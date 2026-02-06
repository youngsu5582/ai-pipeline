const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Service imports
const { createTray, updateTrayMenu } = require('./tray');
const { QuickInputWindow } = require('./windows/quick-input');
const { PopupWindow } = require('./windows/popup-window');
const { InteractiveJobRunner } = require('./services/interactive-job-runner');
const { ClaudeCode } = require('./services/claude-code');
const { ObsidianWriter } = require('./services/obsidian-writer');
const { SessionCollector } = require('./services/session-collector');

// Settings store
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

// Global variables
let mainWindow = null;
let tray = null;
let quickInputWindow = null;
let popupWindow = null;
let jobRunner = null;

// Start Express server (background)
function startExpressServer() {
  return new Promise((resolve) => {
    // Load server.js from relative path
    require('../server.js');
    // Allow time for server to start
    setTimeout(resolve, 1000);
  });
}

// Create main window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'MemoBot',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.loadURL('http://localhost:3030');

  mainWindow.once('ready-to-show', () => {
    // Show immediately in development mode
    if (process.env.NODE_ENV === 'development') {
      mainWindow.show();
    }
  });

  // Hide instead of close (keep running)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// Initialize app
async function initializeApp() {
  // Start Express server
  await startExpressServer();
  console.log('[Electron] Express server started');

  // Create tray
  tray = createTray({
    onShowDashboard: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    onQuickInput: () => showQuickInput(),
    onTodaySummary: () => showTodaySummary(),
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    }
  });

  // Create main window
  createMainWindow();

  // Initialize services
  const claudeCode = new ClaudeCode();
  const obsidianWriter = new ObsidianWriter();
  const sessionCollector = new SessionCollector();

  // Initialize Quick Input window
  quickInputWindow = new QuickInputWindow({
    tray,
    claudeCode,
    obsidianWriter,
    store
  });

  // Initialize Popup window
  popupWindow = new PopupWindow({
    tray,
    claudeCode,
    obsidianWriter,
    sessionCollector,
    store
  });

  // Initialize Interactive Job Runner
  jobRunner = new InteractiveJobRunner({
    popupWindow,
    claudeCode,
    obsidianWriter,
    sessionCollector,
    store
  });
  jobRunner.start();

  // Register shortcuts
  registerShortcuts();

  console.log('[Electron] App initialized');
}

// Register shortcuts
function registerShortcuts() {
  const shortcut = store.get('shortcuts.quickInput', 'CommandOrControl+Shift+Space');

  globalShortcut.register(shortcut, () => {
    showQuickInput();
  });
}

// Show quick input
function showQuickInput() {
  if (quickInputWindow) {
    quickInputWindow.show();
  }
}

// Show today summary
function showTodaySummary() {
  if (popupWindow) {
    popupWindow.showSummary();
  }
}

// Setup IPC handlers
function setupIPC() {
  // Save entry
  ipcMain.handle('save-entry', async (event, { text, type }) => {
    try {
      const claudeCode = new ClaudeCode();
      const obsidianWriter = new ObsidianWriter();

      // Format with Claude
      const formatted = await claudeCode.formatEntry(text);

      // Save to Obsidian
      await obsidianWriter.appendHourlyEntry(formatted);

      // Add to today's entries
      const today = new Date().toISOString().split('T')[0];
      const entries = store.get(`entries.${today}`, []);
      entries.push({
        time: new Date().toISOString(),
        text: formatted,
        raw: text
      });
      store.set(`entries.${today}`, entries);

      return { success: true, formatted };
    } catch (error) {
      console.error('[IPC] save-entry error:', error);
      return { success: false, error: error.message };
    }
  });

  // Ask Claude
  ipcMain.handle('ask-claude', async (event, { prompt }) => {
    try {
      const claudeCode = new ClaudeCode();
      const response = await claudeCode.ask(prompt);
      return { success: true, response };
    } catch (error) {
      console.error('[IPC] ask-claude error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get settings
  ipcMain.handle('get-settings', () => {
    return store.store;
  });

  // Save settings
  ipcMain.handle('save-settings', (event, settings) => {
    for (const [key, value] of Object.entries(settings)) {
      store.set(key, value);
    }
    return { success: true };
  });

  // Get today's entries
  ipcMain.handle('get-today-entries', () => {
    const today = new Date().toISOString().split('T')[0];
    return store.get(`entries.${today}`, []);
  });

  // Close window
  ipcMain.handle('close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    }
  });

  // Hide window
  ipcMain.handle('hide-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.hide();
    }
  });
}

// Electron app events
app.whenReady().then(() => {
  setupIPC();
  initializeApp();
});

// macOS: Dock icon click
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

// Keep app running even when all windows closed (tray)
app.on('window-all-closed', (e) => {
  // Don't quit on non-macOS if tray exists
  if (process.platform !== 'darwin') {
    // Keep running with tray
  }
});

// Before quit
app.on('before-quit', () => {
  app.isQuitting = true;
});

// Unregister shortcuts on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

module.exports = { store };
