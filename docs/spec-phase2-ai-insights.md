# Phase 2: AI 기반 인사이트 & 분석

> 우선순위: P1 | 예상 기간: 2주
> 의존성: Phase 1 (타임라인 API)

## 개요

데이터는 쌓이지만 "그래서 뭐?" 에 대한 답이 없음. Claude를 활용하여 축적된 데이터에서 패턴과 의미를 추출.

---

## 2.1 주간 다이제스트 (Weekly Digest)

### 기능 설명
- 매주 금요일 자동 생성 (cron) 또는 수동 트리거
- 한 주간의 모든 활동 데이터를 Claude가 분석
- 마크다운 리포트 생성 → Obsidian 저장

### 새 API

```
POST /api/insights/weekly-digest
  body: { weekStart?: "2026-02-03" }

GET /api/insights/weekly-digest?week=2026-02-03
```

### 수집 데이터

```javascript
async function collectWeeklyData(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const dates = getDateRange(weekStart, weekEnd);

  return {
    // 1. 세션 데이터
    sessions: await Promise.all(dates.map(d => collectSessionsForDate(d))),
    // 2. 작업 이력
    jobHistory: loadHistory().filter(h => inDateRange(h.startTime, weekStart, weekEnd)),
    // 3. 메모
    memos: loadQuickMemos().filter(m => inDateRange(m.timestamp, weekStart, weekEnd)),
    // 4. Obsidian 메모 (각 날짜별)
    obsidianMemos: await Promise.all(dates.map(d => parseObsidianDailyMemos(d))),
    // 5. 모닝 플랜
    morningPlans: loadMorningPlans().filter(p => inDateRange(p.date, weekStart, weekEnd)),
    // 6. 백로그 변경
    backlogs: loadBacklogs()
  };
}
```

### Claude 프롬프트

```
당신은 개인 생산성 분석가입니다. 아래 데이터를 분석하여 주간 다이제스트를 작성하세요.

## 분석 데이터
- 기간: ${weekStart} ~ ${weekEnd}
- Claude 세션: ${sessions.length}개 (프로젝트: ${projects.join(', ')})
- 작업 실행: ${jobRuns}회 (성공률: ${successRate}%)
- 메모: ${memos.length}개
- 완료 백로그: ${completedBacklogs}개

## 세션 상세
${sessionSummaries}

## 메모 내용
${memoContents}

## 작업 이력 요약
${jobHistorySummary}

---

아래 형식으로 분석해주세요:

# 📊 주간 다이제스트 (${weekStart} ~ ${weekEnd})

## 🎯 이번 주 하이라이트
- (가장 의미있는 성과 3개)

## 📈 활동 요약
- 세션 수 / 평균 시간 / 가장 활발한 프로젝트
- 작업 실행 / 성공률 / 가장 많이 실행된 작업

## 💡 주요 학습 & 인사이트
- (세션과 메모에서 추출한 핵심 학습 내용)

## 🔄 진행 중인 업무
- (아직 끝나지 않은 것들, 백로그에서 추출)

## 🎯 다음 주 제안
- (데이터 기반 구체적 제안 3개)

## 📉 개선 포인트
- (패턴 분석 기반, 예: "수요일에 집중도가 낮아지는 경향")
```

### 출력 & 저장

```javascript
// 결과 저장
const digest = {
  id: `wd-${weekStart}`,
  weekStart,
  weekEnd,
  markdown: claudeResponse,
  stats: { sessions, jobRuns, memos, successRate },
  createdAt: new Date().toISOString()
};

// data/weekly-digests.json에 저장
saveWeeklyDigest(digest);

// Obsidian에 저장 (선택)
if (saveToObsidian) {
  await obsidianWriter.writeToFile(
    `WEEKLY/${weekStart}-digest.md`,
    digest.markdown
  );
}
```

### jobs.json에 자동 실행 추가

```json
{
  "id": "weekly-digest",
  "name": "주간 다이제스트",
  "description": "한 주간 활동 분석 리포트 자동 생성",
  "schedule": "0 18 * * 5",
  "category": "review",
  "enabled": true
}
```

---

## 2.2 생산성 분석 대시보드

### UI: 통계 탭 확장 (또는 새 "인사이트" 서브탭)

