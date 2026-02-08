'use strict';

const { spawn } = require('child_process');
const state = require('./state');
const { sendSlackNotification, sendNotification } = require('./notifications');
const { checkAutoFix, runAutoFix } = require('./autofix');
const { triggerNextJobs } = require('./pipeline');

function getDefaultOptionsFromJob(job) {
  const options = {};
  if (!job.options) return options;
  for (const opt of job.options) {
    const key = opt.flag || opt.arg;
    if (key && opt.default !== undefined && opt.default !== '') {
      options[key] = opt.default;
    }
  }
  return options;
}

function buildCommand(job, options = {}) {
  let command = job.command;
  const jobOptions = job.options || [];
  const flags = [];
  const args = [];

  for (const opt of jobOptions) {
    if (opt.system) continue;
    const value = options[opt.flag || opt.arg];
    if (opt.type === 'boolean') {
      const isEnabled = value !== undefined ? value : opt.default;
      if (isEnabled && opt.flag) flags.push(opt.flag);
    } else if (opt.type === 'string' && value) {
      if (opt.flag) flags.push(`${opt.flag} "${value}"`);
      else if (opt.arg) args.push(value);
    } else if (opt.type === 'array' && value) {
      const joinedValue = Array.isArray(value) ? value.join(',') : value;
      if (joinedValue) {
        if (opt.flag) flags.push(`${opt.flag} "${joinedValue}"`);
        else if (opt.arg) args.push(joinedValue);
      }
    } else if (opt.type === 'select' && value) {
      if (opt.flag) flags.push(`${opt.flag} "${value}"`);
      else if (opt.arg) args.push(value);
    }
  }

  if (command.includes(' && ') && flags.length > 0) {
    const commands = command.split(' && ');
    const flagStr = flags.join(' ');
    command = commands.map(cmd => `${cmd} ${flagStr}`).join(' && ');
  } else {
    if (flags.length > 0) command = `${command} ${flags.join(' ')}`;
    if (args.length > 0) command = `${command} ${args.join(' ')}`;
  }
  return command;
}

function getSystemOptions(job, options = {}) {
  const jobOptions = job.options || [];
  const systemOpts = {};
  for (const opt of jobOptions) {
    if (opt.system) {
      const value = options[opt.flag || opt.arg];
      const isEnabled = value !== undefined ? value : opt.default;
      systemOpts[opt.flag] = isEnabled;
    }
  }
  return systemOpts;
}

