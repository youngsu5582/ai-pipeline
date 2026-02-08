'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const router = express.Router();
const state = require('../lib/state');
const { findSessions, findSessionsBulk, loadSessionSummaries } = require('../lib/sessions');
const { loadQuickMemos, loadMorningPlans, loadBacklogs } = require('../lib/notes');
const { getObsidianPaths, parseObsidianMemos } = require('../lib/obsidian');
const { getGhAccounts, ghExec, fetchGithubEventsForAccount } = require('../lib/github');
const { generateSuggestions, loadWeeklyDigests, loadReviewAnalysis } = require('../lib/analysis');
const { generateTaskId } = require('../lib/sse');

// Today summary
router.get('/today/summary', (req, res) => {
  const targetDate = req.query.date || state.getKSTDateString();
  try {
    const sessions = findSessions(targetDate);
    const jobsForDate = state.jobHistory.filter(h => h.startTime?.startsWith(targetDate));
    res.json({
      date: targetDate,
      sessionsCount: sessions.length,
      jobsCount: jobsForDate.length,
      successCount: jobsForDate.filter(j => j.status === 'success').length,
      failedCount: jobsForDate.filter(j => j.status === 'failed').length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Timeline
router.get('/timeline', async (req, res) => {
  const date = req.query.date || state.getKSTDateString();
  const items = [];

  // Job history
  const history = [...state.jobHistory];
  history.filter(h => h.startTime?.startsWith(date)).forEach(h => {
    items.push({
      id: `job-${h.id}`, type: 'job', time: h.startTime,
      title: h.jobName || h.jobId,
      subtitle: `${h.status === 'success' ? '성공' : h.status === 'failed' ? '실패' : '실행중'} (${((h.duration || 0) / 1000).toFixed(1)}s)`,
      icon: h.status === 'success' ? 'job-success' : 'job-failed',
      color: h.status === 'success' ? 'green' : 'red',
      meta: { jobId: h.jobId, status: h.status, logId: h.id }
    });
  });

  // Sessions
  try {
    const sessions = findSessions(date);
    const summaries = loadSessionSummaries();
    const summaryIds = new Set(summaries.map(s => s.sessionId));
    sessions.forEach(s => {
      items.push({
        id: `session-${s.id}`, type: 'session', time: s.modifiedAt,
        title: s.alias || s.project,
        subtitle: s.alias ? `${s.project} / ${s.firstMessage?.substring(0, 50) || ''}` : (s.firstMessage?.substring(0, 60) || ''),
        icon: 'session', color: 'purple',
        meta: { sessionId: s.id, projectPath: s.projectPath, hasSummary: summaryIds.has(s.id) }
      });
    });
  } catch (e) { /* ignore */ }

  // Dashboard memos
  try {
    const dashMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(date));
    dashMemos.forEach(m => {
      items.push({ id: `memo-${m.id}`, type: 'memo', time: m.timestamp, title: m.content?.substring(0, 100), icon: 'memo', color: 'yellow', meta: { source: 'dashboard', memoId: m.id } });
    });
  } catch (e) { /* ignore */ }

  // Obsidian memos
  try {
    const obsidianMemos = parseObsidianMemos(date);
    obsidianMemos.forEach(m => {
      items.push({ id: m.id, type: 'memo', time: m.timestamp, title: m.content?.substring(0, 100), icon: 'memo-obsidian', color: 'green', meta: { source: 'obsidian' } });
    });
  } catch (e) { /* ignore */ }

  // Morning plan
  try {
    const plans = loadMorningPlans();
    const todayPlan = plans.find(p => p.date === date);
    if (todayPlan) {
      items.push({ id: `plan-${todayPlan.id}`, type: 'plan', time: todayPlan.createdAt, title: '하루 시작 계획', subtitle: `목표 ${todayPlan.goals?.length || 0}개 / 업무 ${todayPlan.tasks?.length || 0}개`, icon: 'plan', color: 'orange', meta: { planId: todayPlan.id } });
    }
  } catch (e) { /* ignore */ }

  // GitHub
  try {
    const accounts = await getGhAccounts();
    const activeAccount = accounts.find(a => a.active)?.username;
    const results = [];
    for (const a of accounts) {
      try { results.push({ status: 'fulfilled', value: await fetchGithubEventsForAccount(a.username, date) }); }
      catch (err) { results.push({ status: 'rejected', reason: err }); }
    }
    if (activeAccount) { try { await ghExec(['auth', 'switch', '--user', activeAccount], 5000); } catch {} }
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = r.value;
      data.prs?.forEach(pr => { items.push({ id: `gh-pr-${pr.repo}-${pr.number}`, type: 'github', time: pr.time, title: `PR #${pr.number} ${pr.title || ''}`.trim(), subtitle: `${pr.account} / ${pr.repoShort} / ${pr.action}`, icon: 'github-pr', color: 'blue', meta: { url: pr.url, repo: pr.repo } }); });
      data.commits?.forEach(c => { items.push({ id: `gh-commit-${c.repo}-${c.time}`, type: 'github', time: c.time, title: `${c.count}개 커밋 - ${c.repoShort}`, subtitle: c.messages?.[0] || c.branch || '', icon: 'github-commit', color: 'blue', meta: { repo: c.repo } }); });
      data.reviews?.forEach(rv => { items.push({ id: `gh-review-${rv.repo}-${rv.prNumber}-${rv.time}`, type: 'github', time: rv.time, title: `리뷰: ${rv.prTitle || `PR #${rv.prNumber}`}`, subtitle: `${rv.account} / ${rv.repoShort} / ${rv.state}`, icon: 'github-review', color: 'blue', meta: { repo: rv.repo } }); });
    }
  } catch (e) { /* ignore */ }

  items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const summary = { sessions: items.filter(i => i.type === 'session').length, memos: items.filter(i => i.type === 'memo').length, jobRuns: items.filter(i => i.type === 'job').length, github: items.filter(i => i.type === 'github').length, plans: items.filter(i => i.type === 'plan').length };
  res.json({ date, items, summary });
});

// Search
router.get('/search', (req, res) => {
  const { q, types } = req.query;
  if (!q || q.length < 2) return res.json({ results: [], total: 0 });
  const query = q.toLowerCase();
  const allowedTypes = types ? types.split(',') : ['session', 'memo', 'job', 'backlog'];
  const results = [];

  if (allowedTypes.includes('memo')) {
    try {
      const memos = loadQuickMemos();
      memos.filter(m => m.content?.toLowerCase().includes(query)).forEach(m => {
        results.push({ type: 'memo', id: m.id, title: m.content.substring(0, 60), preview: m.content.substring(0, 120), date: m.timestamp?.split('T')[0], time: m.timestamp, icon: '📝' });
      });
    } catch (e) { /* ignore */ }
    try {
      for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateStr = state.getKSTDateString(d);
        const memos = parseObsidianMemos(dateStr);
        memos.filter(m => m.content?.toLowerCase().includes(query)).forEach(m => {
          results.push({ type: 'memo', id: m.id, title: m.content.substring(0, 60), preview: m.content.substring(0, 120), date: dateStr, time: m.timestamp, icon: '📓' });
        });
      }
    } catch (e) { /* ignore */ }
  }

  if (allowedTypes.includes('session')) {
    try {
      for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateStr = state.getKSTDateString(d);
        const sessions = findSessions(dateStr);
        sessions.filter(s => s.alias?.toLowerCase().includes(query) || s.project?.toLowerCase().includes(query) || s.firstMessage?.toLowerCase().includes(query))
          .forEach(s => { results.push({ type: 'session', id: s.id, title: s.alias || s.project, preview: s.firstMessage?.substring(0, 120) || '', date: dateStr, time: s.modifiedAt, icon: '🤖', meta: { sessionId: s.id, projectPath: s.projectPath } }); });
      }
    } catch (e) { /* ignore */ }
  }

  if (allowedTypes.includes('job')) {
    const history = [...state.jobHistory];
    history.filter(h => h.jobName?.toLowerCase().includes(query) || h.jobId?.toLowerCase().includes(query)).forEach(h => {
      results.push({ type: 'job', id: String(h.id), title: h.jobName || h.jobId, preview: `${h.status === 'success' ? '성공' : '실패'} - ${(h.duration / 1000).toFixed(1)}s`, date: h.startTime?.split('T')[0], time: h.startTime, icon: h.status === 'success' ? '✅' : '❌', meta: { logId: h.id } });
    });
  }

  if (allowedTypes.includes('backlog')) {
    try {
      const backlogs = loadBacklogs();
      backlogs.filter(b => b.content?.toLowerCase().includes(query)).forEach(b => {
        results.push({ type: 'backlog', id: b.id, title: b.content.substring(0, 60), preview: b.content.substring(0, 120), date: b.createdAt?.split('T')[0], time: b.createdAt, icon: b.done ? '✔️' : '📋' });
      });
    } catch (e) { /* ignore */ }
  }

  results.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  res.json({ results: results.slice(0, 50), total: results.length });
});

// Suggestions
router.get('/insights/suggestions', (req, res) => {
  const suggestions = generateSuggestions();
  res.json({ suggestions });
});

// Productivity
router.get('/insights/productivity', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);

    const dates = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      dates.push(state.getKSTDateString(d));
    }
    const dateSet = new Set(dates);
    const sessionsByDate = findSessionsBulk(dateSet);

    const memosByDate = {};
    for (const m of loadQuickMemos()) {
      const d = m.timestamp?.split('T')[0];
      if (d && dateSet.has(d)) { if (!memosByDate[d]) memosByDate[d] = []; memosByDate[d].push(m); }
    }

    const obsidianByDate = {};
    const { vaultPath: _vp, dailyFolder: _df } = getObsidianPaths();
    const fs = require('fs');
    for (const date of dates) {
      try {
        const notePath = path.join(_vp, _df, `${date}.md`);
        if (!fs.existsSync(notePath)) { obsidianByDate[date] = []; continue; }
        const content = fs.readFileSync(notePath, 'utf8');
        const memos = [];
        const hourlyMatch = content.match(/## ⏰ 시간별 메모\n([\s\S]*?)(?=\n## |$)/);
        if (hourlyMatch) {
          for (const line of hourlyMatch[1].trim().split('\n')) {
            const m = line.match(/^- `((?:오[전후]|[AP]M)?\s*\d{1,2}:\d{2})`/);
            if (m) {
              const timeStr = m[1].trim();
              const digits = timeStr.match(/(\d{1,2}):(\d{2})/);
              let hour = parseInt(digits[1]);
              if (/오후|PM/i.test(timeStr) && hour < 12) hour += 12;
              if (/오전|AM/i.test(timeStr) && hour === 12) hour = 0;
              memos.push({ timestamp: `${date}T${String(hour).padStart(2,'0')}:${digits[2]}:00` });
            }
          }
        }
        obsidianByDate[date] = memos;
      } catch { obsidianByDate[date] = []; }
    }

    const jobsByDate = {};
    for (const h of state.jobHistory) {
      const d = h.startTime?.split('T')[0];
      if (d && dateSet.has(d)) { if (!jobsByDate[d]) jobsByDate[d] = []; jobsByDate[d].push(h); }
    }

    const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({ hour: i, sessions: 0, memos: 0, jobs: 0 }));
    const dailyTrend = [];
    const projectMap = {};
    let totalSessions = 0, totalMemos = 0, totalJobRuns = 0, totalSessionMinutes = 0;

    for (const date of dates) {
      let daySessions = 0, dayMemos = 0, dayJobs = 0;
      const sessions = sessionsByDate[date] || [];
      daySessions = sessions.length; totalSessions += sessions.length;
      for (const s of sessions) {
        const h = s.modifiedAt ? new Date(s.modifiedAt).getHours() : 12;
        hourlyActivity[h].sessions++;
        const proj = s.project || 'unknown';
        if (!projectMap[proj]) projectMap[proj] = { sessions: 0, totalMinutes: 0 };
        projectMap[proj].sessions++; projectMap[proj].totalMinutes += 30; totalSessionMinutes += 30;
      }
      const dashMemos = memosByDate[date] || [];
      dayMemos += dashMemos.length; totalMemos += dashMemos.length;
      for (const m of dashMemos) { const h = m.timestamp ? new Date(m.timestamp).getHours() : 12; hourlyActivity[h].memos++; }
      const obsMemos = obsidianByDate[date] || [];
      dayMemos += obsMemos.length; totalMemos += obsMemos.length;
      for (const m of obsMemos) { const h = m.timestamp ? new Date(m.timestamp).getHours() : 12; hourlyActivity[h].memos++; }
      const dayHistory = jobsByDate[date] || [];
      dayJobs = dayHistory.length; totalJobRuns += dayHistory.length;
      for (const h of dayHistory) { const hr = h.startTime ? new Date(h.startTime).getHours() : 12; hourlyActivity[hr].jobs++; }
      dailyTrend.push({ date, sessions: daySessions, memos: dayMemos, jobs: dayJobs });
    }

    const topProjects = Object.entries(projectMap).map(([project, data]) => ({ project, ...data })).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
    const mid = Math.floor(dailyTrend.length / 2);
    const firstHalf = dailyTrend.slice(0, mid);
    const secondHalf = dailyTrend.slice(mid);
    const sum = (arr, key) => arr.reduce((s, d) => s + (d[key] || 0), 0);
    const weekComparison = {
      firstHalf: { sessions: sum(firstHalf, 'sessions'), memos: sum(firstHalf, 'memos'), jobs: sum(firstHalf, 'jobs') },
      secondHalf: { sessions: sum(secondHalf, 'sessions'), memos: sum(secondHalf, 'memos'), jobs: sum(secondHalf, 'jobs') }
    };

    const avgDays = dates.length || 1;
    res.json({
      period: { start: dates[0], end: dates[dates.length - 1], days },
      overview: { totalSessions, totalMemos, totalJobRuns, avgSessionMinutes: totalSessions > 0 ? Math.round(totalSessionMinutes / totalSessions) : 0, avgDailyMemos: +(totalMemos / avgDays).toFixed(1) },
      hourlyActivity, dailyTrend, topProjects, weekComparison
    });
  } catch (err) { console.error('[Productivity] 분석 오류:', err); res.status(500).json({ error: err.message }); }
});

// Weekly digest
router.post('/insights/weekly-digest', (req, res) => {
  const { weekStart, clientId } = req.body || {};
  const tasksRouter = require('./tasks');
  const task = {
    id: generateTaskId(), type: 'weekly-digest', payload: { weekStart },
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '', logs: [], command: null,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, clientId
  };
  state.taskQueue.set(task.id, task);
  console.log(`[Tasks] 주간 다이제스트 작업 생성: ${task.id}`);
  tasksRouter.processTask(task);
  res.json({ taskId: task.id });
});

router.get('/insights/weekly-digest', (req, res) => {
  const week = req.query.week;
  const digests = loadWeeklyDigests();
  if (week) {
    const digest = digests.find(d => d.weekStart === week);
    return res.json({ digest: digest || null });
  }
  const limit = parseInt(req.query.limit) || 10;
  const list = digests.slice(-limit).reverse().map(d => ({ id: d.id, weekStart: d.weekStart, weekEnd: d.weekEnd, createdAt: d.createdAt, stats: d.stats }));
  res.json({ digests: list });
});

// Ask Claude
router.post('/ask', async (req, res) => {
  const { prompt, timeout = 300000 } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  console.log(`[Claude] 질문 수신: ${prompt.substring(0, 50)}...`);
  const claudePath = process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), '.local', 'bin', 'claude');
  try {
    const claude = spawn(claudePath, ['-p', prompt], { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let stdout = '', stderr = '';
    claude.stdout.on('data', d => { stdout += d.toString(); });
    claude.stderr.on('data', d => { stderr += d.toString(); });
    const timeoutId = setTimeout(() => { claude.kill('SIGTERM'); }, timeout);
    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) { console.log(`[Claude] 응답 완료 (${stdout.length} chars)`); res.json({ success: true, response: stdout.trim() }); }
      else { console.error(`[Claude] 오류 (code: ${code}):`, stderr); res.status(500).json({ error: stderr || `Claude CLI exited with code ${code}` }); }
    });
    claude.on('error', (err) => { clearTimeout(timeoutId); console.error('[Claude] 실행 오류:', err.message); res.status(500).json({ error: err.message }); });
  } catch (err) { console.error('[Claude] 예외:', err.message); res.status(500).json({ error: err.message }); }
});