작업 탭의 통계 서브탭에 "생산성" 섹션 추가:

```
작업 > 통계 > [실행 통계 | 생산성 분석]
```

### 새 API: `GET /api/insights/productivity`

```
GET /api/insights/productivity?days=7
```

**Response:**
```json
{
  "period": { "start": "2026-01-31", "end": "2026-02-06" },
  "overview": {
    "totalSessions": 42,
    "totalMemos": 23,
    "totalJobRuns": 87,
    "avgSessionMinutes": 35,
    "avgDailyMemos": 3.3
  },
  "hourlyActivity": [
    { "hour": 9, "sessions": 5, "memos": 3, "jobs": 8 },
    { "hour": 10, "sessions": 8, "memos": 2, "jobs": 12 },
    ...
  ],
  "dailyTrend": [
    { "date": "2026-01-31", "sessions": 6, "memos": 4, "focusMinutes": 180 },
    { "date": "2026-02-01", "sessions": 5, "memos": 2, "focusMinutes": 150 },
    ...
  ],
  "topProjects": [
    { "project": "ai-pipeline", "sessions": 15, "totalMinutes": 420 },
    { "project": "aicreation", "sessions": 12, "totalMinutes": 380 }
  ],
  "weekComparison": {
    "thisWeek": { "sessions": 42, "memos": 23 },
    "lastWeek": { "sessions": 35, "memos": 18 },
    "change": { "sessions": "+20%", "memos": "+28%" }
  }
}
```

### 차트 구현 (Chart.js)

```javascript
// 1. 시간대별 활동 히트맵
function renderHourlyHeatmap(data) {
  // 7x24 그리드 (요일 x 시간)
  // 셀 색상 강도 = 활동량
}

// 2. 일별 트렌드 라인 차트
function renderDailyTrend(data) {
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dailyTrend.map(d => d.date),
      datasets: [
        { label: '세션', data: data.dailyTrend.map(d => d.sessions) },
        { label: '메모', data: data.dailyTrend.map(d => d.memos) }
      ]
    }
  });
}

// 3. 프로젝트별 시간 분포 도넛 차트
function renderProjectDistribution(data) {
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.topProjects.map(p => p.project),
      datasets: [{
        data: data.topProjects.map(p => p.totalMinutes)
      }]
    }
  });
}

// 4. 이번 주 vs 지난 주 비교 바 차트
function renderWeekComparison(data) {
  // 그룹 바 차트: 세션, 메모, 작업 실행 비교
}
```

### HTML 레이아웃

```html
<!-- 생산성 분석 영역 -->
<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
  <div class="bg-gray-800 rounded-lg p-4">
    <div class="text-sm text-gray-400">총 세션</div>
    <div id="prodTotalSessions" class="text-3xl font-bold mt-1">-</div>
    <div id="prodSessionChange" class="text-xs text-green-400 mt-1">지난주 대비</div>
  </div>
  <!-- ... 메모, 작업, 집중 시간 카드 -->
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
  <!-- 시간대별 히트맵 -->
  <div class="bg-gray-800 rounded-lg p-4">
    <h3 class="text-lg font-semibold mb-4">🕐 시간대별 활동</h3>
    <div id="hourlyHeatmap" style="height: 200px;"></div>
  </div>

  <!-- 프로젝트 분포 -->
  <div class="bg-gray-800 rounded-lg p-4">
    <h3 class="text-lg font-semibold mb-4">📂 프로젝트 분포</h3>
    <canvas id="projectChart" height="200"></canvas>
  </div>
</div>

<!-- 일별 트렌드 -->
<div class="bg-gray-800 rounded-lg p-4 mb-6">
  <h3 class="text-lg font-semibold mb-4">📈 일별 트렌드</h3>
  <canvas id="dailyTrendChart" height="250"></canvas>
</div>
```

---

## 2.3 스마트 서제스션

### 기능 설명
- 홈 대시보드 상단에 AI 기반 제안 카드 표시
- 서버에서 주기적으로 (1시간마다) 제안 생성
- 패턴 감지 기반 + 행동 기반

### 서제스션 타입

