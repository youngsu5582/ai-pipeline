'use strict';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();

const state = require('../lib/state');
const { generateTaskId, sendSSEEvent, updateTaskProgress } = require('../lib/sse');
const { findSessions, parseSessionFile, loadSessionSummaries, saveSessionSummaries, loadDailyReports, saveDailyReports, loadSessionInsights, saveSessionInsights } = require('../lib/sessions');
const { loadQuickMemos, loadMorningPlans, loadBacklogs } = require('../lib/notes');
const { getObsidianPaths, parseObsidianMemos } = require('../lib/obsidian');
const { rebuildKnowledgeGraph, loadWeeklyDigests, saveWeeklyDigests, getWeekStart, getDateRange, loadReviewAnalysis, saveReviewAnalysis } = require('../lib/analysis');
const { getGhAccounts } = require('../lib/github');

// SSE endpoint
router.get('/events', (req, res) => {
  const clientId = req.query.clientId || `client-${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  state.sseClients.set(clientId, res);
  console.log(`[SSE] 클라이언트 연결: ${clientId} (총 ${state.sseClients.size}개)`);

  const pingInterval = setInterval(() => {
    if (state.sseClients.has(clientId)) {
      try { res.write(`:ping\n\n`); }
      catch (err) { clearInterval(pingInterval); state.sseClients.delete(clientId); }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(pingInterval);
    state.sseClients.delete(clientId);
    console.log(`[SSE] 클라이언트 연결 해제: ${clientId}`);
  });
});

// Submit task
router.post('/', (req, res) => {
  const { type, payload, clientId } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const task = {
    id: generateTaskId(), type, payload: payload || {},
    status: 'pending', progress: 0, progressMessage: '대기 중...',
    result: null, error: null, stdout: '', stderr: '',
    logs: [], command: null,
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, clientId
  };

  state.taskQueue.set(task.id, task);
  console.log(`[Tasks] 작업 생성: ${task.id} (${type})`);
  processTask(task);

  res.json({ success: true, taskId: task.id, status: 'pending' });
});

// List tasks
router.get('/', (req, res) => {
  const tasks = Array.from(state.taskQueue.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  res.json({ tasks });
});

// Get task
router.get('/:id', (req, res) => {
  const task = state.taskQueue.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Delete task
router.delete('/:id', (req, res) => {
  const task = state.taskQueue.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status === 'running' && state.runningTaskProcesses.has(task.id)) {
    state.runningTaskProcesses.get(task.id).kill('SIGTERM');
    state.runningTaskProcesses.delete(task.id);
  }

  state.taskQueue.delete(req.params.id);
  sendSSEEvent(task.clientId, 'task:deleted', { taskId: task.id });
  console.log(`[Tasks] 작업 삭제: ${task.id}`);
  res.json({ success: true });
});

// --- Task Processor ---
async function processTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  sendSSEEvent(task.clientId, 'task:started', { taskId: task.id, type: task.type });

  try {
    let result;
    switch (task.type) {
      case 'ask':
        result = await processAskTask(task);
        break;
      case 'session-summary':
        result = await processSessionSummaryTask(task);
        break;
      case 'daily-report':
        result = await processDailyReportTask(task);
        break;
      case 'full-daily-report':
        result = await processFullDailyReportTask(task);
        break;
      case 'day-wrapup':
        result = await processDayWrapupTask(task);
        break;
      case 'weekly-digest':
        result = await processWeeklyDigestTask(task);
        break;
      case 'session-insights':
        result = await processSessionInsightsTask(task);
        break;
      case 'review-analysis':
        result = await processReviewAnalysisTask(task);
        break;
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date().toISOString();
    updateTaskProgress(task, 100, '완료');
    sendSSEEvent(task.clientId, 'task:completed', { taskId: task.id, result });
    state.runningTaskProcesses.delete(task.id);
    console.log(`[Tasks] 작업 완료: ${task.id}`);
  } catch (err) {
    task.status = 'failed';
    task.error = err.message;
    task.completedAt = new Date().toISOString();
    sendSSEEvent(task.clientId, 'task:failed', { taskId: task.id, error: err.message });
    state.runningTaskProcesses.delete(task.id);
    console.error(`[Tasks] 작업 실패: ${task.id}`, err.message);
  }
}

function getClaudePath() {
  return process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), '.local', 'bin', 'claude');
}

function spawnClaude(task, prompt, timeoutMs = 300000) {
  const claudePath = getClaudePath();
  if (!fs.existsSync(claudePath)) throw new Error(`Claude CLI를 찾을 수 없습니다: ${claudePath}`);

  return new Promise((resolve, reject) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    state.runningTaskProcesses.set(task.id, claude);
    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      task.stdout = stdout;
      task.logs.push({ type: 'stdout', time: new Date().toISOString(), text });
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      task.stderr = stderr;
      task.logs.push({ type: 'stderr', time: new Date().toISOString(), text });
    });

    const timeoutId = setTimeout(() => {
      claude.kill('SIGTERM');
      reject(new Error(`타임아웃 (${Math.round(timeoutMs / 60000)}분)`));
    }, timeoutMs);

    claude.on('close', (code) => {
      clearTimeout(timeoutId);
      state.runningTaskProcesses.delete(task.id);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Exit code: ${code}`));
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutId);
      state.runningTaskProcesses.delete(task.id);
      reject(err);
    });
  });
}

