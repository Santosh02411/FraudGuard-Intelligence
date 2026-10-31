/**
 * Rule/policy change proposals — the controlled path from "idea" to "live".
 *
 *   draft --simulate--> draft(with simulation) --approve--> approved --activate--> active --rollback--> rolled_back
 *     \________________________ reject ________________________/ -> rejected
 *
 * Invariants (enforced here, in SQL / one DB transaction, not by caller discipline):
 *  - only a draft is editable; any edit discards its simulation (a simulation always describes the exact content approved);
 *  - approval needs a simulation of THIS content, taken against the rules/policy still in force (else STALE_SIMULATION),
 *    and a second person unless RULE_APPROVAL_ALLOW_SELF (four-eyes);
 *  - activation re-checks the base has not moved (STALE_BASE), then applies rule + policy changes atomically and records
 *    the exact inverse (`effects`);
 *  - rollback applies that inverse only if nothing touched those rules since (ROLLBACK_CONFLICT); the policy is rolled back
 *    by writing a NEW policy version (history stays append-only);
 *  - every transition is a compare-and-set on status/version, so concurrent clicks cannot double-apply;
 *  - the event log is append-only.
 */
const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config/env');
const ruleSetRepository = require('./ruleSetRepository');
const riskPolicyRepository = require('./riskPolicyRepository');
const { validateThresholds } = require('./riskPolicy');
const sim = require('../services/ruleSimulationService');

const STATUSES = ['draft', 'approved', 'active', 'rolled_back', 'rejected'];
const now = () => new Date().toISOString();

class ConflictError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

const parse = (s, d = null) => { if (s === null || s === undefined) return d; try { return JSON.parse(s); } catch { return d; } };
const num = (v) => (v === null || v === undefined ? null : Number(v));

function canonicalContent(ruleChanges, policyChange) {
  const rc = ruleChanges.map((c) => ({ op: c.op, rule_id: c.rule_id ?? null, rule_type: c.rule_type ?? null, value: c.value ?? null, threshold: c.threshold ?? null, reason: c.reason ?? null }));
  const pc = policyChange ? { medium_threshold: Number(policyChange.medium_threshold), high_threshold: Number(policyChange.high_threshold), review_capacity_per_day: policyChange.review_capacity_per_day ?? null } : null;
  return JSON.stringify({ rc, pc });
}
const hashOf = (ruleChanges, policyChange) => crypto.createHash('sha256').update(canonicalContent(ruleChanges, policyChange)).digest('hex');

function shape(row) {
  if (!row) return null;
  return {
    id: Number(row.id), title: row.title, description: row.description, status: row.status,
    rule_changes: parse(row.rule_changes, []), policy_change: parse(row.policy_change),
    content_hash: row.content_hash, created_by: num(row.created_by), created_by_username: row.created_by_username ?? undefined,
    created_at: row.created_at, updated_at: row.updated_at, version: Number(row.version),
    simulation: parse(row.simulation), simulated_at: row.simulated_at,
    simulated_current: !!row.simulated_hash && row.simulated_hash === row.content_hash,
    simulated_rule_version: num(row.simulated_rule_version), simulated_policy_version: num(row.simulated_policy_version),
    approved_by: num(row.approved_by), approved_at: row.approved_at, approval_note: row.approval_note,
    activated_by: num(row.activated_by), activated_at: row.activated_at,
    applied_rule_version: num(row.applied_rule_version), applied_policy_version: num(row.applied_policy_version),
    effects: parse(row.effects),
    rolled_back_by: num(row.rolled_back_by), rolled_back_at: row.rolled_back_at, rollback_reason: row.rollback_reason,
    rejected_by: num(row.rejected_by), rejected_at: row.rejected_at, rejection_reason: row.rejection_reason,
  };
}

async function addEvent(id, kind, actor, summary, details) {
  await db.run(
    'INSERT INTO rule_proposal_events (proposal_id, kind, actor_id, actor_username, summary, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, kind, actor?.id ?? null, actor?.username ?? 'system', summary, details ? JSON.stringify(details) : null, now()]
  );
}

