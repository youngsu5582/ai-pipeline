# Phase 5: 플랫폼 확장

> 우선순위: P3-P4 | 예상 기간: 장기 (4주+)
> 의존성: Phase 1-4의 주요 기능 안정화 후

## 개요

현재 단일 머신 Express + Electron 앱을 확장 가능한 플랫폼으로 발전. 모바일 접근, 위젯 시스템, 서버 아키텍처 개선.

---

## 5.1 반응형 모바일 UI

### 현재 상태
- Tailwind CSS 사용 중 (모바일 breakpoint 일부 적용)
- 그러나 주요 UI가 데스크톱 전용 (모달 크기, 그래프 뷰 등)

### 개선 항목

**1. 네비게이션**
```css
/* 모바일: 하단 탭 바 */
@media (max-width: 768px) {
  .main-tabs {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-around;
    background: #1f2937;
    border-top: 1px solid #374151;
    padding: 8px 0;
    z-index: 40;
  }
  .main-tabs button {
    flex-direction: column;
    font-size: 0.7rem;
    gap: 2px;
  }
  main { padding-bottom: 70px; }
}
```

**2. 카드 레이아웃**
```css
@media (max-width: 768px) {
  .grid-cols-3 { grid-template-columns: 1fr; }
  .grid-cols-4 { grid-template-columns: repeat(2, 1fr); }
}
```

**3. 모달 → 풀스크린**
```css
@media (max-width: 768px) {
  .modal > div {
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    border-radius: 0;
  }
}
```

**4. 터치 인터랙션**
- 스와이프로 탭 전환
- 풀다운 새로고침 (pull-to-refresh)
- 길게 누르기 → 컨텍스트 메뉴

### PWA 지원

```json
// manifest.json
{
  "name": "AI Pipeline Dashboard",
  "short_name": "AI Pipeline",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#111827",
  "theme_color": "#3b82f6",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

```javascript
// Service Worker (기본)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```

---

## 5.2 위젯 시스템

### 개념
홈 대시보드를 커스터마이징 가능한 위젯 그리드로 전환.

### 위젯 타입

| 위젯 | 크기 | 내용 |
|------|------|------|
| `summary-card` | 1x1 | 숫자 + 라벨 (세션수, 작업수 등) |
| `timeline` | 2x2 | 시간순 활동 목록 |
| `quick-memo` | 1x2 | 빠른 메모 입력 |
| `recent-runs` | 1x2 | 최근 실행 목록 |
| `stats-chart` | 2x1 | 미니 차트 (성공률 등) |
| `backlogs` | 1x2 | 미완료 백로그 |
| `morning-plan` | 2x1 | 오늘 계획 요약 |
| `suggestions` | 2x1 | AI 서제스션 |
| `calendar` | 1x2 | 미니 캘린더 |

### 위젯 레이아웃 저장

```json
{
  "widgets": [
    { "id": "w1", "type": "summary-card", "config": { "metric": "sessions" }, "position": { "x": 0, "y": 0, "w": 1, "h": 1 } },
    { "id": "w2", "type": "timeline", "config": {}, "position": { "x": 1, "y": 0, "w": 2, "h": 2 } },
    { "id": "w3", "type": "quick-memo", "config": {}, "position": { "x": 3, "y": 0, "w": 1, "h": 2 } }
  ]
}
```

### 위젯 렌더링 프레임워크

```javascript
class Widget {
  constructor(config) {
    this.config = config;
  }
  async load() { /* 데이터 로드 */ }
  render() { /* HTML 반환 */ }
  onResize() { /* 크기 변경 시 */ }
  destroy() { /* 정리 */ }
}

class SummaryCardWidget extends Widget {
  async load() {
    const res = await fetch(`/api/today/summary`);
    this.data = await res.json();
  }
  render() {
    return `<div class="widget-card">
      <div class="text-3xl font-bold">${this.data[this.config.metric]}</div>
      <div class="text-sm text-gray-400">${this.config.label}</div>
    </div>`;
  }
}
```

### 드래그 & 드롭

CSS Grid + 드래그 이벤트:
```javascript
// 경량 그리드 라이브러리 사용 또는 직접 구현
// 위치 변경 시 서버에 레이아웃 저장
// PUT /api/settings/widget-layout
```

---

## 5.3 서버 아키텍처 개선

### 현재 문제
- `server.js` 단일 파일 3,900+ 줄
- 동기 파일 I/O가 이벤트 루프 블로킹
- JSON 파일 기반 저장소 (스케일 제한)

### 모듈화 계획

