'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { DATA_FILES, getKSTDateString, loadJsonFile, saveJsonFile } = require('./state');
const { sendSSEEvent, updateTaskProgress } = require('./sse');

// --- Memo Categories ---
const CATEGORY_DEFINITIONS = {
  work: { icon: '💼', keywords: ['pr', 'pr리뷰', '배포', 'deploy', '회의', 'meeting', 'review', '리뷰', '머지', 'merge', '코드리뷰', 'jira', '티켓', 'hotfix', 'release', '릴리즈', '장애', '모니터링', '운영', '인프라'] },
  learning: { icon: '📚', keywords: ['학습', '공부', '정리', 'study', 'learn', '이해', '확인중', '알아보기', 'til', '개념', '원리', '동작방식', '아키텍처', '패턴', '블로그', '강의', '튜토리얼', '읽기', '참고'] },
  idea: { icon: '💡', keywords: ['아이디어', 'idea', '제안', '추가하면', '개선', 'suggest', '하면 좋겠다', '해보자', '시도', '구상', '기획'] },
  todo: { icon: '✅', keywords: ['해야', 'todo', '할일', '작업', 'task', '필요', '처리', '예정', '내일', '오늘', '이번주'] },
  issue: { icon: '🐛', keywords: ['이슈', 'issue', '버그', 'bug', '문제', '오류', 'error', 'fail', '실패', 'oom', 'crash', '에러', 'fix', '수정필요'] },
  personal: { icon: '🏠', keywords: ['점심', '저녁', '휴가', 'lunch', 'dinner', 'personal', '약속', '운동', '병원', '맛집'] }
};

function loadMemoCategories() {
  return loadJsonFile(DATA_FILES.memoCategories, {});
}

function saveMemoCategories(categories) {
  saveJsonFile(DATA_FILES.memoCategories, categories);
}

function classifyMemoByKeywords(content) {
  const lower = content.toLowerCase();
  const matches = {};

  for (const [cat, def] of Object.entries(CATEGORY_DEFINITIONS)) {
    const matchedKw = def.keywords.filter(kw => lower.includes(kw));
    if (matchedKw.length > 0) matches[cat] = { score: matchedKw.length, keywords: matchedKw };
  }

  if (Object.keys(matches).length === 0) return null;

  const sorted = Object.entries(matches).sort((a, b) => b[1].score - a[1].score);
  const category = sorted[0][0];
  const tags = sorted[0][1].keywords.slice(0, 3);

  return { category, tags, confidence: 'keyword' };
}