// --- Ask Task ---
async function processAskTask(task) {
  updateTaskProgress(task, 10, 'Claude에게 질문 중...');
  const { prompt } = task.payload;
  task.command = `claude -p "..."`;
  const response = await spawnClaude(task, prompt, task.payload.timeout || 300000);
  return { response };
}

// --- Session Summary Task ---
async function processSessionSummaryTask(task) {
  const { sessionId, projectPath } = task.payload;
  updateTaskProgress(task, 10, '세션 데이터 로드 중...');

  const sessionData = parseSessionFile(sessionId, projectPath, { maxMessages: 50 });
  const userMessages = sessionData.conversation
    .filter(c => c.role === 'user' && c.content)
    .slice(0, 10)
    .map(c => c.content.substring(0, 300));

  updateTaskProgress(task, 30, 'Claude 요약 요청 중...');

  const prompt = `다음 Claude Code 세션을 3-5줄로 요약해주세요. 핵심 작업, 결과, 특이사항을 포함해주세요.\n\n프로젝트: ${sessionData.project}\n메시지 수: ${sessionData.messageCount}\n사용 도구: ${[...sessionData.toolsUsed].slice(0, 10).join(', ')}\n변경 파일: ${[...sessionData.filesChanged].slice(0, 10).join(', ')}\n\n사용자 요청 (시간순):\n${userMessages.join('\n---\n')}\n\n한국어로 요약해주세요.`;

  task.command = `claude -p "..."`;
  const summary = await spawnClaude(task, prompt);
  updateTaskProgress(task, 90, '요약 저장 중...');

  const summaries = loadSessionSummaries();
  const record = { sessionId, project: sessionData.project, summary, createdAt: new Date().toISOString() };
  const existIdx = summaries.findIndex(s => s.sessionId === sessionId);
  if (existIdx >= 0) summaries[existIdx] = record;
  else summaries.push(record);
  saveSessionSummaries(summaries);

  return { sessionId, summary, project: sessionData.project };
}

// --- Daily Report Task ---
async function processDailyReportTask(task) {
  const { date } = task.payload;
  const targetDate = date || state.getKSTDateString();
  updateTaskProgress(task, 10, '세션 데이터 수집 중...');

  const sessions = findSessions(targetDate);
  const sessionDetails = [];
  for (const sess of sessions.slice(0, 10)) {
    try {
      const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 30 });
      sessionDetails.push({
        project: data.project, alias: sess.alias, messageCount: data.messageCount,
        tools: [...data.toolsUsed].slice(0, 5), files: [...data.filesChanged].slice(0, 5),
        firstMessage: data.firstMessage?.substring(0, 100) || ''
      });
    } catch (e) { /* skip */ }
  }

  updateTaskProgress(task, 40, 'Claude 보고서 요청 중...');

  const prompt = `다음은 ${targetDate}의 Claude Code 세션 데이터입니다. 일일 보고서를 마크다운으로 작성해주세요.\n\n세션 수: ${sessions.length}\n${sessionDetails.map(s => `- ${s.alias || s.project}: ${s.messageCount}개 메시지, 도구: ${s.tools.join(',')}`).join('\n')}\n\n다음 형식으로:\n# 📊 ${targetDate} 일일 보고서\n## 오늘의 요약\n## 주요 활동\n## 사용된 기술\n## 내일 계획`;

  const report = await spawnClaude(task, prompt);
  updateTaskProgress(task, 90, '보고서 저장 중...');

  const reports = loadDailyReports();
  const record = {
    id: `dr-${targetDate}-daily-report`, date: targetDate, type: 'daily-report',
    sessionsCount: sessions.length, report, createdAt: new Date().toISOString()
  };
  const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'daily-report');
  if (existIdx >= 0) reports[existIdx] = record;
  else reports.push(record);
  saveDailyReports(reports);

  return { date: targetDate, sessionsCount: sessions.length, report };
}

