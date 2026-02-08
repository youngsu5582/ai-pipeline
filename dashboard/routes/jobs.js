'use strict';

const express = require('express');
const cron = require('node-cron');
const router = express.Router();

const state = require('../lib/state');
const { executeJob, buildCommand, getSystemOptions, getDefaultOptionsFromJob } = require('../lib/executor');
const { scheduleJob } = require('../lib/scheduler');

// Get all jobs
router.get('/', (req, res) => {
  const data = state.loadJobs();
  const jobsWithStatus = data.jobs.map(job => ({
    ...job,
    isScheduled: !!state.scheduledJobs[job.id],
    isRunning: !!state.runningJobs[job.id]
  }));
  res.json({ ...data, jobs: jobsWithStatus, edges: data.edges || [] });
});

// Get live log
router.get('/:id/live-log', (req, res) => {
  const jobId = req.params.id;
  const running = state.runningJobs[jobId];
  if (running) {
    return res.json({
      running: true, logId: running.logId, stdout: running.stdout, stderr: running.stderr,
      elapsed: Date.now() - running.startTime.getTime(), command: running.command
    });
  }
  const lastLog = [...state.jobHistory].reverse().find(h => h.jobId === jobId);
  if (lastLog) {
    return res.json({
      running: false, logId: lastLog.id, stdout: lastLog.stdout || '', stderr: lastLog.stderr || '',
      error: lastLog.error || '', status: lastLog.status, duration: lastLog.duration, command: lastLog.command || ''
    });
  }
  res.json({ running: false, stdout: '', stderr: '' });
});

// Get single job
router.get('/:id', (req, res) => {
  const { jobs } = state.loadJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ...job, isScheduled: !!state.scheduledJobs[job.id] });
});

// Create job
router.post('/', (req, res) => {
  const data = state.loadJobs();
  const newJob = {
    id: req.body.id || `job-${Date.now()}`,
    name: req.body.name, description: req.body.description || '',
    command: req.body.command, schedule: req.body.schedule || '0 * * * *',
    enabled: req.body.enabled ?? false, category: req.body.category || 'custom',
    tags: req.body.tags || []
  };
  if (!cron.validate(newJob.schedule)) return res.status(400).json({ error: 'Invalid cron expression' });
  data.jobs.push(newJob);
  state.saveJobs(data);
  if (newJob.enabled) scheduleJob(newJob);
  res.status(201).json(newJob);
});

