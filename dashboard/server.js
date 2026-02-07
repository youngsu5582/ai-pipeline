const express = require('express');
const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// KST 날짜 헬퍼 (Asia/Seoul)
function getKSTDateString(date) {
  const d = date || new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// Claude 세션 디렉토리
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// 세션 별명 파일
const SESSION_ALIASES_FILE = path.join(__dirname, 'data', 'session-aliases.json');

// 세션 별명 로드/저장
function loadSessionAliases() {
  try {
    if (fs.existsSync(SESSION_ALIASES_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_ALIASES_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSessionAliases(aliases) {
  const dir = path.dirname(SESSION_ALIASES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SESSION_ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

// ============ 비동기 작업 시스템 ============
const taskQueue = new Map();      // taskId -> QueueTask
const sseClients = new Map();     // clientId -> Response
const runningTaskProcesses = new Map(); // taskId -> ChildProcess

// 작업 ID 생성
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// SSE 이벤트 전송
function sendSSEEvent(clientId, event, data) {
  if (clientId && sseClients.has(clientId)) {
    const res = sseClients.get(clientId);
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('[SSE] 전송 오류:', err.message);
      sseClients.delete(clientId);
    }
  } else {
    // 브로드캐스트
    sseClients.forEach((res, cid) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        sseClients.delete(cid);
      }
    });
  }
}

// 작업 진행률 업데이트
function updateTaskProgress(task, progress, message) {
  task.progress = progress;
  task.progressMessage = message;
  sendSSEEvent(task.clientId, 'task:progress', {
    taskId: task.id,
    progress,
    message
  });
}

const app = express();

// Slack 알림 전송
function sendSlackNotification(job, status, result = {}, overrideWebhookUrl = null) {
  // 설정에서 먼저 확인, 없으면 환경변수 사용
  const webhookUrl = overrideWebhookUrl || getSettingValue('slackWebhookUrl', '') || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[Slack] Webhook URL 없음 - 알림 스킵');
    return Promise.resolve();
  }

  // 대시보드 URL도 설정에서 가져오기
  const dashboardUrl = getSettingValue('dashboardUrl', DASHBOARD_URL);

  const emoji = status === 'success' ? '✅' : '❌';
  const statusText = status === 'success' ? '성공' : '실패';
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}초` : '-';

  const message = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} ${job.name} - ${statusText}`,
          emoji: true
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*작업:*\n${job.name}` },
          { type: "mrkdwn", text: `*소요 시간:*\n${duration}` }
        ]
      }
    ]
  };

  // 실패 시 에러 정보 추가 (stdout + stderr 모두)
  if (status === 'failed') {
    // stdout 출력 (에러 메시지가 여기 있는 경우 많음)
    if (result.stdout) {
      const stdoutSummary = result.stdout.trim().substring(0, 800);
      message.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*출력 (stdout):*\n\`\`\`${stdoutSummary}${result.stdout.length > 800 ? '...' : ''}\`\`\``
        }
      });
    }

    // stderr 출력
    if (result.stderr) {
      const stderrSummary = result.stderr.trim().substring(0, 500);
      message.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*에러 (stderr):*\n\`\`\`${stderrSummary}${result.stderr.length > 500 ? '...' : ''}\`\`\``
        }
      });
    }

    // Exit code
    if (result.error) {
      message.blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `\`${result.error}\``
        }]
      });
    }
  }

  // stdout 요약 추가 (성공 시)
  if (status === 'success' && result.stdout) {
    const summary = result.stdout.substring(0, 500).trim();
    if (summary) {
      message.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*출력:*\n\`\`\`${summary}${result.stdout.length > 500 ? '...' : ''}\`\`\``
        }
      });
    }
  }

  // 상세 보기 링크 버튼 추가
  if (result.logId) {
    message.blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "📋 상세 보기",
            emoji: true
          },
          url: `${dashboardUrl}?tab=history&logId=${result.logId}`,
          action_id: "view_detail"
        }
      ]
    });
  }

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = protocol.request(options, (res) => {
      if (res.statusCode === 200) {
        console.log(`[Slack] 알림 전송 완료: ${job.name}`);
        resolve();
      } else {
        console.error(`[Slack] 알림 실패: ${res.statusCode}`);
        reject(new Error(`Slack API error: ${res.statusCode}`));
      }
    });

    req.on('error', (error) => {
      console.error('[Slack] 전송 오류:', error.message);
      reject(error);
    });

    req.write(JSON.stringify(message));
    req.end();
  });
}

// Discord 알림 전송
function sendDiscordNotification(job, status, result = {}, webhookUrl) {
  if (!webhookUrl) return Promise.resolve();

  const color = status === 'success' ? 0x10b981 : 0xef4444;
  const emoji = status === 'success' ? '✅' : '❌';
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}초` : '-';
  const dashboardUrl = getSettingValue('dashboardUrl', DASHBOARD_URL);

  const embed = {
    title: `${emoji} ${job.name} - ${status === 'success' ? '성공' : '실패'}`,
    color,
    fields: [
      { name: '작업', value: job.name, inline: true },
      { name: '소요 시간', value: duration, inline: true },
      { name: '트리거', value: result.trigger || 'manual', inline: true }
    ],
    timestamp: new Date().toISOString()
  };

  if (status === 'failed' && result.stderr) {
    embed.description = '```' + result.stderr.substring(0, 500) + '```';
  }
  if (result.logId) {
    embed.url = `${dashboardUrl}?tab=history&logId=${result.logId}`;
  }

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = protocol.request(options, (res) => {
      res.statusCode < 300 ? resolve() : reject(new Error(`Discord API error: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ embeds: [embed] }));
    req.end();
  });
}

// 알림 규칙 기반 디스패치
async function sendNotification(event, data) {
  const jobsData = loadJobs();
  const settings = jobsData.settings || {};
  const notifications = settings.notifications;
  if (!notifications) return;

  const channels = notifications.channels || [];
  const rules = notifications.rules || [];

  const matchingRules = rules.filter(r => r.event === event);
  for (const rule of matchingRules) {
    if (rule.filter?.category && data.job?.category !== rule.filter.category) continue;
    if (rule.filter?.jobId && data.job?.id !== rule.filter.jobId) continue;

    for (const channelId of rule.channels) {
      const channel = channels.find(c => c.id === channelId && c.enabled);
      if (!channel) continue;

      try {
        switch (channel.type) {
          case 'slack':
            await sendSlackNotification(data.job, data.status, data.result, channel.webhookUrl);
            break;
          case 'discord':
            await sendDiscordNotification(data.job, data.status, data.result, channel.webhookUrl);
            break;
          case 'native':
            sendSSEEvent('notification', {
              title: `${data.status === 'success' ? '✅' : '❌'} ${data.job.name}`,
              body: event,
              status: data.status
            });
            break;
        }
      } catch (err) {
        console.error(`[Notify] ${channel.id} 전송 실패:`, err.message);
      }
    }
  }
}

const PORT = process.env.PORT || 3030;
let DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3030';

// 설정에서 값 가져오는 헬퍼
function getSettingValue(key, defaultValue) {
  try {
    const data = loadJobs();
    return data.settings?.[key] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Paths
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// In-memory state
let scheduledJobs = {};
let jobHistory = [];
let runningJobs = {};  // 실행 중인 작업의 실시간 로그 저장
let jobRetryCount = {};  // 작업별 재시도 횟수 추적

// 자동 복구 규칙 (기본)
const DEFAULT_AUTO_FIX_RULES = [
  {
    id: 'pip-missing',
    name: 'Python 패키지 누락',
    pattern: /(?:No module named|ModuleNotFoundError:.*'(\w+)'|(\w+)가 설치되어 있지 않습니다)/i,
    extractPackage: (match, stdout, stderr) => {
      // pip install <package> 형태 찾기
      const pipMatch = (stdout + stderr).match(/pip install\s+(\S+)/i);
      if (pipMatch) return pipMatch[1];
      // ModuleNotFoundError: No module named 'xxx'
      if (match[1]) return match[1];
      return null;
    },
    fix: (pkg) => `~/ai-pipeline/.venv/bin/pip install ${pkg}`,
    enabled: true
  },
  {
    id: 'npm-missing',
    name: 'NPM 패키지 누락',
    pattern: /Cannot find module '([^']+)'/i,
    extractPackage: (match) => match[1],
    fix: (pkg) => `npm install ${pkg}`,
    enabled: true
  }
];

// 자동 복구 규칙 가져오기
function getAutoFixRules() {
  const data = loadJobs();
  return data.settings?.autoFixRules || DEFAULT_AUTO_FIX_RULES;
}

// 에러 출력에서 자동 복구 가능한지 확인
function checkAutoFix(stdout, stderr) {
  const rules = getAutoFixRules();
  const combined = (stdout || '') + (stderr || '');

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const match = combined.match(rule.pattern);
    if (match) {
      const pkg = rule.extractPackage ? rule.extractPackage(match, stdout, stderr) : null;
      if (pkg || !rule.extractPackage) {
        return {
          rule,
          package: pkg,
          fixCommand: typeof rule.fix === 'function' ? rule.fix(pkg) : rule.fix
        };
      }
    }
  }
  return null;
}

// 자동 복구 명령 실행
function runAutoFix(fixCommand) {
  return new Promise((resolve, reject) => {
    console.log(`[AutoFix] 실행: ${fixCommand}`);
    const child = spawn('/bin/zsh', ['-c', fixCommand], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[AutoFix] 성공: ${fixCommand}`);
        resolve({ success: true, stdout, stderr });
      } else {
        console.error(`[AutoFix] 실패 (code: ${code}): ${fixCommand}`);
        reject(new Error(`AutoFix failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

// Load jobs from file
function loadJobs() {
  try {
    const data = fs.readFileSync(JOBS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading jobs:', error);
    return { jobs: [], categories: {} };
  }
}

// Save jobs to file
function saveJobs(data) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
}

// Load job history
function loadHistory() {
  const historyFile = path.join(LOGS_DIR, 'history.json');
  try {
    if (fs.existsSync(historyFile)) {
      return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading history:', error);
  }
  return [];
}

// Save job history
function saveHistory() {
  const historyFile = path.join(LOGS_DIR, 'history.json');
  // Keep only last 100 entries
  const trimmed = jobHistory.slice(-100);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}

/**
 * 엣지 조건 평가
 */
function evaluateEdgeCondition(edge, status, logEntry, exitCode) {
  if (edge.condition) {
    const cond = edge.condition;
    switch (cond.type) {
      case 'onSuccess': return status === 'success';
      case 'onFailure': return status === 'failed';
      case 'always': return true;
      case 'onOutput':
        if (!logEntry?.stdout) return false;
        if (cond.matchType === 'regex') {
          try { return new RegExp(cond.pattern).test(logEntry.stdout); }
          catch (e) { return false; }
        }
        return logEntry.stdout.includes(cond.pattern || '');
      case 'onExitCode':
        return exitCode === cond.code;
      default: return false;
    }
  }
  // 하위 호환: 기존 trigger/onSuccess boolean
  if (!edge.trigger) return false;
  return edge.onSuccess === false || status === 'success';
}

/**
 * 작업 완료 후 연결된 다음 작업들을 실행 (파이프라인 체이닝)
 * @param {string} jobId - 완료된 작업 ID
 * @param {string} status - 'success' | 'failed'
 * @param {object} prevLog - 이전 작업의 로그
 * @param {number} depth - 체이닝 깊이 (무한 루프 방지)
 */
function triggerNextJobs(jobId, status, prevLog, depth = 0) {
  // 무한 루프 방지
  if (depth > 10) {
    console.error(`[Chain] Max depth (10) exceeded for job ${jobId}`);
    return;
  }

  const data = loadJobs();
  const edges = data.edges || [];

  const exitCode = prevLog?.exitCode ?? (status === 'success' ? 0 : 1);

  // 이 작업에서 나가는 트리거 엣지 찾기 (조건 평가)
  const triggerEdges = edges.filter(e =>
    e.from === jobId && evaluateEdgeCondition(e, status, prevLog, exitCode)
  );

  if (triggerEdges.length === 0) return;

  console.log(`[Chain] ${jobId} completed (${status}), triggering ${triggerEdges.length} job(s)`);

  for (const edge of triggerEdges) {
    const nextJob = data.jobs.find(j => j.id === edge.to);
    if (!nextJob) {
      console.warn(`[Chain] Target job ${edge.to} not found`);
      continue;
    }

    const condLabel = edge.condition?.type || 'legacy';
    console.log(`[Chain] Starting: ${nextJob.name} (condition: ${condLabel})`);

    // 기본 옵션으로 다음 작업 실행
    const defaultOptions = getDefaultOptionsFromJob(nextJob);

    // 비동기로 다음 작업 실행 (depth 전달)
    executeJob(nextJob, 'chained', defaultOptions, depth + 1)
      .catch(err => console.error(`[Chain] Failed to execute ${nextJob.id}:`, err.message));
  }
}

// Execute a job with real-time logging
function executeJob(job, trigger = 'manual', options = {}, chainDepth = 0, retryAttempt = 0) {
  return new Promise((resolve, reject) => {
    // 동시 실행 방지: 이미 실행 중인 작업인지 확인
    if (runningJobs[job.id] && trigger !== 'retry') {
      console.log(`[${new Date().toISOString()}] Skipped: ${job.name} (already running)`);
      return reject(new Error('Job is already running'));
    }

    const startTime = new Date();
    const logId = Date.now();

    // 옵션으로 명령어 빌드
    const command = buildCommand(job, options);
    // system 옵션 추출 (Slack 알림 등)
    const systemOpts = getSystemOptions(job, options);
    const shouldNotifySlack = systemOpts['--slack'] === true;

    // 실행 제어 설정 (기본값)
    const executionConfig = job.execution || {};
    const timeout = executionConfig.timeout || 300000;  // 기본 5분
    const maxRetries = executionConfig.maxRetries || 0;
    const baseRetryDelay = executionConfig.retryDelay || 5000;  // 기본 5초
    const backoffStrategy = executionConfig.backoff || 'fixed';

    // Backoff 전략에 따른 지연 시간 계산
    const calculateRetryDelay = (attempt) => {
      switch (backoffStrategy) {
        case 'linear': return baseRetryDelay * attempt;
        case 'exponential': return baseRetryDelay * Math.pow(2, attempt - 1);
        default: return baseRetryDelay;  // fixed
      }
    };
    const retryDelay = calculateRetryDelay(retryAttempt + 1);

    const logEntry = {
      id: logId,
      jobId: job.id,
      jobName: job.name,
      trigger: retryAttempt > 0 ? `retry(${retryAttempt})` : trigger,
      startTime: startTime.toISOString(),
      status: 'running',
      stdout: '',
      stderr: '',
      command: command,  // 실행된 명령어 저장
      options: options,   // 사용된 옵션 저장
      retryAttempt
    };

    jobHistory.push(logEntry);

    // 실행 중인 작업 등록 (실시간 로그용)
    runningJobs[job.id] = {
      logId,
      stdout: '',
      stderr: '',
      startTime,
      command
    };

    console.log(`[${new Date().toISOString()}] Executing: ${job.name} (${trigger})`);
    console.log(`   Command: ${command}`);
    if (shouldNotifySlack) {
      console.log(`   Slack 알림: 활성화`);
    }

    const child = spawn('/bin/zsh', ['-c', command], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });

    // 타임아웃 설정
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
      if (runningJobs[job.id]) {
        runningJobs[job.id].stdout += text;
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      logEntry.stderr += text;
      if (runningJobs[job.id]) {
        runningJobs[job.id].stderr += text;
      }
    });

    child.on('close', (code) => {
      // 타임아웃 타이머 정리
      if (timeoutId) clearTimeout(timeoutId);

      const endTime = new Date();
      const duration = endTime - startTime;

      logEntry.endTime = endTime.toISOString();
      logEntry.duration = duration;
      logEntry.exitCode = code;

      // 실행 중인 작업에서 제거
      delete runningJobs[job.id];

      // 타임아웃으로 종료된 경우
      if (isTimedOut) {
        logEntry.status = 'failed';
        logEntry.error = `Timeout after ${timeout}ms`;
        console.error(`[${new Date().toISOString()}] Timeout: ${job.name}`);
        saveHistory();

        // 재시도 로직 (타임아웃도 재시도 대상)
        if (retryAttempt < maxRetries) {
          console.log(`[${new Date().toISOString()}] Retry ${retryAttempt + 1}/${maxRetries}: ${job.name} in ${retryDelay}ms`);
          setTimeout(() => {
            executeJob(job, 'retry', options, chainDepth, retryAttempt + 1)
              .then(resolve)
              .catch(reject);
          }, retryDelay);
          return;
        }

        if (shouldNotifySlack) {
          sendSlackNotification(job, 'failed', {
            duration,
            error: logEntry.error,
            stdout: logEntry.stdout,
            stderr: logEntry.stderr,
            logId: logEntry.id
          }).catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
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
        saveHistory();

        // 자동 복구 확인 (첫 번째 실패 시에만)
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
                // 자동 복구 실패 시 일반 재시도 로직으로 진행
                if (maxRetries > 0) {
                  setTimeout(() => {
                    executeJob(job, 'retry', options, chainDepth, 1)
                      .then(resolve)
                      .catch(reject);
                  }, retryDelay);
                } else {
                  reject(new Error(`Exit code: ${code} (AutoFix failed)`));
                }
              });
            return;
          }
        }

        // 일반 재시도 로직
        if (retryAttempt < maxRetries) {
          console.log(`[${new Date().toISOString()}] Retry ${retryAttempt + 1}/${maxRetries}: ${job.name} in ${retryDelay}ms`);
          setTimeout(() => {
            executeJob(job, 'retry', options, chainDepth, retryAttempt + 1)
              .then(resolve)
              .catch(reject);
          }, retryDelay);
          return;
        }

        // Slack 알림 (실패) - 재시도 모두 실패 후에만
        if (shouldNotifySlack) {
          const retryInfo = maxRetries > 0 ? ` (${maxRetries}회 재시도 후)` : '';
          sendSlackNotification(job, 'failed', {
            duration,
            error: logEntry.error + retryInfo,
            stdout: logEntry.stdout,
            stderr: logEntry.stderr,
            logId: logEntry.id
          }).catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
        }
        sendNotification('job.failed', { job, status: 'failed', result: { duration, error: logEntry.error, stdout: logEntry.stdout, stderr: logEntry.stderr, logId: logEntry.id, trigger } })
          .catch(err => console.error('[Notify]', err.message));

        // 체이닝: 다음 작업 실행 (실패 시에도 onSuccess=false인 edge는 실행)
        triggerNextJobs(job.id, 'failed', logEntry, chainDepth);

        reject(new Error(`Exit code: ${code}`));
      } else {
        logEntry.status = 'success';
        const retryInfo = retryAttempt > 0 ? ` (retry ${retryAttempt})` : '';
        console.log(`[${new Date().toISOString()}] Success: ${job.name}${retryInfo} (${duration}ms)`);
        saveHistory();

        // Slack 알림 (성공)
        if (shouldNotifySlack) {
          sendSlackNotification(job, 'success', {
            duration,
            stdout: logEntry.stdout,
            logId: logEntry.id
          }).catch(err => console.error('[Slack] 알림 전송 실패:', err.message));
        }
        sendNotification('job.success', { job, status: 'success', result: { duration, stdout: logEntry.stdout, logId: logEntry.id, trigger } })
          .catch(err => console.error('[Notify]', err.message));

        // 체이닝: 다음 작업 실행
        triggerNextJobs(job.id, 'success', logEntry, chainDepth);

        resolve({ stdout: logEntry.stdout, stderr: logEntry.stderr, duration });
      }
    });

    child.on('error', (error) => {
      logEntry.status = 'failed';
      logEntry.error = error.message;
      delete runningJobs[job.id];
      saveHistory();
      reject(error);
    });
  });
}

// Schedule a job
function scheduleJob(job) {
  if (scheduledJobs[job.id]) {
    scheduledJobs[job.id].stop();
  }

  if (job.enabled && cron.validate(job.schedule)) {
    scheduledJobs[job.id] = cron.schedule(job.schedule, () => {
      // 저장된 기본 옵션으로 실행
      const defaultOptions = getDefaultOptionsFromJob(job);
      executeJob(job, 'scheduled', defaultOptions)
        .catch(err => console.error(`[Scheduled] ${job.name} 실패:`, err.message));
    });
    console.log(`Scheduled: ${job.name} (${job.schedule})`);
  }
}

// job.options에서 기본값 추출
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

// Initialize all jobs
function initializeJobs() {
  const { jobs } = loadJobs();
  jobs.forEach(job => {
    if (job.enabled) {
      scheduleJob(job);
    }
  });
  console.log(`Initialized ${Object.keys(scheduledJobs).length} scheduled jobs`);
}

// Load history on startup
jobHistory = loadHistory();

// ============ API Routes ============

// Get all jobs
app.get('/api/jobs', (req, res) => {
  const data = loadJobs();
  const jobsWithStatus = data.jobs.map(job => ({
    ...job,
    isScheduled: !!scheduledJobs[job.id],
    isRunning: !!runningJobs[job.id]
  }));
  res.json({
    ...data,
    jobs: jobsWithStatus,
    edges: data.edges || []
  });
});