function executeJob(job, trigger = 'manual', options = {}, chainDepth = 0, retryAttempt = 0) {
  return new Promise((resolve, reject) => {
    if (state.runningJobs[job.id] && trigger !== 'retry') {
      console.log(`[${new Date().toISOString()}] Skipped: ${job.name} (already running)`);
      return reject(new Error('Job is already running'));
    }

    const startTime = new Date();
    const logId = Date.now();
    const command = buildCommand(job, options);
    const systemOpts = getSystemOptions(job, options);
    const shouldNotifySlack = systemOpts['--slack'] === true;

    const executionConfig = job.execution || {};
    const timeout = executionConfig.timeout || 300000;
    const maxRetries = executionConfig.maxRetries || 0;
    const baseRetryDelay = executionConfig.retryDelay || 5000;
    const backoffStrategy = executionConfig.backoff || 'fixed';

    const calculateRetryDelay = (attempt) => {
      switch (backoffStrategy) {
        case 'linear': return baseRetryDelay * attempt;
        case 'exponential': return baseRetryDelay * Math.pow(2, attempt - 1);
        default: return baseRetryDelay;
      }
    };
    const retryDelay = calculateRetryDelay(retryAttempt + 1);

    const logEntry = {
      id: logId, jobId: job.id, jobName: job.name,
      trigger: retryAttempt > 0 ? `retry(${retryAttempt})` : trigger,
      startTime: startTime.toISOString(), status: 'running',
      stdout: '', stderr: '', command, options, retryAttempt
    };

    state.jobHistory.push(logEntry);
    state.runningJobs[job.id] = { logId, stdout: '', stderr: '', startTime, command };

    console.log(`[${new Date().toISOString()}] Executing: ${job.name} (${trigger})`);
    console.log(`   Command: ${command}`);
    if (shouldNotifySlack) console.log(`   Slack 알림: 활성화`);

    const child = spawn('/bin/zsh', ['-c', command], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });

    let timeoutId = null;
    let isTimedOut = false;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        child.kill('SIGTERM');
        console.log(`[${new Date().toISOString()}] Timeout: ${job.name} (${timeout}ms)`);
      }, timeout);
    }

    child.stdout.on('data', (data) => {
      const text = data.toString();
      logEntry.stdout += text;
      if (state.runningJobs[job.id]) state.runningJobs[job.id].stdout += text;
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      logEntry.stderr += text;
      if (state.runningJobs[job.id]) state.runningJobs[job.id].stderr += text;
    });

    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      const endTime = new Date();
      const duration = endTime - startTime;
      logEntry.endTime = endTime.toISOString();
      logEntry.duration = duration;
      logEntry.exitCode = code;
      delete state.runningJobs[job.id];

      if (isTimedOut) {
        logEntry.status = 'failed';
        logEntry.error = `Timeout after ${timeout}ms`;
        console.error(`[${new Date().toISOString()}] Timeout: ${job.name}`);
        state.saveHistory();

        if (retryAttempt < maxRetries) {
          console.log(`[${new Date().toISOString()}] Retry ${retryAttempt + 1}/${maxRetries}: ${job.name} in ${retryDelay}ms`);
          setTimeout(() => {
            executeJob(job, 'retry', options, chainDepth, retryAttempt + 1).then(resolve).catch(reject);
          }, retryDelay);
          return;
        }

        if (shouldNotifySlack) {
          sendSlackNotification(job, 'failed', { duration, error: logEntry.error, stdout: logEntry.stdout, stderr: logEntry.stderr, logId: logEntry.id })
            .catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
        }
        sendNotification('job.failed', { job, status: 'failed', result: { duration, error: logEntry.error, stdout: logEntry.stdout, stderr: logEntry.stderr, logId: logEntry.id, trigger } })
          .catch(err => console.error('[Notify]', err.message));
        triggerNextJobs(job.id, 'failed', logEntry, chainDepth);
        reject(new Error(`Timeout after ${timeout}ms`));
        return;
      }

      if (code !== 0) {
        logEntry.status = 'failed';
        logEntry.error = `Exit code: ${code}`;
        console.error(`[${new Date().toISOString()}] Failed: ${job.name} (code: ${code})`);
        state.saveHistory();

        if (retryAttempt === 0) {
          const autoFix = checkAutoFix(logEntry.stdout, logEntry.stderr);
          if (autoFix) {
            console.log(`[${new Date().toISOString()}] AutoFix 감지: ${autoFix.rule.name} - ${autoFix.package || ''}`);
            logEntry.autoFix = { rule: autoFix.rule.name, command: autoFix.fixCommand };
            runAutoFix(autoFix.fixCommand)
              .then(() => {
                console.log(`[${new Date().toISOString()}] AutoFix 후 재시도: ${job.name}`);
                return executeJob(job, 'auto-fix', options, chainDepth, 0);
              })
              .then(resolve)
              .catch((fixErr) => {
                console.error(`[${new Date().toISOString()}] AutoFix 실패: ${fixErr.message}`);
                if (maxRetries > 0) {
                  setTimeout(() => {
                    executeJob(job, 'retry', options, chainDepth, 1).then(resolve).catch(reject);
                  }, retryDelay);
                } else {
                  reject(new Error(`Exit code: ${code} (AutoFix failed)`));
                }
              });
            return;
          }
        }

        if (retryAttempt < maxRetries) {
          console.log(`[${new Date().toISOString()}] Retry ${retryAttempt + 1}/${maxRetries}: ${job.name} in ${retryDelay}ms`);
          setTimeout(() => {
            executeJob(job, 'retry', options, chainDepth, retryAttempt + 1).then(resolve).catch(reject);
          }, retryDelay);
          return;
        }

        if (shouldNotifySlack) {
          const retryInfo = maxRetries > 0 ? ` (${maxRetries}회 재시도 후)` : '';
          sendSlackNotification(job, 'failed', { duration, error: logEntry.error + retryInfo, stdout: logEntry.stdout, stderr: logEntry.stderr, logId: logEntry.id })
            .catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
        }
        sendNotification('job.failed', { job, status: 'failed', result: { duration, error: logEntry.error, stdout: logEntry.stdout, stderr: logEntry.stderr, logId: logEntry.id, trigger } })
          .catch(err => console.error('[Notify]', err.message));
        triggerNextJobs(job.id, 'failed', logEntry, chainDepth);
        reject(new Error(`Exit code: ${code}`));
      } else {
        logEntry.status = 'success';
        const retryInfo = retryAttempt > 0 ? ` (retry ${retryAttempt})` : '';
        console.log(`[${new Date().toISOString()}] Success: ${job.name}${retryInfo} (${duration}ms)`);
        state.saveHistory();

        if (shouldNotifySlack) {
          sendSlackNotification(job, 'success', { duration, stdout: logEntry.stdout, logId: logEntry.id })
            .catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
        }
        sendNotification('job.success', { job, status: 'success', result: { duration, stdout: logEntry.stdout, logId: logEntry.id, trigger } })
          .catch(err => console.error('[Notify]', err.message));
        triggerNextJobs(job.id, 'success', logEntry, chainDepth);
        resolve({ stdout: logEntry.stdout, stderr: logEntry.stderr, duration });
      }
    });

    child.on('error', (error) => {
      logEntry.status = 'failed';
      logEntry.error = error.message;
      delete state.runningJobs[job.id];
      state.saveHistory();
      reject(error);
    });
  });
}

module.exports = { executeJob, buildCommand, getSystemOptions, getDefaultOptionsFromJob };
