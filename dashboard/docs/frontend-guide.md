# 프론트엔드 가이드

`public/index.html`의 구조와 주요 JavaScript 함수를 설명합니다.

## 파일 위치
- `public/index.html` - 메인 대시보드 (약 3000줄)
- `public/quick-input.html` - 빠른 입력 (Electron)
- `public/popup/popup.html` - 인터랙티브 팝업 (Electron)
- `public/popup/popup.js` - 팝업 로직

## 사용 라이브러리

```html
<!-- Tailwind CSS -->
<script src="https://cdn.tailwindcss.com"></script>

<!-- vis-network (그래프 시각화) -->
<link href="https://unpkg.com/vis-network@9.1.9/styles/vis-network.min.css" rel="stylesheet">
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>

<!-- Chart.js (통계 차트) -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
```

## HTML 구조

```html
<body>
  <!-- Toast Container (알림) -->
  <div id="toastContainer"></div>

  <!-- Header -->
  <header>
    <h1>AI Pipeline Dashboard</h1>
    <span id="jobCount">0 jobs scheduled</span>
    <button onclick="openAddModal()">+ 작업 추가</button>
  </header>

  <main>
    <!-- Tabs -->
    <div>
      <button onclick="showTab('jobs')">작업 목록</button>
      <button onclick="showTab('history')">실행 이력</button>
      <button onclick="showTab('stats')">통계</button>
      <button onclick="showTab('settings')">설정</button>
      <button onclick="showTab('sessions')">세션</button>
    </div>

    <!-- Panel: Jobs -->
    <div id="panel-jobs">
      <!-- Today Summary Widget -->
      <div id="todaySummaryWidget">...</div>

      <!-- View Toggle -->
      <button onclick="setView('card')">카드</button>
      <button onclick="setView('graph')">그래프</button>

      <!-- Jobs Grid (카드 뷰) -->
      <div id="jobsGrid"></div>

      <!-- Graph View -->
      <div id="graphView">
        <div id="graphCanvas"></div>
        <div id="graphSidePanel"></div>
      </div>
    </div>

    <!-- Panel: History -->
    <div id="panel-history">...</div>

    <!-- Panel: Stats -->
    <div id="panel-stats">...</div>

    <!-- Panel: Settings -->
    <div id="panel-settings">...</div>

    <!-- Panel: Sessions -->
    <div id="panel-sessions">...</div>
  </main>

  <!-- Modals -->
  <div id="addModal">...</div>
  <div id="runModal">...</div>
  <div id="logModal">...</div>
  <div id="scheduleModal">...</div>
</body>
```

## 전역 변수

```javascript
// 데이터 상태
let jobs = [];              // 작업 목록
let edges = [];             // 엣지 목록
let categories = {};        // 카테고리 정의
let settings = {};          // 전역 설정
let currentJobId = null;    // 현재 선택된 작업 ID

// UI 상태
let currentView = 'card';   // 'card' | 'graph'
let currentCategory = null; // 필터링 카테고리
let currentTab = 'jobs';    // 현재 탭

// 그래프 관련
let network = null;         // vis-network 인스턴스
let nodesDataset = null;    // vis DataSet (노드)
let edgesDataset = null;    // vis DataSet (엣지)

// 히스토리 페이지네이션
let historyPage = 1;
let historyLimit = 10;

// 차트 인스턴스
let trendChart = null;
let hourlyChart = null;
let jobsChart = null;

// 폴링 인터벌
let refreshInterval = null;
let liveLogInterval = null;
```

## 핵심 함수

### 1. 초기화

```javascript
/**
 * 페이지 로드 시 초기화
 */
document.addEventListener('DOMContentLoaded', () => {
  loadJobs();           // 작업 목록 로드
  loadCategories();     // 카테고리 로드
  loadSettings();       // 설정 로드
  startAutoRefresh();   // 자동 새로고침 시작

  // URL 파라미터 처리
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab')) {
    showTab(params.get('tab'));
  }
  if (params.get('logId')) {
    showLogDetail(params.get('logId'));
  }
});
```

### 2. 데이터 로드

```javascript
/**
 * 작업 목록 로드
 */
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();

    jobs = data.jobs || [];
    edges = data.edges || [];
    categories = data.categories || {};
    settings = data.settings || {};

    renderCategoryFilter();
    renderJobs();
    updateJobCount();

    if (currentView === 'graph') {
      renderGraph();
    }
  } catch (error) {
    showToast('작업 목록을 불러오지 못했습니다', 'error');
  }
}

/**
 * 히스토리 로드 (필터링 + 페이지네이션)
 */
async function loadHistoryFiltered() {
  const search = document.getElementById('historySearch').value;
  const status = document.getElementById('historyStatus').value;
  const startDate = document.getElementById('historyStartDate').value;
  const endDate = document.getElementById('historyEndDate').value;

  const params = new URLSearchParams({
    page: historyPage,
    limit: historyLimit,
    ...(search && { search }),
    ...(status && { status }),
    ...(startDate && { startDate }),
    ...(endDate && { endDate })
  });

  const res = await fetch(`/api/history?${params}`);
  const data = await res.json();

  renderHistory(data.items);
  renderPagination(data.pagination);
}
```

