# Electron 서비스 상세

Electron 앱의 각 서비스 클래스에 대한 코드 레벨 상세 분석입니다.

## 파일 구조

```
electron/
├── main.js                  # Electron 진입점
├── preload.js               # 컨텍스트 브릿지
├── tray.js                  # 시스템 트레이
├── windows/
│   ├── quick-input.js       # 빠른 입력 윈도우
│   └── popup-window.js      # 인터랙티브 팝업
└── services/
    ├── claude-code.js       # Claude CLI 연동
    ├── obsidian-writer.js   # Daily Note 저장
    ├── session-collector.js # Claude 세션 수집
    └── interactive-job-runner.js  # 인터랙티브 작업 실행
```

## 1. ClaudeCode (claude-code.js)

### 개요
Claude Code CLI (`claude --print`)를 사용하여 텍스트 처리 및 AI 응답을 생성합니다.

### 클래스 정의

```javascript
class ClaudeCode {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000;      // 1분 타임아웃
    this.maxBuffer = options.maxBuffer || 1024 * 1024 * 10;  // 10MB
  }
}
```

### 메서드

#### ask(prompt, options)

```javascript
/**
 * Claude에게 질문하고 응답 받기
 *
 * @param {string} prompt - 사용자 프롬프트
 * @param {object} options
 * @param {string} options.system - 시스템 프롬프트
 * @returns {Promise<string>} - Claude 응답
 *
 * @example
 * const response = await claudeCode.ask("오늘 뭐 했어?", {
 *   system: "한 줄로 요약해주세요"
 * });
 */
async ask(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];

    if (options.system) {
      args.push('--system-prompt', options.system);
    }

    args.push(prompt);

    // 실행: claude --print --system-prompt "시스템" "프롬프트"
    exec(
      `claude ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`,
      {
        maxBuffer: this.maxBuffer,
        timeout: this.timeout,
        encoding: 'utf8',
        shell: true,
        env: { ...process.env, TERM: 'dumb' }  // ANSI 색상 비활성화
      },
      (error, stdout, stderr) => {
        if (error) {
          // 에러 처리
          reject(error);
          return;
        }

        // ANSI 코드 제거 후 반환
        const cleanOutput = this.cleanOutput(stdout);
        resolve(cleanOutput);
      }
    );
  });
}
```

#### formatEntry(text)

```javascript
/**
 * 텍스트를 Daily Note 형식으로 포맷팅
 *
 * @param {string} text - 원본 텍스트
 * @returns {Promise<string>} - 이모지 + 한 줄 요약
 *
 * @example
 * const formatted = await claudeCode.formatEntry("코드 리뷰하고 버그 수정했음");
 * // 결과: "👨‍💻 코드 리뷰 및 버그 수정 완료"
 */
async formatEntry(text) {
  const systemPrompt = `당신은 Daily Note를 작성하는 비서입니다.
사용자의 입력을 Daily Note에 기록할 형태로 간단히 정리해주세요.

규칙:
- 이모지 한 개를 앞에 붙여주세요
- 한 줄로 간결하게 정리해주세요
- 핵심 내용만 유지하세요
- 말투는 자연스럽게 (예: "~했음", "~중")`;

  try {
    const response = await this.ask(text, { system: systemPrompt });
    return response.trim();
  } catch (error) {
    // 실패 시 기본 포맷
    return `📝 ${text}`;
  }
}
```

#### generateDailySummary(entries, sessions)

```javascript
/**
 * 일일 요약 생성
 *
 * @param {Array} entries - 오늘 기록 배열
 * @param {Array} sessions - Claude 세션 배열
 * @returns {Promise<string>} - 마크다운 형식 요약
 */
async generateDailySummary(entries, sessions) {
  const systemPrompt = `당신은 하루를 정리하는 비서입니다.
오늘 하루의 기록과 Claude 세션을 바탕으로 일일 요약을 작성해주세요.

