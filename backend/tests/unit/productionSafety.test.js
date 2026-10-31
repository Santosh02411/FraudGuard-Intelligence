/**
 * Production-safety checks (ML service credentials + demo data).
 *
 * config/env.js calls process.exit(1) on an unsafe config, so each case
 * boots it in a fresh child process with a controlled environment and
 * asserts on the exit code/message — exactly what a real deploy would see.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

const SAFE_PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'j'.repeat(48),
  DATABASE_URL: 'postgres://u:p@db/x',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  SMTP_HOST: 'smtp.example.com',
  ML_SERVICE_URL: 'http://ml.internal:8001',
  ML_SERVICE_API_KEY: KEY_A,
  ML_ADMIN_API_KEY: KEY_B,
};

function bootEnv(overrides) {
  const env = { PATH: process.env.PATH, ...SAFE_PROD, ...overrides };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, ['-e', "require('./config/env'); console.log('BOOT_OK')"], {
    cwd: path.join(__dirname, '..', '..'),
    env,
    encoding: 'utf8',
  });
}

describe('production boot guard', () => {
  test('a fully safe production config boots', () => {
    const r = bootEnv({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BOOT_OK');
  });

  test('SEED_ON_BOOT=true is rejected in production (the old render.yaml default)', () => {
    const r = bootEnv({ SEED_ON_BOOT: 'true' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SEED_ON_BOOT=true is not allowed/);
  });

  test('SEED_ON_BOOT is rejected in staging too', () => {
    const r = bootEnv({ NODE_ENV: 'staging', SEED_ON_BOOT: 'true' });
    expect(r.status).toBe(1);
  });

  test('explicit override still requires a strong, non-default demo password', () => {
    const weak = bootEnv({ SEED_ON_BOOT: 'true', ALLOW_DEMO_SEED_IN_PRODUCTION: 'true' });
    expect(weak.status).toBe(1);
    expect(weak.stderr).toMatch(/DEMO_USER_PASSWORD/);
    const publicDefault = bootEnv({ SEED_ON_BOOT: 'true', ALLOW_DEMO_SEED_IN_PRODUCTION: 'true', DEMO_USER_PASSWORD: 'demo1234' });
    expect(publicDefault.status).toBe(1);
    const ok = bootEnv({ SEED_ON_BOOT: 'true', ALLOW_DEMO_SEED_IN_PRODUCTION: 'true', DEMO_USER_PASSWORD: 'a-long-unique-demo-pass' });
    expect(ok.status).toBe(0);
  });

  test('seeding stays off by default and a weak/default admin password is rejected', () => {
    expect(bootEnv({}).status).toBe(0);
    const r = bootEnv({ ADMIN_PASSWORD: 'admin123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ADMIN_PASSWORD/);
  });

  test('ML service credentials are mandatory, long, and distinct in production', () => {
    expect(bootEnv({ ML_SERVICE_API_KEY: undefined }).stderr).toMatch(/ML_SERVICE_API_KEY must be set/);
    expect(bootEnv({ ML_ADMIN_API_KEY: undefined }).stderr).toMatch(/ML_ADMIN_API_KEY must be set/);
    expect(bootEnv({ ML_ADMIN_API_KEY: 'short' }).status).toBe(1);
    expect(bootEnv({ ML_ADMIN_API_KEY: KEY_A }).stderr).toMatch(/must be different/);
  });

  test('ML_SERVICE_URL may not silently default to localhost in production', () => {
    const r = bootEnv({ ML_SERVICE_URL: undefined });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ML_SERVICE_URL must be set/);
  });

  test('development stays zero-friction (no keys, no seeding restrictions)', () => {
    const r = bootEnv({ NODE_ENV: 'development', JWT_SECRET: 'dev', DATABASE_URL: undefined, SEED_ON_BOOT: 'true',
      ML_SERVICE_API_KEY: undefined, ML_ADMIN_API_KEY: undefined, ML_SERVICE_URL: undefined, CORS_ALLOWED_ORIGINS: undefined, SMTP_HOST: undefined });
    expect(r.status).toBe(0);
  });
});
