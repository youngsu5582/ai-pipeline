'use strict';

const { loadJobs } = require('./state');

function evaluateEdgeCondition(edge, status, logEntry, exitCode) {
  if (edge.condition) {
    const cond = edge.condition;
    switch (cond.type) {
      case 'onSuccess': return status === 'success';
      case 'onFailure': return status === 'failed';
      case 'always': return true;
      case 'onOutput':
        if (!logEntry?.stdout) return false;
        if (cond.matchType === 'regex') {
          try { return new RegExp(cond.pattern).test(logEntry.stdout); }
          catch (e) { return false; }
        }
        return logEntry.stdout.includes(cond.pattern || '');
      case 'onExitCode':
        return exitCode === cond.code;
      default: return false;
    }
  }
  if (!edge.trigger) return false;
  return edge.onSuccess === false || status === 'success';
}

function triggerNextJobs(jobId, status, prevLog, depth = 0) {
  if (depth > 10) {
    console.error(`[Chain] Max depth (10) exceeded for job ${jobId}`);
    return;
  }

  const data = loadJobs();
  const edges = data.edges || [];
  const exitCode = prevLog?.exitCode ?? (status === 'success' ? 0 : 1);

  const triggerEdges = edges.filter(e =>
    e.from === jobId && evaluateEdgeCondition(e, status, prevLog, exitCode)
  );

  if (triggerEdges.length === 0) return;

  console.log(`[Chain] ${jobId} completed (${status}), triggering ${triggerEdges.length} job(s)`);

  // Lazy require to avoid circular dependency
  const { executeJob, getDefaultOptionsFromJob } = require('./executor');

  for (const edge of triggerEdges) {
    const nextJob = data.jobs.find(j => j.id === edge.to);
    if (!nextJob) {
      console.warn(`[Chain] Target job ${edge.to} not found`);
      continue;
    }

    const condLabel = edge.condition?.type || 'legacy';
    console.log(`[Chain] Starting: ${nextJob.name} (condition: ${condLabel})`);

    const defaultOptions = getDefaultOptionsFromJob(nextJob);
    executeJob(nextJob, 'chained', defaultOptions, depth + 1)
      .catch(err => console.error(`[Chain] Failed to execute ${nextJob.id}:`, err.message));
  }
}

module.exports = { evaluateEdgeCondition, triggerNextJobs };
