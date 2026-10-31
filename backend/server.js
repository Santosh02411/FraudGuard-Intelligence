const config = require('./config/env'); // must load first: validates env, fails fast
const http = require('http');
const logger = require('./config/logger');
const { initSchema } = require('./config/schema');
const { initSocketServer } = require('./realtime/socketServer');
const webhookRetryWorker = require('./services/webhookRetryWorker');
const app = require('./app');

// Socket.io needs the raw http.Server (it upgrades HTTP connections to
// WebSocket), so we create one explicitly instead of using app.listen()
// directly — same Express app, same port, one more protocol on top.
const httpServer = http.createServer(app);

// Real-time layer — attaches to the same httpServer/port, authenticated
// over the handshake with the same JWT used for REST (see
// realtime/socketServer.js for rooms/events).
initSocketServer(httpServer);

initSchema()
  .then(async () => {
    // Fresh-deploy demo data (feature: seed script on fresh deploy) —
    // opt-in via SEED_ON_BOOT so this never fires against a real
    // deployment by accident. Runs once: seedIfEmpty() no-ops if demo
    // users already exist (see scripts/seedDemoData.js), so a container
    // restart doesn't keep appending more data. Failure here is logged,
    // never fatal — a seeding problem shouldn't take down the API.
    if (config.seedOnBoot) {
      try {
        const { seedIfEmpty } = require('./scripts/seedDemoData');
        const result = await seedIfEmpty({ users: config.seedOnBootUsers, days: config.seedOnBootDays });
        if (result.seeded) {
          logger.info('Seeded demo data on boot', { users: result.userCount, transactions: result.transactionCount });
        } else {
          logger.info('Skipped seeding on boot', { reason: result.reason });
        }
      } catch (err) {
        logger.error('SEED_ON_BOOT failed — starting without demo data', { error: err.message });
      }
    }

    httpServer.listen(config.port, () => {
      logger.info('FraudGuard backend started', { port: config.port, env: config.env });
    });

    // Webhook retry sweep (feature: retries that survive a restart —
    // see services/webhookRetryWorker.js). Not started under test —
    // tests drive sweepOnce() directly instead of waiting on a real
    // interval, and a background timer left running across Jest's
    // per-file module registries is exactly the kind of thing that
    // causes tests to hang or bleed into each other.
    if (!config.isTest) {
      webhookRetryWorker.start();
      require('./services/driftMonitorService').start(); // windowed/segmented drift snapshots + alerts
      require('./services/verificationService').start(); // expires overdue verification challenges
      require('./services/cognee').startScheduler(); // incremental Cognee memory sync (no-op unless COGNEE_SERVICE_URL is set)
      // Real-time event log retention (see models/realtimeEventRepository.js).
      const realtimeEvents = require('./models/realtimeEventRepository');
      const pruneEvents = () => realtimeEvents.prune({ maxAgeHours: config.realtimeRetentionHours })
        .catch((err) => logger.error('Realtime event prune failed', { error: err.message }));
      pruneEvents();
      setInterval(pruneEvents, 60 * 60 * 1000).unref();
      if (config.alertCases.escalationIntervalMs > 0) {
        const escalation = require('./services/alertEscalationService');
        const sweepEscalations = () => escalation.sweep()
          .then((r) => { if (r.escalated) logger.warn('Overdue alerts escalated', r); })
          .catch((err) => logger.error('Alert escalation sweep failed', { error: err.message }));
        setInterval(sweepEscalations, config.alertCases.escalationIntervalMs).unref();
      }
      if (config.retention.autoRun) {
        const retentionService = require('./services/retentionService');
        const runRetention = () => retentionService.run({ dryRun: false, actor: 'system:scheduler' })
          .then((r) => logger.info('Retention run complete', r.results))
          .catch((err) => logger.error('Retention run failed', { error: err.message }));
        setInterval(runRetention, config.retention.intervalHours * 3600 * 1000).unref();
      }
      if (config.modelGovernance.healthIntervalMs > 0) {
        const modelHealthService = require('./services/modelHealthService');
        const modelGovernance = require('./services/modelGovernanceService');
        const checkHealth = () => modelHealthService.run({ governance: modelGovernance })
          .then((r) => { if (r.status === 'critical') logger.error('Model rollback trigger breached', { version: r.version, action: r.action, triggers: r.triggers.filter((t) => t.status === 'critical').map((t) => t.name) }); })
          .catch((err) => logger.warn('Model health check failed', { error: err.message }));
        setInterval(checkHealth, config.modelGovernance.healthIntervalMs).unref();
      }
    }
  })
  .catch((err) => {
    logger.error('Failed to initialize database', { error: err.message, stack: err.stack });
    process.exit(1);
  });

// Don't let an unexpected background error crash the process silently —
// log it with full detail so it's actually diagnosable.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.stack || reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
