const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';

async function registerAndLogin(username) {
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password });
  return res.body.accessToken;
}

async function loginAdmin() {
  const res = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  return res.body.accessToken;
}

async function createAlertFor(token) {
  const txnRes = await request(app).post(`${API}/transactions`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 5000, merchant: 'Risky Merchant', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });
  const list = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`);
  const alertId = list.body.alerts.find((a) => a.transaction_id === txnRes.body.transaction.id)?.id;
  return { alertId, txnId: txnRes.body.transaction.id };
}

describe('Alerts — view, resolve, ownership, audit trail', () => {
  let ownerToken;
  let otherUserToken;
  let adminToken;
  let alertId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('alert_owner');
    otherUserToken = await registerAndLogin('alert_stranger');
    adminToken = await loginAdmin();

    const created = await createAlertFor(ownerToken);
    alertId = created.alertId;
    expect(alertId).toBeDefined();
  });

  test('the owner can view their own alert', async () => {
    const res = await request(app).get(`${API}/alerts/${alertId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.alert.id).toBe(alertId);
    expect(res.body.alert.status).toBe('open');
  });

  test('a different user cannot view someone else\'s alert', async () => {
    const res = await request(app).get(`${API}/alerts/${alertId}`).set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(403);
  });

  test('an admin can view any alert', async () => {
    const res = await request(app).get(`${API}/alerts/${alertId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  test('viewing a non-existent alert returns 404', async () => {
    const res = await request(app).get(`${API}/alerts/99999999`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('resolving without a verdict is rejected — verdict is required, not optional', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/resolve`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(400);
  });

  test('a different user cannot resolve someone else\'s alert', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/resolve`)
      .set('Authorization', `Bearer ${otherUserToken}`)
      .send({ verdict: 'confirmed_fraud' });
    expect(res.status).toBe(403);
  });

  test('the owner can resolve their own alert with a verdict and note', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ verdict: 'confirmed_fraud', note: 'Card reported stolen by cardholder.' });
    expect(res.status).toBe(200);
    expect(res.body.alert.status).toBe('resolved');
    expect(res.body.alert.verdict).toBe('confirmed_fraud');
    expect(res.body.alert.resolution_note).toBe('Card reported stolen by cardholder.');
    expect(res.body.alert.resolved_by).toBeTruthy();
    expect(res.body.alert.resolved_at).toBeTruthy();
  });

  test('the audit trail records the view and the resolve (with verdict), with who and when', async () => {
    const res = await request(app).get(`${API}/admin/audit-logs/alert/${alertId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const actions = res.body.logs.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['alerts.view', 'alerts.resolve']));
    const resolveLog = res.body.logs.find((l) => l.action === 'alerts.resolve');
    expect(resolveLog.details).toMatchObject({ verdict: 'confirmed_fraud', hasNote: true });
    for (const log of res.body.logs) {
      expect(log.username).toBeTruthy();
      expect(log.created_at).toBeTruthy();
    }
  });
});

