'use strict';

const { spawn } = require('child_process');
const { getKSTDateString } = require('./state');

function ghExec(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `gh exit ${code}`)));
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeout);
  });
}

async function getGhAccounts() {
  try {
    await ghExec(['auth', 'status'], 5000);
  } catch (e) { /* gh auth status exits non-zero sometimes */ }

  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'status']);
    let out = '';
    child.stderr.on('data', d => out += d);
    child.stdout.on('data', d => out += d);
    child.on('close', () => {
      const accounts = [];
      const lines = out.split('\n');
      let currentAccount = null;
      for (const line of lines) {
        const loginMatch = line.match(/Logged in to (\S+) account (\S+)/);
        if (loginMatch) {
          currentAccount = { host: loginMatch[1], username: loginMatch[2], active: false };
          accounts.push(currentAccount);
        }
        if (currentAccount && /Active account:\s*true/i.test(line)) {
          currentAccount.active = true;
        }
      }
      resolve(accounts);
    });
  });
}

async function ghExecAs(username, args, timeout = 15000) {
  try {
    await ghExec(['auth', 'switch', '--user', username], 5000);
  } catch (e) { /* ignore */ }
  return ghExec(args, timeout);
}

async function fetchGithubEventsForAccount(username, targetDate) {
  const result = { username, commits: [], prs: [], reviews: [], comments: [] };
  const pushEventRepos = new Set();

  try {
    const raw = await ghExecAs(username, [
      'api', `/users/${username}/events?per_page=100`,
      '--jq', `[.[] | select(.created_at | startswith("${targetDate}"))]`
    ]);

    if (!raw.trim()) return result;
    const events = JSON.parse(raw);

    for (const e of events) {
      const repo = e.repo?.name || '';
      const repoShort = repo.split('/').pop() || repo;
      const time = e.created_at;

      switch (e.type) {
        case 'PushEvent': {
          pushEventRepos.add(repo);
          const commits = e.payload?.commits || [];
          if (commits.length > 0) {
            result.commits.push({
              repo, repoShort, account: username, time,
              count: commits.length,
              messages: commits.map(c => c.message).filter(Boolean),
              shas: commits.map(c => c.sha).filter(Boolean),
              branch: (e.payload?.ref || '').replace('refs/heads/', '')
            });
          }
          break;
        }
        case 'PullRequestEvent': {
          const pr = e.payload?.pull_request || {};
          result.prs.push({
            repo, repoShort, account: username, time,
            action: e.payload?.action,
            number: pr.number || e.payload?.number,
            title: pr.title || `PR #${pr.number || e.payload?.number}`,
            state: pr.state,
            url: pr.html_url
          });
          break;
        }
        case 'PullRequestReviewEvent': {
          const review = e.payload?.review || {};
          const pr = e.payload?.pull_request || {};
          result.reviews.push({
            repo, repoShort, account: username, time,
            state: review.state,
            prNumber: pr.number,
            prTitle: pr.title || `PR #${pr.number}`,
            body: (review.body || '').substring(0, 200)
          });
          break;
        }
        case 'PullRequestReviewCommentEvent': {
          const comment = e.payload?.comment || {};
          const pr = e.payload?.pull_request || {};
          result.comments.push({
            repo, repoShort, account: username, time,
            type: 'review_comment',
            prNumber: pr.number,
            prTitle: pr.title || `PR #${pr.number}`,
            body: (comment.body || '').substring(0, 200),
            path: comment.path
          });
          break;
        }
        case 'IssueCommentEvent': {
          const comment = e.payload?.comment || {};
          const issue = e.payload?.issue || {};
          result.comments.push({
            repo, repoShort, account: username, time,
            type: 'issue_comment',
            issueNumber: issue.number,
            issueTitle: issue.title || `#${issue.number}`,
            body: (comment.body || '').substring(0, 200),
            isPR: !!issue.pull_request
          });
          break;
        }
      }
    }
  } catch (e) {
    console.log(`[GitHub] ${username} 이벤트 조회 실패:`, e.message);
  }

  // PushEvent에 커밋 데이터가 없으면 repos commits API로 폴백
  if (result.commits.length === 0 && pushEventRepos.size > 0) {
    const since = new Date(targetDate + 'T00:00:00+09:00').toISOString();
    const until = new Date(targetDate + 'T23:59:59+09:00').toISOString();
    await Promise.all([...pushEventRepos].slice(0, 5).map(async (repo) => {
      try {
        const raw = await ghExec([
          'api', `/repos/${repo}/commits?author=${username}&since=${since}&until=${until}&per_page=30`,
          '--jq', '[.[] | {sha: .sha, message: .commit.message, date: .commit.author.date, url: .html_url}]'
        ], 10000);
        const commits = JSON.parse(raw.trim() || '[]');
        const repoShort = repo.split('/').pop();
        for (const c of commits) {
          result.commits.push({
            repo, repoShort, account: username, time: c.date,
            sha: c.sha, message: c.message, url: c.url,
            count: 1,
            messages: [c.message].filter(Boolean),
            branch: ''
          });
        }
      } catch (err) {
        console.log(`[GitHub] ${repo} 커밋 조회 실패:`, err.message);
      }
    }));
  }

  // PR 제목 조회
  const prTitleCache = {};
  const prUrlCache = {};
  const needsTitleLookup = new Set();

  const allPrRefs = [
    ...result.prs.map(p => ({ repo: p.repo, number: p.number })),
    ...result.reviews.map(r => ({ repo: r.repo, number: r.prNumber })),
    ...result.comments.filter(c => c.prNumber).map(c => ({ repo: c.repo, number: c.prNumber }))
  ];
  for (const ref of allPrRefs) {
    const key = `${ref.repo}#${ref.number}`;
    if (!prTitleCache[key]) needsTitleLookup.add(key);
  }

  const lookups = [...needsTitleLookup].slice(0, 10);
  await Promise.all(lookups.map(async (key) => {
    const [repo, num] = key.split('#');
    try {
      const raw = await ghExec(['api', `/repos/${repo}/pulls/${num}`, '--jq', '{title: .title, html_url: .html_url}'], 8000);
      const data = JSON.parse(raw.trim());
      prTitleCache[key] = data.title;
      prUrlCache[key] = data.html_url;
    } catch (e) {
      prTitleCache[key] = null;
    }
  }));

  for (const pr of result.prs) {
    const key = `${pr.repo}#${pr.number}`;
    if (prTitleCache[key]) pr.title = prTitleCache[key];
    if (prUrlCache[key]) pr.url = prUrlCache[key];
    if (!pr.url) pr.url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  }
  for (const r of result.reviews) {
    const key = `${r.repo}#${r.prNumber}`;
    if (prTitleCache[key]) r.prTitle = prTitleCache[key];
    r.url = prUrlCache[key] || `https://github.com/${r.repo}/pull/${r.prNumber}`;
  }
  for (const c of result.comments) {
    if (c.prNumber) {
      const key = `${c.repo}#${c.prNumber}`;
      if (prTitleCache[key]) c.prTitle = prTitleCache[key];
      c.url = prUrlCache[key] || `https://github.com/${c.repo}/pull/${c.prNumber}`;
    }
  }

  return result;
}

module.exports = { ghExec, getGhAccounts, ghExecAs, fetchGithubEventsForAccount };
