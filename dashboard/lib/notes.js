'use strict';

const { DATA_FILES, loadJsonFile, saveJsonFile } = require('./state');

function loadQuickMemos() {
  return loadJsonFile(DATA_FILES.quickMemos, []);
}

function saveQuickMemos(memos) {
  saveJsonFile(DATA_FILES.quickMemos, memos);
}

function loadMorningPlans() {
  return loadJsonFile(DATA_FILES.morningPlans, []);
}

function saveMorningPlans(plans) {
  saveJsonFile(DATA_FILES.morningPlans, plans);
}

function loadBacklogs() {
  return loadJsonFile(DATA_FILES.backlogs, []);
}

function saveBacklogs(backlogs) {
  saveJsonFile(DATA_FILES.backlogs, backlogs);
}

module.exports = {
  loadQuickMemos, saveQuickMemos,
  loadMorningPlans, saveMorningPlans,
  loadBacklogs, saveBacklogs,
};