async function classifyMemoWithClaude(content) {
  const claudePath = process.env.CLAUDE_CLI_PATH ||
    path.join(os.homedir(), '.local', 'bin', 'claude');

  if (!fs.existsSync(claudePath)) return null;

  const prompt = `다음 메모를 분류하세요.\n\n메모: "${content}"\n\n카테고리 (하나만 선택):\n- work: 업무 (PR, 배포, 회의, 코드리뷰)\n- learning: 학습/기술 (개념 정리, 새로운 기술)\n- idea: 아이디어/제안\n- todo: 할일/작업 항목\n- issue: 이슈/버그/문제\n- personal: 개인/일상\n\nJSON만 응답: {"category": "learning", "tags": ["aws", "ecs"]}\n태그는 핵심 키워드 1-3개만.`;

  return new Promise((resolve) => {
    const claude = spawn(claudePath, ['-p', prompt], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    const timeout = setTimeout(() => { claude.kill('SIGTERM'); resolve(null); }, 20000);

    claude.stdout.on('data', d => { stdout += d.toString(); });
    claude.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try {
        let jsonStr = stdout.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        if (parsed.category && CATEGORY_DEFINITIONS[parsed.category]) {
          resolve({ category: parsed.category, tags: (parsed.tags || []).slice(0, 3), confidence: 'claude' });
        } else {
          resolve(null);
        }
      } catch { resolve(null); }
    });
    claude.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

async function classifyMemoBackground(memoId, content) {
  let result = classifyMemoByKeywords(content);
  if (!result) {
    result = await classifyMemoWithClaude(content);
  }

  if (result) {
    const categories = loadMemoCategories();
    categories[memoId] = {
      ...result,
      autoTags: true,
      classifiedAt: new Date().toISOString()
    };
    saveMemoCategories(categories);
    sendSSEEvent(null, 'memo:classified', { memoId, ...result });
    console.log(`[MemoCategory] ${memoId} → ${result.category} (${result.confidence})`);
  }
}

// --- Knowledge Graph ---
function loadKnowledgeGraphData() {
  return loadJsonFile(DATA_FILES.knowledgeGraph, { nodes: [], edges: [], metadata: { lastUpdated: null, totalNodes: 0, totalEdges: 0 } });
}

function saveKnowledgeGraph(graph) {
  graph.metadata = {
    lastUpdated: new Date().toISOString(),
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length
  };
  saveJsonFile(DATA_FILES.knowledgeGraph, graph);
}

function rebuildKnowledgeGraph() {
  const { loadSessionInsights } = require('./sessions');
  const { loadQuickMemos } = require('./notes');
  const allInsights = loadSessionInsights();
  const memoCategories = loadMemoCategories();
  const memos = loadQuickMemos();

  const nodeMap = new Map();
  const edgeMap = new Map();

  for (const [sessionId, insight] of Object.entries(allInsights)) {
    const allKeywords = [...(insight.topics || []), ...(insight.technologies || [])];

    for (const keyword of allKeywords) {
      const nodeId = `topic-${keyword.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;

      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId, label: keyword, category: 'general',
          mentions: 0, lastSeen: getKSTDateString(),
          sources: { sessions: [], memos: [] }
        });
      }

      const node = nodeMap.get(nodeId);
      node.mentions++;
      if (!node.sources.sessions.includes(sessionId)) {
        node.sources.sessions.push(sessionId);
      }
      const insightDate = insight.createdAt?.split('T')[0];
      if (insightDate && insightDate > node.lastSeen) node.lastSeen = insightDate;
    }

    for (let i = 0; i < allKeywords.length; i++) {
      for (let j = i + 1; j < allKeywords.length; j++) {
        const idA = `topic-${allKeywords[i].toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;
        const idB = `topic-${allKeywords[j].toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;
        const edgeKey = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;

        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            from: idA < idB ? idA : idB,
            to: idA < idB ? idB : idA,
            strength: 0, context: `${allKeywords[i]}와 ${allKeywords[j]}`,
            cooccurrences: []
          });
        }

        const edge = edgeMap.get(edgeKey);
        edge.strength++;
        if (!edge.cooccurrences.includes(sessionId)) edge.cooccurrences.push(sessionId);
      }
    }
  }

  for (const memo of memos) {
    const cat = memoCategories[memo.id];
    if (!cat || !cat.tags || cat.tags.length === 0) continue;

    for (const tag of cat.tags) {
      const nodeId = `topic-${tag.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-')}`;

      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId, label: tag, category: cat.category || 'general',
          mentions: 0, lastSeen: getKSTDateString(),
          sources: { sessions: [], memos: [] }
        });
      }

      const node = nodeMap.get(nodeId);
      node.mentions++;
      if (!node.sources.memos.includes(memo.id)) node.sources.memos.push(memo.id);
      const memoDate = memo.timestamp?.split('T')[0];
      if (memoDate && memoDate > node.lastSeen) node.lastSeen = memoDate;
    }
  }

  const graph = {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values())
  };

  saveKnowledgeGraph(graph);
  console.log(`[KnowledgeGraph] 재구성 완료: ${graph.nodes.length}개 노드, ${graph.edges.length}개 엣지`);
  return graph;
}

// --- Review Analysis ---
function loadReviewAnalysis() {
  return loadJsonFile(DATA_FILES.reviewAnalysis, []);
}

function saveReviewAnalysis(data) {
  saveJsonFile(DATA_FILES.reviewAnalysis, data);
}