// --- Full Daily Report Task ---
async function processFullDailyReportTask(task) {
  const { date } = task.payload;
  const targetDate = date || state.getKSTDateString();

  updateTaskProgress(task, 10, '전체 데이터 수집 중...');

  const sessions = findSessions(targetDate);
  const sessionDetails = [];
  for (const sess of sessions.slice(0, 15)) {
    try {
      const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 30 });
      const userMessages = data.conversation
        .filter(c => c.role === 'user' && c.content)
        .slice(0, 5)
        .map(c => c.content.substring(0, 200));
      sessionDetails.push({
        project: data.project, alias: sess.alias || null,
        messageCount: data.messageCount,
        tools: [...data.toolsUsed].slice(0, 5),
        files: [...data.filesChanged].slice(0, 5),
        keyRequests: userMessages
      });
    } catch (e) { /* skip */ }
  }

  const quickMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(targetDate));
  let obsidianMemos = [];
  try { obsidianMemos = parseObsidianMemos(targetDate); } catch (e) { /* ignore */ }
  const morningPlan = loadMorningPlans().find(p => p.date === targetDate);

  const jobsToday = state.jobHistory.filter(h => h.startTime?.startsWith(targetDate));
  const successJobs = jobsToday.filter(j => j.status === 'success').length;
  const failedJobs = jobsToday.filter(j => j.status === 'failed').length;

  updateTaskProgress(task, 40, 'Claude에게 종합 보고서 요청 중...');

  const prompt = `당신은 개인 생산성 분석가입니다. 다음 데이터를 바탕으로 종합적인 일일 보고서를 작성해주세요.

## 날짜: ${targetDate}

## Claude Code 세션 (${sessions.length}개)
${sessionDetails.map(s => `### ${s.alias ? `${s.alias} (${s.project})` : s.project}
- 메시지: ${s.messageCount}개
- 도구: ${s.tools.join(', ')}
- 파일: ${s.files.join(', ')}
- 주요 작업: ${s.keyRequests.slice(0, 2).join(' / ')}`).join('\n\n')}

## 작업 실행 (${jobsToday.length}건)
- 성공: ${successJobs}, 실패: ${failedJobs}
${jobsToday.slice(0, 10).map(j => `- ${j.jobName}: ${j.status} (${((j.duration || 0)/1000).toFixed(1)}s)`).join('\n')}

## 메모 (대시보드 ${quickMemos.length}개 + Obsidian ${obsidianMemos.length}개)
${quickMemos.slice(0, 10).map(m => `- ${m.content?.substring(0, 80)}`).join('\n')}
${obsidianMemos.slice(0, 10).map(m => `- [Obsidian] ${m.content?.substring(0, 80)}`).join('\n')}

${morningPlan ? `## 모닝 플랜
- 업무: ${(morningPlan.tasks || []).join(', ')}
- 목표: ${(morningPlan.goals || []).join(', ')}
- 다짐: ${morningPlan.motto || ''}` : ''}

---
다음 형식으로 보고서를 작성해주세요:

# 📊 ${targetDate} 종합 일일 보고서

## 오늘의 요약
(한 문단)

## 🎯 주요 성과
(구체적 목록)

## 💻 개발 활동
(세션 기반 분석)

## ⚙️ 자동화 현황
(작업 실행 결과)

## 📝 메모 & 학습
(메모에서 추출한 인사이트)

## 🚀 내일 추천 업무
(데이터 기반 구체적 제안)`;

  const report = await spawnClaude(task, prompt);
  updateTaskProgress(task, 90, '보고서 생성 완료!');

  try {
    const reports = loadDailyReports();
    const record = {
      id: `dr-${targetDate}-full-daily-report`, date: targetDate, type: 'full-daily-report',
      sessionsCount: sessions.length, jobsCount: jobsToday.length, memosCount: quickMemos.length,
      report, createdAt: new Date().toISOString()
    };
    const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'full-daily-report');
    if (existIdx >= 0) reports[existIdx] = record;
    else reports.push(record);
    saveDailyReports(reports);
  } catch (e) { console.error('[FullDailyReport] 저장 실패:', e.message); }

  return { date: targetDate, sessionsCount: sessions.length, jobsCount: jobsToday.length, memosCount: quickMemos.length, report };
}

