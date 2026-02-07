# 실행 이력 개선 명세

## 개요
1. Slack 알림에 실행 이력 상세 링크 추가
2. 실행 이력 UI 개선 (페이지네이션, 검색, 날짜 필터)

---

## Part 1: Slack 알림에 링크 추가

### 현재 상태
- Slack 알림 전송 시 작업명, 상태, 출력만 표시
- 대시보드 링크 없음

### 목표
알림 클릭 시 해당 실행 이력 상세 페이지로 바로 이동

### 구현

#### 1. 실행 이력 ID 기반 URL 생성

**파일**: `server.js`

```javascript
// 대시보드 URL (환경변수 또는 기본값)
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3030';

function getHistoryDetailUrl(logId) {
  return `${DASHBOARD_URL}?tab=history&logId=${logId}`;
}
```

#### 2. sendSlackNotification 함수 수정

**파일**: `server.js`

```javascript
function sendSlackNotification(job, status, result = {}) {
  // ... 기존 코드 ...

  // 링크 버튼 추가
  message.blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "📋 상세 보기",
          emoji: true
        },
        url: getHistoryDetailUrl(result.logId),
        action_id: "view_detail"
      }
    ]
  });

  // ... 전송 로직 ...
}
```

#### 3. executeJob에서 logId 전달

**파일**: `server.js`

```javascript
// executeJob 함수 내 Slack 알림 호출 부분 수정

// 성공 시
if (shouldNotifySlack) {
  sendSlackNotification(job, 'success', {
    duration,
    stdout: logEntry.stdout,
    logId: logEntry.id  // logId 추가
  });
}

// 실패 시
if (shouldNotifySlack) {
  sendSlackNotification(job, 'failed', {
    duration,
    error: logEntry.error,
    stdout: logEntry.stdout,
    stderr: logEntry.stderr,
    logId: logEntry.id  // logId 추가
  });
}
```

#### 4. 프론트엔드에서 URL 파라미터 처리

**파일**: `public/index.html`

```javascript
// 페이지 로드 시 URL 파라미터 확인
function handleUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  const logId = params.get('logId');

  if (tab === 'history') {
    showTab('history');

    if (logId) {
      // 히스토리 로드 후 해당 로그 모달 열기
      loadHistory().then(() => {
        const index = historyData.findIndex(h => h.id === parseInt(logId));
        if (index !== -1) {
          showLog(index);
        }
      });
    }
  }
}

// Init에서 호출
// loadJobs();
// populateCategorySelect();
handleUrlParams() || loadJobs();  // URL 파라미터 없으면 기본 로드
```

---

## Part 2: 실행 이력 UI 개선

### 현재 상태
- 최근 50개 이력만 표시
- 검색/필터 없음
- 스크롤로만 탐색

### 목표
- 페이지네이션 (10개씩)
- 작업명 검색
- 날짜 범위 선택
- 상태 필터 (성공/실패/실행중)

---

### 1. 서버 API 확장

**파일**: `server.js`

#### GET /api/history 수정

```javascript
app.get('/api/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const jobId = req.query.jobId;
  const search = req.query.search;
  const status = req.query.status;  // success, failed, running
  const startDate = req.query.startDate;  // YYYY-MM-DD
  const endDate = req.query.endDate;      // YYYY-MM-DD

  let history = [...jobHistory].reverse();

  // 필터: 작업 ID
  if (jobId) {
    history = history.filter(h => h.jobId === jobId);
  }

  // 필터: 검색 (작업명)
  if (search) {
    const searchLower = search.toLowerCase();
    history = history.filter(h =>
      h.jobName.toLowerCase().includes(searchLower)
    );
  }

  // 필터: 상태
  if (status) {
    history = history.filter(h => h.status === status);
  }

  // 필터: 날짜 범위
  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    history = history.filter(h => new Date(h.startTime) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    history = history.filter(h => new Date(h.startTime) <= end);
  }

  // 페이지네이션
  const total = history.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = history.slice(offset, offset + limit);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  });
});
```

---

### 2. 프론트엔드 UI

**파일**: `public/index.html`

#### 2.1 필터 UI 추가 (History 탭 상단)

