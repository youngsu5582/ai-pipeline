# API 레퍼런스

Express 서버가 제공하는 REST API 명세입니다.

기본 URL: `http://localhost:3030`

## 작업 관리 API

### 작업 목록 조회

```http
GET /api/jobs
```

**응답**
```json
{
  "jobs": [
    {
      "id": "sync-github",
      "name": "GitHub 동기화",
      "description": "로컬 git 커밋을 Daily Note에 기록",
      "command": "/path/to/python script.py",
      "schedule": "20 23 * * *",
      "enabled": true,
      "category": "sync",
      "tags": ["github", "daily"],
      "options": [...],
      "position": { "x": -183, "y": -225 },
      "isScheduled": true,
      "isRunning": false
    }
  ],
  "edges": [...],
  "categories": {...},
  "settings": {...}
}
```

### 작업 상세 조회

```http
GET /api/jobs/:id
```

**응답**
```json
{
  "id": "sync-github",
  "name": "GitHub 동기화",
  ...
  "isScheduled": true
}
```

### 작업 생성

```http
POST /api/jobs
Content-Type: application/json
```

**요청 본문**
```json
{
  "name": "새 작업",
  "description": "설명",
  "command": "/path/to/script.py",
  "schedule": "0 * * * *",
  "enabled": true,
  "category": "custom",
  "tags": ["tag1"]
}
```

**응답**: 201 Created
```json
{
  "id": "job-1234567890",
  "name": "새 작업",
  ...
}
```

### 작업 수정

```http
PUT /api/jobs/:id
Content-Type: application/json
```

**요청 본문** (변경할 필드만)
```json
{
  "name": "수정된 이름",
  "enabled": false
}
```

### 작업 삭제

```http
DELETE /api/jobs/:id
```

**응답**: `{ "success": true }`

### 작업 복제

```http
POST /api/jobs/:id/duplicate
```

**응답**
```json
{
  "success": true,
  "newId": "job-1234567891",
  "job": { ... }
}
```

## 작업 실행 API

### 즉시 실행

```http
POST /api/jobs/:id/run
Content-Type: application/json
```

**요청 본문** (옵션 지정)
```json
{
  "options": {
    "--today": true,
    "--yes": true
  }
}
```

**응답**
```json
{
  "success": true,
  "stdout": "실행 결과...",
  "stderr": "",
  "duration": 1234
}
```

### 활성화/비활성화 토글

```http
POST /api/jobs/:id/toggle
```

**응답**: `{ "enabled": true }`

### 예약 실행 (1회)

```http
POST /api/jobs/:id/schedule-once
Content-Type: application/json
```

**요청 본문**
```json
{
  "scheduledTime": "2026-02-06T15:30:00.000Z"
}
```

**응답**
```json
{
  "success": true,
  "scheduledFor": "2026-02-06T15:30:00.000Z",
  "delayMs": 3600000
}
```

### 실시간 로그 조회

```http
GET /api/jobs/:id/live-log
```

**응답 (실행 중)**
```json
{
  "running": true,
  "logId": 1234567890,
  "stdout": "진행 중...",
  "stderr": "",
  "elapsed": 5000,
  "command": "/path/to/python script.py --yes"
}
```

**응답 (완료)**
```json
{
  "running": false,
  "logId": 1234567890,
  "stdout": "완료",
  "stderr": "",
  "status": "success",
  "duration": 12345,
  "command": "..."
}
```

## 엣지 (의존성) API

### 엣지 목록 조회

```http
GET /api/edges
```

### 엣지 생성

```http
POST /api/edges
Content-Type: application/json
```