### 3. 렌더링

```javascript
/**
 * 작업 카드 렌더링
 */
function renderJobs() {
  const grid = document.getElementById('jobsGrid');
  const filteredJobs = currentCategory
    ? jobs.filter(j => j.category === currentCategory)
    : jobs;

  grid.innerHTML = filteredJobs.map(job => `
    <div class="job-card bg-gray-800 rounded-lg p-4 border border-gray-700"
         data-job-id="${job.id}">

      <!-- 헤더: 상태 표시 + 이름 -->
      <div class="flex items-center gap-2 mb-2">
        <span class="status-dot ${getStatusClass(job)}"></span>
        <h3 class="font-medium">${job.name}</h3>
      </div>

      <!-- 설명 -->
      <p class="text-sm text-gray-400 line-clamp-2 mb-3">
        ${job.description || ''}
      </p>

      <!-- 스케줄 정보 -->
      <div class="text-xs text-gray-500 mb-3">
        ${job.schedule ? `⏰ ${job.schedule}` : '수동 실행'}
      </div>

      <!-- 태그 -->
      <div class="flex flex-wrap gap-1 mb-3">
        ${(job.tags || []).map(tag =>
          `<span class="px-2 py-0.5 bg-gray-700 rounded text-xs">${tag}</span>`
        ).join('')}
      </div>

      <!-- 액션 버튼 -->
      <div class="flex gap-2">
        <button onclick="openRunModal('${job.id}')"
                class="flex-1 px-3 py-1.5 bg-blue-600 rounded text-sm">
          ▶ 실행
        </button>
        <button onclick="toggleJob('${job.id}')"
                class="px-3 py-1.5 bg-gray-700 rounded text-sm">
          ${job.enabled ? '⏸' : '▶'}
        </button>
        <button onclick="openEditModal('${job.id}')"
                class="px-3 py-1.5 bg-gray-700 rounded text-sm">
          ✏️
        </button>
      </div>
    </div>
  `).join('');
}

/**
 * 상태 클래스 결정
 */
function getStatusClass(job) {
  if (job.isRunning) return 'bg-yellow-500 pulse';
  if (job.enabled && job.isScheduled) return 'bg-green-500';
  return 'bg-gray-500';
}
```

### 4. 그래프 뷰

```javascript
/**
 * vis-network 그래프 렌더링
 */
function renderGraph() {
  const container = document.getElementById('graphCanvas');

  // 노드 데이터 생성
  const nodes = jobs.map(job => ({
    id: job.id,
    label: job.name,
    color: {
      background: job.isRunning ? '#fbbf24' :
                  job.enabled ? getCategoryColor(job.category) : '#6b7280',
      border: job.isRunning ? '#f59e0b' : '#4b5563'
    },
    x: job.position?.x,
    y: job.position?.y,
    font: { color: '#e5e7eb' }
  }));

  // 엣지 데이터 생성
  const edgeData = edges.map(edge => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label || '',
    arrows: 'to',
    color: {
      color: edge.trigger ? '#10b981' : '#6b7280'
    },
    dashes: !edge.trigger,
    smooth: { type: 'curvedCW', roundness: 0.2 }
  }));

  // DataSet 생성
  nodesDataset = new vis.DataSet(nodes);
  edgesDataset = new vis.DataSet(edgeData);

  // 옵션
  const options = {
    nodes: {
      shape: 'box',
      borderWidth: 2,
      margin: 10,
      font: { size: 14 }
    },
    edges: {
      font: { size: 12, color: '#9ca3af' }
    },
    physics: {
      enabled: false  // 수동 배치
    },
    manipulation: {
      enabled: true,
      addEdge: (data, callback) => {
        createEdge(data.from, data.to);
        callback(null);  // 취소 (API로 추가)
      }
    },
    interaction: {
      hover: true
    }
  };

  // 네트워크 생성
  network = new vis.Network(container, {
    nodes: nodesDataset,
    edges: edgesDataset
  }, options);

  // 이벤트 핸들러
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      openSidePanel(nodeId);
    }
  });

  network.on('oncontext', (params) => {
    params.event.preventDefault();
    if (params.nodes.length > 0) {
      showContextMenu(params.event, params.nodes[0]);
    }
  });

  network.on('dragEnd', (params) => {
    if (params.nodes.length > 0) {
      // 위치 변경 추적 (나중에 저장)
    }
  });
}

/**
 * 모든 노드 위치 저장
 */
async function saveAllPositions() {
  const positions = jobs.map(job => {
    const pos = network.getPositions([job.id])[job.id];
    return { id: job.id, position: pos };
  });

  await fetch('/api/jobs/positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions })
  });

  showToast('위치가 저장되었습니다', 'success');
}

/**
 * 자동 레이아웃
 */
function autoLayoutGraph() {
  network.setOptions({
    physics: {
      enabled: true,
      stabilization: { iterations: 100 }
    }
  });

  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
  });
}
```

