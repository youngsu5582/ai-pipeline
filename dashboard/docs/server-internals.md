# Server.js 내부 구조

Express 서버의 코드 레벨 상세 분석입니다.

## 파일 위치
`dashboard/server.js` (약 1800줄)

## 의존성

```javascript
const express = require('express');
const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');
const os = require('os');
```

## 전역 상태 변수

```javascript
// 비동기 작업 시스템
const taskQueue = new Map();           // taskId -> QueueTask 객체
const sseClients = new Map();          // clientId -> Express Response 객체
const runningTaskProcesses = new Map(); // taskId -> ChildProcess 객체

// 작업 스케줄링
let scheduledJobs = {};    // { jobId: CronTask } - node-cron 작업 인스턴스
let jobHistory = [];       // 실행 이력 배열 (메모리, 최근 100개)
let runningJobs = {};      // { jobId: { logId, stdout, stderr, startTime, command } }
let jobRetryCount = {};    // { jobId: number } - 재시도 횟수 추적

// 예약 실행
const scheduledOnceJobs = {}; // { jobId: setTimeout ID }
```

## 상수 및 설정

```javascript
const PORT = process.env.PORT || 3030;
let DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3030';
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const LOGS_DIR = path.join(__dirname, 'logs');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
```

## 핵심 함수 상세

### 1. 작업 ID 생성

```javascript
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
// 출력 예: "task-1707184800000-abc123xyz"
```

### 2. SSE 이벤트 전송

```javascript
/**
 * Server-Sent Events로 클라이언트에 이벤트 전송
 * @param {string|null} clientId - 특정 클라이언트 ID (null이면 브로드캐스트)
 * @param {string} event - 이벤트 이름 (connected, task:progress, ping 등)
 * @param {object} data - JSON 직렬화될 데이터
 */
function sendSSEEvent(clientId, event, data) {
  if (clientId && sseClients.has(clientId)) {
    // 특정 클라이언트에게만 전송
    const res = sseClients.get(clientId);
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } else {
    // 모든 클라이언트에게 브로드캐스트
    sseClients.forEach((res, cid) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
  }
}
```

### 3. 설정 값 조회

```javascript
/**
 * jobs.json의 settings에서 값 가져오기
 * @param {string} key - 설정 키
 * @param {any} defaultValue - 기본값
 * @returns {any}
 */
function getSettingValue(key, defaultValue) {
  try {
    const data = loadJobs();
    return data.settings?.[key] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
```

### 4. jobs.json 로드/저장

```javascript
function loadJobs() {
  try {
    const data = fs.readFileSync(JOBS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading jobs:', error);
    return { jobs: [], categories: {} };
  }
}

function saveJobs(data) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
}
```

### 5. 히스토리 관리

```javascript
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

function saveHistory() {
  const historyFile = path.join(LOGS_DIR, 'history.json');
  // 최근 100개만 유지
  const trimmed = jobHistory.slice(-100);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}
```

### 6. Auto-fix 시스템

```javascript
// 기본 자동 복구 규칙
const DEFAULT_AUTO_FIX_RULES = [
  {
    id: 'pip-missing',
    name: 'Python 패키지 누락',
    pattern: /(?:No module named|ModuleNotFoundError:.*'(\w+)')/i,
    extractPackage: (match, stdout, stderr) => {
      // pip install <package> 형태 찾기
      const pipMatch = (stdout + stderr).match(/pip install\s+(\S+)/i);
      if (pipMatch) return pipMatch[1];
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

/**
 * 에러 출력에서 자동 복구 가능 여부 확인
 * @param {string} stdout
 * @param {string} stderr
 * @returns {object|null} { rule, package, fixCommand }
 */
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

/**
 * 자동 복구 명령 실행
 * @param {string} fixCommand
 * @returns {Promise<{success: boolean, stdout: string, stderr: string}>}
 */
function runAutoFix(fixCommand) {
  return new Promise((resolve, reject) => {
    console.log(`[AutoFix] 실행: ${fixCommand}`);
    const child = spawn('/bin/zsh', ['-c', fixCommand], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });
    // stdout, stderr 수집 후 resolve/reject
  });
}
```

### 7. 명령어 빌드

