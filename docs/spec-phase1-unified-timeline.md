# Phase 1: 통합 타임라인 & 데이터 허브

> 우선순위: P0 | 예상 기간: 1-2주
> 의존성: 없음 (현재 상태에서 바로 구현 가능)

## 개요

현재 Pain Point: 세션, 메모, 작업 이력, GitHub 활동이 각각 별도 탭에 존재하여 "오늘 내가 뭘 했는지" 전체 그림을 파악하기 어려움.

해결: 모든 활동 데이터를 시간순으로 통합하여 하나의 타임라인으로 제공.

---

## 1.1 통합 타임라인 뷰

### 데이터 소스 & 통합 방식

| 소스 | API | 데이터 형태 |
|------|-----|-------------|
| 작업 실행 | `GET /api/history` | `{ jobName, status, startTime, duration }` |
| Claude 세션 | `GET /api/sessions` | `{ project, startTime, messageCount, alias }` |
| 빠른 메모 | `GET /api/quick-memos` | `{ content, timestamp }` |
| Obsidian 메모 | `GET /api/obsidian/daily-memos` | `{ content, time }` |
| GitHub 활동 | `GET /api/github/activity` | `{ commits[], prs[], reviews[] }` |
| 모닝 플랜 | `GET /api/morning-plan` | `{ markdown, createdAt }` |
| 백로그 변경 | `GET /api/backlogs` | `{ content, createdAt, done }` |

### 새 API: `GET /api/timeline`

```
GET /api/timeline?date=2026-02-06
```

**Response:**
```json
{
  "date": "2026-02-06",
  "items": [
    {
      "id": "tl-1",
      "type": "session",
      "time": "2026-02-06T09:00:00Z",
      "title": "ai-pipeline 세션",
      "subtitle": "45분 / 메시지 32개",
      "icon": "session",
      "color": "purple",
      "meta": { "sessionId": "abc123", "project": "ai-pipeline" }
    },
    {
      "id": "tl-2",
      "type": "memo",
      "time": "2026-02-06T09:30:00Z",
      "title": "ECS graceful shutdown 확인중",
      "icon": "memo",
      "color": "yellow",
      "meta": { "source": "obsidian" }
    },
    {
      "id": "tl-3",
      "type": "job",
      "time": "2026-02-06T10:00:00Z",
      "title": "GitHub 동기화",
      "subtitle": "성공 (3.2s)",
      "icon": "job-success",
      "color": "green",
      "meta": { "jobId": "sync-github", "status": "success" }
    },
    {
      "id": "tl-4",
      "type": "github",
      "time": "2026-02-06T11:00:00Z",
      "title": "PR #2380 - PROJECT-KEY-496 클라이언트 키 그룹 추가",
      "subtitle": "org-user / aicreation",
      "icon": "github-pr",
      "color": "blue",
      "meta": { "url": "https://github.com/...", "repo": "aicreation" }
    }
  ],
  "summary": {
    "sessions": 3,
    "memos": 5,
    "jobRuns": 12,
    "commits": 4,
    "prs": 2
  }
}
```

### 서버 구현 (server.js)

