# 코드 개선 및 고도화 로드맵

현재 코드베이스 분석을 바탕으로 한 개선 방안입니다.

## 1. 성능 최적화

### 1.1 서버 성능

#### 현재 문제
```javascript
// server.js - 매번 파일 읽기
function loadJobs() {
  const data = fs.readFileSync(JOBS_FILE, 'utf8');  // 동기 I/O, 블로킹
  return JSON.parse(data);
}
```

#### 개선안: 메모리 캐싱 + 파일 감시
```javascript
// 개선: 메모리 캐싱
let jobsCache = null;
let jobsCacheTime = 0;
const CACHE_TTL = 5000;  // 5초

function loadJobs() {
  const now = Date.now();
  if (jobsCache && (now - jobsCacheTime) < CACHE_TTL) {
    return jobsCache;
  }

  const data = fs.readFileSync(JOBS_FILE, 'utf8');
  jobsCache = JSON.parse(data);
  jobsCacheTime = now;
  return jobsCache;
}

// 파일 변경 감시로 캐시 무효화
fs.watch(JOBS_FILE, () => {
  jobsCache = null;
  console.log('[Cache] jobs.json 캐시 무효화');
});
```

#### 개선안: 비동기 I/O
```javascript
// 비동기 버전
async function loadJobsAsync() {
  const data = await fs.promises.readFile(JOBS_FILE, 'utf8');
  return JSON.parse(data);
}
```

### 1.2 히스토리 성능

#### 현재 문제
```javascript
// 매번 전체 배열 저장
function saveHistory() {
  const trimmed = jobHistory.slice(-100);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}
```

#### 개선안: 증분 저장 + 압축
```javascript
// 개선: 증분 저장 (append-only)
function appendHistory(entry) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(historyFile, line);
}

// 읽기: 라인 단위 파싱
function loadHistory() {
  const content = fs.readFileSync(historyFile, 'utf8');
  return content.trim().split('\n')
    .filter(line => line)
    .map(line => JSON.parse(line))
    .slice(-100);
}

// 주기적 압축 (오래된 로그 정리)
function compactHistory() {
  const history = loadHistory();
  const recent = history.slice(-100);
  fs.writeFileSync(historyFile, recent.map(h => JSON.stringify(h)).join('\n'));
}
```

### 1.3 프론트엔드 성능

#### 현재 문제
```javascript
// 전체 재렌더링
function renderJobs() {
  grid.innerHTML = jobs.map(job => `...`).join('');  // DOM 전체 교체
}
```

#### 개선안: Virtual DOM / 차분 업데이트
```javascript
// 개선: 변경된 부분만 업데이트
function updateJobCard(jobId) {
  const job = jobs.find(j => j.id === jobId);
  const card = document.querySelector(`[data-job-id="${jobId}"]`);
  if (card && job) {
    // 상태만 업데이트
    const statusDot = card.querySelector('.status-dot');
    statusDot.className = `status-dot ${getStatusClass(job)}`;
  }
}

// 또는 Preact/lit-html 도입
import { html, render } from 'lit-html';

function renderJobs() {
  render(html`
    ${jobs.map(job => html`
      <div class="job-card" data-job-id="${job.id}">
        ...
      </div>
    `)}
  `, grid);
}
```

---

## 2. 코드 구조 개선

### 2.1 모듈 분리

#### 현재: 단일 server.js (1800줄)

#### 개선안: 기능별 모듈 분리
```
server/
├── index.js           # 진입점
├── app.js             # Express 설정
├── config.js          # 설정 로드
├── routes/
│   ├── jobs.js        # /api/jobs/*
│   ├── history.js     # /api/history
│   ├── stats.js       # /api/stats/*
│   ├── settings.js    # /api/settings
│   └── sse.js         # /api/tasks/events
├── services/
│   ├── scheduler.js   # 크론 스케줄링
│   ├── executor.js    # 작업 실행
│   ├── autofix.js     # Auto-fix 로직
│   ├── notifier.js    # Slack 알림
│   └── history.js     # 히스토리 관리
├── utils/
│   ├── command.js     # 명령어 빌드
│   └── logger.js      # 로깅
└── types/
    └── index.d.ts     # TypeScript 타입 정의
```

