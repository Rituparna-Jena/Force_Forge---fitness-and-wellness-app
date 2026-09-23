/**
 * FocusForge v2 - end-to-end smoke test.
 *
 * Boots the real server on a scratch port (with its own data directory
 * swap so it never touches your real log), then exercises every endpoint
 * in both mock and (optionally) live-key mode.
 *
 * Usage: node scripts/smoke.js [--live]     (--live uses your real .env key)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const LIVE = process.argv.includes('--live');

// Isolate the smoke run's data from real data BEFORE requiring the app.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'focusforge-smoke-'));
const dataDir = path.join(__dirname, '..', 'data');
const dataBackup = fs.existsSync(dataDir) ? null : true;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
for (const f of fs.readdirSync(dataDir)) {
  fs.renameSync(path.join(dataDir, f), path.join(scratch, f));
}

// The real environment may export PORT; the smoke run always overrides it.
process.env.PORT = '3123';
if (LIVE) {
  // keep real key; ensure mock is off
  process.env.MOCK_LLM = 'false';
} else {
  process.env.MOCK_LLM = 'true';
}

const { store } = require('../lib/storage');
const { clearInsightCache } = require('../lib/insight');

const BASE = `http://localhost:${process.env.PORT}`;
let failures = 0;

function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  }
}

async function j(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function main() {
  console.log(`[smoke] scratch data dir: ${scratch}`);
  console.log(`[smoke] mock mode: ${!LIVE}`);

  const server = require('../server');

  // wait for listen
  await new Promise((r) => setTimeout(r, 300));

  try {
    console.log('\n/health');
    const h = await j('GET', '/health');
    check('health 200', h.status === 200, h);
    check('engine reported', ['sqlite', 'json'].includes(h.json && h.json.engine), h.json);

    console.log('\n/judge (fresh excuse -> should pass prefilter and reach LLM)');
    const a = await j('POST', '/judge', { site: 'youtube', energy: 3, excuse: 'my exam is tomorrow and i am stressed' });
    check('judge 200', a.status === 200, a);
    check('verdict present', ['deny', 'task', 'allow'].includes(a.json && a.json.verdict), a.json);
    check('schema fields', a.json && ['need_category', 'excuse_strength', 'minutes_granted', 'micro_task', 'roast', 'distress_flag'].every((k) => k in a.json), a.json);
    check('minutes 0-10', a.json && a.json.minutes_granted >= 0 && a.json.minutes_granted <= 10, a.json);

    console.log('\n/judge (same excuse again -> repeat_excuse auto-deny, no LLM)');
    const b = await j('POST', '/judge', { site: 'youtube', energy: 3, excuse: 'my exam is tomorrow and i am stressed' });
    check('prefilter fired', b.json && b.json.prefilter === 'repeat_excuse', b.json);
    check('verdict deny', b.json && b.json.verdict === 'deny', b.json);

    console.log('\n/judge (near-identical -> near_identical_excuse)');
    const b2 = await j('POST', '/judge', { site: 'youtube', energy: 3, excuse: 'my exam is tomorrow and i am stressed!!' });
    check('near-identical fired', b2.json && b2.json.prefilter === 'near_identical_excuse', b2.json);

    console.log('\n/judge (validation errors)');
    const bad = await j('POST', '/judge', { site: 'tiktok', energy: 3, excuse: 'x' });
    check('400 on bad site', bad.status === 400, bad);
    const badEnergy = await j('POST', '/judge', { site: 'youtube', energy: 99, excuse: 'x' });
    check('400 on bad energy', badEnergy.status === 400, badEnergy);

    console.log('\n/judge (distress wording -> supportive override)');
    const d = await j('POST', '/judge', { site: 'instagram', energy: 1, excuse: 'i feel completely hopeless and worthless tonight' });
    check('distress flagged', d.json && d.json.distress_flag === true, d.json);
    check('supportive tone', d.json && !/roast/i.test(d.json.roast || ''), d.json);

    console.log('\n/stats');
    const s = await j('GET', '/stats');
    check('stats 200', s.status === 200, s);
    check('has byHour(24)', s.json && Array.isArray(s.json.byHour) && s.json.byHour.length === 24, s.json && s.json.byHour && s.json.byHour.length);
    check('has byWeekday(7)', s.json && s.json.byWeekday.length === 7);
    check('has byNeed + byEnergy + days(14)', s.json && s.json.byNeed && s.json.byEnergy.length === 5 && s.json.days.length === 14);
    check('estimate labeled', s.json && s.json.totals.estimateAssumptions && typeof s.json.totals.estimateAssumptions.note === 'string');

    console.log('\n/insight (cached on second call)');
    const i1 = await j('POST', '/insight', { source: 'all' });
    const i2 = await j('POST', '/insight', { source: 'all' });
    check('insight 200', i1.status === 200, i1);
    check('narrative + 3-day experiment', i1.json && i1.json.insight && i1.json.insight.narrative && i1.json.insight.experiment.length === 3, i1.json && i1.json.insight);
    check('second call cached', i2.json && i2.json.cached === true, i2.json);

    console.log('\n/dashboard');
    const dash = await fetch(BASE + '/dashboard');
    const html = await dash.text();
    check('dashboard 200 + html', dash.status === 200 && html.includes('<!DOCTYPE html'), dash.status);

    console.log('\nCORS: extension origin allowed, evil origin rejected');
    const corsRes = await fetch(BASE + '/stats', { headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
    check('extension origin ok', corsRes.status === 200 && corsRes.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefghijklmnop');
    const evil = await fetch(BASE + '/stats', { headers: { Origin: 'https://evil.example' } });
    check('foreign origin 403', evil.status === 403, evil.status);

    console.log('\nDELETE /data');
    const del = await j('DELETE', '/data');
    check('delete ok + empty', del.status === 200 && del.json.counts.attempts === 0, del.json);

    console.log('\nsetup round-trip (mock mode toggle)');
    const su = await j('POST', '/setup', { mockLlm: true });
    check('setup accepts mock toggle', su.status === 200 && su.json.mockMode === true, su.json);
  } finally {
    server.close && server.close();
  }

  // restore original data files
  for (const f of fs.readdirSync(dataDir)) {
    try { fs.rmSync(path.join(dataDir, f), { recursive: true, force: true }); } catch (_) {}
  }
  for (const f of fs.readdirSync(scratch)) {
    fs.renameSync(path.join(scratch, f), path.join(dataDir, f));
  }
  if (dataBackup) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }

  console.log('');
  if (failures === 0) {
    console.log('[smoke] ALL PASS');
  } else {
    console.error(`[smoke] ${failures} FAILURES`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