| 타입 | 트리거 | 예시 |
|------|--------|------|
| `nudge` | 행동 누락 | "오늘 아직 메모를 안 남기셨어요" |
| `trend` | 트렌드 변화 | "이번 주 세션이 30% 증가했어요" |
| `pattern` | 반복 패턴 | "매주 화요일에 주로 PR 리뷰를 하시네요" |
| `reminder` | 미완료 항목 | "백로그에 3개 항목이 1주일 넘게 대기중" |
| `achievement` | 달성 축하 | "오늘 목표 3개 모두 달성!" |

### 새 API

```
GET /api/insights/suggestions
```

**Response:**
```json
{
  "suggestions": [
    {
      "type": "nudge",
      "icon": "📝",
      "message": "오늘 아직 메모를 남기지 않으셨어요. 빠른 메모를 남겨보세요!",
      "action": { "type": "openQuickInput" },
      "priority": "low"
    },
    {
      "type": "achievement",
      "icon": "🎯",
      "message": "이번 주 세션 수가 지난주 대비 25% 증가했어요!",
      "action": null,
      "priority": "info"
    }
  ]
}
```

### 서버 구현

```javascript
function generateSuggestions() {
  const today = new Date().toISOString().split('T')[0];
  const suggestions = [];

  // 1. 메모 누락 체크
  const todayMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(today));
  if (todayMemos.length === 0 && new Date().getHours() >= 11) {
    suggestions.push({
      type: 'nudge', icon: '📝',
      message: '오늘 아직 메모를 남기지 않으셨어요',
      action: { type: 'openQuickInput' }
    });
  }

  // 2. 오래된 백로그
  const backlogs = loadBacklogs().filter(b => !b.done);
  const oldBacklogs = backlogs.filter(b => {
    const created = new Date(b.createdAt);
    return (Date.now() - created) > 7 * 24 * 60 * 60 * 1000;
  });
  if (oldBacklogs.length > 0) {
    suggestions.push({
      type: 'reminder', icon: '📋',
      message: `백로그에 ${oldBacklogs.length}개 항목이 1주일 넘게 대기중이에요`,
      action: { type: 'showTab', tab: 'notes' }
    });
  }

  // 3. 모닝 플랜 체크
  const todayPlan = loadMorningPlans().find(p => p.date === today);
  if (!todayPlan && new Date().getHours() >= 9 && new Date().getHours() < 12) {
    suggestions.push({
      type: 'nudge', icon: '☀️',
      message: '오늘의 계획을 아직 세우지 않으셨어요',
      action: { type: 'openMorningStart' }
    });
  }

  // 4. 주간 비교 (월요일에)
  if (new Date().getDay() === 1) {
    // 지난주 vs 그 전주 비교
    // ... 계산 후 트렌드 서제스션 추가
  }

  return suggestions;
}
```

### UI: 홈 대시보드 서제스션 바

```html
<!-- 요약 카드 위에 -->
<div id="homeSuggestions" class="mb-4 space-y-2">
  <!-- 서제스션 카드들 -->
</div>
```

```javascript
function renderSuggestion(s) {
  const actionAttr = s.action
    ? `onclick="${s.action.type === 'showTab' ? `showTab('${s.action.tab}')` : `${s.action.type}()`}" class="cursor-pointer"`
    : '';
  return `
    <div ${actionAttr}
      class="flex items-center gap-3 p-3 rounded-lg bg-gray-800/60 border border-gray-700/50 hover:bg-gray-800 transition-colors">
      <span class="text-lg">${s.icon}</span>
      <span class="text-sm text-gray-300">${s.message}</span>
      <button onclick="event.stopPropagation(); dismissSuggestion('${s.type}')"
        class="ml-auto text-gray-600 hover:text-gray-400 text-xs">닫기</button>
    </div>
  `;
}
```

---

## 검증 방법

1. **주간 다이제스트**:
   - `curl -X POST http://localhost:3030/api/insights/weekly-digest` 실행
   - 마크다운 출력 확인
   - Obsidian에 파일 생성 확인

2. **생산성 분석**:
   - 통계 탭 → 생산성 분석 영역 확인
   - 차트 렌더링 확인
   - 기간 변경 시 데이터 갱신 확인

3. **스마트 서제스션**:
   - 홈 탭에서 서제스션 바 표시 확인
   - 서제스션 클릭 → 해당 액션 실행 확인
   - "닫기" 클릭 → 숨김 확인