// --- Day Wrapup Task ---
async function processDayWrapupTask(task) {
  const { date, selectedSessions, githubActivity, memos, morningPlan, reflection } = task.payload;
  const targetDate = date || state.getKSTDateString();

  updateTaskProgress(task, 10, '선택된 세션 데이터 분석 중...');

  const sessionDetails = [];
  if (selectedSessions && selectedSessions.length > 0) {
    for (const sess of selectedSessions) {
      try {
        const data = parseSessionFile(sess.id, sess.projectPath, { maxMessages: 30 });
        const userMessages = data.conversation.filter(c => c.role === 'user' && c.content).slice(0, 10).map(c => c.content.substring(0, 200));
        sessionDetails.push({
          project: data.project, alias: sess.alias || null, messageCount: data.messageCount,
          tools: [...data.toolsUsed].slice(0, 5), files: [...data.filesChanged].slice(0, 5), keyRequests: userMessages
        });
      } catch (e) { console.error(`[DayWrapup] 세션 파싱 실패: ${sess.id}`, e.message); }
    }
  }

  updateTaskProgress(task, 30, '데이터 종합 중...');

  let todayMemos = memos || [];
  if (todayMemos.length === 0) {
    try { todayMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(targetDate)); } catch (e) { /* ignore */ }
  }

  let todayMorningPlan = morningPlan || null;
  if (!todayMorningPlan) {
    try { todayMorningPlan = loadMorningPlans().find(p => p.date === targetDate) || null; } catch (e) { /* ignore */ }
  }

  updateTaskProgress(task, 50, 'Claude에게 하루 마무리 작성 요청 중...');

  const prompt = `당신은 사용자의 하루를 돌아보며 의미있는 회고를 작성해주는 멘토입니다.
다음 정보를 바탕으로 따뜻하고 통찰력 있는 하루 마무리 보고서를 작성해주세요.

## 📅 날짜
${targetDate}

## 💻 오늘의 개발 세션 (${sessionDetails.length}개)
${sessionDetails.length > 0 ? sessionDetails.map(s => `
### ${s.alias ? `${s.alias} (${s.project})` : s.project}
- 메시지: ${s.messageCount}개
- 사용 도구: ${s.tools.join(', ')}
- 변경 파일: ${s.files.join(', ')}
- 주요 요청: ${s.keyRequests.slice(0, 3).join(' / ')}
`).join('\n') : '(선택된 세션 없음)'}

## 🐙 GitHub 활동
${githubActivity ? `
- 계정: ${(githubActivity.accounts || []).join(', ') || '알 수 없음'}
- 커밋: ${githubActivity.commits?.length || 0}개
- PR: ${githubActivity.prs?.length || 0}개
- 리뷰: ${githubActivity.reviews?.length || 0}개
` : '(GitHub 데이터 없음)'}

## ☀️ 아침에 세운 계획
${todayMorningPlan ? `
- 주요 업무: ${(todayMorningPlan.tasks || []).join(', ') || '(없음)'}
- 목표: ${(todayMorningPlan.goals || []).join(', ') || '(없음)'}
- 다짐: ${todayMorningPlan.motto || '(없음)'}
` : '(아침 계획 미작성)'}

## 📝 오늘의 메모 (${todayMemos.length}개)
${todayMemos.map(m => `- ${m.content || m.text || JSON.stringify(m)}`).join('\n') || '(메모 없음)'}

## 🪞 사용자의 회고
${reflection ? `
- 오늘 배운 것: ${reflection.learned || '(미입력)'}
- 잘한 점: ${reflection.proud || '(미입력)'}
- 개선할 점: ${reflection.improve || '(미입력)'}
- 내일 목표: ${reflection.tomorrow || '(미입력)'}
- 감사한 것: ${reflection.grateful || '(미입력)'}
- 한 줄 소감: ${reflection.oneline || '(미입력)'}
` : '(회고 미입력)'}

---
위 정보를 바탕으로 다음 형식의 마크다운 보고서를 작성해주세요:

# 🌙 ${targetDate} 하루 마무리
## 📋 오늘의 요약
## 🎯 오늘의 성취
## ☀️ 계획 vs 실제
## 💡 배움과 인사이트
## 🚀 내일을 위한 한 걸음
## ✨ 오늘의 한마디

진심어린 톤으로, 사용자가 하루를 의미있게 마무리할 수 있도록 작성해주세요.`;

  const report = await spawnClaude(task, prompt);
  updateTaskProgress(task, 95, '하루 마무리 완료!');

  try {
    const reports = loadDailyReports();
    const record = {
      id: `dr-${targetDate}-day-wrapup`, date: targetDate, type: 'day-wrapup',
      sessionsCount: sessionDetails.length, memosCount: todayMemos.length,
      hasGithub: !!githubActivity, hasReflection: !!reflection,
      report, createdAt: new Date().toISOString()
    };
    const existIdx = reports.findIndex(r => r.date === targetDate && r.type === 'day-wrapup');
    if (existIdx >= 0) reports[existIdx] = record;
    else reports.push(record);
    saveDailyReports(reports);
  } catch (e) { console.error('[DayWrapup] 저장 실패:', e.message); }

  return { date: targetDate, sessionsCount: sessionDetails.length, memosCount: todayMemos.length, hasGithub: !!githubActivity, hasReflection: !!reflection, report };
}

