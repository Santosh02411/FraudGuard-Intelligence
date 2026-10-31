/**
 * Network / Graph-Based Fraud Ring Detection
 * =============================================
 * Everything else in this app (fraudEngine.js, mlClient.js) scores ONE
 * transaction at a time, from the perspective of ONE account's own
 * history. That misses a whole class of fraud: coordinated activity
 * across MULTIPLE accounts that individually look unremarkable but
 * share underlying infrastructure — a stolen-card testing farm running
 * many small "trial" transactions across throwaway accounts from one
 * device, or one operator working several fake accounts from one IP.
 *
 * This module builds a graph where accounts are nodes and an edge
 * connects two accounts that have ever shared a device_fingerprint or
 * ip_address, then finds connected components ("clusters"/"rings") via
 * union-find. A cluster is worth surfacing when either:
 *
 *   1. It contains at least one account with CONFIRMED fraud history —
 *      and, critically, this reaches accounts that never directly
 *      shared an identifier with the confirmed-fraud account, only
 *      with an intermediary. That's the actual gap this closes: the
 *      existing dynamic blacklist (transactionRepository.
 *      fraudDeviceAndIpBlacklist) only catches a DIRECT device/IP match
 *      against a confirmed-fraud transaction — a single hop. A ring
 *      launders that by rotating devices/IPs between accounts one hop
 *      at a time; graph clustering catches the whole component instead
 *      of each edge in isolation.
 *   2. It's unusually large with NO confirmed fraud yet — e.g. 5
 *      distinct accounts sharing one device is a topology anomaly
 *      worth a human look even before any of them are confirmed
 *      fraudulent, since that's not a pattern genuine, unrelated
 *      customers produce.
 *
 * HONEST CAVEAT (same one docs/METHODOLOGY.md and ml_service/README.md
 * already flag for the existing device/IP blacklist): device_fingerprint
 * here is a hash of the User-Agent header only (see
 * routes/transactions.js's fingerprintDevice), not a real fingerprinting
 * library. Two genuinely unrelated users on the same browser/OS
 * combination WILL collide on this fingerprint. In production this
 * would sit behind a real fingerprinting signal (FingerprintJS-style, or
 * a commercial device-intelligence vendor) before being trusted as
 * strongly as it's used here; treat device-only edges as a weaker
 * signal than IP-only edges when triaging a ring by hand.
 *
 * PERFORMANCE CAVEAT: detectRings() rebuilds the whole graph from every
 * transaction row on every call. Fine at demo scale (thousands of
 * rows); a real deployment would precompute this on a schedule (or
 * incrementally, via a proper graph store) rather than on the request
 * path — see networkRiskForTransaction's doc comment below.
 */

const db = require('../config/database');

// A cluster this size or larger, even with zero confirmed fraud in it
// yet, is flagged as "watch" — unrelated genuine customers essentially
// never share a device/IP at this scale.
const RING_SIZE_ALERT_THRESHOLD = 4;

/** Simple union-find (disjoint set) over user ids. */
class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

async function loadIdentifierEdges() {
  const [deviceRows, ipRows] = await Promise.all([
    db.all(`SELECT DISTINCT user_id, device_fingerprint FROM transactions WHERE device_fingerprint IS NOT NULL`),
    db.all(`SELECT DISTINCT user_id, ip_address FROM transactions WHERE ip_address IS NOT NULL`),
  ]);
  return { deviceRows, ipRows };
}

/**
 * Same "confirmed fraud" definition transactionRepository.
 * fraudDeviceAndIpBlacklist uses, just grouped by account instead of by
 * device/IP — so the two stay in agreement about what counts as
 * confirmed fraud (an analyst's `confirmed_fraud` verdict, or a
 * still-unreversed `is_fraud=1` scoring).
 */
async function confirmedFraudUserIds() {
  const rows = await db.all(`
    SELECT DISTINCT t.user_id FROM transactions t
    LEFT JOIN alerts a ON a.transaction_id = t.id
    WHERE a.verdict = 'confirmed_fraud'
       OR (t.is_fraud = 1 AND (a.verdict IS NULL OR a.verdict != 'false_positive'))
  `);
  return new Set(rows.map((r) => r.user_id));
}

