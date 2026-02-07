# 데이터 스키마

시스템에서 사용되는 모든 데이터 구조의 상세 스키마입니다.

## jobs.json 전체 구조

```typescript
interface JobsFile {
  jobs: Job[];
  edges: Edge[];
  categories: Record<string, Category>;
  settings: Settings;
}
```

## Job 스키마

```typescript
interface Job {
  // === 필수 필드 ===
  id: string;                    // 고유 ID (예: "sync-github")
  name: string;                  // 표시 이름
  command: string;               // 실행 명령어 (전체 경로)

  // === 기본 설정 ===
  description?: string;          // 작업 설명
  schedule?: string;             // 크론 표현식 (빈 값 = 수동 실행만)
  enabled?: boolean;             // 스케줄 활성화 (기본: true)
  category?: string;             // 카테고리 ID
  tags?: string[];               // 태그 배열

  // === 옵션 정의 ===
  options?: Option[];            // 실행 옵션 배열

  // === 실행 제어 ===
  execution?: ExecutionConfig;   // 타임아웃, 재시도 설정

  // === UI 관련 ===
  position?: Position;           // 그래프 뷰 위치
  notes?: string;                // 메모

  // === 인터랙티브 작업 전용 (Electron) ===
  interactive?: boolean;         // 인터랙티브 작업 여부
  popup?: PopupConfig;           // 팝업 설정
  processing?: ProcessingConfig; // Claude 처리 설정
  output?: OutputConfig;         // 출력 설정
  collect?: CollectConfig;       // 데이터 수집 설정
}
```

### Option 스키마

```typescript
interface Option {
  // === 식별 ===
  flag?: string;          // 플래그 (예: "--yes", "--date")
  arg?: string;           // 인자 이름 (예: "date", "repos")

  // === 표시 ===
  label: string;          // UI 레이블
  description?: string;   // 설명

  // === 타입 ===
  type: 'boolean' | 'string' | 'array' | 'select';

  // === 값 ===
  default?: any;          // 기본값
  placeholder?: string;   // 입력 힌트
  choices?: string[];     // select 타입의 선택지

  // === 특수 ===
  system?: boolean;       // true면 명령어에 추가 안 함 (서버 처리용)
}
```

**Option 예시:**

```json
// boolean 타입
{
  "flag": "--yes",
  "label": "자동 승인",
  "description": "확인 없이 실행",
  "type": "boolean",
  "default": true
}

// string 타입
{
  "flag": "--date",
  "arg": "date",
  "label": "날짜",
  "type": "string",
  "placeholder": "YYYY-MM-DD",
  "default": ""
}

// array 타입
{
  "flag": "--repos",
  "arg": "repos",
  "label": "저장소",
  "type": "array",
  "placeholder": "경로 입력 후 Enter",
  "default": []
}

// select 타입
{
  "flag": "--state",
  "arg": "state",
  "label": "상태",
  "type": "select",
  "choices": ["all", "open", "merged", "closed"],
  "default": "all"
}

// system 옵션 (Slack 알림 등)
{
  "flag": "--slack",
  "label": "Slack 알림",
  "type": "boolean",
  "default": false,
  "system": true
}
```

### ExecutionConfig 스키마

```typescript
interface ExecutionConfig {
  timeout?: number;       // 타임아웃 ms (기본: 300000 = 5분)
  maxRetries?: number;    // 최대 재시도 (기본: 0)
  retryDelay?: number;    // 재시도 대기 ms (기본: 5000)
  backoff?: 'fixed' | 'linear' | 'exponential';  // 백오프 전략
}
```

**백오프 계산:**
- `fixed`: `retryDelay`
- `linear`: `retryDelay * attempt`
- `exponential`: `retryDelay * 2^(attempt-1)`

### Position 스키마

```typescript
interface Position {
  x: number;  // 그래프 뷰 X 좌표
  y: number;  // 그래프 뷰 Y 좌표
}
```

### 인터랙티브 작업 스키마 (Electron 전용)