```html
<!-- History Tab -->
<div id="panel-history" class="hidden">
  <!-- 필터 영역 -->
  <div class="bg-gray-800 rounded-lg p-4 mb-4">
    <div class="flex flex-wrap gap-4 items-end">
      <!-- 검색 -->
      <div class="flex-1 min-w-[200px]">
        <label class="block text-sm text-gray-400 mb-1">검색</label>
        <input type="text" id="historySearch" placeholder="작업명 검색..."
          class="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          onkeyup="debounceHistorySearch()">
      </div>

      <!-- 상태 필터 -->
      <div class="w-32">
        <label class="block text-sm text-gray-400 mb-1">상태</label>
        <select id="historyStatus"
          class="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          onchange="loadHistoryFiltered()">
          <option value="">전체</option>
          <option value="success">성공</option>
          <option value="failed">실패</option>
          <option value="running">실행중</option>
        </select>
      </div>

      <!-- 시작 날짜 -->
      <div class="w-40">
        <label class="block text-sm text-gray-400 mb-1">시작일</label>
        <input type="date" id="historyStartDate"
          class="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          onchange="loadHistoryFiltered()">
      </div>

      <!-- 종료 날짜 -->
      <div class="w-40">
        <label class="block text-sm text-gray-400 mb-1">종료일</label>
        <input type="date" id="historyEndDate"
          class="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          onchange="loadHistoryFiltered()">
      </div>

      <!-- 초기화 버튼 -->
      <button onclick="resetHistoryFilters()"
        class="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm">
        초기화
      </button>
    </div>
  </div>

  <!-- 테이블 -->
  <div class="bg-gray-800 rounded-lg overflow-hidden">
    <table class="w-full">
      <thead class="bg-gray-700">
        <tr>
          <th class="px-4 py-3 text-left text-sm font-medium">작업</th>
          <th class="px-4 py-3 text-left text-sm font-medium">트리거</th>
          <th class="px-4 py-3 text-left text-sm font-medium">시작 시간</th>
          <th class="px-4 py-3 text-left text-sm font-medium">소요 시간</th>
          <th class="px-4 py-3 text-left text-sm font-medium">상태</th>
          <th class="px-4 py-3 text-left text-sm font-medium">상세</th>
        </tr>
      </thead>
      <tbody id="historyTable" class="divide-y divide-gray-700">
        <!-- History will be loaded here -->
      </tbody>
    </table>
  </div>

  <!-- 페이지네이션 -->
  <div id="historyPagination" class="flex items-center justify-between mt-4">
    <div id="historyInfo" class="text-sm text-gray-400">
      <!-- 예: 1-10 / 총 45건 -->
    </div>
    <div class="flex gap-2">
      <button id="historyPrevBtn" onclick="loadHistoryPage('prev')"
        class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">
        ← 이전
      </button>
      <div id="historyPageNumbers" class="flex gap-1">
        <!-- 페이지 번호 버튼들 -->
      </div>
      <button id="historyNextBtn" onclick="loadHistoryPage('next')"
        class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">
        다음 →
      </button>
    </div>
  </div>
</div>
```

#### 2.2 JavaScript 로직

```javascript
// 이력 관련 상태
let historyPagination = { page: 1, totalPages: 1 };
let historySearchTimeout = null;

// 검색 디바운스
function debounceHistorySearch() {
  clearTimeout(historySearchTimeout);
  historySearchTimeout = setTimeout(() => {
    loadHistoryFiltered();
  }, 300);
}

// 필터 적용하여 이력 로드
async function loadHistoryFiltered(page = 1) {
  const search = document.getElementById('historySearch').value;
  const status = document.getElementById('historyStatus').value;
  const startDate = document.getElementById('historyStartDate').value;
  const endDate = document.getElementById('historyEndDate').value;

  const params = new URLSearchParams();
  params.set('page', page);
  params.set('limit', 10);
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);

  const res = await fetch(`${API_BASE}/api/history?${params}`);
  const data = await res.json();

  historyData = data.items;
  historyPagination = data.pagination;

  renderHistory(historyData);
  renderHistoryPagination(data.pagination);
}

// 기존 loadHistory 수정
async function loadHistory() {
  return loadHistoryFiltered(1);
}

// 페이지네이션 렌더링
function renderHistoryPagination(pagination) {
  const { page, totalPages, total, limit } = pagination;

  // 정보 텍스트
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  document.getElementById('historyInfo').textContent =
    total > 0 ? `${start}-${end} / 총 ${total}건` : '결과 없음';

  // 이전/다음 버튼
  document.getElementById('historyPrevBtn').disabled = !pagination.hasPrev;
  document.getElementById('historyNextBtn').disabled = !pagination.hasNext;

  // 페이지 번호
  const pageNumbers = document.getElementById('historyPageNumbers');
  pageNumbers.innerHTML = '';

  // 최대 5개 페이지 번호 표시
  let startPage = Math.max(1, page - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) {
    startPage = Math.max(1, endPage - 4);
  }

  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    btn.className = `px-3 py-1 rounded text-sm ${
      i === page
        ? 'bg-blue-600 text-white'
        : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
    }`;
    btn.onclick = () => loadHistoryFiltered(i);
    pageNumbers.appendChild(btn);
  }
}

// 페이지 이동
function loadHistoryPage(direction) {
  const newPage = direction === 'next'
    ? historyPagination.page + 1
    : historyPagination.page - 1;
  loadHistoryFiltered(newPage);
}

// 필터 초기화
function resetHistoryFilters() {
  document.getElementById('historySearch').value = '';
  document.getElementById('historyStatus').value = '';
  document.getElementById('historyStartDate').value = '';
  document.getElementById('historyEndDate').value = '';
  loadHistoryFiltered(1);
}
```