async function currentRuleRows() {
  return db.all('SELECT id, rule_type, value, threshold, enabled FROM fraud_rules ORDER BY id');
}

/** Throws ConflictError('INVALID') when the content cannot apply to today's rules / violates policy limits. */
async function validateContent(ruleChanges, policyChange) {
  if (!ruleChanges.length && !policyChange) throw new ConflictError('INVALID', 'A proposal must change at least one rule or the risk policy');
  if (policyChange) {
    const problems = validateThresholds(Number(policyChange.medium_threshold), Number(policyChange.high_threshold));
    if (problems.length) throw new ConflictError('INVALID', 'Invalid risk thresholds', { problems });
  }
  try { sim.applyRuleChanges(await currentRuleRows(), ruleChanges); } catch (e) {
    if (e.code === 'BAD_CHANGE') throw new ConflictError('INVALID', e.message);
    throw e;
  }
}

async function findById(id) {
  const row = await db.get(
    `SELECT p.*, u.username AS created_by_username FROM rule_proposals p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`, [id]);
  return shape(row);
}

async function list({ status, page = 1, limit = 20 } = {}) {
  const where = status ? 'WHERE p.status = ?' : '';
  const params = status ? [status] : [];
  const { total } = await db.get(`SELECT COUNT(*) AS total FROM rule_proposals p ${where}`, params);
  const rows = await db.all(
    `SELECT p.*, u.username AS created_by_username FROM rule_proposals p LEFT JOIN users u ON u.id = p.created_by ${where}
     ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
  // list view: drop the heavy simulation payload, keep the headline numbers
  return { rows: rows.map((r) => { const s = shape(r); const d = s.simulation; s.simulation = d ? { evaluated: d.evaluated, delta: d.delta, warnings: d.warnings } : null; return s; }), total: Number(total) };
}

async function events(id) {
  const rows = await db.all('SELECT * FROM rule_proposal_events WHERE proposal_id = ? ORDER BY id', [id]);
  return rows.map((r) => ({ ...r, id: Number(r.id), details: parse(r.details) }));
}

async function create({ title, description = null, rule_changes = [], policy_change = null }, actor) {
  await validateContent(rule_changes, policy_change);
  return db.transaction(async () => {
    const { lastInsertRowid } = await db.insert(
      `INSERT INTO rule_proposals (title, description, status, rule_changes, policy_change, content_hash, created_by, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      [title, description, JSON.stringify(rule_changes), policy_change ? JSON.stringify(policy_change) : null, hashOf(rule_changes, policy_change), actor.id, now(), now()]
    );
    await addEvent(lastInsertRowid, 'created', actor, 'Draft created');
    return findById(lastInsertRowid);
  });
}

async function requireStatus(id, allowed) {
  const p = await findById(id);
  if (!p) throw new ConflictError('NOT_FOUND', 'Proposal not found');
  if (!allowed.includes(p.status)) throw new ConflictError('BAD_STATE', `Proposal is ${p.status}; this action needs ${allowed.join(' or ')}`, { status: p.status });
  return p;
}

async function update(id, patch, actor) {
  const p = await requireStatus(id, ['draft']);
  const rc = patch.rule_changes ?? p.rule_changes;
  const pc = patch.policy_change === undefined ? p.policy_change : patch.policy_change;
  await validateContent(rc, pc);
  const hash = hashOf(rc, pc);
  const changedContent = hash !== p.content_hash;
  const r = await db.run(
    `UPDATE rule_proposals SET title = ?, description = ?, rule_changes = ?, policy_change = ?, content_hash = ?, updated_at = ?, version = version + 1
       ${changedContent ? ', simulation = NULL, simulated_at = NULL, simulated_hash = NULL, simulated_rule_version = NULL, simulated_policy_version = NULL' : ''}
     WHERE id = ? AND status = 'draft' ${patch.version ? 'AND version = ?' : ''}`,
    [patch.title ?? p.title, patch.description === undefined ? p.description : patch.description, JSON.stringify(rc), pc ? JSON.stringify(pc) : null, hash, now(), id, ...(patch.version ? [patch.version] : [])]
  );
  if (r.changes === 0) throw new ConflictError('VERSION_CONFLICT', 'This proposal was changed by someone else since you opened it.');
  await addEvent(id, 'edited', actor, changedContent ? 'Content edited (previous simulation discarded)' : 'Title/description edited');
  return findById(id);
}