// Get running job's live log (or last completed log)
app.get('/api/jobs/:id/live-log', (req, res) => {
  const jobId = req.params.id;
  const running = runningJobs[jobId];

  if (running) {
    // 실행 중인 작업
    return res.json({
      running: true,
      logId: running.logId,
      stdout: running.stdout,
      stderr: running.stderr,
      elapsed: Date.now() - running.startTime.getTime(),
      command: running.command
    });
  }

  // 실행 중이 아니면 히스토리에서 가장 최근 로그 찾기
  const lastLog = [...jobHistory].reverse().find(h => h.jobId === jobId);
  if (lastLog) {
    return res.json({
      running: false,
      logId: lastLog.id,
      stdout: lastLog.stdout || '',
      stderr: lastLog.stderr || '',
      error: lastLog.error || '',
      status: lastLog.status,
      duration: lastLog.duration,
      command: lastLog.command || ''
    });
  }

  // 로그가 없는 경우
  res.json({ running: false, stdout: '', stderr: '' });
});

// Get single job
app.get('/api/jobs/:id', (req, res) => {
  const { jobs } = loadJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ ...job, isScheduled: !!scheduledJobs[job.id] });
});

// Create new job
app.post('/api/jobs', (req, res) => {
  const data = loadJobs();
  const newJob = {
    id: req.body.id || `job-${Date.now()}`,
    name: req.body.name,
    description: req.body.description || '',
    command: req.body.command,
    schedule: req.body.schedule || '0 * * * *',
    enabled: req.body.enabled ?? false,
    category: req.body.category || 'custom',
    tags: req.body.tags || []
  };

  // Validate cron expression
  if (!cron.validate(newJob.schedule)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  data.jobs.push(newJob);
  saveJobs(data);

  if (newJob.enabled) {
    scheduleJob(newJob);
  }

  res.status(201).json(newJob);
});

// Update job
app.put('/api/jobs/:id', (req, res) => {
  const data = loadJobs();
  const index = data.jobs.findIndex(j => j.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Validate cron if provided
  if (req.body.schedule && !cron.validate(req.body.schedule)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const updatedJob = { ...data.jobs[index], ...req.body };
  data.jobs[index] = updatedJob;
  saveJobs(data);

  // Reschedule if needed
  if (scheduledJobs[updatedJob.id]) {
    scheduledJobs[updatedJob.id].stop();
    delete scheduledJobs[updatedJob.id];
  }

  if (updatedJob.enabled) {
    scheduleJob(updatedJob);
  }

  res.json(updatedJob);
});

// Delete job
app.delete('/api/jobs/:id', (req, res) => {
  const data = loadJobs();
  const index = data.jobs.findIndex(j => j.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Stop scheduled job
  if (scheduledJobs[req.params.id]) {
    scheduledJobs[req.params.id].stop();
    delete scheduledJobs[req.params.id];
  }

  data.jobs.splice(index, 1);
  saveJobs(data);

  res.json({ success: true });
});

// Duplicate job
app.post('/api/jobs/:id/duplicate', (req, res) => {
  const data = loadJobs();
  const job = data.jobs.find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // 복제된 작업 생성
  const newId = `job-${Date.now()}`;
  const duplicatedJob = {
    ...JSON.parse(JSON.stringify(job)),  // Deep copy
    id: newId,
    name: `${job.name} (복사본)`,
    enabled: false,  // 복제된 작업은 비활성화 상태로 시작
    position: job.position ? {
      x: (job.position.x || 0) + 50,
      y: (job.position.y || 0) + 50
    } : undefined
  };

  data.jobs.push(duplicatedJob);
  saveJobs(data);

  res.json({ success: true, newId, job: duplicatedJob });
});

// ============ Edge API (for graph connections) ============

// Get all edges
app.get('/api/edges', (req, res) => {
  const data = loadJobs();
  res.json(data.edges || []);
});

// Create edge
app.post('/api/edges', (req, res) => {
  const { from, to, label, trigger, onSuccess } = req.body;

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to are required' });
  }

  const data = loadJobs();

  // Initialize edges array if not exists
  if (!data.edges) {
    data.edges = [];
  }

  // Check if edge already exists
  const existing = data.edges.find(e => e.from === from && e.to === to);
  if (existing) {
    return res.status(400).json({ error: 'Edge already exists' });
  }

  // Verify that both jobs exist
  const fromJob = data.jobs.find(j => j.id === from);
  const toJob = data.jobs.find(j => j.id === to);
  if (!fromJob || !toJob) {
    return res.status(404).json({ error: 'One or both jobs not found' });
  }

  const newEdge = {
    id: `edge-${Date.now()}`,
    from,
    to,
    label: label || '',
    trigger: trigger ?? false,
    onSuccess: onSuccess ?? true,
    condition: req.body.condition || null
  };
  // condition이 있으면 trigger/onSuccess 자동 동기화
  if (newEdge.condition) {
    newEdge.trigger = true;
    newEdge.onSuccess = newEdge.condition.type === 'onSuccess';
  }

  data.edges.push(newEdge);
  saveJobs(data);

  res.status(201).json(newEdge);
});

// Update edge
app.put('/api/edges/:id', (req, res) => {
  const data = loadJobs();
  if (!data.edges) {
    return res.status(404).json({ error: 'Edge not found' });
  }

  const index = data.edges.findIndex(e => e.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Edge not found' });
  }

  const { label, trigger, onSuccess, condition } = req.body;
  if (label !== undefined) data.edges[index].label = label;
  if (trigger !== undefined) data.edges[index].trigger = trigger;
  if (onSuccess !== undefined) data.edges[index].onSuccess = onSuccess;
  if (condition !== undefined) {
    data.edges[index].condition = condition;
    if (condition) {
      data.edges[index].trigger = true;
      data.edges[index].onSuccess = condition.type === 'onSuccess';
    }
  }

  saveJobs(data);
  res.json(data.edges[index]);
});

// Delete edge
app.delete('/api/edges/:id', (req, res) => {
  const data = loadJobs();
  if (!data.edges) {
    return res.status(404).json({ error: 'Edge not found' });
  }

  const index = data.edges.findIndex(e => e.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Edge not found' });
  }

  data.edges.splice(index, 1);
  saveJobs(data);

  res.json({ success: true });
});

// Save job positions (for graph view)
app.post('/api/jobs/positions', (req, res) => {
  const { positions } = req.body;

  if (!positions || !Array.isArray(positions)) {
    return res.status(400).json({ error: 'positions array is required' });
  }

  const data = loadJobs();

  positions.forEach(({ id, position }) => {
    const job = data.jobs.find(j => j.id === id);
    if (job && position) {
      job.position = { x: position.x, y: position.y };
    }
  });

  saveJobs(data);
  res.json({ success: true, updated: positions.length });
});

// Build command with options (system 옵션은 제외)
function buildCommand(job, options = {}) {
  let command = job.command;
  const jobOptions = job.options || [];

  // 옵션 처리
  const flags = [];
  const args = [];

  for (const opt of jobOptions) {
    // system 옵션은 명령어에 추가하지 않음 (서버에서 처리)
    if (opt.system) continue;

    const value = options[opt.flag || opt.arg];

    if (opt.type === 'boolean') {
      // boolean 옵션: 값이 true면 플래그 추가
      const isEnabled = value !== undefined ? value : opt.default;
      if (isEnabled && opt.flag) {
        flags.push(opt.flag);
      }
    } else if (opt.type === 'string' && value) {
      // string 옵션: 값이 있으면 추가
      if (opt.flag) {
        flags.push(`${opt.flag} "${value}"`);
      } else if (opt.arg) {
        args.push(value);
      }
    } else if (opt.type === 'array' && value) {
      // array 옵션: 프론트엔드에서 이미 쉼표로 join된 string으로 전달됨
      const joinedValue = Array.isArray(value) ? value.join(',') : value;
      if (joinedValue) {
        if (opt.flag) {
          flags.push(`${opt.flag} "${joinedValue}"`);
        } else if (opt.arg) {
          args.push(joinedValue);
        }
      }
    } else if (opt.type === 'select' && value) {
      // select 옵션: string과 동일하게 처리
      if (opt.flag) {
        flags.push(`${opt.flag} "${value}"`);
      } else if (opt.arg) {
        args.push(value);
      }
    }
  }

  // 명령어에 && 가 있으면 각 명령어에 플래그 적용 (sync-all 같은 경우)
  if (command.includes(' && ') && flags.length > 0) {
    const commands = command.split(' && ');
    const flagStr = flags.join(' ');
    command = commands.map(cmd => `${cmd} ${flagStr}`).join(' && ');
  } else {
    // 단일 명령어
    if (flags.length > 0) {
      command = `${command} ${flags.join(' ')}`;
    }
    if (args.length > 0) {
      command = `${command} ${args.join(' ')}`;
    }
  }

  return command;
}

// system 옵션 추출 (--slack 등)
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

// Execute job immediately
app.post('/api/jobs/:id/run', async (req, res) => {
  const { jobs } = loadJobs();
  const job = jobs.find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    // 요청 body에서 옵션 받기
    const options = req.body.options || {};
    const result = await executeJob(job, 'manual', options);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle job enabled/disabled
app.post('/api/jobs/:id/toggle', (req, res) => {
  const data = loadJobs();
  const job = data.jobs.find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.enabled = !job.enabled;
  saveJobs(data);

  if (job.enabled) {
    scheduleJob(job);
  } else if (scheduledJobs[job.id]) {
    scheduledJobs[job.id].stop();
    delete scheduledJobs[job.id];
  }

  res.json({ enabled: job.enabled });
});

// Schedule one-time execution
const scheduledOnceJobs = {};  // { jobId: timeoutId }

app.post('/api/jobs/:id/schedule-once', (req, res) => {
  const { jobs } = loadJobs();
  const job = jobs.find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const { scheduledTime } = req.body;
  if (!scheduledTime) {
    return res.status(400).json({ error: 'scheduledTime required' });
  }

  const targetTime = new Date(scheduledTime);
  const now = new Date();
  const delay = targetTime.getTime() - now.getTime();

  if (delay <= 0) {
    return res.status(400).json({ error: 'Scheduled time must be in the future' });
  }

  // 기존 예약이 있으면 취소
  if (scheduledOnceJobs[job.id]) {
    clearTimeout(scheduledOnceJobs[job.id]);
    console.log(`[Schedule] Cancelled previous schedule for ${job.name}`);
  }

  // 새 예약 설정
  scheduledOnceJobs[job.id] = setTimeout(() => {
    console.log(`[Schedule] Executing one-time scheduled job: ${job.name}`);
    const defaultOptions = getDefaultOptionsFromJob(job);
    executeJob(job, 'scheduled-once', defaultOptions)
      .catch(err => console.error(`[Schedule] ${job.name} 실패:`, err.message));
    delete scheduledOnceJobs[job.id];
  }, delay);

  console.log(`[Schedule] ${job.name} scheduled for ${targetTime.toISOString()} (in ${Math.round(delay/1000)}s)`);

  res.json({
    success: true,
    scheduledFor: targetTime.toISOString(),
    delayMs: delay
  });
});


// Get job history (with pagination, search, filters)
app.get('/api/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const jobId = req.query.jobId;
  const search = req.query.search;
  const status = req.query.status;  // success, failed, running
  const startDate = req.query.startDate;  // YYYY-MM-DD
  const endDate = req.query.endDate;      // YYYY-MM-DD

  let history = [...jobHistory].reverse();

  // 필터: 작업 ID
  if (jobId) {
    history = history.filter(h => h.jobId === jobId);
  }

  // 필터: 검색 (작업명)
  if (search) {
    const searchLower = search.toLowerCase();
    history = history.filter(h =>
      h.jobName.toLowerCase().includes(searchLower)
    );
  }

  // 필터: 상태
  if (status) {
    history = history.filter(h => h.status === status);
  }

  // 필터: 날짜 범위
  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    history = history.filter(h => new Date(h.startTime) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    history = history.filter(h => new Date(h.startTime) <= end);
  }

  // 페이지네이션
  const total = history.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = history.slice(offset, offset + limit);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  });
});

// Get categories
app.get('/api/categories', (req, res) => {
  const { categories } = loadJobs();
  res.json(categories);
});

// Validate cron expression
app.post('/api/validate-cron', (req, res) => {
  const { expression } = req.body;
  const isValid = cron.validate(expression);
  res.json({ valid: isValid });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    scheduledJobs: Object.keys(scheduledJobs).length
  });
});

// ============ Statistics API ============

// 전체 요약 통계
app.get('/api/stats/summary', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentHistory = jobHistory.filter(h =>
    new Date(h.startTime) >= cutoff
  );

  const total = recentHistory.length;
  const success = recentHistory.filter(h => h.status === 'success').length;
  const failed = recentHistory.filter(h => h.status === 'failed').length;
  const running = recentHistory.filter(h => h.status === 'running').length;

  // 평균 실행 시간 (성공한 작업만)
  const successfulJobs = recentHistory.filter(h => h.status === 'success' && h.duration);
  const avgDuration = successfulJobs.length > 0
    ? Math.round(successfulJobs.reduce((sum, h) => sum + h.duration, 0) / successfulJobs.length)
    : 0;

  // 성공률
  const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

  res.json({
    period: `${days} days`,
    total,
    success,
    failed,
    running,
    successRate,
    avgDuration,
    avgDurationFormatted: `${(avgDuration / 1000).toFixed(1)}s`
  });
});

// 작업별 통계
app.get('/api/stats/jobs', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentHistory = jobHistory.filter(h =>
    new Date(h.startTime) >= cutoff
  );

  // 작업별 집계
  const jobStats = {};
  for (const entry of recentHistory) {
    if (!jobStats[entry.jobId]) {
      jobStats[entry.jobId] = {
        jobId: entry.jobId,
        jobName: entry.jobName,
        total: 0,
        success: 0,
        failed: 0,
        totalDuration: 0,
        lastRun: null
      };
    }
    const stat = jobStats[entry.jobId];
    stat.total++;
    if (entry.status === 'success') stat.success++;
    if (entry.status === 'failed') stat.failed++;
    if (entry.duration) stat.totalDuration += entry.duration;
    if (!stat.lastRun || new Date(entry.startTime) > new Date(stat.lastRun)) {
      stat.lastRun = entry.startTime;
    }
  }

  // 배열로 변환 및 성공률 계산
  const stats = Object.values(jobStats).map(s => ({
    ...s,
    successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0,
    avgDuration: s.total > 0 ? Math.round(s.totalDuration / s.total) : 0
  }));

  // 실행 횟수 기준 정렬
  stats.sort((a, b) => b.total - a.total);

  res.json(stats);
});

// 일별 트렌드
app.get('/api/stats/trend', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // 일별 데이터 초기화
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = getKSTDateString(date);
    trend.push({
      date: dateStr,
      success: 0,
      failed: 0,
      total: 0
    });
  }

  // 데이터 집계
  for (const entry of jobHistory) {
    const entryDate = entry.startTime.split('T')[0];
    const dayData = trend.find(d => d.date === entryDate);
    if (dayData) {
      dayData.total++;
      if (entry.status === 'success') dayData.success++;
      if (entry.status === 'failed') dayData.failed++;
    }
  }

  res.json(trend);
});

// 시간대별 실행 분포
app.get('/api/stats/hourly', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // 시간대별 초기화 (0-23시)
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0
  }));

  // 데이터 집계
  for (const entry of jobHistory) {
    if (new Date(entry.startTime) < cutoff) continue;
    const hour = new Date(entry.startTime).getHours();
    hourly[hour].count++;
  }

  res.json(hourly);
});

// 가장 실패 많은 작업 TOP N
app.get('/api/stats/failures', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const limit = parseInt(req.query.limit) || 5;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentHistory = jobHistory.filter(h =>
    new Date(h.startTime) >= cutoff && h.status === 'failed'
  );

  // 작업별 실패 횟수 집계
  const failureCounts = {};
  for (const entry of recentHistory) {
    if (!failureCounts[entry.jobId]) {
      failureCounts[entry.jobId] = {
        jobId: entry.jobId,
        jobName: entry.jobName,
        count: 0,
        lastFailure: null,
        lastError: null
      };
    }
    failureCounts[entry.jobId].count++;
    if (!failureCounts[entry.jobId].lastFailure ||
        new Date(entry.startTime) > new Date(failureCounts[entry.jobId].lastFailure)) {
      failureCounts[entry.jobId].lastFailure = entry.startTime;
      failureCounts[entry.jobId].lastError = entry.error || entry.stderr?.substring(0, 200);
    }
  }

  // 정렬 및 상위 N개
  const top = Object.values(failureCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  res.json(top);
});

// ============ Export API ============

