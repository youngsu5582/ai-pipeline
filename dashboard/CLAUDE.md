# CLAUDE.md

이 파일은 Claude Code (claude.ai/code)가 이 저장소에서 작업할 때 참고하는 가이드입니다.

## 프로젝트 개요

AI Pipeline의 **Dashboard** 컴포넌트 - 개인 지식 관리 시스템을 구동하는 크론 작업을 관리하는 Node.js 웹 UI. AI 대화, GitHub 활동, 개인 노트를 Obsidian vault로 동기화하는 Python 스크립트들을 스케줄링하고 모니터링합니다.

## 명령어

```bash
npm install           # 의존성 설치
npm run dev           # 개발 모드 (--watch, 자동 리로드)
npm start             # 프로덕션 실행
```

- 기본 포트: 3030 (`DASHBOARD_URL` 설정으로 변경 가능)
- 접속: http://localhost:3030

## 현재 UI 구조

### 탭 네비게이션 (2단 구조)
```
상위 탭: 🏠 홈 | 📦 작업 | ⚙️ 설정 | 🤖 세션 | 📋 노트

"작업" 탭 내부 서브탭:
  작업 목록 | 실행 이력 | 📊 통계
```

- `showTab(tab)`: 상위 탭 전환 (home/jobs/settings/sessions/notes)
- `showJobSubTab(sub)`: 작업 내부 서브탭 전환 (list/history/stats)
- 키보드 단축키: 1=홈, 2=작업, 3=설정, 4=세션, 5=노트, Cmd+K or `/`=검색

### 주요 패널 ID
| 패널 | ID | 설명 |
|------|-----|------|
| 홈 | `panel-home` | 요약 카드 + 빠른 액션 + 통합 타임라인 + 최근 실행/메모 |
| 작업 | `panel-jobs` | 서브탭 3개 포함 |
| 작업목록 | `jobSubPanel-list` | 오늘의 요약 위젯 + 카드/그래프 뷰 |
| 실행이력 | `jobSubPanel-history` | 필터 + 테이블 + 페이지네이션 |
| 통계 | `jobSubPanel-stats` | 차트 + 작업별 통계 테이블 |
| 설정 | `panel-settings` | Slack, 대시보드 URL, 내보내기 |
| 세션 | `panel-sessions` | Claude Code 세션 관리 (서브탭: 세션 목록/지식 그래프/리뷰 분석) |
| 노트 | `panel-notes` | 날짜별 메모/백로그 조회 |

### 주요 모달
- **작업 편집** (`editJobModal`): 기본정보/옵션/실행제어 3탭
- **Quick Input** (`quickInputModal`): 빠른 메모/백로그 추가
- **Morning Start** (`morningStartModal`): 하루 시작 위저드 (폼/마크다운뷰/원본편집)
- **Day Wrapup** (`dayWrapupModal`): 오늘 보고서 4단계 위저드
- **Session Detail** (`sessionDetailModal`): 세션 상세 (Overview/Conversation/Summary)
- **Log Modal** (`logModal`): 실행 로그 상세
- **Ask Modal** (`askModal`): Claude에게 질문
- **Rename Session** (`renameSessionModal`): 세션 이름 변경

### 주요 기능별 함수
| 기능 | 함수 | 파일 |
|------|------|------|
| 작업 로드 | `loadJobs()` | index.html |
| 이력 로드 | `loadHistory()` | index.html |
| 통계 로드 | `loadStats()` | index.html |
| 노트 로드 | `loadNotes()` | index.html (날짜 필터: `notesDate` 변수) |
| 홈 대시보드 | `loadHomeDashboard()` | index.html (선택 날짜 기준 요약카드 갱신) |
| 홈→탭 이동 | `navigateWithDate(tab, subTab)` | index.html (homeDate를 대상 탭에 전달) |
| 통합 타임라인 | `loadTimeline()` | index.html (타입 필터, 시간 범위 슬라이더) |
| 통합 검색 | `openGlobalSearch()` | index.html (Cmd+K, `/` 단축키) |
| 오늘 요약 | `refreshTodaySummary()` | index.html |
| 모닝 플랜 | `openMorningStart()` | index.html |
| 오늘 보고서 | `generateTodayFullReport()` | index.html |
| GitHub 활동 수집 | `/api/github/activity` | server.js (멀티 계정, PR title 해석) |
| 스마트 서제스션 | `loadSuggestions()` | index.html (규칙 기반, localStorage dismiss) |
| 생산성 분석 | `loadProductivity()` | index.html (4개 차트, 기간 전환) |
| 주간 다이제스트 | `generateWeeklyDigest()` | index.html (Claude CLI 비동기 태스크) |
| 메모 분류 | `classifyMemoBackground()` | server.js (키워드+Claude 하이브리드, SSE) |
| 세션 인사이트 | `loadSessionInsightsTab()` | index.html (세션 모달 인사이트 탭) |
| 지식 그래프 | `loadKnowledgeGraphUI()` | index.html (vis-network, 세션 탭 서브탭) |
| 리뷰 분석 | `generateReviewAnalysis()` | index.html (GitHub PR 리뷰 패턴 분석) |
| SSE 이벤트 | `initSSE()` | index.html |