#### routes/jobs.js 예시
```javascript
const express = require('express');
const router = express.Router();
const { loadJobs, saveJobs } = require('../services/jobs');
const { executeJob } = require('../services/executor');

router.get('/', (req, res) => {
  const data = loadJobs();
  res.json(data);
});

router.post('/:id/run', async (req, res) => {
  try {
    const result = await executeJob(req.params.id, req.body.options);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 2.2 TypeScript 도입

```typescript
// types/index.ts
interface Job {
  id: string;
  name: string;
  command: string;
  schedule?: string;
  enabled?: boolean;
  category?: string;
  tags?: string[];
  options?: JobOption[];
  execution?: ExecutionConfig;
}

interface JobOption {
  flag?: string;
  arg?: string;
  label: string;
  type: 'boolean' | 'string' | 'array' | 'select';
  default?: any;
  system?: boolean;
}

interface ExecutionConfig {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  backoff?: 'fixed' | 'linear' | 'exponential';
}

// services/executor.ts
export async function executeJob(
  job: Job,
  trigger: 'manual' | 'scheduled' | 'chained',
  options: Record<string, any>
): Promise<ExecutionResult> {
  // 타입 안전한 코드
}
```

### 2.3 에러 처리 강화

#### 현재 문제
```javascript
try {
  // ...
} catch (error) {
  console.error('Error:', error);  // 불충분한 에러 처리
  reject(error);
}
```

#### 개선안: 커스텀 에러 클래스 + 중앙 에러 핸들링
```javascript
// errors.js
class JobExecutionError extends Error {
  constructor(jobId, message, cause) {
    super(message);
    this.name = 'JobExecutionError';
    this.jobId = jobId;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
  }
}

class TimeoutError extends JobExecutionError {
  constructor(jobId, timeout) {
    super(jobId, `Timeout after ${timeout}ms`);
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }
}

class AutoFixError extends JobExecutionError {
  constructor(jobId, fixCommand, cause) {
    super(jobId, `AutoFix failed: ${fixCommand}`, cause);
    this.name = 'AutoFixError';
    this.fixCommand = fixCommand;
  }
}

