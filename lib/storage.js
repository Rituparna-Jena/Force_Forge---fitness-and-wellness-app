/**
 * FocusForge v2 - storage layer.
 *
 * better-sqlite3 when it loads, JSON file store as a guaranteed fallback.
 * Both implementations satisfy one identical interface:
 *   insertAttempt, attemptsSince, allAttempts, dailyAllowedSum,
 *   countSince, deleteAll, counts, close
 *
 * Log policy: excuse text, site, timestamp, energy, outcome, need category.
 * Never page content, never full URLs beyond the site label.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'focusforge.db');
const JSON_FILE = path.join(DATA_DIR, 'attempts.json');

function attemptStore() {
  try {
    const store = sqliteStore();
    return { store, engine: 'sqlite' };
  } catch (err) {
    console.warn('[storage] better-sqlite3 unavailable (%s); using JSON file store.', err.message);
    return { store: jsonStore(), engine: 'json' };
  }
}

/* ---------------------------------------------------------------- sqlite */

function sqliteStore() {
  // Required lazily so a native build failure falls through to JSON.
  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      site TEXT NOT NULL,
      energy INTEGER NOT NULL,
      excuse TEXT NOT NULL,
      verdict TEXT NOT NULL,
      need_category TEXT NOT NULL,
      minutes_granted INTEGER NOT NULL DEFAULT 0,
      micro_task TEXT NOT NULL DEFAULT 'none',
      reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'live',
      llm INTEGER NOT NULL DEFAULT 1,
      distress INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_ts ON attempts (ts);
  `);

  const insert = db.prepare(`
    INSERT INTO attempts
      (ts, site, energy, excuse, verdict, need_category, minutes_granted,
       micro_task, reason, source, llm, distress)
    VALUES
      (@ts, @site, @energy, @excuse, @verdict, @need_category, @minutes_granted,
       @micro_task, @reason, @source, @llm, @distress)
  `);

  return {
    engine: 'sqlite',
    insertAttempt(a) {
      const row = normalize(a);
      const info = insert.run(row);
      return { ...row, id: info.lastInsertRowid };
    },
    attemptsSince(sinceTs) {
      return db.prepare('SELECT * FROM attempts WHERE ts >= ? ORDER BY ts ASC').all(sinceTs).map(rowToAttempt);
    },
    allAttempts() {
      return db.prepare('SELECT * FROM attempts ORDER BY ts ASC').all().map(rowToAttempt);
    },
    dailyAllowedSum(dayStartTs, dayEndTs) {
      const r = db.prepare(
        "SELECT COALESCE(SUM(minutes_granted), 0) AS m FROM attempts WHERE verdict = 'allow' AND ts >= ? AND ts < ?"
      ).get(dayStartTs, dayEndTs);
      return r.m || 0;
    },
    countSince(sinceTs) {
      const r = db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE ts >= ?').get(sinceTs);
      return r.c || 0;
    },
    deleteAll() {
      db.exec('DELETE FROM attempts');
    },
    counts() {
      const r = db.prepare('SELECT COUNT(*) AS c FROM attempts').get();
      return { attempts: r.c || 0 };
    },
    close() {
      db.close();
    },
  };
}

/* ------------------------------------------------------------------ json */

function jsonStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let attempts = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    if (Array.isArray(parsed.attempts)) attempts = parsed.attempts;
  } catch (_) { /* first run */ }

  let nextId = attempts.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
  const flush = () => fs.writeFileSync(JSON_FILE, JSON.stringify({ attempts }, null, 1));

  return {
    engine: 'json',
    insertAttempt(a) {
      const row = normalize(a);
      row.id = nextId++;
      attempts.push(row);
      flush();
      return row;
    },
    attemptsSince(sinceTs) {
      return attempts.filter((a) => a.ts >= sinceTs);
    },
    allAttempts() {
      return attempts.slice();
    },
    dailyAllowedSum(dayStartTs, dayEndTs) {
      return attempts
        .filter((a) => a.verdict === 'allow' && a.ts >= dayStartTs && a.ts < dayEndTs)
        .reduce((s, a) => s + (a.minutes_granted || 0), 0);
    },
    countSince(sinceTs) {
      return attempts.filter((a) => a.ts >= sinceTs).length;
    },
    deleteAll() {
      attempts = [];
      flush();
    },
    counts() {
      return { attempts: attempts.length };
    },
    close() { /* nothing to close */ },
  };
}

/* --------------------------------------------------------------- shared */

function normalize(a) {
  return {
    ts: Math.floor(Number(a.ts) || Date.now()),
    site: String(a.site || 'unknown').slice(0, 64),
    energy: Math.min(5, Math.max(1, Math.floor(Number(a.energy) || 3))),
    excuse: String(a.excuse || '').slice(0, 280),
    verdict: String(a.verdict || 'deny').slice(0, 16),
    need_category: String(a.need_category || 'other').slice(0, 16),
    minutes_granted: Math.max(0, Math.floor(Number(a.minutes_granted) || 0)),
    micro_task: String(a.micro_task || 'none').slice(0, 24),
    reason: String(a.reason || '').slice(0, 64),
    source: String(a.source || 'live').slice(0, 16),
    llm: a.llm === false ? 0 : 1,
    distress: a.distress ? 1 : 0,
  };
}

// sqlite rows come back as { llm: 0|1, distress: 0|1 }; normalize both shapes.
function rowToAttempt(r) {
  return {
    ...r,
    llm: !!r.llm,
    distress: !!r.distress,
  };
}

module.exports = { attemptStore, DATA_DIR };
