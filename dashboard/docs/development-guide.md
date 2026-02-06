# 개발 가이드

새 기능 추가, 수정, 디버깅 시 참고할 가이드입니다.

## 개발 환경 설정

### 1. 의존성 설치

```bash
cd dashboard
npm install
```

### 2. 개발 모드 실행

```bash
# Express 서버만 (웹 대시보드)
npm run web:dev   # --watch 옵션으로 자동 재시작

# Electron 앱 (데스크톱)
npm run dev       # NODE_ENV=development
```

### 3. 로그 확인

```bash
# 서버 로그 (터미널 출력)
[2026-02-06T14:20:00.000Z] Executing: GitHub 동기화 (scheduled)
   Command: /path/to/python script.py --yes
[2026-02-06T14:20:05.123Z] Success: GitHub 동기화 (5123ms)

# 히스토리 파일
cat logs/history.json | jq '.[-1]'
```

## 새 작업 추가하기

### 1. jobs.json에 작업 정의 추가

```json
{
  "id": "my-new-job",
  "name": "새 작업",
  "description": "작업 설명",
  "command": "/path/to/venv/python /path/to/script.py",
  "schedule": "0 9 * * *",
  "enabled": true,
  "category": "custom",
  "tags": ["tag1"],
  "options": [
    {
      "flag": "--dry-run",
      "label": "미리보기",
      "type": "boolean",
      "default": false
    }
  ]
}
```

### 2. Python 스크립트 작성

```python
#!/usr/bin/env python3
"""
my_script.py - 새 작업 스크립트

Usage:
    python my_script.py [--dry-run] [--yes]
"""
import argparse
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--yes', action='store_true')
    args = parser.parse_args()

    print("작업 시작...")

    if args.dry_run:
        print("(미리보기 모드)")
        return

    # 작업 로직
    try:
        # ...
        print("완료!")
    except Exception as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
```

### 3. 대시보드에서 확인

- 카드 뷰에서 새 작업 표시 확인
- 실행 버튼 클릭하여 테스트
- 로그 확인

## 새 옵션 타입 추가하기

### 1. server.js의 buildCommand 함수 수정

```javascript
function buildCommand(job, options = {}) {
  // ...
  for (const opt of jobOptions) {
    // 새 타입 추가
    if (opt.type === 'my-new-type') {
      const value = options[opt.flag || opt.arg];
      if (value) {
        // 값 처리 로직
        flags.push(`${opt.flag} "${processMyNewType(value)}"`);
      }
    }
  }
  // ...
}
```

### 2. public/index.html의 옵션 폼 렌더링 수정

```javascript
function renderOptionInput(opt) {
  if (opt.type === 'my-new-type') {
    return `
      <label class="block">
        <span>${opt.label}</span>
        <div class="my-new-type-input" data-name="${opt.flag || opt.arg}">
          <!-- 커스텀 입력 UI -->
        </div>
      </label>
    `;
  }
  // ...
}
```

### 3. 옵션 값 수집 로직 추가

```javascript
async function executeJob() {
  // ...
  for (const opt of job.options || []) {
    if (opt.type === 'my-new-type') {
      options[key] = getMyNewTypeValue(key);
    }
  }
  // ...
}
```

## 새 API 엔드포인트 추가하기

### 1. server.js에 라우트 추가

```javascript
// GET /api/my-endpoint
app.get('/api/my-endpoint', (req, res) => {
  try {
    // 쿼리 파라미터
    const param = req.query.param;

    // 로직
    const result = doSomething(param);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/my-endpoint
app.post('/api/my-endpoint', (req, res) => {
  try {
    // 요청 본문
    const { field1, field2 } = req.body;

    // 검증
    if (!field1) {
      return res.status(400).json({ error: 'field1 required' });
    }

    // 로직
    const result = doSomething(field1, field2);

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 2. 프론트엔드에서 호출

```javascript
// GET
async function fetchMyEndpoint(param) {
  const res = await fetch(`/api/my-endpoint?param=${encodeURIComponent(param)}`);
  return res.json();
}

