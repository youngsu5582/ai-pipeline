# Electron 데스크톱 앱

MemoBot - AI Pipeline Dashboard의 Electron 데스크톱 앱 문서입니다.

## 개요

Electron 앱은 Express 서버를 내장하고 추가 기능을 제공합니다:

- 시스템 트레이 상주
- 전역 단축키 (빠른 메모)
- 인터랙티브 팝업 작업
- Claude Code CLI 연동
- Obsidian Daily Note 자동 저장

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│                 Electron App                     │
│  ┌─────────────────────────────────────────────┐ │
│  │              Main Process                   │ │
│  │  ┌─────────┐  ┌─────────┐  ┌────────────┐ │ │
│  │  │  Tray   │  │ Express │  │  Services  │ │ │
│  │  │ (tray.js)│  │(server.js)│  │           │ │ │
│  │  └────┬────┘  └────┬────┘  │ ClaudeCode │ │ │
│  │       │            │       │ Obsidian   │ │ │
│  │       │     ┌──────┴─────┐ │ Session    │ │ │
│  │       │     │    IPC     │ │ JobRunner  │ │ │
│  │       │     └──────┬─────┘ └──────┬─────┘ │ │
│  └───────┼────────────┼──────────────┼───────┘ │
│          │            │              │         │
│  ┌───────▼────────────▼──────────────▼───────┐ │
│  │           Renderer Processes              │ │
│  │  ┌────────────┐  ┌────────────┐          │ │
│  │  │ Quick Input│  │   Popup    │          │ │
│  │  │  Window    │  │  Window    │          │ │
│  │  └────────────┘  └────────────┘          │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## 시작하기

### 개발 모드

```bash
npm run dev
# NODE_ENV=development로 실행
# 메인 윈도우 자동 표시
```

### 프로덕션 모드

```bash
npm start
# 트레이에만 상주 (백그라운드)
```

## 컴포넌트

### 1. 메인 프로세스 (main.js)

Electron 앱의 진입점:

```javascript
// 초기화 순서
1. Express 서버 시작 (startExpressServer)
2. 시스템 트레이 생성 (createTray)
3. 메인 윈도우 생성 (createMainWindow)
4. 서비스 초기화 (ClaudeCode, ObsidianWriter, SessionCollector)
5. 윈도우 컴포넌트 초기화 (QuickInputWindow, PopupWindow)
6. 인터랙티브 작업 실행기 시작 (InteractiveJobRunner)
7. 전역 단축키 등록 (registerShortcuts)
```

### 2. 시스템 트레이 (tray.js)

```javascript
const contextMenu = [
  { label: 'Dashboard 열기', click: onShowDashboard },
  { label: '지금 기록하기', accelerator: 'CmdOrCtrl+Shift+Space', click: onQuickInput },
  { type: 'separator' },
  { label: '오늘 요약 보기', click: onTodaySummary },
  { type: 'separator' },
  { label: '종료', click: onQuit }
];
```

- 왼쪽 클릭: 빠른 입력 창
- 우클릭: 컨텍스트 메뉴

### 3. 빠른 입력 윈도우 (quick-input.js)

```javascript
class QuickInputWindow {
  // Raycast/Alfred 스타일 드롭다운
  // 트레이 아이콘 아래에 표시
  // 포커스 잃으면 자동 숨김
}
```

특징:
- 투명 배경, 프레임 없음
- 항상 최상위
- macOS vibrancy 효과

### 4. 팝업 윈도우 (popup-window.js)

```javascript
class PopupWindow {
  // 인터랙티브 작업용 팝업
  // 화면 중앙에 표시
  // 리마인더 기능
}
```

입력 타입:
| 타입 | 크기 | 용도 |
|------|------|------|
| textarea | 420x320 | 일반 텍스트 입력 |
| quick-buttons | 380x240 | 빠른 선택 버튼 |
| review | 500x500 | 수집 데이터 확인 및 편집 |

## 서비스

### ClaudeCode (claude-code.js)

Claude CLI 연동 서비스:

```javascript
class ClaudeCode {
  async ask(prompt, options = {}) {
    // claude --print "prompt" --system-prompt "system"
    // 1분 타임아웃
    // ANSI 코드 제거
  }

  async formatEntry(text) {
    // 텍스트를 Daily Note 형식으로 정리
    // 이모지 + 한 줄 요약
  }

  async generateDailySummary(entries, sessions) {
    // 하루 기록과 Claude 세션으로 일일 요약 생성
  }
}
```

### ObsidianWriter (obsidian-writer.js)

Daily Note 저장 서비스:

```javascript
class ObsidianWriter {
  constructor() {
    // config/settings.yaml에서 vault 경로 로드
  }

  async appendToSection(sectionHeader, content) {
    // 특정 섹션 아래에 내용 추가
  }

  async replaceSection(sectionHeader, newContent) {
    // 섹션 전체 교체
  }

  async appendHourlyEntry(text) {
    // "## 시간별 메모" 섹션에 시간 태그 추가
    // - `14:30` 내용...
  }
}
```

