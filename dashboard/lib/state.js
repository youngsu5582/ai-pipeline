'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Constants
const PORT = process.env.PORT || 3030;
let DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3030';

const JOBS_FILE = path.join(__dirname, '..', 'jobs.json');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory state
const taskQueue = new Map();
const sseClients = new Map();
const runningTaskProcesses = new Map();
let scheduledJobs = {};
let jobHistory = [];
let runningJobs = {};
let jobRetryCount = {};
const scheduledOnceJobs = {};

// KST date helper
function getKSTDateString(date) {
  const d = date || new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// Load/Save jobs.json
function loadJobs() {
  try {
    const data = fs.readFileSync(JOBS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading jobs:', error);
    return { jobs: [], categories: {} };
  }
}

function saveJobs(data) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
}

// Get setting value helper
function getSettingValue(key, defaultValue) {
  try {
    const data = loadJobs();
    return data.settings?.[key] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

// Load/Save history
function loadHistory() {
  const historyFile = path.join(LOGS_DIR, 'history.json');
  try {
    if (fs.existsSync(historyFile)) {
      return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading history:', error);
  }
  return [];
}

function saveHistory() {
  const historyFile = path.join(LOGS_DIR, 'history.json');
  const trimmed = jobHistory.slice(-100);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}

// Session aliases
const SESSION_ALIASES_FILE = path.join(DATA_DIR, 'session-aliases.json');

function loadSessionAliases() {
  try {
    if (fs.existsSync(SESSION_ALIASES_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_ALIASES_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSessionAliases(aliases) {
  const dir = path.dirname(SESSION_ALIASES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

// Webhook tokens
const WEBHOOK_TOKENS_FILE = path.join(DATA_DIR, 'webhook-tokens.json');

function loadWebhookTokens() {
  try {
    if (fs.existsSync(WEBHOOK_TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(WEBHOOK_TOKENS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveWebhookTokens(tokens) {
  const dir = path.dirname(WEBHOOK_TOKENS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEBHOOK_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Generic JSON store helpers
function loadJsonFile(filePath, defaultValue = []) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return defaultValue;
}

function saveJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Data file paths
const DATA_FILES = {
  quickMemos: path.join(DATA_DIR, 'quick-memos.json'),
  backlogs: path.join(DATA_DIR, 'backlogs.json'),
  morningPlans: path.join(DATA_DIR, 'morning-plans.json'),
  weeklyDigests: path.join(DATA_DIR, 'weekly-digests.json'),
  sessionSummaries: path.join(DATA_DIR, 'session-summaries.json'),
  dailyReports: path.join(DATA_DIR, 'daily-reports.json'),
  memoCategories: path.join(DATA_DIR, 'memo-categories.json'),
  sessionInsights: path.join(DATA_DIR, 'session-insights.json'),
  knowledgeGraph: path.join(DATA_DIR, 'knowledge-graph.json'),
  reviewAnalysis: path.join(DATA_DIR, 'review-analysis.json'),
  widgetLayout: path.join(DATA_DIR, 'widget-layout.json'),
};

module.exports = {
  // Constants
  PORT, DASHBOARD_URL,
  JOBS_FILE, LOGS_DIR, DATA_DIR,
  CLAUDE_PROJECTS,
  DATA_FILES,

  // Mutable state (accessed by reference)
  taskQueue,
  sseClients,
  runningTaskProcesses,
  get scheduledJobs() { return scheduledJobs; },
  set scheduledJobs(v) { scheduledJobs = v; },
  get jobHistory() { return jobHistory; },
  set jobHistory(v) { jobHistory = v; },
  get runningJobs() { return runningJobs; },
  set runningJobs(v) { runningJobs = v; },
  get jobRetryCount() { return jobRetryCount; },
  set jobRetryCount(v) { jobRetryCount = v; },
  scheduledOnceJobs,

  // Functions
  getKSTDateString,
  loadJobs,
  saveJobs,
  getSettingValue,
  loadHistory,
  saveHistory,
  loadSessionAliases,
  saveSessionAliases,
  loadWebhookTokens,
  saveWebhookTokens,
  loadJsonFile,
  saveJsonFile,

  // Allow DASHBOARD_URL to be updated
  get dashboardUrl() { return DASHBOARD_URL; },
  set dashboardUrl(v) { DASHBOARD_URL = v; },
};
