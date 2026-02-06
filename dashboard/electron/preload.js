const { contextBridge, ipcRenderer } = require('electron');

// Electron API를 렌더러 프로세스에 노출
contextBridge.exposeInMainWorld('electronAPI', {
  // 엔트리 저장
  saveEntry: (text, type = 'quick') => ipcRenderer.invoke('save-entry', { text, type }),

  // Claude에게 질문
  askClaude: (prompt) => ipcRenderer.invoke('ask-claude', { prompt }),

  // 설정
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // 오늘 기록
  getTodayEntries: () => ipcRenderer.invoke('get-today-entries'),

  // 창 제어
  closeWindow: () => ipcRenderer.invoke('close-window'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),

  // 이벤트 수신
  onShowPopup: (callback) => {
    ipcRenderer.on('show-popup', (event, data) => callback(data));
  },

  onPopupData: (callback) => {
    ipcRenderer.on('popup-data', (event, data) => callback(data));
  },

  // 팝업 응답
  submitPopup: (response) => ipcRenderer.invoke('submit-popup', response),
  skipPopup: () => ipcRenderer.invoke('skip-popup')
});

// 플랫폼 정보
contextBridge.exposeInMainWorld('platform', {
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux'
});