요청사항:
1. "오늘 한 일" 섹션용 요약 (불렛 3-5개)
2. "오늘의 인사이트" 한 문장
3. 전체적인 하루 평가 (이모지 + 한 줄)

친근하고 따뜻한 톤으로 작성해주세요.`;

  const prompt = `오늘 하루 기록을 정리해주세요.

## 시간별 메모
${entries.map(e => {
  const time = new Date(e.time).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `- ${time}: ${e.text}`;
}).join('\n') || '(기록 없음)'}

## Claude 세션
${sessions.map(s =>
  `- ${s.summary || s.firstPrompt?.substring(0, 50) || '(제목 없음)'}`
).join('\n') || '(세션 없음)'}

위 내용을 바탕으로 일일 요약을 작성해주세요.`;

  return this.ask(prompt, { system: systemPrompt });
}
```

#### cleanOutput(text)

```javascript
/**
 * 출력 정리 (ANSI 이스케이프 코드 제거)
 */
cleanOutput(text) {
  if (!text) return '';

  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')  // ANSI 코드
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

## 2. ObsidianWriter (obsidian-writer.js)

### 개요
Obsidian vault의 Daily Note에 내용을 저장합니다.

### 클래스 정의

```javascript
class ObsidianWriter {
  constructor(options = {}) {
    this.config = this.loadConfig();
    this.vaultPath = this.expandPath(
      this.config?.vault?.path || '~/Documents/Obsidian'
    );
    this.dailyFolder = this.config?.vault?.daily_folder || 'DAILY';
  }
}
```

### 설정 로드

```javascript
/**
 * settings.yaml에서 설정 로드
 * 우선순위: settings.local.yaml > settings.yaml > settings.example.yaml
 */
loadConfig() {
  const configPaths = [
    path.join(__dirname, '../../../config/settings.local.yaml'),
    path.join(__dirname, '../../../config/settings.yaml'),
    path.join(__dirname, '../../../config/settings.example.yaml')
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        return yaml.load(content);
      }
    } catch (e) {
      console.warn(`Failed to load config from ${configPath}`);
    }
  }

  return {};
}
```

### 메서드

#### getDailyNotePath(date)

```javascript
/**
 * Daily Note 파일 경로 반환
 *
 * @param {string|null} date - YYYY-MM-DD (null이면 오늘)
 * @returns {string} - 파일 경로
 *
 * @example
 * getDailyNotePath('2026-02-06')
 * // → "/Users/user/Documents/Obsidian/MyVault/DAILY/2026-02-06.md"
 */
getDailyNotePath(date = null) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  return path.join(this.vaultPath, this.dailyFolder, `${targetDate}.md`);
}
```

#### ensureDailyNote(date)

```javascript
/**
 * Daily Note 존재 확인 및 생성
 *
 * @param {string|null} date
 * @returns {string} - 파일 경로
 */
ensureDailyNote(date = null) {
  const dailyPath = this.getDailyNotePath(date);
  const dirPath = path.dirname(dailyPath);

  // 디렉토리 생성
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // 파일이 없으면 템플릿으로 생성
  if (!fs.existsSync(dailyPath)) {
    const template = this.createDailyNoteTemplate(date);
    fs.writeFileSync(dailyPath, template, 'utf8');
    console.log(`[ObsidianWriter] Created daily note: ${dailyPath}`);
  }

  return dailyPath;
}
```

#### appendToSection(sectionHeader, content, date)

```javascript
/**
 * 특정 섹션에 내용 추가 (append)
 *
 * @param {string} sectionHeader - 섹션 헤더 (예: "## 시간별 메모")
 * @param {string} content - 추가할 내용
 * @param {string|null} date - 대상 날짜
 *
 * @example
 * await writer.appendToSection(
 *   "## ⏰ 시간별 메모",
 *   "- `14:30` 회의 참석함",
 *   "2026-02-06"
 * );
 */
