const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Claude Code Session Collector
 * Reads session info from ~/.claude/projects/{project}/sessions-index.json
 */
class SessionCollector {
  constructor() {
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Find today's sessions
   * @param {string} targetDate - YYYY-MM-DD format (default: today)
   * @returns {Array} Session list
   */
  findTodaySessions(targetDate = null) {
    const date = targetDate || new Date().toISOString().split('T')[0];
    const sessions = [];

    if (!fs.existsSync(this.projectsDir)) {
      console.log('[SessionCollector] Projects directory not found');
      return sessions;
    }

    try {
      const projectDirs = fs.readdirSync(this.projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsDir, projectDir);
        const indexPath = path.join(projectPath, 'sessions-index.json');

        if (!fs.existsSync(indexPath)) continue;

        try {
          const indexContent = fs.readFileSync(indexPath, 'utf8');
          const index = JSON.parse(indexContent);

          for (const entry of index.entries || []) {
            // Check date (modified or created)
            const entryDate = (entry.modified || entry.created || '').split('T')[0];

            if (entryDate === date) {
              sessions.push({
                projectDir,
                sessionId: entry.sessionId,
                summary: entry.summary,
                firstPrompt: entry.firstPrompt,
                messageCount: entry.messageCount,
                created: entry.created,
                modified: entry.modified,
                gitBranch: entry.gitBranch,
                projectPath: entry.projectPath
              });
            }
          }
        } catch (parseError) {
          console.warn(`[SessionCollector] Failed to parse ${indexPath}:`, parseError.message);
        }
      }

      // Sort by time (newest first)
      sessions.sort((a, b) => {
        const timeA = new Date(a.modified || a.created || 0).getTime();
        const timeB = new Date(b.modified || b.created || 0).getTime();
        return timeB - timeA;
      });

    } catch (error) {
      console.error('[SessionCollector] Error reading projects:', error);
    }

    console.log(`[SessionCollector] Found ${sessions.length} sessions for ${date}`);
    return sessions;
  }

  /**
   * Build session summary
   * @param {Array} sessions - Session list
   * @returns {string} Markdown formatted summary
   */
  buildSessionSummary(sessions) {
    if (!sessions || sessions.length === 0) {
      return '_No Claude Code sessions today._';
    }

    const lines = [`**Sessions: ${sessions.length}**\n`];

    // Group by project
    const byProject = {};
    for (const s of sessions) {
      // Extract project name (last part of path)
      let project = 'default';
      if (s.projectPath) {
        project = path.basename(s.projectPath);
      } else if (s.projectDir) {
        // -Users-iyeongsu-ai-pipeline-dashboard 형식에서 마지막 부분
        const parts = s.projectDir.split('-');
        project = parts[parts.length - 1] || 'default';
      }

      if (!byProject[project]) byProject[project] = [];
      byProject[project].push(s);
    }

    // Output by project
    for (const [project, projectSessions] of Object.entries(byProject)) {
      lines.push(`\n### ${project}`);

      for (const s of projectSessions) {
        const time = s.modified
          ? new Date(s.modified).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
          : '';

        const title = s.summary || s.firstPrompt?.substring(0, 60) || '(untitled)';
        const messageInfo = s.messageCount ? ` (${s.messageCount} messages)` : '';

        lines.push(`- ${time ? `\`${time}\` ` : ''}${title}${messageInfo}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Read stats cache
   * @returns {Object} Stats info
   */
  getStats() {
    const statsPath = path.join(this.claudeDir, 'stats-cache.json');

    try {
      if (fs.existsSync(statsPath)) {
        const content = fs.readFileSync(statsPath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('[SessionCollector] Failed to read stats:', error.message);
    }

    return null;
  }

  /**
   * Get today's stats
   * @returns {Object} Today's stats
   */
  getTodayStats() {
    const stats = this.getStats();
    if (!stats) return null;

    const today = new Date().toISOString().split('T')[0];
    const dailyStats = stats.dailyActivity?.[today];

    return dailyStats || null;
  }

  /**
   * Find session file path
   * @param {string} sessionId - Session ID
   * @returns {string|null} Session file path
   */
  findSessionFile(sessionId) {
    if (!fs.existsSync(this.projectsDir)) return null;

    try {
      const projectDirs = fs.readdirSync(this.projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsDir, projectDir);
        const sessionFile = path.join(projectPath, `${sessionId}.jsonl`);

        if (fs.existsSync(sessionFile)) {
          return sessionFile;
        }
      }
    } catch (error) {
      console.warn('[SessionCollector] Error finding session file:', error.message);
    }

    return null;
  }
}

module.exports = { SessionCollector };