// Update job
router.put('/:id', (req, res) => {
  const data = state.loadJobs();
  const index = data.jobs.findIndex(j => j.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Job not found' });
  if (req.body.schedule && !cron.validate(req.body.schedule)) return res.status(400).json({ error: 'Invalid cron expression' });
  const updatedJob = { ...data.jobs[index], ...req.body };
  data.jobs[index] = updatedJob;
  state.saveJobs(data);
  if (state.scheduledJobs[updatedJob.id]) { state.scheduledJobs[updatedJob.id].stop(); delete state.scheduledJobs[updatedJob.id]; }
  if (updatedJob.enabled) scheduleJob(updatedJob);
  res.json(updatedJob);
});

// Delete job
router.delete('/:id', (req, res) => {
  const data = state.loadJobs();
  const index = data.jobs.findIndex(j => j.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Job not found' });
  if (state.scheduledJobs[req.params.id]) { state.scheduledJobs[req.params.id].stop(); delete state.scheduledJobs[req.params.id]; }
  data.jobs.splice(index, 1);
  state.saveJobs(data);
  res.json({ success: true });
});

// Duplicate job
router.post('/:id/duplicate', (req, res) => {
  const data = state.loadJobs();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const newId = `job-${Date.now()}`;
  const duplicatedJob = {
    ...JSON.parse(JSON.stringify(job)), id: newId, name: `${job.name} (복사본)`, enabled: false,
    position: job.position ? { x: (job.position.x || 0) + 50, y: (job.position.y || 0) + 50 } : undefined
  };
  data.jobs.push(duplicatedJob);
  state.saveJobs(data);
  res.json({ success: true, newId, job: duplicatedJob });
});

// Run job
router.post('/:id/run', async (req, res) => {
  const { jobs } = state.loadJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  try {
    const options = req.body.options || {};
    const result = await executeJob(job, 'manual', options);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle job
router.post('/:id/toggle', (req, res) => {
  const data = state.loadJobs();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.enabled = !job.enabled;
  state.saveJobs(data);
  if (job.enabled) { scheduleJob(job); }
  else if (state.scheduledJobs[job.id]) { state.scheduledJobs[job.id].stop(); delete state.scheduledJobs[job.id]; }
  res.json({ enabled: job.enabled });
});

// Schedule one-time
router.post('/:id/schedule-once', (req, res) => {
  const { jobs } = state.loadJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { scheduledTime } = req.body;
  if (!scheduledTime) return res.status(400).json({ error: 'scheduledTime required' });
  const targetTime = new Date(scheduledTime);
  const delay = targetTime.getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: 'Scheduled time must be in the future' });
  if (state.scheduledOnceJobs[job.id]) {
    clearTimeout(state.scheduledOnceJobs[job.id]);
    console.log(`[Schedule] Cancelled previous schedule for ${job.name}`);
  }
  state.scheduledOnceJobs[job.id] = setTimeout(() => {
    console.log(`[Schedule] Executing one-time scheduled job: ${job.name}`);
    const defaultOptions = getDefaultOptionsFromJob(job);
    executeJob(job, 'scheduled-once', defaultOptions).catch(err => console.error(`[Schedule] ${job.name} 실패:`, err.message));
    delete state.scheduledOnceJobs[job.id];
  }, delay);
  console.log(`[Schedule] ${job.name} scheduled for ${targetTime.toISOString()} (in ${Math.round(delay/1000)}s)`);
  res.json({ success: true, scheduledFor: targetTime.toISOString(), delayMs: delay });
});

// Save positions
router.post('/positions', (req, res) => {
  const { positions } = req.body;
  if (!positions || !Array.isArray(positions)) return res.status(400).json({ error: 'positions array is required' });
  const data = state.loadJobs();
  positions.forEach(({ id, position }) => {
    const job = data.jobs.find(j => j.id === id);
    if (job && position) job.position = { x: position.x, y: position.y };
  });
  state.saveJobs(data);
  res.json({ success: true, updated: positions.length });
});

// --- Edge routes ---
router.get('/edges', (req, res) => {
  const data = state.loadJobs();
  res.json(data.edges || []);
});

router.post('/edges', (req, res) => {
  const { from, to, label, trigger, onSuccess } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const data = state.loadJobs();
  if (!data.edges) data.edges = [];
  const existing = data.edges.find(e => e.from === from && e.to === to);
  if (existing) return res.status(400).json({ error: 'Edge already exists' });
  const fromJob = data.jobs.find(j => j.id === from);
  const toJob = data.jobs.find(j => j.id === to);
  if (!fromJob || !toJob) return res.status(404).json({ error: 'One or both jobs not found' });
  const newEdge = {
    id: `edge-${Date.now()}`, from, to, label: label || '',
    trigger: trigger ?? false, onSuccess: onSuccess ?? true, condition: req.body.condition || null
  };
  if (newEdge.condition) { newEdge.trigger = true; newEdge.onSuccess = newEdge.condition.type === 'onSuccess'; }
  data.edges.push(newEdge);
  state.saveJobs(data);
  res.status(201).json(newEdge);
});

router.put('/edges/:id', (req, res) => {
  const data = state.loadJobs();
  if (!data.edges) return res.status(404).json({ error: 'Edge not found' });
  const index = data.edges.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Edge not found' });
  const { label, trigger, onSuccess, condition } = req.body;
  if (label !== undefined) data.edges[index].label = label;
  if (trigger !== undefined) data.edges[index].trigger = trigger;
  if (onSuccess !== undefined) data.edges[index].onSuccess = onSuccess;
  if (condition !== undefined) {
    data.edges[index].condition = condition;
    if (condition) { data.edges[index].trigger = true; data.edges[index].onSuccess = condition.type === 'onSuccess'; }
  }
  state.saveJobs(data);
  res.json(data.edges[index]);
});

router.delete('/edges/:id', (req, res) => {
  const data = state.loadJobs();
  if (!data.edges) return res.status(404).json({ error: 'Edge not found' });
  const index = data.edges.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Edge not found' });
  data.edges.splice(index, 1);
  state.saveJobs(data);
  res.json({ success: true });
});

module.exports = router;
