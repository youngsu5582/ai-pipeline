const { exec, spawn } = require('child_process');
const path = require('path');

/**
 * Claude Code CLI 연동
 * `claude --print` 명령어로 Claude와 대화
 */
class ClaudeCode {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000; // 1분 타임아웃
    this.maxBuffer = options.maxBuffer || 1024 * 1024 * 10; // 10MB
  }

  /**
   * Claude에게 질문
   * @param {string} prompt - 질문 내용
   * @param {Object} options - 옵션
   * @param {string} options.system - 시스템 프롬프트
   * @returns {Promise<string>} - 응답
   */
  async ask(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      // 명령어 구성
      const args = ['--print'];

      // 시스템 프롬프트
      if (options.system) {
        args.push('--system-prompt', options.system);
      }

      // 프롬프트 추가
      args.push(prompt);

      // Claude CLI 실행
      const command = 'claude';

      console.log(`[ClaudeCode] Executing: claude ${args.slice(0, 2).join(' ')}...`);

      exec(
        `${command} ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`,
        {
          maxBuffer: this.maxBuffer,
          timeout: this.timeout,
          encoding: 'utf8',
          shell: true,
          env: {
            ...process.env,
            TERM: 'dumb' // 색상 코드 비활성화
          }
        },
        (error, stdout, stderr) => {
          if (error) {
            // 타임아웃
            if (error.killed) {
              reject(new Error('Claude 응답 시간 초과'));
              return;
            }

            // Claude Code가 설치되어 있지 않은 경우
            if (error.message.includes('not found') || error.message.includes('ENOENT')) {
              reject(new Error('Claude Code CLI가 설치되어 있지 않습니다. npm install -g @anthropic-ai/claude-code'));
              return;
            }

            console.error('[ClaudeCode] Error:', error.message);
            reject(error);
            return;
          }

          // 응답 정리 (ANSI 코드 제거)
          const cleanOutput = this.cleanOutput(stdout);
          resolve(cleanOutput);
        }
      );
    });
  }

  /**
   * 간단한 포맷팅 요청
   * @param {string} text - 포맷팅할 텍스트
   * @returns {Promise<string>} - 포맷팅된 텍스트
   */
  async formatEntry(text) {
    const systemPrompt = `당신은 Daily Note를 작성하는 비서입니다.
사용자의 입력을 Daily Note에 기록할 형태로 간단히 정리해주세요.

규칙:
- 이모지 한 개를 앞에 붙여주세요
- 한 줄로 간결하게 정리해주세요
- 핵심 내용만 유지하세요
- 말투는 자연스럽게 (예: "~했음", "~중")`;

    try {
      const response = await this.ask(text, { system: systemPrompt });
      return response.trim();
    } catch (error) {
      console.error('[ClaudeCode] formatEntry failed:', error);
      // 실패 시 원본 반환 (이모지 추가)
      return `📝 ${text}`;
    }
  }

  /**
   * 일일 요약 생성
   * @param {Array} entries - 오늘 기록들
   * @param {Array} sessions - Claude 세션들
   * @returns {Promise<string>} - 요약
   */
  async generateDailySummary(entries, sessions) {
    const systemPrompt = `당신은 하루를 정리하는 비서입니다.
오늘 하루의 기록과 Claude 세션을 바탕으로 일일 요약을 작성해주세요.

요청사항:
1. "오늘 한 일" 섹션용 요약 (불렛 3-5개)
2. "오늘의 인사이트" 한 문장
3. 전체적인 하루 평가 (이모지 + 한 줄)

친근하고 따뜻한 톤으로 작성해주세요.`;

    const prompt = `오늘 하루 기록을 정리해주세요.

## 시간별 메모
${entries.map(e => {
  const time = new Date(e.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return `- ${time}: ${e.text}`;
}).join('\n') || '(기록 없음)'}

## Claude 세션
${sessions.map(s => `- ${s.summary || s.firstPrompt?.substring(0, 50) || '(제목 없음)'}`).join('\n') || '(세션 없음)'}

위 내용을 바탕으로 일일 요약을 작성해주세요.`;

    try {
      const response = await this.ask(prompt, { system: systemPrompt });
      return response;
    } catch (error) {
      console.error('[ClaudeCode] generateDailySummary failed:', error);
      // 실패 시 기본 요약
      return `## 오늘 한 일
- 기록 ${entries.length}개
- Claude 세션 ${sessions.length}개

_요약 생성에 실패했습니다._`;
    }
  }

  /**
   * 출력 정리 (ANSI 코드 제거)
   */
  cleanOutput(text) {
    if (!text) return '';

    return text
      // ANSI 이스케이프 코드 제거
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
      // 캐리지 리턴 정리
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // 연속 줄바꿈 정리
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Claude Code 설치 확인
   */
  async checkInstalled() {
    return new Promise((resolve) => {
      exec('claude --version', (error) => {
        resolve(!error);
      });
    });
  }
}

module.exports = { ClaudeCode };