async appendToSection(sectionHeader, content, date = null) {
  const dailyPath = this.ensureDailyNote(date);
  let fileContent = fs.readFileSync(dailyPath, 'utf8');

  // 섹션 찾기
  const sectionRegex = new RegExp(
    `(${this.escapeRegex(sectionHeader)}[^\n]*\n)`,
    'i'
  );

  if (sectionRegex.test(fileContent)) {
    // 섹션 바로 다음에 추가
    fileContent = fileContent.replace(sectionRegex, `$1${content}\n`);
  } else {
    // 섹션이 없으면 파일 끝에 추가
    fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
  }

  fs.writeFileSync(dailyPath, fileContent, 'utf8');
  console.log(`[ObsidianWriter] Appended to ${sectionHeader}`);
}
```

#### replaceSection(sectionHeader, newContent, date)

```javascript
/**
 * 섹션 내용 전체 교체
 *
 * @param {string} sectionHeader - 섹션 헤더
 * @param {string} newContent - 새 내용
 * @param {string|null} date
 *
 * @example
 * await writer.replaceSection(
 *   "## ✅ 오늘 한 일",
 *   "- 회의 참석\n- 코드 리뷰\n- 배포 완료"
 * );
 */
async replaceSection(sectionHeader, newContent, date = null) {
  const dailyPath = this.ensureDailyNote(date);
  let fileContent = fs.readFileSync(dailyPath, 'utf8');

  // 섹션 전체 교체 (다음 ## 전까지)
  const pattern = new RegExp(
    `${this.escapeRegex(sectionHeader)}[^\n]*\n[\\s\\S]*?(?=\n## |$)`,
    'i'
  );

  if (pattern.test(fileContent)) {
    fileContent = fileContent.replace(
      pattern,
      `${sectionHeader}\n${newContent}\n`
    );
  } else {
    // 섹션이 없으면 끝에 추가
    fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${newContent}\n`;
  }

  fs.writeFileSync(dailyPath, fileContent, 'utf8');
  console.log(`[ObsidianWriter] Replaced ${sectionHeader}`);
}
```

#### 헬퍼 메서드

```javascript
/**
 * 시간별 기록 추가
 */
async appendHourlyEntry(text, time = null) {
  const now = time || new Date();
  const timeStr = now.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const entry = `- \`${timeStr}\` ${text}`;

  await this.appendToSection('## ⏰ 시간별 메모', entry);
}

/**
 * 일일 요약 업데이트
 */
async updateDailySummary(summaryContent) {
  await this.replaceSection('## ✅ 오늘 한 일', summaryContent);
}

/**
 * Claude 세션 섹션 업데이트
 */
async updateClaudeSessions(sessionContent) {
  await this.replaceSection('## 🤖 Claude 세션 요약', sessionContent);
}

/**
 * 정규식 이스케이프
 */
escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

## 3. SessionCollector (session-collector.js)

### 개요
`~/.claude/projects/` 디렉토리에서 Claude Code 세션 정보를 수집합니다.

### 클래스 정의

```javascript
class SessionCollector {
  constructor() {
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }
}
```

### 메서드

#### findTodaySessions(targetDate)

```javascript
/**
 * 특정 날짜의 Claude 세션 찾기
 *
 * @param {string|null} targetDate - YYYY-MM-DD (null이면 오늘)
 * @returns {Array} 세션 목록
 *
 * @example
 * const sessions = collector.findTodaySessions();
 * // [
 * //   {
 * //     projectDir: "-Users-user-ai-pipeline",
 * //     sessionId: "abc123",
 * //     summary: "Dashboard 기능 구현",
 * //     messageCount: 15,
 * //     created: "2026-02-06T10:00:00Z",
 * //     modified: "2026-02-06T12:30:00Z"
 * //   }
 * // ]
 */
findTodaySessions(targetDate = null) {
  const date = targetDate || new Date().toISOString().split('T')[0];
  const sessions = [];

  if (!fs.existsSync(this.projectsDir)) {
    return sessions;
  }

  try {
    const projectDirs = fs.readdirSync(this.projectsDir);

    for (const projectDir of projectDirs) {
      const projectPath = path.join(this.projectsDir, projectDir);
      const indexPath = path.join(projectPath, 'sessions-index.json');

      if (!fs.existsSync(indexPath)) continue;

      try {
        const indexContent = fs.readFileSync(indexPath, 'utf8');
        const index = JSON.parse(indexContent);

        for (const entry of index.entries || []) {
          // 날짜 확인 (modified 또는 created)
          const entryDate = (entry.modified || entry.created || '').split('T')[0];

          if (entryDate === date) {
            sessions.push({
              projectDir,
              sessionId: entry.sessionId,
              summary: entry.summary,
              firstPrompt: entry.firstPrompt,
              messageCount: entry.messageCount,
              created: entry.created,
              modified: entry.modified,
              gitBranch: entry.gitBranch,
              projectPath: entry.projectPath
            });
          }
        }
      } catch (parseError) {
        console.warn(`Failed to parse ${indexPath}`);
      }
    }

    // 최신순 정렬
    sessions.sort((a, b) => {
      const timeA = new Date(a.modified || a.created || 0).getTime();
      const timeB = new Date(b.modified || b.created || 0).getTime();
      return timeB - timeA;
    });

  } catch (error) {
    console.error('[SessionCollector] Error:', error);
  }

  return sessions;
}
```

#### buildSessionSummary(sessions)

```javascript
/**
 * 세션 목록을 마크다운 요약으로 변환
 *
 * @param {Array} sessions
 * @returns {string} 마크다운 형식 요약
 */
buildSessionSummary(sessions) {
  if (!sessions || sessions.length === 0) {
    return '_No Claude Code sessions today._';
  }

  const lines = [`**Sessions: ${sessions.length}**\n`];

  // 프로젝트별 그룹핑
  const byProject = {};
  for (const s of sessions) {
    let project = 'default';
    if (s.projectPath) {
      project = path.basename(s.projectPath);
    } else if (s.projectDir) {
      // -Users-user-ai-pipeline 형식에서 마지막 부분
      const parts = s.projectDir.split('-');
      project = parts[parts.length - 1] || 'default';
    }

    if (!byProject[project]) byProject[project] = [];
    byProject[project].push(s);
  }

  // 프로젝트별 출력
  for (const [project, projectSessions] of Object.entries(byProject)) {
    lines.push(`\n### ${project}`);

    for (const s of projectSessions) {
      const time = s.modified
        ? new Date(s.modified).toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit'
          })
        : '';

      const title = s.summary || s.firstPrompt?.substring(0, 60) || '(untitled)';
      const messageInfo = s.messageCount ? ` (${s.messageCount} messages)` : '';

      lines.push(`- ${time ? `\`${time}\` ` : ''}${title}${messageInfo}`);
    }
  }

  return lines.join('\n');
}
```

