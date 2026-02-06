# 작업 설정 가이드

`jobs.json` 파일의 구조와 작업 정의 방법을 설명합니다.

## jobs.json 구조

```json
{
  "jobs": [...],       // 작업 정의 배열
  "edges": [...],      // 작업 간 연결 (의존성)
  "categories": {...}, // 카테고리 정의
  "settings": {...}    // 전역 설정
}
```

## 작업 정의 (Job)

### 기본 구조

```json
{
  "id": "sync-github",
  "name": "GitHub 동기화",
  "description": "로컬 git 커밋을 Daily Note에 기록",
  "command": "/path/to/venv/python /path/to/script.py",
  "schedule": "20 23 * * *",
  "enabled": true,
  "category": "sync",
  "tags": ["github", "daily"],
  "options": [...],
  "execution": {...},
  "position": { "x": 0, "y": 0 },
  "notes": ""
}
```

### 필수 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| id | string | 고유 식별자 (영문, 숫자, 하이픈) |
| name | string | 표시 이름 |
| command | string | 실행할 명령어 (전체 경로 권장) |

### 선택 필드

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| description | string | "" | 작업 설명 |
| schedule | string | "" | 크론 표현식 (빈 값 = 수동 실행만) |
| enabled | boolean | true | 스케줄 활성화 여부 |
| category | string | "custom" | 카테고리 ID |
| tags | string[] | [] | 태그 목록 |
| options | Option[] | [] | 실행 옵션 정의 |
| execution | Execution | {} | 실행 제어 설정 |
| position | Position | null | 그래프 뷰 위치 |
| notes | string | "" | 메모 |

## 크론 표현식

```
┌────────────── 분 (0-59)
│ ┌──────────── 시 (0-23)
│ │ ┌────────── 일 (1-31)
│ │ │ ┌──────── 월 (1-12)
│ │ │ │ ┌────── 요일 (0-7, 0과 7은 일요일)
│ │ │ │ │
* * * * *
```

### 예시

| 표현식 | 설명 |
|--------|------|
| `0 9 * * 1-5` | 평일 오전 9시 |
| `30 23 * * *` | 매일 밤 11시 30분 |
| `0 * * * *` | 매 정시 |
| `*/5 * * * *` | 5분마다 |
| `0 21 1 * *` | 매월 1일 오후 9시 |

## 옵션 정의 (Option)

### 기본 구조

```json
{
  "flag": "--today",
  "arg": "date",
  "label": "오늘 활동",
  "description": "어제가 아닌 오늘 활동 동기화",
  "type": "boolean",
  "default": false,
  "placeholder": "",
  "choices": [],
  "system": false
}
```

### 옵션 타입

#### boolean
체크박스로 표시, true면 플래그 추가

```json
{
  "flag": "--yes",
  "label": "자동 승인",
  "description": "확인 없이 실행",
  "type": "boolean",
  "default": true
}
```

결과: `script.py --yes`

#### string
텍스트 입력

```json
{
  "arg": "date",
  "label": "특정 날짜",
  "description": "동기화할 날짜",
  "type": "string",
  "placeholder": "YYYY-MM-DD",
  "default": ""
}
```

결과: `script.py 2026-01-31`

플래그와 함께 사용:
```json
{
  "flag": "--date",
  "arg": "date",
  "label": "날짜",
  "type": "string"
}
```

결과: `script.py --date "2026-01-31"`

#### array
여러 값 입력 (태그 스타일)

```json
{
  "flag": "--repos",
  "arg": "repos",
  "label": "저장소 경로",
  "description": "로컬 저장소 경로",
  "type": "array",
  "placeholder": "경로 입력 후 Enter",
  "default": []
}
```

결과: `script.py --repos "path1,path2,path3"`

#### select
드롭다운 선택

```json
{
  "flag": "--state",
  "arg": "state",
  "label": "PR 상태",
  "type": "select",
  "choices": ["all", "open", "merged", "closed"],
  "default": "all"
}
```

결과: `script.py --state "open"`

### 시스템 옵션

`system: true`로 표시된 옵션은 명령어에 추가되지 않고 서버에서 처리됩니다.

```json
{
  "flag": "--slack",
  "label": "Slack 알림",
  "description": "완료/실패 시 Slack으로 알림 전송",
  "type": "boolean",
  "default": true,
  "system": true
}
```

## 실행 제어 (Execution)

```json
{
  "execution": {
    "timeout": 300000,
    "maxRetries": 3,
    "retryDelay": 5000,
    "backoff": "exponential"
  }
}
```

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| timeout | number | 300000 | 타임아웃 (ms) - 5분 |
| maxRetries | number | 0 | 최대 재시도 횟수 |
| retryDelay | number | 5000 | 재시도 대기 시간 (ms) |
| backoff | string | "fixed" | 백오프 전략 |

### 백오프 전략

| 전략 | 설명 |
|------|------|
| fixed | 고정 대기 시간 |
| linear | 선형 증가 (delay * attempt) |
| exponential | 지수 증가 (delay * 2^(attempt-1)) |

## 엣지 (Edge)

작업 간 연결 정의:

```json
{
  "id": "edge-1234567890",
  "from": "daily-init",
  "to": "sync-github",
  "label": "",
  "trigger": true,
  "onSuccess": true
}
```

| 필드 | 설명 |
|------|------|
| from | 출발 작업 ID |
| to | 도착 작업 ID |
| label | 연결선 레이블 |
| trigger | true면 자동 트리거 (파이프라인), false면 시각적 연결만 |
| onSuccess | true면 성공 시에만 트리거 |

### 파이프라인 예시

