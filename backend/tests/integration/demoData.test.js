/**
 * Demo-data safety: seeding is idempotent across restarts, demo accounts are
 * clearly marked and can't be impersonated by real sign-ups, and the seeder
 * itself refuses to run against a production environment.
 */
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const { seedIfEmpty, hasDemoData, assertSeedingAllowed } = require('../../scripts/seedDemoData');
const { DEMO_EMAIL_DOMAIN } = require('../../config/demo');

const API = '/api/v1';
const count = async (sql, params = []) => Number((await db.get(sql, params)).count);

beforeAll(async () => {
  await initSchema();
});

describe('demo seeding is idempotent (restarts never add demo records)', () => {
  test('no demo data exists until seeding is explicitly run', async () => {
    expect(await hasDemoData()).toBe(false);
    expect(await count('SELECT COUNT(*) as count FROM users WHERE email LIKE ?', [`%@${DEMO_EMAIL_DOMAIN}`])).toBe(0);
  });

  test('seeding once, then "restarting" repeatedly, leaves the data unchanged', async () => {
    const first = await seedIfEmpty({ users: 2, days: 4 });
    expect(first.seeded).toBe(true);

    const usersAfterFirst = await count('SELECT COUNT(*) as count FROM users');
    const txnsAfterFirst = await count('SELECT COUNT(*) as count FROM transactions');
    expect(txnsAfterFirst).toBeGreaterThan(0);

    for (let restart = 0; restart < 3; restart += 1) {
      const again = await seedIfEmpty({ users: 2, days: 4 });
      expect(again.seeded).toBe(false);
    }
    expect(await count('SELECT COUNT(*) as count FROM users')).toBe(usersAfterFirst);
    expect(await count('SELECT COUNT(*) as count FROM transactions')).toBe(txnsAfterFirst);
  });

  test('every seeded account is on the reserved domain; real accounts never are', async () => {
    await request(app).post(`${API}/auth/register`).send({ username: 'realperson', email: 'real@example.com', password: 'Str0ng!Passw0rd1' });
    const demo = await count('SELECT COUNT(*) as count FROM users WHERE email LIKE ?', [`%@${DEMO_EMAIL_DOMAIN}`]);
    const real = await count('SELECT COUNT(*) as count FROM users WHERE email NOT LIKE ?', [`%@${DEMO_EMAIL_DOMAIN}`]);
    expect(demo).toBe(2);
    expect(real).toBeGreaterThanOrEqual(2); // admin + realperson
  });
});

describe('demo accounts cannot be mistaken for / impersonated as real customers', () => {
  test('registration on the reserved demo domain is rejected', async () => {
    const res = await request(app).post(`${API}/auth/register`).send({
      username: 'sneaky', email: `sneaky@${DEMO_EMAIL_DOMAIN}`, password: 'Str0ng!Passw0rd1',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/reserved/i);
    expect(await count('SELECT COUNT(*) as count FROM users WHERE username = ?', ['sneaky'])).toBe(0);
  });

  test('the admin user list flags demo accounts (is_demo) and only those', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
    const res = await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    const demoFlagged = res.body.users.filter((u) => u.is_demo);
    expect(demoFlagged.length).toBe(2);
    expect(demoFlagged.every((u) => u.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`))).toBe(true);
    expect(res.body.users.find((u) => u.username === 'realperson').is_demo).toBe(false);
    expect(res.body.users.find((u) => u.username === 'admin').is_demo).toBe(false);
  });
});

describe('the seeder refuses to run against production', () => {
  const config = require('../../config/env');
  const original = { isProd: config.isProd, isStaging: config.isStaging, allow: config.allowDemoSeedInProduction };
  afterEach(() => Object.assign(config, { isProd: original.isProd, isStaging: original.isStaging, allowDemoSeedInProduction: original.allow }));

  test('blocked in production and staging unless explicitly allowed', async () => {
    config.isProd = true;
    expect(() => assertSeedingAllowed()).toThrow(/Refusing to seed/);
    await expect(seedIfEmpty({ users: 1, days: 1 })).rejects.toThrow(/Refusing to seed/);
    config.isProd = false;
    config.isStaging = true;
    expect(() => assertSeedingAllowed()).toThrow(/Refusing to seed/);
    config.allowDemoSeedInProduction = true;
    expect(() => assertSeedingAllowed()).not.toThrow();
  });

  test('allowed in development/test', () => {
    expect(() => assertSeedingAllowed()).not.toThrow();
  });
});
