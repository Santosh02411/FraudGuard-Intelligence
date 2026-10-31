"""
Persistent monitoring state
==============================
The drift buffer, the shadow-comparison log and the selected shadow version
used to live only in process memory, so a restart (a deploy, a crash, a
platform restart) silently reset drift monitoring and the evidence gathered
about a challenger.

This keeps them in SQLite (stdlib, no new dependency) in a file that must sit
on a persistent volume in production (MONITOR_DB_PATH). Writes are best-effort
and never break a scoring response; the in-memory deques stay the hot path and
are rebuilt from here on startup.

Limits, stated: one SQLite file means ONE ML-service instance owns the
monitoring state. Running several replicas would need a shared store
(Postgres/Redis) behind this same interface.
"""

import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("MONITOR_DB_PATH", "models/monitor.db")
_lock = threading.Lock()
_conn = None


def _connect():
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript("""
            CREATE TABLE IF NOT EXISTS live_scores (
              id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ts REAL NOT NULL,
              score REAL NOT NULL, features TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_live_version ON live_scores(version, id);
            CREATE TABLE IF NOT EXISTS shadow_comparisons (
              id INTEGER PRIMARY KEY AUTOINCREMENT, primary_version TEXT NOT NULL, shadow_version TEXT NOT NULL,
              ts REAL NOT NULL, primary_score REAL NOT NULL, shadow_score REAL NOT NULL, agree INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_shadow_pair ON shadow_comparisons(primary_version, shadow_version, id);
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
        """)
        _conn.commit()
    return _conn


def reset_for_tests(path=None):
    global _conn, DB_PATH
    if _conn is not None:
        _conn.close()
        _conn = None
    if path:
        DB_PATH = path


def _run(sql, params=(), many=None, fetch=False):
    try:
        with _lock:
            c = _connect()
            cur = c.executemany(sql, many) if many is not None else c.execute(sql, params)
            rows = cur.fetchall() if fetch else None
            c.commit()
            return rows
    except Exception as e:  # noqa: BLE001 - monitoring must never break serving
        print(f"monitor_store: {e}")
        return [] if fetch else None


def record_live(version, score, features, keep):
    _run("INSERT INTO live_scores(version, ts, score, features) VALUES (?,?,?,?)", (version, time.time(), float(score), json.dumps(features, default=float)))
    _run("DELETE FROM live_scores WHERE version=? AND id <= (SELECT id FROM live_scores WHERE version=? ORDER BY id DESC LIMIT 1 OFFSET ?)", (version, version, keep))


def load_live(version, limit):
    rows = _run("SELECT score, features FROM live_scores WHERE version=? ORDER BY id DESC LIMIT ?", (version, limit), fetch=True) or []
    rows.reverse()
    return [(r[0], json.loads(r[1])) for r in rows]


def clear_live(version=None):
    if version is None:
        _run("DELETE FROM live_scores")
    else:
        _run("DELETE FROM live_scores WHERE version=?", (version,))


def record_shadow(primary_version, shadow_version, primary_score, shadow_score, agree, keep):
    _run("INSERT INTO shadow_comparisons(primary_version, shadow_version, ts, primary_score, shadow_score, agree) VALUES (?,?,?,?,?,?)",
         (primary_version, shadow_version, time.time(), float(primary_score), float(shadow_score), 1 if agree else 0))
    _run("DELETE FROM shadow_comparisons WHERE primary_version=? AND shadow_version=? AND id <= "
         "(SELECT id FROM shadow_comparisons WHERE primary_version=? AND shadow_version=? ORDER BY id DESC LIMIT 1 OFFSET ?)",
         (primary_version, shadow_version, primary_version, shadow_version, keep))


def load_shadow(primary_version, shadow_version, limit):
    rows = _run("SELECT primary_score, shadow_score, agree FROM shadow_comparisons WHERE primary_version=? AND shadow_version=? ORDER BY id DESC LIMIT ?",
                (primary_version, shadow_version, limit), fetch=True) or []
    rows.reverse()
    return [{"primary_score": r[0], "shadow_score": r[1], "abs_score_diff": abs(r[0] - r[1]), "agree_risk_level": bool(r[2])} for r in rows]


def clear_shadow(primary_version=None, shadow_version=None):
    if primary_version is None:
        _run("DELETE FROM shadow_comparisons")
    else:
        _run("DELETE FROM shadow_comparisons WHERE primary_version=? AND shadow_version=?", (primary_version, shadow_version))


def set_kv(key, value):
    if value is None:
        _run("DELETE FROM kv WHERE key=?", (key,))
    else:
        _run("INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def get_kv(key):
    rows = _run("SELECT value FROM kv WHERE key=?", (key,), fetch=True) or []
    return rows[0][0] if rows else None