// --- Weekly Digest Task ---
async function processWeeklyDigestTask(task) {
  const today = state.getKSTDateString();
  const weekStart = task.payload.weekStart || getWeekStart(today);
  const weekEndDate = new Date(weekStart + 'T00:00:00');
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = state.getKSTDateString(weekEndDate);
  const dates = getDateRange(weekStart, weekEnd);

  updateTaskProgress(task, 10, '주간 데이터 수집 중...');

  let allSessions = [];
  let allObsidianMemos = [];
  for (const date of dates) {
    try { allSessions.push(...findSessions(date)); } catch (e) { /* ignore */ }
    try { allObsidianMemos.push(...parseObsidianMemos(date)); } catch (e) { /* ignore */ }
  }

  const weekMemos = loadQuickMemos().filter(m => m.timestamp >= weekStart && m.timestamp < weekEnd + 'T23:59:59');
  const weekPlans = loadMorningPlans().filter(p => p.date >= weekStart && p.date <= weekEnd);
  const weekHistory = state.jobHistory.filter(h => h.startTime >= weekStart && h.startTime < weekEnd + 'T23:59:59');
  const weekBacklogs = loadBacklogs();
  const completedBacklogs = weekBacklogs.filter(b => b.done && b.updatedAt >= weekStart && b.updatedAt <= weekEnd + 'T23:59:59');

  updateTaskProgress(task, 30, 'Claude 분석 프롬프트 구성 중...');

  const totalJobRuns = weekHistory.length;
  const successCount = weekHistory.filter(h => h.status === 'success').length;
  const successRate = totalJobRuns > 0 ? Math.round((successCount / totalJobRuns) * 100) : 0;
  const projects = [...new Set(allSessions.map(s => s.project || 'unknown'))];

  const sessionSummaries = allSessions.slice(0, 20).map(s =>
    `- [${s.modifiedAt?.split('T')[0] || '?'}] ${s.project || 'unknown'}: ${s.firstMessage?.substring(0, 80) || '(내용 없음)'}`
  ).join('\n');

  const memoContents = [...weekMemos.map(m => `- [대시보드] ${m.content?.substring(0, 100) || ''}`),
    ...allObsidianMemos.slice(0, 20).map(m => `- [Obsidian] ${m.content?.substring(0, 100) || ''}`)
  ].join('\n');

  const jobSummary = {};
  for (const h of weekHistory) {
    const name = h.jobName || h.jobId;
    if (!jobSummary[name]) jobSummary[name] = { total: 0, success: 0 };
    jobSummary[name].total++;
    if (h.status === 'success') jobSummary[name].success++;
  }
  const jobHistorySummary = Object.entries(jobSummary)
    .map(([name, s]) => `- ${name}: ${s.total}회 실행 (성공 ${s.success})`)
    .join('\n');

  const prompt = `당신은 개인 생산성 분석가입니다. 아래 데이터를 분석하여 주간 다이제스트를 작성하세요.

## 분석 데이터
- 기간: ${weekStart} ~ ${weekEnd}
- Claude 세션: ${allSessions.length}개 (프로젝트: ${projects.join(', ')})
- 작업 실행: ${totalJobRuns}회 (성공률: ${successRate}%)
- 메모: ${weekMemos.length + allObsidianMemos.length}개
- 완료 백로그: ${completedBacklogs.length}개
- 모닝 플랜: ${weekPlans.length}일

## 세션 상세
${sessionSummaries || '(세션 데이터 없음)'}

## 메모 내용
${memoContents || '(메모 없음)'}

## 작업 이력 요약
${jobHistorySummary || '(작업 이력 없음)'}

---
아래 형식으로 분석해주세요:

# 📊 주간 다이제스트 (${weekStart} ~ ${weekEnd})
## 🎯 이번 주 하이라이트
## 📈 활동 요약
## 💡 주요 학습 & 인사이트
## 🔄 진행 중인 업무
## 🎯 다음 주 제안
## 📉 개선 포인트`;

  updateTaskProgress(task, 40, 'Claude CLI 실행 중...');
  task.command = `claude -p "..."`;
  task.logs.push({ type: 'info', time: new Date().toISOString(), text: `주간 데이터: 세션 ${allSessions.length}개, 메모 ${weekMemos.length + allObsidianMemos.length}개, 작업 ${totalJobRuns}회` });

  const markdown = await spawnClaude(task, prompt, 600000);
  updateTaskProgress(task, 85, '결과 저장 중...');

  const digest = {
    id: `wd-${weekStart}`, weekStart, weekEnd, markdown,
    stats: { sessions: allSessions.length, jobRuns: totalJobRuns, memos: weekMemos.length + allObsidianMemos.length, successRate },
    createdAt: new Date().toISOString()
  };

  const digests = loadWeeklyDigests();
  const existIdx = digests.findIndex(d => d.weekStart === weekStart);
  if (existIdx >= 0) digests[existIdx] = digest;
  else digests.push(digest);
  saveWeeklyDigests(digests);

  try {
    const { vaultPath } = getObsidianPaths();
    const weeklyDir = path.join(vaultPath, 'WEEKLY');
    if (!fs.existsSync(weeklyDir)) fs.mkdirSync(weeklyDir, { recursive: true });
    fs.writeFileSync(path.join(weeklyDir, `${weekStart}-digest.md`), markdown);
    task.logs.push({ type: 'info', time: new Date().toISOString(), text: `Obsidian 저장: WEEKLY/${weekStart}-digest.md` });
  } catch (e) {
    task.logs.push({ type: 'warn', time: new Date().toISOString(), text: `Obsidian 저장 실패: ${e.message}` });
  }

  updateTaskProgress(task, 95, '완료 처리 중...');
  return { markdown, weekStart, weekEnd, stats: digest.stats };
}