### 5. 작업 실행

```javascript
/**
 * 실행 모달 열기
 */
function openRunModal(jobId) {
  currentJobId = jobId;
  const job = jobs.find(j => j.id === jobId);

  document.getElementById('runModalTitle').textContent = job.name;

  // 옵션 폼 생성
  const optionsForm = document.getElementById('runOptionsForm');
  optionsForm.innerHTML = (job.options || []).map(opt => {
    if (opt.type === 'boolean') {
      return `
        <label class="flex items-center gap-2">
          <input type="checkbox" name="${opt.flag || opt.arg}"
                 ${opt.default ? 'checked' : ''}>
          <span>${opt.label}</span>
        </label>
        <p class="text-xs text-gray-500">${opt.description || ''}</p>
      `;
    } else if (opt.type === 'string') {
      return `
        <label class="block">
          <span>${opt.label}</span>
          <input type="text" name="${opt.flag || opt.arg}"
                 value="${opt.default || ''}"
                 placeholder="${opt.placeholder || ''}"
                 class="w-full bg-gray-700 rounded px-3 py-2">
        </label>
      `;
    } else if (opt.type === 'array') {
      return renderArrayInput(opt);
    } else if (opt.type === 'select') {
      return `
        <label class="block">
          <span>${opt.label}</span>
          <select name="${opt.flag || opt.arg}" class="w-full bg-gray-700 rounded px-3 py-2">
            ${opt.choices.map(c =>
              `<option value="${c}" ${c === opt.default ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </label>
      `;
    }
  }).join('');

  document.getElementById('runModal').classList.add('active');
}

/**
 * 작업 실행
 */
