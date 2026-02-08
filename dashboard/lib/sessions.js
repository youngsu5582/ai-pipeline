'use strict';

const fs = require('fs');
const path = require('path');
const { CLAUDE_PROJECTS, DATA_FILES, getKSTDateString, loadSessionAliases, loadJsonFile, saveJsonFile } = require('./state');

function loadSessionSummaries() {
  return loadJsonFile(DATA_FILES.sessionSummaries, []);
}

function saveSessionSummaries(summaries) {
  saveJsonFile(DATA_FILES.sessionSummaries, summaries);
}

function loadDailyReports() {
  return loadJsonFile(DATA_FILES.dailyReports, []);
}

function saveDailyReports(reports) {
  saveJsonFile(DATA_FILES.dailyReports, reports);
}

function loadSessionInsights() {
  return loadJsonFile(DATA_FILES.sessionInsights, {});
}

function saveSessionInsights(insights) {
  saveJsonFile(DATA_FILES.sessionInsights, insights);
}

function findSessions(targetDate, projectFilter) {
  const sessions = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return sessions;

  const aliases = loadSessionAliases();

  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectPath = path.join(CLAUDE_PROJECTS, dir);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;
      if (dir === 'memory' || dir === '.deleted') continue;

      const projectName = dir.split('-').pop();
      if (projectFilter && !projectName.toLowerCase().includes(projectFilter.toLowerCase())) continue;

      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const fileStat = fs.statSync(filePath);
        const mtime = getKSTDateString(fileStat.mtime);
        if (mtime === targetDate) {
          let firstMessage = '';
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').slice(0, 20);
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' && entry.message?.content) {
                  const msgContent = entry.message.content;
                  if (typeof msgContent === 'string') {
                    firstMessage = msgContent.substring(0, 100);
                  } else if (Array.isArray(msgContent)) {
                    const textPart = msgContent.find(p => p.type === 'text');
                    if (textPart) firstMessage = textPart.text?.substring(0, 100) || '';
                  }
                  break;
                }
              } catch (e) { /* skip */ }
            }
          } catch (e) { /* skip */ }

          const sessionId = file.replace('.jsonl', '');
          sessions.push({
            id: sessionId,
            project: projectName,
            projectPath: dir,
            file: file,
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
            firstMessage: firstMessage || '',
            alias: aliases[sessionId] || null
          });
        }
      }
    }
  } catch (err) {
    console.error('[Sessions] Error finding sessions:', err.message);
  }

  return sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

// Bulk session find (for productivity analysis, 60s cache)
let _sessionBulkCache = null;
let _sessionBulkCacheTime = 0;

function findSessionsBulk(dateSet) {
  const sessionsByDate = {};
  for (const d of dateSet) sessionsByDate[d] = [];

  const now = Date.now();
  let allSessions = _sessionBulkCache;
  if (!allSessions || now - _sessionBulkCacheTime > 60000) {
    allSessions = [];
    if (fs.existsSync(CLAUDE_PROJECTS)) {
      try {
        for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
          const projectPath = path.join(CLAUDE_PROJECTS, dir);
          let stat;
          try { stat = fs.statSync(projectPath); } catch { continue; }
          if (!stat.isDirectory() || dir === 'memory' || dir === '.deleted') continue;
          const projectName = dir.split('-').pop();

          let files;
          try { files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
          for (const file of files) {
            try {
              const fileStat = fs.statSync(path.join(projectPath, file));
              allSessions.push({
                project: projectName,
                modifiedAt: fileStat.mtime.toISOString(),
                date: getKSTDateString(fileStat.mtime)
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    }
    _sessionBulkCache = allSessions;
    _sessionBulkCacheTime = now;
  }

  for (const s of allSessions) {
    if (sessionsByDate[s.date]) {
      sessionsByDate[s.date].push({ project: s.project, modifiedAt: s.modifiedAt });
    }
  }
  return sessionsByDate;
}

function parseSessionFile(sessionId, projectPath, options = {}) {
  const filePath = path.join(CLAUDE_PROJECTS, projectPath, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    throw new Error('Session file not found');
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const aliases = loadSessionAliases();

  const result = {
    id: sessionId,
    project: projectPath.split('-').pop(),
    projectPath: projectPath,
    alias: aliases[sessionId] || null,
    filesChanged: new Set(),
    toolsUsed: new Set(),
    messageCount: 0,
    firstMessage: null,
    lastActivity: null,
    conversation: []
  };

  const includeConversation = options.includeConversation !== false;
  const maxMessages = options.maxMessages || 200;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.type === 'user' || entry.type === 'assistant') {
        result.messageCount++;
        if (entry.timestamp) result.lastActivity = entry.timestamp;
      }

      if (!result.firstMessage && entry.type === 'user') {
        const msgContent = entry.message?.content;
        if (typeof msgContent === 'string') {
          result.firstMessage = msgContent.substring(0, 200);
        } else if (Array.isArray(msgContent)) {
          const textPart = msgContent.find(p => p.type === 'text');
          if (textPart) result.firstMessage = textPart.text?.substring(0, 200);
        }
      }

      if (includeConversation && result.conversation.length < maxMessages) {
        if (entry.type === 'user') {
          const msgContent = entry.message?.content;
          let text = '';
          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === 'text') text += part.text || '';
            }
          }
          if (text && !text.includes('<system-reminder>') && text.trim().length > 0) {
            result.conversation.push({
              role: 'user',
              content: text.substring(0, 3000),
              timestamp: entry.timestamp
            });
          }
        } else if (entry.type === 'assistant') {
          const msgContent = entry.message?.content;
          let text = '';
          const tools = [];

          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === 'text' && part.text) {
                text += part.text;
              } else if (part.type === 'tool_use') {
                result.toolsUsed.add(part.name);
                tools.push({ name: part.name, input: part.input });
                if (part.input?.file_path) {
                  result.filesChanged.add(path.basename(part.input.file_path));
                }
              }
            }
          } else if (typeof msgContent === 'string') {
            text = msgContent;
          }

          if (text.trim() || tools.length > 0) {
            result.conversation.push({
              role: 'assistant',
              content: text.trim().substring(0, 3000),
              tools: tools.map(t => t.name),
              toolDetails: tools.slice(0, 5),
              timestamp: entry.timestamp
            });
          }
        }
      } else {
        if (entry.type === 'assistant' && entry.message?.content) {
          const msgContent = entry.message.content;
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === 'tool_use') {
                result.toolsUsed.add(part.name);
                if (part.input?.file_path) {
                  result.filesChanged.add(path.basename(part.input.file_path));
                }
              }
            }
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  result.filesChanged = Array.from(result.filesChanged).slice(0, 30);
  result.toolsUsed = Array.from(result.toolsUsed);

  return result;
}

