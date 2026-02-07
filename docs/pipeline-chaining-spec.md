# Pipeline Chaining 기능 명세

## 개요
그래프 뷰에서 연결된 작업들이 순차적으로 자동 실행되는 파이프라인 체이닝 기능

## 현재 상태
- 그래프 뷰 구현 완료 (vis-network)
- Edge CRUD API 존재 (`/api/edges`)
- Edge 데이터: `{ id, from, to, label }`

## 목표
A 작업 완료 시 → 연결된 B 작업 자동 실행

---

## 데이터 모델 변경

### Edge 스키마 확장
**파일**: `jobs.json`

```json
{
  "edges": [
    {
      "id": "edge-1",
      "from": "daily-init",
      "to": "daily-update",
      "label": "",
      "trigger": true,
      "onSuccess": true
    }
  ]
}
```

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `id` | string | - | 고유 ID |
| `from` | string | - | 소스 작업 ID |
| `to` | string | - | 타겟 작업 ID |
| `label` | string | "" | 연결선 라벨 (선택) |
| `trigger` | boolean | false | true면 자동 실행 트리거 |
| `onSuccess` | boolean | true | true=성공시만, false=항상 |

---

## 서버 로직 변경

### 파일: `server.js`

### 1. executeJob 함수 수정

작업 완료 후 연결된 다음 작업을 찾아 실행하는 로직 추가:

```javascript
// executeJob 함수 내 child.on('close') 콜백에서
// 작업 완료 후 체이닝 처리

child.on('close', async (code) => {
  // ... 기존 로그 처리 ...

  // 체이닝: 다음 작업 실행
  const status = code === 0 ? 'success' : 'failed';
  await triggerNextJobs(job.id, status, logEntry);

  // ... 기존 resolve/reject ...
});
```

### 2. triggerNextJobs 함수 추가

```javascript
/**
 * 작업 완료 후 연결된 다음 작업들을 실행
 * @param {string} jobId - 완료된 작업 ID
 * @param {string} status - 'success' | 'failed'
 * @param {object} prevLog - 이전 작업의 로그 (stdout, stderr 등)
 */
async function triggerNextJobs(jobId, status, prevLog) {
  const data = loadJobs();
  const edges = data.edges || [];

  // 이 작업에서 나가는 trigger edge 찾기
  const triggerEdges = edges.filter(e =>
    e.from === jobId &&
    e.trigger === true &&
    (e.onSuccess === false || status === 'success')
  );

  if (triggerEdges.length === 0) return;

  console.log(`[Chain] ${jobId} completed (${status}), triggering ${triggerEdges.length} jobs`);

  for (const edge of triggerEdges) {
    const nextJob = data.jobs.find(j => j.id === edge.to);
    if (!nextJob) continue;

    // 비동기로 다음 작업 실행 (대기하지 않음)
    executeJob(nextJob, 'chained', {})
      .catch(err => console.error(`[Chain] Failed to execute ${nextJob.id}:`, err.message));
  }
}
```

### 3. 실행 이력에 trigger 타입 추가

`trigger` 필드에 'chained' 값 지원:
- `manual`: 수동 실행
- `scheduled`: 스케줄 실행
- `chained`: 체이닝으로 실행

---

## API 변경

### POST /api/edges 수정

요청 body에 trigger, onSuccess 필드 추가 지원:

```javascript
app.post('/api/edges', (req, res) => {
  const { from, to, label, trigger, onSuccess } = req.body;

  // ... 기존 검증 ...

  const newEdge = {
    id: `edge-${Date.now()}`,
    from,
    to,
    label: label || '',
    trigger: trigger ?? false,      // 기본값 false
    onSuccess: onSuccess ?? true    // 기본값 true
  };

  // ... 저장 ...
});
```

### PUT /api/edges/:id 수정

trigger, onSuccess 업데이트 지원:

```javascript
app.put('/api/edges/:id', (req, res) => {
  // ... 기존 코드 ...

  const { label, trigger, onSuccess } = req.body;

  if (label !== undefined) data.edges[index].label = label;
  if (trigger !== undefined) data.edges[index].trigger = trigger;
  if (onSuccess !== undefined) data.edges[index].onSuccess = onSuccess;

  // ... 저장 ...
});
```

---

## 프론트엔드 변경

### 파일: `public/index.html`

### 1. Edge 스타일 분기

trigger edge는 시각적으로 구분:

```javascript
// initGraph 또는 updateGraphNodes에서
const edgeData = edges.map(e => ({
  id: e.id,
  from: e.from,
  to: e.to,
  label: e.trigger ? (e.onSuccess ? '✓' : '⚡') : (e.label || ''),
  arrows: 'to',
  color: e.trigger
    ? { color: '#10b981', highlight: '#34d399' }  // 녹색 (트리거)
    : { color: '#6b7280', highlight: '#9ca3af' }, // 회색 (일반)
  dashes: !e.trigger,  // 트리거 아니면 점선
  width: e.trigger ? 2 : 1,
  smooth: { type: 'curvedCW', roundness: 0.2 }
}));
```

### 2. Edge 생성 시 옵션 선택

manipulation으로 edge 생성 시 trigger 여부 묻기:

```javascript
// initGraph의 manipulation.addEdge 수정
addEdge: function(data, callback) {
  if (data.from !== data.to) {
    // 사용자에게 edge 타입 묻기
    showEdgeTypeModal(data.from, data.to);
  }
  callback(null);
}
```

### 3. Edge 타입 선택 모달 추가