## 아키텍처

### 핵심 컴포넌트

**server.js** (~3,900줄) - Express 서버:
- 40+ REST API 엔드포인트
- `node-cron` 크론 작업 스케줄링
- child process 작업 실행 (타임아웃, 재시도 지원)
- SSE (Server-Sent Events) 실시간 업데이트
- Claude API 연동 (비동기 태스크 큐)
- Slack Webhook 알림
- Auto-fix 규칙
- GitHub 멀티 계정 활동 수집 (Events API)
- KST 타임존 헬퍼 - `getKSTDateString()` (Asia/Seoul, 모든 날짜 기본값에 사용)
- Obsidian Daily Note 파싱 - `parseObsidianMemos(date)` 헬퍼 (한국어 시간 형식 지원)
- 통합 타임라인 API (`/api/timeline`)
- AI 인사이트 API (`/api/insights/suggestions`, `/api/insights/productivity`, `/api/insights/weekly-digest`)

**public/index.html** (~7,400줄) - 싱글 페이지 대시보드:
- Tailwind CSS 다크 테마
- Chart.js 차트
- vis-network 그래프 뷰
- marked.js 마크다운 렌더링

**jobs.json** - 작업 정의 + edges + settings

### 데이터 파일 (data/ 디렉토리)
| 파일 | 용도 |
|------|------|
| `quick-memos.json` | 빠른 메모 저장 |
| `backlogs.json` | 백로그 항목 |
| `morning-plans.json` | 하루 시작 계획 |
| `session-aliases.json` | 세션 별칭 |
| `weekly-digests.json` | 주간 다이제스트 |
| `session-summaries.json` | 세션 요약 캐시 |
| `daily-reports.json` | 일일/종합/하루마무리 보고서 캐시 |
| `memo-categories.json` | 메모 자동 분류 (카테고리/태그) |
| `session-insights.json` | 세션 인사이트 캐시 (토픽/기술/문제) |
| `knowledge-graph.json` | 지식 그래프 노드/엣지 |
| `review-analysis.json` | 코드 리뷰 패턴 분석 결과 |

### 데이터 흐름
```
Dashboard (Node.js:3030)
    ↓ spawn
Python Scripts (../scripts/)
    ↓ 기록
Obsidian Vault (~/Desktop/obsidian)
    ↓ 알림
Slack (webhooks)
```

## 주요 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/jobs` | 작업 목록 |
| POST | `/api/jobs/:id/run` | 작업 실행 |
| GET | `/api/history?limit=N` | 실행 이력 (items 배열) |
| GET | `/api/stats/summary?days=N` | 통계 요약 |
| GET | `/api/today/summary?date=YYYY-MM-DD` | 날짜별 요약 (sessionsCount, jobsCount, successCount, 기본=오늘) |
| GET | `/api/sessions` | Claude 세션 목록 (hasSummary 포함) |
| GET | `/api/sessions/:id/summary` | 캐시된 세션 요약 조회 |
| GET | `/api/reports/daily?date=&type=` | 캐시된 일일 보고서 조회 |
| GET | `/api/quick-memos?date=YYYY-MM-DD` | 메모 (날짜 필터 지원) |
| GET | `/api/backlogs` | 백로그 |
| GET | `/api/obsidian/daily-memos?date=YYYY-MM-DD` | Obsidian 시간별 메모 |
| GET | `/api/morning-plan?date=YYYY-MM-DD` | 모닝 플랜 |
| GET | `/api/github/activity?date=YYYY-MM-DD` | GitHub 활동 (멀티 계정) |
| GET | `/api/timeline?date=YYYY-MM-DD` | 통합 타임라인 (6개 소스 통합, 시간순) |
| GET | `/api/search?q=키워드&types=...` | 통합 검색 (메모, 세션, 작업, 백로그) |
| GET | `/api/insights/suggestions` | 스마트 서제스션 (규칙 기반 5가지) |
| GET | `/api/insights/productivity?days=N` | 생산성 분석 (시간대/일별/프로젝트/비교) |
| POST | `/api/insights/weekly-digest` | 주간 다이제스트 생성 (비동기 태스크) |
| GET | `/api/insights/weekly-digest?week=YYYY-MM-DD` | 저장된 다이제스트 조회 |
| PATCH | `/api/quick-memos/:id/category` | 메모 카테고리/태그 수동 수정 |
| POST | `/api/memos/migrate-classifications` | 기존 메모 일괄 키워드 분류 |
| GET | `/api/memos/stats` | 카테고리별 메모 통계 |
| GET | `/api/sessions/:id/insights?project=` | 세션 인사이트 조회/생성 (캐시 or 비동기) |
| GET | `/api/sessions/insights/overview?days=N` | 인사이트 통계 요약 |
| GET | `/api/knowledge-graph?minMentions=N` | 지식 그래프 노드/엣지 |
| POST | `/api/knowledge-graph/rebuild` | 지식 그래프 재구성 |
| GET | `/api/knowledge-graph/recommendations?topic=` | 토픽 추천 + 복습 제안 |
| POST | `/api/github/review-analysis` | 리뷰 패턴 분석 (비동기) |
| GET | `/api/github/review-analysis` | 저장된 리뷰 분석 조회 |
| POST | `/api/tasks` | 비동기 태스크 (ask, daily-report, session-insights, review-analysis 등) |
| GET | `/api/tasks/events` | SSE 스트림 (memo:classified 포함) |

