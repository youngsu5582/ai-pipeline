'use strict';

const express = require('express');
const router = express.Router();
const state = require('../lib/state');
const { loadQuickMemos, saveQuickMemos, loadMorningPlans, saveMorningPlans, loadBacklogs, saveBacklogs } = require('../lib/notes');
const { appendToObsidianSection, parseObsidianMemos } = require('../lib/obsidian');
const { loadMemoCategories, saveMemoCategories, classifyMemoByKeywords, classifyMemoBackground, CATEGORY_DEFINITIONS } = require('../lib/analysis');

// --- Quick Memos ---
router.get('/quick-memos', (req, res) => {
  const { date } = req.query;
  let memos = loadQuickMemos();
  const categories = loadMemoCategories();
  if (date) {
    memos = memos.filter(m => {
      if (!m.timestamp) return false;
      const kstDate = state.getKSTDateString(new Date(m.timestamp));
      return kstDate === date;
    });
  }
  const enriched = memos.map(m => ({
    ...m,
    category: categories[m.id]?.category || null,
    tags: categories[m.id]?.tags || [],
    autoTags: categories[m.id]?.autoTags || false
  }));
  res.json({ memos: enriched });
});

router.post('/quick-memos', (req, res) => {
  const { content, category } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const memos = loadQuickMemos();
  const newMemo = { id: `memo-${Date.now()}`, content: content.trim(), timestamp: new Date().toISOString() };
  memos.unshift(newMemo);
  if (memos.length > 500) memos.splice(500);
  saveQuickMemos(memos);
  console.log(`[Memos] 메모 저장: ${content.substring(0, 30)}...`);
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  appendToObsidianSection('## ⏰ 시간별 메모', `- \`${timeStr}\` ${content.trim()}`);
  res.json({ success: true, memo: newMemo });
  if (category && CATEGORY_DEFINITIONS[category]) {
    const categories = loadMemoCategories();
    categories[newMemo.id] = { category, tags: [], autoTags: false, classifiedAt: new Date().toISOString() };
    saveMemoCategories(categories);
  } else {
    classifyMemoBackground(newMemo.id, newMemo.content).catch(err => console.error('[MemoCategory] 분류 실패:', err.message));
  }
});

router.delete('/quick-memos/:id', (req, res) => {
  const memos = loadQuickMemos();
  const idx = memos.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Memo not found' });
  memos.splice(idx, 1);
  saveQuickMemos(memos);
  res.json({ success: true });
});

// Memo category patch
router.patch('/quick-memos/:id/category', (req, res) => {
  const { id } = req.params;
  const { category, tags } = req.body;
  if (category && !CATEGORY_DEFINITIONS[category]) return res.status(400).json({ error: `Invalid category: ${category}` });
  const categories = loadMemoCategories();
  categories[id] = {
    category: category || categories[id]?.category || null,
    tags: tags || categories[id]?.tags || [],
    autoTags: false, classifiedAt: new Date().toISOString()
  };
  saveMemoCategories(categories);
  res.json({ success: true, classification: categories[id] });
});

// Migrate classifications
router.post('/memos/migrate-classifications', (req, res) => {
  const memos = loadQuickMemos();
  const categories = loadMemoCategories();
  let classified = 0;
  for (const memo of memos) {
    if (!categories[memo.id]) {
      const result = classifyMemoByKeywords(memo.content);
      if (result) { categories[memo.id] = { ...result, autoTags: true, classifiedAt: new Date().toISOString() }; classified++; }
    }
  }
  saveMemoCategories(categories);
  console.log(`[MemoCategory] 마이그레이션 완료: ${classified}/${memos.length}`);
  res.json({ success: true, classified, total: memos.length });
});

// Memo stats
router.get('/memos/stats', (req, res) => {
  const memos = loadQuickMemos();
  const categories = loadMemoCategories();
  const stats = {};
  for (const cat of Object.keys(CATEGORY_DEFINITIONS)) stats[cat] = 0;
  stats.uncategorized = 0;
  memos.forEach(m => { const cat = categories[m.id]?.category; if (cat && stats[cat] !== undefined) stats[cat]++; else stats.uncategorized++; });
  res.json({ stats, total: memos.length, definitions: CATEGORY_DEFINITIONS });
});

