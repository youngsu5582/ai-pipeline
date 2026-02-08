'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const state = require('../lib/state');
const { findSessions, parseSessionFile, sessionToMarkdown, loadSessionSummaries, loadSessionInsights, loadDailyReports } = require('../lib/sessions');
const { getObsidianPaths } = require('../lib/obsidian');
const { generateTaskId, sendSSEEvent } = require('../lib/sse');
const { loadKnowledgeGraphData, rebuildKnowledgeGraph } = require('../lib/analysis');

// Session list
router.get('/', (req, res) => {
  const { date, project } = req.query;
  const targetDate = date || state.getKSTDateString();
  try {
    const sessions = findSessions(targetDate, project);
    const summaries = loadSessionSummaries();
    const summaryMap = {};
    summaries.forEach(s => { summaryMap[s.sessionId] = true; });
    const enriched = sessions.map(s => ({ ...s, hasSummary: !!summaryMap[s.id] }));
    res.json({ sessions: enriched, date: targetDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Session projects
router.get('/projects', (req, res) => {
  if (!fs.existsSync(state.CLAUDE_PROJECTS)) return res.json({ projects: [] });
  try {
    const dirs = fs.readdirSync(state.CLAUDE_PROJECTS).filter(d => {
      const p = path.join(state.CLAUDE_PROJECTS, d);
      try { return fs.statSync(p).isDirectory() && d !== 'memory' && d !== '.deleted'; }
      catch { return false; }
    });
    const projects = dirs.map(d => ({ path: d, name: d.split('-').pop() }));
    res.json({ projects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Knowledge graph (must be before /:id wildcard route)
router.get('/knowledge-graph', (req, res) => {
  let graph = loadKnowledgeGraphData();
  const minMentions = parseInt(req.query.minMentions || '1');
  if (req.query.rebuild === 'true') graph = rebuildKnowledgeGraph();
  if (minMentions > 1) {
    const nodeIds = new Set(graph.nodes.filter(n => n.mentions >= minMentions).map(n => n.id));
    graph = { ...graph, nodes: graph.nodes.filter(n => nodeIds.has(n.id)), edges: graph.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)) };
  }
  res.json(graph);
});

router.post('/knowledge-graph/rebuild', (req, res) => {
  try {
    const graph = rebuildKnowledgeGraph();
    res.json({ success: true, nodes: graph.nodes.length, edges: graph.edges.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/knowledge-graph/recommendations', (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.status(400).json({ error: 'topic parameter required' });
  const graph = loadKnowledgeGraphData();
  const topicId = `topic-${topic.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;
  const relatedEdges = graph.edges.filter(e => e.from === topicId || e.to === topicId).sort((a, b) => b.strength - a.strength);
  const related = relatedEdges.slice(0, 5).map(e => {
    const otherId = e.from === topicId ? e.to : e.from;
    const node = graph.nodes.find(n => n.id === otherId);
    return { topic: node?.label || otherId, reason: `${e.strength}회 함께 언급됨`, strength: e.strength };
  });
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - 60);
  const cutoff = state.getKSTDateString(cutoffDate);
  const reviewNeeded = graph.nodes.filter(n => n.lastSeen < cutoff && n.mentions >= 3)
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen)).slice(0, 3)
    .map(n => ({ topic: n.label, lastSeen: n.lastSeen, reason: `${n.mentions}회 학습, 복습 추천` }));
  res.json({ related, review_needed: reviewNeeded });
});

// Insights overview (must be before /:id wildcard route)
router.get('/insights/overview', (req, res) => {
  const days = parseInt(req.query.days || '7');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString();
  const allInsights = loadSessionInsights();
  const recentInsights = Object.entries(allInsights)
    .filter(([_, ins]) => ins.createdAt >= cutoff)
    .map(([sessionId, ins]) => ({ sessionId, ...ins }));
  const topicCount = {}, techCount = {}, complexity = { low: 0, medium: 0, high: 0 };
  recentInsights.forEach(ins => {
    (ins.topics || []).forEach(t => { topicCount[t] = (topicCount[t] || 0) + 1; });
    (ins.technologies || []).forEach(t => { techCount[t] = (techCount[t] || 0) + 1; });
    if (ins.complexity) complexity[ins.complexity]++;
  });
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topic, count]) => ({ topic, count }));
  const topTech = Object.entries(techCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tech, count]) => ({ tech, count }));
  res.json({ period: `${days} days`, sessionsAnalyzed: recentInsights.length, topTopics, topTechnologies: topTech, complexityDistribution: complexity });
});

// Cached daily reports (must be before /:id wildcard route)
router.get('/reports/daily', (req, res) => {
  const { date, type } = req.query;
  const reports = loadDailyReports();
  if (date && type) {
    const report = reports.find(r => r.date === date && r.type === type);
    return res.json({ report: report || null });
  }
  const limit = parseInt(req.query.limit) || 50;
  const list = reports.map(r => ({ id: r.id, date: r.date, type: r.type, createdAt: r.createdAt })).reverse().slice(0, limit);
  res.json({ reports: list });
});

// Session detail
router.get('/:id', (req, res) => {
  const { project, maxMessages } = req.query;
  if (!project) return res.status(400).json({ error: 'project query parameter required' });
  try {
    const data = parseSessionFile(req.params.id, project, { maxMessages: parseInt(maxMessages) || 200 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete session
router.delete('/:id', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project query parameter required' });
  const filePath = path.join(state.CLAUDE_PROJECTS, project, `${req.params.id}.jsonl`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session file not found' });
  try {
    const deletedDir = path.join(state.CLAUDE_PROJECTS, '.deleted');
    if (!fs.existsSync(deletedDir)) fs.mkdirSync(deletedDir, { recursive: true });
    const backupPath = path.join(deletedDir, `${req.params.id}.jsonl`);
    fs.copyFileSync(filePath, backupPath);
    fs.unlinkSync(filePath);
    console.log(`[Sessions] 삭제 (백업): ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Session summary (cached)
router.get('/:id/summary', (req, res) => {
  const summaries = loadSessionSummaries();
  const summary = summaries.find(s => s.sessionId === req.params.id);
  if (!summary) return res.json({ summary: null });
  res.json(summary);
});

// Session alias
router.put('/:id/alias', (req, res) => {
  const { alias } = req.body;
  const aliases = state.loadSessionAliases();
  if (alias) aliases[req.params.id] = alias;
  else delete aliases[req.params.id];
  state.saveSessionAliases(aliases);
  res.json({ success: true });
});

router.get('/:id/alias', (req, res) => {
  const aliases = state.loadSessionAliases();
  res.json({ alias: aliases[req.params.id] || null });
});

// Markdown export
router.get('/:id/markdown', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project query parameter required' });
  try {
    const data = parseSessionFile(req.params.id, project, { maxMessages: 500 });
    const summaries = loadSessionSummaries();
    const summaryObj = summaries.find(s => s.sessionId === req.params.id);
    const allInsights = loadSessionInsights();
    const markdown = sessionToMarkdown(data, { summary: summaryObj?.summary || null, insights: allInsights[req.params.id] || null });
    res.json({ markdown, filename: `${data.project}-${req.params.id.substring(0,8)}.md` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export to Obsidian
router.post('/:id/export-obsidian', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project required' });
  try {
    const data = parseSessionFile(req.params.id, project, { maxMessages: 500 });
    const summaries = loadSessionSummaries();
    const summaryObj = summaries.find(s => s.sessionId === req.params.id);
    const allInsights = loadSessionInsights();
    const markdown = sessionToMarkdown(data, { summary: summaryObj?.summary || null, insights: allInsights[req.params.id] || null });
    const { vaultPath } = getObsidianPaths();
    const yearMonth = (data.lastActivity || new Date().toISOString()).substring(0, 7);
    const sessionDir = path.join(vaultPath, 'Claude Sessions', yearMonth);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const filename = `${data.project}-${req.params.id.substring(0, 8)}.md`;
    const filePath = path.join(sessionDir, filename);
    fs.writeFileSync(filePath, markdown, 'utf8');
    console.log(`[Sessions] Obsidian 내보내기: ${filePath}`);
    res.json({ success: true, path: filePath, relativePath: `Claude Sessions/${yearMonth}/${filename}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily report
const dailyReportCache = new Map();

router.post('/daily-report', async (req, res) => {
  const { date } = req.body;
  const targetDate = date || state.getKSTDateString();
  try {
    const sessions = findSessions(targetDate);
    if (sessions.length === 0) return res.json({ success: false, error: '해당 날짜에 세션이 없습니다.' });
    // Return cached
    if (dailyReportCache.has(targetDate)) return res.json({ success: true, ...dailyReportCache.get(targetDate) });
    // Use task system for async generation
    const tasksRouter = require('./tasks');
    const task = {
      id: generateTaskId(), type: 'daily-report', payload: { date: targetDate },
      status: 'pending', progress: 0, progressMessage: '대기 중...',
      result: null, error: null, stdout: '', stderr: '', logs: [], command: null,
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null, clientId: null
    };
    state.taskQueue.set(task.id, task);
    tasksRouter.processTask(task);
    res.json({ taskId: task.id, status: 'generating' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/daily-report/download', (req, res) => {
  const targetDate = req.query.date || state.getKSTDateString();
  try {
    let report;
    if (dailyReportCache.has(targetDate)) { report = dailyReportCache.get(targetDate).report; }
    else {
      const sessions = findSessions(targetDate);
      report = `# ${targetDate} 일일 보고서\n\n세션 수: ${sessions.length}\n\n(상세 보고서를 보려면 먼저 일일 보고서 버튼을 클릭하세요)`;
    }
    const filename = `claude-daily-report-${targetDate}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/daily-report/obsidian', (req, res) => {
  const targetDate = req.body.date || state.getKSTDateString();
  try {
    let report;
    if (dailyReportCache.has(targetDate)) { report = dailyReportCache.get(targetDate).report; }
    else { return res.status(400).json({ error: '먼저 일일 보고서를 생성해주세요' }); }
    const { vaultPath } = getObsidianPaths();
    const reportDir = path.join(vaultPath, 'Claude Sessions', 'Daily Reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const filename = `${targetDate}-daily-report.md`;
    fs.writeFileSync(path.join(reportDir, filename), report, 'utf8');
    res.json({ success: true, path: path.join(reportDir, filename), relativePath: `Claude Sessions/Daily Reports/${filename}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export all sessions
router.post('/export-all', (req, res) => {
  const targetDate = req.body.date || state.getKSTDateString();
  try {
    const sessions = findSessions(targetDate);
    let exported = 0;
    const { vaultPath } = getObsidianPaths();
    const yearMonth = targetDate.substring(0, 7);
    const sessionDir = path.join(vaultPath, 'Claude Sessions', yearMonth);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const summaries = loadSessionSummaries();
    const allInsights = loadSessionInsights();
    for (const sess of sessions) {
      try {
        const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 500 });
        const summaryObj = summaries.find(s => s.sessionId === sess.id);
        const markdown = sessionToMarkdown(data, { summary: summaryObj?.summary || null, insights: allInsights[sess.id] || null });
        const filename = `${data.project}-${targetDate}-${sess.id.substring(0, 8)}.md`;
        fs.writeFileSync(path.join(sessionDir, filename), markdown, 'utf8');
        exported++;
      } catch (e) { console.error(`[ExportAll] 세션 내보내기 실패: ${sess.id}`, e.message); }
    }
    console.log(`[ExportAll] ${targetDate}: ${exported}/${sessions.length}개 내보냄`);
    res.json({ success: true, exported, total: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Session insights
router.get('/:id/insights', (req, res) => {
  const { id } = req.params;
  const { project } = req.query;
  const allInsights = loadSessionInsights();
  if (allInsights[id]) return res.json({ insights: allInsights[id], cached: true });
  if (!project) return res.status(400).json({ error: 'project query parameter required for generation' });
  const tasksRouter = require('./tasks');
  const task = {
    id: generateTaskId(), type: 'session-insights',
    payload: { sessionId: id, projectPath: project },
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '', logs: [], command: null,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, clientId: null
  };
  state.taskQueue.set(task.id, task);
  tasksRouter.processTask(task);
  res.json({ taskId: task.id, status: 'generating' });
});

module.exports = router;
