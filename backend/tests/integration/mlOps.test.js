jest.mock('../../services/mlAdminClient');

const request = require('supertest');
const mlAdminClient = require('../../services/mlAdminClient');
const app = require('../../app');
const { initSchema } = require('../../config/schema');
const { AppError } = require('../../middleware/errorHandler');

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

describe('ML ops (admin-only proxy to ml_service)', () => {
  let userToken;
  let adminToken;

  beforeAll(async () => {
    userToken = await registerAndLogin('mlops_user');
    adminToken = await loginAdmin();
  });

  afterEach(() => jest.clearAllMocks());

  test('a regular user cannot reach any ml ops endpoint', async () => {
    const endpoints = ['/admin/ml/versions', '/admin/ml/drift', '/admin/ml/shadow/status'];
    for (const path of endpoints) {
      const res = await request(app).get(`${API}${path}`).set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    }
  });

  test('GET /ml/versions passes through the registry list and active version', async () => {
    mlAdminClient.listVersions.mockResolvedValue({
      versions: [{ version: 'v1', best_model_type: 'xgboost', pr_auc: 0.99 }],
      active: 'v1',
    });
    const res = await request(app).get(`${API}/admin/ml/versions`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe('v1');
    expect(res.body.versions[0].version).toBe('v1');
  });

  test('GET /ml/drift passes through the drift report', async () => {
    mlAdminClient.getDrift.mockResolvedValue({ status: 'stable', n_samples: 500, version: 'v1', flagged_features: {} });
    const res = await request(app).get(`${API}/admin/ml/drift`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stable');
  });

  test('POST /ml/drift/reset is audit-logged and passes through the result', async () => {
    mlAdminClient.resetDrift.mockResolvedValue({ reset: true });
    const res = await request(app).post(`${API}/admin/ml/drift/reset`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(mlAdminClient.resetDrift).toHaveBeenCalledTimes(1);
  });

  test('GET /ml/shadow/status reflects an inactive shadow deployment', async () => {
    mlAdminClient.getShadowStatus.mockResolvedValue({ active: false });
    const res = await request(app).get(`${API}/admin/ml/shadow/status`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  test('POST /ml/shadow/set requires a version in the body', async () => {
    const res = await request(app).post(`${API}/admin/ml/shadow/set`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(400);
    expect(mlAdminClient.setShadow).not.toHaveBeenCalled();
  });

  test('POST /ml/shadow/set starts shadow-scoring a given version', async () => {
    mlAdminClient.setShadow.mockResolvedValue({ active: true, shadow_version: 'v2' });
    const res = await request(app).post(`${API}/admin/ml/shadow/set`).set('Authorization', `Bearer ${adminToken}`).send({ version: 'v2' });
    expect(res.status).toBe(200);
    expect(res.body.shadow_version).toBe('v2');
    expect(mlAdminClient.setShadow).toHaveBeenCalledWith('v2');
  });

  test('POST /ml/shadow/clear stops shadow-scoring', async () => {
    mlAdminClient.clearShadow.mockResolvedValue({ cleared: true });
    const res = await request(app).post(`${API}/admin/ml/shadow/clear`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
  });

  test('POST /ml/shadow/promote no longer promotes: agreement is not accuracy, use the change workflow', async () => {
    const res = await request(app).post(`${API}/admin/ml/shadow/promote`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('USE_CHANGE_WORKFLOW');
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
  });

  test('a downstream ml_service failure surfaces as 503, not a crash', async () => {
    mlAdminClient.getDrift.mockRejectedValue(AppError.serviceUnavailable('ML service is unreachable — is ml_service running?'));
    const res = await request(app).get(`${API}/admin/ml/drift`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
  });
});