```
server.js (진입점, 80줄)
├── routes/
│   ├── jobs.js          (작업 CRUD + 실행)
│   ├── history.js       (이력 조회 + 필터)
│   ├── stats.js         (통계 + 분석)
│   ├── sessions.js      (세션 관리)
│   ├── notes.js         (메모 + 백로그)
│   ├── settings.js      (설정 관리)
│   ├── tasks.js         (비동기 태스크)
│   ├── timeline.js      (통합 타임라인)
│   ├── insights.js      (AI 인사이트)
│   └── webhooks.js      (외부 트리거)
├── services/
│   ├── scheduler.js     (크론 스케줄링)
│   ├── executor.js      (작업 실행 엔진)
│   ├── notifier.js      (알림 전송)
│   ├── autofix.js       (자동 복구)
│   ├── claude.js        (Claude API 연동)
│   └── sse.js           (SSE 관리)
├── stores/
│   ├── jobs-store.js    (jobs.json 캐싱)
│   ├── history-store.js (이력 저장소)
│   ├── memo-store.js    (메모 저장소)
│   └── session-store.js (세션 저장소)
└── utils/
    ├── command.js       (명령어 빌드)
    ├── logger.js        (로깅)
    └── config.js        (설정 로드)
```

### 저장소 추상화 (Store Layer)

```javascript
// stores/base-store.js
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
    this.cacheTTL = 5000; // 5초
    this.cacheTime = 0;
  }

  load() {
    if (this.cache && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }
    this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.cacheTime = Date.now();
    return this.cache;
  }

  save(data) {
    this.cache = data;
    this.cacheTime = Date.now();
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  invalidate() {
    this.cache = null;
  }
}

// 향후 SQLite 전환 시 동일 인터페이스 유지
class SqliteStore {
  constructor(dbPath, tableName) { ... }
  load() { ... }
  save(data) { ... }
  query(filter) { ... }
}
```

### SQLite 전환 (장기)

```javascript
// 이력 조회 성능 개선
const db = new Database('dashboard.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY,
    jobId TEXT NOT NULL,
    jobName TEXT,
    trigger TEXT,
    startTime TEXT,
    endTime TEXT,
    duration INTEGER,
    status TEXT,
    stdout TEXT,
    stderr TEXT,
    command TEXT,
    options TEXT,
    retryAttempt INTEGER DEFAULT 0,
    error TEXT
  );
  CREATE INDEX idx_history_jobId ON history(jobId);
  CREATE INDEX idx_history_startTime ON history(startTime);
  CREATE INDEX idx_history_status ON history(status);
`);
```

### Docker 배포

```dockerfile
FROM node:20-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/
COPY jobs.json ./

# Python 런타임 (스크립트 실행용)
RUN apt-get update && apt-get install -y python3 python3-pip

VOLUME ["/app/data", "/app/logs"]
EXPOSE 3030

CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  dashboard:
    build: .
    ports:
      - "3030:3030"
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./jobs.json:/app/jobs.json
    environment:
      - SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}
    restart: unless-stopped
```

---

## 5.4 플러그인 아키텍처 (장기 비전)

### 플러그인 타입

| 타입 | 역할 | 예시 |
|------|------|------|
| `data-source` | 데이터 수집 | Notion 연동, Google Calendar |
| `notification` | 알림 채널 | Telegram, Line, SMS |
| `analyzer` | 분석 도구 | 코드 품질 분석, 감정 분석 |
| `widget` | 대시보드 위젯 | 날씨, 주가, 뉴스 |

### 플러그인 인터페이스

```javascript
// plugin-api.js
class Plugin {
  constructor(config) { this.config = config; }

  // 메타데이터
  static get meta() {
    return {
      name: 'my-plugin',
      version: '1.0.0',
      type: 'data-source',
      description: '...',
      configSchema: { /* JSON Schema */ }
    };
  }

  // 라이프사이클
  async initialize() { }
  async destroy() { }

  // data-source 타입
  async collect(date) { return []; }

  // notification 타입
  async send(event, data) { }

  // widget 타입
  render(container) { }
}
```

---

## 검증 방법

각 항목은 독립적으로 검증:

1. **모바일 UI**: Chrome DevTools 모바일 에뮬레이션으로 확인
2. **PWA**: `manifest.json` 추가 후 "홈 화면에 추가" 동작 확인
3. **모듈화**: 리팩토링 후 모든 기존 API 테스트 통과 확인
4. **Docker**: `docker compose up` 후 http://localhost:3030 접속 확인