async function baseNow() {
  const [ruleVer, policy] = await Promise.all([ruleSetRepository.captureIfChanged({ note: 'detected change made outside the API' }), riskPolicyRepository.getActive()]);
  return { rule_version: ruleVer.id, policy, policy_version: policy.version };
}

/** Ad-hoc simulation of arbitrary content (nothing stored). */
async function simulateContent({ rule_changes = [], policy_change = null, days, maturity_days }) {
  await validateContent(rule_changes, policy_change);
  const [rows, base] = await Promise.all([currentRuleRows(), baseNow()]);
  const result = await sim.simulate({ currentRules: rows, currentPolicy: base.policy, ruleChanges: rule_changes, policyChange: policy_change, days, maturityDays: maturity_days });
  return { ...result, base: { rule_version: base.rule_version, policy_version: base.policy_version } };
}

async function runSimulation(id, { days, maturity_days }, actor) {
  const p = await requireStatus(id, ['draft']);
  const result = await simulateContent({ rule_changes: p.rule_changes, policy_change: p.policy_change, days, maturity_days });
  const r = await db.run(
    `UPDATE rule_proposals SET simulation = ?, simulated_at = ?, simulated_hash = ?, simulated_rule_version = ?, simulated_policy_version = ?, updated_at = ?
     WHERE id = ? AND status = 'draft' AND content_hash = ?`,
    [JSON.stringify(result), now(), p.content_hash, result.base.rule_version, result.base.policy_version, now(), id, p.content_hash]
  );
  if (r.changes === 0) throw new ConflictError('VERSION_CONFLICT', 'The proposal changed while the simulation ran; run it again.');
  await addEvent(id, 'simulated', actor, `Simulated over ${result.window_days}d: ${result.delta.flagged >= 0 ? '+' : ''}${result.delta.flagged} flagged`, { evaluated: result.evaluated, delta: result.delta });
  return findById(id);
}

async function assertFresh(p) {
  if (!p.simulated_current) throw new ConflictError('NO_SIMULATION', 'Run a historical simulation of this exact content before approving or activating it');
  const base = await baseNow();
  if (base.rule_version !== p.simulated_rule_version || base.policy_version !== p.simulated_policy_version) {
    throw new ConflictError('STALE_SIMULATION', 'The live rules or risk policy changed after this simulation. Run it again.', {
      simulated: { rule_version: p.simulated_rule_version, policy_version: p.simulated_policy_version }, now: { rule_version: base.rule_version, policy_version: base.policy_version },
    });
  }
}

async function approve(id, { note, version }, actor) {
  const p = await requireStatus(id, ['draft']);
  if (!config.ruleLifecycle.allowSelfApproval && p.created_by === actor.id) {
    throw new ConflictError('SELF_APPROVAL', 'A second administrator must approve this proposal (four-eyes)');
  }
  await assertFresh(p);
  const r = await db.run(
    `UPDATE rule_proposals SET status = 'approved', approved_by = ?, approved_at = ?, approval_note = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status = 'draft' AND content_hash = ? ${version ? 'AND version = ?' : ''}`,
    [actor.id, now(), note ?? null, now(), id, p.content_hash, ...(version ? [version] : [])]
  );
  if (r.changes === 0) throw new ConflictError('VERSION_CONFLICT', 'This proposal was changed by someone else since you opened it.');
  await addEvent(id, 'approved', actor, 'Approved', { note: note ?? null });
  return findById(id);
}

async function reject(id, { reason }, actor) {
  await requireStatus(id, ['draft', 'approved']);
  const r = await db.run(
    `UPDATE rule_proposals SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status IN ('draft', 'approved')`, [actor.id, now(), reason, now(), id]);
  if (r.changes === 0) throw new ConflictError('BAD_STATE', 'Proposal is no longer open');
  await addEvent(id, 'rejected', actor, 'Rejected', { reason });
  return findById(id);
}

