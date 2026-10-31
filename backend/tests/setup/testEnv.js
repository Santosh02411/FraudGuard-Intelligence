/**
 * Runs before the test framework is installed and before any test file
 * is required (Jest's `setupFiles`) — so these env vars are in place
 * before config/env.js's validation runs for the first time. Without
 * this, requiring anything that pulls in config/env.js would either
 * throw (missing JWT_SECRET) or call process.exit(1) (see
 * config/env.js's `fail()`), killing the whole test run.
 *
 * SQLITE_PATH=':memory:' gives each test FILE its own private in-memory
 * SQLite database — Jest sandboxes the module registry per test file by
 * default, so config/database.js (and the connection it opens) is a
 * fresh instance per file, and tests in different files can never see
 * each other's data even though they all use the same ':memory:' path.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_only_secret_do_not_use_in_real_deployments_1234567890';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.SQLITE_PATH = ':memory:';
process.env.ML_SERVICE_URL = 'http://127.0.0.1:1'; // deliberately unreachable — exercises the rule-engine fallback path unless a test mocks mlClient
process.env.LOG_LEVEL = 'error'; // keep test output free of the app's own request/audit logs
process.env.RATE_LIMIT_AUTH_MAX = '1000'; // tests fire many auth requests in a row; the real limit would false-fail them
process.env.RATE_LIMIT_TRANSACTIONS_MAX = '1000';
process.env.RELATIONSHIP_CACHE_TTL_MS = '0'; // tests mutate data between calls; production caches the graph briefly
process.env.RATE_LIMIT_COGNEE_SYNC_MAX = '1000';
process.env.RATE_LIMIT_COGNEE_QUERY_MAX = '1000';
