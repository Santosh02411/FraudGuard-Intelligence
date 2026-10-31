/**
 * Model change governance
 * ==========================
 * Changing which model decides on real money is a controlled change, not a
 * button. Flow (promotion; rollback is the same with fewer gates):
 *
 *   1. REQUEST   an admin names a registry version, gives a reason and
 *                completes the checklist. The ML service computes the gates;
 *                this service adds the one that needs our database (outcomes).
 *                Hard failures (integrity, compatibility, schema, calibration,
 *                missing required metrics) stop the request here. A challenger
 *                that is WORSE than the incumbent on labelled data (benchmark
 *                or confirmed outcomes) cannot be requested through either.
 *   2. APPROVE   a DIFFERENT admin reviews the stored gate report, must
 *                acknowledge by id every gate that is insufficient / warning,
 *                and leaves a note. (Self-approval exists only as an explicit
 *                non-production opt-in and is recorded as such.)
 *   3. APPLY     immediately after approval, with the hard gates re-run NOW
 *                (files can change after the request) and a check that the
 *                serving model is still the one the request was made against.
 *                The ML service re-verifies integrity again at the switch.
 *
 * Every step is stored in model_change_requests (the promotion history) with
 * the actor, the time, the reason and the evidence. Shadow-score AGREEMENT is
 * deliberately not a gate: agreement is not accuracy.
 */
const config = require('../config/env');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { audit } = require('../middleware/auditLog');
const modelChangeRepository = require('../models/modelChangeRepository');
const shadowScoreRepository = require('../models/shadowScoreRepository');
const modelEvaluationService = require('./modelEvaluationService');
const mlAdminClient = require('./mlAdminClient');

const CHECKLISTS = {
  promote: [
    { id: 'gates_reviewed', label: 'I reviewed the automated gate report (integrity, compatibility, schema, calibration, metrics)' },
    { id: 'comparison_reviewed', label: 'I reviewed the challenger-vs-incumbent comparison on labelled data, including per-fraud-pattern recall' },
    { id: 'thresholds_reviewed', label: 'I checked the risk-policy thresholds still fit this model\'s score distribution (review volume vs capacity)' },
    { id: 'rollback_plan', label: 'The previous version is verified and I know how to roll back (and who watches the rollback triggers)' },
    { id: 'stakeholders_notified', label: 'Fraud operations / analysts are told the model is changing' },
  ],
  rollback: [
    { id: 'impact_understood', label: 'I understand what the target version\'s behaviour and calibration are' },
    { id: 'target_verified', label: 'The target version passed integrity verification' },
  ],
};

const NON_OVERRIDABLE_SOFT_FAILS = new Set(['benchmark_comparison', 'outcome_evidence']);

const validVersion = (v) => typeof v === 'string' && /^v\d+$/.test(v);

/** Honesty adjustments to the raw gate list. */
function finalizeGates(gates) {
  return gates.map((g) => {
    if (g.id === 'benchmark_comparison' && g.status === 'pass' && g.data?.benchmark?.synthetic) {
      return { ...g, status: 'warn', detail: `${g.detail} — passing a synthetic benchmark rules out a regression on our generator's patterns; it is NOT evidence of real-world accuracy` };
    }
    return g;
  });
}

function blockingProblems(gates) {
  return gates.filter((g) => (g.hard && g.status === 'fail') || (g.status === 'fail' && NON_OVERRIDABLE_SOFT_FAILS.has(g.id)));
}

function needingAcknowledgement(gates) {
  return gates.filter((g) => ['insufficient', 'warn'].includes(g.status) || (g.status === 'fail' && !g.hard && !NON_OVERRIDABLE_SOFT_FAILS.has(g.id)));
}

function checklistFor(action) {
  return CHECKLISTS[action] || [];
}

function assertChecklist(action, submitted) {
  const missing = checklistFor(action).filter((item) => submitted?.[item.id] !== true).map((i) => i.id);
  if (missing.length) {
    throw Object.assign(AppError.badRequest('Every checklist item must be confirmed before a model change can be requested'), { details: { code: 'CHECKLIST_INCOMPLETE', missing } });
  }
}

async function loadActive() {
  const versions = await mlAdminClient.listVersions();
  return { active: versions.active, versions: versions.versions || [] };
}

async function buildGateReport(action, target, active) {
  const mlReport = await mlAdminClient.getGates(target, { incumbent: active, compare: action === 'promote' });
  let gates = mlReport.gates || [];
  if (action === 'promote') {
    const count = await shadowScoreRepository.countFor(target);
    gates = [...gates, count === 0
      ? { id: 'outcome_evidence', title: 'Challenger judged on confirmed fraud outcomes (analyst verdicts)', status: 'insufficient', hard: false,
          detail: 'the challenger has not shadow-scored any real transactions. Shadow-score AGREEMENT would not count as evidence anyway; only analyst verdicts do. Run it as a shadow model on real traffic, then request again.' }
      : await modelEvaluationService.outcomeGate(target)];
  }
  gates = finalizeGates(gates);
  return {
    action, target_version: target, incumbent_version: active, generated_at: new Date().toISOString(), gates,
    summary: {
      blocked: blockingProblems(gates).length > 0,
      blocking: blockingProblems(gates).map((g) => g.id),
      needs_acknowledgement: needingAcknowledgement(gates).map((g) => g.id),
    },
  };
}