```html
<!-- Edge Type Modal -->
<div id="edgeModal" class="modal fixed inset-0 bg-black/50 items-center justify-center z-50">
  <div class="bg-gray-800 rounded-xl p-6 w-full max-w-sm mx-4">
    <h2 class="text-xl font-bold mb-4">연결 타입</h2>
    <input type="hidden" id="edgeFrom">
    <input type="hidden" id="edgeTo">

    <div class="space-y-3 mb-6">
      <label class="flex items-center gap-3 p-3 bg-gray-700 rounded-lg cursor-pointer hover:bg-gray-600">
        <input type="radio" name="edgeType" value="visual" checked class="w-4 h-4">
        <div>
          <div class="font-medium">시각적 연결</div>
          <div class="text-sm text-gray-400">관계 표시만 (자동 실행 안함)</div>
        </div>
      </label>

      <label class="flex items-center gap-3 p-3 bg-gray-700 rounded-lg cursor-pointer hover:bg-gray-600">
        <input type="radio" name="edgeType" value="trigger-success" class="w-4 h-4">
        <div>
          <div class="font-medium text-green-400">성공 시 실행</div>
          <div class="text-sm text-gray-400">앞 작업 성공하면 다음 실행</div>
        </div>
      </label>

      <label class="flex items-center gap-3 p-3 bg-gray-700 rounded-lg cursor-pointer hover:bg-gray-600">
        <input type="radio" name="edgeType" value="trigger-always" class="w-4 h-4">
        <div>
          <div class="font-medium text-yellow-400">항상 실행</div>
          <div class="text-sm text-gray-400">성공/실패 관계없이 다음 실행</div>
        </div>
      </label>
    </div>

    <div class="flex gap-3">
      <button onclick="confirmEdgeCreate()" class="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded-lg font-medium">
        연결
      </button>
      <button onclick="closeEdgeModal()" class="flex-1 bg-gray-600 hover:bg-gray-500 py-2 rounded-lg font-medium">
        취소
      </button>
    </div>
  </div>
</div>
```

### 4. Edge 모달 JavaScript

```javascript
function showEdgeTypeModal(fromId, toId) {
  document.getElementById('edgeFrom').value = fromId;
  document.getElementById('edgeTo').value = toId;
  document.getElementById('edgeModal').classList.add('active');
}

function closeEdgeModal() {
  document.getElementById('edgeModal').classList.remove('active');
}

async function confirmEdgeCreate() {
  const from = document.getElementById('edgeFrom').value;
  const to = document.getElementById('edgeTo').value;
  const type = document.querySelector('input[name="edgeType"]:checked').value;

  let trigger = false;
  let onSuccess = true;

  if (type === 'trigger-success') {
    trigger = true;
    onSuccess = true;
  } else if (type === 'trigger-always') {
    trigger = true;
    onSuccess = false;
  }

  closeEdgeModal();

  try {
    const res = await fetch(`${API_BASE}/api/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, trigger, onSuccess })
    });
    if (res.ok) {
      loadJobs();
    }
  } catch (error) {
    console.error('Failed to create edge:', error);
  }
}
```

---

## 실행 이력 표시 변경

### History 테이블에서 trigger 표시

```javascript
// renderHistory 함수에서
const triggerText = {
  manual: '수동',
  scheduled: '스케줄',
  chained: '체인 ⛓️'
};

// ... 테이블 렌더링 ...
<td class="px-4 py-3 text-sm text-gray-400">${triggerText[h.trigger] || h.trigger}</td>
```

---

## 순환 참조 방지

### triggerNextJobs에 depth 제한 추가

```javascript
async function triggerNextJobs(jobId, status, prevLog, depth = 0) {
  // 무한 루프 방지
  if (depth > 10) {
    console.error(`[Chain] Max depth exceeded for job ${jobId}`);
    return;
  }

  // ... 기존 로직 ...

  // 다음 작업 실행 시 depth 전달
  executeJob(nextJob, 'chained', {}, depth + 1)
}
```

---

## 검증 체크리스트

1. [ ] Edge에 trigger, onSuccess 필드 저장되는지 확인
2. [ ] 작업 완료 후 triggerNextJobs 호출되는지 확인
3. [ ] trigger=true인 edge만 다음 작업 실행하는지 확인
4. [ ] onSuccess=true일 때 성공시에만 실행되는지 확인
5. [ ] 실행 이력에 'chained' 표시되는지 확인
6. [ ] 그래프에서 trigger edge 스타일 다르게 표시되는지 확인
7. [ ] Edge 생성 모달에서 타입 선택 가능한지 확인
8. [ ] 순환 참조 시 무한 루프 방지되는지 확인

---

## 테스트 시나리오

### 시나리오 1: 기본 체이닝
```
1. daily-init → daily-update trigger edge 생성
2. daily-init 수동 실행
3. 성공 후 daily-update 자동 실행되는지 확인
4. 실행 이력에 'chained' 표시 확인
```

### 시나리오 2: 실패 시 중단
```
1. A → B trigger edge (onSuccess=true)
2. A 실행 (의도적으로 실패하게)
3. B가 실행되지 않는지 확인
```

### 시나리오 3: 실패해도 실행
```
1. A → B trigger edge (onSuccess=false)
2. A 실행 (실패)
3. B가 실행되는지 확인
```

---

## 파일 변경 요약

| 파일 | 변경 내용 |
|------|----------|
| `jobs.json` | edges 배열에 trigger, onSuccess 필드 추가 |
| `server.js` | triggerNextJobs 함수 추가, executeJob 수정, Edge API 수정 |
| `public/index.html` | Edge 스타일 분기, Edge 타입 선택 모달, 관련 JS 함수 |
