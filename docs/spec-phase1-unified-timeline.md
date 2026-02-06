# Phase 1: 통합 타임라인 & 데이터 허브

> 우선순위: P0 | 예상 기간: 1-2주
> 의존성: 없음 (현재 상태에서 바로 구현 가능)

## 개요

현재 Pain Point: 세션, 메모, 작업 이력, GitHub 활동이 각각 별도 탭에 존재하여 "오늘 내가 뭘 했는지" 전체 그림을 파악하기 어려움.

해결: 모든 활동 데이터를 시간순으로 통합하여 하나의 타임라인으로 제공.

---

## 1.1 통합 타임라인 뷰 (구현 완료)

### 데이터 소스 & 통합 방식

| 소스 | 서버 함수 | 타임라인 type |
|------|-----------|---------------|
| 작업 실행 | `jobHistory` (전역 변수) | `job` |
| Claude 세션 | `findSessions(date)` | `session` |
| 빠른 메모 | `loadQuickMemos()` | `memo` (source: dashboard) |
| Obsidian 메모 | `parseObsidianMemos(date)` | `memo` (source: obsidian) |
| GitHub 활동 | `getGhAccounts()` + `fetchGithubEventsForAccount()` | `github` |
| 모닝 플랜 | `loadMorningPlans()` | `plan` |

> 참고: `parseObsidianMemos(date)`는 기존 `/api/obsidian/daily-memos` 인라인 로직에서 헬퍼 함수로 추출됨. GitHub는 `Promise.allSettled`로 호출하여 실패 시에도 나머지 데이터 정상 반환.

### API: `GET /api/timeline`

```
GET /api/timeline?date=2026-02-06
```

**Response:**
```json
{
  "date": "2026-02-06",
  "items": [
    {
      "id": "job-1770340800544",
      "type": "job",
      "time": "2026-02-06T01:20:00.544Z",
      "title": "PR 리뷰 알림",
      "subtitle": "성공 (0.5s)",
      "icon": "job-success",
      "color": "green",
      "meta": { "jobId": "pr-review-reminder", "status": "success", "logId": 1770340800544 }
    },
    {
      "id": "session-704c131d-...",
      "type": "session",
      "time": "2026-02-06T01:12:35.675Z",
      "title": "dashboard",
      "subtitle": "첫 메시지 미리보기...",
      "icon": "session",
      "color": "purple",
      "meta": { "sessionId": "704c131d-...", "projectPath": "-Users-iyeongsu-ai-pipeline-dashboard" }
    },
    {
      "id": "memo-memo-123",
      "type": "memo",
      "time": "2026-02-06T09:30:00Z",
      "title": "ECS graceful shutdown 확인중",
      "icon": "memo",
      "color": "yellow",
      "meta": { "source": "dashboard", "memoId": "memo-123" }
    },
    {
      "id": "gh-pr-repo-123",
      "type": "github",
      "time": "2026-02-06T11:00:00Z",
      "title": "PR #2380 PROJECT-KEY-496 클라이언트 키 그룹 추가",
      "subtitle": "org-user / aicreation / opened",
      "icon": "github-pr",
      "color": "blue",
      "meta": { "url": "https://github.com/...", "repo": "org/aicreation" }
    },
    {
      "id": "plan-mp-123",
      "type": "plan",
      "time": "2026-02-06T01:45:45.559Z",
      "title": "하루 시작 계획",
      "subtitle": "목표 3개 / 업무 12개",
      "icon": "plan",
      "color": "orange",
      "meta": { "planId": "mp-123" }
    }
  ],
  "summary": {
    "sessions": 3,
    "memos": 5,
    "jobRuns": 12,
    "github": 2,
    "plans": 1
  }
}
```

### 프론트엔드 UI (index.html 홈 탭)

빠른 액션 버튼과 2열 레이아웃(최근 실행/메모) **사이**에 타임라인 배치:

```
[4칸 요약 카드]
[빠른 액션 3개]
[통합 타임라인]  ← 여기
[최근 실행 | 최근 메모]
```

**UI 구성요소:**
- **접기/펼치기**: 헤더 클릭으로 타임라인 본문 토글 (화살표 아이콘 회전)
- **타입 필터**: 작업/세션/메모/GitHub/플랜 chip 버튼 (토글, opacity로 비활성 표시)
- **시간 범위 슬라이더**: 0~24시 듀얼 핸들 드래그 (0.5시간 단위 스냅)
  - 데이터 로드 시 실제 활동 시간 범위로 자동 설정
  - 트랙 클릭으로 가까운 핸들 이동
- **시간대별 그루핑**: 오전(~12시) / 오후(12~18시) / 저녁(18시~) 섹션
- **타임라인 아이템**: 세로 라인 + 컬러 도트 + 시간 + 아이콘 + 제목/부제목

### 클릭 핸들러 (타임라인 → 상세 보기)

