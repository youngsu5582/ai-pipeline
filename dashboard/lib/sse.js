'use strict';

const { taskQueue, sseClients, runningTaskProcesses } = require('./state');

function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function sendSSEEvent(clientId, event, data) {
  if (clientId && sseClients.has(clientId)) {
    const res = sseClients.get(clientId);
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('[SSE] 전송 오류:', err.message);
      sseClients.delete(clientId);
    }
  } else {
    // 브로드캐스트
    sseClients.forEach((res, cid) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        sseClients.delete(cid);
      }
    });
  }
}

function updateTaskProgress(task, progress, message) {
  task.progress = progress;
  task.progressMessage = message;
  sendSSEEvent(task.clientId, 'task:progress', {
    taskId: task.id,
    progress,
    message
  });
}

module.exports = { generateTaskId, sendSSEEvent, updateTaskProgress };