// --- Session Insights Task ---
async function processSessionInsightsTask(task) {
  const { sessionId, projectPath } = task.payload;
  updateTaskProgress(task, 10, '세션 데이터 로드 중...');

  const sessionData = parseSessionFile(sessionId, projectPath, { maxMessages: 100 });
  const userMessages = sessionData.conversation.filter(c => c.role === 'user' && c.content).slice(0, 20).map(c => c.content.substring(0, 500));
  const assistantSummary = sessionData.conversation.filter(c => c.role === 'assistant' && c.content).slice(0, 10).map(c => c.content.substring(0, 300));

  updateTaskProgress(task, 30, 'Claude 분석 요청 중...');

  const prompt = `다음 Claude Code 세션을 분석하여 인사이트를 추출하세요.

프로젝트: ${sessionData.project}
메시지 수: ${sessionData.messageCount}
사용 도구: ${[...sessionData.toolsUsed].slice(0, 10).join(', ')}
변경 파일: ${[...sessionData.filesChanged].slice(0, 15).join(', ')}

사용자 요청:
${userMessages.join('\n---\n')}

Assistant 응답 (요약):
${assistantSummary.slice(0, 5).join('\n---\n')}

JSON 형식으로만 응답하세요:
{
  "topics": ["주제1", "주제2"],
  "technologies": ["기술1", "기술2"],
  "problems_solved": ["해결한 문제"],
  "key_decisions": ["주요 결정"],
  "complexity": "low|medium|high",
  "summary": "한 줄 요약 (50자 이내)"
}`;

  task.command = `claude -p "..."`;
  task.logs.push({ type: 'cmd', time: new Date().toISOString(), text: 'Claude 인사이트 분석 실행' });
  updateTaskProgress(task, 40, 'Claude CLI 실행 중...');

  const stdout = await spawnClaude(task, prompt, 240000);
  let insights;
  try {
    let jsonStr = stdout.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    insights = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`JSON 파싱 실패: ${err.message}`);
  }

  updateTaskProgress(task, 85, '인사이트 저장 중...');

  const allInsights = loadSessionInsights();
  allInsights[sessionId] = {
    ...insights,
    files_modified: [...sessionData.filesChanged].slice(0, 15),
    createdAt: new Date().toISOString()
  };
  saveSessionInsights(allInsights);

  try { rebuildKnowledgeGraph(); } catch (e) { /* ignore */ }

  updateTaskProgress(task, 100, '완료');
  return { sessionId, project: sessionData.project, insights: allInsights[sessionId] };
}