**요청 본문**
```json
{
  "from": "job-a",
  "to": "job-b",
  "label": "완료 후",
  "trigger": true,
  "onSuccess": true
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| from | string | 출발 작업 ID |
| to | string | 도착 작업 ID |
| label | string | 레이블 (선택) |
| trigger | boolean | true면 자동 트리거, false면 시각적 연결만 |
| onSuccess | boolean | true면 성공 시에만 트리거 |

### 엣지 수정

```http
PUT /api/edges/:id
Content-Type: application/json
```

### 엣지 삭제

```http
DELETE /api/edges/:id
```

## 위치 저장 API

```http
POST /api/jobs/positions
Content-Type: application/json
```

**요청 본문**
```json
{
  "positions": [
    { "id": "job-a", "position": { "x": 100, "y": 200 } },
    { "id": "job-b", "position": { "x": 300, "y": 200 } }
  ]
}
```

## 이력 API

### 이력 조회 (페이지네이션)

```http
GET /api/history?page=1&limit=10&jobId=&search=&status=&startDate=&endDate=
```

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| page | number | 페이지 번호 (기본: 1) |
| limit | number | 페이지당 항목 수 (기본: 10) |
| jobId | string | 특정 작업 필터 |
| search | string | 작업명 검색 |
| status | string | 상태 필터 (success, failed, running) |
| startDate | string | 시작 날짜 (YYYY-MM-DD) |
| endDate | string | 종료 날짜 (YYYY-MM-DD) |

**응답**
```json
{
  "items": [
    {
      "id": 1234567890,
      "jobId": "sync-github",
      "jobName": "GitHub 동기화",
      "trigger": "scheduled",
      "startTime": "2026-02-06T14:20:00.000Z",
      "endTime": "2026-02-06T14:20:05.000Z",
      "duration": 5000,
      "status": "success",
      "stdout": "...",
      "stderr": "",
      "command": "...",
      "options": {...}
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

## 통계 API

### 요약 통계

```http
GET /api/stats/summary?days=7
```

**응답**
```json
{
  "period": "7 days",
  "total": 150,
  "success": 140,
  "failed": 8,
  "running": 2,
  "successRate": 93,
  "avgDuration": 5000,
  "avgDurationFormatted": "5.0s"
}
```

### 작업별 통계

```http
GET /api/stats/jobs?days=7
```

**응답**
```json
[
  {
    "jobId": "sync-github",
    "jobName": "GitHub 동기화",
    "total": 30,
    "success": 28,
    "failed": 2,
    "successRate": 93,
    "avgDuration": 4500,
    "lastRun": "2026-02-06T14:20:00.000Z"
  }
]
```

### 일별 트렌드

```http
GET /api/stats/trend?days=7
```

**응답**
```json
[
  { "date": "2026-01-31", "success": 20, "failed": 1, "total": 21 },
  { "date": "2026-02-01", "success": 22, "failed": 0, "total": 22 },
  ...
]
```

### 시간대별 분포

```http
GET /api/stats/hourly?days=7
```

**응답**
```json
[
  { "hour": 0, "count": 5 },
  { "hour": 1, "count": 3 },
  ...
  { "hour": 23, "count": 15 }
]
```

### 실패 TOP N

```http
GET /api/stats/failures?days=7&limit=5
```

**응답**
```json
[
  {
    "jobId": "cloudwatch-alert",
    "jobName": "CloudWatch 에러 알림",
    "count": 3,
    "lastFailure": "2026-02-05T10:00:00.000Z",
    "lastError": "AWS credentials not configured"
  }
]
```

## 설정 API

### 설정 조회

```http
GET /api/settings
```

**응답**
```json
{
  "slackWebhookUrl": "https://hooks.slack.com/...",
  "slackEnabled": true,
  "dashboardUrl": "http://localhost:3030",
  "refreshInterval": 5,
  "defaultTimeout": 10,
  "defaultRetry": 0
}
```

### 설정 저장

```http
PUT /api/settings
Content-Type: application/json
```

**요청 본문**
```json
{
  "slackWebhookUrl": "https://hooks.slack.com/...",
  "slackEnabled": true,
  "dashboardUrl": "http://localhost:3030",
  "refreshInterval": 5,
  "defaultTimeout": 10,
  "defaultRetry": 0
}
```

## 내보내기/가져오기 API

### 이력 내보내기

```http
GET /api/export/history?days=30&format=json
```

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| days | number | 내보낼 일수 |
| format | json, csv | 출력 형식 |

### 통계 내보내기

```http
GET /api/export/stats?days=7&format=json
```

### 전체 설정 내보내기

```http
GET /api/export
```

### 설정 가져오기

```http
POST /api/import
Content-Type: application/json
```

**요청 본문**: jobs.json 전체 내용

## 유틸리티 API

### 크론 표현식 검증

```http
POST /api/validate-cron
Content-Type: application/json
```

**요청 본문**
```json
{
  "expression": "0 23 * * *"
}
```

**응답**: `{ "valid": true }`

### 헬스 체크

```http
GET /api/health
```

**응답**
```json
{
  "status": "ok",
  "uptime": 3600,
  "scheduledJobs": 15
}
```

### 카테고리 목록

```http
GET /api/categories
```

**응답**
```json
{
  "sync": { "name": "동기화", "color": "#3b82f6" },
  "daily": { "name": "Daily Note", "color": "#f59e0b" },
  ...
}
```

## SSE (Server-Sent Events)

### 실시간 이벤트 구독

```http
GET /api/tasks/events?clientId=client-123
```

**이벤트 타입**
| 이벤트 | 데이터 | 설명 |
|--------|--------|------|
| connected | `{ clientId }` | 연결 성공 |
| task:progress | `{ taskId, progress, message }` | 작업 진행 상황 |
| ping | - | 연결 유지 |

## 세션 요약 API

### 캐시된 세션 요약 조회

```http
GET /api/sessions/:id/summary?project={projectPath}
```

**응답**
```json
{
  "summary": {
    "id": "ss-abc123",
    "sessionId": "abc123...",
    "projectPath": "-Users-iyeongsu-ai-pipeline-dashboard",
    "project": "dashboard",
    "summary": "## 요약\n...",
    "createdAt": "2026-02-07T10:30:00.000Z"
  }
}
```

요약이 없으면 `{ "summary": null }` 반환.

### 세션 목록 (hasSummary 포함)

`GET /api/sessions?date=YYYY-MM-DD` 응답의 각 세션 객체에 `hasSummary: boolean` 필드 포함.

## 일일 보고서 API

### 캐시된 보고서 조회

```http
GET /api/reports/daily?date=YYYY-MM-DD&type={type}
```

**파라미터**
| 파라미터 | 필수 | 설명 |
|---------|------|------|
| date | 선택 | 날짜 필터 (YYYY-MM-DD) |
| type | 선택 | `daily-report`, `full-daily-report`, `day-wrapup` |

**응답 (date+type 지정)**
```json
{ "report": { "id": "dr-2026-02-07-day-wrapup", "date": "2026-02-07", "type": "day-wrapup", "report": "# 🌙 ...", "createdAt": "..." } }
```

**응답 (date만 지정)**
```json
{ "reports": [ ... ] }
```

보고서가 없으면 `{ "report": null }` 또는 `{ "reports": [] }` 반환.

## 에러 응답

모든 API는 에러 시 다음 형식으로 응답합니다:

```json
{
  "error": "에러 메시지"
}
```

| 상태 코드 | 설명 |
|----------|------|
| 400 | 잘못된 요청 (파라미터 오류 등) |
| 404 | 리소스를 찾을 수 없음 |
| 500 | 서버 내부 오류 |