// 이력 내보내기 (JSON)
app.get('/api/export/history', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const format = req.query.format || 'json';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  let data = jobHistory.filter(h => new Date(h.startTime) >= cutoff);

  if (format === 'csv') {
    const csv = convertToCSV(data, [
      'id', 'jobId', 'jobName', 'trigger', 'status',
      'startTime', 'endTime', 'duration', 'error'
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=history_${days}days.csv`);
    return res.send(csv);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=history_${days}days.json`);
  res.json(data);
});

// 통계 내보내기 (JSON)
app.get('/api/export/stats', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const format = req.query.format || 'json';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentHistory = jobHistory.filter(h => new Date(h.startTime) >= cutoff);

  // 작업별 통계 계산
  const jobStats = {};
  for (const entry of recentHistory) {
    if (!jobStats[entry.jobId]) {
      jobStats[entry.jobId] = {
        jobId: entry.jobId,
        jobName: entry.jobName,
        total: 0,
        success: 0,
        failed: 0,
        totalDuration: 0
      };
    }
    const stat = jobStats[entry.jobId];
    stat.total++;
    if (entry.status === 'success') stat.success++;
    if (entry.status === 'failed') stat.failed++;
    if (entry.duration) stat.totalDuration += entry.duration;
  }

  const stats = Object.values(jobStats).map(s => ({
    ...s,
    successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0,
    avgDuration: s.total > 0 ? Math.round(s.totalDuration / s.total) : 0
  }));

  if (format === 'csv') {
    const csv = convertToCSV(stats, [
      'jobId', 'jobName', 'total', 'success', 'failed',
      'successRate', 'avgDuration'
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=stats_${days}days.csv`);
    return res.send(csv);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=stats_${days}days.json`);
  res.json(stats);
});

// 작업 설정 내보내기
app.get('/api/export/jobs', (req, res) => {
  const data = loadJobs();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=jobs.json');
  res.json(data);
});

// ============ Settings API ============

// 설정 조회
app.get('/api/settings', (req, res) => {
  const data = loadJobs();
  const settings = data.settings || {};
  const { vaultPath, dailyFolder } = getObsidianPaths();
  res.json({
    slackWebhookUrl: settings.slackWebhookUrl || '',
    slackEnabled: settings.slackEnabled || false,
    dashboardUrl: settings.dashboardUrl || 'http://localhost:3030',
    refreshInterval: settings.refreshInterval || 5,
    defaultTimeout: settings.defaultTimeout || 10,
    defaultRetry: settings.defaultRetry || 0,
    notifications: settings.notifications || { channels: [], rules: [] },
    obsidianVaultPath: vaultPath,
    obsidianDailyFolder: dailyFolder
  });
});

// 설정 저장
app.put('/api/settings', (req, res) => {
  try {
    const data = loadJobs();
    data.settings = {
      ...data.settings,
      slackWebhookUrl: req.body.slackWebhookUrl || '',
      slackEnabled: req.body.slackEnabled || false,
      dashboardUrl: req.body.dashboardUrl || 'http://localhost:3030',
      refreshInterval: req.body.refreshInterval || 5,
      defaultTimeout: req.body.defaultTimeout || 10,
      defaultRetry: req.body.defaultRetry || 0
    };
    if (req.body.notifications !== undefined) {
      data.settings.notifications = req.body.notifications;
    }
    if (req.body.obsidianVaultPath !== undefined) {
      data.settings.obsidianVaultPath = req.body.obsidianVaultPath;
    }
    if (req.body.obsidianDailyFolder !== undefined) {
      data.settings.obsidianDailyFolder = req.body.obsidianDailyFolder;
    }
    saveJobs(data);

    // 환경변수 동적 업데이트 (현재 세션에서만)
    if (data.settings.slackWebhookUrl) {
      process.env.SLACK_WEBHOOK_URL = data.settings.slackWebhookUrl;
    }
    if (data.settings.dashboardUrl) {
      global.DASHBOARD_URL = data.settings.dashboardUrl;
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Webhook Tokens API ============

const WEBHOOK_TOKENS_FILE = path.join(__dirname, 'data', 'webhook-tokens.json');

function loadWebhookTokens() {
  try {
    if (fs.existsSync(WEBHOOK_TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(WEBHOOK_TOKENS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveWebhookTokens(tokens) {
  const dir = path.dirname(WEBHOOK_TOKENS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEBHOOK_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// 토큰 목록 (토큰 값은 마스킹)
app.get('/api/webhook-tokens', (req, res) => {
  const tokens = loadWebhookTokens();
  res.json(tokens.map(t => ({ ...t, token: t.token.substring(0, 8) + '...' })));
});

// 토큰 생성
app.post('/api/webhook-tokens', (req, res) => {
  const { name, allowedJobs } = req.body;
  const tokens = loadWebhookTokens();
  const newToken = {
    id: `tok-${Date.now()}`,
    name: name || '새 토큰',
    token: crypto.randomBytes(32).toString('hex'),
    enabled: true,
    allowedJobs: allowedJobs || [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    usageCount: 0
  };
  tokens.push(newToken);
  saveWebhookTokens(tokens);
  res.status(201).json(newToken);  // 전체 토큰 반환 (한 번만)
});

// 토큰 수정 (활성/비활성, 이름 변경)
app.put('/api/webhook-tokens/:id', (req, res) => {
  const tokens = loadWebhookTokens();
  const token = tokens.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  if (req.body.enabled !== undefined) token.enabled = req.body.enabled;
  if (req.body.name !== undefined) token.name = req.body.name;
  if (req.body.allowedJobs !== undefined) token.allowedJobs = req.body.allowedJobs;
  saveWebhookTokens(tokens);
  res.json({ ...token, token: token.token.substring(0, 8) + '...' });
});

// 토큰 삭제
app.delete('/api/webhook-tokens/:id', (req, res) => {
  const tokens = loadWebhookTokens();
  const index = tokens.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Token not found' });
  tokens.splice(index, 1);
  saveWebhookTokens(tokens);
  res.json({ success: true });
});

// 외부 웹훅 트리거
app.post('/api/webhook/:token', (req, res) => {
  const tokens = loadWebhookTokens();
  const tokenData = tokens.find(t => t.token === req.params.token && t.enabled);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or disabled token' });

  const { jobId, options } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const data = loadJobs();
  const job = data.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: `Job '${jobId}' not found` });

  if (tokenData.allowedJobs.length > 0 && !tokenData.allowedJobs.includes(jobId)) {
    return res.status(403).json({ error: 'Job not allowed for this token' });
  }

  tokenData.lastUsedAt = new Date().toISOString();
  tokenData.usageCount = (tokenData.usageCount || 0) + 1;
  saveWebhookTokens(tokens);

  const defaultOptions = getDefaultOptionsFromJob(job);
  const mergedOptions = { ...defaultOptions, ...(options || {}) };
  executeJob(job, 'webhook', mergedOptions)
    .catch(err => console.error(`[Webhook] Failed to execute ${job.id}:`, err.message));

  res.json({ success: true, message: `Job '${jobId}' triggered via webhook` });
});

// 알림 채널 테스트
app.post('/api/notifications/test', async (req, res) => {
  const { channel } = req.body;
  if (!channel || !channel.type) return res.status(400).json({ error: 'channel required' });

  const testJob = { name: '테스트 알림', id: 'test', category: 'test' };
  try {
    if (channel.type === 'slack') {
      await sendSlackNotification(testJob, 'success', { duration: 1000 }, channel.webhookUrl);
    } else if (channel.type === 'discord') {
      await sendDiscordNotification(testJob, 'success', { duration: 1000 }, channel.webhookUrl);
    } else if (channel.type === 'native') {
      sendSSEEvent('notification', { title: '🔔 테스트 알림', body: '알림이 정상 작동합니다.', status: 'success' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Export/Import API ============

// 전체 데이터 내보내기
app.get('/api/export', (req, res) => {
  const data = loadJobs();
  res.json(data);
});

// 전체 데이터 가져오기
app.post('/api/import', (req, res) => {
  try {
    const importData = req.body;

    // 기본 구조 검증
    if (!importData.jobs || !Array.isArray(importData.jobs)) {
      return res.status(400).json({ error: 'Invalid data format: jobs array required' });
    }

    // 기존 스케줄 정리
    Object.keys(scheduledJobs).forEach(id => {
      if (scheduledJobs[id]) {
        scheduledJobs[id].stop();
        delete scheduledJobs[id];
      }
    });

    // 데이터 저장
    saveJobs(importData);

    // 새 스케줄 초기화
    initializeJobs();

    res.json({ success: true, jobCount: importData.jobs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSV 변환 헬퍼
function convertToCSV(data, columns) {
  if (!data || data.length === 0) return '';

  const header = columns.join(',');
  const rows = data.map(item =>
    columns.map(col => {
      let val = item[col];
      if (val === null || val === undefined) val = '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',')
  );

  return [header, ...rows].join('\n');
}

// ============ 비동기 작업 시스템 APIs ============

// SSE 엔드포인트 - 작업 진행 상황 실시간 전송
app.get('/api/tasks/events', (req, res) => {
  const clientId = req.query.clientId || `client-${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 초기 연결 이벤트
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  // 클라이언트 등록
  sseClients.set(clientId, res);
  console.log(`[SSE] 클라이언트 연결: ${clientId} (총 ${sseClients.size}개)`);

  // keep-alive ping
  const pingInterval = setInterval(() => {
    if (sseClients.has(clientId)) {
      try {
        res.write(`:ping\n\n`);
      } catch (err) {
        clearInterval(pingInterval);
        sseClients.delete(clientId);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  // 연결 종료 시 정리
  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(clientId);
    console.log(`[SSE] 클라이언트 연결 해제: ${clientId}`);
  });
});

// 작업 제출 (비동기, 즉시 반환)
app.post('/api/tasks', (req, res) => {
  const { type, payload, clientId } = req.body;

  if (!type) {
    return res.status(400).json({ error: 'type required' });
  }

  const task = {
    id: generateTaskId(),
    type,
    payload: payload || {},
    status: 'pending',
    progress: 0,
    progressMessage: '대기 중...',
    result: null,
    error: null,
    stdout: '',
    stderr: '',
    logs: [],
    command: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    clientId
  };

  taskQueue.set(task.id, task);
  console.log(`[Tasks] 작업 생성: ${task.id} (${type})`);

  // 비동기로 작업 시작
  processTask(task);

  res.json({
    success: true,
    taskId: task.id,
    status: 'pending'
  });
});

// 작업 목록 조회
app.get('/api/tasks', (req, res) => {
  const tasks = Array.from(taskQueue.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  res.json({ tasks });
});

// 개별 작업 상태 조회
app.get('/api/tasks/:id', (req, res) => {
  const task = taskQueue.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// 작업 취소/삭제
app.delete('/api/tasks/:id', (req, res) => {
  const task = taskQueue.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // 실행 중인 프로세스 종료
  if (task.status === 'running' && runningTaskProcesses.has(task.id)) {
    runningTaskProcesses.get(task.id).kill('SIGTERM');
    runningTaskProcesses.delete(task.id);
  }

  taskQueue.delete(req.params.id);
  sendSSEEvent(task.clientId, 'task:deleted', { taskId: task.id });

  console.log(`[Tasks] 작업 삭제: ${task.id}`);
  res.json({ success: true });
});

// 작업 처리 함수
async function processTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  sendSSEEvent(task.clientId, 'task:started', {
    taskId: task.id,
    type: task.type
  });

  try {
    let result;

    switch (task.type) {
      case 'ask':
        result = await processAskTask(task);
        break;
      case 'daily-report':
        result = await processDailyReportTask(task);
        break;
      case 'session-summary':
        result = await processSessionSummaryTask(task);
        break;
      case 'full-daily-report':
        result = await processFullDailyReportTask(task);
        break;
      case 'day-wrapup':
        result = await processDayWrapupTask(task);
        break;
      case 'weekly-digest':
        result = await processWeeklyDigestTask(task);
        break;
      case 'session-insights':
        result = await processSessionInsightsTask(task);
        break;
      case 'review-analysis':
        result = await processReviewAnalysisTask(task);
        break;
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date().toISOString();

    sendSSEEvent(task.clientId, 'task:completed', {
      taskId: task.id,
      type: task.type,
      result
    });

    console.log(`[Tasks] 작업 완료: ${task.id}`);

  } catch (error) {
    task.status = 'failed';
    task.error = error.message;
    task.completedAt = new Date().toISOString();

    sendSSEEvent(task.clientId, 'task:failed', {
      taskId: task.id,
      type: task.type,
      error: error.message
    });

    console.error(`[Tasks] 작업 실패: ${task.id}`, error.message);
  }

  runningTaskProcesses.delete(task.id);

  // 1시간 이상 된 완료/실패 작업 정리
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, t] of taskQueue) {
    if ((t.status === 'completed' || t.status === 'failed') &&
        new Date(t.completedAt).getTime() < oneHourAgo) {
      taskQueue.delete(id);
    }
  }
}

// Claude 질문 처리
async function processAskTask(task) {
  const { prompt } = task.payload;
  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  // Claude CLI 존재 확인
  if (!fs.existsSync(claudePath)) {
    throw new Error(`Claude CLI를 찾을 수 없습니다: ${claudePath}`);
  }

  task.command = `${claudePath} -p "..."`;
  task.logs.push({ type: 'info', time: new Date().toISOString(), text: `Claude CLI 경로: ${claudePath}` });
  task.logs.push({ type: 'cmd', time: new Date().toISOString(), text: `실행: claude -p "(프롬프트 ${prompt.length}자)"` });

  updateTaskProgress(task, 10, `Claude CLI 실행 중: ${claudePath}`);

  return new Promise((resolve, reject) => {
    console.log(`[Task ${task.id}] Claude CLI 실행: ${claudePath}`);

    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    task.logs.push({ type: 'info', time: new Date().toISOString(), text: `프로세스 시작됨 (PID: ${claude.pid})` });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
      updateTaskProgress(task, 50, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (5분)'));
    }, 300000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      updateTaskProgress(task, 90, '완료 처리 중...');
      if (code === 0) {
        resolve({ response: stdout.trim() });
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text: `프로세스 에러: ${err.message}` });
      reject(new Error(`Claude CLI 실행 실패: ${err.message}`));
    });

    // 프로세스가 즉시 종료되는 경우 감지
    claude.on('spawn', () => {
      task.logs.push({ type: 'info', time: new Date().toISOString(), text: '프로세스 정상 시작됨' });
    });
  });
}

// 일일 보고서 처리
async function processDailyReportTask(task) {
  const { date } = task.payload;
  const targetDate = date || getKSTDateString();

  updateTaskProgress(task, 10, '세션 데이터 수집 중...');

  const sessions = findSessions(targetDate);

  if (sessions.length === 0) {
    return {
      date: targetDate,
      sessionsCount: 0,
      report: `# ${targetDate} 일일 보고서\n\n해당 날짜에 Claude Code 세션이 없습니다.`
    };
  }

  updateTaskProgress(task, 20, '세션 분석 중...');

  // 세션 요약 수집
  const sessionSummaries = [];
  for (const sess of sessions.slice(0, 10)) {
    try {
      const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 50 });
      sessionSummaries.push({
        project: data.project,
        alias: sess.alias || null,
        displayName: sess.alias ? `${sess.alias} (${data.project})` : data.project,
        messageCount: data.messageCount,
        tools: data.toolsUsed.slice(0, 10),
        files: data.filesChanged.slice(0, 10),
        firstMessage: data.firstMessage,
        conversations: data.conversation.slice(0, 20).map(c => ({
          role: c.role,
          content: c.content?.substring(0, 500)
        }))
      });
    } catch (e) {
      console.error(`[DailyReport] 세션 파싱 실패: ${sess.id}`, e.message);
    }
  }

  updateTaskProgress(task, 40, 'Claude 분석 요청 중...');

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  const prompt = `다음은 ${targetDate} 하루 동안의 Claude Code 세션 요약입니다.
이 정보를 바탕으로 하루 동안 무엇을 작업했는지 깔끔한 마크다운 형식의 일일 보고서를 작성해주세요.

보고서에 포함할 내용:
1. 📋 오늘의 요약 (한 문단)
2. 🎯 주요 작업 (프로젝트별로 정리)
3. 🔧 사용한 도구 통계
4. 📁 변경된 파일 목록
5. 💡 주요 인사이트 또는 배운 점
6. 📝 내일 할 일 제안 (있다면)

세션 데이터:
${JSON.stringify(sessionSummaries, null, 2)}

마크다운 형식으로 깔끔하게 작성해주세요. 이모지를 적절히 사용하고, 항목별로 구분해주세요.`;

  const report = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
      updateTaskProgress(task, 70, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (2분)'));
    }, 120000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });

  updateTaskProgress(task, 90, '보고서 생성 완료!');

  // 캐시 저장
  dailyReportCache.set(targetDate, {
    success: true,
    date: targetDate,
    sessionsCount: sessions.length,
    report
  });

  // 파일에 저장
  try {
    const reports = loadDailyReports();
    const record = {
      id: `dr-${targetDate}-daily-report`,
      date: targetDate,
      type: 'daily-report',
      sessionsCount: sessions.length,
      report,
      createdAt: new Date().toISOString()
    };
    const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'daily-report');
    if (existIdx >= 0) reports[existIdx] = record;
    else reports.push(record);
    saveDailyReports(reports);
    console.log(`[DailyReport] 저장 완료: ${targetDate}`);
  } catch (e) {
    console.error('[DailyReport] 저장 실패:', e.message);
  }

  return {
    date: targetDate,
    sessionsCount: sessions.length,
    report
  };
}

// 세션 요약 처리
async function processSessionSummaryTask(task) {
  const { sessionId, projectPath } = task.payload;

  updateTaskProgress(task, 10, '세션 데이터 로드 중...');

  // 메시지 수를 줄여서 프롬프트 최적화
  const sessionData = parseSessionFile(sessionId, projectPath, { maxMessages: 50 });

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  // Claude CLI 존재 확인
  if (!fs.existsSync(claudePath)) {
    throw new Error(`Claude CLI를 찾을 수 없습니다: ${claudePath}`);
  }

  updateTaskProgress(task, 30, `Claude CLI 실행 준비: ${claudePath}`);
  task.logs.push({ type: 'info', time: new Date().toISOString(), text: `Claude CLI 경로: ${claudePath}` });

  // 사용자 메시지만 추출하여 프롬프트 간소화
  const userMessages = sessionData.conversation
    .filter(c => c.role === 'user' && c.content)
    .slice(0, 15)
    .map(c => c.content.substring(0, 300));

  const prompt = `다음 Claude Code 세션을 요약해주세요.

프로젝트: ${sessionData.project}
메시지 수: ${sessionData.messageCount}
도구: ${sessionData.toolsUsed.slice(0, 8).join(', ')}
파일: ${sessionData.filesChanged.slice(0, 8).join(', ')}

사용자 요청:
${userMessages.join('\n---\n')}

간결한 마크다운 형식으로 작성:
## 요약
## 주요 작업
## 결과`;

  // 실행 명령어 저장
  task.command = `${claudePath} -p "..."`;
  task.logs.push({ type: 'cmd', time: new Date().toISOString(), text: `실행: claude -p "(프롬프트 ${prompt.length}자)"` });

  updateTaskProgress(task, 35, 'Claude CLI 실행 중...');

  const summary = await new Promise((resolve, reject) => {
    console.log(`[Task ${task.id}] Claude CLI 실행: ${claudePath}`);

    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    task.logs.push({ type: 'info', time: new Date().toISOString(), text: `프로세스 시작됨 (PID: ${claude.pid})` });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
      updateTaskProgress(task, 60, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    // 타임아웃 4분으로 증가
    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (4분)'));
    }, 240000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });

  updateTaskProgress(task, 90, '요약 완료!');

  // 파일에 저장
  try {
    const summaries = loadSessionSummaries();
    const record = {
      id: `ss-${sessionId}`,
      sessionId,
      projectPath: task.payload.projectPath,
      project: sessionData.project,
      summary,
      createdAt: new Date().toISOString()
    };
    const existIdx = summaries.findIndex(s => s.sessionId === sessionId);
    if (existIdx >= 0) summaries[existIdx] = record;
    else summaries.push(record);
    saveSessionSummaries(summaries);
    console.log(`[SessionSummary] 저장 완료: ${sessionId}`);
  } catch (e) {
    console.error('[SessionSummary] 저장 실패:', e.message);
  }

  return {
    sessionId,
    project: sessionData.project,
    summary
  };
}

// 종합 일일 보고서 처리 (세션 + 메모 + 작업 이력)
async function processFullDailyReportTask(task) {
  const { date } = task.payload;
  const targetDate = date || getKSTDateString();

  updateTaskProgress(task, 5, '데이터 수집 중...');

  // 1. Claude 세션 데이터
  const sessions = findSessions(targetDate);
  const sessionSummaries = [];
  for (const sess of sessions.slice(0, 10)) {
    try {
      const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 30 });
      sessionSummaries.push({
        project: data.project,
        messageCount: data.messageCount,
        tools: data.toolsUsed.slice(0, 5),
        files: data.filesChanged.slice(0, 5),
        firstMessage: data.firstMessage,
        keyConversations: data.conversation
          .filter(c => c.role === 'user' && c.content)
          .slice(0, 5)
          .map(c => c.content.substring(0, 200))
      });
    } catch (e) { /* skip */ }
  }

  updateTaskProgress(task, 20, '작업 이력 수집 중...');

  // 2. 작업 이력
  const jobsToday = jobHistory.filter(h => h.startTime?.startsWith(targetDate));
  const jobsSummary = jobsToday.map(j => ({
    name: j.jobName,
    status: j.status,
    duration: j.duration
  }));

  updateTaskProgress(task, 30, '메모 데이터 수집 중...');

  // 3. 빠른 메모 (로그 파일에서)
  let quickMemos = [];
  const memoLogPath = path.join(__dirname, 'logs', 'quick-input.log');
  if (fs.existsSync(memoLogPath)) {
    try {
      const memoContent = fs.readFileSync(memoLogPath, 'utf8');
      const memoLines = memoContent.split('\n').filter(l => l.includes(targetDate));
      quickMemos = memoLines.slice(0, 10).map(l => {
        try {
          return JSON.parse(l);
        } catch { return null; }
      }).filter(Boolean);
    } catch (e) { /* skip */ }
  }

  updateTaskProgress(task, 40, 'Claude 분석 요청 중...');

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  const prompt = `다음은 ${targetDate} 하루 동안의 모든 활동 데이터입니다.
이 정보를 바탕으로 오늘 하루를 종합적으로 정리한 상세 보고서를 마크다운 형식으로 작성해주세요.

## Claude Code 세션 (${sessions.length}개)
${JSON.stringify(sessionSummaries, null, 2)}

## 자동화 작업 실행 (${jobsToday.length}개)
${JSON.stringify(jobsSummary, null, 2)}

## 빠른 메모 (${quickMemos.length}개)
${quickMemos.map(m => m?.content || m?.text || '').join('\n')}

---

보고서에 포함할 내용:
1. # ${targetDate} 일일 보고서 (제목)
2. ## 📋 오늘의 요약 - 하루 전체를 2-3문장으로 요약
3. ## 🎯 주요 작업 - 프로젝트별로 무엇을 했는지 정리
4. ## 🔧 사용한 도구 - 자주 사용한 도구 통계
5. ## 📁 변경된 파일 - 주요 파일 변경 내역
6. ## ⚙️ 자동화 작업 - 실행된 크론 작업 결과
7. ## 📝 메모 및 아이디어 - 빠른 메모 내용 정리
8. ## 💡 오늘의 인사이트 - 배운 점, 개선할 점
9. ## 📌 내일 할 일 - 이어서 해야 할 작업 제안

마크다운 형식으로 깔끔하게 작성해주세요. 이모지를 적절히 사용하세요.`;

  const report = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
      updateTaskProgress(task, 70, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (3분)'));
    }, 180000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });

  updateTaskProgress(task, 90, '보고서 생성 완료!');

  // 파일에 저장
  try {
    const reports = loadDailyReports();
    const record = {
      id: `dr-${targetDate}-full-daily-report`,
      date: targetDate,
      type: 'full-daily-report',
      sessionsCount: sessions.length,
      jobsCount: jobsToday.length,
      memosCount: quickMemos.length,
      report,
      createdAt: new Date().toISOString()
    };
    const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'full-daily-report');
    if (existIdx >= 0) reports[existIdx] = record;
    else reports.push(record);
    saveDailyReports(reports);
    console.log(`[FullDailyReport] 저장 완료: ${targetDate}`);
  } catch (e) {
    console.error('[FullDailyReport] 저장 실패:', e.message);
  }

  return {
    date: targetDate,
    sessionsCount: sessions.length,
    jobsCount: jobsToday.length,
    memosCount: quickMemos.length,
    report
  };
}

// Day Wrap-up 보고서 처리 (사용자가 선택한 데이터로 의미있는 하루 마무리)
async function processDayWrapupTask(task) {
  const { date, selectedSessions, githubActivity, memos, morningPlan, reflection } = task.payload;
  const targetDate = date || getKSTDateString();

  updateTaskProgress(task, 10, '선택된 세션 데이터 분석 중...');

  // 선택된 세션 데이터 수집
  const sessionDetails = [];
  if (selectedSessions && selectedSessions.length > 0) {
    for (const sess of selectedSessions) {
      try {
        const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 30 });
        const userMessages = data.conversation
          .filter(c => c.role === 'user' && c.content)
          .slice(0, 10)
          .map(c => c.content.substring(0, 200));

        sessionDetails.push({
          project: data.project,
          alias: sess.alias || null,
          messageCount: data.messageCount,
          tools: data.toolsUsed.slice(0, 5),
          files: data.filesChanged.slice(0, 5),
          keyRequests: userMessages
        });
      } catch (e) {
        console.error(`[DayWrapup] 세션 파싱 실패: ${sess.id}`, e.message);
      }
    }
  }

  updateTaskProgress(task, 30, '데이터 종합 중...');

  // 메모 데이터
  const quickMemosPath = path.join(__dirname, 'data', 'quick-memos.json');
  let todayMemos = memos || [];
  if (todayMemos.length === 0 && fs.existsSync(quickMemosPath)) {
    try {
      const allMemos = JSON.parse(fs.readFileSync(quickMemosPath, 'utf8'));
      todayMemos = allMemos.filter(m => m.timestamp?.startsWith(targetDate));
    } catch (e) { /* ignore */ }
  }

  // 모닝 플랜 데이터
  let todayMorningPlan = morningPlan || null;
  if (!todayMorningPlan) {
    try {
      const plans = loadMorningPlans();
      todayMorningPlan = plans.find(p => p.date === targetDate) || null;
    } catch (e) { /* ignore */ }
  }

  updateTaskProgress(task, 50, 'Claude에게 하루 마무리 작성 요청 중...');

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  // 의미있는 하루 마무리를 위한 프롬프트
  const prompt = `당신은 사용자의 하루를 돌아보며 의미있는 회고를 작성해주는 멘토입니다.
다음 정보를 바탕으로 따뜻하고 통찰력 있는 하루 마무리 보고서를 작성해주세요.

## 📅 날짜
${targetDate}

## 💻 오늘의 개발 세션 (${sessionDetails.length}개)
${sessionDetails.length > 0 ? sessionDetails.map(s => `
### ${s.alias ? `${s.alias} (${s.project})` : s.project}
- 메시지: ${s.messageCount}개
- 사용 도구: ${s.tools.join(', ')}
- 변경 파일: ${s.files.join(', ')}
- 주요 요청: ${s.keyRequests.slice(0, 3).join(' / ')}
`).join('\n') : '(선택된 세션 없음)'}

## 🐙 GitHub 활동
${githubActivity ? `
- 계정: ${(githubActivity.accounts || []).join(', ') || '알 수 없음'}
- 커밋: ${githubActivity.commits?.length || 0}개 ${githubActivity.commits?.map(c => `(${c.repoShort}: ${(c.messages || []).slice(0, 2).join(', ')})`).join(', ') || ''}
- PR: ${githubActivity.prs?.length || 0}개 ${githubActivity.prs?.map(p => `${p.repoShort}#${p.number} ${p.title} [${p.action}]`).join(', ') || ''}
- 리뷰: ${githubActivity.reviews?.length || 0}개 ${githubActivity.reviews?.map(r => `${r.repoShort}#${r.prNumber} [${r.state}]`).join(', ') || ''}
- 코멘트: ${githubActivity.comments?.length || 0}개 ${githubActivity.comments?.slice(0, 5).map(c => `${c.repoShort}: "${c.body?.substring(0, 50)}"`).join(', ') || ''}
- 관련 레포: ${(githubActivity.repos || []).join(', ') || '없음'}
` : '(GitHub 데이터 없음)'}

## ☀️ 아침에 세운 계획
${todayMorningPlan ? `
- 주요 업무: ${(todayMorningPlan.tasks || []).join(', ') || '(없음)'}
- 추가 할 일: ${(todayMorningPlan.additionalTasks || []).map(t => `${t.category}: ${t.content}`).join(', ') || '(없음)'}
- 목표: ${(todayMorningPlan.goals || []).join(', ') || '(없음)'}
- 집중 시간: ${todayMorningPlan.focusTime || '(미설정)'}
- 다짐: ${todayMorningPlan.motto || '(없음)'}
` : '(아침 계획 미작성)'}

## 📝 오늘의 메모 (${todayMemos.length}개)
${todayMemos.map(m => `- ${m.content || m.text || JSON.stringify(m)}`).join('\n') || '(메모 없음)'}

## 🪞 사용자의 회고
${reflection ? `
- 오늘 배운 것: ${reflection.learned || '(미입력)'}
- 잘한 점: ${reflection.proud || '(미입력)'}
- 개선할 점: ${reflection.improve || '(미입력)'}
- 내일 목표: ${reflection.tomorrow || '(미입력)'}
- 감사한 것: ${reflection.grateful || '(미입력)'}
- 한 줄 소감: ${reflection.oneline || '(미입력)'}
` : '(회고 미입력)'}

---

위 정보를 바탕으로 다음 형식의 마크다운 보고서를 작성해주세요:

# 🌙 ${targetDate} 하루 마무리

## 📋 오늘의 요약
(한 문단으로 오늘 하루를 요약. 따뜻하고 격려하는 톤으로)

## 🎯 오늘의 성취
(구체적인 성취 목록. 작은 것도 인정해주기)

## ☀️ 계획 vs 실제
(아침에 세운 계획과 실제 달성한 것을 비교. 아침 계획이 없으면 이 섹션 생략)

## 💡 배움과 인사이트
(오늘 배운 점, 깨달은 점을 정리)

## 🚀 내일을 위한 한 걸음
(내일 해야 할 일, 개선점을 구체적으로)

## ✨ 오늘의 한마디
(영감을 주는 격려의 한마디로 마무리)

---
진심어린 톤으로, 사용자가 하루를 의미있게 마무리할 수 있도록 작성해주세요.`;

  const report = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
      updateTaskProgress(task, 75, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (5분)'));
    }, 300000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });

  updateTaskProgress(task, 95, '하루 마무리 완료!');

  // 파일에 저장
  try {
    const reports = loadDailyReports();
    const record = {
      id: `dr-${targetDate}-day-wrapup`,
      date: targetDate,
      type: 'day-wrapup',
      sessionsCount: sessionDetails.length,
      memosCount: todayMemos.length,
      hasGithub: !!githubActivity,
      hasReflection: !!reflection,
      report,
      createdAt: new Date().toISOString()
    };
    const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'day-wrapup');
    if (existIdx >= 0) reports[existIdx] = record;
    else reports.push(record);
    saveDailyReports(reports);
    console.log(`[DayWrapup] 저장 완료: ${targetDate}`);
  } catch (e) {
    console.error('[DayWrapup] 저장 실패:', e.message);
  }

  return {
    date: targetDate,
    sessionsCount: sessionDetails.length,
    memosCount: todayMemos.length,
    hasGithub: !!githubActivity,
    hasReflection: !!reflection,
    report
  };
}

// --- 주간 다이제스트 태스크 처리 ---
async function processWeeklyDigestTask(task) {
  const today = getKSTDateString();
  const weekStart = task.payload.weekStart || getWeekStart(today);
  const weekEndDate = new Date(weekStart + 'T00:00:00');
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = getKSTDateString(weekEndDate);
  const dates = getDateRange(weekStart, weekEnd);

  updateTaskProgress(task, 10, '주간 데이터 수집 중...');

  // 1. 데이터 수집
  let allSessions = [];
  let allMemos = [];
  let allObsidianMemos = [];
  let allPlans = [];

  for (const date of dates) {
    try { allSessions.push(...findSessions(date)); } catch (e) { /* ignore */ }
    try { allObsidianMemos.push(...parseObsidianMemos(date)); } catch (e) { /* ignore */ }
  }

  const weekMemos = loadQuickMemos().filter(m =>
    m.timestamp >= weekStart && m.timestamp < weekEnd + 'T23:59:59'
  );
  allMemos = weekMemos;

  const weekPlans = loadMorningPlans().filter(p =>
    p.date >= weekStart && p.date <= weekEnd
  );
  allPlans = weekPlans;

  const weekHistory = jobHistory.filter(h =>
    h.startTime >= weekStart && h.startTime < weekEnd + 'T23:59:59'
  );

  const weekBacklogs = loadBacklogs();
  const completedBacklogs = weekBacklogs.filter(b => b.done && b.updatedAt >= weekStart && b.updatedAt <= weekEnd + 'T23:59:59');

  updateTaskProgress(task, 30, 'Claude 분석 프롬프트 구성 중...');

  // 2. 통계 계산
  const totalJobRuns = weekHistory.length;
  const successCount = weekHistory.filter(h => h.status === 'success').length;
  const successRate = totalJobRuns > 0 ? Math.round((successCount / totalJobRuns) * 100) : 0;

  // 프로젝트별 세션
  const projects = [...new Set(allSessions.map(s => s.project || 'unknown'))];

  // 세션 요약
  const sessionSummaries = allSessions.slice(0, 20).map(s =>
    `- [${s.modifiedAt?.split('T')[0] || '?'}] ${s.project || 'unknown'}: ${s.firstMessage?.substring(0, 80) || '(내용 없음)'}`
  ).join('\n');

  // 메모 내용
  const memoContents = [...allMemos.map(m => `- [대시보드] ${m.content?.substring(0, 100) || ''}`),
    ...allObsidianMemos.slice(0, 20).map(m => `- [Obsidian] ${m.content?.substring(0, 100) || ''}`)
  ].join('\n');

  // 작업 이력 요약
  const jobSummary = {};
  for (const h of weekHistory) {
    const name = h.jobName || h.jobId;
    if (!jobSummary[name]) jobSummary[name] = { total: 0, success: 0 };
    jobSummary[name].total++;
    if (h.status === 'success') jobSummary[name].success++;
  }
  const jobHistorySummary = Object.entries(jobSummary)
    .map(([name, s]) => `- ${name}: ${s.total}회 실행 (성공 ${s.success})`)
    .join('\n');

  // 3. Claude 프롬프트
  const prompt = `당신은 개인 생산성 분석가입니다. 아래 데이터를 분석하여 주간 다이제스트를 작성하세요.

## 분석 데이터
- 기간: ${weekStart} ~ ${weekEnd}
- Claude 세션: ${allSessions.length}개 (프로젝트: ${projects.join(', ')})
- 작업 실행: ${totalJobRuns}회 (성공률: ${successRate}%)
- 메모: ${allMemos.length + allObsidianMemos.length}개
- 완료 백로그: ${completedBacklogs.length}개
- 모닝 플랜: ${allPlans.length}일

## 세션 상세
${sessionSummaries || '(세션 데이터 없음)'}

## 메모 내용
${memoContents || '(메모 없음)'}

## 작업 이력 요약
${jobHistorySummary || '(작업 이력 없음)'}

---

아래 형식으로 분석해주세요:

# 📊 주간 다이제스트 (${weekStart} ~ ${weekEnd})

## 🎯 이번 주 하이라이트
- (가장 의미있는 성과 3개)

## 📈 활동 요약
- 세션 수 / 평균 시간 / 가장 활발한 프로젝트
- 작업 실행 / 성공률 / 가장 많이 실행된 작업

## 💡 주요 학습 & 인사이트
- (세션과 메모에서 추출한 핵심 학습 내용)

## 🔄 진행 중인 업무
- (아직 끝나지 않은 것들, 백로그에서 추출)

## 🎯 다음 주 제안
- (데이터 기반 구체적 제안 3개)

## 📉 개선 포인트
- (패턴 분석 기반, 예: "수요일에 집중도가 낮아지는 경향")`;

  updateTaskProgress(task, 40, 'Claude CLI 실행 중...');

  // 4. Claude CLI 실행
  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  if (!fs.existsSync(claudePath)) {
    throw new Error(`Claude CLI를 찾을 수 없습니다: ${claudePath}`);
  }

  task.command = `${claudePath} -p "..."`;
  task.logs.push({ type: 'info', time: new Date().toISOString(), text: `주간 데이터: 세션 ${allSessions.length}개, 메모 ${allMemos.length + allObsidianMemos.length}개, 작업 ${totalJobRuns}회` });

  const markdown = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
      task.stdout = stdout;
      updateTaskProgress(task, 60, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
      task.stderr = stderr;
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (10분)'));
    }, 600000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Exit code: ${code}`));
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Claude CLI 실행 실패: ${err.message}`));
    });
  });

  updateTaskProgress(task, 85, '결과 저장 중...');

  // 5. 저장
  const digest = {
    id: `wd-${weekStart}`,
    weekStart,
    weekEnd,
    markdown,
    stats: {
      sessions: allSessions.length,
      jobRuns: totalJobRuns,
      memos: allMemos.length + allObsidianMemos.length,
      successRate
    },
    createdAt: new Date().toISOString()
  };

  const digests = loadWeeklyDigests();
  const existIdx = digests.findIndex(d => d.weekStart === weekStart);
  if (existIdx >= 0) digests[existIdx] = digest;
  else digests.push(digest);
  saveWeeklyDigests(digests);

  // Obsidian에 저장
  try {
    const { vaultPath } = getObsidianPaths();
    const weeklyDir = path.join(vaultPath, 'WEEKLY');
    if (!fs.existsSync(weeklyDir)) fs.mkdirSync(weeklyDir, { recursive: true });
    fs.writeFileSync(path.join(weeklyDir, `${weekStart}-digest.md`), markdown);
    task.logs.push({ type: 'info', time: new Date().toISOString(), text: `Obsidian 저장: WEEKLY/${weekStart}-digest.md` });
  } catch (e) {
    task.logs.push({ type: 'warn', time: new Date().toISOString(), text: `Obsidian 저장 실패: ${e.message}` });
  }

  updateTaskProgress(task, 95, '완료 처리 중...');

  return { markdown, weekStart, weekEnd, stats: digest.stats };
}

// ============ Personal Assistant APIs ============

// Claude 세션 찾기 헬퍼
function findSessions(targetDate, projectFilter) {
  const sessions = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return sessions;

  // 별명 로드
  const aliases = loadSessionAliases();

  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectPath = path.join(CLAUDE_PROJECTS, dir);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;

      // memory, .deleted 폴더 제외
      if (dir === 'memory' || dir === '.deleted') continue;

      // 프로젝트 필터
      const projectName = dir.split('-').pop();
      if (projectFilter && !projectName.toLowerCase().includes(projectFilter.toLowerCase())) continue;

      // .jsonl 파일 검색
      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const fileStat = fs.statSync(filePath);
        const mtime = getKSTDateString(fileStat.mtime);
        if (mtime === targetDate) {
          // 첫 메시지 추출 (처음 20줄만 읽기)
          let firstMessage = '';
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').slice(0, 20);
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' && entry.message?.content) {
                  const msgContent = entry.message.content;
                  if (typeof msgContent === 'string') {
                    firstMessage = msgContent.substring(0, 100);
                  } else if (Array.isArray(msgContent)) {
                    const textPart = msgContent.find(p => p.type === 'text');
                    if (textPart) firstMessage = textPart.text?.substring(0, 100) || '';
                  }
                  break;
                }
              } catch (e) { /* skip */ }
            }
          } catch (e) { /* skip */ }

          const sessionId = file.replace('.jsonl', '');
          sessions.push({
            id: sessionId,
            project: projectName,
            projectPath: dir,
            file: file,
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
            firstMessage: firstMessage || '',
            alias: aliases[sessionId] || null
          });
        }
      }
    }
  } catch (err) {
    console.error('[Sessions] Error finding sessions:', err.message);
  }

  return sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