```javascript
// GET /api/timeline
app.get('/api/timeline', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const items = [];

  // 1. 작업 이력
  const history = loadHistory();
  history.filter(h => h.startTime?.startsWith(date)).forEach(h => {
    items.push({
      id: `job-${h.id}`,
      type: 'job',
      time: h.startTime,
      title: h.jobName || h.jobId,
      subtitle: `${h.status === 'success' ? '성공' : '실패'} (${(h.duration/1000).toFixed(1)}s)`,
      icon: h.status === 'success' ? 'job-success' : 'job-failed',
      color: h.status === 'success' ? 'green' : 'red',
      meta: { jobId: h.jobId, status: h.status, logId: h.id }
    });
  });

  // 2. 세션 (sessionDir 스캔)
  const sessions = await collectSessions(date);
  sessions.forEach(s => {
    items.push({
      id: `session-${s.id}`,
      type: 'session',
      time: s.startTime,
      title: s.alias || s.project,
      subtitle: s.alias ? `${s.project} / ${s.messageCount}개 메시지` : `${s.messageCount}개 메시지`,
      icon: 'session',
      color: 'purple',
      meta: { sessionId: s.id, project: s.project }
    });
  });

  // 3. 메모 (대시보드 + Obsidian)
  const dashMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(date));
  dashMemos.forEach(m => {
    items.push({
      id: `memo-${m.id}`,
      type: 'memo',
      time: m.timestamp,
      title: m.content?.substring(0, 100),
      icon: 'memo',
      color: 'yellow',
      meta: { source: 'dashboard', memoId: m.id }
    });
  });

  // Obsidian 메모
  const obsidianMemos = parseObsidianDailyMemos(date);
  obsidianMemos.forEach(m => {
    items.push({
      id: m.id,
      type: 'memo',
      time: m.timestamp,
      title: m.content?.substring(0, 100),
      icon: 'memo-obsidian',
      color: 'green',
      meta: { source: 'obsidian' }
    });
  });

  // 4. 모닝 플랜
  const plans = loadMorningPlans();
  const todayPlan = plans.find(p => p.date === date);
  if (todayPlan) {
    items.push({
      id: `plan-${todayPlan.id}`,
      type: 'plan',
      time: todayPlan.createdAt,
      title: '하루 시작 계획',
      subtitle: `목표 ${todayPlan.goals?.length || 0}개 / 업무 ${todayPlan.tasks?.length || 0}개`,
      icon: 'plan',
      color: 'orange',
      meta: { planId: todayPlan.id }
    });
  }

  // 시간순 정렬
  items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  // 요약
  const summary = {
    sessions: items.filter(i => i.type === 'session').length,
    memos: items.filter(i => i.type === 'memo').length,
    jobRuns: items.filter(i => i.type === 'job').length,
    plans: items.filter(i => i.type === 'plan').length
  };

  res.json({ date, items, summary });
});
```

### 프론트엔드 UI (index.html 홈 탭)

기존 홈 대시보드의 "최근 실행" + "최근 메모" 2열 레이아웃 아래에 타임라인 추가:

```html
<!-- 타임라인 영역 -->
<div class="mt-6">
  <div class="flex items-center justify-between mb-4">
    <h3 class="text-sm font-bold text-gray-300">📅 오늘의 타임라인</h3>
    <span id="homeTimelineCount" class="text-xs text-gray-500"></span>
  </div>
  <div id="homeTimeline" class="relative pl-6 border-l-2 border-gray-700 space-y-4">
    <!-- 타임라인 항목들 -->
  </div>
</div>
```

**타임라인 아이템 렌더링:**
```javascript
function renderTimelineItem(item) {
  const colors = {
    green: 'bg-green-500', red: 'bg-red-500', purple: 'bg-purple-500',
    yellow: 'bg-yellow-500', blue: 'bg-blue-500', orange: 'bg-orange-500'
  };
  const icons = {
    session: '🤖', memo: '📝', 'memo-obsidian': '📓',
    'job-success': '✅', 'job-failed': '❌',
    'github-pr': '🔀', 'github-commit': '📦',
    plan: '☀️'
  };
  const time = new Date(item.time).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit'
  });

  return `
    <div class="relative flex items-start gap-3 group cursor-pointer hover:bg-gray-800/30 p-2 -ml-2 rounded-lg transition-colors"
         onclick="handleTimelineClick('${item.type}', ${JSON.stringify(item.meta).replace(/"/g, '&quot;')})">
      <!-- 타임라인 도트 -->
      <div class="absolute -left-[25px] w-3 h-3 rounded-full ${colors[item.color]} border-2 border-gray-900 mt-1.5"></div>
      <!-- 시간 -->
      <span class="text-xs text-gray-600 w-14 flex-shrink-0 mt-0.5">${time}</span>
      <!-- 아이콘 -->
      <span class="flex-shrink-0">${icons[item.icon] || '📌'}</span>
      <!-- 내용 -->
      <div class="flex-1 min-w-0">
        <div class="text-sm text-gray-300 truncate">${escapeHtml(item.title)}</div>
        ${item.subtitle ? `<div class="text-xs text-gray-600">${escapeHtml(item.subtitle)}</div>` : ''}
      </div>
    </div>
  `;
}
```