describe('Alerts — false-positive verdict removes the device/IP from the dynamic blacklist', () => {
  // fingerprintDevice() (routes/transactions.js) hashes only the
  // User-Agent header, and clientIp() reads X-Forwarded-For before
  // falling back to the socket address — so within one test file every
  // request would otherwise share the same "device" (supertest's
  // default UA, and the same loopback IP), including with transactions
  // created by earlier describe blocks in this file. Setting a unique
  // User-Agent + X-Forwarded-For per test gives each scenario its own
  // isolated device/IP identity, exactly like two genuinely different
  // devices in production — without this, the earlier "resolve with
  // confirmed_fraud" test above would permanently poison the blacklist
  // for every test that runs after it in this file.
  function withDevice(req, label) {
    return req.set('User-Agent', `jest-${label}`).set('X-Forwarded-For', `10.0.0.${Math.floor(Math.random() * 254) + 1}`);
  }

  test('a device flagged is_fraud=1, then marked false_positive, no longer trips the hard-rule blacklist', async () => {
    const token = await registerAndLogin('alert_fp_user');
    const device = 'fp-device';

    // First transaction: scores high risk (large amount + high-risk
    // location + prepaid) on its own merits — not via the blacklist —
    // creating an alert and putting its device/IP fingerprint on the
    // dynamic blacklist.
    const first = await withDevice(request(app).post(`${API}/transactions`), device)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, merchant: 'Some Shop', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });
    expect(first.body.transaction.risk_level).toBe('high');

    const list = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`);
    const alertId = list.body.alerts.find((a) => a.transaction_id === first.body.transaction.id)?.id;
    expect(alertId).toBeDefined();

    // Before creating any further transactions, an analyst reviews the
    // alert and marks it a false positive — this should remove the
    // device/IP from the blacklist going forward. (Resolving it now,
    // rather than after a second high-risk transaction exists, isolates
    // what this test is actually checking: an unresolved is_fraud=1
    // transaction sharing the same device would independently keep the
    // blacklist hit alive regardless of this alert's verdict.)
    await request(app).patch(`${API}/alerts/${alertId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ verdict: 'false_positive', note: 'Verified with cardholder — legitimate purchase.' });

    // A second transaction from the same simulated device (same
    // User-Agent/X-Forwarded-For as the first) with otherwise ordinary
    // fields should NOT be hard-flagged, now that the only prior
    // high-risk transaction on this device has been confirmed a false
    // positive.
    const second = await withDevice(request(app).post(`${API}/transactions`), device)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 15, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect(second.body.transaction.risk_level).not.toBe('high');
    expect(second.body.transaction.scoring_method).not.toMatch(/hard_rule_override/);
  });

  test('a device flagged is_fraud=1 stays on the blacklist until an analyst reviews it', async () => {
    const token = await registerAndLogin('alert_unresolved_user');
    const device = 'unresolved-device';

    const first = await withDevice(request(app).post(`${API}/transactions`), device)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, merchant: 'Some Shop', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });
    expect(first.body.transaction.risk_level).toBe('high');

    // No resolution yet — the second transaction, sharing the same
    // simulated device, should still be caught by the dynamic blacklist.
    const second = await withDevice(request(app).post(`${API}/transactions`), device)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 15, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect(second.body.transaction.risk_level).toBe('high');
    expect(second.body.transaction.scoring_method).toMatch(/hard_rule_override/);
  });
});