async function executeJob() {
  const job = jobs.find(j => j.id === currentJobId);
  const form = document.getElementById('runOptionsForm');
  const options = {};

  // 폼에서 옵션 수집
  for (const opt of job.options || []) {
    const key = opt.flag || opt.arg;
    const input = form.querySelector(`[name="${key}"]`);

    if (opt.type === 'boolean') {
      options[key] = input.checked;
    } else if (opt.type === 'array') {
      options[key] = getArrayInputValue(key);
    } else {
      options[key] = input.value;
    }
  }

  closeRunModal();
  showToast(`${job.name} 실행 중...`, 'info');

  try {
    const res = await fetch(`/api/jobs/${currentJobId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options })
    });

    const result = await res.json();

    if (result.success) {
      showToast(`${job.name} 완료`, 'success');
    } else {
      showToast(`${job.name} 실패: ${result.error}`, 'error');
    }
  } catch (error) {
    showToast(`실행 오류: ${error.message}`, 'error');
  }

  loadJobs();  // 상태 새로고침
}
```

### 6. 실시간 로그

```javascript
/**
 * 실시간 로그 폴링 시작
 */
function startLiveLog(jobId) {
  stopLiveLog();

  liveLogInterval = setInterval(async () => {
    const res = await fetch(`/api/jobs/${jobId}/live-log`);
    const data = await res.json();

    const logContent = document.getElementById('logContent');

    if (data.running) {
      logContent.innerHTML = `
        <div class="text-yellow-400 mb-2">⏳ 실행 중... (${Math.round(data.elapsed/1000)}s)</div>
        <pre class="text-green-400">${escapeHtml(data.stdout)}</pre>
        ${data.stderr ? `<pre class="text-red-400">${escapeHtml(data.stderr)}</pre>` : ''}
      `;
    } else {
      // 완료됨 - 폴링 중지
      stopLiveLog();
      logContent.innerHTML = `
        <div class="${data.status === 'success' ? 'text-green-400' : 'text-red-400'} mb-2">
          ${data.status === 'success' ? '✅ 완료' : '❌ 실패'}
          (${(data.duration/1000).toFixed(1)}s)
        </div>
        <pre class="text-green-400">${escapeHtml(data.stdout)}</pre>
        ${data.stderr ? `<pre class="text-red-400">${escapeHtml(data.stderr)}</pre>` : ''}
        ${data.error ? `<div class="text-red-500 mt-2">${data.error}</div>` : ''}
      `;
    }

    // 스크롤 하단으로
    logContent.scrollTop = logContent.scrollHeight;
  }, 1000);
}

function stopLiveLog() {
  if (liveLogInterval) {
    clearInterval(liveLogInterval);
    liveLogInterval = null;
  }
}
```

### 7. 통계 차트

```javascript
/**
 * 통계 탭 로드
 */
async function loadStats() {
  const days = document.getElementById('statsDays').value || 7;

  // 요약 통계
  const summaryRes = await fetch(`/api/stats/summary?days=${days}`);
  const summary = await summaryRes.json();
  renderStatsSummary(summary);

  // 트렌드 차트
  const trendRes = await fetch(`/api/stats/trend?days=${days}`);
  const trend = await trendRes.json();
  renderTrendChart(trend);

  // 시간대별 차트
  const hourlyRes = await fetch(`/api/stats/hourly?days=${days}`);
  const hourly = await hourlyRes.json();
  renderHourlyChart(hourly);

  // 작업별 통계
  const jobsRes = await fetch(`/api/stats/jobs?days=${days}`);
  const jobStats = await jobsRes.json();
  renderJobsStats(jobStats);
}

/**
 * 트렌드 차트 렌더링
 */
function renderTrendChart(data) {
  const ctx = document.getElementById('trendChart').getContext('2d');

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.date.slice(5)),  // MM-DD
      datasets: [
        {
          label: '성공',
          data: data.map(d => d.success),
          backgroundColor: '#10b981'
        },
        {
          label: '실패',
          data: data.map(d => d.failed),
          backgroundColor: '#ef4444'
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true }
      },
      plugins: {
        legend: { position: 'bottom' }
      }
    }
  });
}
```

### 8. 토스트 알림

```javascript
/**
 * 토스트 알림 표시
 * @param {string} message - 메시지
 * @param {string} type - 'success' | 'error' | 'info' | 'warning'
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const id = Date.now();

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  const toast = document.createElement('div');
  toast.id = `toast-${id}`;
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" onclick="dismissToast(${id})">&times;</button>
  `;

  container.appendChild(toast);

  // 5초 후 자동 닫기
  setTimeout(() => dismissToast(id), 5000);
}

function dismissToast(id) {
  const toast = document.getElementById(`toast-${id}`);
  if (toast) {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }
}
```

### 9. 자동 새로고침

```javascript
/**
 * 자동 새로고침 시작
 */
function startAutoRefresh() {
  const interval = (settings.refreshInterval || 5) * 1000;

  refreshInterval = setInterval(() => {
    if (currentTab === 'jobs') {
      loadJobs();
    } else if (currentTab === 'history') {
      loadHistoryFiltered();
    }
  }, interval);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
```

### 10. 유틸리티

```javascript
/**
 * HTML 이스케이프
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 카테고리 색상 가져오기
 */
function getCategoryColor(categoryId) {
  return categories[categoryId]?.color || '#6b7280';
}

/**
 * 날짜 포맷
 */
function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * 기간 포맷
 */
function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;
}

/**
 * 디바운스
 */
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// 검색 디바운스 적용
const debounceHistorySearch = debounce(loadHistoryFiltered, 300);
```

## CSS 클래스 참조

```css
/* 상태 표시 */
.status-dot { width: 8px; height: 8px; border-radius: 50%; }
.pulse { animation: pulse 2s infinite; }

/* 작업 카드 */
.job-card { transition: all 0.2s ease; }
.job-card:hover { transform: translateY(-2px); }

/* 모달 */
.modal { display: none; }
.modal.active { display: flex; }

/* 토스트 */
.toast { animation: toast-in 0.3s ease; }
.toast.toast-out { animation: toast-out 0.3s ease forwards; }

/* 그래프 뷰 */
.graph-controls { position: absolute; top: 12px; left: 12px; }
.zoom-controls { position: absolute; bottom: 12px; left: 12px; }
.graph-legend { position: absolute; bottom: 12px; right: 12px; }
.graph-side-panel { transform: translateX(100%); transition: 0.2s; }
.graph-side-panel.open { transform: translateX(0); }
```

## 이벤트 플로우

```
사용자 클릭: "▶ 실행" 버튼
    │
    ▼
openRunModal(jobId)
    │
    ├── currentJobId = jobId
    ├── 옵션 폼 생성
    └── 모달 표시
    │
    ▼
사용자: 옵션 선택 후 "실행" 클릭
    │
    ▼
executeJob()
    │
    ├── 옵션 수집
    ├── POST /api/jobs/:id/run
    ├── showToast("실행 중...")
    │
    ▼
서버: executeJob() 실행
    │
    ▼
응답 수신
    │
    ├── 성공: showToast("완료", "success")
    └── 실패: showToast("실패: ...", "error")
    │
    ▼
loadJobs() - 상태 새로고침
```
