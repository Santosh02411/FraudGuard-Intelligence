/** Public surface of the Cognee integration. Nothing in the fraud-scoring path imports this. */
const client = require('./client');
const syncService = require('./syncService');
const queryService = require('./queryService');

module.exports = {
  configured: client.isConfigured,
  CogneeError: client.CogneeError,
  SyncBusyError: syncService.SyncBusyError,
  runSync: syncService.runSync,
  recentRuns: syncService.recentRuns,
  startScheduler: syncService.startScheduler,
  stopScheduler: syncService.stopScheduler,
  ...queryService,
};
