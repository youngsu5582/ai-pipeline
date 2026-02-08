'use strict';

const express = require('express');
const router = express.Router();
const state = require('../lib/state');

function convertToCSV(data, columns) {
  if (!data || data.length === 0) return '';
  const header = columns.join(',');
  const rows = data.map(item =>
    columns.map(col => {
      let val = item[col];
      if (val === null || val === undefined) val = '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

// Summary stats
router.get('/summary', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const recentHistory = state.jobHistory.filter(h => new Date(h.startTime) >= cutoff);
  const total = recentHistory.length;
  const success = recentHistory.filter(h => h.status === 'success').length;
  const failed = recentHistory.filter(h => h.status === 'failed').length;
  const running = recentHistory.filter(h => h.status === 'running').length;
  const successfulJobs = recentHistory.filter(h => h.status === 'success' && h.duration);
  const avgDuration = successfulJobs.length > 0
    ? Math.round(successfulJobs.reduce((sum, h) => sum + h.duration, 0) / successfulJobs.length) : 0;
  const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
  res.json({ period: `${days} days`, total, success, failed, running, successRate, avgDuration, avgDurationFormatted: `${(avgDuration / 1000).toFixed(1)}s` });
});

// Per-job stats
router.get('/jobs', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const recentHistory = state.jobHistory.filter(h => new Date(h.startTime) >= cutoff);
  const jobStats = {};
  for (const entry of recentHistory) {
    if (!jobStats[entry.jobId]) {
      jobStats[entry.jobId] = { jobId: entry.jobId, jobName: entry.jobName, total: 0, success: 0, failed: 0, totalDuration: 0, lastRun: null };
    }
    const stat = jobStats[entry.jobId];
    stat.total++;
    if (entry.status === 'success') stat.success++;
    if (entry.status === 'failed') stat.failed++;
    if (entry.duration) stat.totalDuration += entry.duration;
    if (!stat.lastRun || new Date(entry.startTime) > new Date(stat.lastRun)) stat.lastRun = entry.startTime;
  }
  const stats = Object.values(jobStats).map(s => ({
    ...s, successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0,
    avgDuration: s.total > 0 ? Math.round(s.totalDuration / s.total) : 0
  }));
  stats.sort((a, b) => b.total - a.total);
  res.json(stats);
});

// Daily trend
router.get('/trend', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    trend.push({ date: state.getKSTDateString(date), success: 0, failed: 0, total: 0 });
  }
  for (const entry of state.jobHistory) {
    const entryDate = entry.startTime.split('T')[0];
    const dayData = trend.find(d => d.date === entryDate);
    if (dayData) {
      dayData.total++;
      if (entry.status === 'success') dayData.success++;
      if (entry.status === 'failed') dayData.failed++;
    }
  }
  res.json(trend);
});

// Hourly distribution
router.get('/hourly', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
  for (const entry of state.jobHistory) {
    if (new Date(entry.startTime) < cutoff) continue;
    const hour = new Date(entry.startTime).getHours();
    hourly[hour].count++;
  }
  res.json(hourly);
});

// Top failures
router.get('/failures', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const limit = parseInt(req.query.limit) || 5;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const recentHistory = state.jobHistory.filter(h => new Date(h.startTime) >= cutoff && h.status === 'failed');
  const failureCounts = {};
  for (const entry of recentHistory) {
    if (!failureCounts[entry.jobId]) {
      failureCounts[entry.jobId] = { jobId: entry.jobId, jobName: entry.jobName, count: 0, lastFailure: null, lastError: null };
    }
    failureCounts[entry.jobId].count++;
    if (!failureCounts[entry.jobId].lastFailure || new Date(entry.startTime) > new Date(failureCounts[entry.jobId].lastFailure)) {
      failureCounts[entry.jobId].lastFailure = entry.startTime;
      failureCounts[entry.jobId].lastError = entry.error || entry.stderr?.substring(0, 200);
    }
  }
  const top = Object.values(failureCounts).sort((a, b) => b.count - a.count).slice(0, limit);
  res.json(top);
});

// --- History ---
router.get('/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const jobId = req.query.jobId;
  const search = req.query.search;
  const status = req.query.status;
  const startDate = req.query.startDate;
  const endDate = req.query.endDate;

  let history = [...state.jobHistory].reverse();
  if (jobId) history = history.filter(h => h.jobId === jobId);
  if (search) { const s = search.toLowerCase(); history = history.filter(h => h.jobName.toLowerCase().includes(s)); }
  if (status) history = history.filter(h => h.status === status);
  if (startDate) { const start = new Date(startDate); start.setHours(0,0,0,0); history = history.filter(h => new Date(h.startTime) >= start); }
  if (endDate) { const end = new Date(endDate); end.setHours(23,59,59,999); history = history.filter(h => new Date(h.startTime) <= end); }

  const total = history.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = history.slice(offset, offset + limit);
  res.json({ items, pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 } });
});

// --- Categories ---
router.get('/categories', (req, res) => {
  const { categories } = state.loadJobs();
  res.json(categories);
});

// --- Validate cron ---
router.post('/validate-cron', (req, res) => {
  const cron = require('node-cron');
  const { expression } = req.body;
  res.json({ valid: cron.validate(expression) });
});

// --- Health ---
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), scheduledJobs: Object.keys(state.scheduledJobs).length });
});

// --- Export ---
router.get('/export/history', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const format = req.query.format || 'json';
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  let data = state.jobHistory.filter(h => new Date(h.startTime) >= cutoff);
  if (format === 'csv') {
    const csv = convertToCSV(data, ['id','jobId','jobName','trigger','status','startTime','endTime','duration','error']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=history_${days}days.csv`);
    return res.send(csv);
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=history_${days}days.json`);
  res.json(data);
});

router.get('/export/stats', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const format = req.query.format || 'json';
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const recentHistory = state.jobHistory.filter(h => new Date(h.startTime) >= cutoff);
  const jobStats = {};
  for (const entry of recentHistory) {
    if (!jobStats[entry.jobId]) { jobStats[entry.jobId] = { jobId: entry.jobId, jobName: entry.jobName, total: 0, success: 0, failed: 0, totalDuration: 0 }; }
    const stat = jobStats[entry.jobId]; stat.total++;
    if (entry.status === 'success') stat.success++;
    if (entry.status === 'failed') stat.failed++;
    if (entry.duration) stat.totalDuration += entry.duration;
  }
  const stats = Object.values(jobStats).map(s => ({ ...s, successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0, avgDuration: s.total > 0 ? Math.round(s.totalDuration / s.total) : 0 }));
  if (format === 'csv') {
    const csv = convertToCSV(stats, ['jobId','jobName','total','success','failed','successRate','avgDuration']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=stats_${days}days.csv`);
    return res.send(csv);
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=stats_${days}days.json`);
  res.json(stats);
});

router.get('/export/jobs', (req, res) => {
  const data = state.loadJobs();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=jobs.json');
  res.json(data);
});

module.exports = router;