function sessionToMarkdown(sessionData, options = {}) {
  const { summary, insights } = options;
  const lines = [];
  const date = sessionData.lastActivity ?
    new Date(sessionData.lastActivity).toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '날짜 없음';

  const complexityEmoji = { low: '🟢', medium: '🟡', high: '🔴' };

  lines.push(`# Claude Code 세션: ${sessionData.project}`);
  lines.push('');
  lines.push(`- **세션 ID**: \`${sessionData.id}\``);
  lines.push(`- **날짜**: ${date}`);
  lines.push(`- **메시지 수**: ${sessionData.messageCount}`);
  lines.push(`- **사용된 도구**: ${sessionData.toolsUsed.join(', ') || '없음'}`);
  if (insights?.complexity) {
    lines.push(`- **복잡도**: ${complexityEmoji[insights.complexity] || ''} ${insights.complexity}`);
  }
  lines.push('');

  if (insights) {
    lines.push('## 📊 인사이트');
    lines.push('');
    if (insights.summary) { lines.push(`> ${insights.summary}`); lines.push(''); }
    if (insights.topics?.length) { lines.push(`**주제**: ${insights.topics.map(t => `\`${t}\``).join(' ')}`); lines.push(''); }
    if (insights.technologies?.length) { lines.push(`**기술**: ${insights.technologies.map(t => `\`${t}\``).join(' ')}`); lines.push(''); }
    if (insights.problems_solved?.length) {
      lines.push('**해결한 문제**:');
      for (const p of insights.problems_solved) lines.push(`- ✅ ${p}`);
      lines.push('');
    }
    if (insights.key_decisions?.length) {
      lines.push('**주요 결정**:');
      for (const d of insights.key_decisions) lines.push(`- 🎯 ${d}`);
      lines.push('');
    }
  }

  if (summary) {
    lines.push('## 📋 요약');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  if (sessionData.filesChanged.length > 0) {
    lines.push('## 변경된 파일');
    lines.push('');
    for (const f of sessionData.filesChanged) lines.push(`- \`${f}\``);
    lines.push('');
  }

  lines.push('## 대화 내용');
  lines.push('');

  const grouped = [];
  let toolGroup = null;
  for (const msg of sessionData.conversation || []) {
    const hasContent = msg.content && msg.content.trim();
    const isToolOnly = msg.role === 'assistant' && !hasContent && msg.tools?.length > 0;

    if (isToolOnly) {
      if (!toolGroup) toolGroup = { isToolGroup: true, count: 0, tools: [], timestamp: msg.timestamp };
      toolGroup.count++;
      for (const t of (msg.tools || [])) toolGroup.tools.push(t);
    } else {
      if (toolGroup) {
        if (toolGroup.count >= 2 || toolGroup.tools.length >= 2) {
          grouped.push(toolGroup);
        } else {
          grouped.push({ role: 'assistant', content: '', tools: toolGroup.tools, timestamp: toolGroup.timestamp });
        }
        toolGroup = null;
      }
      grouped.push(msg);
    }
  }
  if (toolGroup) {
    if (toolGroup.count >= 2 || toolGroup.tools.length >= 2) {
      grouped.push(toolGroup);
    } else {
      grouped.push({ role: 'assistant', content: '', tools: toolGroup.tools, timestamp: toolGroup.timestamp });
    }
  }

  for (const msg of grouped) {
    if (msg.isToolGroup) {
      const toolCounts = {};
      for (const t of msg.tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
      const summary = Object.entries(toolCounts).map(([t, c]) => c > 1 ? `${t} ×${c}` : t).join(', ');
      lines.push(`> 🔧 _${msg.tools.length}개 도구 호출: ${summary}_`);
      lines.push('');
    } else if (msg.role === 'user') {
      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`### 👤 사용자 ${time ? `(${time})` : ''}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    } else {
      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`### 🤖 Claude ${time ? `(${time})` : ''}`);
      lines.push('');
      if (msg.tools?.length > 0) { lines.push(`> 🔧 사용된 도구: ${msg.tools.join(', ')}`); lines.push(''); }
      if (msg.content) lines.push(msg.content);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*AI Pipeline Dashboard에서 내보냄*`);

  return lines.join('\n');
}

module.exports = {
  findSessions,
  findSessionsBulk,
  parseSessionFile,
  sessionToMarkdown,
  loadSessionSummaries,
  saveSessionSummaries,
  loadDailyReports,
  saveDailyReports,
  loadSessionInsights,
  saveSessionInsights,
};
