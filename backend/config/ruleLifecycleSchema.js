/** Rule/policy change proposals: draft -> approved -> active -> rolled_back (or rejected), with an append-only event log. */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS rule_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    rule_changes TEXT NOT NULL DEFAULT '[]',
    policy_change TEXT,
    content_hash TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    simulation TEXT,
    simulated_at TEXT,
    simulated_hash TEXT,
    simulated_rule_version INTEGER,
    simulated_policy_version INTEGER,
    approved_by INTEGER,
    approved_at TEXT,
    approval_note TEXT,
    activated_by INTEGER,
    activated_at TEXT,
    applied_rule_version INTEGER,
    applied_policy_version INTEGER,
    effects TEXT,
    rolled_back_by INTEGER,
    rolled_back_at TEXT,
    rollback_reason TEXT,
    rejected_by INTEGER,
    rejected_at TEXT,
    rejection_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS rule_proposal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES rule_proposals(id),
    kind TEXT NOT NULL,
    actor_id INTEGER,
    actor_username TEXT,
    summary TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

async function initRuleLifecycleSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_rule_proposals_status ON rule_proposals(status, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_rule_proposal_events ON rule_proposal_events(proposal_id, id)');
}

module.exports = { initRuleLifecycleSchema };