// 중앙 에러 핸들러
app.use((err, req, res, next) => {
  console.error(`[${err.name}] ${err.message}`, {
    jobId: err.jobId,
    stack: err.stack
  });

  res.status(err.status || 500).json({
    error: err.message,
    code: err.name,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});
```

---

## 3. 새 기능 추가

### 3.1 작업 의존성 그래프 자동 실행

```javascript
// 현재: 수동 edge 정의 필요
// 개선: 작업 간 의존성 자동 감지 + 병렬 실행

interface JobWithDependencies extends Job {
  dependsOn?: string[];  // 선행 작업 ID 배열
  parallel?: boolean;    // 병렬 실행 가능 여부
}

// 의존성 기반 실행
async function executeWithDependencies(jobId: string) {
  const job = getJob(jobId);
  const deps = job.dependsOn || [];

  // 선행 작업들 병렬 실행
  await Promise.all(deps.map(depId => executeWithDependencies(depId)));

  // 현재 작업 실행
  return executeJob(job);
}

// 또는 작업 그룹 병렬 실행
async function executeParallel(jobIds: string[]) {
  const results = await Promise.allSettled(
    jobIds.map(id => executeJob(getJob(id)))
  );

  return results.map((r, i) => ({
    jobId: jobIds[i],
    status: r.status,
    result: r.status === 'fulfilled' ? r.value : null,
    error: r.status === 'rejected' ? r.reason : null
  }));
}
```

### 3.2 작업 템플릿 시스템

```javascript
// 자주 사용하는 작업 패턴 템플릿화
const templates = {
  'python-script': {
    command: '{{venv}}/bin/python {{scriptPath}}',
    options: [
      { flag: '--yes', label: '자동 승인', type: 'boolean', default: true },
      { flag: '--slack', label: 'Slack 알림', type: 'boolean', system: true }
    ],
    execution: { timeout: 300000, maxRetries: 1 }
  },
  'daily-sync': {
    extends: 'python-script',
    schedule: '0 23 * * *',
    category: 'sync',
    options: [
      { flag: '--today', label: '오늘', type: 'boolean' },
      { arg: 'date', label: '날짜', type: 'string', placeholder: 'YYYY-MM-DD' }
    ]
  }
};

// 템플릿에서 작업 생성
function createJobFromTemplate(templateId, overrides) {
  const template = resolveTemplate(templateId);
  return deepMerge(template, overrides);
}
```

### 3.3 웹훅 트리거

```javascript
// 외부에서 작업 트리거 가능한 웹훅
app.post('/api/webhooks/:jobId', authenticateWebhook, async (req, res) => {
  const { jobId } = req.params;
  const { options, metadata } = req.body;

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const result = await executeJob(job, 'webhook', options);
  res.json({ success: true, ...result });
});

// 웹훅 인증
function authenticateWebhook(req, res, next) {
  const token = req.headers['x-webhook-token'];
  const expectedToken = process.env.WEBHOOK_TOKEN || settings.webhookToken;

  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }
  next();
}
```

### 3.4 실시간 로그 스트리밍 개선

```javascript
// 현재: 폴링 기반
// 개선: WebSocket + 버퍼링

const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

const logStreams = new Map();  // jobId -> Set<WebSocket>

wss.on('connection', (ws, req) => {
  const jobId = new URL(req.url, 'http://localhost').searchParams.get('jobId');

  if (!logStreams.has(jobId)) {
    logStreams.set(jobId, new Set());
  }
  logStreams.get(jobId).add(ws);

  ws.on('close', () => {
    logStreams.get(jobId)?.delete(ws);
  });
});

// 로그 브로드캐스트
function broadcastLog(jobId, data) {
  const clients = logStreams.get(jobId);
  if (!clients) return;

  const message = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// 작업 실행 시 스트리밍
child.stdout.on('data', (data) => {
  const text = data.toString();
  logEntry.stdout += text;
  broadcastLog(job.id, { type: 'stdout', data: text, timestamp: Date.now() });
});
```

### 3.5 작업 상태 대시보드 위젯

```javascript
// 시스템 상태 종합 API
app.get('/api/dashboard/status', (req, res) => {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // 오늘 통계
  const todayHistory = jobHistory.filter(h =>
    h.startTime.startsWith(today)
  );

  // 다음 실행 예정 작업
  const nextJobs = Object.entries(scheduledJobs)
    .map(([id, task]) => ({
      id,
      name: getJob(id)?.name,
      nextRun: getNextCronDate(getJob(id)?.schedule)
    }))
    .filter(j => j.nextRun)
    .sort((a, b) => a.nextRun - b.nextRun)
    .slice(0, 5);

  // 실행 중인 작업
  const running = Object.entries(runningJobs).map(([id, info]) => ({
    id,
    name: getJob(id)?.name,
    elapsed: Date.now() - info.startTime.getTime(),
    command: info.command
  }));

  // 최근 실패
  const recentFailures = todayHistory
    .filter(h => h.status === 'failed')
    .slice(-5);

  res.json({
    timestamp: now.toISOString(),
    summary: {
      total: todayHistory.length,
      success: todayHistory.filter(h => h.status === 'success').length,
      failed: todayHistory.filter(h => h.status === 'failed').length,
      running: running.length
    },
    running,
    nextJobs,
    recentFailures
  });
});
```

---

## 4. 안정성 강화

### 4.1 Graceful Shutdown

```javascript
// 현재: 없음
// 개선: 실행 중인 작업 완료 대기

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);
  isShuttingDown = true;

  // 새 작업 수락 중지
  Object.values(scheduledJobs).forEach(task => task.stop());

  // 실행 중인 작업 완료 대기 (최대 30초)
  const timeout = 30000;
  const startTime = Date.now();

  while (Object.keys(runningJobs).length > 0) {
    if (Date.now() - startTime > timeout) {
      console.log('[Shutdown] Timeout waiting for jobs, forcing shutdown');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`[Shutdown] Waiting for ${Object.keys(runningJobs).length} jobs...`);
  }

  // 히스토리 저장
  saveHistory();

  console.log('[Shutdown] Complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### 4.2 작업 격리 (Sandbox)

```javascript
// 위험한 명령어 필터링
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  />\s*\/dev\/sd/,
  /mkfs\./,
  /dd\s+if=/
];

function validateCommand(command) {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Dangerous command pattern detected: ${pattern}`);
    }
  }
}