#### 2.3 renderHistory 함수 수정

기존 함수는 그대로 사용 가능. 단, 빈 상태 메시지 수정:

```javascript
function renderHistory(history) {
  const container = document.getElementById('historyTable');

  if (history.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="6" class="px-4 py-8 text-center text-gray-400">
          검색 결과가 없습니다
        </td>
      </tr>
    `;
    return;
  }

  // ... 기존 렌더링 로직 (index 대신 h.id 사용하도록 수정) ...
  container.innerHTML = history.map((h) => {
    // ...
    <td class="px-4 py-3">
      <button onclick="showLogById(${h.id})" class="text-blue-400 hover:underline text-sm">
        상세
      </button>
    </td>
    // ...
  }).join('');
}
```

#### 2.4 showLogById 함수 추가

```javascript
function showLogById(logId) {
  const entry = historyData.find(h => h.id === logId);
  if (!entry) return;

  stopLiveLogPolling();

  // 명령어 표시
  const cmdSection = document.getElementById('logCommandSection');
  const cmdEl = document.getElementById('logCommand');
  if (entry.command) {
    cmdEl.textContent = entry.command;
    cmdSection.classList.remove('hidden');
  } else {
    cmdSection.classList.add('hidden');
  }

  document.getElementById('logStdout').textContent = entry.stdout || '(없음)';
  document.getElementById('logStderr').textContent = entry.stderr || entry.error || '(없음)';
  document.getElementById('logModal').classList.add('active');
}
```

---

## 스타일 추가

**파일**: `public/index.html` (style 태그 내)

```css
/* Date input 다크 테마 */
input[type="date"] {
  color-scheme: dark;
}

/* 페이지네이션 버튼 비활성화 */
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

---

## 검증 체크리스트

### Slack 링크
1. [ ] Slack 알림에 "상세 보기" 버튼 표시되는지 확인
2. [ ] 버튼 클릭 시 대시보드 해당 이력으로 이동하는지 확인
3. [ ] logId 파라미터로 로그 모달 자동 열리는지 확인

### 실행 이력 UI
4. [ ] 검색 입력 시 작업명 필터링 되는지 확인
5. [ ] 상태 필터 (성공/실패/실행중) 동작 확인
6. [ ] 날짜 범위 선택 동작 확인
7. [ ] 페이지네이션 동작 확인 (이전/다음/번호 클릭)
8. [ ] 필터 초기화 버튼 동작 확인
9. [ ] 빈 결과 시 "검색 결과가 없습니다" 표시 확인

---

## 파일 변경 요약

| 파일 | 변경 내용 |
|------|----------|
| `server.js` | sendSlackNotification에 링크 버튼 추가, GET /api/history 페이지네이션/필터 지원 |
| `public/index.html` | 필터 UI, 페이지네이션 UI, 관련 JS 함수 추가 |

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DASHBOARD_URL` | `http://localhost:3030` | Slack 링크용 대시보드 URL |

프로덕션 배포 시 설정 필요:
```bash
export DASHBOARD_URL=https://your-dashboard.com
```
