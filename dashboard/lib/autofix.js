'use strict';

const { spawn } = require('child_process');
const { loadJobs } = require('./state');

const DEFAULT_AUTO_FIX_RULES = [
  {
    id: 'pip-missing',
    name: 'Python 패키지 누락',
    pattern: /(?:No module named|ModuleNotFoundError:.*'(\w+)'|(\w+)가 설치되어 있지 않습니다)/i,
    extractPackage: (match, stdout, stderr) => {
      const pipMatch = (stdout + stderr).match(/pip install\s+(\S+)/i);
      if (pipMatch) return pipMatch[1];
      if (match[1]) return match[1];
      return null;
    },
    fix: (pkg) => `~/ai-pipeline/.venv/bin/pip install ${pkg}`,
    enabled: true
  },
  {
    id: 'npm-missing',
    name: 'NPM 패키지 누락',
    pattern: /Cannot find module '([^']+)'/i,
    extractPackage: (match) => match[1],
    fix: (pkg) => `npm install ${pkg}`,
    enabled: true
  }
];

function getAutoFixRules() {
  const data = loadJobs();
  return data.settings?.autoFixRules || DEFAULT_AUTO_FIX_RULES;
}

function checkAutoFix(stdout, stderr) {
  const rules = getAutoFixRules();
  const combined = (stdout || '') + (stderr || '');

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const match = combined.match(rule.pattern);
    if (match) {
      const pkg = rule.extractPackage ? rule.extractPackage(match, stdout, stderr) : null;
      if (pkg || !rule.extractPackage) {
        return {
          rule,
          package: pkg,
          fixCommand: typeof rule.fix === 'function' ? rule.fix(pkg) : rule.fix
        };
      }
    }
  }
  return null;
}

function runAutoFix(fixCommand) {
  return new Promise((resolve, reject) => {
    console.log(`[AutoFix] 실행: ${fixCommand}`);
    const child = spawn('/bin/zsh', ['-c', fixCommand], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[AutoFix] 성공: ${fixCommand}`);
        resolve({ success: true, stdout, stderr });
      } else {
        console.error(`[AutoFix] 실패 (code: ${code}): ${fixCommand}`);
        reject(new Error(`AutoFix failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

module.exports = {
  DEFAULT_AUTO_FIX_RULES,
  getAutoFixRules,
  checkAutoFix,
  runAutoFix,
};