Daily Note 템플릿:
```markdown
---
date: 2026-02-06
weekday: 목요일
---

# 2026-02-06 (목)
> 어제: [[2026-02-05]]

## 오늘의 Focus
## 할 일
## 고민거리
## 오늘의 생각
## 시간별 메모
## 오늘 한 일
## Claude 세션 요약
```

### SessionCollector (session-collector.js)

Claude Code 세션 수집:

```javascript
class SessionCollector {
  constructor() {
    // ~/.claude/projects/ 디렉토리 스캔
  }

  findTodaySessions(targetDate) {
    // sessions-index.json에서 오늘 세션 찾기
    // 프로젝트별 그룹핑
  }

  buildSessionSummary(sessions) {
    // 마크다운 형식 요약 생성
  }
}
```

### InteractiveJobRunner (interactive-job-runner.js)

인터랙티브 작업 실행:

```javascript
class InteractiveJobRunner {
  start() {
    // jobs.json에서 interactive=true 작업 로드
    // 스케줄 등록
  }

  async executeJob(job) {
    // 1. 알림 시간대 확인
    // 2. 데이터 수집 (오늘 기록, Claude 세션)
    // 3. 팝업 표시
    // 4. 사용자 입력 대기
    // 5. Claude 처리 (선택)
    // 6. Obsidian 저장
  }
}
```

## IPC 통신

### 메인 → 렌더러

```javascript
// 팝업 데이터 전송
this.window.webContents.send('popup-data', { job, collectedData });
```

### 렌더러 → 메인

```javascript
// 엔트리 저장
ipcMain.handle('save-entry', async (event, { text, type }) => {
  // Claude로 포맷팅 → Obsidian 저장
  return { success: true, formatted };
});

// Claude 질문
ipcMain.handle('ask-claude', async (event, { prompt }) => {
  const response = await claudeCode.ask(prompt);
  return { success: true, response };
});

// 팝업 제출
ipcMain.handle('submit-popup', async (event, response) => {
  // 입력 처리
});

// 설정 조회/저장
ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('save-settings', (event, settings) => { ... });

// 윈도우 제어
ipcMain.handle('close-window', (event) => { ... });
ipcMain.handle('hide-window', (event) => { ... });
```

## 설정 저장 (electron-store)

```javascript
const store = new Store({
  name: 'electron-settings',
  defaults: {
    notificationSettings: {
      enabled: true,
      startHour: 9,
      endHour: 22,
      intervalMinutes: 60,
      reminderAfterMinutes: 5
    },
    shortcuts: {
      quickInput: 'CommandOrControl+Shift+Space'
    }
  }
});
```

저장 위치: `~/.config/memobot/electron-settings.json`

### 오늘 기록 저장

```javascript
// 날짜별 엔트리 저장
store.set(`entries.${today}`, [
  { time: "2026-02-06T10:30:00Z", text: "작업 내용", raw: "원본" }
]);
```

## 전역 단축키

| 단축키 | 기능 |
|--------|------|
| `Cmd/Ctrl+Shift+Space` | 빠른 입력 창 |

사용자 지정 가능:
```javascript
store.set('shortcuts.quickInput', 'CommandOrControl+Shift+M');
```

## 앱 생명주기

### 시작

```
app.whenReady()
    ↓
setupIPC()
    ↓
initializeApp()
    ├── startExpressServer()
    ├── createTray()
    ├── createMainWindow()
    ├── 서비스 초기화
    └── registerShortcuts()
```

### 종료

```
트레이 메뉴 → 종료
    ↓
app.isQuitting = true
    ↓
app.quit()
    ↓
globalShortcut.unregisterAll()
```

### 윈도우 동작

- 닫기 버튼: 숨기기 (트레이 유지)
- Dock 아이콘 클릭 (macOS): 메인 윈도우 표시

## 디버깅

### 개발자 도구

```javascript
// 메인 윈도우
mainWindow.webContents.openDevTools();

// 팝업 윈도우
this.window.webContents.openDevTools({ mode: 'detach' });
```

### 로그 확인

```bash
# Electron 로그
npm run dev

# 콘솔 출력
[Electron] Express server started
[JobRunner] Started with 5 interactive jobs
[ClaudeCode] Executing: claude --print ...
[ObsidianWriter] Appended to ## 시간별 메모
```

## 패키징

### macOS

```bash
# electron-builder 사용 (설정 필요)
npm run build
```

### 앱 아이콘

위치: `dashboard/assets/`
- `icon.png` - 앱 아이콘
- `tray-icon.png` - 트레이 아이콘 (템플릿 이미지)

## 알려진 제한사항

1. **Claude CLI 필요**: `claude --print` 명령어 사용 가능해야 함
2. **macOS 최적화**: vibrancy, 트레이 위치 등 macOS 우선
3. **Obsidian vault**: 경로가 config/settings.yaml에 설정되어 있어야 함
4. **항상 실행**: 트레이에 상주하며 리소스 사용
