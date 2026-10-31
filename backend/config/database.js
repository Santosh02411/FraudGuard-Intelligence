/**
 * Database connection abstraction — SQLite (dev) or PostgreSQL (production).
 * ==============================================================================
 * WHY SQLITE IS THE DEV DEFAULT, NOT WHAT SHIPS TO PRODUCTION:
 *
 *   - Single-file, zero-setup: `npm install && npm start` just works, no
 *     separate DB server to install/configure — ideal for local dev and
 *     for anyone cloning this repo to try it out.
 *   - SQLite writes lock the whole database file. Fine for one developer
 *     hitting the API from a browser; wrong for a real deployment with
 *     concurrent users, where a fraud-scoring write on one request
 *     shouldn't block reads from every other request.
 *   - No connection pooling, no replication, no built-in support for the
 *     managed hosting most teams actually deploy to (RDS, Cloud SQL,
 *     Render/Railway Postgres, etc).
 *   - No native DECIMAL type for money — this schema uses REAL/FLOAT for
 *     amounts, which is fine for a demo but not for real financial
 *     reconciliation (Postgres NUMERIC would be the production choice).
 *
 * WHY POSTGRES FOR PRODUCTION:
 *
 *   - Row-level locking and MVCC — concurrent fraud-scoring writes don't
 *     block each other or block reads.
 *   - Connection pooling (via `pg.Pool`) for a multi-instance deployment.
 *   - Real hosted options with backups/replicas/monitoring out of the box.
 *
 * HOW THIS MODULE WORKS:
 *
 * Set DATABASE_URL (a standard postgres:// connection string) to switch
 * to Postgres. Leave it unset and the app runs on a local SQLite file —
 * no code changes required either way. Every query in this codebase is
 * written once, with `?` placeholders (SQLite's native style), and this
 * module transparently renumbers them to `$1, $2, ...` when running
 * against Postgres. The repositories in models/*.js never touch a
 * driver-specific API directly — they only call all()/get()/run()/insert()
 * from this module, so the dialect is switched in exactly one place.
 */

/**
 * TRANSACTIONS
 * ------------
 * `db.transaction(async () => { ... })` runs every db.* call made inside the
 * callback (however deeply nested, via AsyncLocalStorage) in ONE database
 * transaction: it all commits or none of it does. Repositories need no
 * changes; they keep calling db.all/get/run/insert and join the ambient
 * transaction. Nested db.transaction() calls join the outer one.
 *   - Postgres: a dedicated pooled client with BEGIN/COMMIT/ROLLBACK.
 *   - SQLite: one connection is shared by all requests, so an open
 *     transaction would swallow unrelated requests' statements. Transactions
 *     are therefore serialised (BEGIN IMMEDIATE) and statements issued
 *     OUTSIDE a transaction wait until it finishes. Keep transactions short;
 *     do slow I/O (ML calls, webhooks) outside them.
 */

const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const config = require("./env");
const logger = require("./logger");

const IS_POSTGRES = Boolean(config.databaseUrl);

/** Ambient transaction context. Store = { client } (pg) or { sqlite: true }. */
const txContext = new AsyncLocalStorage();

/** Renumbers `?` placeholders to Postgres's `$1, $2, ...` style. */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let impl;

if (IS_POSTGRES) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 31000,
  });

  pool.on("error", (err) => {
    // A background/idle client failing is not a request-scoped error —
    // log it rather than crashing the process.
    logger.error("Unexpected error on idle Postgres client", {
      error: err.message,
    });
  });

  const runner = () => txContext.getStore()?.client || pool;

  impl = {
    dialect: "postgres",

    async all(sql, params = []) {
      const { rows } = await runner().query(toPgPlaceholders(sql), params);
      return rows;
    },

    async get(sql, params = []) {
      const { rows } = await runner().query(toPgPlaceholders(sql), params);
      return rows[0] || null;
    },

    async run(sql, params = []) {
      const { rowCount } = await runner().query(toPgPlaceholders(sql), params);
      return { changes: rowCount };
    },

    /** INSERT that returns the new row's id, regardless of dialect. */
    async insert(sql, params = []) {
      const withReturning = /returning/i.test(sql)
        ? sql
        : `${sql} RETURNING id`;
      const { rows } = await runner().query(
        toPgPlaceholders(withReturning),
        params,
      );
      const first = rows[0];
      // `id` by convention; tables keyed differently name their key in RETURNING.
      return {
        lastInsertRowid: first ? (first.id ?? Object.values(first)[0]) : null,
      };
    },

    async exec(sql) {
      await runner().query(sql);
    },

    async transaction(fn) {
      if (txContext.getStore()) return fn(); // join the outer transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await txContext.run({ client }, fn);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          logger.error("Rollback failed", { error: rollbackErr.message });
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
} else {
  const Database = require("better-sqlite3");
  const DB_PATH =
    process.env.SQLITE_PATH || path.join(__dirname, "..", "fraudguard.db");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // another process holding the write lock: wait, don't fail

  // At most one open transaction at a time; everything else waits for it.
  let openTx = null;
  const waitForTransactionToFinish = async () => {
    while (openTx) {
      // eslint-disable-next-line no-await-in-loop
      await openTx;
    }
  };
  // Statements issued inside a transaction run immediately; all others
  // queue behind it so they cannot join (or observe) it by accident.
  const gate = async () => {
    if (!txContext.getStore()) await waitForTransactionToFinish();
  };

  impl = {
    dialect: "sqlite",

    async all(sql, params = []) {
      await gate();
      return db.prepare(sql).all(...params);
    },

    async get(sql, params = []) {
      await gate();
      return db.prepare(sql).get(...params) || null;
    },

    async run(sql, params = []) {
      await gate();
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },

    async insert(sql, params = []) {
      await gate();
      const info = db.prepare(sql).run(...params);
      return { lastInsertRowid: info.lastInsertRowid };
    },

    async exec(sql) {
      await gate();
      db.exec(sql);
    },

    async transaction(fn) {
      if (txContext.getStore()) return fn(); // join the outer transaction
      // Acquire synchronously once the loop exits: a separate awaited helper leaves a gap in which several waiters
      // can all observe "no open transaction" and each BEGIN (SqliteError: cannot start a transaction within a transaction).
      while (openTx) await openTx;
      let release;
      openTx = new Promise((resolve) => {
        release = resolve;
      });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await txContext.run({ sqlite: true }, fn);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch (rollbackErr) {
            logger.error("Rollback failed", { error: rollbackErr.message });
          }
          throw err;
        }
      } finally {
        openTx = null;
        release();
      }
    },

    async close() {
      db.close();
    },
  };
}

module.exports = impl;