```json
{
  "edges": [
    {
      "from": "sync-github",
      "to": "daily-update",
      "trigger": true,
      "onSuccess": true
    }
  ]
}
```

sync-github 성공 → daily-update 자동 실행

## 카테고리 (Category)

```json
{
  "categories": {
    "sync": {
      "name": "동기화",
      "color": "#3b82f6"
    },
    "daily": {
      "name": "Daily Note",
      "color": "#f59e0b"
    },
    "review": {
      "name": "회고",
      "color": "#ec4899"
    },
    "monitor": {
      "name": "모니터링",
      "color": "#ef4444"
    },
    "maintenance": {
      "name": "정리",
      "color": "#14b8a6"
    },
    "interactive": {
      "name": "인터랙티브",
      "color": "#8b5cf6"
    },
    "vacuum": {
      "name": "문서 정리",
      "color": "#10b981"
    },
    "custom": {
      "name": "사용자 정의",
      "color": "#6b7280"
    }
  }
}
```

## 전역 설정 (Settings)

```json
{
  "settings": {
    "slackWebhookUrl": "https://hooks.slack.com/...",
    "slackEnabled": true,
    "dashboardUrl": "http://localhost:3030",
    "refreshInterval": 5,
    "defaultTimeout": 10,
    "defaultRetry": 0
  }
}
```

| 필드 | 설명 |
|------|------|
| slackWebhookUrl | Slack 웹훅 URL |
| slackEnabled | Slack 알림 활성화 |
| dashboardUrl | 대시보드 URL (알림 링크용) |
| refreshInterval | UI 자동 새로고침 간격 (초) |
| defaultTimeout | 기본 타임아웃 (분) |
| defaultRetry | 기본 재시도 횟수 |

## 인터랙티브 작업 (Electron 전용)

Electron 앱에서 팝업으로 사용자 입력을 받는 작업:

```json
{
  "id": "hourly-checkin",
  "name": "시간별 기록",
  "description": "매시간 지금 하고 있는 일 기록",
  "interactive": true,
  "schedule": "6 * * * *",
  "enabled": true,
  "category": "interactive",
  "popup": {
    "character": "asking",
    "prompts": ["지금 뭐 하고 있어요?", "오늘 하루 어때요?"],
    "placeholder": "간단히 적어주세요...",
    "inputType": "textarea",
    "reminderMinutes": 5,
    "maxReminders": 1,
    "reminderPrompts": ["아까 물어봤는데... 괜찮으면 알려줘요"]
  },
  "processing": {
    "claude": {
      "enabled": true,
      "prompt": "이 내용을 Daily Note에 기록할 형태로 간단히 정리해주세요."
    }
  },
  "output": {
    "target": "obsidian-daily",
    "section": "## 시간별 메모",
    "format": "- `{time}` {content}"
  },
  "collect": {
    "todayEntries": true,
    "claudeSessions": true
  }
}
```

### popup 설정

| 필드 | 설명 |
|------|------|
| character | 캐릭터 이미지 (asking, happy, reminder) |
| prompts | 랜덤하게 표시할 질문 목록 |
| placeholder | 입력창 플레이스홀더 |
| inputType | textarea, quick-buttons, review |
| reminderMinutes | 리마인더 대기 시간 (분) |
| maxReminders | 최대 리마인더 횟수 |
| showCollectedData | 수집 데이터 표시 여부 |
| allowEmpty | 빈 입력 허용 |

### processing 설정

```json
{
  "claude": {
    "enabled": true,
    "prompt": "시스템 프롬프트..."
  }
}
```

Claude CLI를 사용해 입력 내용을 가공합니다.

### output 설정

| 필드 | 설명 |
|------|------|
| target | 저장 대상 (obsidian-daily) |
| section | Daily Note 섹션 헤더 |
| format | 출력 포맷 ({time}, {content} 치환) |
| sections | 여러 섹션에 나눠 저장 시 |

### collect 설정

팝업에 표시할 데이터 수집:

| 필드 | 설명 |
|------|------|
| todayEntries | 오늘 기록 수집 |
| claudeSessions | Claude 세션 수집 |

## 전체 예시

```json
{
  "jobs": [
    {
      "id": "sync-github",
      "name": "GitHub 동기화",
      "description": "로컬 git 커밋을 Daily Note에 기록",
      "command": "/Users/user/ai-pipeline/.venv/bin/python /Users/user/ai-pipeline/scripts/sync_github.py",
      "schedule": "20 23 * * *",
      "enabled": true,
      "category": "sync",
      "tags": ["github", "daily"],
      "options": [
        {
          "flag": "--today",
          "label": "오늘 활동",
          "description": "어제가 아닌 오늘 활동 동기화",
          "type": "boolean",
          "default": false
        },
        {
          "flag": "--yes",
          "label": "자동 승인",
          "type": "boolean",
          "default": true
        },
        {
          "flag": "--slack",
          "label": "Slack 알림",
          "type": "boolean",
          "default": false,
          "system": true
        }
      ],
      "execution": {
        "timeout": 300000,
        "maxRetries": 1,
        "retryDelay": 5000,
        "backoff": "fixed"
      },
      "position": { "x": -183, "y": -225 }
    }
  ],
  "edges": [
    {
      "id": "edge-1",
      "from": "sync-github",
      "to": "daily-update",
      "trigger": true,
      "onSuccess": true
    }
  ],
  "categories": {
    "sync": { "name": "동기화", "color": "#3b82f6" }
  },
  "settings": {
    "slackWebhookUrl": "",
    "slackEnabled": false,
    "dashboardUrl": "http://localhost:3030"
  }
}
```