## 4. InteractiveJobRunner (interactive-job-runner.js)

### 개요
`jobs.json`의 `interactive: true` 작업을 스케줄링하고 실행합니다.

### 클래스 정의

```javascript
class InteractiveJobRunner {
  constructor(options = {}) {
    this.popupWindow = options.popupWindow;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.sessionCollector = options.sessionCollector;
    this.store = options.store;

    this.scheduledJobs = new Map();  // jobId → CronTask
    this.jobs = [];  // 인터랙티브 작업 배열
  }
}
```

### 메서드

#### start()

```javascript
/**
 * 서비스 시작
 */
start() {
  this.loadJobs();
  this.scheduleJobs();
  console.log(`[JobRunner] Started with ${this.jobs.length} interactive jobs`);
}

/**
 * jobs.json에서 인터랙티브 작업 로드
 */
loadJobs() {
  try {
    const jobsPath = path.join(__dirname, '../../jobs.json');
    const data = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    this.jobs = (data.jobs || []).filter(job => job.interactive === true);
  } catch (error) {
    console.error('[JobRunner] Failed to load jobs:', error);
    this.jobs = [];
  }
}

/**
 * 작업 스케줄링
 */
scheduleJobs() {
  // 기존 스케줄 취소
  this.scheduledJobs.forEach(task => task.stop());
  this.scheduledJobs.clear();

  // 새 스케줄 등록
  this.jobs.forEach(job => {
    if (job.schedule && job.enabled !== false) {
      try {
        const task = cron.schedule(job.schedule, () => {
          this.executeJob(job);
        });
        this.scheduledJobs.set(job.id, task);
        console.log(`[JobRunner] Scheduled: ${job.name} (${job.schedule})`);
      } catch (error) {
        console.error(`[JobRunner] Failed to schedule ${job.id}:`, error);
      }
    }
  });
}
```