```javascript
/**
 * job.options를 기반으로 최종 명령어 생성
 * system 옵션은 제외됨 (서버에서 처리)
 *
 * @param {object} job - 작업 정의
 * @param {object} options - 사용자 선택 옵션 { "--flag": value }
 * @returns {string} 최종 명령어
 *
 * @example
 * // job.command = "python script.py"
 * // job.options = [{ flag: "--yes", type: "boolean", default: true }]
 * // options = { "--yes": true, "--date": "2026-01-31" }
 * // 결과: "python script.py --yes --date \"2026-01-31\""
 */
function buildCommand(job, options = {}) {
  let command = job.command;
  const jobOptions = job.options || [];

  const flags = [];  // ["--yes", "--date \"2026-01-31\""]
  const args = [];   // ["positional_arg"]

  for (const opt of jobOptions) {
    if (opt.system) continue;  // system 옵션은 명령어에 추가 안 함

    const value = options[opt.flag || opt.arg];

    if (opt.type === 'boolean') {
      const isEnabled = value !== undefined ? value : opt.default;
      if (isEnabled && opt.flag) {
        flags.push(opt.flag);
      }
    } else if (opt.type === 'string' && value) {
      if (opt.flag) {
        flags.push(`${opt.flag} "${value}"`);
      } else if (opt.arg) {
        args.push(value);
      }
    } else if (opt.type === 'array' && value) {
      const joinedValue = Array.isArray(value) ? value.join(',') : value;
      if (joinedValue) {
        if (opt.flag) {
          flags.push(`${opt.flag} "${joinedValue}"`);
        }
      }
    } else if (opt.type === 'select' && value) {
      if (opt.flag) {
        flags.push(`${opt.flag} "${value}"`);
      }
    }
  }

  // 명령어에 플래그/인자 추가
  if (flags.length > 0) {
    command = `${command} ${flags.join(' ')}`;
  }
  if (args.length > 0) {
    command = `${command} ${args.join(' ')}`;
  }

  return command;
}

/**
 * system 옵션 추출 (--slack 등 서버 처리용)
 */
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
  return systemOpts;  // { "--slack": true }
}
```

### 8. 작업 실행 (핵심)

