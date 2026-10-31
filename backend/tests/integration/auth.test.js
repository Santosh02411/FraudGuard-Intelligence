const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';

describe('POST /auth/register', () => {
  test('rejects a weak password with every failing rule reported', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ username: 'weakuser', email: 'weak@example.com', password: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(3);
  });

  test('accepts a strong password and returns an access+refresh token pair', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ username: 'alice', email: 'alice@example.com', password: 'Str0ng!Passw0rd' });

    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.user).toMatchObject({ username: 'alice', role: 'user' });
    expect(res.body.user.password).toBeUndefined(); // never leak the hash
  });

  test('rejects a duplicate username', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ username: 'alice', email: 'someone-else@example.com', password: 'Str0ng!Passw0rd' });

    expect(res.status).toBe(409);
  });
});

describe('POST /auth/login + account lockout', () => {
  beforeAll(async () => {
    await request(app).post(`${API}/auth/register`)
      .send({ username: 'lockme', email: 'lockme@example.com', password: 'Correct!Passw0rd' });
  });

  test('wrong password is rejected with a generic message', async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ username: 'lockme', password: 'WrongPassword1!' });
    expect(res.status).toBe(401);
  });

  test('a non-existent username gets the same generic error as a wrong password (no user enumeration)', async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ username: 'doesnotexist', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('locks the account after enough consecutive failures, even for the correct password', async () => {
    // Already failed once above; keep failing until it locks (threshold is env-driven, default 5).
    let lastStatus;
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post(`${API}/auth/login`).send({ username: 'lockme', password: 'WrongPassword1!' });
      lastStatus = res.status;
      if (lastStatus === 423) break;
    }
    expect(lastStatus).toBe(423);

    const correctAttempt = await request(app).post(`${API}/auth/login`).send({ username: 'lockme', password: 'Correct!Passw0rd' });
    expect(correctAttempt.status).toBe(423);
  });
});

describe('POST /auth/refresh — rotation and reuse detection', () => {
  let refreshToken1;

  beforeAll(async () => {
    await request(app).post(`${API}/auth/register`)
      .send({ username: 'bob', email: 'bob@example.com', password: 'An0ther$Secure1' });
    const res = await request(app).post(`${API}/auth/login`).send({ username: 'bob', password: 'An0ther$Secure1' });
    refreshToken1 = res.body.refreshToken;
  });

  test('a valid refresh token returns a new pair, including a different refresh token', async () => {
    const res = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: refreshToken1 });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.refreshToken).not.toBe(refreshToken1);
  });

  test('reusing the same (now-rotated-out) refresh token is rejected', async () => {
    const res = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: refreshToken1 });
    expect(res.status).toBe(401);
  });

  test('an unknown refresh token is rejected', async () => {
    const res = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  test('revokes the refresh token server-side — it can no longer be used to refresh', async () => {
    await request(app).post(`${API}/auth/register`)
      .send({ username: 'carla', email: 'carla@example.com', password: 'Sup3r$ecure!' });
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'carla', password: 'Sup3r$ecure!' });
    const { refreshToken } = login.body;

    const logoutRes = await request(app).post(`${API}/auth/logout`).send({ refreshToken });
    expect(logoutRes.status).toBe(200);

    const refreshAfterLogout = await request(app).post(`${API}/auth/refresh`).send({ refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });

  test('is idempotent / never errors even with no token', async () => {
    const res = await request(app).post(`${API}/auth/logout`).send({});
    expect(res.status).toBe(200);
  });
});

describe('GET /auth/me', () => {
  test('requires a valid access token', async () => {
    const res = await request(app).get(`${API}/auth/me`);
    expect(res.status).toBe(401);
  });

  test('returns the authenticated user', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'alice', password: 'Str0ng!Passw0rd' });
    const res = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('alice');
  });
});