#### executeJob(job)

```javascript
/**
 * 작업 실행
 *
 * @param {object} job - 작업 정의
 */
async executeJob(job) {
  console.log(`[JobRunner] Executing: ${job.name}`);

  try {
    // 1. 알림 설정 확인
    const settings = this.store.get('notificationSettings', {});
    if (settings.enabled === false) {
      console.log(`[JobRunner] Notifications disabled, skipping`);
      return;
    }

    // 2. 시간대 확인
    const now = new Date();
    const hour = now.getHours();
    if (hour < (settings.startHour || 0) || hour >= (settings.endHour || 24)) {
      console.log(`[JobRunner] Outside notification hours, skipping`);
      return;
    }

    // 3. 데이터 수집
    const collectedData = await this.collectData(job);

    // 4. 팝업 표시 및 사용자 입력 대기
    const userInput = await this.popupWindow.show(job, collectedData);

    // 5. 입력이 없으면 종료 (스킵)
    if (!userInput && job.popup?.inputType !== 'quick-buttons') {
      console.log(`[JobRunner] User skipped: ${job.name}`);
      return;
    }

    // 6. Claude 처리
    let processedContent = userInput?.text || userInput;
    if (job.processing?.claude?.enabled) {
      processedContent = await this.processWithClaude(
        job,
        processedContent,
        collectedData
      );
    }

    // 7. 저장
    await this.saveOutput(job, processedContent, collectedData);

    console.log(`[JobRunner] Completed: ${job.name}`);

  } catch (error) {
    console.error(`[JobRunner] Error executing ${job.name}:`, error);
  }
}
```

#### collectData(job)

```javascript
/**
 * 데이터 수집 (팝업에 표시용)
 */
async collectData(job) {
  const data = {};

  if (job.collect?.todayEntries) {
    const today = new Date().toISOString().split('T')[0];
    data.entries = this.store.get(`entries.${today}`, []);
  }

  if (job.collect?.claudeSessions) {
    try {
      data.sessions = this.sessionCollector.findTodaySessions();
    } catch (e) {
      data.sessions = [];
    }
  }

  return data;
}
```

#### processWithClaude(job, input, collectedData)

```javascript
/**
 * Claude로 입력 처리
 */
async processWithClaude(job, input, collectedData) {
  const config = job.processing.claude;

  try {
    // 시스템 프롬프트 구성
    let systemPrompt = config.prompt || '';

    // 수집된 데이터 추가
    if (collectedData && Object.keys(collectedData).length > 0) {
      systemPrompt += '\n\n수집된 데이터:';

      if (collectedData.entries?.length > 0) {
        systemPrompt += '\n\n## 오늘 기록\n';
        collectedData.entries.forEach(e => {
          const time = new Date(e.time).toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit'
          });
          systemPrompt += `- ${time}: ${e.text}\n`;
        });
      }

      if (collectedData.sessions?.length > 0) {
        systemPrompt += '\n\n## Claude 세션\n';
        collectedData.sessions.forEach(s => {
          systemPrompt += `- ${s.summary || s.firstPrompt?.substring(0, 50)}\n`;
        });
      }
    }

    // Claude 호출
    const response = await this.claudeCode.ask(
      input || '정리해주세요',
      { system: systemPrompt }
    );

    return response;

  } catch (error) {
    console.error('[JobRunner] Claude processing failed:', error);
    return input;  // 실패 시 원본 반환
  }
}
```