**시간대별 그룹핑:**
```javascript
function groupTimelineByPeriod(items) {
  const groups = { morning: [], afternoon: [], evening: [] };
  items.forEach(item => {
    const hour = new Date(item.time).getHours();
    if (hour < 12) groups.morning.push(item);
    else if (hour < 18) groups.afternoon.push(item);
    else groups.evening.push(item);
  });
  return groups;
}
```

### 클릭 핸들러 (타임라인 → 상세 보기)

```javascript
function handleTimelineClick(type, meta) {
  switch (type) {
    case 'session':
      showTab('sessions');
      // 해당 세션 상세 열기
      setTimeout(() => showSessionDetail(meta.sessionId), 100);
      break;
    case 'job':
      showTab('jobs');
      showJobSubTab('history');
      setTimeout(() => showLogById(meta.logId), 100);
      break;
    case 'memo':
      showTab('notes');
      break;
    case 'plan':
      openMorningStart(); // 편집 모드로 열기
      break;
    case 'github':
      if (meta.url) window.open(meta.url, '_blank');
      break;
  }
}
```

---

## 1.2 통합 검색 (Global Search)

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

### 서버 구현

```javascript
app.get('/api/search', (req, res) => {
  const { q, types } = req.query;
  if (!q || q.length < 2) return res.json({ results: [], total: 0 });

  const query = q.toLowerCase();
  const allowedTypes = types ? types.split(',') : ['session', 'memo', 'job', 'backlog'];
  const results = [];

  // 메모 검색
  if (allowedTypes.includes('memo')) {
    const memos = loadQuickMemos();
    memos.filter(m => m.content?.toLowerCase().includes(query)).forEach(m => {
      results.push({
        type: 'memo', id: m.id,
        title: m.content.substring(0, 60),
        preview: m.content.substring(0, 120),
        date: m.timestamp?.split('T')[0],
        time: m.timestamp
      });
    });
  }

  // 세션 검색 (프로젝트명, alias)
  if (allowedTypes.includes('session')) {
    // 세션 목록에서 alias/project로 검색
  }

  // 작업 이력 검색
  if (allowedTypes.includes('job')) {
    const history = loadHistory();
    history.filter(h =>
      h.jobName?.toLowerCase().includes(query) ||
      h.stdout?.toLowerCase().includes(query)
    ).forEach(h => {
      results.push({
        type: 'job', id: h.id,
        title: h.jobName,
        preview: h.stdout?.substring(0, 120),
        date: h.startTime?.split('T')[0],
        time: h.startTime
      });
    });
  }

  // 백로그 검색
  if (allowedTypes.includes('backlog')) {
    const backlogs = loadBacklogs();
    backlogs.filter(b => b.content?.toLowerCase().includes(query)).forEach(b => {
      results.push({
        type: 'backlog', id: b.id,
        title: b.content.substring(0, 60),
        preview: b.content.substring(0, 120),
        date: b.createdAt?.split('T')[0],
        time: b.createdAt
      });
    });
  }

  // 최신순 정렬
  results.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  res.json({ results: results.slice(0, 20), total: results.length });
});
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

## 1.3 날짜 네비게이션 통합

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

1. `npm run dev` 서버 시작
2. http://localhost:3030 접속 → 홈 탭에 타임라인 표시 확인
3. 타임라인 항목 클릭 → 해당 상세 보기로 이동 확인
4. Cmd+K → 검색 모달 열림 확인
5. 검색어 입력 → 결과 표시 + 클릭으로 이동 확인
6. 날짜 변경 → 해당 날짜 타임라인 로드 확인
7. `curl http://localhost:3030/api/timeline?date=2026-02-06 | jq` 로 API 응답 확인
8. `curl "http://localhost:3030/api/search?q=graceful" | jq` 로 검색 API 확인
