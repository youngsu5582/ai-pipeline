'use strict';

const https = require('https');
const http = require('http');
const { getSettingValue, loadJobs } = require('./state');
const { sendSSEEvent } = require('./sse');

let DASHBOARD_URL;

function getDashboardUrl() {
  if (!DASHBOARD_URL) {
    DASHBOARD_URL = require('./state').dashboardUrl;
  }
  return getSettingValue('dashboardUrl', require('./state').dashboardUrl);
}

function sendSlackNotification(job, status, result = {}, overrideWebhookUrl = null) {
  const webhookUrl = overrideWebhookUrl || getSettingValue('slackWebhookUrl', '') || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[Slack] Webhook URL 없음 - 알림 스킵');
    return Promise.resolve();
  }

  const dashboardUrl = getDashboardUrl();
  const emoji = status === 'success' ? '✅' : '❌';
  const statusText = status === 'success' ? '성공' : '실패';
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}초` : '-';

  const message = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${job.name} - ${statusText}`, emoji: true }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*작업:*\n${job.name}` },
          { type: "mrkdwn", text: `*소요 시간:*\n${duration}` }
        ]
      }
    ]
  };

  if (status === 'failed') {
    if (result.stdout) {
      const stdoutSummary = result.stdout.trim().substring(0, 800);
      message.blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*출력 (stdout):*\n\`\`\`${stdoutSummary}${result.stdout.length > 800 ? '...' : ''}\`\`\`` }
      });
    }
    if (result.stderr) {
      const stderrSummary = result.stderr.trim().substring(0, 500);
      message.blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*에러 (stderr):*\n\`\`\`${stderrSummary}${result.stderr.length > 500 ? '...' : ''}\`\`\`` }
      });
    }
    if (result.error) {
      message.blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `\`${result.error}\`` }]
      });
    }
  }

  if (status === 'success' && result.stdout) {
    const summary = result.stdout.substring(0, 500).trim();
    if (summary) {
      message.blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*출력:*\n\`\`\`${summary}${result.stdout.length > 500 ? '...' : ''}\`\`\`` }
      });
    }
  }

  if (result.logId) {
    message.blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "📋 상세 보기", emoji: true },
        url: `${dashboardUrl}?tab=history&logId=${result.logId}`,
        action_id: "view_detail"
      }]
    });
  }

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = protocol.request(options, (res) => {
      if (res.statusCode === 200) {
        console.log(`[Slack] 알림 전송 완료: ${job.name}`);
        resolve();
      } else {
        console.error(`[Slack] 알림 실패: ${res.statusCode}`);
        reject(new Error(`Slack API error: ${res.statusCode}`));
      }
    });
    req.on('error', (error) => {
      console.error('[Slack] 전송 오류:', error.message);
      reject(error);
    });
    req.write(JSON.stringify(message));
    req.end();
  });
}

function sendDiscordNotification(job, status, result = {}, webhookUrl) {
  if (!webhookUrl) return Promise.resolve();

  const color = status === 'success' ? 0x10b981 : 0xef4444;
  const emoji = status === 'success' ? '✅' : '❌';
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}초` : '-';
  const dashboardUrl = getDashboardUrl();

  const embed = {
    title: `${emoji} ${job.name} - ${status === 'success' ? '성공' : '실패'}`,
    color,
    fields: [
      { name: '작업', value: job.name, inline: true },
      { name: '소요 시간', value: duration, inline: true },
      { name: '트리거', value: result.trigger || 'manual', inline: true }
    ],
    timestamp: new Date().toISOString()
  };

  if (status === 'failed' && result.stderr) {
    embed.description = '```' + result.stderr.substring(0, 500) + '```';
  }
  if (result.logId) {
    embed.url = `${dashboardUrl}?tab=history&logId=${result.logId}`;
  }

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = protocol.request(options, (res) => {
      res.statusCode < 300 ? resolve() : reject(new Error(`Discord API error: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ embeds: [embed] }));
    req.end();
  });
}

async function sendNotification(event, data) {
  const jobsData = loadJobs();
  const settings = jobsData.settings || {};
  const notifications = settings.notifications;
  if (!notifications) return;

  const channels = notifications.channels || [];
  const rules = notifications.rules || [];

  const matchingRules = rules.filter(r => r.event === event);
  for (const rule of matchingRules) {
    if (rule.filter?.category && data.job?.category !== rule.filter.category) continue;
    if (rule.filter?.jobId && data.job?.id !== rule.filter.jobId) continue;

    for (const channelId of rule.channels) {
      const channel = channels.find(c => c.id === channelId && c.enabled);
      if (!channel) continue;

      try {
        switch (channel.type) {
          case 'slack':
            await sendSlackNotification(data.job, data.status, data.result, channel.webhookUrl);
            break;
          case 'discord':
            await sendDiscordNotification(data.job, data.status, data.result, channel.webhookUrl);
            break;
          case 'native':
            sendSSEEvent('notification', {
              title: `${data.status === 'success' ? '✅' : '❌'} ${data.job.name}`,
              body: event,
              status: data.status
            });
            break;
        }
      } catch (err) {
        console.error(`[Notify] ${channel.id} 전송 실패:`, err.message);
      }
    }
  }
}

module.exports = {
  sendSlackNotification,
  sendDiscordNotification,
  sendNotification,
};
