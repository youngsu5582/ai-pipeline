'use strict';

const cron = require('node-cron');
const state = require('./state');
const { executeJob, getDefaultOptionsFromJob } = require('./executor');

function scheduleJob(job) {
  if (state.scheduledJobs[job.id]) {
    state.scheduledJobs[job.id].stop();
  }

  if (job.enabled && cron.validate(job.schedule)) {
    state.scheduledJobs[job.id] = cron.schedule(job.schedule, () => {
      const defaultOptions = getDefaultOptionsFromJob(job);
      executeJob(job, 'scheduled', defaultOptions)
        .catch(err => console.error(`[Scheduled] ${job.name} 실패:`, err.message));
    });
    console.log(`Scheduled: ${job.name} (${job.schedule})`);
  }
}

function initializeJobs() {
  const { jobs } = state.loadJobs();
  jobs.forEach(job => {
    if (job.enabled) {
      scheduleJob(job);
    }
  });
  console.log(`Initialized ${Object.keys(state.scheduledJobs).length} scheduled jobs`);
}

module.exports = { scheduleJob, initializeJobs };
