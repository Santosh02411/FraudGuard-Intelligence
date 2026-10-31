/**
 * Relationship & fraud-ring analysis
 * ====================================
 * Finds groups of accounts that appear to be operated together, scores the group,
 * and lets an investigator expand from one transaction to everything around it.
 *
 * The central design problem is that shared identifiers are WEAK evidence:
 *   - a public/NAT/carrier/office IP is shared by many unrelated customers;
 *   - `device_fingerprint` is a hash of the User-Agent only, so everyone on the same
 *     browser + OS collides;
 *   - households share IPs and devices innocently.
 * So this module never lets one shared identifier create a cluster. It
 *   1. ignores private/loopback addresses (they say nothing across accounts),
 *   2. suppresses "common" identifiers used by more than N accounts (shared infrastructure),
 *   3. weights each remaining identifier by how few accounts share it,
 *   4. links two accounts into a cluster only when INDEPENDENT kinds of evidence agree
 *      (e.g. same IP and same device, or same IP and the same rare merchants),
 *      treating every single-identifier overlap as a "weak lead" shown but never clustered,
 *   5. scores clusters from corroborating behaviour (confirmed outcomes, bursts, card-testing
 *      patterns, accounts created together), and caps clusters that have topology only.
 * The result is a review priority with its reasons, never a verdict.
 */
const db = require("../config/database");
const config = require("../config/env");

const W = { ip: 0.5, device: 0.35, merchants: 0.3 };
const STRONG_MIN = 0.7; // pair strength needed to join a cluster
const RARE_MERCHANT_MAX_ACCOUNTS = 4;
const MIN_SHARED_RARE_MERCHANTS = 2;
const TOPOLOGY_ONLY_CAP = 44; // a cluster with no behavioural corroboration never reaches 'high'
const BANDS = { high: 60, watch: 30 };
const CREATED_TOGETHER_HOURS = 48;
const ROW_CAP = 310000;

let cache = null;

