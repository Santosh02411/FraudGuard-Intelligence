/**
 * An empty `KEY=` line means "not set". (.env.example used to ship `ML_SERVICE_API_KEY=` and
 * `ML_ADMIN_API_KEY=` empty, and a plain `copy .env.example .env` then refused to boot.)
 * Boots config/env.js in a fresh child process, like a real start.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEV = { NODE_ENV: 'development', JWT_SECRET: 'dev_only_change_this_to_something_random' };
function boot(extra, { dotenvFile } = {}) {
  const env = { PATH: process.env.PATH, ...DEV, ...extra };
  const code = dotenvFile
    ? `require('dotenv').config({ path: ${JSON.stringify(dotenvFile)} }); const c = require('./config/env'); console.log('BOOT_OK ' + JSON.stringify({ ml: c.mlServiceApiKey, admin: c.mlAdminApiKey }))`
    : "const c = require('./config/env'); console.log('BOOT_OK ' + JSON.stringify({ ml: c.mlServiceApiKey, admin: c.mlAdminApiKey }))";
  return spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..', '..'), env, encoding: 'utf8' });
}

describe('empty values in .env mean "not set"', () => {
  test('empty ML keys no longer stop the backend booting', () => {
    const r = boot({ ML_SERVICE_API_KEY: '', ML_ADMIN_API_KEY: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BOOT_OK {"ml":null,"admin":null}');
  });

  test('the shipped .env.example works unmodified when copied to .env', () => {
    const tmp = path.join(require('os').tmpdir(), `fg-env-${process.pid}`);
    fs.copyFileSync(path.join(__dirname, '..', '..', '.env.example'), tmp);
    try {
      const r = boot({}, { dotenvFile: tmp });
      expect(r.stderr).not.toMatch(/Invalid environment/);
      expect(r.status).toBe(0);
    } finally { fs.unlinkSync(tmp); }
  });

  test('a real value is still used, and other empty optional text settings are also treated as unset', () => {
    const r = boot({ ML_SERVICE_API_KEY: 'k'.repeat(40), ML_ADMIN_API_KEY: '', DATABASE_URL: '', REDIS_URL: '', SMTP_HOST: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`"ml":"${'k'.repeat(40)}","admin":null`);
  });

  test('production still REQUIRES real keys: empty means missing, not "fine"', () => {
    const r = spawnSync(process.execPath, ['-e', "require('./config/env')"], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: 'j'.repeat(48), DATABASE_URL: 'postgres://u:p@db/x', CORS_ALLOWED_ORIGINS: 'https://a.example.com', SMTP_HOST: 'smtp.example.com', ML_SERVICE_URL: 'http://ml:8001', ML_SERVICE_API_KEY: '', ML_ADMIN_API_KEY: '' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/ML_SERVICE_API_KEY must be set/);
  });
});
