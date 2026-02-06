const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let callbacks = {};

/**
 * 시스템 트레이 생성
 */
function createTray(options = {}) {
  callbacks = options;

  // 트레이 아이콘 (없으면 기본 아이콘)
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // 기본 아이콘 생성 (16x16 흰색 원)
      icon = createDefaultIcon();
    }
  } catch (e) {
    icon = createDefaultIcon();
  }

  // 템플릿 이미지로 설정 (macOS 다크모드 지원)
  icon = icon.resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('MemoBot - 개인 비서');

  // 메뉴 설정
  updateTrayMenu();

  // 클릭 이벤트 (macOS: 왼쪽 클릭으로 메뉴 표시)
  tray.on('click', () => {
    if (callbacks.onQuickInput) {
      callbacks.onQuickInput();
    }
  });

  return tray;
}

/**
 * 기본 아이콘 생성 (SVG 기반)
 */
function createDefaultIcon() {
  // 간단한 로봇 아이콘 (Base64 PNG)
  const base64Icon = `
    iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz
    AAALEwAACxMBAJqcGAAAARlJREFUOI2lkz1uwzAMha+TLkWXTr2Ah9zAW4Yu3XqCHqFDB2++gYcu
    PUKHLl2yNd2ypB2SfHWSJv0SIMAPkI+PpChJZkafoAKwa1Oze2Y4gBcAJGY2LwBOSdrM7JqkDOBm
    AN6Y2RXAU0m3EyEC4ImZ3UYCgDsjBkm3dYgkM7siuQdwH8AJSR8SEUCPpA8kHwFci6QPZnZG8gHA
    NUkfAexJngDcALgm6SMj6QPJRwDXJH0AsA9wEWP+lmQyM+0B3AFIksQSiWjfhgKbmW6T3CN5iIjL
    iFgGOCP5DeBexJzN7N+Z6CnJAwDnACaS3gM4JTkHcBNj3ov0k8cCSXcArkmOY8x7Et+SfBLxbUT6
    SfIOwAWAU5LeAzglOQdwS3IeyR9DxXDvSKYAAAAASUVORK5CYII=
  `.replace(/\s/g, '');

  return nativeImage.createFromDataURL(`data:image/png;base64,${base64Icon}`);
}

/**
 * 트레이 메뉴 업데이트
 */
function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Dashboard 열기',
      click: () => {
        if (callbacks.onShowDashboard) {
          callbacks.onShowDashboard();
        }
      }
    },
    {
      label: '지금 기록하기',
      accelerator: 'CmdOrCtrl+Shift+Space',
      click: () => {
        if (callbacks.onQuickInput) {
          callbacks.onQuickInput();
        }
      }
    },
    { type: 'separator' },
    {
      label: '오늘 요약 보기',
      click: () => {
        if (callbacks.onTodaySummary) {
          callbacks.onTodaySummary();
        }
      }
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        if (callbacks.onQuit) {
          callbacks.onQuit();
        }
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

module.exports = {
  createTray,
  updateTrayMenu
};
