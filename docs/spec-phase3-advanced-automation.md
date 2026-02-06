# Phase 3: 자동화 & 워크플로우 고도화

> 우선순위: P2 | 예상 기간: 2주
> 의존성: 없음 (독립적으로 구현 가능)

## 개요

현재 파이프라인은 단순 순차 실행(A→B). 조건부 분기, 스마트 스케줄, 다채널 알림으로 고도화.

---

## 3.1 조건부 파이프라인 (Conditional Pipelines)

### 현재 상태
- `edges` 배열: `{ from, to, trigger: true, onSuccess: true }`
- A 성공 시 → B 실행 (단순 성공/실패 분기만)

### 확장: Edge 조건 타입

```json
{
  "id": "edge-1",
  "from": "job-a",
  "to": "job-b",
  "condition": {
    "type": "onSuccess"
  }
}
```

**새로운 condition 타입들:**

| type | 설명 | 설정 |
|------|------|------|
| `onSuccess` | A 성공 시 실행 | - |
| `onFailure` | A 실패 시 실행 | - |
| `always` | A 완료 시 항상 실행 | - |
| `onOutput` | A 출력에 특정 문자열 포함 시 | `{ pattern: "ERROR", matchType: "contains" }` |
| `onExitCode` | 특정 exit code 일 때 | `{ code: 0 }` |

### jobs.json 스키마 변경

```json
{
  "edges": [
    {
      "id": "edge-1",
      "from": "sync-github",
      "to": "daily-update",
      "condition": { "type": "onSuccess" }
    },
    {
      "id": "edge-2",
      "from": "cloudwatch-alert",
      "to": "slack-notify-error",
      "condition": {
        "type": "onOutput",
        "pattern": "CRITICAL",
        "matchType": "contains"
      }
    }
  ]
}
```

### 서버 구현: triggerNextJobs 확장

```javascript
function triggerNextJobs(completedJobId, status, stdout, exitCode) {
  const edges = loadEdges().filter(e => e.from === completedJobId);

  for (const edge of edges) {
    const condition = edge.condition || { type: 'onSuccess' };
    let shouldTrigger = false;

    switch (condition.type) {
      case 'onSuccess':
        shouldTrigger = status === 'success';
        break;
      case 'onFailure':
        shouldTrigger = status === 'failed';
        break;
      case 'always':
        shouldTrigger = true;
        break;
      case 'onOutput':
        if (condition.matchType === 'contains') {
          shouldTrigger = stdout?.includes(condition.pattern);
        } else if (condition.matchType === 'regex') {
          shouldTrigger = new RegExp(condition.pattern).test(stdout);
        }
        break;
      case 'onExitCode':
        shouldTrigger = exitCode === condition.code;
        break;
    }

    if (shouldTrigger) {
      const nextJob = loadJobs().find(j => j.id === edge.to);
      if (nextJob) {
        executeJob(nextJob, 'chained', {}, chainDepth + 1);
      }
    }
  }
}
```

### 그래프 뷰 시각화

Edge 색상으로 조건 표현:
- `onSuccess`: 초록색 실선
- `onFailure`: 빨간색 점선
- `always`: 회색 실선
- `onOutput`: 파란색 점선 (라벨: "contains: XXX")

### Edge 편집 모달 확장

기존 Edge 모달에 condition 선택 UI 추가:

```html
<div class="mt-4">
  <label class="block text-sm font-medium mb-2">실행 조건</label>
  <select id="edgeConditionType" class="w-full bg-gray-700 ...">
    <option value="onSuccess">성공 시 (기본)</option>
    <option value="onFailure">실패 시</option>
    <option value="always">항상</option>
    <option value="onOutput">출력값 포함 시</option>
  </select>
  <div id="edgeConditionExtra" class="hidden mt-2">
    <input id="edgeConditionPattern" placeholder="패턴 (예: ERROR)"
      class="w-full bg-gray-700 ...">
  </div>
</div>
```

---

## 3.2 알림 채널 확장

### 현재 상태
- Slack Webhook만 지원
- settings의 `slackWebhookUrl`로 전역 설정

### 확장: 다중 채널 지원

```json
{
  "settings": {
    "notifications": {
      "channels": [
        {
          "id": "slack-main",
          "type": "slack",
          "webhookUrl": "https://hooks.slack.com/...",
          "enabled": true
        },
        {
          "id": "discord-dev",
          "type": "discord",
          "webhookUrl": "https://discord.com/api/webhooks/...",
          "enabled": true
        },
        {
          "id": "native",
          "type": "native",
          "enabled": true
        }
      ],
      "rules": [
        {
          "event": "job.failed",
          "channels": ["slack-main", "native"],
          "filter": { "category": "monitor" }
        },
        {
          "event": "job.success",
          "channels": ["slack-main"],
          "filter": { "category": "sync" }
        }
      ]
    }
  }
}
```

### 알림 전송 추상화

