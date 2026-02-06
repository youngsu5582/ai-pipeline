# 아키텍처

AI Pipeline Dashboard의 시스템 구조와 컴포넌트 관계를 설명합니다.

## 시스템 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                        Dashboard                                 │
│  ┌──────────────────┐   ┌──────────────────┐                   │
│  │   Express 서버    │   │   Electron App   │                   │
│  │   (server.js)    │◄──│   (main.js)      │                   │
│  │   - REST API     │   │   - 트레이 앱     │                   │
│  │   - 크론 스케줄링 │   │   - 팝업 윈도우   │                   │
│  │   - 작업 실행     │   │   - 빠른 입력     │                   │
│  └────────┬─────────┘   └────────┬─────────┘                   │
│           │                      │                              │
│           ▼                      ▼                              │
│  ┌──────────────────────────────────────────┐                  │
│  │              jobs.json                    │                  │
│  │  (작업 정의, 스케줄, 옵션, 의존성)        │                  │
│  └──────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Python Scripts  │    │  Claude Code CLI │    │  Obsidian Vault  │
│  (../scripts/)   │    │  (--print)       │    │  (Daily Note)    │
└──────────────────┘    └──────────────────┘    └──────────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Slack (Webhook 알림)                         │
└─────────────────────────────────────────────────────────────────┘
```

## 핵심 컴포넌트

### 1. Express 서버 (server.js)

메인 백엔드 서버로 다음 기능을 제공합니다:

#### 스케줄링 시스템
```javascript
// node-cron으로 작업 스케줄링
scheduledJobs[job.id] = cron.schedule(job.schedule, () => {
  executeJob(job, 'scheduled', defaultOptions);
});
```

#### 작업 실행 엔진
```javascript
// child_process.spawn으로 Python 스크립트 실행
const child = spawn('/bin/zsh', ['-c', command], {
  env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
});
```

#### 주요 기능
| 기능 | 설명 |
|------|------|
| 작업 관리 | CRUD, 활성화/비활성화, 복제 |
| 실행 제어 | 타임아웃, 재시도, 백오프 전략 |
| 파이프라인 | 작업 완료 시 다음 작업 트리거 |
| Auto-fix | 패키지 누락 자동 감지 및 설치 |
| SSE | 실시간 작업 진행 상황 전송 |

### 2. Electron 앱 (electron/)

데스크톱 앱으로 추가 기능 제공:

```
electron/
├── main.js              # Electron 메인 프로세스
├── preload.js           # 컨텍스트 브릿지
├── tray.js              # 시스템 트레이 메뉴
├── windows/
│   ├── quick-input.js   # 빠른 입력 윈도우
│   └── popup-window.js  # 인터랙티브 팝업
└── services/
    ├── claude-code.js        # Claude CLI 연동
    ├── obsidian-writer.js    # Daily Note 저장
    ├── session-collector.js  # Claude 세션 수집
    └── interactive-job-runner.js  # 인터랙티브 작업 실행
```

#### 인터랙티브 작업 흐름
```
1. InteractiveJobRunner가 스케줄에 따라 작업 실행
2. PopupWindow로 사용자 입력 수집
3. ClaudeCode로 입력 내용 가공
4. ObsidianWriter로 Daily Note에 저장
```

### 3. 프론트엔드 (public/)

```
public/
├── index.html         # 메인 대시보드
│   - 작업 카드/그래프 뷰
│   - 실행 이력
│   - 통계 차트
│   - 설정 관리
├── quick-input.html   # 빠른 메모 입력
└── popup/
    ├── popup.html     # 인터랙티브 팝업
    └── popup.js
```

#### 뷰 모드
| 모드 | 라이브러리 | 용도 |
|------|-----------|------|
| 카드 뷰 | Tailwind CSS | 작업 목록 카드 형태 |
| 그래프 뷰 | vis-network | 의존성 그래프 시각화 |
| 통계 | Chart.js | 성공률, 트렌드 차트 |

## 데이터 흐름

### 작업 실행 흐름

```
1. 스케줄 트리거 (node-cron) 또는 수동 실행 (API)
       │
       ▼
2. executeJob() - 옵션으로 명령어 빌드
       │
       ▼
3. spawn() - Python 스크립트 실행
       │
       ├── stdout/stderr 캡처
       │
       ▼
4. 실행 완료
       │
       ├── 히스토리 저장 (logs/history.json)
       ├── Slack 알림 (실패/성공)
       └── 파이프라인 체이닝 (triggerNextJobs)
```

### 인터랙티브 작업 흐름 (Electron)

```
1. InteractiveJobRunner.executeJob()
       │
       ▼
2. 데이터 수집 (오늘 기록, Claude 세션)
       │
       ▼
3. PopupWindow.show() - 팝업 표시
       │
       ▼
4. 사용자 입력 대기
       │
       ├── 입력 완료 → ClaudeCode.ask() 가공
       │                      │
       │                      ▼
       │              ObsidianWriter.appendToSection()
       │
       └── 스킵 → 리마인더 대기 (선택)
```

## 상태 관리

### 메모리 상태

```javascript
// server.js
let scheduledJobs = {};   // 스케줄된 크론 작업 { jobId: CronTask }
let jobHistory = [];      // 실행 이력 (최근 100개)
let runningJobs = {};     // 현재 실행 중인 작업 { jobId: { stdout, stderr, ... } }
let taskQueue = new Map(); // 비동기 작업 큐
let sseClients = new Map(); // SSE 연결 클라이언트
```

### 영속 저장소

| 저장소 | 위치 | 내용 |
|--------|------|------|
| jobs.json | dashboard/ | 작업 정의, 의존성, 설정 |
| history.json | dashboard/logs/ | 실행 이력 (최근 100개) |
| electron-store | ~/.config/memobot/ | 알림 설정, 단축키, 오늘 기록 |
| settings.yaml | config/ | 전역 설정 (vault 경로 등) |

## 통신 방식

### REST API
- Express 서버가 제공하는 HTTP API
- 프론트엔드 및 외부 클라이언트용

### Server-Sent Events (SSE)
```javascript
// 실시간 작업 진행 상황 전송
app.get('/api/tasks/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  // ...
});
```

### IPC (Electron)
```javascript
// 메인 ↔ 렌더러 프로세스 통신
ipcMain.handle('save-entry', async (event, { text }) => {
  // ...
});
```

## 확장 포인트

### 새 작업 유형 추가
1. `jobs.json`에 작업 정의 추가
2. 필요시 `options` 스키마 정의
3. Python 스크립트 또는 명령어 구현

### 새 서비스 연동
1. `electron/services/`에 서비스 클래스 추가
2. `main.js`에서 초기화
3. IPC 핸들러 등록

### 알림 채널 추가
1. `sendSlackNotification` 함수 참고
2. 새 알림 함수 구현
3. 작업 실행 완료 시 호출