// --- Suggestions ---
function generateSuggestions() {
  const { loadQuickMemos, loadBacklogs, loadMorningPlans } = require('./notes');
  const { parseObsidianMemos } = require('./obsidian');
  const state = require('./state');

  const now = new Date();
  const today = getKSTDateString(now);
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const suggestions = [];

  try {
    const todayMemos = loadQuickMemos().filter(m => m.timestamp?.startsWith(today));
    let obsidianMemoCount = 0;
    try { obsidianMemoCount = parseObsidianMemos(today).length; } catch (e) { /* ignore */ }
    if (todayMemos.length === 0 && obsidianMemoCount === 0 && hour >= 11) {
      suggestions.push({
        id: 'nudge-memo', type: 'nudge', icon: '📝',
        message: '오늘 아직 메모를 남기지 않으셨어요. 빠른 메모를 남겨보세요!',
        action: { type: 'openQuickInput' }, priority: 'low'
      });
    }

    const backlogs = loadBacklogs().filter(b => !b.done);
    const oldBacklogs = backlogs.filter(b => {
      const created = new Date(b.createdAt);
      return (Date.now() - created.getTime()) > 7 * 24 * 60 * 60 * 1000;
    });
    if (oldBacklogs.length > 0) {
      suggestions.push({
        id: 'reminder-backlog', type: 'reminder', icon: '📋',
        message: `백로그에 ${oldBacklogs.length}개 항목이 1주일 넘게 대기중이에요`,
        action: { type: 'showTab', tab: 'notes' }, priority: 'medium'
      });
    }

    if (isWeekday && ((hour === 10 && minute >= 30) || hour === 11)) {
      const todayPlan = loadMorningPlans().find(p => p.date === today);
      if (!todayPlan) {
        suggestions.push({
          id: 'nudge-morning', type: 'nudge', icon: '☀️',
          message: '오늘의 계획을 아직 세우지 않으셨어요. 하루 시작을 해보세요!',
          action: { type: 'openMorningStart' }, priority: 'medium'
        });
      }
    }

    if (hour >= 22 && minute >= 30) {
      const todayPlan = loadMorningPlans().find(p => p.date === today);
      if (todayPlan?.goals?.length > 0) {
        suggestions.push({
          id: 'achievement-day', type: 'achievement', icon: '🎯',
          message: `오늘 하루 수고하셨어요! 목표 ${todayPlan.goals.length}개를 세우고 달려온 하루였습니다`,
          action: null, priority: 'info'
        });
      }
    }

    const todayFailed = state.jobHistory.filter(h =>
      h.startTime?.startsWith(today) && h.status === 'failed'
    );
    if (todayFailed.length > 0) {
      const jobNames = [...new Set(todayFailed.map(h => h.jobName || h.jobId))].slice(0, 3).join(', ');
      suggestions.push({
        id: 'alert-failed', type: 'reminder', icon: '⚠️',
        message: `오늘 실패한 작업이 ${todayFailed.length}개 있어요: ${jobNames}`,
        action: { type: 'showTab', tab: 'jobs' }, priority: 'high'
      });
    }
  } catch (e) {
    console.error('[Suggestions] 생성 오류:', e.message);
  }

  return suggestions;
}

// --- Weekly digest helpers ---
function loadWeeklyDigests() {
  return loadJsonFile(DATA_FILES.weeklyDigests, []);
}

function saveWeeklyDigests(digests) {
  saveJsonFile(DATA_FILES.weeklyDigests, digests);
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return getKSTDateString(d);
}

function getDateRange(start, end) {
  const dates = [];
  for (let d = new Date(start + 'T00:00:00'); d <= new Date(end + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    dates.push(getKSTDateString(d));
  }
  return dates;
}

module.exports = {
  CATEGORY_DEFINITIONS,
  loadMemoCategories, saveMemoCategories,
  classifyMemoByKeywords, classifyMemoWithClaude, classifyMemoBackground,
  loadKnowledgeGraphData, saveKnowledgeGraph, rebuildKnowledgeGraph,
  loadReviewAnalysis, saveReviewAnalysis,
  generateSuggestions,
  loadWeeklyDigests, saveWeeklyDigests,
  getWeekStart, getDateRange,
};
