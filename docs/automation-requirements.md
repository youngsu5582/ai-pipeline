# AI Pipeline 자동화 요구사항

> 작성일: 2026-01-31
> 상태: Draft

## 개요

반복적인 개발 업무를 cron 기반으로 자동화하여 AI Pipeline Dashboard에서 관리

## 기존 자동화 작업 (구현 완료)

| ID | 작업명 | 주기 | 설명 |
|----|--------|------|------|
| sync-github | GitHub 동기화 | 23:20 | git 커밋을 Daily Note에 기록 |
| sync-jira | JIRA 동기화 | 18:00 | JIRA 활동을 Daily Note에 기록 |
| daily-init | Daily Note 생성 | 10:30 (평일) | 오늘 Daily Note 템플릿 생성 |
| daily-update | Daily Note 갱신 | 23:30 (평일) | 학습 내용을 Daily Note에 추가 |
| vacuum-run | 문서 정리 실행 | 23:10 (평일) | 프로젝트 루트 MD 파일 정리 |

---

## 추가 자동화 작업 (구현 예정)

### 1. CloudWatch 에러 알림

| 항목 | 내용 |
|------|------|
| **ID** | `cloudwatch-error-alert` |
| **카테고리** | 모니터링 |
| **주기** | 1시간마다 (`0 * * * *`) |
| **대상** | API 서버 + Consumer 서버 로그 그룹 |
| **출력** | Slack 알림 |
| **우선순위** | 높음 |

**동작**:
1. CloudWatch Logs Insights로 최근 1시간 에러 로그 쿼리
2. ERROR/WARN 패턴 집계
3. 에러 있으면 Slack 알림 (개수, 샘플, 로그 링크)

**필요 환경변수**:
- `AWS_PROFILE` 또는 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
- `SLACK_WEBHOOK_URL`

---

### 2. PR 리뷰 대기 알림

| 항목 | 내용 |
|------|------|
| **ID** | `pr-review-reminder` |
| **카테고리** | PR 관리 |
| **주기** | 하루 1회 오전 (`0 9 * * 1-5`) |
| **대상** | aicreation 저장소 |
| **출력** | Slack 알림 |
| **우선순위** | 중간 |

**동작**:
1. `gh pr list --search "review-requested:@me"`로 리뷰 대기 PR 조회
2. PR 제목, 작성자, 생성일 목록
3. Slack으로 리뷰 대기 목록 알림

---

### 3. 내 PR 상태 요약

| 항목 | 내용 |
|------|------|
| **ID** | `my-pr-status` |
| **카테고리** | PR 관리 |
| **주기** | 하루 1회 저녁 (`0 18 * * 1-5`) |
| **대상** | aicreation 저장소 |
| **출력** | Daily Note |
| **우선순위** | 중간 |

**동작**:
1. `gh pr list --author @me`로 내 PR 조회
2. 상태별 분류 (Open/Merged/Closed)
3. Daily Note에 PR 현황 섹션 추가

---

### 4. Claude 세션 요약

| 항목 | 내용 |
|------|------|
| **ID** | `claude-session-summary` |
| **카테고리** | 학습 |
| **주기** | 하루 1회 저녁 (`0 23 * * 1-5`) |
| **대상** | Claude Code 세션 히스토리 |
| **출력** | Daily Note |
| **우선순위** | 중간 |

**동작**:
1. `~/.claude/projects/*/` 에서 오늘 세션 파일 탐색
2. 주요 작업 내용 추출 (파일 변경, 학습 포인트)
3. TIL 형식으로 Daily Note에 추가

---

### 5. 브라우저 링크 정리

| 항목 | 내용 |
|------|------|
| **ID** | `browser-links-collect` |
| **카테고리** | 학습 |
| **주기** | 하루 1회 저녁 (`30 22 * * 1-5`) |
| **대상** | Safari/Chrome 열린 탭 또는 읽기 목록 |
| **출력** | Obsidian |
| **우선순위** | 낮음 |

**동작**:
1. AppleScript로 열린 탭 URL/제목 수집
2. 카테고리 분류 (기술문서, 뉴스, 참고자료)
3. Obsidian `reading/` 폴더에 정리

---

## 구현 우선순위

1. **CloudWatch 에러 알림** - 실시간 모니터링으로 장애 대응 시간 단축
2. **PR 리뷰 대기 알림** - 팀 협업 효율성
3. **내 PR 상태 요약** - 일일 업무 파악
4. **Claude 세션 요약** - 학습 기록 자동화
5. **브라우저 링크 정리** - 읽을거리 관리

---

## 기술 스택

- **스크립트**: Python 3.x (ai-pipeline/.venv)
- **AWS 연동**: boto3
- **GitHub 연동**: gh CLI
- **브라우저 연동**: AppleScript (macOS)
- **출력**: Slack webhook, Obsidian vault

---

## 스크립트 상세 명세

### 1. cloudwatch_alert.py

```
Usage:
    python cloudwatch_alert.py                    # 기본 (최근 1시간)
    python cloudwatch_alert.py --hours 2          # 최근 2시간
    python cloudwatch_alert.py --profile prod     # 특정 AWS 프로필
    python cloudwatch_alert.py --slack            # Slack 알림 전송

Options:
    --hours N       조회할 시간 범위 (기본: 1)
    --profile NAME  AWS 프로필 (기본: 환경변수 또는 default)
    --slack         Slack 알림 전송
    --yes, -y       확인 없이 실행
```