```typescript
interface PopupConfig {
  character?: 'asking' | 'happy' | 'reminder';  // 캐릭터 이미지
  prompts?: string[];           // 랜덤 표시될 질문들
  placeholder?: string;         // 입력창 플레이스홀더
  inputType?: 'textarea' | 'quick-buttons' | 'review';
  reminderMinutes?: number;     // 리마인더 대기 시간 (분)
  maxReminders?: number;        // 최대 리마인더 횟수
  reminderPrompts?: string[];   // 리마인더 시 표시할 문구
  showCollectedData?: boolean;  // 수집 데이터 표시 여부
  allowEmpty?: boolean;         // 빈 입력 허용
}

interface ProcessingConfig {
  claude?: {
    enabled: boolean;    // Claude 처리 활성화
    prompt: string;      // 시스템 프롬프트
  };
}

interface OutputConfig {
  target: 'obsidian-daily';     // 저장 대상
  section?: string;             // Daily Note 섹션 헤더
  format?: string;              // 포맷 템플릿 ({time}, {content})
  sections?: SectionConfig[];   // 여러 섹션 저장 시
}

interface SectionConfig {
  name: string;                 // 섹션 헤더 (예: "## 오늘 한 일")
  type: 'summary' | 'sessions'; // 내용 타입
}

interface CollectConfig {
  todayEntries?: boolean;       // 오늘 기록 수집
  claudeSessions?: boolean;     // Claude 세션 수집
}
```

## Edge 스키마

```typescript
interface Edge {
  id: string;           // 고유 ID (예: "edge-1234567890")
  from: string;         // 출발 작업 ID
  to: string;           // 도착 작업 ID
  label?: string;       // 연결선 레이블
  trigger?: boolean;    // true: 자동 트리거, false: 시각적 연결만
  onSuccess?: boolean;  // true: 성공 시에만 트리거
}
```

**Edge 동작:**
| trigger | onSuccess | 동작 |
|---------|-----------|------|
| false | - | 시각적 연결만 (그래프에서 보기 용) |
| true | true | from 성공 시 to 자동 실행 |
| true | false | from 완료 시 (성공/실패 무관) to 자동 실행 |

## Category 스키마

```typescript
interface Category {
  name: string;   // 표시 이름
  color: string;  // HEX 색상 코드
}
```

**기본 카테고리:**
```json
{
  "sync": { "name": "동기화", "color": "#3b82f6" },
  "daily": { "name": "Daily Note", "color": "#f59e0b" },
  "review": { "name": "회고", "color": "#ec4899" },
  "monitor": { "name": "모니터링", "color": "#ef4444" },
  "maintenance": { "name": "정리", "color": "#14b8a6" },
  "interactive": { "name": "인터랙티브", "color": "#8b5cf6" },
  "vacuum": { "name": "문서 정리", "color": "#10b981" },
  "custom": { "name": "사용자 정의", "color": "#6b7280" }
}
```

## Settings 스키마

```typescript
interface Settings {
  // Slack 설정
  slackWebhookUrl?: string;
  slackEnabled?: boolean;
  slack?: {
    webhookEnvVar?: string;
    defaultChannel?: string;
  };

  // 대시보드 설정
  dashboardUrl?: string;      // 알림 링크용 (기본: http://localhost:3030)
  refreshInterval?: number;   // UI 자동 새로고침 (초)

  // 실행 기본값
  defaultTimeout?: number;    // 기본 타임아웃 (분)
  defaultRetry?: number;      // 기본 재시도 횟수

  // Auto-fix 규칙 (선택)
  autoFixRules?: AutoFixRule[];
}

interface AutoFixRule {
  id: string;
  name: string;
  pattern: RegExp;            // 에러 패턴
  extractPackage?: Function;  // 패키지명 추출 함수
  fix: string | Function;     // 복구 명령어
  enabled: boolean;
}
```

## History Entry 스키마

`logs/history.json`에 저장되는 실행 이력:

```typescript
interface HistoryEntry {
  id: number;              // 타임스탬프 기반 ID
  jobId: string;           // 작업 ID
  jobName: string;         // 작업 이름
  trigger: string;         // 'manual' | 'scheduled' | 'chained' | 'retry(N)' | 'auto-fix'
  startTime: string;       // ISO 8601 형식
  endTime?: string;        // ISO 8601 형식
  duration?: number;       // 실행 시간 (ms)
  status: 'running' | 'success' | 'failed';
  stdout: string;          // 표준 출력
  stderr: string;          // 표준 에러
  error?: string;          // 에러 메시지 (실패 시)
  command: string;         // 실행된 명령어
  options: object;         // 사용된 옵션
  retryAttempt: number;    // 재시도 횟수
  autoFix?: {              // Auto-fix 정보 (적용된 경우)
    rule: string;
    command: string;
  };
}
```

**예시:**
```json
{
  "id": 1707184800000,
  "jobId": "sync-github",
  "jobName": "GitHub 동기화",
  "trigger": "scheduled",
  "startTime": "2026-02-06T14:20:00.000Z",
  "endTime": "2026-02-06T14:20:05.123Z",
  "duration": 5123,
  "status": "success",
  "stdout": "Synced 5 commits to Daily Note\n",
  "stderr": "",
  "command": "/Users/user/.venv/bin/python /Users/user/scripts/sync_github.py --yes",
  "options": { "--yes": true, "--slack": false },
  "retryAttempt": 0
}
```

