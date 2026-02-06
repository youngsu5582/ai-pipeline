const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

/**
 * Obsidian Daily Note 저장
 * settings.yaml 설정을 기반으로 Daily Note에 내용 추가
 */
class ObsidianWriter {
  constructor(options = {}) {
    this.config = this.loadConfig();
    this.vaultPath = this.expandPath(this.config?.vault?.path || '~/Documents/Obsidian');
    this.dailyFolder = this.config?.vault?.daily_folder || 'DAILY';
  }

  /**
   * 설정 파일 로드
   */
  loadConfig() {
    const configPaths = [
      path.join(__dirname, '../../../config/settings.local.yaml'),
      path.join(__dirname, '../../../config/settings.yaml'),
      path.join(__dirname, '../../../config/settings.example.yaml')
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          return yaml.load(content);
        }
      } catch (e) {
        console.warn(`[ObsidianWriter] Failed to load config from ${configPath}`);
      }
    }

    return {};
  }

  /**
   * 경로 확장 (~를 홈 디렉토리로)
   */
  expandPath(p) {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }

  /**
   * Daily Note 경로 가져오기
   */
  getDailyNotePath(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return path.join(this.vaultPath, this.dailyFolder, `${targetDate}.md`);
  }

  /**
   * Daily Note 존재 확인 및 생성
   */
  ensureDailyNote(date = null) {
    const dailyPath = this.getDailyNotePath(date);
    const dirPath = path.dirname(dailyPath);

    // 디렉토리 생성
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // 파일이 없으면 기본 템플릿으로 생성
    if (!fs.existsSync(dailyPath)) {
      const template = this.createDailyNoteTemplate(date);
      fs.writeFileSync(dailyPath, template, 'utf8');
      console.log(`[ObsidianWriter] Created daily note: ${dailyPath}`);
    }

    return dailyPath;
  }

  /**
   * Daily Note 템플릿 생성
   */
  createDailyNoteTemplate(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const d = new Date(targetDate);
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    const weekday = weekdays[d.getDay()];

    // 어제 날짜
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    return `---
date: ${targetDate}
weekday: ${weekday}요일
---

# ${targetDate} (${weekday})
> 📅 어제: [[${yesterdayStr}]]

## 🎯 오늘의 Focus
<!-- 오늘 집중할 핵심 과제 1-2개 -->
-

## 📋 할 일
<!-- 오늘 해야 할 구체적인 태스크 -->
- [ ]

## 🤔 고민거리
<!-- 현재 막혀있거나 결정이 필요한 것들 -->

## 📝 오늘의 생각
<!-- 하루 중 떠오르는 생각, 인사이트 -->

## ⏰ 시간별 메모
<!-- 자동 기록 -->

## ✅ 오늘 한 일
<!-- 퇴근 전에 정리 -->

## 🤖 Claude 세션 요약
<!-- 자동 기록 -->
`;
  }

  /**
   * 섹션에 내용 추가 (append)
   */
  async appendToSection(sectionHeader, content, date = null) {
    const dailyPath = this.ensureDailyNote(date);
    let fileContent = fs.readFileSync(dailyPath, 'utf8');

    // 섹션 찾기
    const sectionRegex = new RegExp(
      `(${this.escapeRegex(sectionHeader)}[^\n]*\n)`,
      'i'
    );

    if (sectionRegex.test(fileContent)) {
      // 섹션 바로 다음에 추가
      fileContent = fileContent.replace(sectionRegex, `$1${content}\n`);
    } else {
      // 섹션이 없으면 파일 끝에 추가
      fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
    }

    fs.writeFileSync(dailyPath, fileContent, 'utf8');
    console.log(`[ObsidianWriter] Appended to ${sectionHeader}`);
  }

  /**
   * 섹션 내용 교체 (replace)
   */
  async replaceSection(sectionHeader, newContent, date = null) {
    const dailyPath = this.ensureDailyNote(date);
    let fileContent = fs.readFileSync(dailyPath, 'utf8');

    // 섹션 전체 교체 (다음 ## 전까지)
    const pattern = new RegExp(
      `${this.escapeRegex(sectionHeader)}[^\n]*\n[\\s\\S]*?(?=\n## |$)`,
      'i'
    );

    if (pattern.test(fileContent)) {
      fileContent = fileContent.replace(
        pattern,
        `${sectionHeader}\n${newContent}\n`
      );
    } else {
      // 섹션이 없으면 파일 끝에 추가
      fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${newContent}\n`;
    }

    fs.writeFileSync(dailyPath, fileContent, 'utf8');
    console.log(`[ObsidianWriter] Replaced ${sectionHeader}`);
  }

  /**
   * 시간별 기록 추가
   */
  async appendHourlyEntry(text, time = null) {
    const now = time || new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const entry = `- \`${timeStr}\` ${text}`;

    await this.appendToSection('## ⏰ 시간별 메모', entry);
  }

  /**
   * 일일 요약 업데이트
   */
  async updateDailySummary(summaryContent) {
    await this.replaceSection('## ✅ 오늘 한 일', summaryContent);
  }

  /**
   * Claude 세션 섹션 업데이트
   */
  async updateClaudeSessions(sessionContent) {
    await this.replaceSection('## 🤖 Claude 세션 요약', sessionContent);
  }

  /**
   * 정규식 이스케이프
   */
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = { ObsidianWriter };