describe('Alerts — assignment (case management)', () => {
  let adminToken;
  let secondAdminToken;
  let regularUserToken;
  let alertOwnerToken;
  let alertId;

  beforeAll(async () => {
    adminToken = await loginAdmin();
    regularUserToken = await registerAndLogin('assign_regular_user');
    alertOwnerToken = await registerAndLogin('assign_alert_owner');

    // Promote a second regular user to admin so we have a legitimate assignee.
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${regularUserToken}`);
    await request(app).patch(`${API}/admin/users/${meRes.body.user.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });
    const reloggedIn = await request(app).post(`${API}/auth/login`).send({ username: 'assign_regular_user', password: 'Str0ng!Passw0rd1' });
    secondAdminToken = reloggedIn.body.accessToken;

    const created = await createAlertFor(alertOwnerToken);
    alertId = created.alertId;
  });

  test('a non-admin cannot assign an alert', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/assign`)
      .set('Authorization', `Bearer ${alertOwnerToken}`)
      .send({ assigneeId: 1 });
    expect(res.status).toBe(403);
  });

  test('cannot assign an alert to a non-admin user', async () => {
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${alertOwnerToken}`);
    const res = await request(app).patch(`${API}/alerts/${alertId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigneeId: meRes.body.user.id });
    expect(res.status).toBe(400);
  });

  test('an admin can assign an alert to another admin, moving it to in_review', async () => {
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${secondAdminToken}`);
    const res = await request(app).patch(`${API}/alerts/${alertId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigneeId: meRes.body.user.id });
    expect(res.status).toBe(200);
    expect(res.body.alert.status).toBe('in_review');
    expect(res.body.alert.assigned_to).toBe(meRes.body.user.id);
    expect(res.body.alert.assignee_username).toBe('assign_regular_user');
  });

  test('unassigning (assigneeId: null) moves it back to open', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigneeId: null });
    expect(res.status).toBe(200);
    expect(res.body.alert.status).toBe('open');
    expect(res.body.alert.assigned_to).toBeFalsy();
  });

  test('assigning to a non-existent user returns 404', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigneeId: 99999999 });
    expect(res.status).toBe(404);
  });
});

describe('GET /alerts — pagination and filters', () => {
  test('accepts page/limit and returns pagination metadata', async () => {
    const token = await registerAndLogin('alerts_pagination_user');
    const res = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`).query({ page: 1, limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 5 });
  });

  test('filters by status', async () => {
    const token = await registerAndLogin('alerts_filter_status_user');
    const { alertId } = await createAlertFor(token);
    await request(app).patch(`${API}/alerts/${alertId}/resolve`).set('Authorization', `Bearer ${token}`).send({ verdict: 'confirmed_fraud' });

    const openRes = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`).query({ status: 'open' });
    expect(openRes.body.alerts.some((a) => a.id === alertId)).toBe(false);

    const resolvedRes = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`).query({ status: 'resolved' });
    expect(resolvedRes.body.alerts.some((a) => a.id === alertId)).toBe(true);
  });

  test('filters by riskLevel', async () => {
    const token = await registerAndLogin('alerts_filter_risk_user');
    await createAlertFor(token);
    const res = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`).query({ riskLevel: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.alerts.every((a) => a.risk_level === 'high')).toBe(true);
  });

  test('rejects an invalid status filter', async () => {
    const token = await registerAndLogin('alerts_filter_invalid_user');
    const res = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`).query({ status: 'not-a-status' });
    expect(res.status).toBe(400);
  });
});