// 세션 파일 파싱 헬퍼
function parseSessionFile(sessionId, projectPath, options = {}) {
  const filePath = path.join(CLAUDE_PROJECTS, projectPath, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    throw new Error('Session file not found');
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  // 별명 로드
  const aliases = loadSessionAliases();

  const result = {
    id: sessionId,
    project: projectPath.split('-').pop(),
    projectPath: projectPath,
    alias: aliases[sessionId] || null,
    filesChanged: new Set(),
    toolsUsed: new Set(),
    messageCount: 0,
    firstMessage: null,
    lastActivity: null,
    conversation: []
  };

  const includeConversation = options.includeConversation !== false;
  const maxMessages = options.maxMessages || 200;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // user 또는 assistant 메시지만 카운트
      if (entry.type === 'user' || entry.type === 'assistant') {
        result.messageCount++;
        if (entry.timestamp) {
          result.lastActivity = entry.timestamp;
        }
      }

      // 첫 사용자 메시지 추출 (type이 'user')
      if (!result.firstMessage && entry.type === 'user') {
        const msgContent = entry.message?.content;
        if (typeof msgContent === 'string') {
          result.firstMessage = msgContent.substring(0, 200);
        } else if (Array.isArray(msgContent)) {
          const textPart = msgContent.find(p => p.type === 'text');
          if (textPart) result.firstMessage = textPart.text?.substring(0, 200);
        }
      }

      // 대화 내용 추출
      if (includeConversation && result.conversation.length < maxMessages) {
        if (entry.type === 'user') {
          // user 메시지 - content는 보통 문자열
          const msgContent = entry.message?.content;
          let text = '';
          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            // 배열인 경우 텍스트 부분 추출
            for (const part of msgContent) {
              if (part.type === 'text') {
                text += part.text || '';
              }
            }
          }

          // 시스템 리마인더 필터링
          if (text && !text.includes('<system-reminder>') && text.trim().length > 0) {
            result.conversation.push({
              role: 'user',
              content: text.substring(0, 3000),
              timestamp: entry.timestamp
            });
          }
        } else if (entry.type === 'assistant') {
          const msgContent = entry.message?.content;
          let text = '';
          const tools = [];

          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === 'text' && part.text) {
                text += part.text;
              } else if (part.type === 'tool_use') {
                result.toolsUsed.add(part.name);
                tools.push({ name: part.name, input: part.input });
                if (part.input?.file_path) {
                  result.filesChanged.add(path.basename(part.input.file_path));
                }
              }
            }
          } else if (typeof msgContent === 'string') {
            text = msgContent;
          }

          if (text.trim() || tools.length > 0) {
            result.conversation.push({
              role: 'assistant',
              content: text.trim().substring(0, 3000),
              tools: tools.map(t => t.name),
              toolDetails: tools.slice(0, 5), // 상세 정보는 5개까지만
              timestamp: entry.timestamp
            });
          }
        }
      } else {
        // 대화 내용 미포함 시에도 도구 사용은 추출
        if (entry.type === 'assistant' && entry.message?.content) {
          const msgContent = entry.message.content;
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === 'tool_use') {
                result.toolsUsed.add(part.name);
                if (part.input?.file_path) {
                  result.filesChanged.add(path.basename(part.input.file_path));
                }
              }
            }
          }
        }
      }
    } catch (e) {
      // Skip invalid JSON lines
    }
  }

  result.filesChanged = Array.from(result.filesChanged).slice(0, 30);
  result.toolsUsed = Array.from(result.toolsUsed);

  return result;
}

// ============ Obsidian Daily Note 쓰기 헬퍼 ============
function getObsidianPaths() {
  const yaml = require('js-yaml');

  // 1순위: 대시보드 설정 (jobs.json)
  const jobsData = loadJobs();
  if (jobsData.settings?.obsidianVaultPath) {
    return {
      vaultPath: jobsData.settings.obsidianVaultPath.replace(/^~/, os.homedir()),
      dailyFolder: jobsData.settings.obsidianDailyFolder || 'DAILY'
    };
  }

  // 2순위: YAML 설정 파일
  const configPaths = [
    path.join(__dirname, '../config/settings.local.yaml'),
    path.join(__dirname, '../config/settings.yaml'),
    path.join(__dirname, 'config/settings.yaml')
  ];

  let vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian');
  let dailyFolder = 'DAILY';

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
        if (config?.vault?.path) {
          vaultPath = config.vault.path.replace(/^~/, os.homedir());
        }
        if (config?.vault?.daily_folder) {
          dailyFolder = config.vault.daily_folder;
        }
        break;
      } catch (e) { /* ignore */ }
    }
  }

  return { vaultPath, dailyFolder };
}

function appendToObsidianSection(sectionHeader, content, date) {
  try {
    const { vaultPath, dailyFolder } = getObsidianPaths();
    const targetDate = date || getKSTDateString();
    const dailyNotePath = path.join(vaultPath, dailyFolder, `${targetDate}.md`);

    if (!fs.existsSync(dailyNotePath)) {
      console.log(`[Obsidian] Daily note not found: ${dailyNotePath}`);
      return false;
    }

    let fileContent = fs.readFileSync(dailyNotePath, 'utf8');

    const escSection = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(`(${escSection}[^\n]*\n)`, 'i');

    if (sectionRegex.test(fileContent)) {
      fileContent = fileContent.replace(sectionRegex, `$1${content}\n`);
    } else {
      fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
    }

    fs.writeFileSync(dailyNotePath, fileContent, 'utf8');
    console.log(`[Obsidian] Appended to ${sectionHeader}`);
    return true;
  } catch (e) {
    console.error('[Obsidian] Write failed:', e.message);
    return false;
  }
}

// ============ 빠른 메모 API ============
const QUICK_MEMOS_FILE = path.join(__dirname, 'data', 'quick-memos.json');