async function requestChange({ action, version, reason, checklist, user, req }) {
  if (!['promote', 'rollback'].includes(action)) throw AppError.badRequest('action must be promote or rollback');
  if (!validVersion(version)) throw AppError.badRequest('version must look like "v4"');
  assertChecklist(action, checklist);

  const { active, versions } = await loadActive();
  if (!versions.some((v) => v.version === version)) throw AppError.notFound(`No such model version in the registry: ${version}`);
  if (version === active) throw AppError.conflict(`${version} is already the serving model`);

  const report = await buildGateReport(action, version, active);
  if (report.summary.blocked) {
    const err = new AppError('The gates block this change; it cannot be requested until they pass', 422, { code: 'GATES_BLOCK', gate_report: report });
    await audit({ req, userId: user.id, username: user.username, action: 'ml.change_blocked', targetType: 'model', outcome: 'denied', details: { action, version, blocking: report.summary.blocking } });
    throw err;
  }
  const created = await modelChangeRepository.create({
    action, targetVersion: version, fromVersion: active, reason, checklist, gateReport: report, requestedBy: user.id,
  });
  if (!created) throw Object.assign(AppError.conflict(`Another ${action} request is already open; decide or cancel it first`), { details: { code: 'CHANGE_ALREADY_OPEN' } });
  await audit({ req, userId: user.id, username: user.username, action: 'ml.change_requested', targetType: 'model_change', targetId: created.id, details: { action, version, from: active, reason } });
  return created;
}

async function load(id) {
  const c = await modelChangeRepository.get(id);
  if (!c) throw AppError.notFound('Model change request not found');
  return c;
}

async function approve({ id, user, note, acknowledgedGates = [], expectedVersion, req }) {
  const change = await load(id);
  if (change.status !== 'pending_approval') throw Object.assign(AppError.conflict(`Request is ${change.status}, not pending approval`), { details: { code: 'NOT_PENDING', current: change } });
  const selfApproved = change.requested_by === user.id;
  if (selfApproved && !config.modelGovernance.allowSelfApproval) {
    await audit({ req, userId: user.id, username: user.username, action: 'ml.change_approve_denied', targetType: 'model_change', targetId: id, outcome: 'denied', details: { reason: 'self-approval' } });
    throw Object.assign(AppError.forbidden('The person who requested a model change cannot approve it — ask another admin'), { details: { code: 'FOUR_EYES' } });
  }
  const report = change.gate_report;
  const ackNeeded = (report?.summary?.needs_acknowledgement) || [];
  const missing = ackNeeded.filter((g) => !acknowledgedGates.includes(g));
  if (missing.length) throw Object.assign(AppError.badRequest('Acknowledge each insufficient or warning gate by id to approve'), { details: { code: 'GATES_NOT_ACKNOWLEDGED', missing, gate_report: report } });

  const ok = await modelChangeRepository.decide(id, {
    status: 'approved', decidedBy: user.id, note: selfApproved ? `[SELF-APPROVED] ${note}` : note, acknowledged: acknowledgedGates, expectedVersion,
  });
  if (!ok) throw Object.assign(AppError.conflict('This request was changed by someone else; reload it'), { details: { code: 'VERSION_CONFLICT', current: await modelChangeRepository.get(id) } });
  await audit({ req, userId: user.id, username: user.username, action: 'ml.change_approved', targetType: 'model_change', targetId: id, details: { version: change.target_version, selfApproved, acknowledged: acknowledgedGates, note } });
  return apply({ id, actor: user, req });
}

async function reject({ id, user, note, expectedVersion, req }) {
  const change = await load(id);
  const ok = await modelChangeRepository.decide(id, { status: 'rejected', decidedBy: user.id, note, acknowledged: [], expectedVersion });
  if (!ok) throw Object.assign(AppError.conflict(`Request is ${change.status}, or was changed by someone else`), { details: { code: 'NOT_PENDING', current: await modelChangeRepository.get(id) } });
  await audit({ req, userId: user.id, username: user.username, action: 'ml.change_rejected', targetType: 'model_change', targetId: id, details: { version: change.target_version, note } });
  return modelChangeRepository.get(id);
}