```javascript
/**
 * 작업 실행 메인 함수
 *
 * @param {object} job - 작업 정의 객체
 * @param {string} trigger - 실행 트리거 ('manual'|'scheduled'|'chained'|'retry'|'auto-fix')
 * @param {object} options - 실행 옵션
 * @param {number} chainDepth - 파이프라인 체이닝 깊이 (무한루프 방지, max 10)
 * @param {number} retryAttempt - 현재 재시도 횟수
 * @returns {Promise<{stdout, stderr, duration}>}
 */
function executeJob(job, trigger = 'manual', options = {}, chainDepth = 0, retryAttempt = 0) {
  return new Promise((resolve, reject) => {
    // 1. 동시 실행 방지
    if (runningJobs[job.id] && trigger !== 'retry') {
      return reject(new Error('Job is already running'));
    }

    // 2. 실행 설정 추출
    const startTime = new Date();
    const logId = Date.now();
    const command = buildCommand(job, options);
    const systemOpts = getSystemOptions(job, options);
    const shouldNotifySlack = systemOpts['--slack'] === true;

    // 3. 실행 제어 설정
    const executionConfig = job.execution || {};
    const timeout = executionConfig.timeout || 300000;     // 5분
    const maxRetries = executionConfig.maxRetries || 0;
    const baseRetryDelay = executionConfig.retryDelay || 5000;
    const backoffStrategy = executionConfig.backoff || 'fixed';

    // 4. 백오프 계산
    const calculateRetryDelay = (attempt) => {
      switch (backoffStrategy) {
        case 'linear': return baseRetryDelay * attempt;
        case 'exponential': return baseRetryDelay * Math.pow(2, attempt - 1);
        default: return baseRetryDelay;
      }
    };

    // 5. 로그 엔트리 생성
    const logEntry = {
      id: logId,
      jobId: job.id,
      jobName: job.name,
      trigger: retryAttempt > 0 ? `retry(${retryAttempt})` : trigger,
      startTime: startTime.toISOString(),
      status: 'running',
      stdout: '',
      stderr: '',
      command: command,
      options: options,
      retryAttempt
    };
    jobHistory.push(logEntry);

    // 6. 실행 중 상태 등록
    runningJobs[job.id] = { logId, stdout: '', stderr: '', startTime, command };

    // 7. 프로세스 실행
    const child = spawn('/bin/zsh', ['-c', command], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });

    // 8. 타임아웃 설정
    let timeoutId = null;
    let isTimedOut = false;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        child.kill('SIGTERM');
      }, timeout);
    }

    // 9. stdout/stderr 수집
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

    // 10. 완료 처리
    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);

      const endTime = new Date();
      const duration = endTime - startTime;
      logEntry.endTime = endTime.toISOString();
      logEntry.duration = duration;

      delete runningJobs[job.id];

      // 타임아웃 처리
      if (isTimedOut) {
        logEntry.status = 'failed';
        logEntry.error = `Timeout after ${timeout}ms`;
        saveHistory();
        // 재시도 로직...
        return;
      }

      // 실패 처리
      if (code !== 0) {
        logEntry.status = 'failed';
        logEntry.error = `Exit code: ${code}`;
        saveHistory();

        // Auto-fix 시도 (첫 실패 시에만)
        if (retryAttempt === 0) {
          const autoFix = checkAutoFix(logEntry.stdout, logEntry.stderr);
          if (autoFix) {
            logEntry.autoFix = { rule: autoFix.rule.name, command: autoFix.fixCommand };
            runAutoFix(autoFix.fixCommand)
              .then(() => executeJob(job, 'auto-fix', options, chainDepth, 0))
              .then(resolve)
              .catch(/* 일반 재시도로 진행 */);
            return;
          }
        }

        // 일반 재시도
        if (retryAttempt < maxRetries) {
          const retryDelay = calculateRetryDelay(retryAttempt + 1);
          setTimeout(() => {
            executeJob(job, 'retry', options, chainDepth, retryAttempt + 1)
              .then(resolve).catch(reject);
          }, retryDelay);
          return;
        }

        // Slack 알림
        if (shouldNotifySlack) {
          sendSlackNotification(job, 'failed', { duration, error: logEntry.error, ... });
        }

        // 파이프라인 체이닝
        triggerNextJobs(job.id, 'failed', logEntry, chainDepth);
        reject(new Error(`Exit code: ${code}`));
      } else {
        // 성공 처리
        logEntry.status = 'success';
        saveHistory();

        if (shouldNotifySlack) {
          sendSlackNotification(job, 'success', { duration, stdout: logEntry.stdout, ... });
        }

        triggerNextJobs(job.id, 'success', logEntry, chainDepth);
        resolve({ stdout: logEntry.stdout, stderr: logEntry.stderr, duration });
      }
    });
  });
}
```

### 9. 파이프라인 체이닝

```javascript
/**
 * 작업 완료 후 연결된 다음 작업들을 실행
 *
 * @param {string} jobId - 완료된 작업 ID
 * @param {string} status - 'success' | 'failed'
 * @param {object} prevLog - 이전 작업 로그
 * @param {number} depth - 체이닝 깊이 (max 10, 무한루프 방지)
 */
function triggerNextJobs(jobId, status, prevLog, depth = 0) {
  if (depth > 10) {
    console.error(`[Chain] Max depth (10) exceeded for job ${jobId}`);
    return;
  }

  const data = loadJobs();
  const edges = data.edges || [];

  // trigger=true인 엣지만 찾기
  const triggerEdges = edges.filter(e =>
    e.from === jobId &&
    e.trigger === true &&
    (e.onSuccess === false || status === 'success')
  );

  if (triggerEdges.length === 0) return;

  for (const edge of triggerEdges) {
    const nextJob = data.jobs.find(j => j.id === edge.to);
    if (!nextJob) continue;

    const defaultOptions = getDefaultOptionsFromJob(nextJob);
    executeJob(nextJob, 'chained', defaultOptions, depth + 1)
      .catch(err => console.error(`[Chain] Failed: ${err.message}`));
  }
}
```

### 10. 스케줄링

