# Phase 4: AI/LLM 심화 연동

> 우선순위: P2-P3 | 예상 기간: 3주
> 의존성: Phase 1 (타임라인), Phase 2 (인사이트 기반)

## 개요

Claude를 "보고서 작성 도구"에서 "지능형 분석 파트너"로 격상. 메모 자동 분류, 세션 인사이트, 학습 지식 그래프.

---

## 4.1 메모 자동 분류 (Auto-categorize)

### 기능
- 메모 저장 시 Claude가 자동으로 태그/카테고리 부여
- 비동기 처리 (저장은 즉시, 분류는 백그라운드)
- 수동 태그 수정 가능

### 카테고리 정의

| 카테고리 | 아이콘 | 설명 | 예시 |
|----------|--------|------|------|
| `work` | 💼 | 업무 관련 | "PR 리뷰중", "배포 완료" |
| `learning` | 📚 | 학습/공부 | "Redis pub/sub 정리", "ECS graceful shutdown" |
| `idea` | 💡 | 아이디어 | "대시보드에 타임라인 추가하면 좋겠다" |
| `todo` | ✅ | 할일 | "내일 코드 리뷰 해야함" |
| `issue` | 🐛 | 이슈/문제 | "OOM 발생, 메모리 제한 확인 필요" |
| `personal` | 🏠 | 개인 | "점심 맛집 발견" |

### 데이터 스키마 변경

```json
{
  "id": "memo-123",
  "content": "ECS에서 graceful shutdown 확인중",
  "timestamp": "2026-02-06T02:33:06Z",
  "tags": ["learning", "aws"],
  "autoTags": true,
  "category": "learning"
}
```

### 분류 프로세스

```javascript
// POST /api/quick-memos 수정
app.post('/api/quick-memos', async (req, res) => {
  const { content } = req.body;

  const newMemo = {
    id: `memo-${Date.now()}`,
    content: content.trim(),
    timestamp: new Date().toISOString(),
    tags: [],
    category: null
  };

  // 즉시 저장
  memos.unshift(newMemo);
  saveQuickMemos(memos);
  res.json({ success: true, memo: newMemo });

  // 백그라운드 분류
  classifyMemo(newMemo).catch(err =>
    console.error('[AutoTag] 분류 실패:', err)
  );
});

async function classifyMemo(memo) {
  const prompt = `다음 메모를 분류하세요.

메모: "${memo.content}"

아래 카테고리 중 하나를 선택하고, 관련 태그를 1-3개 추출하세요:
- work: 업무 관련 (PR, 배포, 회의 등)
- learning: 학습/기술 (개념 정리, 새로운 기술 등)
- idea: 아이디어/제안
- todo: 할일/작업 항목
- issue: 이슈/문제/버그
- personal: 개인/일상

JSON으로 응답:
{"category": "learning", "tags": ["aws", "ecs"]}`;

  const result = await askClaude(prompt);
  const parsed = JSON.parse(result);

  // 메모 업데이트
  const memos = loadQuickMemos();
  const idx = memos.findIndex(m => m.id === memo.id);
  if (idx !== -1) {
    memos[idx].category = parsed.category;
    memos[idx].tags = parsed.tags;
    memos[idx].autoTags = true;
    saveQuickMemos(memos);
  }
}
```

### 노트 탭 UI 변경

메모 아이템에 태그 표시:

```javascript
function renderMemoItem(m) {
  const tagBadges = (m.tags || []).map(tag =>
    `<span class="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">${tag}</span>`
  ).join('');

  const categoryIcon = {
    work: '💼', learning: '📚', idea: '💡',
    todo: '✅', issue: '🐛', personal: '🏠'
  }[m.category] || '📝';

  // 기존 렌더링에 태그 추가
  return `...
    <div class="flex items-center gap-1 mt-1">${tagBadges}</div>
  ...`;
}
```

필터에 카테고리 추가:

```html
<div class="flex gap-2 mb-4">
  <!-- 기존 필터 버튼들 -->
  <button onclick="setNotesFilter('all')" ...>전체</button>
  <button onclick="setNotesFilter('backlog')" ...>📋 백로그</button>
  <button onclick="setNotesFilter('memo')" ...>📝 메모</button>
  <!-- 새 카테고리 필터 -->
  <button onclick="setNotesFilter('learning')" ...>📚 학습</button>
  <button onclick="setNotesFilter('work')" ...>💼 업무</button>
  <button onclick="setNotesFilter('idea')" ...>💡 아이디어</button>
  <button onclick="setNotesFilter('done')" ...>✅ 완료</button>
</div>
```

---

## 4.2 세션 인사이트 (Session Intelligence)

### 기능
- Claude Code 세션 자동 분석
- 세션별: 다룬 주제, 사용 기술, 해결한 문제 추출
- 세션 간 연관 관계 감지
- 프로젝트별 지식 축적 추적

### 새 API

```
GET /api/sessions/:id/insights   → 세션 인사이트
GET /api/sessions/insights/overview?days=7  → 전체 인사이트 요약
```

### 세션 분석 프로세스

