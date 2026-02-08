'use strict';

const express = require('express');
const cors = require('cors');

// ============ State & Modules ============
const state = require('./lib/state');
const { initializeJobs } = require('./lib/scheduler');

// ============ Express App ============
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ Routes ============
const jobsRouter = require('./routes/jobs');
const statsRouter = require('./routes/stats');
const settingsRouter = require('./routes/settings');
const tasksRouter = require('./routes/tasks');
const notesRouter = require('./routes/notes');
const sessionsRouter = require('./routes/sessions');
const homeRouter = require('./routes/home');

// Jobs & Edges
app.use('/api/jobs', jobsRouter);
app.use('/api/edges', (req, res, next) => {
  // Forward /api/edges/* to jobs router's edge handlers
  req.url = '/edges' + req.url;
  jobsRouter(req, res, next);
});

// Stats & History & Export
app.use('/api/stats', statsRouter);
app.get('/api/history', (req, res, next) => { req.url = '/history'; statsRouter(req, res, next); });
app.get('/api/categories', (req, res, next) => { req.url = '/categories'; statsRouter(req, res, next); });
app.post('/api/validate-cron', (req, res, next) => { req.url = '/validate-cron'; statsRouter(req, res, next); });
app.get('/api/health', (req, res, next) => { req.url = '/health'; statsRouter(req, res, next); });
app.get('/api/export/history', (req, res, next) => { req.url = '/export/history'; statsRouter(req, res, next); });
app.get('/api/export/stats', (req, res, next) => { req.url = '/export/stats'; statsRouter(req, res, next); });
app.get('/api/export/jobs', (req, res, next) => { req.url = '/export/jobs'; statsRouter(req, res, next); });

// Settings, Webhook tokens, Notifications, Import/Export
app.use('/api/settings', settingsRouter);
app.use('/api/webhook-tokens', (req, res, next) => { req.url = '/webhook-tokens' + req.url; settingsRouter(req, res, next); });
app.post('/api/webhook/:token', (req, res, next) => { req.url = `/webhook/${req.params.token}`; settingsRouter(req, res, next); });
app.post('/api/notifications/test', (req, res, next) => { req.url = '/notifications/test'; settingsRouter(req, res, next); });
app.get('/api/export', (req, res, next) => { req.url = '/export'; settingsRouter(req, res, next); });
app.post('/api/import', (req, res, next) => { req.url = '/import'; settingsRouter(req, res, next); });

// Tasks (async job system + SSE)
app.use('/api/tasks', tasksRouter);

// Notes (memos, morning plans, backlogs, obsidian)
app.use('/api', notesRouter);

// Sessions (session list, detail, insights, knowledge graph, reports)
app.use('/api/sessions', sessionsRouter);
app.get('/api/reports/daily', (req, res, next) => { req.url = '/reports/daily'; sessionsRouter(req, res, next); });
app.get('/api/knowledge-graph', (req, res, next) => { req.url = '/knowledge-graph'; sessionsRouter(req, res, next); });
app.post('/api/knowledge-graph/rebuild', (req, res, next) => { req.url = '/knowledge-graph/rebuild'; sessionsRouter(req, res, next); });
app.get('/api/knowledge-graph/recommendations', (req, res, next) => { req.url = '/knowledge-graph/recommendations'; sessionsRouter(req, res, next); });

// Home (timeline, search, today, productivity, weekly digest, ask, github)
app.use('/api', homeRouter);

// Widget layout
app.get('/api/settings/widget-layout', (req, res, next) => { req.url = '/widget-layout'; settingsRouter(req, res, next); });
app.put('/api/settings/widget-layout', (req, res, next) => { req.url = '/widget-layout'; settingsRouter(req, res, next); });

// ============ Global Error Handlers ============
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] ⚠️ Unhandled Promise Rejection:`, reason);
});

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ Uncaught Exception:`, err.message);
  console.error('  Stack:', err.stack);
});

// ============ Graceful Shutdown ============
function cleanupRunningJobs() {
  const now = new Date().toISOString();
  let cleaned = 0;
  for (const entry of state.jobHistory) {
    if (entry.status === 'running') {
      entry.status = 'failed';
      entry.error = 'Server shutdown';
      entry.endTime = now;
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Server] ${cleaned}개 실행 중 작업 정리됨`);
    state.saveHistory();
  }
}

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM 수신 - 정상 종료 중...');
  cleanupRunningJobs();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT 수신 - 정상 종료 중...');
  cleanupRunningJobs();
  process.exit(0);
});

// ============ Start Server ============
// Load history on startup
state.jobHistory = state.loadHistory();

app.listen(state.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     AI Pipeline Dashboard                            ║
║     http://localhost:${state.PORT}                            ║
╚══════════════════════════════════════════════════════╝
  `);

  const zombieCount = state.jobHistory.filter(h => h.status === 'running').length;
  if (zombieCount > 0) {
    console.log(`[Server] 이전 좀비 작업 ${zombieCount}개 정리 중...`);
    cleanupRunningJobs();
  }

  initializeJobs();
});