// --- Review Analysis Task ---
async function processReviewAnalysisTask(task) {
  const { days = 30 } = task.payload;
  updateTaskProgress(task, 10, 'GitHub 리뷰 데이터 수집 중...');

  const allActivity = [];
  try {
    const accounts = await getGhAccounts();
    for (const acc of accounts) {
      const username = acc.username;
      const result = JSON.parse(await new Promise((resolve, reject) => {
        const gh = spawn('gh', ['api', `/users/${username}/events?per_page=100`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        gh.stdout.on('data', d => { out += d.toString(); });
        gh.on('close', code => code === 0 ? resolve(out) : reject(new Error(`gh failed: ${code}`)));
        gh.on('error', reject);
      }));

      const reviews = result.filter(e =>
        e.type === 'PullRequestReviewEvent' || e.type === 'PullRequestReviewCommentEvent'
      ).map(e => ({
        repo: e.repo?.name, prNumber: e.payload?.pull_request?.number,
        prTitle: e.payload?.pull_request?.title || '(제목 없음)',
        action: e.payload?.action, state: e.payload?.review?.state,
        body: e.payload?.review?.body || e.payload?.comment?.body || '',
        createdAt: e.created_at, account: username
      }));
      allActivity.push(...reviews);
    }
  } catch (err) {
    console.error('[ReviewAnalysis] GitHub 데이터 수집 오류:', err.message);
  }

  if (allActivity.length === 0) {
    return { period: `${days} days`, reviewCount: 0, analysis: { common_patterns: [], review_style: '데이터 부족', suggestions: [], checklist: [] } };
  }

  updateTaskProgress(task, 40, `${allActivity.length}개 리뷰 분석 중...`);

  const reviewSummaries = allActivity.slice(0, 30).map(r => ({
    repo: r.repo, pr: r.prTitle, state: r.state,
    comment: (r.body || '').substring(0, 200), date: r.createdAt?.split('T')[0]
  }));

  const prompt = `다음은 ${days}일간의 코드 리뷰 활동입니다.\n\n${JSON.stringify(reviewSummaries, null, 2)}\n\nJSON만 응답:\n{\n  "common_patterns": ["자주 지적하는 패턴 (상위 3개)"],\n  "review_style": "리뷰 스타일 한 문장 설명",\n  "suggestions": ["개선 제안 2-3개"],\n  "checklist": [\n    {"item": "체크리스트 항목", "category": "security|performance|style|testing"}\n  ],\n  "summary": "전체 리뷰 활동 요약 (2-3문장)"\n}`;

  const stdout = await spawnClaude(task, prompt, 240000);
  let analysis;
  try {
    let jsonStr = stdout.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    analysis = JSON.parse(jsonStr);
  } catch (err) { throw new Error(`JSON 파싱 실패: ${err.message}`); }

  updateTaskProgress(task, 90, '결과 저장 중...');

  const result = {
    id: `ra-${state.getKSTDateString()}`, period: `${days} days`,
    reviewCount: allActivity.length, analysis, createdAt: new Date().toISOString()
  };

  const allAnalysis = loadReviewAnalysis();
  const existIdx = allAnalysis.findIndex(a => a.id === result.id);
  if (existIdx >= 0) allAnalysis[existIdx] = result;
  else allAnalysis.push(result);
  saveReviewAnalysis(allAnalysis);

  updateTaskProgress(task, 100, '완료');
  return result;
}

// Expose processTask for external use (review-analysis, weekly-digest, session-insights routes)
router.processTask = processTask;

module.exports = router;