/**
 * Builds the full identifier-sharing graph and returns every cluster of
 * size >= minSize, annotated with its risk verdict. Used by the admin
 * "Fraud Rings" view (GET /api/admin/fraud-rings).
 */
async function detectRings({ minSize = 2 } = {}) {
  const [{ deviceRows, ipRows }, fraudUsers, users] = await Promise.all([
    loadIdentifierEdges(),
    confirmedFraudUserIds(),
    db.all(`SELECT id, username FROM users WHERE deleted_at IS NULL`),
  ]);

  const uf = new UnionFind();
  const byDevice = new Map();
  const byIp = new Map();

  for (const row of deviceRows) {
    uf.find(row.user_id);
    if (!byDevice.has(row.device_fingerprint)) byDevice.set(row.device_fingerprint, new Set());
    byDevice.get(row.device_fingerprint).add(row.user_id);
  }
  for (const row of ipRows) {
    uf.find(row.user_id);
    if (!byIp.has(row.ip_address)) byIp.set(row.ip_address, new Set());
    byIp.get(row.ip_address).add(row.user_id);
  }
  for (const members of byDevice.values()) {
    const arr = [...members];
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }
  for (const members of byIp.values()) {
    const arr = [...members];
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }

  const allUserIds = new Set([...deviceRows.map((r) => r.user_id), ...ipRows.map((r) => r.user_id)]);
  const clusters = new Map(); // root -> Set(user_id)
  for (const userId of allUserIds) {
    const root = uf.find(userId);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(userId);
  }

  const usernameById = new Map(users.map((u) => [u.id, u.username]));

  const rings = [];
  for (const [root, memberSet] of clusters) {
    if (memberSet.size < minSize) continue;

    const sharedDevices = [...byDevice.entries()]
      .filter(([, s]) => [...s].some((u) => memberSet.has(u)))
      .map(([d]) => d);
    const sharedIps = [...byIp.entries()]
      .filter(([, s]) => [...s].some((u) => memberSet.has(u)))
      .map(([ip]) => ip);
    const confirmedFraudMembers = [...memberSet].filter((u) => fraudUsers.has(u));

    rings.push({
      ring_id: `ring_${root}`,
      size: memberSet.size,
      members: [...memberSet].map((id) => ({ user_id: id, username: usernameById.get(id) || `user_${id}` })),
      shared_device_count: sharedDevices.length,
      shared_ip_count: sharedIps.length,
      confirmed_fraud_members: confirmedFraudMembers.map((id) => usernameById.get(id) || `user_${id}`),
      risk: confirmedFraudMembers.length > 0
        ? 'high'
        : memberSet.size >= RING_SIZE_ALERT_THRESHOLD
        ? 'watch'
        : 'low',
    });
  }

  return rings.sort((a, b) => b.size - a.size);
}

/**
 * Real-time signal for the fraud engine (see fraudEngine.js's
 * checkNetworkRisk). Checks whether THIS transaction's device_fingerprint
 * or ip_address ties `userId` into a cluster of other accounts — either
 * one it's already part of via history, or one it would newly join via
 * this transaction's own identifiers — and whether that cluster reaches
 * a confirmed-fraud account (possibly through an intermediary, not
 * necessarily directly).
 *
 * NOTE ON COST: this rebuilds the whole graph (detectRings) on every
 * call, which is the honest, simple version of this feature rather than
 * a falsely-impressive one — seedDemoData.js and realtime/simulator.js
 * deliberately do NOT call this (see their own comments) so bulk
 * seeding and the live-feed demo aren't slowed down by an O(all
 * transactions) rebuild on every single row. A real deployment would
 * cache/precompute the graph (e.g. rebuild on a short interval, or
 * maintain it incrementally in a real graph store) instead of doing
 * this per-request.
 */
async function networkRiskForTransaction(txn, userId) {
  // Delegates to the relationship layer: strong, hub-suppressed links only. The old
  // implementation below (any shared device/IP, rebuilt from every row, hard override on a
  // single hop) treated common/public identifiers as proof and is kept only as detectRings()
  // for the legacy admin listing.
  return require('../services/relationshipService').networkRiskForTransaction(txn, userId);
}

module.exports = { detectRings, networkRiskForTransaction, RING_SIZE_ALERT_THRESHOLD };