const ruleState = (r) => ({ value: r.value ?? null, threshold: num(r.threshold), enabled: Number(r.enabled) ? 1 : 0 });
const sameState = (a, b) => a.value === b.value && a.threshold === b.threshold && a.enabled === b.enabled;

async function activate(id, actor) {
  const p = await requireStatus(id, ['approved']);
  try { await assertFresh(p); } catch (e) {
    if (e instanceof ConflictError && e.code === 'STALE_SIMULATION') throw new ConflictError('STALE_BASE', e.message, e.extra);
    throw e;
  }
  return db.transaction(async () => {
    const claim = await db.run(`UPDATE rule_proposals SET status = 'active', activated_by = ?, activated_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'`, [actor.id, now(), now(), id]);
    if (claim.changes === 0) throw new ConflictError('BAD_STATE', 'Proposal was already activated');

    const effects = { created: [], updated: [], deleted: [], policy: null };
    for (const c of p.rule_changes) {
      if (c.op === 'add') {
        const { lastInsertRowid } = await db.insert(
          'INSERT INTO fraud_rules (rule_type, value, threshold, reason, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
          [c.rule_type, c.value ?? null, c.threshold ?? null, c.reason ?? `Rule proposal #${id}`, actor.id, actor.id]);
        effects.created.push({ id: Number(lastInsertRowid), after: { value: c.value ?? null, threshold: c.threshold ?? null, enabled: 1 }, rule_type: c.rule_type });
        continue;
      }
      const row = await db.get('SELECT * FROM fraud_rules WHERE id = ?', [c.rule_id]);
      if (!row) throw new ConflictError('STALE_BASE', `Rule ${c.rule_id} no longer exists`);
      if (c.op === 'delete') {
        await db.run('DELETE FROM fraud_rules WHERE id = ?', [row.id]);
        effects.deleted.push({ id: Number(row.id), rule_type: row.rule_type, before: ruleState(row), reason: row.reason ?? null });
        continue;
      }
      const before = ruleState(row);
      const after = { ...before };
      if (c.op === 'enable') after.enabled = 1;
      if (c.op === 'disable') after.enabled = 0;
      if (c.op === 'update') { if (c.value !== undefined) after.value = c.value; if (c.threshold !== undefined) after.threshold = c.threshold; }
      if (sameState(before, after)) continue;
      await db.run('UPDATE fraud_rules SET value = ?, threshold = ?, enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [after.value, after.threshold, after.enabled, actor.id, row.id]);
      effects.updated.push({ id: Number(row.id), rule_type: row.rule_type, before, after });
    }
    let appliedRuleVersion = (await ruleSetRepository.captureIfChanged({ by: actor.id, note: `rule proposal #${id} activated` })).id;

    let appliedPolicyVersion = null;
    if (p.policy_change) {
      const prev = await riskPolicyRepository.getActive();
      const cap = p.policy_change.review_capacity_per_day ?? null;
      if (!(prev.medium_threshold === Number(p.policy_change.medium_threshold) && prev.high_threshold === Number(p.policy_change.high_threshold) && prev.review_capacity_per_day === cap)) {
        const created = await riskPolicyRepository.create({ medium_threshold: Number(p.policy_change.medium_threshold), high_threshold: Number(p.policy_change.high_threshold), review_capacity_per_day: cap, note: `Rule proposal #${id}: ${p.title}`.slice(0, 500), createdBy: actor.id });
        effects.policy = { previous: { version: prev.version, medium_threshold: prev.medium_threshold, high_threshold: prev.high_threshold, review_capacity_per_day: prev.review_capacity_per_day }, created_version: created.version };
        appliedPolicyVersion = created.version;
      }
    }
    await db.run('UPDATE rule_proposals SET effects = ?, applied_rule_version = ?, applied_policy_version = ? WHERE id = ?', [JSON.stringify(effects), appliedRuleVersion, appliedPolicyVersion, id]);
    await addEvent(id, 'activated', actor, 'Activated — live from the next transaction scored', { rule_version: appliedRuleVersion, policy_version: appliedPolicyVersion, created: effects.created.length, updated: effects.updated.length, deleted: effects.deleted.length });
    return findById(id);
  });
}

async function rollback(id, { reason }, actor) {
  const p = await requireStatus(id, ['active']);
  const fx = p.effects || { created: [], updated: [], deleted: [], policy: null };
  return db.transaction(async () => {
    const claim = await db.run(`UPDATE rule_proposals SET status = 'rolled_back', rolled_back_by = ?, rolled_back_at = ?, rollback_reason = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'active'`, [actor.id, now(), reason, now(), id]);
    if (claim.changes === 0) throw new ConflictError('BAD_STATE', 'Proposal was already rolled back');

    // 1. verify nothing touched these rules since activation
    const conflicts = [];
    for (const c of fx.created) {
      const row = await db.get('SELECT * FROM fraud_rules WHERE id = ?', [c.id]);
      if (!row || !sameState(ruleState(row), c.after)) conflicts.push({ rule_id: c.id, reason: row ? 'rule was edited after activation' : 'rule no longer exists' });
    }
    for (const u of fx.updated) {
      const row = await db.get('SELECT * FROM fraud_rules WHERE id = ?', [u.id]);
      if (!row || !sameState(ruleState(row), u.after)) conflicts.push({ rule_id: u.id, reason: row ? 'rule was edited after activation' : 'rule no longer exists' });
    }
    if (fx.policy) {
      const active = await riskPolicyRepository.getActive();
      if (active.version !== fx.policy.created_version) conflicts.push({ policy: true, reason: `risk policy changed after activation (now v${active.version})` });
    }
    if (conflicts.length) throw new ConflictError('ROLLBACK_CONFLICT', 'Cannot roll back automatically: later changes touched the same rules/policy. Resolve them first (or roll back the later change).', { conflicts });

    // 2. apply the inverse
    const restoredAs = {};
    for (const c of fx.created) await db.run('DELETE FROM fraud_rules WHERE id = ?', [c.id]);
    for (const u of fx.updated) await db.run('UPDATE fraud_rules SET value = ?, threshold = ?, enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [u.before.value, u.before.threshold, u.before.enabled, actor.id, u.id]);
    for (const d of fx.deleted) {
      const { lastInsertRowid } = await db.insert('INSERT INTO fraud_rules (rule_type, value, threshold, enabled, reason, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [d.rule_type, d.before.value, d.before.threshold, d.before.enabled, d.reason ?? `Restored by rollback of proposal #${id}`, actor.id, actor.id]);
      restoredAs[d.id] = Number(lastInsertRowid);
    }
    const ruleVersion = (await ruleSetRepository.captureIfChanged({ by: actor.id, note: `rule proposal #${id} rolled back` })).id;
    let policyVersion = null;
    if (fx.policy) {
      const pr = fx.policy.previous;
      const created = await riskPolicyRepository.create({ medium_threshold: pr.medium_threshold, high_threshold: pr.high_threshold, review_capacity_per_day: pr.review_capacity_per_day, note: `Rollback of rule proposal #${id}: ${reason}`.slice(0, 500), createdBy: actor.id });
      policyVersion = created.version;
    }
    await addEvent(id, 'rolled_back', actor, 'Rolled back', { reason, rule_version: ruleVersion, policy_version: policyVersion, restored_deleted_rules: restoredAs });
    return findById(id);
  });
}

/** Where the live system stands, for the Rule Lab header. */
async function state() {
  const [rules, base, versions, active] = await Promise.all([
    db.all('SELECT * FROM fraud_rules ORDER BY rule_type, id'), baseNow(), ruleSetRepository.list(10),
    db.all(`SELECT id, title, activated_at FROM rule_proposals WHERE status = 'active' ORDER BY id DESC`),
  ]);
  return { rules, rule_version: base.rule_version, policy: base.policy, rule_set_versions: versions, active_proposals: active.map((a) => ({ ...a, id: Number(a.id) })), require_proposal: config.ruleLifecycle.requireProposal, allow_self_approval: config.ruleLifecycle.allowSelfApproval };
}

module.exports = { STATUSES, ConflictError, create, update, findById, list, events, simulateContent, runSimulation, approve, reject, activate, rollback, state };
