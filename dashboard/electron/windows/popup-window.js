const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

/**
 * 인터랙티브 작업 팝업 윈도우
 * 스케줄된 작업이 실행될 때 표시되는 팝업
 */
class PopupWindow {
  constructor(options = {}) {
    this.tray = options.tray;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.sessionCollector = options.sessionCollector;
    this.store = options.store;
    this.window = null;
    this.currentJob = null;
    this.resolvePromise = null;
    this.reminderTimeout = null;

    // IPC 핸들러 등록
    this.setupIPC();
  }

  /**
   * IPC 핸들러 설정
   */
  setupIPC() {
    ipcMain.handle('submit-popup', async (event, response) => {
      if (this.resolvePromise) {
        this.resolvePromise(response);
        this.resolvePromise = null;
      }
      this.clearReminder();
      this.hide();
      return { success: true };
    });

    ipcMain.handle('skip-popup', async () => {
      if (this.resolvePromise) {
        this.resolvePromise(null);
        this.resolvePromise = null;
      }
      this.hide();
      // 리마인더가 설정되어 있으면 유지
      return { success: true };
    });
  }

  /**
   * 작업 팝업 표시
   * @param {Object} job - 작업 정의
   * @param {Object} collectedData - 수집된 데이터 (선택)
   * @returns {Promise<string|null>} - 사용자 입력 또는 null
   */
  async show(job, collectedData = null) {
    this.currentJob = job;

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.createWindow(job, collectedData);

      // 리마인더 설정
      if (job.popup?.reminderMinutes) {
        this.setReminder(job, collectedData);
      }
    });
  }

  /**
   * 오늘 요약 팝업 표시
   */
  async showSummary() {
    const job = {
      id: 'manual-summary',
      name: '오늘 요약',
      popup: {
        character: 'happy',
        prompts: ['오늘 하루를 확인해볼까요?'],
        inputType: 'review',
        showCollectedData: true
      },
      collect: {
        todayEntries: true,
        claudeSessions: true
      }
    };

    // 데이터 수집
    const collectedData = await this.collectData(job);

    this.createWindow(job, collectedData);
  }

  /**
   * 데이터 수집
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

  /**
   * 윈도우 생성
   */
  createWindow(job, collectedData) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }

    const position = this.calculatePosition();
    const size = this.calculateSize(job);

    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.loadFile(path.join(__dirname, '../../public/popup/popup.html'));

    // 데이터 전달
    this.window.webContents.once('did-finish-load', () => {
      this.window.webContents.send('popup-data', {
        job,
        collectedData
      });
    });

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  /**
   * 윈도우 크기 계산
   */
  calculateSize(job) {
    const inputType = job.popup?.inputType || 'textarea';

    switch (inputType) {
      case 'quick-buttons':
        return { width: 380, height: 240 };
      case 'review':
        return { width: 500, height: 500 };
      default:
        return { width: 420, height: 320 };
    }
  }

  /**
   * 윈도우 위치 계산 (화면 중앙)
   */
  calculatePosition() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    return {
      x: Math.round(width / 2 - 210),
      y: Math.round(height / 3)
    };
  }

  /**
   * 윈도우 숨기기
   */
  hide() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
      this.window = null;
    }
  }

  /**
   * 리마인더 설정
   */
  setReminder(job, collectedData) {
    const minutes = job.popup.reminderMinutes || 5;
    const maxReminders = job.popup.maxReminders || 1;
    let reminderCount = 0;

    this.reminderTimeout = setTimeout(() => {
      reminderCount++;

      if (reminderCount <= maxReminders && !this.window) {
        // 리마인더 팝업 표시
        const reminderJob = {
          ...job,
          popup: {
            ...job.popup,
            character: 'reminder',
            prompts: job.popup.reminderPrompts || [
              '아까 물어봤는데... 괜찮으면 알려줘요 &#128522;',
              '짧게라도 남겨보는 건 어때요?'
            ]
          }
        };

        this.createWindow(reminderJob, collectedData);
      }
    }, minutes * 60 * 1000);
  }

  /**
   * 리마인더 취소
   */
  clearReminder() {
    if (this.reminderTimeout) {
      clearTimeout(this.reminderTimeout);
      this.reminderTimeout = null;
    }
  }
}

module.exports = { PopupWindow };