function loadQuickMemos() {
  try {
    if (fs.existsSync(QUICK_MEMOS_FILE)) {
      return JSON.parse(fs.readFileSync(QUICK_MEMOS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveQuickMemos(memos) {
  const dir = path.dirname(QUICK_MEMOS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(QUICK_MEMOS_FILE, JSON.stringify(memos, null, 2));
}

// GET /api/quick-memos - 메모 목록 조회
app.get('/api/quick-memos', (req, res) => {
  const { date } = req.query;
  let memos = loadQuickMemos();
  const categories = loadMemoCategories();

  if (date) {
    memos = memos.filter(m => {
      if (!m.timestamp) return false;
      // KST 기준으로 날짜 비교 (UTC timestamp → KST date)
      const kstDate = getKSTDateString(new Date(m.timestamp));
      return kstDate === date;
    });
  }

  // 카테고리/태그 데이터 병합
  const enriched = memos.map(m => ({
    ...m,
    category: categories[m.id]?.category || null,
    tags: categories[m.id]?.tags || [],
    autoTags: categories[m.id]?.autoTags || false
  }));

  res.json({ memos: enriched });
});

// POST /api/quick-memos - 메모 저장
app.post('/api/quick-memos', (req, res) => {
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  const memos = loadQuickMemos();
  const newMemo = {
    id: `memo-${Date.now()}`,
    content: content.trim(),
    timestamp: new Date().toISOString()
  };

  memos.unshift(newMemo);

  // 최대 500개까지만 저장
  if (memos.length > 500) {
    memos.splice(500);
  }

  saveQuickMemos(memos);
  console.log(`[Memos] 메모 저장: ${content.substring(0, 30)}...`);

  // Obsidian Daily Note에도 기록
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  appendToObsidianSection('## ⏰ 시간별 메모', `- \`${timeStr}\` ${content.trim()}`);

  res.json({ success: true, memo: newMemo });

  // 백그라운드 자동 분류 (논블로킹)
  classifyMemoBackground(newMemo.id, newMemo.content).catch(err =>
    console.error('[MemoCategory] 분류 실패:', err.message)
  );
});

// DELETE /api/quick-memos/:id - 메모 삭제
app.delete('/api/quick-memos/:id', (req, res) => {
  const { id } = req.params;
  const memos = loadQuickMemos();
  const idx = memos.findIndex(m => m.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Memo not found' });
  }

  memos.splice(idx, 1);
  saveQuickMemos(memos);

  res.json({ success: true });
});

// ============ 하루 시작 (Morning Plan) API ============
const MORNING_PLANS_FILE = path.join(__dirname, 'data', 'morning-plans.json');

function loadMorningPlans() {
  try {
    if (fs.existsSync(MORNING_PLANS_FILE)) {
      return JSON.parse(fs.readFileSync(MORNING_PLANS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveMorningPlans(plans) {
  const dir = path.dirname(MORNING_PLANS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MORNING_PLANS_FILE, JSON.stringify(plans, null, 2));
}

// GET /api/morning-plans - 모닝 플랜 목록 조회
app.get('/api/morning-plans', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const plans = loadMorningPlans();
    const list = plans.map(p => ({ id: p.id, date: p.date, createdAt: p.createdAt }))
      .reverse().slice(0, limit);
    res.json({ plans: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/morning-plan - 날짜별 모닝 플랜 조회
app.get('/api/morning-plan', (req, res) => {
  const { date } = req.query;
  const targetDate = date || getKSTDateString();
  const plans = loadMorningPlans();
  const plan = plans.find(p => p.date === targetDate);
  res.json({ plan: plan || null });
});

// POST /api/morning-plan - 모닝 플랜 저장
app.post('/api/morning-plan', (req, res) => {
  const { tasks, additionalTasks, goals, focusTime, motto, markdown } = req.body;
  const today = getKSTDateString();

  const plans = loadMorningPlans();

  // 오늘 기존 플랜이 있으면 업데이트
  const existingIdx = plans.findIndex(p => p.date === today);
  const plan = {
    id: existingIdx >= 0 ? plans[existingIdx].id : `mp-${Date.now()}`,
    date: today,
    tasks: tasks || [],
    additionalTasks: additionalTasks || [],
    goals: goals || [],
    focusTime: focusTime || '',
    motto: motto || '',
    markdown: markdown || '',
    createdAt: existingIdx >= 0 ? plans[existingIdx].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    plans[existingIdx] = plan;
  } else {
    plans.unshift(plan);
  }

  // 최대 365개까지 저장
  if (plans.length > 365) plans.splice(365);

  saveMorningPlans(plans);
  console.log(`[MorningPlan] 저장: ${today} (${(tasks || []).length}개 업무, ${(goals || []).length}개 목표)`);

  res.json({ success: true, plan });
});

// PUT /api/morning-plan/:id - 모닝 플랜 수정 (마크다운 편집)
app.put('/api/morning-plan/:id', (req, res) => {
  const { id } = req.params;
  const plans = loadMorningPlans();
  const idx = plans.findIndex(p => p.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Morning plan not found' });
  }

  const updates = req.body;
  if (updates.tasks !== undefined) plans[idx].tasks = updates.tasks;
  if (updates.additionalTasks !== undefined) plans[idx].additionalTasks = updates.additionalTasks;
  if (updates.goals !== undefined) plans[idx].goals = updates.goals;
  if (updates.focusTime !== undefined) plans[idx].focusTime = updates.focusTime;
  if (updates.motto !== undefined) plans[idx].motto = updates.motto;
  if (updates.markdown !== undefined) plans[idx].markdown = updates.markdown;
  plans[idx].updatedAt = new Date().toISOString();

  saveMorningPlans(plans);
  res.json({ success: true, plan: plans[idx] });
});

// ============ 백로그 API ============
const BACKLOGS_FILE = path.join(__dirname, 'data', 'backlogs.json');

function loadBacklogs() {
  try {
    if (fs.existsSync(BACKLOGS_FILE)) {
      return JSON.parse(fs.readFileSync(BACKLOGS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveBacklogs(backlogs) {
  const dir = path.dirname(BACKLOGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BACKLOGS_FILE, JSON.stringify(backlogs, null, 2));
}

// GET /api/backlogs - 백로그 목록
app.get('/api/backlogs', (req, res) => {
  const { status, date } = req.query;
  let backlogs = loadBacklogs();

  if (status === 'open') backlogs = backlogs.filter(b => !b.done);
  if (status === 'done') backlogs = backlogs.filter(b => b.done);
  if (date) backlogs = backlogs.filter(b => b.createdAt?.startsWith(date));

  res.json({ backlogs, total: backlogs.length, openCount: backlogs.filter(b => !b.done).length });
});

// POST /api/backlogs - 백로그 추가
app.post('/api/backlogs', (req, res) => {
  const { content, priority } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  const backlogs = loadBacklogs();
  const item = {
    id: `bl-${Date.now()}`,
    content: content.trim(),
    priority: priority || 'normal',
    done: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  backlogs.unshift(item);
  if (backlogs.length > 1000) backlogs.splice(1000);

  saveBacklogs(backlogs);
  console.log(`[Backlog] 추가: ${content.substring(0, 40)}`);

  // Obsidian Daily Note에도 기록
  appendToObsidianSection('## 📋 할 일', `- [ ] ${content.trim()}`);

  res.json({ success: true, backlog: item });
});

// PUT /api/backlogs/:id - 백로그 수정 (체크/내용)
app.put('/api/backlogs/:id', (req, res) => {
  const { id } = req.params;
  const backlogs = loadBacklogs();
  const idx = backlogs.findIndex(b => b.id === id);

  if (idx === -1) return res.status(404).json({ error: 'Backlog not found' });

  if (req.body.done !== undefined) backlogs[idx].done = req.body.done;
  if (req.body.content !== undefined) backlogs[idx].content = req.body.content;
  if (req.body.priority !== undefined) backlogs[idx].priority = req.body.priority;
  backlogs[idx].updatedAt = new Date().toISOString();

  saveBacklogs(backlogs);
  res.json({ success: true, backlog: backlogs[idx] });
});

// DELETE /api/backlogs/:id - 백로그 삭제
app.delete('/api/backlogs/:id', (req, res) => {
  const { id } = req.params;
  const backlogs = loadBacklogs();
  const idx = backlogs.findIndex(b => b.id === id);

  if (idx === -1) return res.status(404).json({ error: 'Backlog not found' });

  backlogs.splice(idx, 1);
  saveBacklogs(backlogs);
  res.json({ success: true });
});

// Obsidian Daily Note 메모 파싱 헬퍼
function parseObsidianMemos(targetDate) {
  const yaml = require('js-yaml');
  const configPaths = [
    path.join(__dirname, '../config/settings.local.yaml'),
    path.join(__dirname, '../config/settings.yaml'),
    path.join(__dirname, 'config/settings.yaml')
  ];

  let vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian');
  let dailyFolder = 'DAILY';

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
        if (config?.vault?.path) {
          vaultPath = config.vault.path.replace(/^~/, os.homedir());
        }
        if (config?.vault?.daily_folder) {
          dailyFolder = config.vault.daily_folder;
        }
        break;
      } catch (e) { /* ignore */ }
    }
  }

  const dailyNotePath = path.join(vaultPath, dailyFolder, `${targetDate}.md`);
  if (!fs.existsSync(dailyNotePath)) return [];

  const content = fs.readFileSync(dailyNotePath, 'utf8');
  const memos = [];

  const hourlyMatch = content.match(/## ⏰ 시간별 메모\n([\s\S]*?)(?=\n## |$)/);
  if (hourlyMatch) {
    const lines = hourlyMatch[1].trim().split('\n');
    let currentMemo = null;

    for (const line of lines) {
      const match = line.match(/^- `((?:오[전후]|[AP]M)?\s*\d{1,2}:\d{2})`\s*(.*)$/);
      if (match) {
        if (currentMemo) memos.push(currentMemo);

        const timeStr = match[1].trim();
        const timeDigits = timeStr.match(/(\d{1,2}):(\d{2})/);
        let hour = parseInt(timeDigits[1]);
        const min = timeDigits[2];
        if (/오후|PM/i.test(timeStr) && hour < 12) hour += 12;
        if (/오전|AM/i.test(timeStr) && hour === 12) hour = 0;
        const normalizedTime = `${String(hour).padStart(2, '0')}:${min}`;

        currentMemo = {
          id: `obsidian-${targetDate}-${normalizedTime}-${memos.length}`,
          time: timeStr,
          content: (match[2] || '').trim(),
          timestamp: `${targetDate}T${normalizedTime}:00`,
          source: 'obsidian'
        };
      } else if (currentMemo && line.trim()) {
        currentMemo.content += (currentMemo.content ? '\n' : '') + line.trim();
      }
    }
    if (currentMemo) memos.push(currentMemo);
  }

  return memos;
}

// GET /api/obsidian/daily-memos - Obsidian Daily Note 메모 조회
app.get('/api/obsidian/daily-memos', (req, res) => {
  const { date } = req.query;
  const targetDate = date || getKSTDateString();

  try {
    const memos = parseObsidianMemos(targetDate);
    res.json({ memos, source: 'obsidian', date: targetDate });
  } catch (err) {
    console.error('[Obsidian] 메모 읽기 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// 세션을 마크다운으로 변환
function sessionToMarkdown(sessionData, options = {}) {
  const { summary, insights } = options;
  const lines = [];
  const date = sessionData.lastActivity ?
    new Date(sessionData.lastActivity).toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '날짜 없음';

  const complexityEmoji = { low: '🟢', medium: '🟡', high: '🔴' };

  lines.push(`# Claude Code 세션: ${sessionData.project}`);
  lines.push('');
  lines.push(`- **세션 ID**: \`${sessionData.id}\``);
  lines.push(`- **날짜**: ${date}`);
  lines.push(`- **메시지 수**: ${sessionData.messageCount}`);
  lines.push(`- **사용된 도구**: ${sessionData.toolsUsed.join(', ') || '없음'}`);
  if (insights?.complexity) {
    lines.push(`- **복잡도**: ${complexityEmoji[insights.complexity] || ''} ${insights.complexity}`);
  }
  lines.push('');

  // 인사이트 섹션
  if (insights) {
    lines.push('## 📊 인사이트');
    lines.push('');
    if (insights.summary) {
      lines.push(`> ${insights.summary}`);
      lines.push('');
    }
    if (insights.topics?.length) {
      lines.push(`**주제**: ${insights.topics.map(t => `\`${t}\``).join(' ')}`);
      lines.push('');
    }
    if (insights.technologies?.length) {
      lines.push(`**기술**: ${insights.technologies.map(t => `\`${t}\``).join(' ')}`);
      lines.push('');
    }
    if (insights.problems_solved?.length) {
      lines.push('**해결한 문제**:');
      for (const p of insights.problems_solved) {
        lines.push(`- ✅ ${p}`);
      }
      lines.push('');
    }
    if (insights.key_decisions?.length) {
      lines.push('**주요 결정**:');
      for (const d of insights.key_decisions) {
        lines.push(`- 🎯 ${d}`);
      }
      lines.push('');
    }
  }

  // 요약 섹션
  if (summary) {
    lines.push('## 📋 요약');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  if (sessionData.filesChanged.length > 0) {
    lines.push('## 변경된 파일');
    lines.push('');
    for (const f of sessionData.filesChanged) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('## 대화 내용');
  lines.push('');

  // 연속 도구 전용 메시지 그룹화
  const grouped = [];
  let toolGroup = null;
  for (const msg of sessionData.conversation || []) {
    const hasContent = msg.content && msg.content.trim();
    const isToolOnly = msg.role === 'assistant' && !hasContent && msg.tools?.length > 0;

    if (isToolOnly) {
      if (!toolGroup) toolGroup = { isToolGroup: true, count: 0, tools: [], timestamp: msg.timestamp };
      toolGroup.count++;
      for (const t of (msg.tools || [])) toolGroup.tools.push(t);
    } else {
      if (toolGroup) {
        if (toolGroup.count >= 2 || toolGroup.tools.length >= 2) {
          grouped.push(toolGroup);
        } else {
          // 단일 도구 메시지는 일반 메시지로 표시
          grouped.push({ role: 'assistant', content: '', tools: toolGroup.tools, timestamp: toolGroup.timestamp });
        }
        toolGroup = null;
      }
      grouped.push(msg);
    }
  }
  if (toolGroup) {
    if (toolGroup.count >= 2 || toolGroup.tools.length >= 2) {
      grouped.push(toolGroup);
    } else {
      grouped.push({ role: 'assistant', content: '', tools: toolGroup.tools, timestamp: toolGroup.timestamp });
    }
  }

  for (const msg of grouped) {
    if (msg.isToolGroup) {
      const toolCounts = {};
      for (const t of msg.tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
      const summary = Object.entries(toolCounts).map(([t, c]) => c > 1 ? `${t} ×${c}` : t).join(', ');
      lines.push(`> 🔧 _${msg.tools.length}개 도구 호출: ${summary}_`);
      lines.push('');
    } else if (msg.role === 'user') {
      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`### 👤 사용자 ${time ? `(${time})` : ''}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    } else {
      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`### 🤖 Claude ${time ? `(${time})` : ''}`);
      lines.push('');
      if (msg.tools?.length > 0) {
        lines.push(`> 🔧 사용된 도구: ${msg.tools.join(', ')}`);
        lines.push('');
      }
      if (msg.content) {
        lines.push(msg.content);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*AI Pipeline Dashboard에서 내보냄*`);

  return lines.join('\n');
}

// POST /api/ask - Claude에게 질문
app.post('/api/ask', async (req, res) => {
  const { prompt, timeout = 300000 } = req.body; // 기본 5분 타임아웃

  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  console.log(`[Claude] 질문 수신: ${prompt.substring(0, 50)}...`);

  // Claude CLI 경로 (환경변수 또는 기본 경로)
  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  try {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
    }, timeout);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code === 0) {
        console.log(`[Claude] 응답 완료 (${stdout.length} chars)`);
        res.json({ success: true, response: stdout.trim() });
      } else {
        console.error(`[Claude] 오류 (code: ${code}):`, stderr);
        res.status(500).json({
          error: stderr || `Claude CLI exited with code ${code}`
        });
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      console.error('[Claude] 실행 오류:', err.message);
      res.status(500).json({ error: err.message });
    });

  } catch (err) {
    console.error('[Claude] 예외:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- GitHub 활동 헬퍼 ----
function ghExec(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `gh exit ${code}`)));
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeout);
  });
}

async function getGhAccounts() {
  try {
    const output = await ghExec(['auth', 'status'], 5000);
    // stderr 에도 나오므로 catch
  } catch (e) { /* gh auth status exits non-zero sometimes */ }
  // parse from gh auth status (outputs to stderr)
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'status']);
    let out = '';
    child.stderr.on('data', d => out += d);
    child.stdout.on('data', d => out += d);
    child.on('close', () => {
      const accounts = [];
      const lines = out.split('\n');
      let currentAccount = null;
      for (const line of lines) {
        const loginMatch = line.match(/Logged in to (\S+) account (\S+)/);
        if (loginMatch) {
          currentAccount = { host: loginMatch[1], username: loginMatch[2], active: false };
          accounts.push(currentAccount);
        }
        if (currentAccount && /Active account:\s*true/i.test(line)) {
          currentAccount.active = true;
        }
      }
      resolve(accounts);
    });
  });
}

// 계정별 gh auth switch 후 API 호출
async function ghExecAs(username, args, timeout = 15000) {
  // 해당 계정으로 전환 후 실행
  try {
    await ghExec(['auth', 'switch', '--user', username], 5000);
  } catch (e) {
    // 이미 해당 계정이거나 전환 실패 시 그냥 진행
  }
  return ghExec(args, timeout);
}

async function fetchGithubEventsForAccount(username, targetDate) {
  const result = { username, commits: [], prs: [], reviews: [], comments: [] };

  try {
    const raw = await ghExecAs(username, [
      'api', `/users/${username}/events?per_page=100`,
      '--jq', `[.[] | select(.created_at | startswith("${targetDate}"))]`
    ]);

    if (!raw.trim()) return result;
    const events = JSON.parse(raw);

    for (const e of events) {
      const repo = e.repo?.name || '';
      const repoShort = repo.split('/').pop() || repo;
      const time = e.created_at;

      switch (e.type) {
        case 'PushEvent': {
          const commits = e.payload?.commits || [];
          if (commits.length > 0) {
            result.commits.push({
              repo, repoShort, account: username, time,
              count: commits.length,
              messages: commits.map(c => c.message).filter(Boolean),
              branch: (e.payload?.ref || '').replace('refs/heads/', '')
            });
          }
          break;
        }
        case 'PullRequestEvent': {
          const pr = e.payload?.pull_request || {};
          result.prs.push({
            repo, repoShort, account: username, time,
            action: e.payload?.action,
            number: pr.number || e.payload?.number,
            title: pr.title || `PR #${pr.number || e.payload?.number}`,
            state: pr.state,
            url: pr.html_url
          });
          break;
        }
        case 'PullRequestReviewEvent': {
          const review = e.payload?.review || {};
          const pr = e.payload?.pull_request || {};
          result.reviews.push({
            repo, repoShort, account: username, time,
            state: review.state, // approved, commented, changes_requested
            prNumber: pr.number,
            prTitle: pr.title || `PR #${pr.number}`,
            body: (review.body || '').substring(0, 200)
          });
          break;
        }
        case 'PullRequestReviewCommentEvent': {
          const comment = e.payload?.comment || {};
          const pr = e.payload?.pull_request || {};
          result.comments.push({
            repo, repoShort, account: username, time,
            type: 'review_comment',
            prNumber: pr.number,
            prTitle: pr.title || `PR #${pr.number}`,
            body: (comment.body || '').substring(0, 200),
            path: comment.path
          });
          break;
        }
        case 'IssueCommentEvent': {
          const comment = e.payload?.comment || {};
          const issue = e.payload?.issue || {};
          result.comments.push({
            repo, repoShort, account: username, time,
            type: 'issue_comment',
            issueNumber: issue.number,
            issueTitle: issue.title || `#${issue.number}`,
            body: (comment.body || '').substring(0, 200),
            isPR: !!issue.pull_request
          });
          break;
        }
        case 'IssuesEvent': {
          // issue opened, closed 등은 별도로 처리 가능하면 추가
          break;
        }
      }
    }
  } catch (e) {
    console.log(`[GitHub] ${username} 이벤트 조회 실패:`, e.message);
  }

  // PR 제목이 null인 경우 API로 조회
  const prTitleCache = {};
  const prUrlCache = {};
  const needsTitleLookup = new Set();

  // 제목이 필요한 PR 번호들 수집
  const allPrRefs = [
    ...result.prs.map(p => ({ repo: p.repo, number: p.number })),
    ...result.reviews.map(r => ({ repo: r.repo, number: r.prNumber })),
    ...result.comments.filter(c => c.prNumber).map(c => ({ repo: c.repo, number: c.prNumber }))
  ];
  for (const ref of allPrRefs) {
    const key = `${ref.repo}#${ref.number}`;
    if (!prTitleCache[key]) needsTitleLookup.add(key);
  }

  // 병렬로 PR 제목 조회 (최대 10개)
  const lookups = [...needsTitleLookup].slice(0, 10);
  await Promise.all(lookups.map(async (key) => {
    const [repo, num] = key.split('#');
    try {
      const raw = await ghExec(['api', `/repos/${repo}/pulls/${num}`, '--jq', '{title: .title, html_url: .html_url}'], 8000);
      const data = JSON.parse(raw.trim());
      prTitleCache[key] = data.title;
      prUrlCache[key] = data.html_url;
    } catch (e) {
      prTitleCache[key] = null;
    }
  }));

  // 제목과 URL 적용
  for (const pr of result.prs) {
    const key = `${pr.repo}#${pr.number}`;
    if (prTitleCache[key]) pr.title = prTitleCache[key];
    if (prUrlCache[key]) pr.url = prUrlCache[key];
    if (!pr.url) pr.url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  }
  for (const r of result.reviews) {
    const key = `${r.repo}#${r.prNumber}`;
    if (prTitleCache[key]) r.prTitle = prTitleCache[key];
    r.url = prUrlCache[key] || `https://github.com/${r.repo}/pull/${r.prNumber}`;
  }
  for (const c of result.comments) {
    if (c.prNumber) {
      const key = `${c.repo}#${c.prNumber}`;
      if (prTitleCache[key]) c.prTitle = prTitleCache[key];
      c.url = prUrlCache[key] || `https://github.com/${c.repo}/pull/${c.prNumber}`;
    }
  }

  return result;
}

// GET /api/github/activity - 오늘의 GitHub 활동 조회 (다중 계정)
app.get('/api/github/activity', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getKSTDateString();

  try {
    const accounts = await getGhAccounts();
    console.log(`[GitHub] ${accounts.length}개 계정 감지:`, accounts.map(a => a.username).join(', '));

    // 계정별 순차 수집 (gh auth switch는 전역 상태이므로 병렬 불가)
    const activeAccount = accounts.find(a => a.active)?.username;
    const results = [];
    for (const a of accounts) {
      results.push(await fetchGithubEventsForAccount(a.username, targetDate));
    }
    // 원래 active 계정 복원
    if (activeAccount) {
      try { await ghExec(['auth', 'switch', '--user', activeAccount], 5000); } catch {}
    }

    // 통합
    const activity = {
      date: targetDate,
      accounts: accounts.map(a => a.username),
      commits: [],
      prs: [],
      reviews: [],
      comments: []
    };

    for (const r of results) {
      activity.commits.push(...r.commits);
      activity.prs.push(...r.prs);
      activity.reviews.push(...r.reviews);
      activity.comments.push(...r.comments);
    }

    // PR 중복 제거 (같은 PR에 여러 이벤트 가능)
    const prSeen = new Set();
    activity.prs = activity.prs.filter(pr => {
      const key = `${pr.repo}#${pr.number}`;
      if (prSeen.has(key)) return false;
      prSeen.add(key);
      return true;
    });

    // 리뷰 중복 제거 (같은 PR 같은 계정)
    const reviewSeen = new Set();
    activity.reviews = activity.reviews.filter(r => {
      const key = `${r.account}:${r.repo}#${r.prNumber}`;
      if (reviewSeen.has(key)) return false;
      reviewSeen.add(key);
      return true;
    });

    // repo별 그룹 정보 추가
    const repos = new Set();
    [...activity.commits, ...activity.prs, ...activity.reviews, ...activity.comments]
      .forEach(item => repos.add(item.repo));
    activity.repos = [...repos].sort();

    res.json(activity);
  } catch (err) {
    console.error('[GitHub] 활동 조회 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeline - 통합 타임라인
app.get('/api/timeline', async (req, res) => {
  const date = req.query.date || getKSTDateString();
  const items = [];

  // 1. 작업 이력
  const history = [...jobHistory];
  history.filter(h => h.startTime?.startsWith(date)).forEach(h => {
    items.push({
      id: `job-${h.id}`,
      type: 'job',
      time: h.startTime,
      title: h.jobName || h.jobId,
      subtitle: `${h.status === 'success' ? '성공' : h.status === 'failed' ? '실패' : '실행중'} (${((h.duration || 0) / 1000).toFixed(1)}s)`,
      icon: h.status === 'success' ? 'job-success' : 'job-failed',
      color: h.status === 'success' ? 'green' : 'red',
      meta: { jobId: h.jobId, status: h.status, logId: h.id }
    });
  });

  // 2. Claude 세션
  try {
    const sessions = findSessions(date);
    const summaries = loadSessionSummaries();
    const summaryIds = new Set(summaries.map(s => s.sessionId));
    sessions.forEach(s => {
      items.push({
        id: `session-${s.id}`,
        type: 'session',
        time: s.modifiedAt,
        title: s.alias || s.project,
        subtitle: s.alias ? `${s.project} / ${s.firstMessage?.substring(0, 50) || ''}` : (s.firstMessage?.substring(0, 60) || ''),
        icon: 'session',
        color: 'purple',
        meta: { sessionId: s.id, projectPath: s.projectPath, hasSummary: summaryIds.has(s.id) }
      });
    });
  } catch (e) { /* ignore */ }

  // 3. 대시보드 메모
  try {
    const dashMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(date));
    dashMemos.forEach(m => {
      items.push({
        id: `memo-${m.id}`,
        type: 'memo',
        time: m.timestamp,
        title: m.content?.substring(0, 100),
        icon: 'memo',
        color: 'yellow',
        meta: { source: 'dashboard', memoId: m.id }
      });
    });
  } catch (e) { /* ignore */ }

  // 4. Obsidian 메모
  try {
    const obsidianMemos = parseObsidianMemos(date);
    obsidianMemos.forEach(m => {
      items.push({
        id: m.id,
        type: 'memo',
        time: m.timestamp,
        title: m.content?.substring(0, 100),
        icon: 'memo-obsidian',
        color: 'green',
        meta: { source: 'obsidian' }
      });
    });
  } catch (e) { /* ignore */ }

  // 5. 모닝 플랜
  try {
    const plans = loadMorningPlans();
    const todayPlan = plans.find(p => p.date === date);
    if (todayPlan) {
      items.push({
        id: `plan-${todayPlan.id}`,
        type: 'plan',
        time: todayPlan.createdAt,
        title: '하루 시작 계획',
        subtitle: `목표 ${todayPlan.goals?.length || 0}개 / 업무 ${todayPlan.tasks?.length || 0}개`,
        icon: 'plan',
        color: 'orange',
        meta: { planId: todayPlan.id }
      });
    }
  } catch (e) { /* ignore */ }

  // 6. GitHub 활동 (외부 API이므로 실패해도 나머지 반환)
  try {
    const accounts = await getGhAccounts();
    const activeAccount = accounts.find(a => a.active)?.username;
    const results = [];
    for (const a of accounts) {
      try {
        results.push({ status: 'fulfilled', value: await fetchGithubEventsForAccount(a.username, date) });
      } catch (err) {
        results.push({ status: 'rejected', reason: err });
      }
    }
    if (activeAccount) {
      try { await ghExec(['auth', 'switch', '--user', activeAccount], 5000); } catch {}
    }
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = r.value;
      // PR
      data.prs?.forEach(pr => {
        items.push({
          id: `gh-pr-${pr.repo}-${pr.number}`,
          type: 'github',
          time: pr.time,
          title: `PR #${pr.number} ${pr.title || ''}`.trim(),
          subtitle: `${pr.account} / ${pr.repoShort} / ${pr.action}`,
          icon: 'github-pr',
          color: 'blue',
          meta: { url: pr.url, repo: pr.repo }
        });
      });
      // Commits
      data.commits?.forEach(c => {
        items.push({
          id: `gh-commit-${c.repo}-${c.time}`,
          type: 'github',
          time: c.time,
          title: `${c.count}개 커밋 - ${c.repoShort}`,
          subtitle: c.messages?.[0] || c.branch || '',
          icon: 'github-commit',
          color: 'blue',
          meta: { repo: c.repo }
        });
      });
      // Reviews
      data.reviews?.forEach(rv => {
        items.push({
          id: `gh-review-${rv.repo}-${rv.prNumber}-${rv.time}`,
          type: 'github',
          time: rv.time,
          title: `리뷰: ${rv.prTitle || `PR #${rv.prNumber}`}`,
          subtitle: `${rv.account} / ${rv.repoShort} / ${rv.state}`,
          icon: 'github-review',
          color: 'blue',
          meta: { repo: rv.repo }
        });
      });
    }
  } catch (e) { /* GitHub 실패 시 무시 */ }

  // 시간순 정렬
  items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  // 요약
  const summary = {
    sessions: items.filter(i => i.type === 'session').length,
    memos: items.filter(i => i.type === 'memo').length,
    jobRuns: items.filter(i => i.type === 'job').length,
    github: items.filter(i => i.type === 'github').length,
    plans: items.filter(i => i.type === 'plan').length
  };

  res.json({ date, items, summary });
});

// GET /api/search - 통합 검색
app.get('/api/search', (req, res) => {
  const { q, types } = req.query;
  if (!q || q.length < 2) return res.json({ results: [], total: 0 });

  const query = q.toLowerCase();
  const allowedTypes = types ? types.split(',') : ['session', 'memo', 'job', 'backlog'];
  const results = [];

  // 대시보드 메모 검색
  if (allowedTypes.includes('memo')) {
    try {
      const memos = loadQuickMemos();
      memos.filter(m => m.content?.toLowerCase().includes(query)).forEach(m => {
        results.push({
          type: 'memo', id: m.id,
          title: m.content.substring(0, 60),
          preview: m.content.substring(0, 120),
          date: m.timestamp?.split('T')[0],
          time: m.timestamp,
          icon: '📝'
        });
      });
    } catch (e) { /* ignore */ }

    // Obsidian 메모 검색 (최근 7일)
    try {
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = getKSTDateString(d);
        const memos = parseObsidianMemos(dateStr);
        memos.filter(m => m.content?.toLowerCase().includes(query)).forEach(m => {
          results.push({
            type: 'memo', id: m.id,
            title: m.content.substring(0, 60),
            preview: m.content.substring(0, 120),
            date: dateStr,
            time: m.timestamp,
            icon: '📓'
          });
        });
      }
    } catch (e) { /* ignore */ }
  }

  // 세션 검색 (alias, project, firstMessage — 최근 7일)
  if (allowedTypes.includes('session')) {
    try {
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = getKSTDateString(d);
        const sessions = findSessions(dateStr);
        sessions.filter(s =>
          s.alias?.toLowerCase().includes(query) ||
          s.project?.toLowerCase().includes(query) ||
          s.firstMessage?.toLowerCase().includes(query)
        ).forEach(s => {
          results.push({
            type: 'session', id: s.id,
            title: s.alias || s.project,
            preview: s.firstMessage?.substring(0, 120) || '',
            date: dateStr,
            time: s.modifiedAt,
            icon: '🤖',
            meta: { sessionId: s.id, projectPath: s.projectPath }
          });
        });
      }
    } catch (e) { /* ignore */ }
  }

  // 작업 이력 검색
  if (allowedTypes.includes('job')) {
    const history = [...jobHistory];
    history.filter(h =>
      h.jobName?.toLowerCase().includes(query) ||
      h.jobId?.toLowerCase().includes(query)
    ).forEach(h => {
      results.push({
        type: 'job', id: String(h.id),
        title: h.jobName || h.jobId,
        preview: `${h.status === 'success' ? '성공' : '실패'} - ${(h.duration / 1000).toFixed(1)}s`,
        date: h.startTime?.split('T')[0],
        time: h.startTime,
        icon: h.status === 'success' ? '✅' : '❌',
        meta: { logId: h.id }
      });
    });
  }

  // 백로그 검색
  if (allowedTypes.includes('backlog')) {
    try {
      const backlogs = loadBacklogs();
      backlogs.filter(b => b.content?.toLowerCase().includes(query)).forEach(b => {
        results.push({
          type: 'backlog', id: b.id,
          title: b.content.substring(0, 60),
          preview: b.content.substring(0, 120),
          date: b.createdAt?.split('T')[0],
          time: b.createdAt,
          icon: b.done ? '✔️' : '📋'
        });
      });
    } catch (e) { /* ignore */ }
  }

  // 최신순 정렬
  results.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  res.json({ results: results.slice(0, 30), total: results.length });
});

// GET /api/sessions - 세션 목록 조회
app.get('/api/sessions', (req, res) => {
  const { date, project } = req.query;
  const targetDate = date || getKSTDateString();

  try {
    const sessions = findSessions(targetDate, project);

    // 요약 생성 여부 표시
    const summaries = loadSessionSummaries();
    const summaryIds = new Set(summaries.map(s => s.sessionId));
    for (const s of sessions) {
      s.hasSummary = summaryIds.has(s.id);
    }

    // 인사이트 생성 여부 표시
    const insights = loadSessionInsights();
    for (const s of sessions) {
      s.hasInsights = !!insights[s.id];
    }

    res.json({ sessions, date: targetDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/projects - 프로젝트 목록 조회
app.get('/api/sessions/projects', (req, res) => {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS)) {
      return res.json({ projects: [] });
    }

    const projects = new Set();
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectPath = path.join(CLAUDE_PROJECTS, dir);
      if (fs.statSync(projectPath).isDirectory() && dir !== 'memory') {
        projects.add(dir.split('-').pop());
      }
    }

    res.json({ projects: Array.from(projects).sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id - 세션 상세 조회
app.get('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'project query parameter required' });
  }

  try {
    const data = parseSessionFile(id, project);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id - 세션 삭제
app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'project query parameter required' });
  }

  const filePath = path.join(CLAUDE_PROJECTS, project, `${id}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Session file not found' });
  }

  try {
    // 백업 폴더 생성 (삭제된 세션 보관)
    const backupDir = path.join(CLAUDE_PROJECTS, '.deleted');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // 백업 후 삭제 (완전 삭제 대신 백업)
    const backupPath = path.join(backupDir, `${id}_${Date.now()}.jsonl`);
    fs.renameSync(filePath, backupPath);

    console.log(`[Sessions] 세션 삭제: ${id} (백업: ${backupPath})`);
    res.json({ success: true, message: '세션이 삭제되었습니다 (백업됨)' });
  } catch (err) {
    console.error(`[Sessions] 세션 삭제 실패:`, err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/summary - 캐시된 세션 요약 조회
app.get('/api/sessions/:id/summary', (req, res) => {
  const sessionId = req.params.id;
  try {
    const summaries = loadSessionSummaries();
    const summary = summaries.find(s => s.sessionId === sessionId);
    res.json({ summary: summary || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/daily - 캐시된 일일 보고서 조회
app.get('/api/reports/daily', (req, res) => {
  const { date, type } = req.query;
  try {
    const reports = loadDailyReports();

    if (date && type) {
      const report = reports.find(r => r.date === date && r.type === type);
      return res.json({ report: report || null });
    }

    if (date) {
      const dateReports = reports.filter(r => r.date === date);
      return res.json({ reports: dateReports });
    }

    // 최근 N개 (기본 30)
    const limit = parseInt(req.query.limit) || 30;
    const list = reports.slice(-limit).reverse().map(r => ({
      id: r.id, date: r.date, type: r.type, createdAt: r.createdAt
    }));
    res.json({ reports: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sessions/:id/alias - 세션 별명 설정
app.put('/api/sessions/:id/alias', (req, res) => {
  const { id } = req.params;
  const { alias } = req.body;

  try {
    const aliases = loadSessionAliases();

    if (alias && alias.trim()) {
      aliases[id] = alias.trim();
    } else {
      delete aliases[id];
    }

    saveSessionAliases(aliases);
    console.log(`[Sessions] 세션 별명 설정: ${id} → "${alias || '(삭제)'}"`);
    res.json({ success: true, alias: aliases[id] || null });
  } catch (err) {
    console.error(`[Sessions] 별명 설정 실패:`, err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/aliases - 모든 세션 별명 조회
app.get('/api/sessions/aliases', (req, res) => {
  try {
    const aliases = loadSessionAliases();
    res.json({ aliases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/markdown - 세션을 마크다운으로 내보내기
app.get('/api/sessions/:id/markdown', (req, res) => {
  const { id } = req.params;
  const { project, download } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'project query parameter required' });
  }

  try {
    const data = parseSessionFile(id, project, { maxMessages: 500 });

    // 캐시된 요약/인사이트 로드
    const summaries = loadSessionSummaries();
    const summaryObj = summaries.find(s => s.sessionId === id);
    const allInsights = loadSessionInsights();

    const markdown = sessionToMarkdown(data, {
      summary: summaryObj?.summary || null,
      insights: allInsights[id] || null
    });

    if (download === 'true') {
      const filename = `claude-session-${data.project}-${getKSTDateString()}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(markdown);
    } else {
      res.json({ markdown, filename: `claude-session-${data.project}.md` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/export-obsidian - 옵시디언으로 내보내기
app.post('/api/sessions/:id/export-obsidian', (req, res) => {
  const { id } = req.params;
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'project query parameter required' });
  }

  const { vaultPath: obsidianVault } = getObsidianPaths();

  try {
    const data = parseSessionFile(id, project, { maxMessages: 500 });

    // 캐시된 요약 로드
    const summaries = loadSessionSummaries();
    const summaryObj = summaries.find(s => s.sessionId === id);
    const summaryText = summaryObj?.summary || null;

    // 캐시된 인사이트 로드
    const allInsights = loadSessionInsights();
    const insights = allInsights[id] || null;

    const markdown = sessionToMarkdown(data, { summary: summaryText, insights });

    // 저장 경로: vault/Claude Sessions/YYYY-MM/
    const date = new Date();
    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const sessionDir = path.join(obsidianVault, 'Claude Sessions', yearMonth);

    // 디렉토리 생성
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const filename = `${data.project}-${getKSTDateString(date)}-${id.substring(0, 8)}.md`;
    const filePath = path.join(sessionDir, filename);

    fs.writeFileSync(filePath, markdown, 'utf8');
    console.log(`[Sessions] 옵시디언으로 내보냄: ${filePath} (요약: ${!!summaryText}, 인사이트: ${!!insights})`);

    res.json({
      success: true,
      path: filePath,
      relativePath: `Claude Sessions/${yearMonth}/${filename}`,
      hasSummary: !!summaryText,
      hasInsights: !!insights
    });
  } catch (err) {
    console.error('[Sessions] 옵시디언 내보내기 실패:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 일일 보고서 캐시 (메모리)
const dailyReportCache = new Map();

// POST /api/sessions/daily-report - Claude로 일일 보고서 생성
app.post('/api/sessions/daily-report', async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getKSTDateString();

  // 캐시 확인
  if (dailyReportCache.has(targetDate)) {
    console.log(`[DailyReport] 캐시 히트: ${targetDate}`);
    return res.json(dailyReportCache.get(targetDate));
  }

  try {
    const sessions = findSessions(targetDate);

    if (sessions.length === 0) {
      return res.json({
        success: true,
        date: targetDate,
        sessionsCount: 0,
        report: `# ${targetDate} 일일 보고서\n\n해당 날짜에 Claude Code 세션이 없습니다.`
      });
    }

    // 모든 세션의 요약 정보 수집
    const sessionSummaries = [];
    for (const sess of sessions.slice(0, 10)) { // 최대 10개 세션
      try {
        const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 50 });
        sessionSummaries.push({
          project: data.project,
          messageCount: data.messageCount,
          tools: data.toolsUsed.slice(0, 10),
          files: data.filesChanged.slice(0, 10),
          firstMessage: data.firstMessage,
          conversations: data.conversation.slice(0, 20).map(c => ({
            role: c.role,
            content: c.content?.substring(0, 500)
          }))
        });
      } catch (e) {
        console.error(`[DailyReport] 세션 파싱 실패: ${sess.id}`, e.message);
      }
    }

    // Claude CLI로 보고서 생성
    const claudePath = process.env.CLAUDE_CLI_PATH ||
      path.join(os.homedir(), '.local', 'bin', 'claude');

    const prompt = `다음은 ${targetDate} 하루 동안의 Claude Code 세션 요약입니다.
이 정보를 바탕으로 하루 동안 무엇을 작업했는지 깔끔한 마크다운 형식의 일일 보고서를 작성해주세요.

보고서에 포함할 내용:
1. 📋 오늘의 요약 (한 문단)
2. 🎯 주요 작업 (프로젝트별로 정리)
3. 🔧 사용한 도구 통계
4. 📁 변경된 파일 목록
5. 💡 주요 인사이트 또는 배운 점
6. 📝 내일 할 일 제안 (있다면)

세션 데이터:
${JSON.stringify(sessionSummaries, null, 2)}

마크다운 형식으로 깔끔하게 작성해주세요. 이모지를 적절히 사용하고, 항목별로 구분해주세요.`;

    const report = await new Promise((resolve, reject) => {
      const claude = spawn(claudePath, ['-p', prompt], {
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => { stdout += data.toString(); });
      claude.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeoutId = setTimeout(() => {
        claude.kill('SIGTERM');
        reject(new Error('Claude 응답 타임아웃'));
      }, 120000);

      claude.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Claude CLI exited with code ${code}`));
        }
      });

      claude.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });

    const result = {
      success: true,
      date: targetDate,
      sessionsCount: sessions.length,
      report: report
    };

    // 캐시 저장 (1시간)
    dailyReportCache.set(targetDate, result);
    setTimeout(() => dailyReportCache.delete(targetDate), 3600000);

    console.log(`[DailyReport] 생성 완료: ${targetDate} (${sessions.length}개 세션)`);
    res.json(result);

  } catch (err) {
    console.error('[DailyReport] 생성 실패:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/daily-report/download - 보고서 다운로드
app.get('/api/sessions/daily-report/download', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getKSTDateString();

  try {
    let report;
    if (dailyReportCache.has(targetDate)) {
      report = dailyReportCache.get(targetDate).report;
    } else {
      // 캐시가 없으면 간단한 요약만 생성
      const sessions = findSessions(targetDate);
      report = `# ${targetDate} 일일 보고서\n\n세션 수: ${sessions.length}\n\n(상세 보고서를 보려면 먼저 일일 보고서 버튼을 클릭하세요)`;
    }

    const filename = `claude-daily-report-${targetDate}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/daily-report/obsidian - 보고서 옵시디언 저장
app.post('/api/sessions/daily-report/obsidian', async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getKSTDateString();

  try {
    let report;
    if (dailyReportCache.has(targetDate)) {
      report = dailyReportCache.get(targetDate).report;
    } else {
      return res.status(400).json({ error: '먼저 일일 보고서를 생성해주세요' });
    }

    const { vaultPath: obsidianVault } = getObsidianPaths();

    const reportDir = path.join(obsidianVault, 'Claude Sessions', 'Daily Reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const filename = `${targetDate}-daily-report.md`;
    const filePath = path.join(reportDir, filename);

    fs.writeFileSync(filePath, report, 'utf8');
    console.log(`[DailyReport] 옵시디언 저장: ${filePath}`);

    res.json({
      success: true,
      path: filePath,
      relativePath: `Claude Sessions/Daily Reports/${filename}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/export-all - 전체 세션 옵시디언 내보내기
app.post('/api/sessions/export-all', async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getKSTDateString();

  try {
    const sessions = findSessions(targetDate);
    let exported = 0;

    const { vaultPath: obsidianVault } = getObsidianPaths();

    const yearMonth = targetDate.substring(0, 7);
    const sessionDir = path.join(obsidianVault, 'Claude Sessions', yearMonth);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const summaries = loadSessionSummaries();
    const allInsights = loadSessionInsights();

    for (const sess of sessions) {
      try {
        const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 500 });
        const summaryObj = summaries.find(s => s.sessionId === sess.id);
        const markdown = sessionToMarkdown(data, {
          summary: summaryObj?.summary || null,
          insights: allInsights[sess.id] || null
        });

        const filename = `${data.project}-${targetDate}-${sess.id.substring(0, 8)}.md`;
        const filePath = path.join(sessionDir, filename);

        fs.writeFileSync(filePath, markdown, 'utf8');
        exported++;
      } catch (e) {
        console.error(`[ExportAll] 세션 내보내기 실패: ${sess.id}`, e.message);
      }
    }

    console.log(`[ExportAll] ${targetDate}: ${exported}/${sessions.length}개 내보냄`);
    res.json({ success: true, exported, total: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/today/summary - 요약 (날짜 파라미터 지원)
app.get('/api/today/summary', (req, res) => {
  const targetDate = req.query.date || getKSTDateString();

  try {
    const sessions = findSessions(targetDate);
    const jobsForDate = jobHistory.filter(h =>
      h.startTime?.startsWith(targetDate)
    );

    res.json({
      date: targetDate,
      sessionsCount: sessions.length,
      jobsCount: jobsForDate.length,
      successCount: jobsForDate.filter(j => j.status === 'success').length,
      failedCount: jobsForDate.filter(j => j.status === 'failed').length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Global Error Handlers ============

// Unhandled Promise Rejection - 서버 크래시 방지
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] ⚠️ Unhandled Promise Rejection:`);
  console.error('  Reason:', reason);
  // 서버를 멈추지 않고 로그만 기록
});

// Uncaught Exception - 치명적 에러도 로그 후 복구 시도
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ Uncaught Exception:`);
  console.error('  Error:', err.message);
  console.error('  Stack:', err.stack);
  // 서버를 멈추지 않음 (주의: 상태 불일치 가능)
});

// ============ Phase 2: AI 인사이트 & 분석 ============

// --- 2.3 스마트 서제스션 ---
function generateSuggestions() {
  const now = new Date();
  const today = getKSTDateString(now);
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0=일, 1=월 ... 6=토
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const suggestions = [];

  try {
    // 1. 메모 누락 (11시 이후, 오늘 메모 0개)
    const todayMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(today));
    let obsidianMemoCount = 0;
    try { obsidianMemoCount = parseObsidianMemos(today).length; } catch (e) { /* ignore */ }
    if (todayMemos.length === 0 && obsidianMemoCount === 0 && hour >= 11) {
      suggestions.push({
        id: 'nudge-memo',
        type: 'nudge',
        icon: '📝',
        message: '오늘 아직 메모를 남기지 않으셨어요. 빠른 메모를 남겨보세요!',
        action: { type: 'openQuickInput' },
        priority: 'low'
      });
    }

    // 2. 오래된 백로그 (7일+)
    const backlogs = loadBacklogs().filter(b => !b.done);
    const oldBacklogs = backlogs.filter(b => {
      const created = new Date(b.createdAt);
      return (Date.now() - created.getTime()) > 7 * 24 * 60 * 60 * 1000;
    });
    if (oldBacklogs.length > 0) {
      suggestions.push({
        id: 'reminder-backlog',
        type: 'reminder',
        icon: '📋',
        message: `백로그에 ${oldBacklogs.length}개 항목이 1주일 넘게 대기중이에요`,
        action: { type: 'showTab', tab: 'notes' },
        priority: 'medium'
      });
    }

    // 3. 모닝 플랜 미작성 (평일 10:30~12시)
    if (isWeekday && ((hour === 10 && minute >= 30) || hour === 11)) {
      const todayPlan = loadMorningPlans().find(p => p.date === today);
      if (!todayPlan) {
        suggestions.push({
          id: 'nudge-morning',
          type: 'nudge',
          icon: '☀️',
          message: '오늘의 계획을 아직 세우지 않으셨어요. 하루 시작을 해보세요!',
          action: { type: 'openMorningStart' },
          priority: 'medium'
        });
      }
    }

    // 4. 목표 달성 축하 (22:30 이후, 모닝 플랜이 있고 목표 있을 때)
    if (hour >= 22 && minute >= 30) {
      const todayPlan = loadMorningPlans().find(p => p.date === today);
      if (todayPlan?.goals?.length > 0) {
        suggestions.push({
          id: 'achievement-day',
          type: 'achievement',
          icon: '🎯',
          message: `오늘 하루 수고하셨어요! 목표 ${todayPlan.goals.length}개를 세우고 달려온 하루였습니다`,
          action: null,
          priority: 'info'
        });
      }
    }

    // 5. 오늘 실패한 작업 알림
    const todayFailed = jobHistory.filter(h =>
      h.startTime?.startsWith(today) && h.status === 'failed'
    );
    if (todayFailed.length > 0) {
      const jobNames = [...new Set(todayFailed.map(h => h.jobName || h.jobId))].slice(0, 3).join(', ');
      suggestions.push({
        id: 'alert-failed',
        type: 'reminder',
        icon: '⚠️',
        message: `오늘 실패한 작업이 ${todayFailed.length}개 있어요: ${jobNames}`,
        action: { type: 'showTab', tab: 'jobs' },
        priority: 'high'
      });
    }
  } catch (e) {
    console.error('[Suggestions] 생성 오류:', e.message);
  }

  return suggestions;
}

app.get('/api/insights/suggestions', (req, res) => {
  const suggestions = generateSuggestions();
  res.json({ suggestions });
});

// --- 2.2 생산성 분석 ---
// 세션 벌크 조회 (디렉토리 1회 스캔, 날짜별 그룹핑, firstMessage 생략)
// 60초 캐시로 기간 전환 시 재스캔 방지
let _sessionBulkCache = null;
let _sessionBulkCacheTime = 0;

function findSessionsBulk(dateSet) {
  const sessionsByDate = {};
  for (const d of dateSet) sessionsByDate[d] = [];

  // 캐시 확인 (60초 TTL)
  const now = Date.now();
  let allSessions = _sessionBulkCache;
  if (!allSessions || now - _sessionBulkCacheTime > 60000) {
    allSessions = [];
    if (fs.existsSync(CLAUDE_PROJECTS)) {
      try {
        for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
          const projectPath = path.join(CLAUDE_PROJECTS, dir);
          let stat;
          try { stat = fs.statSync(projectPath); } catch { continue; }
          if (!stat.isDirectory() || dir === 'memory' || dir === '.deleted') continue;
          const projectName = dir.split('-').pop();

          let files;
          try { files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
          for (const file of files) {
            try {
              const fileStat = fs.statSync(path.join(projectPath, file));
              allSessions.push({
                project: projectName,
                modifiedAt: fileStat.mtime.toISOString(),
                date: getKSTDateString(fileStat.mtime)
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    }
    _sessionBulkCache = allSessions;
    _sessionBulkCacheTime = now;
  }

  // 날짜별 필터링
  for (const s of allSessions) {
    if (sessionsByDate[s.date]) {
      sessionsByDate[s.date].push({ project: s.project, modifiedAt: s.modifiedAt });
    }
  }
  return sessionsByDate;
}

app.get('/api/insights/productivity', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);

    const dates = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      dates.push(getKSTDateString(d));
    }
    const dateSet = new Set(dates);

    // 벌크 데이터 로드 (각각 1회만)
    const sessionsByDate = findSessionsBulk(dateSet);

    // 메모 날짜별 인덱스
    const memosByDate = {};
    for (const m of loadQuickMemos()) {
      const d = m.timestamp?.split('T')[0];
      if (d && dateSet.has(d)) {
        if (!memosByDate[d]) memosByDate[d] = [];
        memosByDate[d].push(m);
      }
    }

    // Obsidian 메모 (날짜별 파일 읽기 - 경량 카운트 모드)
    const obsidianByDate = {};
    const { vaultPath: _vp, dailyFolder: _df } = getObsidianPaths();
    for (const date of dates) {
      try {
        const notePath = path.join(_vp, _df, `${date}.md`);
        if (!fs.existsSync(notePath)) { obsidianByDate[date] = []; continue; }
        const content = fs.readFileSync(notePath, 'utf8');
        const memos = [];
        const hourlyMatch = content.match(/## ⏰ 시간별 메모\n([\s\S]*?)(?=\n## |$)/);
        if (hourlyMatch) {
          for (const line of hourlyMatch[1].trim().split('\n')) {
            const m = line.match(/^- `((?:오[전후]|[AP]M)?\s*\d{1,2}:\d{2})`/);
            if (m) {
              const timeStr = m[1].trim();
              const digits = timeStr.match(/(\d{1,2}):(\d{2})/);
              let hour = parseInt(digits[1]);
              if (/오후|PM/i.test(timeStr) && hour < 12) hour += 12;
              if (/오전|AM/i.test(timeStr) && hour === 12) hour = 0;
              memos.push({ timestamp: `${date}T${String(hour).padStart(2,'0')}:${digits[2]}:00` });
            }
          }
        }
        obsidianByDate[date] = memos;
      } catch { obsidianByDate[date] = []; }
    }

    // 작업 이력 날짜별 인덱스
    const jobsByDate = {};
    for (const h of jobHistory) {
      const d = h.startTime?.split('T')[0];
      if (d && dateSet.has(d)) {
        if (!jobsByDate[d]) jobsByDate[d] = [];
        jobsByDate[d].push(h);
      }
    }

    // 시간대별 활동 (24시간)
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({
      hour: i, sessions: 0, memos: 0, jobs: 0
    }));

    const dailyTrend = [];
    const projectMap = {};
    let totalSessions = 0, totalMemos = 0, totalJobRuns = 0, totalSessionMinutes = 0;

    for (const date of dates) {
      let daySessions = 0, dayMemos = 0, dayJobs = 0;

      // 세션
      const sessions = sessionsByDate[date] || [];
      daySessions = sessions.length;
      totalSessions += sessions.length;
      for (const s of sessions) {
        const h = s.modifiedAt ? new Date(s.modifiedAt).getHours() : 12;
        hourlyActivity[h].sessions++;
        const proj = s.project || 'unknown';
        if (!projectMap[proj]) projectMap[proj] = { sessions: 0, totalMinutes: 0 };
        projectMap[proj].sessions++;
        projectMap[proj].totalMinutes += 30;
        totalSessionMinutes += 30;
      }

      // 대시보드 메모
      const dashMemos = memosByDate[date] || [];
      dayMemos += dashMemos.length;
      totalMemos += dashMemos.length;
      for (const m of dashMemos) {
        const h = m.timestamp ? new Date(m.timestamp).getHours() : 12;
        hourlyActivity[h].memos++;
      }

      // Obsidian 메모
      const obsMemos = obsidianByDate[date] || [];
      dayMemos += obsMemos.length;
      totalMemos += obsMemos.length;
      for (const m of obsMemos) {
        const h = m.timestamp ? new Date(m.timestamp).getHours() : 12;
        hourlyActivity[h].memos++;
      }

      // 작업 이력
      const dayHistory = jobsByDate[date] || [];
      dayJobs = dayHistory.length;
      totalJobRuns += dayHistory.length;
      for (const h of dayHistory) {
        const hr = h.startTime ? new Date(h.startTime).getHours() : 12;
        hourlyActivity[hr].jobs++;
      }

      dailyTrend.push({ date, sessions: daySessions, memos: dayMemos, jobs: dayJobs });
    }

    // 프로젝트 상위 5개
    const topProjects = Object.entries(projectMap)
      .map(([project, data]) => ({ project, ...data }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5);

    // 기간 비교 (전반 vs 후반)
    const mid = Math.floor(dailyTrend.length / 2);
    const firstHalf = dailyTrend.slice(0, mid);
    const secondHalf = dailyTrend.slice(mid);
    const sum = (arr, key) => arr.reduce((s, d) => s + (d[key] || 0), 0);

    const weekComparison = {
      firstHalf: {
        sessions: sum(firstHalf, 'sessions'),
        memos: sum(firstHalf, 'memos'),
        jobs: sum(firstHalf, 'jobs')
      },
      secondHalf: {
        sessions: sum(secondHalf, 'sessions'),
        memos: sum(secondHalf, 'memos'),
        jobs: sum(secondHalf, 'jobs')
      }
    };

    const avgDays = dates.length || 1;
    res.json({
      period: { start: dates[0], end: dates[dates.length - 1], days },
      overview: {
        totalSessions,
        totalMemos,
        totalJobRuns,
        avgSessionMinutes: totalSessions > 0 ? Math.round(totalSessionMinutes / totalSessions) : 0,
        avgDailyMemos: +(totalMemos / avgDays).toFixed(1)
      },
      hourlyActivity,
      dailyTrend,
      topProjects,
      weekComparison
    });
  } catch (err) {
    console.error('[Productivity] 분석 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 2.1 주간 다이제스트 ---
const WEEKLY_DIGESTS_FILE = path.join(__dirname, 'data', 'weekly-digests.json');

function loadWeeklyDigests() {
  try {
    if (fs.existsSync(WEEKLY_DIGESTS_FILE)) {
      return JSON.parse(fs.readFileSync(WEEKLY_DIGESTS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveWeeklyDigests(digests) {
  const dir = path.dirname(WEEKLY_DIGESTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEEKLY_DIGESTS_FILE, JSON.stringify(digests, null, 2));
}

// --- Memo Categories (Phase 4.1) ---
const MEMO_CATEGORIES_FILE = path.join(__dirname, 'data', 'memo-categories.json');

const CATEGORY_DEFINITIONS = {
  work: { icon: '💼', keywords: ['pr', 'pr리뷰', '배포', 'deploy', '회의', 'meeting', 'review', '리뷰', '머지', 'merge', '코드리뷰', 'jira', '티켓', 'hotfix', 'release', '릴리즈', '장애', '모니터링', '운영', '인프라'] },
  learning: { icon: '📚', keywords: ['학습', '공부', '정리', 'study', 'learn', '이해', '확인중', '알아보기', 'til', '개념', '원리', '동작방식', '아키텍처', '패턴', '블로그', '강의', '튜토리얼', '읽기', '참고'] },
  idea: { icon: '💡', keywords: ['아이디어', 'idea', '제안', '추가하면', '개선', 'suggest', '하면 좋겠다', '해보자', '시도', '구상', '기획'] },
  todo: { icon: '✅', keywords: ['해야', 'todo', '할일', '작업', 'task', '필요', '처리', '예정', '내일', '오늘', '이번주'] },
  issue: { icon: '🐛', keywords: ['이슈', 'issue', '버그', 'bug', '문제', '오류', 'error', 'fail', '실패', 'oom', 'crash', '에러', 'fix', '수정필요'] },
  personal: { icon: '🏠', keywords: ['점심', '저녁', '휴가', 'lunch', 'dinner', 'personal', '약속', '운동', '병원', '맛집'] }
};

function loadMemoCategories() {
  try {
    if (fs.existsSync(MEMO_CATEGORIES_FILE)) {
      return JSON.parse(fs.readFileSync(MEMO_CATEGORIES_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveMemoCategories(categories) {
  const dir = path.dirname(MEMO_CATEGORIES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEMO_CATEGORIES_FILE, JSON.stringify(categories, null, 2));
}

// Tier 1: 키워드 매칭 즉시 분류
function classifyMemoByKeywords(content) {
  const lower = content.toLowerCase();
  const matches = {};

  for (const [cat, def] of Object.entries(CATEGORY_DEFINITIONS)) {
    const matchedKw = def.keywords.filter(kw => lower.includes(kw));
    if (matchedKw.length > 0) matches[cat] = { score: matchedKw.length, keywords: matchedKw };
  }

  if (Object.keys(matches).length === 0) return null;

  const sorted = Object.entries(matches).sort((a, b) => b[1].score - a[1].score);
  const category = sorted[0][0];
  const tags = sorted[0][1].keywords.slice(0, 3);

  return { category, tags, confidence: 'keyword' };
}

// Tier 2: Claude CLI 백그라운드 분류
async function classifyMemoWithClaude(content) {
  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  if (!fs.existsSync(claudePath)) return null;

  const prompt = `다음 메모를 분류하세요.

메모: "${content}"

카테고리 (하나만 선택):
- work: 업무 (PR, 배포, 회의, 코드리뷰)
- learning: 학습/기술 (개념 정리, 새로운 기술)
- idea: 아이디어/제안
- todo: 할일/작업 항목
- issue: 이슈/버그/문제
- personal: 개인/일상

JSON만 응답: {"category": "learning", "tags": ["aws", "ecs"]}
태그는 핵심 키워드 1-3개만.`;

  return new Promise((resolve) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    const timeout = setTimeout(() => { claude.kill('SIGTERM'); resolve(null); }, 20000);

    claude.stdout.on('data', d => { stdout += d.toString(); });
    claude.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try {
        let jsonStr = stdout.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        if (parsed.category && CATEGORY_DEFINITIONS[parsed.category]) {
          resolve({ category: parsed.category, tags: (parsed.tags || []).slice(0, 3), confidence: 'claude' });
        } else {
          resolve(null);
        }
      } catch { resolve(null); }
    });
    claude.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// 비동기 메모 분류 (저장 후 백그라운드)
async function classifyMemoBackground(memoId, content) {
  // Tier 1: 키워드 매칭
  let result = classifyMemoByKeywords(content);

  // Tier 2: 키워드 매칭 실패 시 Claude
  if (!result) {
    result = await classifyMemoWithClaude(content);
  }

  if (result) {
    const categories = loadMemoCategories();
    categories[memoId] = {
      ...result,
      autoTags: true,
      classifiedAt: new Date().toISOString()
    };
    saveMemoCategories(categories);

    // SSE 브로드캐스트
    sendSSEEvent(null, 'memo:classified', { memoId, ...result });
    console.log(`[MemoCategory] ${memoId} → ${result.category} (${result.confidence})`);
  }
}

// --- Session Insights (Phase 4.2) ---
const SESSION_INSIGHTS_FILE = path.join(__dirname, 'data', 'session-insights.json');

function loadSessionInsights() {
  try {
    if (fs.existsSync(SESSION_INSIGHTS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_INSIGHTS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSessionInsights(insights) {
  const dir = path.dirname(SESSION_INSIGHTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_INSIGHTS_FILE, JSON.stringify(insights, null, 2));
}

// 세션 인사이트 생성 태스크
async function processSessionInsightsTask(task) {
  const { sessionId, projectPath } = task.payload;

  updateTaskProgress(task, 10, '세션 데이터 로드 중...');

  const sessionData = parseSessionFile(sessionId, projectPath, { maxMessages: 100 });

  const userMessages = sessionData.conversation
    .filter(c => c.role === 'user' && c.content)
    .slice(0, 20)
    .map(c => c.content.substring(0, 500));

  const assistantSummary = sessionData.conversation
    .filter(c => c.role === 'assistant' && c.content)
    .slice(0, 10)
    .map(c => c.content.substring(0, 300));

  updateTaskProgress(task, 30, 'Claude 분석 요청 중...');

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  if (!fs.existsSync(claudePath)) {
    throw new Error(`Claude CLI를 찾을 수 없습니다: ${claudePath}`);
  }

  const prompt = `다음 Claude Code 세션을 분석하여 인사이트를 추출하세요.

프로젝트: ${sessionData.project}
메시지 수: ${sessionData.messageCount}
사용 도구: ${[...sessionData.toolsUsed].slice(0, 10).join(', ')}
변경 파일: ${[...sessionData.filesChanged].slice(0, 15).join(', ')}

사용자 요청:
${userMessages.join('\n---\n')}

Assistant 응답 (요약):
${assistantSummary.slice(0, 5).join('\n---\n')}

JSON 형식으로만 응답하세요:
{
  "topics": ["주제1", "주제2"],
  "technologies": ["기술1", "기술2"],
  "problems_solved": ["해결한 문제"],
  "key_decisions": ["주요 결정"],
  "complexity": "low|medium|high",
  "summary": "한 줄 요약 (50자 이내)"
}

규칙:
- topics: 다룬 주제 3-5개
- technologies: 사용/언급된 기술 2-5개
- problems_solved: 해결한 문제 1-3개
- key_decisions: 주요 결정 1-2개
- complexity: 세션 복잡도
- 한국어 세션이면 한국어로 응답`;

  task.command = `${claudePath} -p "..."`;
  task.logs.push({ type: 'cmd', time: new Date().toISOString(), text: 'Claude 인사이트 분석 실행' });

  updateTaskProgress(task, 40, 'Claude CLI 실행 중...');

  const insights = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);
    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
      task.stdout = stdout;
      updateTaskProgress(task, 60, 'Claude 응답 수신 중...');
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
      task.stderr = stderr;
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error('타임아웃 (4분)'));
    }, 240000);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      runningTaskProcesses.delete(task.id);
      if (code === 0 && stdout.trim()) {
        try {
          let jsonStr = stdout.trim();
          const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) jsonStr = jsonMatch[0];
          resolve(JSON.parse(jsonStr));
        } catch (err) {
          reject(new Error(`JSON 파싱 실패: ${err.message}`));
        }
      } else {
        reject(new Error(`Claude 실행 실패 (exit ${code}): ${stderr || 'No output'}`));
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      runningTaskProcesses.delete(task.id);
      reject(err);
    });
  });

  updateTaskProgress(task, 85, '인사이트 저장 중...');

  const allInsights = loadSessionInsights();
  allInsights[sessionId] = {
    ...insights,
    files_modified: [...sessionData.filesChanged].slice(0, 15),
    createdAt: new Date().toISOString()
  };
  saveSessionInsights(allInsights);

  // 지식 그래프에 반영
  try { rebuildKnowledgeGraph(); } catch (e) { /* 그래프 재구성 실패 무시 */ }

  updateTaskProgress(task, 100, '완료');
  return { sessionId, project: sessionData.project, insights: allInsights[sessionId] };
}

// --- Knowledge Graph (Phase 4.3) ---
const KNOWLEDGE_GRAPH_FILE = path.join(__dirname, 'data', 'knowledge-graph.json');

function loadKnowledgeGraphData() {
  try {
    if (fs.existsSync(KNOWLEDGE_GRAPH_FILE)) {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_GRAPH_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { nodes: [], edges: [], metadata: { lastUpdated: null, totalNodes: 0, totalEdges: 0 } };
}

function saveKnowledgeGraph(graph) {
  const dir = path.dirname(KNOWLEDGE_GRAPH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  graph.metadata = {
    lastUpdated: new Date().toISOString(),
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length
  };
  fs.writeFileSync(KNOWLEDGE_GRAPH_FILE, JSON.stringify(graph, null, 2));
}

function rebuildKnowledgeGraph() {
  const allInsights = loadSessionInsights();
  const memoCategories = loadMemoCategories();
  const memos = loadQuickMemos();

  const nodeMap = new Map();
  const edgeMap = new Map();

  // 세션 인사이트에서 토픽 추출
  for (const [sessionId, insight] of Object.entries(allInsights)) {
    const allKeywords = [...(insight.topics || []), ...(insight.technologies || [])];

    for (const keyword of allKeywords) {
      const nodeId = `topic-${keyword.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;

      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId, label: keyword, category: 'general',
          mentions: 0, lastSeen: getKSTDateString(),
          sources: { sessions: [], memos: [] }
        });
      }

      const node = nodeMap.get(nodeId);
      node.mentions++;
      if (!node.sources.sessions.includes(sessionId)) {
        node.sources.sessions.push(sessionId);
      }
      const insightDate = insight.createdAt?.split('T')[0];
      if (insightDate && insightDate > node.lastSeen) node.lastSeen = insightDate;
    }

    // 엣지: 동일 세션에서 동시 언급
    for (let i = 0; i < allKeywords.length; i++) {
      for (let j = i + 1; j < allKeywords.length; j++) {
        const idA = `topic-${allKeywords[i].toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;
        const idB = `topic-${allKeywords[j].toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;
        const edgeKey = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;

        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            from: idA < idB ? idA : idB,
            to: idA < idB ? idB : idA,
            strength: 0, context: `${allKeywords[i]}와 ${allKeywords[j]}`,
            cooccurrences: []
          });
        }

        const edge = edgeMap.get(edgeKey);
        edge.strength++;
        if (!edge.cooccurrences.includes(sessionId)) edge.cooccurrences.push(sessionId);
      }
    }
  }

  // 메모 태그에서 토픽 추출
  for (const memo of memos) {
    const cat = memoCategories[memo.id];
    if (!cat || !cat.tags || cat.tags.length === 0) continue;

    for (const tag of cat.tags) {
      const nodeId = `topic-${tag.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;

      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId, label: tag, category: cat.category || 'general',
          mentions: 0, lastSeen: getKSTDateString(),
          sources: { sessions: [], memos: [] }
        });
      }

      const node = nodeMap.get(nodeId);
      node.mentions++;
      if (!node.sources.memos.includes(memo.id)) node.sources.memos.push(memo.id);
      const memoDate = memo.timestamp?.split('T')[0];
      if (memoDate && memoDate > node.lastSeen) node.lastSeen = memoDate;
    }
  }

  const graph = {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values())
  };

  saveKnowledgeGraph(graph);
  console.log(`[KnowledgeGraph] 재구성 완료: ${graph.nodes.length}개 노드, ${graph.edges.length}개 엣지`);
  return graph;
}

// --- Review Analysis (Phase 4.4) ---
const REVIEW_ANALYSIS_FILE = path.join(__dirname, 'data', 'review-analysis.json');

function loadReviewAnalysis() {
  try {
    if (fs.existsSync(REVIEW_ANALYSIS_FILE)) {
      return JSON.parse(fs.readFileSync(REVIEW_ANALYSIS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveReviewAnalysis(data) {
  const dir = path.dirname(REVIEW_ANALYSIS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REVIEW_ANALYSIS_FILE, JSON.stringify(data, null, 2));
}

async function processReviewAnalysisTask(task) {
  const { days = 30 } = task.payload;

  updateTaskProgress(task, 10, 'GitHub 리뷰 데이터 수집 중...');

  // GitHub 활동에서 리뷰 관련 이벤트 수집
  const allActivity = [];
  const dateSet = new Set();
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dateSet.add(getKSTDateString(d));
  }

  try {
    const accounts = await getGhAccounts();
    for (const acc of accounts) {
      const username = acc.username;
      const eventsUrl = `/users/${username}/events?per_page=100`;
      const result = JSON.parse(await new Promise((resolve, reject) => {
        const gh = spawn('gh', ['api', eventsUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        gh.stdout.on('data', d => { out += d.toString(); });
        gh.on('close', code => code === 0 ? resolve(out) : reject(new Error(`gh failed: ${code}`)));
        gh.on('error', reject);
      }));

      const reviews = result.filter(e =>
        e.type === 'PullRequestReviewEvent' || e.type === 'PullRequestReviewCommentEvent'
      ).map(e => ({
        repo: e.repo?.name,
        prNumber: e.payload?.pull_request?.number,
        prTitle: e.payload?.pull_request?.title || '(제목 없음)',
        action: e.payload?.action,
        state: e.payload?.review?.state,
        body: e.payload?.review?.body || e.payload?.comment?.body || '',
        createdAt: e.created_at,
        account: username
      }));

      allActivity.push(...reviews);
    }
  } catch (err) {
    console.error('[ReviewAnalysis] GitHub 데이터 수집 오류:', err.message);
  }

  if (allActivity.length === 0) {
    return { period: `${days} days`, reviewCount: 0, analysis: { common_patterns: [], review_style: '데이터 부족', suggestions: [], checklist: [] } };
  }

  updateTaskProgress(task, 40, `${allActivity.length}개 리뷰 분석 중...`);

  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  if (!fs.existsSync(claudePath)) {
    throw new Error('Claude CLI를 찾을 수 없습니다');
  }

  const reviewSummaries = allActivity.slice(0, 30).map(r => ({
    repo: r.repo, pr: r.prTitle, state: r.state,
    comment: (r.body || '').substring(0, 200), date: r.createdAt?.split('T')[0]
  }));

  const prompt = `다음은 ${days}일간의 코드 리뷰 활동입니다.

${JSON.stringify(reviewSummaries, null, 2)}

JSON만 응답:
{
  "common_patterns": ["자주 지적하는 패턴 (상위 3개)"],
  "review_style": "리뷰 스타일 한 문장 설명",
  "suggestions": ["개선 제안 2-3개"],
  "checklist": [
    {"item": "체크리스트 항목", "category": "security|performance|style|testing"}
  ],
  "summary": "전체 리뷰 활동 요약 (2-3문장)"
}`;

  const analysis = await new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    runningTaskProcesses.set(task.id, claude);
    let stdout = '';

    claude.stdout.on('data', d => {
      stdout += d.toString();
      task.stdout = stdout;
      updateTaskProgress(task, 70, 'Claude 응답 수신 중...');
    });

    const timeoutId = setTimeout(() => { claude.kill('SIGTERM'); reject(new Error('타임아웃')); }, 240000);

    claude.on('close', code => {
      clearTimeout(timeoutId);
      runningTaskProcesses.delete(task.id);
      if (code === 0 && stdout.trim()) {
        try {
          let jsonStr = stdout.trim();
          const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) jsonStr = jsonMatch[0];
          resolve(JSON.parse(jsonStr));
        } catch (err) { reject(new Error(`JSON 파싱 실패: ${err.message}`)); }
      } else { reject(new Error(`Claude 실행 실패 (exit ${code})`)); }
    });

    claude.on('error', err => { clearTimeout(timeoutId); runningTaskProcesses.delete(task.id); reject(err); });
  });

  updateTaskProgress(task, 90, '결과 저장 중...');

  const result = {
    id: `ra-${getKSTDateString()}`,
    period: `${days} days`,
    reviewCount: allActivity.length,
    analysis,
    createdAt: new Date().toISOString()
  };

  const allAnalysis = loadReviewAnalysis();
  const existIdx = allAnalysis.findIndex(a => a.id === result.id);
  if (existIdx >= 0) allAnalysis[existIdx] = result;
  else allAnalysis.push(result);
  saveReviewAnalysis(allAnalysis);

  updateTaskProgress(task, 100, '완료');
  return result;
}

// --- Session Summaries ---
const SESSION_SUMMARIES_FILE = path.join(__dirname, 'data', 'session-summaries.json');

function loadSessionSummaries() {
  try {
    if (fs.existsSync(SESSION_SUMMARIES_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_SUMMARIES_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveSessionSummaries(summaries) {
  const dir = path.dirname(SESSION_SUMMARIES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_SUMMARIES_FILE, JSON.stringify(summaries, null, 2));
}

// --- Daily Reports (daily-report, full-daily-report, day-wrapup) ---
const DAILY_REPORTS_FILE = path.join(__dirname, 'data', 'daily-reports.json');

function loadDailyReports() {
  try {
    if (fs.existsSync(DAILY_REPORTS_FILE)) {
      return JSON.parse(fs.readFileSync(DAILY_REPORTS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveDailyReports(reports) {
  const dir = path.dirname(DAILY_REPORTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DAILY_REPORTS_FILE, JSON.stringify(reports, null, 2));
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=일
  const diff = day === 0 ? 6 : day - 1; // 월요일 기준
  d.setDate(d.getDate() - diff);
  return getKSTDateString(d);
}

function getDateRange(start, end) {
  const dates = [];
  for (let d = new Date(start + 'T00:00:00'); d <= new Date(end + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    dates.push(getKSTDateString(d));
  }
  return dates;
}

// ============ Phase 4 API Endpoints ============

// PATCH /api/quick-memos/:id/category - 수동 카테고리/태그 수정
app.patch('/api/quick-memos/:id/category', (req, res) => {
  const { id } = req.params;
  const { category, tags } = req.body;

  if (category && !CATEGORY_DEFINITIONS[category]) {
    return res.status(400).json({ error: `Invalid category: ${category}` });
  }

  const categories = loadMemoCategories();
  categories[id] = {
    category: category || categories[id]?.category || null,
    tags: tags || categories[id]?.tags || [],
    autoTags: false,
    classifiedAt: new Date().toISOString()
  };
  saveMemoCategories(categories);

  res.json({ success: true, classification: categories[id] });
});

// POST /api/memos/migrate-classifications - 기존 메모 일괄 키워드 분류
app.post('/api/memos/migrate-classifications', (req, res) => {
  const memos = loadQuickMemos();
  const categories = loadMemoCategories();
  let classified = 0;

  for (const memo of memos) {
    if (!categories[memo.id]) {
      const result = classifyMemoByKeywords(memo.content);
      if (result) {
        categories[memo.id] = { ...result, autoTags: true, classifiedAt: new Date().toISOString() };
        classified++;
      }
    }
  }

  saveMemoCategories(categories);
  console.log(`[MemoCategory] 마이그레이션 완료: ${classified}/${memos.length}`);
  res.json({ success: true, classified, total: memos.length });
});

// GET /api/memos/stats - 카테고리별 통계
app.get('/api/memos/stats', (req, res) => {
  const memos = loadQuickMemos();
  const categories = loadMemoCategories();

  const stats = {};
  for (const cat of Object.keys(CATEGORY_DEFINITIONS)) stats[cat] = 0;
  stats.uncategorized = 0;

  memos.forEach(m => {
    const cat = categories[m.id]?.category;
    if (cat && stats[cat] !== undefined) stats[cat]++;
    else stats.uncategorized++;
  });

  res.json({ stats, total: memos.length, definitions: CATEGORY_DEFINITIONS });
});

// GET /api/sessions/:id/insights - 세션 인사이트 조회
app.get('/api/sessions/:id/insights', (req, res) => {
  const { id } = req.params;
  const { project } = req.query;

  const allInsights = loadSessionInsights();

  if (allInsights[id]) {
    return res.json({ insights: allInsights[id], cached: true });
  }

  if (!project) {
    return res.status(400).json({ error: 'project query parameter required for generation' });
  }

  // 태스크 생성
  const task = {
    id: generateTaskId(),
    type: 'session-insights',
    payload: { sessionId: id, projectPath: project },
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '',
    logs: [], command: null,
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, clientId: null
  };

  taskQueue.set(task.id, task);
  processTask(task);

  res.json({ taskId: task.id, status: 'generating' });
});

// GET /api/sessions/insights/overview - 인사이트 통계 요약
app.get('/api/sessions/insights/overview', (req, res) => {
  const days = parseInt(req.query.days || '7');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString();

  const allInsights = loadSessionInsights();
  const recentInsights = Object.entries(allInsights)
    .filter(([_, ins]) => ins.createdAt >= cutoff)
    .map(([sessionId, ins]) => ({ sessionId, ...ins }));

  const topicCount = {};
  const techCount = {};
  const complexity = { low: 0, medium: 0, high: 0 };

  recentInsights.forEach(ins => {
    (ins.topics || []).forEach(t => { topicCount[t] = (topicCount[t] || 0) + 1; });
    (ins.technologies || []).forEach(t => { techCount[t] = (techCount[t] || 0) + 1; });
    if (ins.complexity) complexity[ins.complexity]++;
  });

  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));
  const topTech = Object.entries(techCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([tech, count]) => ({ tech, count }));

  res.json({ period: `${days} days`, sessionsAnalyzed: recentInsights.length, topTopics, topTechnologies: topTech, complexityDistribution: complexity });
});

// GET /api/knowledge-graph - 지식 그래프 데이터
app.get('/api/knowledge-graph', (req, res) => {
  let graph = loadKnowledgeGraphData();
  const minMentions = parseInt(req.query.minMentions || '1');

  if (req.query.rebuild === 'true') {
    graph = rebuildKnowledgeGraph();
  }

  if (minMentions > 1) {
    const nodeIds = new Set(graph.nodes.filter(n => n.mentions >= minMentions).map(n => n.id));
    graph = {
      ...graph,
      nodes: graph.nodes.filter(n => nodeIds.has(n.id)),
      edges: graph.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    };
  }

  res.json(graph);
});

// POST /api/knowledge-graph/rebuild - 지식 그래프 재구성
app.post('/api/knowledge-graph/rebuild', (req, res) => {
  try {
    const graph = rebuildKnowledgeGraph();
    res.json({ success: true, nodes: graph.nodes.length, edges: graph.edges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-graph/recommendations - 토픽 추천
app.get('/api/knowledge-graph/recommendations', (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.status(400).json({ error: 'topic parameter required' });

  const graph = loadKnowledgeGraphData();
  const topicId = `topic-${topic.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;

  const relatedEdges = graph.edges
    .filter(e => e.from === topicId || e.to === topicId)
    .sort((a, b) => b.strength - a.strength);

  const related = relatedEdges.slice(0, 5).map(e => {
    const otherId = e.from === topicId ? e.to : e.from;
    const node = graph.nodes.find(n => n.id === otherId);
    return { topic: node?.label || otherId, reason: `${e.strength}회 함께 언급됨`, strength: e.strength };
  });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 60);
  const cutoff = getKSTDateString(cutoffDate);

  const reviewNeeded = graph.nodes
    .filter(n => n.lastSeen < cutoff && n.mentions >= 3)
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))
    .slice(0, 3)
    .map(n => ({ topic: n.label, lastSeen: n.lastSeen, reason: `${n.mentions}회 학습, 복습 추천` }));

  res.json({ related, review_needed: reviewNeeded });
});

// POST /api/github/review-analysis - 리뷰 패턴 분석 (비동기)
app.post('/api/github/review-analysis', (req, res) => {
  const { days = 30, clientId } = req.body || {};

  // 캐시 확인
  const cached = loadReviewAnalysis();
  const today = getKSTDateString();
  const existing = cached.find(a => a.id === `ra-${today}`);
  if (existing) {
    return res.json({ cached: true, ...existing });
  }

  const task = {
    id: generateTaskId(),
    type: 'review-analysis',
    payload: { days: parseInt(days) },
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '',
    logs: [], command: null,
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, clientId
  };

  taskQueue.set(task.id, task);
  processTask(task);

  res.json({ taskId: task.id, status: 'generating' });
});

// GET /api/github/review-analysis - 저장된 리뷰 분석 조회
app.get('/api/github/review-analysis', (req, res) => {
  const analyses = loadReviewAnalysis();
  if (analyses.length === 0) return res.json({ analysis: null });
  res.json({ analysis: analyses[analyses.length - 1] });
});

// POST /api/insights/weekly-digest - 주간 다이제스트 생성 (비동기 태스크)
app.post('/api/insights/weekly-digest', (req, res) => {
  const { weekStart, clientId } = req.body || {};

  const task = {
    id: generateTaskId(),
    type: 'weekly-digest',
    payload: { weekStart },
    status: 'pending',
    progress: 0,
    progressMessage: '대기 중...',
    result: null,
    error: null,
    stdout: '',
    stderr: '',
    logs: [],
    command: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    clientId
  };

  taskQueue.set(task.id, task);
  console.log(`[Tasks] 주간 다이제스트 작업 생성: ${task.id}`);
  processTask(task);

  res.json({ taskId: task.id });
});

// GET /api/insights/weekly-digest - 저장된 다이제스트 조회
app.get('/api/insights/weekly-digest', (req, res) => {
  const week = req.query.week;
  const digests = loadWeeklyDigests();

  if (week) {
    const digest = digests.find(d => d.weekStart === week);
    return res.json({ digest: digest || null });
  }

  // 최근 N개 (기본 10)
  const limit = parseInt(req.query.limit) || 10;
  const list = digests.slice(-limit).reverse().map(d => ({
    id: d.id, weekStart: d.weekStart, weekEnd: d.weekEnd, createdAt: d.createdAt, stats: d.stats
  }));
  res.json({ digests: list });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM 수신 - 정상 종료 중...');
  cleanupRunningJobs();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT 수신 - 정상 종료 중...');
  cleanupRunningJobs();
  process.exit(0);
});

// 실행 중인 작업 정리
function cleanupRunningJobs() {
  const now = new Date().toISOString();
  let cleaned = 0;

  for (const entry of jobHistory) {
    if (entry.status === 'running') {
      entry.status = 'failed';
      entry.error = 'Server shutdown';
      entry.endTime = now;
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Server] ${cleaned}개 실행 중 작업 정리됨`);
    saveHistory();
  }
}

// ============ Start Server ============

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     AI Pipeline Dashboard                            ║
║     http://localhost:${PORT}                            ║
╚══════════════════════════════════════════════════════╝
  `);

  // 서버 시작 시 좀비 작업 정리
  const zombieCount = jobHistory.filter(h => h.status === 'running').length;
  if (zombieCount > 0) {
    console.log(`[Server] 이전 좀비 작업 ${zombieCount}개 정리 중...`);
    cleanupRunningJobs();
  }

  initializeJobs();
});