async function cancel({ id, user, note, req }) {
  const change = await load(id);
  if (change.requested_by !== user.id) throw AppError.forbidden('Only the requester can cancel; anyone else should reject it');
  const ok = await modelChangeRepository.cancel(id, { by: user.id, note: note || 'cancelled by requester' });
  if (!ok) throw Object.assign(AppError.conflict(`Request is ${change.status}`), { details: { code: 'NOT_PENDING' } });
  await audit({ req, userId: user.id, username: user.username, action: 'ml.change_cancelled', targetType: 'model_change', targetId: id });
  return modelChangeRepository.get(id);
}

/** Applies an APPROVED change. Safe to call twice: only one caller wins the claim. */
async function apply({ id, actor, req, actorLabel }) {
  if (!(await modelChangeRepository.claimApply(id))) throw Object.assign(AppError.conflict('This change is not approved, or is already being applied'), { details: { code: 'NOT_APPROVED' } });
  const change = await modelChangeRepository.get(id);
  const label = actorLabel || actor?.username || 'system';
  const fail = async (message, extra = {}, gatesNow) => {
    await modelChangeRepository.finishApply(id, { ok: false, result: { error: message, ...extra }, gateReportAtApply: gatesNow });
    await audit({ req, userId: actor?.id ?? null, username: label, action: 'ml.change_apply_failed', targetType: 'model_change', targetId: id, outcome: 'failure', details: { version: change.target_version, error: message } });
    throw Object.assign(new AppError(`Model change not applied: ${message}`, 409, { code: 'APPLY_FAILED', ...extra }), { applyFailed: true });
  };
  let gatesNow;
  try {
    const { active } = await loadActive();
    if (active !== change.from_version) return await fail(`the serving model changed since the request (was ${change.from_version}, now ${active}) — request again`, { code: 'STALE_BASE', serving: active });
    // Hard gates are re-run NOW: artifacts can change between request and approval.
    gatesNow = await mlAdminClient.getGates(change.target_version, { incumbent: active, compare: false });
    const hard = (gatesNow.gates || []).filter((g) => g.hard && g.status === 'fail');
    if (hard.length) return await fail(`gates failed at apply time: ${hard.map((g) => g.id).join(', ')}`, { code: 'GATES_FAILED_AT_APPLY', gates: hard.map((g) => ({ id: g.id, detail: g.detail })) }, gatesNow);
    const result = await mlAdminClient.activate({
      version: change.target_version, kind: change.action, changeId: id, actor: label,
      reason: `${change.reason} (approved by ${change.decided_by_username || label})`,
    });
    await modelChangeRepository.finishApply(id, { ok: true, result, gateReportAtApply: gatesNow });
    await audit({ req, userId: actor?.id ?? null, username: label, action: change.action === 'rollback' ? 'ml.rolled_back' : 'ml.promoted', targetType: 'model_change', targetId: id, details: { from: change.from_version, to: change.target_version, reason: change.reason } });
    logger.info('Model change applied', { id, action: change.action, from: change.from_version, to: change.target_version, actor: label });
    return modelChangeRepository.get(id);
  } catch (err) {
    if (err.applyFailed) throw err;
    return fail(err.message, {}, gatesNow);
  }
}

/** Used by the rollback triggers: a rollback recorded under the SYSTEM actor, applied at once, with the trigger as the reason. Opt-in (MODEL_AUTO_ROLLBACK). */
async function automaticRollback({ toVersion, trigger, details }) {
  const { active, versions } = await loadActive();
  if (!toVersion || toVersion === active || !versions.some((v) => v.version === toVersion)) return { applied: false, reason: 'no valid version to roll back to' };
  const report = await buildGateReport('rollback', toVersion, active);
  if (report.summary.blocked) return { applied: false, reason: `rollback target blocked by gates: ${report.summary.blocking.join(', ')}` };
  const created = await modelChangeRepository.create({
    action: 'rollback', targetVersion: toVersion, fromVersion: active,
    reason: `AUTOMATIC rollback: trigger "${trigger}" breached (${JSON.stringify(details).slice(0, 300)})`,
    checklist: { automatic: true }, gateReport: report, requestedBy: null, status: 'pending_approval',
  });
  if (!created) return { applied: false, reason: 'a rollback request is already open' };
  if (!(await modelChangeRepository.decide(created.id, { status: 'approved', decidedBy: null, note: `automatic: trigger ${trigger}`, acknowledged: report.summary.needs_acknowledgement }))) {
    return { applied: false, reason: 'could not approve automatic rollback' };
  }
  try {
    const applied = await apply({ id: created.id, actor: null, actorLabel: 'system:rollback-trigger' });
    return { applied: true, change: applied };
  } catch (err) {
    return { applied: false, reason: err.message };
  }
}

module.exports = {
  CHECKLISTS, checklistFor, buildGateReport, requestChange, approve, reject, cancel, apply, automaticRollback,
  blockingProblems, needingAcknowledgement, finalizeGates,
};