```javascript
async function analyzeSession(session) {
  // 대화 내용에서 핵심 추출
  const conversation = session.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${m.content?.substring(0, 500)}`)
    .join('\n');

  const prompt = `다음 Claude Code 세션을 분석하세요.

프로젝트: ${session.project}
메시지 수: ${session.messages.length}
시작: ${session.startTime}

대화 내용 (요약):
${conversation.substring(0, 3000)}

JSON으로 분석 결과를 반환하세요:
{
  "topics": ["주제1", "주제2"],           // 다룬 주제들
  "technologies": ["Java", "Spring"],     // 사용/언급된 기술
  "problems_solved": ["문제 설명1"],      // 해결한 문제
  "key_decisions": ["결정 사항1"],        // 주요 결정
  "files_modified": ["path/to/file"],     // 수정된 파일들
  "complexity": "medium",                 // low/medium/high
  "summary": "한 줄 요약"
}`;

  return JSON.parse(await askClaude(prompt));
}
```

### 세션 상세 모달 확장

기존 탭(Overview, Conversation, Summary)에 **Insights** 탭 추가:

```html
<div id="sessionInsights">
  <div class="grid grid-cols-2 gap-4 mb-4">
    <div class="bg-gray-800 rounded-lg p-3">
      <h4 class="text-xs text-gray-500 mb-2">다룬 주제</h4>
      <div class="flex flex-wrap gap-1" id="insightTopics">
        <!-- 태그 뱃지들 -->
      </div>
    </div>
    <div class="bg-gray-800 rounded-lg p-3">
      <h4 class="text-xs text-gray-500 mb-2">사용 기술</h4>
      <div class="flex flex-wrap gap-1" id="insightTech">
        <!-- 태그 뱃지들 -->
      </div>
    </div>
  </div>
  <div class="bg-gray-800 rounded-lg p-3 mb-4">
    <h4 class="text-xs text-gray-500 mb-2">해결한 문제</h4>
    <ul id="insightProblems" class="text-sm space-y-1">
      <!-- 문제 목록 -->
    </ul>
  </div>
  <div class="bg-gray-800 rounded-lg p-3">
    <h4 class="text-xs text-gray-500 mb-2">주요 결정</h4>
    <ul id="insightDecisions" class="text-sm space-y-1">
      <!-- 결정 목록 -->
    </ul>
  </div>
</div>
```

---

## 4.3 학습 지식 그래프 (Knowledge Graph)

### 기능
- 세션 인사이트 + Obsidian 노트에서 토픽 추출
- 토픽 간 연결 관계 시각화 (vis-network 재사용)
- 학습 진행 상황 추적
- "이것도 공부해보세요" 추천

### 데이터 모델

```json
{
  "nodes": [
    {
      "id": "topic-docker",
      "label": "Docker",
      "category": "tech/docker",
      "mentions": 12,
      "lastSeen": "2026-02-06",
      "sessions": ["session-1", "session-2"],
      "notes": ["docker-compose.md", "dockerfile-best-practices.md"]
    }
  ],
  "edges": [
    {
      "from": "topic-docker",
      "to": "topic-ecs",
      "strength": 5,
      "context": "ECS 배포에서 Docker 이미지 사용"
    }
  ]
}
```

### 시각화 (새 탭 또는 세션 탭 내부)

```javascript
function initKnowledgeGraph(data) {
  const nodes = new vis.DataSet(data.nodes.map(n => ({
    id: n.id,
    label: n.label,
    value: n.mentions,  // 노드 크기 = 언급 횟수
    color: getCategoryColor(n.category),
    title: `${n.label}\n언급: ${n.mentions}회\n마지막: ${n.lastSeen}`
  })));

  const edges = new vis.DataSet(data.edges.map(e => ({
    from: e.from,
    to: e.to,
    width: Math.min(e.strength, 5),
    title: e.context
  })));

  const network = new vis.Network(container, { nodes, edges }, {
    physics: { barnesHut: { gravitationalConstant: -3000 } },
    nodes: { shape: 'dot', font: { color: '#e5e7eb' } }
  });
}
```

### 추천 API

```
GET /api/ai/recommendations?topic=docker
```

```json
{
  "related": [
    { "topic": "kubernetes", "reason": "Docker 다음 단계로 자주 학습됨" },
    { "topic": "ci-cd", "reason": "Docker와 함께 자주 언급됨" }
  ],
  "review_needed": [
    { "topic": "docker-networking", "lastSeen": "2025-12-15", "reason": "2개월 전 학습, 복습 추천" }
  ]
}
```

---

## 4.4 코드 리뷰 어시스턴트

### 기능
- GitHub PR 리뷰 데이터 수집 (Phase 이전 구현 완료)
- 리뷰 패턴 분석: 자주 지적하는 항목, 자주 받는 피드백
- 프로젝트별 리뷰 체크리스트 자동 생성

### 리뷰 패턴 분석

```javascript
async function analyzeReviewPatterns(reviews, days = 30) {
  const prompt = `다음은 ${days}일간의 코드 리뷰 활동입니다.

${reviews.map(r => `PR: ${r.title}\n리뷰 내용: ${r.body}\n결과: ${r.state}`).join('\n---\n')}

분석해주세요:
1. 자주 지적하는 패턴 (상위 5개)
2. 리뷰 스타일 특성
3. 개선 제안
4. 프로젝트별 체크리스트 제안`;

  return askClaude(prompt);
}
```

---

## 검증 방법

1. **메모 분류**: 메모 추가 → 몇 초 후 태그 자동 부여 확인
2. **세션 인사이트**: 세션 상세 → Insights 탭에 분석 결과 표시 확인
3. **지식 그래프**: 그래프 뷰에서 토픽 노드 & 연결 확인
4. **리뷰 패턴**: 리뷰 분석 결과 리포트 생성 확인
