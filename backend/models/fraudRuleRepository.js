/**
 * Fraud Rule Repository
 * ========================
 * Feature: configurable rule builder. Backs the admin-editable
 * replacement for fraudEngine.js's old hardcoded HARD_RULES_CONFIG —
 * that constant's own comment used to say "In production this would
 * live in its own DB table with an admin UI; kept as a static list here
 * for clarity." This is that table.
 *
 * Five rule_type values:
 *   blacklist_merchant / blacklist_location / blacklist_device / blacklist_ip
 *     -> `value` holds the blacklisted string, `threshold` is unused.
 *   amount_cap
 *     -> `threshold` holds the dollar cap, `value` is unused.
 *
 * getActiveRuleConfig() is what routes/transactions.js calls before
 * scoring, shaping the DB rows into the same plain-object shape
 * fraudEngine.js's checkHardRules already expects (so that function
 * itself doesn't need to know rules come from a database at all — same
 * "caller resolves it, engine just consumes it" pattern as
 * dynamicBlacklist and networkRisk).
 */

const db = require('../config/database');
const ruleSetRepository = require('./ruleSetRepository');

const RULE_TYPES = ['blacklist_merchant', 'blacklist_location', 'blacklist_device', 'blacklist_ip', 'amount_cap'];

async function listRules() {
  return db.all(`
    SELECT r.*, creator.username as created_by_username, updater.username as updated_by_username
    FROM fraud_rules r
    LEFT JOIN users creator ON r.created_by = creator.id
    LEFT JOIN users updater ON r.updated_by = updater.id
    ORDER BY r.rule_type, r.id
  `);
}

async function findById(id) {
  return db.get('SELECT * FROM fraud_rules WHERE id = ?', [id]);
}

async function createRule({ rule_type, value, threshold, reason, createdBy }) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO fraud_rules (rule_type, value, threshold, reason, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rule_type, value ?? null, threshold ?? null, reason ?? null, createdBy, createdBy]
  );
  await ruleSetRepository.captureIfChanged({ by: createdBy, note: `rule created: ${rule_type}` });
  return findById(lastInsertRowid);
}

/** Partial update — only touches the fields actually passed. */
async function updateRule(id, { value, threshold, enabled, reason }, updatedBy) {
  const sets = ['updated_by = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [updatedBy];
  if (value !== undefined) { sets.push('value = ?'); params.push(value); }
  if (threshold !== undefined) { sets.push('threshold = ?'); params.push(threshold); }
  if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (reason !== undefined) { sets.push('reason = ?'); params.push(reason); }
  params.push(id);
  await db.run(`UPDATE fraud_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  await ruleSetRepository.captureIfChanged({ by: updatedBy, note: `rule ${id} updated` });
  return findById(id);
}

async function deleteRule(id, deletedBy = null) {
  const result = await db.run('DELETE FROM fraud_rules WHERE id = ?', [id]);
  await ruleSetRepository.captureIfChanged({ by: deletedBy, note: `rule ${id} deleted` });
  return result;
}

/**
 * Seeds the table from the ORIGINAL hardcoded defaults, but only if it's
 * completely empty — called once from config/schema.js's initSchema, on
 * every startup, so it's a no-op after the first run. This means
 * upgrading an existing install to this feature doesn't silently change
 * what gets blocked: the same merchants/locations/cap that were baked
 * into the code before are just now sitting in an editable table.
 */
async function seedDefaultsIfEmpty(seededByUserId) {
  const { count } = await db.get('SELECT COUNT(*) as count FROM fraud_rules');
  if (Number(count) > 0) return;

  const defaults = [
    { rule_type: 'blacklist_merchant', value: 'DarkNet Market', reason: 'Seeded default (formerly hardcoded)' },
    { rule_type: 'blacklist_merchant', value: 'FastCash Wire Instant', reason: 'Seeded default (formerly hardcoded)' },
    { rule_type: 'blacklist_merchant', value: 'QuickCoin Anonymous', reason: 'Seeded default (formerly hardcoded)' },
    { rule_type: 'blacklist_location', value: 'Anonymous Proxy', reason: 'Seeded default (formerly hardcoded)' },
    { rule_type: 'amount_cap', threshold: 10000, reason: 'Seeded default (formerly hardcoded absoluteAmountCap)' },
  ];
  for (const rule of defaults) {
    await db.insert(
      `INSERT INTO fraud_rules (rule_type, value, threshold, reason, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rule.rule_type, rule.value ?? null, rule.threshold ?? null, rule.reason, seededByUserId, seededByUserId]
    );
  }
}