## 환경변수

| 변수 | 용도 |
|------|------|
| `SLACK_WEBHOOK_URL` | Slack 알림 |
| `PORT` | 서버 포트 (기본 3030) |
| `ANTHROPIC_API_KEY` | Claude API |

## 설정 파일

- `../config/settings.local.yaml` - 로컬 설정 (vault 경로, GitHub repos 등)
- `../config/settings.yaml` - 기본 설정

## 파일 구조

```
dashboard/
├── server.js           # Express 서버 (3,900줄)
├── jobs.json           # 작업 정의 + edges + settings
├── public/
│   └── index.html      # 대시보드 UI (7,400줄)
├── electron/           # Electron 데스크톱 앱
│   ├── main.js
│   ├── tray.js
│   ├── preload.js
│   ├── services/       # ObsidianWriter, ClaudeCode, SessionCollector
│   └── windows/        # QuickInput, Popup 윈도우
├── data/               # JSON 데이터 파일
├── logs/               # 실행 로그
├── docs/               # 개발 가이드, API 레퍼런스
└── package.json
```

## 고도화 로드맵

상세 명세서: `../docs/enhancement-roadmap.md`

| Phase | 내용 | 명세서 | 우선순위 |
|-------|------|--------|----------|
| 1 | 통합 타임라인 + 검색 | `spec-phase1-unified-timeline.md` | P0 |
| 2 | AI 인사이트 + 생산성 분석 | `spec-phase2-ai-insights.md` | P1 |
| 3 | 자동화 고도화 (조건부 파이프라인, 알림 확장) | `spec-phase3-advanced-automation.md` | P2 |
| 4 | AI 심화 (메모 분류, 세션 인사이트, 지식 그래프) | `spec-phase4-ai-deep-integration.md` | P2-P3 |
| 5 | 플랫폼 확장 (모바일, 위젯, 서버 모듈화) | `spec-phase5-platform-extension.md` | P3-P4 |

**구현 완료**: Phase 1 전체 + Phase 2 전체 + Phase 3 전체 + Phase 4 전체 + Phase 5 전체
- 1.1 통합 타임라인 (`GET /api/timeline` + 접기/펼치기 + 시간 범위 슬라이더 + 타입 필터)
- 1.2 통합 검색 (`GET /api/search` + Cmd+K 모달 + 키보드 네비게이션)
- 1.3 날짜 네비게이션 (홈 탭 날짜 선택기 + 전체 데이터 날짜 연동)
- 2.1 주간 다이제스트 (`POST/GET /api/insights/weekly-digest` + Claude CLI 분석 + Obsidian WEEKLY/ 저장)
- 2.2 생산성 분석 (`GET /api/insights/productivity` + 히트맵/도넛/트렌드/비교 차트)
- 2.3 스마트 서제스션 (`GET /api/insights/suggestions` + 규칙 기반 5가지 제안 + localStorage 24시간 dismiss)
- 3.1 조건부 파이프라인 (Edge 조건 6가지: onSuccess/onFailure/always/onOutput/onExitCode + 그래프 색상)
- 3.2 알림 채널 확장 (Slack/Discord/Native + 규칙 기반 라우팅 + 테스트 알림)
- 3.3 외부 트리거 (`POST /api/webhook/:token` + 토큰 CRUD + allowedJobs 보안)
- 3.4 스마트 스케줄링 (간편/Cron 모드 전환 + 빈도 선택기 + 다음 실행 표시)
- 4.1 메모 자동 분류 (키워드 Tier1 + Claude Tier2, `PATCH /api/quick-memos/:id/category`, 카테고리 필터, SSE 실시간 갱신)
- 4.2 세션 인사이트 (`GET /api/sessions/:id/insights` + Claude CLI 분석 + 세션 모달 인사이트 탭)
- 4.3 지식 그래프 (`GET /api/knowledge-graph` + vis-network 시각화 + 토픽 추천, 세션 탭 서브탭)
- 4.4 코드 리뷰 분석 (`POST/GET /api/github/review-analysis` + Claude 패턴 분석 + 체크리스트)
- 5.1 반응형 모바일 UI + PWA
- 5.2 위젯 시스템
- 5.3 서버 모듈화 (6,000줄 → 132줄 entry + routes/ + lib/)

**전체 로드맵 구현 완료** (Phase 1-5)
