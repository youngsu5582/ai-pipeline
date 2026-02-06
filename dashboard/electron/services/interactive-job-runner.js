const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

/**
 * Interactive Job Runner
 * jobs.json의 interactive 작업을 스케줄링하고 실행
 */
class InteractiveJobRunner {
  constructor(options = {}) {
    this.popupWindow = options.popupWindow;
    this.claudeCode = options.claudeCode;
    this.obsidianWriter = options.obsidianWriter;
    this.sessionCollector = options.sessionCollector;
    this.store = options.store;

    this.scheduledJobs = new Map();
    this.jobs = [];
  }

  /**
   * 시작
   */
  start() {
    this.loadJobs();
    this.scheduleJobs();
    console.log(`[JobRunner] Started with ${this.jobs.length} interactive jobs`);
  }

  /**
   * jobs.json에서 interactive 작업 로드
   */
  loadJobs() {
    try {
      const jobsPath = path.join(__dirname, '../../jobs.json');
      const data = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      this.jobs = (data.jobs || []).filter(job => job.interactive === true);
    } catch (error) {
      console.error('[JobRunner] Failed to load jobs:', error);
      this.jobs = [];
    }
  }

  /**
   * 작업 스케줄링
   */
  scheduleJobs() {
    // 기존 스케줄 취소
    this.scheduledJobs.forEach(task => task.stop());
    this.scheduledJobs.clear();

    // 새 스케줄 등록
    this.jobs.forEach(job => {
      if (job.schedule && job.enabled !== false) {
        try {
          const task = cron.schedule(job.schedule, () => {
            this.executeJob(job);
          });
          this.scheduledJobs.set(job.id, task);
          console.log(`[JobRunner] Scheduled: ${job.name} (${job.schedule})`);
        } catch (error) {
          console.error(`[JobRunner] Failed to schedule ${job.id}:`, error);
        }
      }
    });
  }

  /**
   * 작업 실행
   */
  async executeJob(job) {
    console.log(`[JobRunner] Executing: ${job.name}`);

    try {
      // 알림 설정 확인
      const settings = this.store.get('notificationSettings', {});
      if (settings.enabled === false) {
        console.log(`[JobRunner] Notifications disabled, skipping ${job.name}`);
        return;
      }

      // 시간대 확인
      const now = new Date();
      const hour = now.getHours();
      if (hour < (settings.startHour || 0) || hour >= (settings.endHour || 24)) {
        console.log(`[JobRunner] Outside notification hours, skipping ${job.name}`);
        return;
      }

      // 1. 데이터 수집
      const collectedData = await this.collectData(job);

      // 2. 팝업 표시 및 사용자 입력 대기
      const userInput = await this.popupWindow.show(job, collectedData);

      // 3. 입력이 없으면 종료 (스킵된 경우)
      if (!userInput && job.popup?.inputType !== 'quick-buttons') {
        console.log(`[JobRunner] User skipped: ${job.name}`);
        return;
      }

      // 4. Claude 처리
      let processedContent = userInput?.text || userInput;
      if (job.processing?.claude?.enabled) {
        processedContent = await this.processWithClaude(job, processedContent, collectedData);
      }

      // 5. 저장
      await this.saveOutput(job, processedContent, collectedData);

      console.log(`[JobRunner] Completed: ${job.name}`);

    } catch (error) {
      console.error(`[JobRunner] Error executing ${job.name}:`, error);
    }
  }

  /**
   * 데이터 수집
   */
  async collectData(job) {
    const data = {};

    if (job.collect?.todayEntries) {
      const today = new Date().toISOString().split('T')[0];
      data.entries = this.store.get(`entries.${today}`, []);
    }

    if (job.collect?.claudeSessions) {
      try {
        data.sessions = this.sessionCollector.findTodaySessions();
      } catch (e) {
        console.error('[JobRunner] Failed to collect sessions:', e);
        data.sessions = [];
      }
    }

    return data;
  }

  /**
   * Claude로 처리
   */
  async processWithClaude(job, input, collectedData) {
    const config = job.processing.claude;

    try {
      // 시스템 프롬프트 구성
      let systemPrompt = config.prompt || '';

      // 수집된 데이터 추가
      if (collectedData && Object.keys(collectedData).length > 0) {
        systemPrompt += '\n\n수집된 데이터:';

        if (collectedData.entries?.length > 0) {
          systemPrompt += '\n\n## 오늘 기록\n';
          collectedData.entries.forEach(e => {
            const time = new Date(e.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            systemPrompt += `- ${time}: ${e.text}\n`;
          });
        }

        if (collectedData.sessions?.length > 0) {
          systemPrompt += '\n\n## Claude 세션\n';
          collectedData.sessions.forEach(s => {
            systemPrompt += `- ${s.summary || s.firstPrompt?.substring(0, 50)}\n`;
          });
        }
      }

      // Claude 호출
      const response = await this.claudeCode.ask(input || '정리해주세요', {
        system: systemPrompt
      });

      return response;

    } catch (error) {
      console.error('[JobRunner] Claude processing failed:', error);
      return input; // 실패 시 원본 반환
    }
  }

  /**
   * 결과 저장
   */
  async saveOutput(job, content, collectedData) {
    if (!job.output) return;

    const target = job.output.target;
    const now = new Date();

    try {
      if (target === 'obsidian-daily') {
        // 시간 포맷팅
        const time = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

        // 포맷 적용
        let formatted = content;
        if (job.output.format) {
          formatted = job.output.format
            .replace('{time}', time)
            .replace('{content}', content);
        }

        // 섹션별 저장
        if (job.output.sections) {
          for (const section of job.output.sections) {
            let sectionContent = '';

            if (section.type === 'summary') {
              sectionContent = content;
            } else if (section.type === 'sessions' && collectedData?.sessions) {
              sectionContent = this.formatSessions(collectedData.sessions);
            }

            await this.obsidianWriter.replaceSection(section.name, sectionContent);
          }
        } else if (job.output.section) {
          await this.obsidianWriter.appendToSection(job.output.section, formatted);
        }

        // store에도 저장
        const today = now.toISOString().split('T')[0];
        const entries = this.store.get(`entries.${today}`, []);
        entries.push({
          time: now.toISOString(),
          text: content,
          jobId: job.id
        });
        this.store.set(`entries.${today}`, entries);
      }
    } catch (error) {
      console.error('[JobRunner] Failed to save output:', error);
    }
  }

  /**
   * 세션 포맷팅
   */
  formatSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      return '_오늘 Claude Code 세션이 없습니다._';
    }

    const lines = [`세션 수: ${sessions.length}개\n`];

    // 프로젝트별 그룹핑
    const byProject = {};
    for (const s of sessions) {
      const project = s.projectDir?.split('-').pop() || 'default';
      if (!byProject[project]) byProject[project] = [];
      byProject[project].push(s);
    }

    for (const [project, projectSessions] of Object.entries(byProject)) {
      lines.push(`### ${project}`);
      for (const s of projectSessions) {
        lines.push(`- ${s.summary || s.firstPrompt?.substring(0, 50) || '(제목 없음)'}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 수동 실행
   */
  async runJob(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) {
      await this.executeJob(job);
    } else {
      throw new Error(`Job not found: ${jobId}`);
    }
  }

  /**
   * 중지
   */
  stop() {
    this.scheduledJobs.forEach(task => task.stop());
    this.scheduledJobs.clear();
    console.log('[JobRunner] Stopped');
  }
}

module.exports = { InteractiveJobRunner };
