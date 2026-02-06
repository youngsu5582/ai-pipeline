const { BrowserWindow, screen } = require('electron');
const path = require('path');

/**
 * 빠른 입력 윈도우 (메뉴바 앱)
 * Raycast/Alfred 스타일의 드롭다운 입력창
 */
class QuickInputWindow {
  constructor(options = {}) {
    this.tray = options.tray;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.store = options.store;
    this.window = null;
  }

  /**
   * 윈도우 표시
   */
  show() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    this.createWindow();
  }

  /**
   * 윈도우 숨기기
   */
  hide() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide();
    }
  }

  /**
   * 윈도우 생성
   */
  createWindow() {
    // 트레이 위치 또는 화면 중앙 계산
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
      vibrancy: 'popover', // macOS 블러 효과
      visualEffectState: 'active',
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.loadFile(path.join(__dirname, '../../public/quick-input.html'));

    // 포커스 잃으면 숨기기
    this.window.on('blur', () => {
      this.hide();
    });

    // 윈도우 닫힘 처리
    this.window.on('closed', () => {
      this.window = null;
    });

    // 윈도우 숨김 처리
    this.window.on('hide', () => {
      // 숨겨도 참조 유지
    });
  }

  /**
   * 윈도우 위치 계산
   */
  calculatePosition() {
    // 트레이 위치 가져오기
    if (this.tray) {
      try {
        const trayBounds = this.tray.getBounds();
        return {
          x: Math.round(trayBounds.x - 200 + trayBounds.width / 2),
          y: trayBounds.y + trayBounds.height + 5
        };
      } catch (e) {
        // 트레이 위치 가져오기 실패 시 화면 중앙
      }
    }

    // 화면 중앙 상단
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;

    return {
      x: Math.round(width / 2 - 210),
      y: 100
    };
  }
}

module.exports = { QuickInputWindow };