// Obsidian daily memos
router.get('/obsidian/daily-memos', (req, res) => {
  const { date } = req.query;
  const targetDate = date || state.getKSTDateString();
  try {
    const memos = parseObsidianMemos(targetDate);
    res.json({ memos, source: 'obsidian', date: targetDate });
  } catch (err) {
    console.error('[Obsidian] 메모 읽기 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Morning Plans ---
router.get('/morning-plans', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const plans = loadMorningPlans();
    const list = plans.map(p => ({ id: p.id, date: p.date, createdAt: p.createdAt })).reverse().slice(0, limit);
    res.json({ plans: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/morning-plan', (req, res) => {
  const targetDate = req.query.date || state.getKSTDateString();
  const plans = loadMorningPlans();
  const plan = plans.find(p => p.date === targetDate);
  res.json({ plan: plan || null });
});

router.post('/morning-plan', (req, res) => {
  const { tasks, additionalTasks, goals, focusTime, motto, markdown, date } = req.body;
  const today = date || state.getKSTDateString();
  const plans = loadMorningPlans();
  const existingIdx = plans.findIndex(p => p.date === today);
  const plan = {
    id: existingIdx >= 0 ? plans[existingIdx].id : `mp-${Date.now()}`,
    date: today, tasks: tasks || [], additionalTasks: additionalTasks || [],
    goals: goals || [], focusTime: focusTime || '', motto: motto || '', markdown: markdown || '',
    createdAt: existingIdx >= 0 ? plans[existingIdx].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) plans[existingIdx] = plan;
  else plans.unshift(plan);
  if (plans.length > 365) plans.splice(365);
  saveMorningPlans(plans);
  console.log(`[MorningPlan] 저장: ${today} (${(tasks || []).length}개 업무, ${(goals || []).length}개 목표)`);
  res.json({ success: true, plan });
});

router.put('/morning-plan/:id', (req, res) => {
  const plans = loadMorningPlans();
  const idx = plans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Morning plan not found' });
  const updates = req.body;
  if (updates.tasks !== undefined) plans[idx].tasks = updates.tasks;
  if (updates.additionalTasks !== undefined) plans[idx].additionalTasks = updates.additionalTasks;
  if (updates.goals !== undefined) plans[idx].goals = updates.goals;
  if (updates.focusTime !== undefined) plans[idx].focusTime = updates.focusTime;
  if (updates.motto !== undefined) plans[idx].motto = updates.motto;
  if (updates.markdown !== undefined) plans[idx].markdown = updates.markdown;
  plans[idx].updatedAt = new Date().toISOString();
  saveMorningPlans(plans);
  res.json({ success: true, plan: plans[idx] });
});

// Toggle morning plan checklist item
router.patch('/morning-plan/:id/toggle', (req, res) => {
  const { index } = req.body;
  if (index === undefined) return res.status(400).json({ error: 'index required' });
  const plans = loadMorningPlans();
  const plan = plans.find(p => p.id === req.params.id);
  if (!plan) return res.status(404).json({ error: 'Morning plan not found' });

  // Parse markdown checklist items and toggle
  const lines = plan.markdown.split('\n');
  let checkIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const unchecked = lines[i].match(/^(\s*- \[) \]/);
    const checked = lines[i].match(/^(\s*- \[)x\]/);
    if (unchecked || checked) {
      if (checkIdx === index) {
        if (unchecked) {
          lines[i] = lines[i].replace('- [ ]', '- [x]');
        } else {
          lines[i] = lines[i].replace('- [x]', '- [ ]');
        }
        break;
      }
      checkIdx++;
    }
  }
  plan.markdown = lines.join('\n');
  plan.updatedAt = new Date().toISOString();
  saveMorningPlans(plans);
  res.json({ success: true, markdown: plan.markdown });
});

// --- Backlogs ---
router.get('/backlogs', (req, res) => {
  const { status, date } = req.query;
  let backlogs = loadBacklogs();
  if (status === 'open') backlogs = backlogs.filter(b => !b.done);
  if (status === 'done') backlogs = backlogs.filter(b => b.done);
  if (date) backlogs = backlogs.filter(b => b.createdAt?.startsWith(date));
  res.json({ backlogs, total: backlogs.length, openCount: backlogs.filter(b => !b.done).length });
});

router.post('/backlogs', (req, res) => {
  const { content, priority } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const backlogs = loadBacklogs();
  const item = { id: `bl-${Date.now()}`, content: content.trim(), priority: priority || 'normal', done: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  backlogs.unshift(item);
  if (backlogs.length > 1000) backlogs.splice(1000);
  saveBacklogs(backlogs);
  console.log(`[Backlog] 추가: ${content.substring(0, 40)}`);
  appendToObsidianSection('## 📋 할 일', `- [ ] ${content.trim()}`);
  res.json({ success: true, backlog: item });
});

router.put('/backlogs/:id', (req, res) => {
  const backlogs = loadBacklogs();
  const idx = backlogs.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Backlog not found' });
  if (req.body.done !== undefined) backlogs[idx].done = req.body.done;
  if (req.body.content !== undefined) backlogs[idx].content = req.body.content;
  if (req.body.priority !== undefined) backlogs[idx].priority = req.body.priority;
  backlogs[idx].updatedAt = new Date().toISOString();
  saveBacklogs(backlogs);
  res.json({ success: true, backlog: backlogs[idx] });
});

router.delete('/backlogs/:id', (req, res) => {
  const backlogs = loadBacklogs();
  const idx = backlogs.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Backlog not found' });
  backlogs.splice(idx, 1);
  saveBacklogs(backlogs);
  res.json({ success: true });
});

module.exports = router;