```javascript
/**
 * 작업 스케줄 등록
 */
function scheduleJob(job) {
  // 기존 스케줄 제거
  if (scheduledJobs[job.id]) {
    scheduledJobs[job.id].stop();
  }

  // 새 스케줄 등록
  if (job.enabled && cron.validate(job.schedule)) {
    scheduledJobs[job.id] = cron.schedule(job.schedule, () => {
      const defaultOptions = getDefaultOptionsFromJob(job);
      executeJob(job, 'scheduled', defaultOptions)
        .catch(err => console.error(`[Scheduled] ${job.name} 실패:`, err.message));
    });
    console.log(`Scheduled: ${job.name} (${job.schedule})`);
  }
}

/**
 * job.options에서 기본값 추출
 */
function getDefaultOptionsFromJob(job) {
  const options = {};
  if (!job.options) return options;

  for (const opt of job.options) {
    const key = opt.flag || opt.arg;
    if (key && opt.default !== undefined && opt.default !== '') {
      options[key] = opt.default;
    }
  }
  return options;  // { "--yes": true, "--slack": false }
}

/**
 * 모든 작업 초기화
 */
function initializeJobs() {
  const { jobs } = loadJobs();
  jobs.forEach(job => {
    if (job.enabled) {
      scheduleJob(job);
    }
  });
  console.log(`Initialized ${Object.keys(scheduledJobs).length} scheduled jobs`);
}
```

### 11. Slack 알림

```javascript
/**
 * Slack 웹훅 알림 전송
 *
 * @param {object} job - 작업 정의
 * @param {string} status - 'success' | 'failed'
 * @param {object} result - { duration, stdout, stderr, error, logId }
 */
function sendSlackNotification(job, status, result = {}) {
  const webhookUrl = getSettingValue('slackWebhookUrl', '') || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return Promise.resolve();

  const dashboardUrl = getSettingValue('dashboardUrl', DASHBOARD_URL);

  const message = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${status === 'success' ? '✅' : '❌'} ${job.name} - ${status === 'success' ? '성공' : '실패'}`,
          emoji: true
        }
      },
      // ... 상세 블록들
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "📋 상세 보기" },
          url: `${dashboardUrl}?tab=history&logId=${result.logId}`
        }]
      }
    ]
  };

  // https.request로 전송
}
```

## API 라우트 구조

```javascript
// === 작업 관리 ===
app.get('/api/jobs', ...)           // 목록 조회
app.get('/api/jobs/:id', ...)       // 상세 조회
app.post('/api/jobs', ...)          // 생성
app.put('/api/jobs/:id', ...)       // 수정
app.delete('/api/jobs/:id', ...)    // 삭제
app.post('/api/jobs/:id/duplicate', ...) // 복제

// === 작업 실행 ===
app.post('/api/jobs/:id/run', ...)          // 즉시 실행
app.post('/api/jobs/:id/toggle', ...)       // 활성화 토글
app.post('/api/jobs/:id/schedule-once', ...) // 1회 예약
app.get('/api/jobs/:id/live-log', ...)      // 실시간 로그

// === 엣지 (의존성) ===
app.get('/api/edges', ...)
app.post('/api/edges', ...)
app.put('/api/edges/:id', ...)
app.delete('/api/edges/:id', ...)

// === 위치 저장 ===
app.post('/api/jobs/positions', ...)

// === 이력 ===
app.get('/api/history', ...)  // 페이지네이션, 필터링

// === 통계 ===
app.get('/api/stats/summary', ...)   // 요약
app.get('/api/stats/jobs', ...)      // 작업별
app.get('/api/stats/trend', ...)     // 일별 트렌드
app.get('/api/stats/hourly', ...)    // 시간대별
app.get('/api/stats/failures', ...)  // 실패 TOP N

// === 설정 ===
app.get('/api/settings', ...)
app.put('/api/settings', ...)

// === 내보내기/가져오기 ===
app.get('/api/export/history', ...)
app.get('/api/export/stats', ...)
app.get('/api/export/jobs', ...)
app.get('/api/export', ...)
app.post('/api/import', ...)

// === 유틸리티 ===
app.post('/api/validate-cron', ...)
app.get('/api/health', ...)
app.get('/api/categories', ...)

// === SSE ===
app.get('/api/tasks/events', ...)  // 실시간 이벤트 스트림
```

## 초기화 순서

```javascript
// 1. 로그 디렉토리 생성
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// 2. 히스토리 로드
jobHistory = loadHistory();

// 3. Express 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 4. API 라우트 등록 (위 참조)

// 5. 작업 초기화 및 서버 시작
initializeJobs();
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
```