```javascript
class NotificationService {
  constructor(settings) {
    this.channels = settings.notifications?.channels || [];
    this.rules = settings.notifications?.rules || [];
  }

  async notify(event, data) {
    const matchingRules = this.rules.filter(r => r.event === event);
    for (const rule of matchingRules) {
      // 필터 체크
      if (rule.filter && !this.matchFilter(rule.filter, data)) continue;

      // 해당 채널로 전송
      for (const channelId of rule.channels) {
        const channel = this.channels.find(c => c.id === channelId && c.enabled);
        if (channel) await this.sendToChannel(channel, event, data);
      }
    }
  }

  async sendToChannel(channel, event, data) {
    switch (channel.type) {
      case 'slack':
        return this.sendSlack(channel.webhookUrl, event, data);
      case 'discord':
        return this.sendDiscord(channel.webhookUrl, event, data);
      case 'native':
        return this.sendNative(event, data);
    }
  }
}
```

### Discord Webhook 포맷

```javascript
async sendDiscord(webhookUrl, event, data) {
  const color = data.status === 'success' ? 0x10b981 : 0xef4444;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `${data.status === 'success' ? '✅' : '❌'} ${data.jobName}`,
        description: data.summary,
        color,
        fields: [
          { name: '트리거', value: data.trigger, inline: true },
          { name: '소요 시간', value: data.duration, inline: true }
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
}
```

### 설정 UI (설정 탭)

```html
<h3 class="text-lg font-semibold mb-4">🔔 알림 채널</h3>
<div id="notificationChannels" class="space-y-3">
  <!-- 채널별 카드: 타입, URL, 활성화 토글, 테스트 버튼 -->
</div>
<button onclick="addNotificationChannel()" class="mt-2 text-sm text-blue-400">
  + 채널 추가
</button>

<h3 class="text-lg font-semibold mb-4 mt-6">📋 알림 규칙</h3>
<div id="notificationRules" class="space-y-3">
  <!-- 규칙별: 이벤트 선택, 채널 선택, 필터 조건 -->
</div>
```

---

## 3.3 외부 트리거 (Webhooks)

### 새 API

```
POST /api/webhook/:token
  body: { jobId: "sync-github", options: {...} }
```

### 토큰 관리

```
GET /api/webhook-tokens          → 토큰 목록
POST /api/webhook-tokens         → 토큰 생성
DELETE /api/webhook-tokens/:id   → 토큰 삭제
```

### 사용 예시

```bash
# GitHub Actions에서 배포 후 대시보드 작업 트리거
curl -X POST https://your-dashboard:3030/api/webhook/abc123 \
  -H "Content-Type: application/json" \
  -d '{"jobId": "deploy-notify"}'
```

### 서버 구현

```javascript
app.post('/api/webhook/:token', (req, res) => {
  const { token } = req.params;
  const tokens = loadWebhookTokens();
  const tokenData = tokens.find(t => t.token === token && t.enabled);

  if (!tokenData) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { jobId, options } = req.body;
  const job = allJobsData.find(j => j.id === jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // 토큰 권한 체크 (특정 작업만 허용)
  if (tokenData.allowedJobs && !tokenData.allowedJobs.includes(jobId)) {
    return res.status(403).json({ error: 'Job not allowed for this token' });
  }

  executeJob(job, 'webhook', options || {});
  res.json({ success: true, message: `Job ${jobId} triggered` });
});
```

---

## 3.4 스마트 스케줄링 UI

### 현재 상태
- cron 표현식 직접 입력
- crontab.guru 링크 제공

### 개선: 시각적 스케줄 편집기

```html
<div class="schedule-builder">
  <div class="flex gap-4 mb-3">
    <label class="flex items-center gap-2">
      <input type="radio" name="schedType" value="simple" checked> 간편 설정
    </label>
    <label class="flex items-center gap-2">
      <input type="radio" name="schedType" value="cron"> Cron 직접 입력
    </label>
  </div>

  <!-- 간편 설정 -->
  <div id="simpleSchedule">
    <select id="schedFrequency" class="bg-gray-700 ...">
      <option value="daily">매일</option>
      <option value="weekdays">평일만</option>
      <option value="weekly">매주</option>
      <option value="monthly">매월</option>
      <option value="hourly">매시간</option>
    </select>

    <div id="schedWeekdayPicker" class="hidden flex gap-1 mt-2">
      <!-- 월~일 토글 버튼 -->
    </div>

    <div class="flex gap-2 mt-2">
      <input type="time" id="schedTime" class="bg-gray-700 ...">
    </div>
  </div>

  <!-- 변환된 cron 표현식 미리보기 -->
  <div class="mt-3 text-sm text-gray-500">
    Cron: <code id="schedCronPreview">0 9 * * 1-5</code>
    <span id="schedNextRun" class="ml-2">다음 실행: 2월 7일 오전 9:00</span>
  </div>
</div>
```

---

## 검증 방법

1. **조건부 파이프라인**: Edge 모달에서 조건 설정 → 작업 실행 → 조건에 따라 다음 작업 실행/미실행 확인
2. **알림 채널**: 설정에서 Discord 채널 추가 → 작업 실패 시 Discord 알림 수신 확인
3. **외부 트리거**: 토큰 생성 → curl로 webhook 호출 → 작업 실행 확인
4. **스케줄 UI**: 간편 설정으로 스케줄 설정 → cron 표현식 올바르게 생성 확인