**settings.yaml 설정**:
```yaml
monitor:
  cloudwatch:
    log_groups:
      - "/aws/lambda/api-function"
      - "/aws/ecs/consumer-service"
    error_patterns:
      - "ERROR"
      - "Exception"
      - "FATAL"
```

**출력**: Slack 알림 (에러 개수, 샘플 로그, CloudWatch 링크)

---

### 2. pr_review_reminder.py

```
Usage:
    python pr_review_reminder.py                          # 모든 저장소
    python pr_review_reminder.py --repo owner/repo        # 특정 저장소
    python pr_review_reminder.py --slack                  # Slack 알림

Options:
    --repo OWNER/REPO  특정 저장소만 조회 (여러번 지정 가능)
    --slack            Slack 알림 전송
```

**출력**: Slack 알림 (리뷰 대기 PR 목록, 작성자, 생성일)

---

### 3. my_pr_status.py

```
Usage:
    python my_pr_status.py                        # 모든 저장소
    python my_pr_status.py --repo owner/repo      # 특정 저장소
    python my_pr_status.py --yes                  # Daily Note에 자동 추가

Options:
    --repo OWNER/REPO  특정 저장소만 조회
    --yes, -y          Daily Note에 자동 추가
    --slack            Slack 알림 전송
```

**출력**: Daily Note에 PR 현황 섹션 추가

---

### 4. claude_session_summary.py

```
Usage:
    python claude_session_summary.py              # 오늘 세션
    python claude_session_summary.py --yes        # Daily Note에 자동 추가

Options:
    --yes, -y          Daily Note에 자동 추가
    --slack            Slack 알림 전송
```

**대상**: `~/.claude/projects/*/` 내 오늘 날짜 세션 파일
**출력**: Daily Note에 학습 내용 요약 추가

---

### 5. browser_links.py

```
Usage:
    python browser_links.py                       # Chrome 열린 탭
    python browser_links.py --yes                 # Obsidian에 자동 저장

Options:
    --yes, -y          Obsidian에 자동 저장
    --slack            Slack 알림 전송
```

**대상**: Chrome 열린 탭 (AppleScript)
**출력**: Obsidian `reading/YYYY-MM-DD.md` 파일

---

## jobs.json 추가 항목

```json
{
  "id": "cloudwatch-alert",
  "name": "CloudWatch 에러 알림",
  "description": "AWS CloudWatch 에러 로그 감지 후 Slack 알림",
  "command": ".venv/bin/python scripts/cloudwatch_alert.py",
  "schedule": "0 * * * *",
  "enabled": false,
  "category": "monitor",
  "tags": ["aws", "cloudwatch", "alert"],
  "options": [
    {"flag": "--hours", "label": "조회 시간", "type": "string", "default": "1"},
    {"flag": "--profile", "label": "AWS 프로필", "type": "string", "default": ""},
    {"flag": "--slack", "label": "Slack 알림", "type": "boolean", "default": true, "system": true}
  ]
},
{
  "id": "pr-review-reminder",
  "name": "PR 리뷰 알림",
  "description": "리뷰 대기 중인 PR 목록 Slack 알림",
  "command": ".venv/bin/python scripts/pr_review_reminder.py",
  "schedule": "0 9 * * 1-5",
  "enabled": false,
  "category": "monitor",
  "tags": ["github", "pr", "review"],
  "options": [
    {"arg": "repo", "flag": "--repo", "label": "저장소", "type": "string", "default": ""},
    {"flag": "--slack", "label": "Slack 알림", "type": "boolean", "default": true, "system": true}
  ]
},
{
  "id": "my-pr-status",
  "name": "내 PR 상태",
  "description": "내가 올린 PR 상태를 Daily Note에 기록",
  "command": ".venv/bin/python scripts/my_pr_status.py",
  "schedule": "0 18 * * 1-5",
  "enabled": false,
  "category": "sync",
  "tags": ["github", "pr", "daily"],
  "options": [
    {"arg": "repo", "flag": "--repo", "label": "저장소", "type": "string", "default": ""},
    {"flag": "--yes", "label": "자동 추가", "type": "boolean", "default": true},
    {"flag": "--slack", "label": "Slack 알림", "type": "boolean", "default": false, "system": true}
  ]
},
{
  "id": "claude-session-summary",
  "name": "Claude 세션 요약",
  "description": "오늘 Claude Code 세션의 학습 내용 요약",
  "command": ".venv/bin/python scripts/claude_session_summary.py",
  "schedule": "0 23 * * 1-5",
  "enabled": false,
  "category": "sync",
  "tags": ["claude", "learning", "daily"],
  "options": [
    {"flag": "--yes", "label": "자동 추가", "type": "boolean", "default": true},
    {"flag": "--slack", "label": "Slack 알림", "type": "boolean", "default": false, "system": true}
  ]
},
{
  "id": "browser-links",
  "name": "브라우저 링크 정리",
  "description": "Chrome 열린 탭을 Obsidian에 저장",
  "command": ".venv/bin/python scripts/browser_links.py",
  "schedule": "30 22 * * 1-5",
  "enabled": false,
  "category": "sync",
  "tags": ["browser", "reading", "obsidian"],
  "options": [
    {"flag": "--yes", "label": "자동 저장", "type": "boolean", "default": true},
    {"flag": "--slack", "label": "Slack 알림", "type": "boolean", "default": false, "system": true}
  ]
}
```

---

## 참고

- 대시보드: `ai-pipeline/dashboard/`
- 기존 스크립트: `ai-pipeline/scripts/`
- 작업 설정: `ai-pipeline/dashboard/jobs.json`
