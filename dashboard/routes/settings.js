'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const state = require('../lib/state');
const { getObsidianPaths } = require('../lib/obsidian');
const { sendSlackNotification, sendDiscordNotification } = require('../lib/notifications');
const { sendSSEEvent } = require('../lib/sse');
const { executeJob, getDefaultOptionsFromJob } = require('../lib/executor');
const { initializeJobs } = require('../lib/scheduler');

// Get settings
router.get('/', (req, res) => {
  const data = state.loadJobs();
  const settings = data.settings || {};
  const { vaultPath, dailyFolder } = getObsidianPaths();
  res.json({
    slackWebhookUrl: settings.slackWebhookUrl || '',
    slackEnabled: settings.slackEnabled || false,
    dashboardUrl: settings.dashboardUrl || 'http://localhost:3030',
    refreshInterval: settings.refreshInterval || 5,
    defaultTimeout: settings.defaultTimeout || 10,
    defaultRetry: settings.defaultRetry || 0,
    notifications: settings.notifications || { channels: [], rules: [] },
    obsidianVaultPath: vaultPath,
    obsidianDailyFolder: dailyFolder,
    obsidianMorningFolder: settings.obsidianMorningFolder || 'Morning Plans',
    obsidianReportFolder: settings.obsidianReportFolder || 'Daily Reports',
    obsidianWeeklyFolder: settings.obsidianWeeklyFolder || 'WEEKLY'
  });
});

// Save settings
router.put('/', (req, res) => {
  try {
    const data = state.loadJobs();
    data.settings = {
      ...data.settings,
      slackWebhookUrl: req.body.slackWebhookUrl || '',
      slackEnabled: req.body.slackEnabled || false,
      dashboardUrl: req.body.dashboardUrl || 'http://localhost:3030',
      refreshInterval: req.body.refreshInterval || 5,
      defaultTimeout: req.body.defaultTimeout || 10,
      defaultRetry: req.body.defaultRetry || 0
    };
    if (req.body.notifications !== undefined) data.settings.notifications = req.body.notifications;
    if (req.body.obsidianVaultPath !== undefined) data.settings.obsidianVaultPath = req.body.obsidianVaultPath;
    if (req.body.obsidianDailyFolder !== undefined) data.settings.obsidianDailyFolder = req.body.obsidianDailyFolder;
    if (req.body.obsidianMorningFolder !== undefined) data.settings.obsidianMorningFolder = req.body.obsidianMorningFolder;
    if (req.body.obsidianReportFolder !== undefined) data.settings.obsidianReportFolder = req.body.obsidianReportFolder;
    if (req.body.obsidianWeeklyFolder !== undefined) data.settings.obsidianWeeklyFolder = req.body.obsidianWeeklyFolder;
    state.saveJobs(data);
    if (data.settings.slackWebhookUrl) process.env.SLACK_WEBHOOK_URL = data.settings.slackWebhookUrl;
    if (data.settings.dashboardUrl) state.dashboardUrl = data.settings.dashboardUrl;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook tokens
router.get('/webhook-tokens', (req, res) => {
  const tokens = state.loadWebhookTokens();
  res.json(tokens.map(t => ({ ...t, token: t.token.substring(0, 8) + '...' })));
});

router.post('/webhook-tokens', (req, res) => {
  const { name, allowedJobs } = req.body;
  const tokens = state.loadWebhookTokens();
  const newToken = {
    id: `tok-${Date.now()}`, name: name || '새 토큰',
    token: crypto.randomBytes(32).toString('hex'),
    enabled: true, allowedJobs: allowedJobs || [],
    createdAt: new Date().toISOString(), lastUsedAt: null, usageCount: 0
  };
  tokens.push(newToken);
  state.saveWebhookTokens(tokens);
  res.status(201).json(newToken);
});

router.put('/webhook-tokens/:id', (req, res) => {
  const tokens = state.loadWebhookTokens();
  const token = tokens.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  if (req.body.enabled !== undefined) token.enabled = req.body.enabled;
  if (req.body.name !== undefined) token.name = req.body.name;
  if (req.body.allowedJobs !== undefined) token.allowedJobs = req.body.allowedJobs;
  state.saveWebhookTokens(tokens);
  res.json({ ...token, token: token.token.substring(0, 8) + '...' });
});

router.delete('/webhook-tokens/:id', (req, res) => {
  const tokens = state.loadWebhookTokens();
  const index = tokens.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Token not found' });
  tokens.splice(index, 1);
  state.saveWebhookTokens(tokens);
  res.json({ success: true });
});

// External webhook trigger
router.post('/webhook/:token', (req, res) => {
  const tokens = state.loadWebhookTokens();
  const tokenData = tokens.find(t => t.token === req.params.token && t.enabled);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or disabled token' });
  const { jobId, options } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  const data = state.loadJobs();
  const job = data.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: `Job '${jobId}' not found` });
  if (tokenData.allowedJobs.length > 0 && !tokenData.allowedJobs.includes(jobId)) {
    return res.status(403).json({ error: 'Job not allowed for this token' });
  }
  tokenData.lastUsedAt = new Date().toISOString();
  tokenData.usageCount = (tokenData.usageCount || 0) + 1;
  state.saveWebhookTokens(tokens);
  const defaultOptions = getDefaultOptionsFromJob(job);
  const mergedOptions = { ...defaultOptions, ...(options || {}) };
  executeJob(job, 'webhook', mergedOptions).catch(err => console.error(`[Webhook] Failed to execute ${job.id}:`, err.message));
  res.json({ success: true, message: `Job '${jobId}' triggered via webhook` });
});

// Notification test
router.post('/notifications/test', async (req, res) => {
  const { channel } = req.body;
  if (!channel || !channel.type) return res.status(400).json({ error: 'channel required' });
  const testJob = { name: '테스트 알림', id: 'test', category: 'test' };
  try {
    if (channel.type === 'slack') await sendSlackNotification(testJob, 'success', { duration: 1000 }, channel.webhookUrl);
    else if (channel.type === 'discord') await sendDiscordNotification(testJob, 'success', { duration: 1000 }, channel.webhookUrl);
    else if (channel.type === 'native') sendSSEEvent('notification', { title: '🔔 테스트 알림', body: '알림이 정상 작동합니다.', status: 'success' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export/Import
router.get('/export', (req, res) => { res.json(state.loadJobs()); });

router.post('/import', (req, res) => {
  try {
    const importData = req.body;
    if (!importData.jobs || !Array.isArray(importData.jobs)) return res.status(400).json({ error: 'Invalid data format: jobs array required' });
    Object.keys(state.scheduledJobs).forEach(id => { if (state.scheduledJobs[id]) { state.scheduledJobs[id].stop(); delete state.scheduledJobs[id]; } });
    state.saveJobs(importData);
    initializeJobs();
    res.json({ success: true, jobCount: importData.jobs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Widget layout
router.get('/widget-layout', (req, res) => {
  const layout = state.loadJsonFile(state.DATA_FILES.widgetLayout, null);
  res.json({ layout });
});

router.put('/widget-layout', (req, res) => {
  state.saveJsonFile(state.DATA_FILES.widgetLayout, req.body.layout);
  res.json({ success: true });
});

module.exports = router;