// 리소스 제한
function executeWithLimits(command, limits = {}) {
  const { maxMemory = '512M', maxCpu = 1, maxTime = 300000 } = limits;

  // Linux: cgroups 사용
  // macOS: ulimit 사용
  const limitedCommand = process.platform === 'linux'
    ? `systemd-run --scope -p MemoryMax=${maxMemory} ${command}`
    : command;  // macOS는 제한적

  return spawn('/bin/zsh', ['-c', limitedCommand], {
    timeout: maxTime
  });
}
```

### 4.3 상태 복구

```javascript
// 서버 재시작 시 실행 중이던 작업 복구
function recoverState() {
  const stateFile = path.join(LOGS_DIR, 'state.json');

  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      // 실행 중이던 작업 상태 업데이트
      for (const [jobId, info] of Object.entries(state.running || {})) {
        const entry = jobHistory.find(h => h.id === info.logId);
        if (entry && entry.status === 'running') {
          entry.status = 'interrupted';
          entry.error = 'Server restart during execution';
          entry.endTime = new Date().toISOString();
        }
      }

      saveHistory();
    }
  } catch (error) {
    console.error('[Recovery] Failed:', error);
  }
}

// 주기적 상태 저장
setInterval(() => {
  const state = {
    running: runningJobs,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(LOGS_DIR, 'state.json'),
    JSON.stringify(state, null, 2)
  );
}, 10000);
```

---

## 5. 개발 경험 개선

### 5.1 핫 리로드 강화

```javascript
// nodemon.json
{
  "watch": ["server.js", "jobs.json"],
  "ext": "js,json",
  "ignore": ["logs/*", "node_modules/*"],
  "exec": "node server.js"
}

// jobs.json 변경 시 스케줄 자동 리로드
fs.watch(JOBS_FILE, debounce(() => {
  console.log('[HotReload] jobs.json changed, reloading schedules...');
  initializeJobs();
}, 1000));
```

### 5.2 개발 대시보드

```javascript
// 개발 모드 전용 엔드포인트
if (process.env.NODE_ENV === 'development') {
  // 메모리 상태
  app.get('/api/dev/memory', (req, res) => {
    const used = process.memoryUsage();
    res.json({
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(used.external / 1024 / 1024)}MB`,
      rss: `${Math.round(used.rss / 1024 / 1024)}MB`
    });
  });

  // 캐시 상태
  app.get('/api/dev/cache', (req, res) => {
    res.json({
      jobsCache: !!jobsCache,
      jobsCacheAge: jobsCacheTime ? Date.now() - jobsCacheTime : null,
      scheduledJobs: Object.keys(scheduledJobs).length,
      runningJobs: Object.keys(runningJobs).length,
      sseClients: sseClients.size
    });
  });

  // 캐시 클리어
  app.post('/api/dev/cache/clear', (req, res) => {
    jobsCache = null;
    res.json({ success: true });
  });
}
```

### 5.3 CLI 도구

```javascript
#!/usr/bin/env node
// cli.js - 명령줄 도구

const { program } = require('commander');

program
  .name('aip')
  .description('AI Pipeline Dashboard CLI')
  .version('2.0.0');

program
  .command('run <jobId>')
  .description('Run a job immediately')
  .option('-o, --options <json>', 'Job options as JSON')
  .action(async (jobId, opts) => {
    const options = opts.options ? JSON.parse(opts.options) : {};
    const res = await fetch(`http://localhost:3030/api/jobs/${jobId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options })
    });
    console.log(await res.json());
  });

program
  .command('list')
  .description('List all jobs')
  .option('-c, --category <category>', 'Filter by category')
  .action(async (opts) => {
    const res = await fetch('http://localhost:3030/api/jobs');
    const data = await res.json();
    let jobs = data.jobs;

    if (opts.category) {
      jobs = jobs.filter(j => j.category === opts.category);
    }

    console.table(jobs.map(j => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule || '-',
      enabled: j.enabled ? '✓' : '✗'
    })));
  });

program
  .command('status')
  .description('Show dashboard status')
  .action(async () => {
    const res = await fetch('http://localhost:3030/api/health');
    console.log(await res.json());
  });

program.parse();
```

---

## 6. 우선순위별 구현 로드맵

### Phase 1: 즉시 개선 (1-2일)
- [ ] jobs.json 캐싱
- [ ] Graceful shutdown
- [ ] 커스텀 에러 클래스

### Phase 2: 단기 개선 (1주)
- [ ] 모듈 분리 (routes, services)
- [ ] 히스토리 증분 저장
- [ ] WebSocket 로그 스트리밍

### Phase 3: 중기 개선 (2-3주)
- [ ] TypeScript 마이그레이션
- [ ] 작업 템플릿 시스템
- [ ] 웹훅 트리거

### Phase 4: 장기 고도화 (1개월+)
- [ ] 작업 샌드박싱
- [ ] 분산 실행 (여러 워커)
- [ ] 모니터링 통합 (Prometheus/Grafana)