/**
 * Shapes enabled rules into the object fraudEngine.js's checkHardRules
 * consumes. If NO amount_cap rule is enabled (every admin disabled
 * theirs), falls back to Infinity rather than silently reintroducing the
 * old hardcoded number — an admin who explicitly turned off every cap
 * rule meant to turn off the cap, not to reactivate a value they can no
 * longer see or edit.
 */
/** The rules in force AND the version they are recorded under (captured now if they changed unnoticed). */
async function getActiveRuleSet() {
  const [config, version] = await Promise.all([getActiveRuleConfig(), ruleSetRepository.captureIfChanged({ note: 'detected change made outside the API' })]);
  return { config, version: version.id, hash: version.hash };
}

async function getActiveRuleConfig() {
  const rows = await db.all('SELECT rule_type, value, threshold FROM fraud_rules WHERE enabled = 1');
  return configFromRows(rows);
}

/** Shapes enabled rule rows into the object fraudEngine.checkHardRules consumes. Shared with the rule simulator so both see rules identically. */
function configFromRows(rows) {
  const config = { blacklistedMerchants: [], blacklistedLocations: [], blacklistedDevices: [], blacklistedIps: [], absoluteAmountCap: Infinity };
  for (const row of rows) {
    switch (row.rule_type) {
      case 'blacklist_merchant': config.blacklistedMerchants.push(row.value); break;
      case 'blacklist_location': config.blacklistedLocations.push(row.value); break;
      case 'blacklist_device': config.blacklistedDevices.push(row.value); break;
      case 'blacklist_ip': config.blacklistedIps.push(row.value); break;
      case 'amount_cap':
        if (row.threshold !== null && row.threshold < config.absoluteAmountCap) config.absoluteAmountCap = row.threshold;
        break;
      default: break;
    }
  }
  return config;
}

/**
 * Dry-run a candidate rule against the transactions already on file,
 * without creating it — feature: rule impact preview. Lets an admin
 * see "this would have matched N past transactions" before turning a
 * new blacklist entry or a lower amount cap live, so a rule that's
 * far too broad (e.g. a common location, or a cap that would have
 * caught half of last month's legitimate traffic) gets caught before
 * it starts generating alerts, not after.
 */
async function previewImpact({ rule_type, value, threshold }) {
  let where;
  let params;
  switch (rule_type) {
    case 'blacklist_merchant': where = 'merchant = ?'; params = [value]; break;
    case 'blacklist_location': where = 'location = ?'; params = [value]; break;
    case 'blacklist_device': where = 'device_fingerprint = ?'; params = [value]; break;
    case 'blacklist_ip': where = 'ip_address = ?'; params = [value]; break;
    case 'amount_cap': where = 'amount > ?'; params = [threshold]; break;
    default: where = '0 = 1'; params = []; break;
  }

  const { count } = await db.get(`SELECT COUNT(*) as count FROM transactions WHERE ${where}`, params);
  const sample = await db.all(
    `SELECT id, merchant, amount, location, card_type, risk_level, created_at
     FROM transactions WHERE ${where} ORDER BY created_at DESC LIMIT 5`,
    params
  );
  return { matched_count: Number(count), sample };
}

module.exports = {
  configFromRows, getActiveRuleSet, RULE_TYPES, listRules, findById, createRule, updateRule, deleteRule, seedDefaultsIfEmpty, getActiveRuleConfig, previewImpact };