#### saveOutput(job, content, collectedData)

```javascript
/**
 * 결과 저장
 */
async saveOutput(job, content, collectedData) {
  if (!job.output) return;

  const target = job.output.target;
  const now = new Date();

  try {
    if (target === 'obsidian-daily') {
      // 시간 포맷팅
      const time = now.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit'
      });

      // 포맷 적용
      let formatted = content;
      if (job.output.format) {
        formatted = job.output.format
          .replace('{time}', time)
          .replace('{content}', content);
      }

      // 섹션별 저장
      if (job.output.sections) {
        for (const section of job.output.sections) {
          let sectionContent = '';

          if (section.type === 'summary') {
            sectionContent = content;
          } else if (section.type === 'sessions' && collectedData?.sessions) {
            sectionContent = this.formatSessions(collectedData.sessions);
          }

          await this.obsidianWriter.replaceSection(section.name, sectionContent);
        }
      } else if (job.output.section) {
        await this.obsidianWriter.appendToSection(job.output.section, formatted);
      }

      // store에도 저장 (오늘 기록 트래킹)
      const today = now.toISOString().split('T')[0];
      const entries = this.store.get(`entries.${today}`, []);
      entries.push({
        time: now.toISOString(),
        text: content,
        jobId: job.id
      });
      this.store.set(`entries.${today}`, entries);
    }
  } catch (error) {
    console.error('[JobRunner] Failed to save output:', error);
  }
}
```

## 5. 윈도우 컴포넌트

### QuickInputWindow

```javascript
class QuickInputWindow {
  constructor(options = {}) {
    this.tray = options.tray;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.store = options.store;
    this.window = null;
  }

  show() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    this.createWindow();
  }

  createWindow() {
    const position = this.calculatePosition();

    this.window = new BrowserWindow({
      width: 420,
      height: 280,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      vibrancy: 'popover',  // macOS 블러
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true
      }
    });

    this.window.loadFile(path.join(__dirname, '../../public/quick-input.html'));

    // 포커스 잃으면 숨기기
    this.window.on('blur', () => this.hide());
  }
}
```

### PopupWindow

```javascript
class PopupWindow {
  constructor(options = {}) {
    this.tray = options.tray;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.sessionCollector = options.sessionCollector;
    this.store = options.store;
    this.window = null;
    this.resolvePromise = null;
    this.reminderTimeout = null;
  }

  /**
   * 팝업 표시 및 입력 대기
   * @returns {Promise<string|null>} 사용자 입력
   */
  async show(job, collectedData = null) {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.createWindow(job, collectedData);

      // 리마인더 설정
      if (job.popup?.reminderMinutes) {
        this.setReminder(job, collectedData);
      }
    });
  }

  createWindow(job, collectedData) {
    const position = this.calculatePosition();
    const size = this.calculateSize(job);

    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      vibrancy: 'popover',
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true
      }
    });

    this.window.loadFile(path.join(__dirname, '../../public/popup/popup.html'));

    // 데이터 전달
    this.window.webContents.once('did-finish-load', () => {
      this.window.webContents.send('popup-data', { job, collectedData });
    });
  }

  // IPC 핸들러 (setupIPC에서 등록)
  // - 'submit-popup': 입력 완료
  // - 'skip-popup': 스킵
}
```
