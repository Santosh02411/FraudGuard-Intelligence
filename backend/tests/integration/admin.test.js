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

describe('RBAC on admin routes', () => {
  test('an unauthenticated request is rejected', async () => {
    const res = await request(app).get(`${API}/admin/stats`);
    expect(res.status).toBe(401);
  });

  test('a regular user is forbidden, and it is audit-logged', async () => {
    const userToken = await registerAndLogin('rbac_regular_user');
    const res = await request(app).get(`${API}/admin/stats`).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);

    const adminToken = await loginAdmin();
    const logs = await request(app).get(`${API}/admin/audit-logs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'rbac.access_denied' });
    expect(logs.body.logs.some((l) => l.username === 'rbac_regular_user')).toBe(true);
  });

  test('an admin can access admin routes', async () => {
    const adminToken = await loginAdmin();
    const res = await request(app).get(`${API}/admin/stats`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_users');
    expect(res.body).toHaveProperty('total_transactions');
  });
});

describe('PATCH /admin/users/:id/role', () => {
  let adminToken;
  let targetUserId;

  beforeAll(async () => {
    adminToken = await loginAdmin();
    await registerAndLogin('role_change_target');
    const users = await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${adminToken}`);
    targetUserId = users.body.users.find((u) => u.username === 'role_change_target').id;
  });

  test('promotes a user to admin and audit-logs it', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/${targetUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);

    const logs = await request(app).get(`${API}/admin/audit-logs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'admin.role_change', targetId: targetUserId });
    expect(logs.body.logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.body.logs[0].details.newRole).toBe('admin');
  });

  test('the promoted user\'s prior session (refresh token) is revoked by the role change', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'role_change_target', password: 'Str0ng!Passw0rd1' });
    const { refreshToken } = login.body;

    await request(app)
      .patch(`${API}/admin/users/${targetUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });

    const refreshAttempt = await request(app).post(`${API}/auth/refresh`).send({ refreshToken });
    expect(refreshAttempt.status).toBe(401);
  });

  test('an admin cannot demote themselves', async () => {
    const users = await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${adminToken}`);
    const adminUser = users.body.users.find((u) => u.username === 'admin');
    const res = await request(app)
      .patch(`${API}/admin/users/${adminUser.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid role value', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/${targetUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/audit-logs — pagination', () => {
  test('supports pagination params', async () => {
    const adminToken = await loginAdmin();
    const res = await request(app).get(`${API}/admin/audit-logs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 1, limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 5 });
  });
});

describe('GET /admin/audit-logs/export — CSV export', () => {
  test('requires admin', async () => {
    const userToken = await registerAndLogin('export_audit_regular_user');
    const res = await request(app).get(`${API}/admin/audit-logs/export`).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test('returns CSV with a header row and respects the action filter', async () => {
    const adminToken = await loginAdmin();
    await registerAndLogin('export_audit_triggering_user'); // generates at least one auth.register / auth.login entry

    const res = await request(app).get(`${API}/admin/audit-logs/export`).set('Authorization', `Bearer ${adminToken}`).query({ action: 'auth.register' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('ID,Date,User,Action,Target Type,Target ID,Outcome,IP Address');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.includes('auth.register'))).toBe(true);
  });
});