// GitHub activity
router.get('/github/activity', async (req, res) => {
  const targetDate = req.query.date || state.getKSTDateString();
  try {
    const accounts = await getGhAccounts();
    console.log(`[GitHub] ${accounts.length}개 계정 감지:`, accounts.map(a => a.username).join(', '));
    const activeAccount = accounts.find(a => a.active)?.username;
    const results = [];
    for (const a of accounts) { results.push(await fetchGithubEventsForAccount(a.username, targetDate)); }
    if (activeAccount) { try { await ghExec(['auth', 'switch', '--user', activeAccount], 5000); } catch {} }
    const activity = { date: targetDate, accounts: accounts.map(a => a.username), commits: [], prs: [], reviews: [], comments: [] };
    for (const r of results) { activity.commits.push(...r.commits); activity.prs.push(...r.prs); activity.reviews.push(...r.reviews); activity.comments.push(...r.comments); }
    const prSeen = new Set();
    activity.prs = activity.prs.filter(pr => { const key = `${pr.repo}#${pr.number}`; if (prSeen.has(key)) return false; prSeen.add(key); return true; });
    const reviewSeen = new Set();
    activity.reviews = activity.reviews.filter(r => { const key = `${r.account}:${r.repo}#${r.prNumber}`; if (reviewSeen.has(key)) return false; reviewSeen.add(key); return true; });
    const repos = new Set();
    [...activity.commits, ...activity.prs, ...activity.reviews, ...activity.comments].forEach(item => repos.add(item.repo));
    activity.repos = [...repos].sort();
    res.json(activity);
  } catch (err) { console.error('[GitHub] 활동 조회 오류:', err); res.status(500).json({ error: err.message }); }
});

// GitHub review analysis
router.post('/github/review-analysis', (req, res) => {
  const { days = 30, clientId } = req.body || {};
  const cached = loadReviewAnalysis();
  const today = state.getKSTDateString();
  const existing = cached.find(a => a.id === `ra-${today}`);
  if (existing) return res.json({ cached: true, ...existing });
  const tasksRouter = require('./tasks');
  const task = {
    id: generateTaskId(), type: 'review-analysis', payload: { days: parseInt(days) },
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '', logs: [], command: null,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, clientId
  };
  state.taskQueue.set(task.id, task);
  tasksRouter.processTask(task);
  res.json({ taskId: task.id, status: 'generating' });
});

router.get('/github/review-analysis', (req, res) => {
  const analyses = loadReviewAnalysis();
  if (analyses.length === 0) return res.json({ analysis: null });
  res.json({ analysis: analyses[analyses.length - 1] });
});

module.exports = router;