describe('GET /alerts/export — CSV export', () => {
  test('requires auth', async () => {
    const res = await request(app).get(`${API}/alerts/export`);
    expect(res.status).toBe(401);
  });

  test('returns CSV with a header row and includes the alert message', async () => {
    const token = await registerAndLogin('export_alert_user1');
    await createAlertFor(token);

    const res = await request(app).get(`${API}/alerts/export`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('ID,Date,User,Merchant,Amount,Risk Level,Status,Verdict,Assigned To,Resolution Note,Message');
    expect(lines.length).toBeGreaterThan(1);
  });

  test('a regular user cannot see another user\'s alerts in their export', async () => {
    const tokenA = await registerAndLogin('export_alert_user2');
    const tokenB = await registerAndLogin('export_alert_user3');
    await createAlertFor(tokenA);

    const res = await request(app).get(`${API}/alerts/export`).set('Authorization', `Bearer ${tokenB}`);
    const lines = res.text.trim().split('\r\n');
    expect(lines.length).toBe(1); // header only
  });
});

describe('PATCH /alerts/bulk-resolve — bulk actions', () => {
  test('rejects an empty alertIds array', async () => {
    const token = await registerAndLogin('bulk_empty_user');
    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [], verdict: 'confirmed_fraud' });
    expect(res.status).toBe(400);
  });

  test('rejects more than 100 alertIds', async () => {
    const token = await registerAndLogin('bulk_toomany_user');
    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: Array.from({ length: 101 }, (_, i) => i + 1), verdict: 'confirmed_fraud' });
    expect(res.status).toBe(400);
  });

  test('rejects a missing verdict', async () => {
    const token = await registerAndLogin('bulk_noverdict_user');
    const { alertId } = await createAlertFor(token);
    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [alertId] });
    expect(res.status).toBe(400);
  });

  test('resolves every alert in the batch with the same verdict and note', async () => {
    const token = await registerAndLogin('bulk_success_user');
    const a1 = await createAlertFor(token);
    const a2 = await createAlertFor(token);
    const a3 = await createAlertFor(token);

    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [a1.alertId, a2.alertId, a3.alertId], verdict: 'false_positive', note: 'Batch cleared after fraud team review.' });

    expect(res.status).toBe(200);
    expect(res.body.resolvedCount).toBe(3);

    for (const { alertId } of [a1, a2, a3]) {
      const check = await request(app).get(`${API}/alerts/${alertId}`).set('Authorization', `Bearer ${token}`);
      expect(check.body.alert.status).toBe('resolved');
      expect(check.body.alert.verdict).toBe('false_positive');
      expect(check.body.alert.resolution_note).toBe('Batch cleared after fraud team review.');
    }
  });

  test('deduplicates repeated ids in the request', async () => {
    const token = await registerAndLogin('bulk_dedupe_user');
    const { alertId } = await createAlertFor(token);
    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [alertId, alertId, alertId], verdict: 'confirmed_fraud' });
    expect(res.status).toBe(200);
    expect(res.body.resolvedCount).toBe(1);
  });

  test('rejects the whole batch (resolving nothing) if any id does not exist', async () => {
    const token = await registerAndLogin('bulk_missing_user');
    const { alertId } = await createAlertFor(token);

    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [alertId, 99999999], verdict: 'confirmed_fraud' });
    expect(res.status).toBe(404);

    const check = await request(app).get(`${API}/alerts/${alertId}`).set('Authorization', `Bearer ${token}`);
    expect(check.body.alert.status).toBe('open'); // untouched — the batch was rejected, not partially applied
  });

  test('rejects the whole batch if any alert belongs to a different user', async () => {
    const ownerToken = await registerAndLogin('bulk_owner_user');
    const strangerToken = await registerAndLogin('bulk_stranger_user');
    const owned = await createAlertFor(ownerToken);
    const strangers = await createAlertFor(strangerToken);

    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ alertIds: [owned.alertId, strangers.alertId], verdict: 'confirmed_fraud' });
    expect(res.status).toBe(403);

    const check = await request(app).get(`${API}/alerts/${owned.alertId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(check.body.alert.status).toBe('open'); // untouched
  });

  test('an admin can bulk-resolve alerts spanning multiple users', async () => {
    const adminToken = await loginAdmin();
    const userAToken = await registerAndLogin('bulk_admin_user_a');
    const userBToken = await registerAndLogin('bulk_admin_user_b');
    const a = await createAlertFor(userAToken);
    const b = await createAlertFor(userBToken);

    const res = await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${adminToken}`)
      .send({ alertIds: [a.alertId, b.alertId], verdict: 'confirmed_fraud' });
    expect(res.status).toBe(200);
    expect(res.body.resolvedCount).toBe(2);
  });

  test('the audit trail records one bulk_resolve entry covering the whole batch', async () => {
    const adminToken = await loginAdmin();
    const token = await registerAndLogin('bulk_audit_user');
    const a1 = await createAlertFor(token);
    const a2 = await createAlertFor(token);

    await request(app).patch(`${API}/alerts/bulk-resolve`).set('Authorization', `Bearer ${token}`)
      .send({ alertIds: [a1.alertId, a2.alertId], verdict: 'confirmed_fraud' });

    const auditRes = await request(app).get(`${API}/admin/audit-logs`).set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'alerts.bulk_resolve' });
    expect(auditRes.status).toBe(200);
    const entry = auditRes.body.logs.find((l) => l.details?.alertIds?.includes(a1.alertId) && l.details?.alertIds?.includes(a2.alertId));
    expect(entry).toBeDefined();
    expect(entry.details.count).toBe(2);
  });
});