| type | 동작 |
|------|------|
| `session` | `showTab('sessions')` → `showSessionDetail(sessionId, projectPath)` |
| `job` | `showTab('jobs')` → `showJobSubTab('history')` → `showLogById(logId)` |
| `memo` | `showTab('notes')` |
| `plan` | `openMorningStart()` |
| `github` | `window.open(meta.url, '_blank')` |

### 주요 함수 (index.html)

| 함수 | 역할 |
|------|------|
| `loadTimeline()` | API fetch + 초기 시간 범위 설정 + 렌더링 |
| `renderTimeline()` | 필터/시간범위 적용 → 시간대별 그루핑 → HTML 생성 |
| `renderTimelineItem(item)` | 개별 아이템 HTML |
| `handleTimelineClick(type, meta)` | 클릭 시 상세 네비게이션 |
| `toggleTimelineFilter(type)` | 타입 필터 토글 |
| `toggleTimelineCollapse()` | 접기/펼치기 |
| `initTimeRangeSlider()` | 듀얼 핸들 드래그 이벤트 초기화 |
| `updateTimeRangeUI()` | 슬라이더 핸들/활성바/라벨 업데이트 |

---

## 1.2 통합 검색 (Global Search) — 미구현

### UI: Cmd+K 검색 모달

```html
<div id="globalSearchModal" class="modal fixed inset-0 bg-black/60 items-center justify-start pt-[20vh] z-50"
     style="display:none">
  <div class="bg-gray-800 rounded-xl w-full max-w-2xl mx-auto shadow-2xl border border-gray-700">
    <!-- 검색 입력 -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-gray-700">
      <span class="text-gray-500">🔍</span>
      <input id="globalSearchInput" type="text" placeholder="검색... (세션, 메모, 작업, 이력)"
        class="flex-1 bg-transparent text-lg outline-none text-gray-200"
        oninput="debounceGlobalSearch()" onkeydown="handleSearchKeydown(event)">
      <kbd class="text-xs text-gray-600 bg-gray-700 px-1.5 py-0.5 rounded">ESC</kbd>
    </div>
    <!-- 검색 결과 -->
    <div id="globalSearchResults" class="max-h-[50vh] overflow-y-auto p-2">
      <!-- 최근 검색 or 검색 결과 -->
    </div>
  </div>
</div>
```

### 새 API: `GET /api/search`

```
GET /api/search?q=graceful+shutdown&types=session,memo,job
```

**Response:**
```json
{
  "results": [
    {
      "type": "memo",
      "id": "memo-123",
      "title": "ECS 에서 graceful shutdown 확인중",
      "preview": "이때, 근데 dumb init 이 필요했던거 같음...",
      "date": "2026-02-06",
      "score": 0.95
    },
    {
      "type": "session",
      "id": "session-abc",
      "title": "ai-pipeline 세션",
      "preview": "...graceful shutdown 관련 코드 수정...",
      "date": "2026-02-06",
      "score": 0.8
    }
  ],
  "total": 2
}
```

### 키보드 단축키

```javascript
// Cmd+K or / 로 검색 열기
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openGlobalSearch();
  }
});
```

---

## 1.3 날짜 네비게이션 통합 — 미구현

홈 대시보드의 기존 요약 카드 위에 날짜 선택기 추가 (노트 탭의 패턴 재사용):

```html
<div class="flex items-center justify-between mb-6">
  <h2 class="text-xl font-bold">🏠 대시보드</h2>
  <!-- 날짜 선택기 (노트 탭과 동일 패턴) -->
  <div class="flex items-center gap-1 bg-gray-800 rounded-lg px-1 py-1">
    <button onclick="shiftHomeDate(-1)" class="...">‹</button>
    <button id="homeDateLabel" onclick="document.getElementById('homeDateInput').showPicker()" class="..."></button>
    <input type="date" id="homeDateInput" class="sr-only" onchange="setHomeDate(this.value)">
    <button onclick="shiftHomeDate(1)" id="homeDateNext" class="...">›</button>
    <button onclick="setHomeToday()" class="...">오늘</button>
  </div>
</div>
```

날짜 변경 시 → `loadHomeDashboard(date)` + 타임라인 로드.

---

## 검증 방법

### 1.1 통합 타임라인 (구현 완료)
1. `npm run dev` 서버 시작
2. http://localhost:3030 접속 → 홈 탭에 타임라인 표시 확인
3. 타임라인 항목 클릭 → 해당 상세 보기로 이동 확인
4. 타입 필터 chip 토글 → 항목 필터링 확인
5. 시간 범위 슬라이더 드래그 → 해당 시간대 항목만 표시 확인
6. 타임라인 헤더 클릭 → 접기/펼치기 확인
7. `curl "http://localhost:3030/api/timeline?date=2026-02-06" | jq` 로 API 응답 확인

### 1.2 통합 검색 (미구현)
- Cmd+K → 검색 모달 열림 확인
- 검색어 입력 → 결과 표시 + 클릭으로 이동 확인
- `curl "http://localhost:3030/api/search?q=graceful" | jq` 로 검색 API 확인

### 1.3 날짜 네비게이션 (미구현)
- 날짜 변경 → 해당 날짜 타임라인 로드 확인
