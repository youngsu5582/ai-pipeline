'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadJobs, getKSTDateString } = require('./state');

function getObsidianPaths() {
  const yaml = require('js-yaml');

  const jobsData = loadJobs();
  if (jobsData.settings?.obsidianVaultPath) {
    return {
      vaultPath: jobsData.settings.obsidianVaultPath.replace(/^~/, os.homedir()),
      dailyFolder: jobsData.settings.obsidianDailyFolder || 'DAILY'
    };
  }

  const configPaths = [
    path.join(__dirname, '../../config/settings.local.yaml'),
    path.join(__dirname, '../../config/settings.yaml'),
    path.join(__dirname, '../config/settings.yaml')
  ];

  let vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian');
  let dailyFolder = 'DAILY';

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
        if (config?.vault?.path) {
          vaultPath = config.vault.path.replace(/^~/, os.homedir());
        }
        if (config?.vault?.daily_folder) {
          dailyFolder = config.vault.daily_folder;
        }
        break;
      } catch (e) { /* ignore */ }
    }
  }

  return { vaultPath, dailyFolder };
}

function appendToObsidianSection(sectionHeader, content, date) {
  try {
    const { vaultPath, dailyFolder } = getObsidianPaths();
    const targetDate = date || getKSTDateString();
    const dailyNotePath = path.join(vaultPath, dailyFolder, `${targetDate}.md`);

    if (!fs.existsSync(dailyNotePath)) {
      console.log(`[Obsidian] Daily note not found: ${dailyNotePath}`);
      return false;
    }

    let fileContent = fs.readFileSync(dailyNotePath, 'utf8');
    const escSection = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(`(${escSection}[^\n]*\n)`, 'i');

    if (sectionRegex.test(fileContent)) {
      fileContent = fileContent.replace(sectionRegex, `$1${content}\n`);
    } else {
      fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
    }

    fs.writeFileSync(dailyNotePath, fileContent, 'utf8');
    console.log(`[Obsidian] Appended to ${sectionHeader}`);
    return true;
  } catch (e) {
    console.error('[Obsidian] Write failed:', e.message);
    return false;
  }
}

function parseObsidianMemos(targetDate) {
  const { vaultPath, dailyFolder } = getObsidianPaths();
  const dailyNotePath = path.join(vaultPath, dailyFolder, `${targetDate}.md`);
  if (!fs.existsSync(dailyNotePath)) return [];

  const content = fs.readFileSync(dailyNotePath, 'utf8');
  const memos = [];

  const hourlyMatch = content.match(/## ⏰ 시간별 메모\n([\s\S]*?)(?=\n## |$)/);
  if (hourlyMatch) {
    const lines = hourlyMatch[1].trim().split('\n');
    let currentMemo = null;

    for (const line of lines) {
      const match = line.match(/^- `((?:오[전후]|[AP]M)?\s*\d{1,2}:\d{2})`\s*(.*)$/);
      if (match) {
        if (currentMemo) memos.push(currentMemo);

        const timeStr = match[1].trim();
        const timeDigits = timeStr.match(/(\d{1,2}):(\d{2})/);
        let hour = parseInt(timeDigits[1]);
        const min = timeDigits[2];
        if (/오후|PM/i.test(timeStr) && hour < 12) hour += 12;
        if (/오전|AM/i.test(timeStr) && hour === 12) hour = 0;
        const normalizedTime = `${String(hour).padStart(2, '0')}:${min}`;

        currentMemo = {
          id: `obsidian-${targetDate}-${normalizedTime}-${memos.length}`,
          time: timeStr,
          content: (match[2] || '').trim(),
          timestamp: `${targetDate}T${normalizedTime}:00`,
          source: 'obsidian'
        };
      } else if (currentMemo && line.trim()) {
        currentMemo.content += (currentMemo.content ? '\n' : '') + line.trim();
      }
    }
    if (currentMemo) memos.push(currentMemo);
  }

  return memos;
}

module.exports = { getObsidianPaths, appendToObsidianSection, parseObsidianMemos };
