/**
 * Escalates overdue alerts. Safe to run on every instance at once: the UPDATE is a compare-and-set on
 * escalation_level, so a case escalates once per level no matter how many sweepers race.
 * Each escalation moves the case to status 'escalated', raises escalation_level, sets a SHORTER next
 * deadline (half the severity's SLA), writes an audit entry (actor system:escalation) and publishes an
 * admin-only real-time event. Stops at ALERT_MAX_ESCALATION_LEVEL; beyond that the case simply stays overdue.
 */
const alertCase = require('../models/alertCaseRepository');
const alertRepository = require('../models/alertRepository');
const auditLogRepository = require('../models/auditLogRepository');
const alertEvents = require('./alertEvents');
const logger = require('../config/logger');

async function sweep({ now = new Date(), limit = 200 } = {}) {
  const due = await alertCase.overdueUnresolved({ limit, now: alertCase.iso(now) });
  let escalated = 0;
  for (const a of due) {
    if (!(await alertCase.escalate(a.id, a.escalation_level))) continue; // someone else got there first
    escalated += 1;
    const fresh = await alertRepository.findByIdWithDetails(a.id);
    await auditLogRepository.insert({
      userId: null, username: 'system:escalation', action: 'alerts.escalate', targetType: 'alert', targetId: a.id,
      details: { automatic: true, reason: 'SLA deadline passed', transaction_id: fresh?.transaction_id, before: { escalation_level: a.escalation_level, due_at: a.due_at }, after: { escalation_level: a.escalation_level + 1, due_at: fresh?.due_at } },
    }).catch((err) => logger.error('Escalation audit failed', { alert: a.id, error: err.message }));
    if (fresh) await alertEvents.emit('escalated', fresh, { extra: { automatic: true } });
  }
  return { checked: due.length, escalated };
}

module.exports = { sweep };
