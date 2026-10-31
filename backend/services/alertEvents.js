/**
 * Case-management real-time events ('alert:updated'). ADMIN-ONLY: the alert's owner is the customer,
 * and who claimed their case, what investigators commented, or that it escalated is internal.
 * Written to the persistent event log (so a reconnecting investigator replays what they missed) and then
 * published. Best effort: the state change has already committed, and clients refetch on reconnect.
 */
const realtimeEvents = require('../models/realtimeEventRepository');
const logger = require('../config/logger');
const { publish } = require('../realtime/socketServer');

async function emit(kind, alert, { actor = null, extra = {} } = {}) {
  try {
    const events = await realtimeEvents.append([{
      type: 'alert:updated', userId: null, riskLevel: alert.risk_level,
      payload: { kind, alert_id: alert.id, transaction_id: alert.transaction_id, status: alert.status, severity: alert.severity ?? null,
        assigned_to: alert.assigned_to ?? null, claimed_by: alert.claimed_by ?? null, escalation_level: alert.escalation_level ?? 0,
        actor: actor ? { id: actor.id, username: actor.username } : null, ...extra },
    }]);
    publish(events);
  } catch (err) {
    logger.warn('Could not publish alert case event', { kind, error: err.message });
  }
}
module.exports = { emit };