const num = (v) => Number(v);
const ts = (v) => {
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  return new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`).getTime();
};
const r2 = (x) => Math.round(x * 100) / 100;
const crowd = (k) => 1 / (1 + 0.08 * Math.max(0, k - 2)); // 2 sharers = full weight; each extra sharer discounts the evidence (IP+device alone stays strong up to 4 accounts)

/** Private, loopback, link-local and unspecified addresses identify a network, not a person. */
function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip)
    .replace(/^::ffff:/i, "")
    .toLowerCase();
  if (v === "::1" || v === "::" || v === "localhost") return true;
  if (/^(fc|fd|fe80)/.test(v)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

class UnionFind {
  constructor() {
    this.p = new Map();
  }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    let c = x;
    while (this.p.get(c) !== r) {
      const n = this.p.get(c);
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

function cutoffIso(days, now) {
  return new Date(now - days * 86400000).toISOString();
}
const dateCol = () =>
  db.dialect === "postgres"
    ? "t.created_at::timestamptz >= ?::timestamptz"
    : "t.created_at >= ?";

async function loadBase(days, now) {
  const cutoff = cutoffIso(days, now);
  const where = `t.is_synthetic = 0 AND ${dateCol()}`;
  const [devRows, ipRows, merRows, users, confirmed, flagged] =
    await Promise.all([
      db.all(
        `SELECT t.user_id, t.device_fingerprint AS v, COUNT(*) AS n FROM transactions t WHERE ${where} AND t.device_fingerprint IS NOT NULL GROUP BY t.user_id, t.device_fingerprint LIMIT ${ROW_CAP}`,
        [cutoff],
      ),
      db.all(
        `SELECT t.user_id, t.ip_address AS v, COUNT(*) AS n FROM transactions t WHERE ${where} AND t.ip_address IS NOT NULL GROUP BY t.user_id, t.ip_address LIMIT ${ROW_CAP}`,
        [cutoff],
      ),
      db.all(
        `SELECT t.user_id, t.merchant AS v, COUNT(*) AS n FROM transactions t WHERE ${where} GROUP BY t.user_id, t.merchant LIMIT ${ROW_CAP}`,
        [cutoff],
      ),
      db.all(
        "SELECT id, username, created_at FROM users WHERE deleted_at IS NULL",
      ),
      db.all(
        `SELECT DISTINCT t.user_id FROM alerts a JOIN transactions t ON t.id = a.transaction_id WHERE a.verdict = 'confirmed_fraud'`,
      ),
      db.all(
        `SELECT t.user_id, COUNT(*) AS n FROM alerts a JOIN transactions t ON t.id = a.transaction_id WHERE a.resolved = 0 AND ${where} GROUP BY t.user_id`,
        [cutoff],
      ),
    ]);
  return {
    devRows,
    ipRows,
    merRows,
    users,
    confirmed: new Set(confirmed.map((r) => r.user_id)),
    flagged: new Map(flagged.map((r) => [r.user_id, num(r.n)])),
  };
}

function invert(rows) {
  // value -> Map(user -> count)
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.v)) m.set(r.v, new Map());
    m.get(r.v).set(r.user_id, num(r.n));
  }
  return m;
}

/** Builds identifier maps, suppression decisions, per-pair evidence and strong clusters. */
let inflight = null;
/** Cached for a short TTL; concurrent callers during a rebuild share one build instead of stampeding the database. */
async function buildIndex(opts = {}) {
  const days = opts.days || config.relationships.windowDays;
  const now = opts.now || Date.now();
  const ttl = config.relationships.cacheTtlMs;
  if (ttl > 0 && cache && cache.days === days && now - cache.builtAt < ttl)
    return cache.index;
  if (ttl > 0 && inflight && inflight.days === days) return inflight.promise;
  const promise = buildIndexUncached({ days, now });
  if (ttl > 0) {
    inflight = { days, promise };
    promise
      .finally(() => {
        if (inflight && inflight.promise === promise) inflight = null;
      })
      .catch(() => {});
  }
  return promise;
}

async function buildIndexUncached({ days, now }) {
  const ttl = config.relationships.cacheTtlMs;
  const base = await loadBase(days, now);
  const commonMax = config.relationships.commonMaxAccounts;
  const byDevice = invert(base.devRows);
  const byIp = invert(base.ipRows);
  const byMerchant = invert(base.merRows);

  const suppressed = { ip: [], device: [] };
  const evidence = new Map(); // "a|b" -> { a, b, items: [{type,value,accounts}] }
  const addEv = (accounts, type, value, k) => {
    const ids = [...accounts].sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`;
        if (!evidence.has(key))
          evidence.set(key, { a: ids[i], b: ids[j], items: [] });
        evidence.get(key).items.push({ type, value, accounts: k });
      }
  };
  for (const [v, users] of byIp) {
    if (isPrivateIp(v)) continue;
    if (users.size > commonMax) {
      suppressed.ip.push({ value: v, accounts: users.size });
      continue;
    }
    if (users.size >= 2) addEv(users.keys(), "ip", v, users.size);
  }
  for (const [v, users] of byDevice) {
    if (users.size > commonMax) {
      suppressed.device.push({ value: v, accounts: users.size });
      continue;
    }
    if (users.size >= 2) addEv(users.keys(), "device", v, users.size);
  }
  // rare merchants: pair evidence only counts when at least MIN_SHARED_RARE_MERCHANTS are shared
  const merchantPairs = new Map();
  for (const [v, users] of byMerchant) {
    if (users.size < 2 || users.size > RARE_MERCHANT_MAX_ACCOUNTS) continue;
    const ids = [...users.keys()].sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`;
        if (!merchantPairs.has(key))
          merchantPairs.set(key, { a: ids[i], b: ids[j], merchants: [] });
        merchantPairs
          .get(key)
          .merchants.push({ value: v, accounts: users.size });
      }
  }
  for (const [key, mp] of merchantPairs) {
    if (mp.merchants.length < MIN_SHARED_RARE_MERCHANTS) continue;
    if (!evidence.has(key)) evidence.set(key, { a: mp.a, b: mp.b, items: [] });
    evidence
      .get(key)
      .items.push({
        type: "merchants",
        value: mp.merchants.map((m) => m.value),
        accounts: Math.max(...mp.merchants.map((m) => m.accounts)),
      });
  }

  const links = [];
  const uf = new UnionFind();
  for (const e of evidence.values()) {
    const byType = new Map();
    for (const it of e.items)
      byType.set(
        it.type,
        Math.max(byType.get(it.type) || 0, W[it.type] * crowd(it.accounts)),
      );
    const strength = Math.min(
      1,
      [...byType.values()].reduce((s, x) => s + x, 0),
    );
    const types = [...byType.keys()];
    const strong = strength >= STRONG_MIN && types.length >= 2;
    links.push({
      a: e.a,
      b: e.b,
      strength: r2(strength),
      types,
      items: e.items,
      strong,
    });
    if (strong) uf.union(e.a, e.b);
  }

  const strongMembers = new Set();
  for (const l of links)
    if (l.strong) {
      strongMembers.add(l.a);
      strongMembers.add(l.b);
    }
  const groups = new Map();
  for (const u of strongMembers) {
    const root = uf.find(u);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(u);
  }
  const userById = new Map(base.users.map((u) => [u.id, u]));
  const clusters = [...groups.values()]
    .filter((g) => g.size >= 2)
    .map((g) => {
      const ids = [...g].sort((x, y) => x - y);
      return { id: `c${ids[0]}`, members: ids };
    });
  const clusterOf = new Map();
  clusters.forEach((c) => c.members.forEach((u) => clusterOf.set(u, c)));

  const index = {
    days,
    base,
    byDevice,
    byIp,
    byMerchant,
    suppressed,
    links,
    clusters,
    clusterOf,
    userById,
    builtAt: now,
  };
  if (ttl > 0) cache = { days, builtAt: now, index };
  return index;
}

function invalidate() {
  cache = null;
  inflight = null;
}

/** Sliding-window helpers over time-sorted arrays. */
function maxWindow(sorted, windowMs, scoreFn) {
  let best = null;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi].t - sorted[lo].t > windowMs) lo += 1;
    const slice = sorted.slice(lo, hi + 1);
    const s = scoreFn(slice);
    if (s && (!best || s.rank > best.rank))
      best = {
        ...s,
        start: new Date(sorted[lo].t).toISOString(),
        end: new Date(sorted[hi].t).toISOString(),
      };
  }
  return best;
}

async function memberTransactions(userIds, days, now) {
  if (!userIds.length) return [];
  return db.all(
    `SELECT t.id, t.user_id, t.amount, t.merchant, t.created_at, t.is_fraud FROM transactions t
      WHERE t.is_synthetic = 0 AND ${dateCol()} AND t.user_id IN (${userIds.map(() => "?").join(",")}) ORDER BY t.created_at LIMIT 20000`,
    [cutoffIso(days, now), ...userIds],
  );
}

function detectBurst(txns) {
  const rows = txns.map((t) => ({ t: ts(t.created_at), u: t.user_id }));
  const best = maxWindow(
    rows,
    config.relationships.burstWindowMin * 60000,
    (slice) => {
      const accounts = new Set(slice.map((x) => x.u)).size;
      return slice.length >= config.relationships.burstMinTxns && accounts >= 2
        ? { txns: slice.length, accounts, rank: slice.length }
        : null;
    },
  );
  return best;
}

/** Card-testing style: many tiny transactions by one account in a short window. */
function detectSmallRepeats(txns) {
  const byUser = new Map();
  for (const t of txns) {
    if (num(t.amount) > config.relationships.smallAmount) continue;
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser
      .get(t.user_id)
      .push({ t: ts(t.created_at), m: t.merchant, a: num(t.amount) });
  }
  const out = [];
  for (const [userId, rows] of byUser) {
    rows.sort((x, y) => x.t - y.t);
    const best = maxWindow(
      rows,
      config.relationships.smallWindowMin * 60000,
      (slice) =>
        slice.length >= config.relationships.smallMinCount
          ? {
              txns: slice.length,
              merchants: new Set(slice.map((x) => x.m)).size,
              total: r2(slice.reduce((s, x) => s + x.a, 0)),
              rank: slice.length,
            }
          : null,
    );
    if (best) out.push({ user_id: userId, ...best });
  }
  return out;
}

function scoreCluster({
  size,
  confirmedMembers,
  flaggedMembers,
  avgStrength,
  burst,
  small,
  createdTogether,
}) {
  const parts = [];
  const add = (points, reason) => {
    if (points > 0) parts.push({ points: Math.round(points), reason });
  };
  if (confirmedMembers > 0)
    add(
      30 + 15 * (confirmedMembers / size),
      `${confirmedMembers} of ${size} accounts have analyst-confirmed fraud`,
    );
  if (size >= 8) add(18, `${size} accounts strongly linked`);
  else if (size >= 5) add(14, `${size} accounts strongly linked`);
  else if (size >= 3) add(8, `${size} accounts strongly linked`);
  add(avgStrength * 10, `average link strength ${r2(avgStrength)}`);
  if (burst)
    add(
      15,
      `coordinated burst: ${burst.txns} transactions from ${burst.accounts} accounts within ${config.relationships.burstWindowMin} minutes`,
    );
  if (small.length)
    add(12, `repeated small transactions on ${small.length} account(s)`);
  if (createdTogether)
    add(
      10,
      `${createdTogether} accounts created within ${CREATED_TOGETHER_HOURS}h of each other`,
    );
  if (flaggedMembers > 0)
    add(
      10 * (flaggedMembers / size),
      `${flaggedMembers} accounts have unresolved alerts`,
    );
  const corroborated =
    confirmedMembers > 0 ||
    burst ||
    small.length ||
    createdTogether ||
    flaggedMembers > 0;
  let score = Math.min(
    100,
    parts.reduce((s, p) => s + p.points, 0),
  );
  if (!corroborated) {
    score = Math.min(score, TOPOLOGY_ONLY_CAP);
    parts.push({
      points: 0,
      reason:
        "shared infrastructure only: no behavioural corroboration, so the score is capped",
    });
  }
  const band =
    score >= BANDS.high ? "high" : score >= BANDS.watch ? "watch" : "low";
  return {
    score,
    band,
    corroborated: Boolean(corroborated),
    components: parts,
  };
}

async function describeCluster(index, cluster, { now = Date.now() } = {}) {
  const { base, links, userById } = index;
  const members = cluster.members;
  const memberSet = new Set(members);
  const txns = await memberTransactions(members, index.days, now);
  const perUser = new Map(
    members.map((u) => [u, { transactions: 0, amount: 0 }]),
  );
  for (const t of txns) {
    const p = perUser.get(t.user_id);
    p.transactions += 1;
    p.amount += num(t.amount);
  }
  const strongLinks = links.filter(
    (l) => l.strong && memberSet.has(l.a) && memberSet.has(l.b),
  );
  const weakLeads = links
    .filter((l) => !l.strong && memberSet.has(l.a) !== memberSet.has(l.b))
    .slice(0, 30);
  const burst = detectBurst(txns);
  const small = detectSmallRepeats(txns).filter((s) =>
    memberSet.has(s.user_id),
  );
  const created = members
    .map((u) => ts(userById.get(u)?.created_at))
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  let createdTogether = 0;
  for (let lo = 0, hi = 0; hi < created.length; hi++) {
    while (created[hi] - created[lo] > CREATED_TOGETHER_HOURS * 3600000)
      lo += 1;
    createdTogether = Math.max(createdTogether, hi - lo + 1);
  }
  if (createdTogether < 3) createdTogether = 0;
  const confirmedMembers = members.filter((u) => base.confirmed.has(u));
  const flaggedMembers = members.filter((u) => (base.flagged.get(u) || 0) > 0);
  const avgStrength = strongLinks.length
    ? strongLinks.reduce((s, l) => s + l.strength, 0) / strongLinks.length
    : 0;
  const sc = scoreCluster({
    size: members.length,
    confirmedMembers: confirmedMembers.length,
    flaggedMembers: flaggedMembers.length,
    avgStrength,
    burst,
    small,
    createdTogether,
  });

  const sharedIps = new Map();
  const sharedDevices = new Map();
  for (const l of strongLinks)
    for (const it of l.items) {
      if (it.type === "ip") sharedIps.set(it.value, it.accounts);
      if (it.type === "device") sharedDevices.set(it.value, it.accounts);
    }
  const alerts = txns.length
    ? await db.all(
        `SELECT a.id, a.transaction_id FROM alerts a WHERE a.user_id IN (${members.map(() => "?").join(",")}) AND a.resolved = 0 ORDER BY a.id LIMIT 200`,
        members,
      )
    : [];

  return {
    cluster_id: cluster.id,
    size: members.length,
    risk_score: sc.score,
    risk_band: sc.band,
    corroborated: sc.corroborated,
    reasons: sc.components.map((c) => c.reason),
    score_components: sc.components,
    members: members.map((u) => ({
      user_id: u,
      username: userById.get(u)?.username || `user_${u}`,
      transactions: perUser.get(u).transactions,
      amount: r2(perUser.get(u).amount),
      confirmed_fraud: base.confirmed.has(u),
      unresolved_alerts: base.flagged.get(u) || 0,
    })),
    exposure_amount: r2(
      [...perUser.values()].reduce((s, p) => s + p.amount, 0),
    ),
    links: strongLinks
      .map((l) => ({ a: l.a, b: l.b, strength: l.strength, evidence: l.types }))
      .slice(0, 100),
    shared_ips: [...sharedIps].map(([value, accounts]) => ({
      value,
      accounts,
    })),
    shared_devices: [...sharedDevices].map(([value, accounts]) => ({
      value,
      accounts,
    })),
    weak_leads: weakLeads.map((l) => ({
      a: l.a,
      b: l.b,
      strength: l.strength,
      evidence: l.types,
    })),
    signals: {
      burst,
      repeated_small: small,
      accounts_created_together: createdTogether || null,
    },
    open_alert_ids: alerts.map((a) => a.id),
    open_alert_transaction_ids: alerts.map((a) => a.transaction_id),
    caveats: [
      "A review priority, not a finding of fraud. Shared IPs and devices have innocent explanations (households, offices, carriers, common browsers).",
      `Identifiers used by more than ${config.relationships.commonMaxAccounts} accounts are ignored as shared infrastructure; two accounts are only clustered when independent kinds of evidence agree.`,
    ],
  };
}

async function clusters({
  days = config.relationships.windowDays,
  minScore = 0,
  limit = 25,
  now = Date.now(),
} = {}) {
  const index = await buildIndex({ days, now });
  const out = [];
  for (const c of index.clusters)
    out.push(await describeCluster(index, c, { now }));
  const filtered = out
    .filter((c) => c.risk_score >= minScore)
    .sort((a, b) => b.risk_score - a.risk_score || b.size - a.size);
  return {
    window_days: days,
    generated_at: new Date(now).toISOString(),
    total: filtered.length,
    clusters: filtered.slice(0, limit),
    suppressed_identifiers: {
      ips: index.suppressed.ip.length,
      devices: index.suppressed.device.length,
      note: `used by more than ${config.relationships.commonMaxAccounts} accounts each; ignored as links`,
    },
  };
}

async function clusterById(id, opts = {}) {
  const now = opts.now || Date.now();
  const index = await buildIndex({
    days: opts.days || config.relationships.windowDays,
    now,
  });
  const c = index.clusters.find((x) => x.id === id);
  return c ? describeCluster(index, c, { now }) : null;
}

/** Account-level signals, independent of clustering: repeated small transactions across the whole population. */
async function accountSignals({
  days = config.relationships.windowDays,
  now = Date.now(),
} = {}) {
  const rows = await db.all(
    `SELECT t.id, t.user_id, t.amount, t.merchant, t.created_at FROM transactions t WHERE t.is_synthetic = 0 AND t.amount <= ? AND ${dateCol()} ORDER BY t.user_id, t.created_at LIMIT ${ROW_CAP}`,
    [config.relationships.smallAmount, cutoffIso(days, now)],
  );
  const found = detectSmallRepeats(rows);
  const users = found.length
    ? await db.all(
        `SELECT id, username FROM users WHERE id IN (${found.map(() => "?").join(",")})`,
        found.map((f) => f.user_id),
      )
    : [];
  const name = new Map(users.map((u) => [u.id, u.username]));
  return {
    window_days: days,
    repeated_small: found
      .sort((a, b) => b.txns - a.txns)
      .slice(0, 100)
      .map((f) => ({
        ...f,
        username: name.get(f.user_id) || `user_${f.user_id}`,
      })),
    definition: `${config.relationships.smallMinCount}+ transactions of $${config.relationships.smallAmount} or less within ${config.relationships.smallWindowMin} minutes`,
  };
}

/**
 * Live-scoring signal (replaces the old "any shared identifier" ring check). Considers only strong,
 * hub-suppressed links, including the link THIS transaction would create. Returns the shape
 * fraudEngine.checkNetworkRisk expects. By default it never hard-overrides: it adds risk and a reason.
 */
async function networkRiskForTransaction(
  txn,
  userId,
  { now = Date.now() } = {},
) {
  if (!txn.device_fingerprint && !txn.ip_address)
    return { triggered: false, hardOverride: false, ring: null };
  const index = await buildIndex({ now });
  const mine = index.clusterOf.get(userId);
  let memberIds = mine ? new Set(mine.members) : new Set([userId]);

  // would this transaction link the account to someone new? only if BOTH an IP and a device are shared
  const ip =
    txn.ip_address && !isPrivateIp(txn.ip_address) ? txn.ip_address : null;
  const ipUsers = ip
    ? new Set(
        [...(index.byIp.get(ip)?.keys() || [])].filter((u) => u !== userId),
      )
    : new Set();
  const devUsers = txn.device_fingerprint
    ? new Set(
        [...(index.byDevice.get(txn.device_fingerprint)?.keys() || [])].filter(
          (u) => u !== userId,
        ),
      )
    : new Set();
  const ipCrowd = ipUsers.size + 1;
  const devCrowd = devUsers.size + 1;
  if (
    ip &&
    ipCrowd <= config.relationships.commonMaxAccounts &&
    devCrowd <= config.relationships.commonMaxAccounts
  ) {
    for (const o of ipUsers) {
      if (!devUsers.has(o)) continue;
      const strength = W.ip * crowd(ipCrowd) + W.device * crowd(devCrowd);
      if (strength >= STRONG_MIN) {
        const oc = index.clusterOf.get(o);
        (oc ? oc.members : [o]).forEach((m) => memberIds.add(m));
      }
    }
  }
  if (memberIds.size < 2)
    return { triggered: false, hardOverride: false, ring: null };
  const confirmed = [...memberIds].filter(
    (u) => index.base.confirmed.has(u) && u !== userId,
  );
  const names = (ids) =>
    ids.map((u) => index.userById.get(u)?.username || `user_${u}`);
  const large = memberIds.size >= 4;
  return {
    triggered: confirmed.length > 0 || large,
    hardOverride: confirmed.length > 0 && config.relationships.hardOverride,
    ring: { size: memberIds.size, confirmed_fraud_members: names(confirmed) },
  };
}

/**
 * Expand from a transaction or account: accounts <-> devices/IPs <-> accounts, `depth` hops.
 * Common/private identifiers are drawn but never expanded (they would pull in strangers).
 */
async function graph({
  transactionId,
  userId,
  depth = 1,
  maxNodes = 120,
  now = Date.now(),
}) {
  const index = await buildIndex({ now });
  let seedTxn = null;
  if (transactionId) {
    seedTxn = await db.get(
      "SELECT id, user_id, amount, merchant, device_fingerprint, ip_address, created_at, fraud_score, risk_level FROM transactions WHERE id = ?",
      [transactionId],
    );
    if (!seedTxn) return null;
    userId = seedTxn.user_id;
  }
  if (!index.userById.has(userId)) return null;
  const commonMax = config.relationships.commonMaxAccounts;
  const nodes = new Map();
  const edges = [];
  let truncated = false;
  const addNode = (n) => {
    if (nodes.has(n.id)) return true;
    if (nodes.size >= maxNodes) {
      truncated = true;
      return false;
    }
    nodes.set(n.id, n);
    return true;
  };
  const accountNode = (u, level) => {
    const user = index.userById.get(u);
    return {
      id: `u${u}`,
      type: "account",
      user_id: u,
      label: user?.username || `user_${u}`,
      level,
      confirmed_fraud: index.base.confirmed.has(u),
      unresolved_alerts: index.base.flagged.get(u) || 0,
      cluster_id: index.clusterOf.get(u)?.id || null,
    };
  };
  // Build reverse indexes once so expansion is O(identifiers of the account), not O(all identifiers)
  const userIds = new Map();
  for (const [v, users] of index.byIp)
    for (const u of users.keys()) {
      if (!userIds.has(u)) userIds.set(u, []);
      userIds.get(u).push({ type: "ip", value: v, users });
    }
  for (const [v, users] of index.byDevice)
    for (const u of users.keys()) {
      if (!userIds.has(u)) userIds.set(u, []);
      userIds.get(u).push({ type: "device", value: v, users });
    }

  addNode({ ...accountNode(userId, 0), seed: true });
  if (seedTxn) {
    addNode({
      id: `t${seedTxn.id}`,
      type: "transaction",
      label: `Txn #${seedTxn.id} $${Number(seedTxn.amount).toFixed(2)}`,
      level: 0,
      risk_level: seedTxn.risk_level,
      seed: true,
    });
    edges.push({ from: `t${seedTxn.id}`, to: `u${userId}`, type: "made_by" });
  }
  let frontier = [userId];
  const expanded = new Set();
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next = [];
    for (const u of frontier) {
      if (expanded.has(u)) continue;
      expanded.add(u);
      const base = [...(userIds.get(u) || [])];
      if (seedTxn && u === userId) {
        // the seed transaction's own identifiers are always included, even if only this once
        if (
          seedTxn.ip_address &&
          !base.some((b) => b.type === "ip" && b.value === seedTxn.ip_address)
        )
          base.push({
            type: "ip",
            value: seedTxn.ip_address,
            users: new Map([[u, 1]]),
          });
        if (
          seedTxn.device_fingerprint &&
          !base.some(
            (b) =>
              b.type === "device" && b.value === seedTxn.device_fingerprint,
          )
        )
          base.push({
            type: "device",
            value: seedTxn.device_fingerprint,
            users: new Map([[u, 1]]),
          });
      }
      for (const id of base) {
        const priv = id.type === "ip" && isPrivateIp(id.value);
        const common = id.users.size > commonMax;
        const nid = `${id.type[0]}:${id.value}`;
        if (
          !addNode({
            id: nid,
            type: id.type,
            label:
              id.type === "device"
                ? `${String(id.value).slice(0, 6)}…`
                : id.value,
            level,
            accounts: id.users.size,
            common: common || priv,
            private: priv,
            note: priv
              ? "private/loopback address: not linking"
              : common
                ? `used by ${id.users.size} accounts: shared infrastructure, not expanded`
                : undefined,
          })
        )
          continue;
        edges.push({
          from: `u${u}`,
          to: nid,
          type: "uses",
          transactions: id.users.get(u),
        });
        if (common || priv) continue;
        for (const other of id.users.keys()) {
          if (other === u) continue;
          if (!addNode(accountNode(other, level))) continue;
          edges.push({
            from: `u${other}`,
            to: nid,
            type: "uses",
            transactions: id.users.get(other),
          });
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const shown = new Set(
    [...nodes.values()]
      .filter((n) => n.type === "account")
      .map((n) => n.user_id),
  );
  const linkEdges = index.links
    .filter((l) => shown.has(l.a) && shown.has(l.b))
    .map((l) => ({
      from: `u${l.a}`,
      to: `u${l.b}`,
      type: l.strong ? "strong_link" : "weak_lead",
      strength: l.strength,
      evidence: l.types,
    }));
  const cl = index.clusterOf.get(userId);
  return {
    seed: seedTxn
      ? { transaction_id: seedTxn.id, user_id: userId }
      : { user_id: userId },
    depth,
    nodes: [...nodes.values()],
    edges: [...edges, ...linkEdges],
    truncated,
    cluster: cl ? await describeCluster(index, cl, { now }) : null,
    cautions: [
      "Dashed lines are weak leads (a single shared identifier); solid lines are strong links backed by independent evidence.",
      "Identifiers used by many accounts and private addresses are shown but not expanded.",
    ],
  };
}

module.exports = {
  buildIndex,
  invalidate,
  clusters,
  clusterById,
  accountSignals,
  networkRiskForTransaction,
  graph,
  isPrivateIp,
  scoreCluster,
  detectBurst,
  detectSmallRepeats,
  constants: { W, STRONG_MIN, BANDS, TOPOLOGY_ONLY_CAP },
};