## Electron Store 스키마

`~/.config/memobot/electron-settings.json`:

```typescript
interface ElectronStore {
  // 알림 설정
  notificationSettings: {
    enabled: boolean;         // 알림 활성화
    startHour: number;        // 시작 시간 (0-23)
    endHour: number;          // 종료 시간 (0-23)
    intervalMinutes: number;  // 알림 간격 (분)
    reminderAfterMinutes: number;  // 리마인더 대기 (분)
  };

  // 단축키
  shortcuts: {
    quickInput: string;       // 빠른 입력 (기본: "CommandOrControl+Shift+Space")
  };

  // 날짜별 엔트리
  entries: {
    [date: string]: Entry[];  // "2026-02-06": [...]
  };
}

interface Entry {
  time: string;      // ISO 8601
  text: string;      // 저장된 텍스트
  raw?: string;      // 원본 입력
  jobId?: string;    // 생성한 작업 ID
}
```

## Claude Session Index 스키마

`~/.claude/projects/{project}/sessions-index.json`:

```typescript
interface SessionIndex {
  entries: SessionEntry[];
}

interface SessionEntry {
  sessionId: string;       // 세션 ID
  summary?: string;        // 세션 요약
  firstPrompt?: string;    // 첫 프롬프트
  messageCount?: number;   // 메시지 수
  created: string;         // 생성 시간
  modified: string;        // 수정 시간
  gitBranch?: string;      // Git 브랜치
  projectPath?: string;    // 프로젝트 경로
}
```

## config/settings.yaml 스키마

```yaml
# Obsidian Vault 설정
vault:
  path: ~/Documents/Obsidian/MyVault  # ~ 확장됨
  daily_folder: DAILY                  # Daily Note 폴더

# GitHub 설정
github:
  repos:                               # 동기화할 저장소 경로
    - /path/to/repo1
    - /path/to/repo2

# JIRA 설정
jira:
  server: https://your-company.atlassian.net
  project: PROJECT_KEY
  username: email@example.com
  # token은 환경변수에서

# Slack 설정
slack:
  webhook_url: https://hooks.slack.com/...
  channel: "#notifications"

# CloudWatch 설정
cloudwatch:
  log_groups:
    - /aws/lambda/function-name
  patterns:
    - ERROR
    - Exception
  profile: default
  region: ap-northeast-2
```

## API 응답 스키마

### 페이지네이션 응답

```typescript
interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
```

### 통계 응답

```typescript
// GET /api/stats/summary
interface StatsSummary {
  period: string;           // "7 days"
  total: number;
  success: number;
  failed: number;
  running: number;
  successRate: number;      // 0-100
  avgDuration: number;      // ms
  avgDurationFormatted: string;  // "5.0s"
}

// GET /api/stats/jobs
interface JobStats {
  jobId: string;
  jobName: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  avgDuration: number;
  lastRun: string;          // ISO 8601
}

// GET /api/stats/trend
interface TrendData {
  date: string;             // "2026-02-06"
  success: number;
  failed: number;
  total: number;
}

// GET /api/stats/hourly
interface HourlyData {
  hour: number;             // 0-23
  count: number;
}
```

## session-summaries.json 스키마

`data/session-summaries.json` — Claude가 생성한 세션 요약 캐시.

```typescript
interface SessionSummary {
  id: string;                // "ss-{sessionId}"
  sessionId: string;         // UUID
  projectPath: string;       // "-Users-iyeongsu-ai-pipeline-dashboard"
  project: string;           // "dashboard"
  summary: string;           // 마크다운 요약 본문
  createdAt: string;         // ISO 8601
}

// 파일 구조: SessionSummary[]
```

## daily-reports.json 스키마

`data/daily-reports.json` — 일일 보고서/종합 보고서/하루 마무리 캐시.

```typescript
interface DailyReport {
  id: string;                // "dr-{date}-{type}"
  date: string;              // "2026-02-07"
  type: 'daily-report' | 'full-daily-report' | 'day-wrapup';
  report: string;            // 마크다운 보고서 본문
  sessionsCount?: number;
  jobsCount?: number;
  memosCount?: number;
  hasGithub?: boolean;       // day-wrapup only
  hasReflection?: boolean;   // day-wrapup only
  createdAt: string;         // ISO 8601
}

// 파일 구조: DailyReport[]
```