// POST
async function postMyEndpoint(data) {
  const res = await fetch('/api/my-endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}
```

## 새 Electron 서비스 추가하기

### 1. 서비스 클래스 생성

```javascript
// electron/services/my-service.js
class MyService {
  constructor(options = {}) {
    this.config = options.config || {};
  }

  async doSomething(input) {
    // 비동기 작업
    return result;
  }
}

module.exports = { MyService };
```

### 2. main.js에서 초기화

```javascript
// electron/main.js
const { MyService } = require('./services/my-service');

async function initializeApp() {
  // ...
  const myService = new MyService({ config: { ... } });

  // IPC 핸들러 등록
  ipcMain.handle('my-service-action', async (event, data) => {
    try {
      const result = await myService.doSomething(data);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  // ...
}
```

### 3. 렌더러에서 호출

```javascript
// preload.js에서 노출
contextBridge.exposeInMainWorld('myService', {
  doSomething: (data) => ipcRenderer.invoke('my-service-action', data)
});

// 렌더러에서 사용
const result = await window.myService.doSomething({ key: 'value' });
```

## 새 인터랙티브 작업 추가하기

### 1. jobs.json에 인터랙티브 작업 정의

```json
{
  "id": "my-interactive-job",
  "name": "인터랙티브 작업",
  "interactive": true,
  "schedule": "0 12 * * *",
  "enabled": true,
  "category": "interactive",
  "popup": {
    "character": "asking",
    "prompts": ["점심 뭐 먹었어요?"],
    "placeholder": "입력...",
    "inputType": "textarea"
  },
  "processing": {
    "claude": {
      "enabled": true,
      "prompt": "입력을 정리해주세요"
    }
  },
  "output": {
    "target": "obsidian-daily",
    "section": "## 점심",
    "format": "- {content}"
  }
}
```

### 2. 팝업 UI 커스터마이징 (필요시)

```javascript
// public/popup/popup.js
function renderCustomInput(job) {
  if (job.id === 'my-interactive-job') {
    // 커스텀 UI 렌더링
  }
}
```

## 파이프라인 체이닝 설정하기

### 1. edges 배열에 연결 추가

```json
{
  "edges": [
    {
      "id": "edge-1",
      "from": "job-a",
      "to": "job-b",
      "trigger": true,
      "onSuccess": true
    }
  ]
}
```

### 2. 체이닝 동작 확인

```
job-a 실행 완료 (성공)
    │
    ▼
triggerNextJobs("job-a", "success", ...)
    │
    ▼
job-b 자동 실행 (trigger: 'chained')
```

## 디버깅

### 서버 디버깅

```javascript
// 상세 로그 추가
console.log(`[DEBUG] executeJob called:`, {
  jobId: job.id,
  trigger,
  options,
  chainDepth
});

// 실행 중인 작업 상태
console.log(`[DEBUG] runningJobs:`, Object.keys(runningJobs));
```

### 프론트엔드 디버깅

```javascript
// 브라우저 콘솔
console.log('jobs:', jobs);
console.log('edges:', edges);
console.log('network positions:', network.getPositions());

// API 응답 확인
const res = await fetch('/api/jobs');
console.log(await res.json());
```

### Electron 디버깅

```javascript
// 메인 프로세스
console.log('[Electron] Debug:', data);

// 개발자 도구 열기
mainWindow.webContents.openDevTools();
this.window.webContents.openDevTools({ mode: 'detach' });
```

## 테스트

### 수동 테스트 체크리스트

```markdown
## 작업 관리
- [ ] 작업 생성
- [ ] 작업 수정
- [ ] 작업 삭제
- [ ] 작업 복제
- [ ] 활성화/비활성화

## 작업 실행
- [ ] 수동 실행 (옵션 있음/없음)
- [ ] 스케줄 실행
- [ ] 타임아웃 동작
- [ ] 재시도 동작
- [ ] 파이프라인 체이닝

## UI
- [ ] 카드 뷰 렌더링
- [ ] 그래프 뷰 렌더링
- [ ] 실시간 로그
- [ ] 히스토리 필터링
- [ ] 통계 차트

## 알림
- [ ] Slack 알림 (성공/실패)
- [ ] 토스트 알림
```

### API 테스트

```bash
# 작업 목록
curl http://localhost:3030/api/jobs | jq

# 작업 실행
curl -X POST http://localhost:3030/api/jobs/sync-github/run \
  -H "Content-Type: application/json" \
  -d '{"options":{"--yes":true}}'

# 히스토리
curl "http://localhost:3030/api/history?page=1&limit=5" | jq

# 통계
curl "http://localhost:3030/api/stats/summary?days=7" | jq
```

## 코드 스타일

### JavaScript

```javascript
// 함수 문서화
/**
 * 작업 실행
 * @param {object} job - 작업 정의
 * @param {string} trigger - 트리거 타입
 * @returns {Promise<object>}
 */
async function executeJob(job, trigger) { ... }

// 에러 처리
try {
  const result = await riskyOperation();
} catch (error) {
  console.error('[Module] Error:', error.message);
  throw error;  // 또는 적절한 처리
}

// 로그 형식
console.log(`[${new Date().toISOString()}] ${action}: ${details}`);
```

### 커밋 메시지

```
feat: 새 기능 추가
fix: 버그 수정
docs: 문서 수정
style: 코드 포맷팅
refactor: 리팩토링
test: 테스트 추가
chore: 빌드/설정 변경
```

## 배포 전 체크리스트

```markdown
- [ ] 모든 console.log 디버그 로그 제거/주석
- [ ] 환경변수 확인 (SLACK_WEBHOOK_URL 등)
- [ ] jobs.json 백업
- [ ] 의존성 업데이트 확인
- [ ] 히스토리 파일 백업 (필요시)
```
