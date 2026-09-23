/**
 * FocusForge v2 - Express server.
 *
 * Endpoints:
 *   POST /judge      pre-filter -> LLM -> validate -> clamp -> log -> verdict
 *   GET  /stats      deterministic fingerprint numbers (no LLM)
 *   POST /insight    LLM narration of stats + 3-day experiment (cached)
 *   GET  /dashboard  static dashboard page
 *   GET  /health     status + redacted key info (for the setup screen)
 *   POST /setup      write .env / config from the dashboard form
 *   DELETE /data     wipe every logged attempt
 *
 * Security posture: the API key lives only in this process' memory / local
 * config file. CORS is restricted to the extension origin. Rate limiting is
 * a small in-process token bucket (no external service).
 */
'use strict';

const path = require('path');
const express = require('express');

const { config, writeConfigFile, keyStatus } = require('./lib/config');
const { attemptStore } = require('./lib/storage');
const { prefilter } = require('./lib/prefilter');
const { validateVerdict, safeDeny } = require('./lib/validate');
const { judge } = require('./lib/llm');
const { computeStats } = require('./lib/stats');
const { getInsight, clearInsightCache } = require('./lib/insight');

const { store, engine } = attemptStore();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

/* ------------------------------------------------------------------ CORS */
/* Only the extension origin (chrome-extension://<id>) and the dashboard's
   own origin may call the JSON API. */
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  } else if (origin && origin !== `http://localhost:${config.port}` && origin !== `http://127.0.0.1:${config.port}`) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  next();
});

/* ---------------------------------------------------------- rate limit  */
/* Token bucket per IP: 30 requests / minute for /judge, 60 / min overall. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const nowTs = Date.now();
    const rec = hits.get(key) || { count: 0, resetAt: nowTs + windowMs };
    if (nowTs > rec.resetAt) {
      rec.count = 0;
      rec.resetAt = nowTs + windowMs;
    }
    rec.count++;
    hits.set(key, rec);
    if (rec.count > max) {
      return res.status(429).json({ error: 'rate limited, slow down' });
    }
    next();
  };
}

const judgeLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 60 });

/* ------------------------------------------------------------- routes -- */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    engine,
    mockMode: config.mockLlm,
    ...keyStatus(),
    counts: store.counts(),
  });
});

app.post('/judge', judgeLimiter, async (req, res) => {
  const { site, energy, excuse } = req.body || {};
  const payload = {
    site: String(site || '').toLowerCase().replace(/^www\./, '').split('/')[0],
    energy: Number(energy),
    excuse: String(excuse || '').slice(0, 280),
  };

  if (!payload.site || !['youtube', 'instagram', 'other'].includes(payload.site)) {
    return res.status(400).json({ error: 'site must be youtube, instagram or other' });
  }
  if (!Number.isFinite(payload.energy) || payload.energy < 1 || payload.energy > 5) {
    return res.status(400).json({ error: 'energy must be 1-5' });
  }

  const nowTs = Date.now();
  const pf = prefilter({ payload, store, now: nowTs, config });
  if (!pf.pass) {
    // Auto-deny without spending an API call. Still logged, flagged llm:false.
    const verdict = safeDeny(autoDenyCopy(pf.reason), 'avoiding');
    const logged = store.insertAttempt({
      ts: nowTs,
      site: payload.site,
      energy: payload.energy,
      excuse: payload.excuse,
      verdict: 'deny',
      need_category: 'other',
      minutes_granted: 0,
      micro_task: 'none',
      reason: pf.reason,
      source: 'live',
      llm: false,
      distress: false,
    });
    return res.json({ ...verdict, prefilter: pf.reason, attemptId: logged.id, attemptCount: 0, serverNow: nowTs });
  }

  const attemptCount = store.countSince(startOfDay(nowTs)) + 1;

  let verdict;
  try {
    verdict = await judge({
      site: payload.site,
      energy: payload.energy,
      excuse: payload.excuse,
      attemptCount,
    });
  } catch (err) {
    console.error('[judge] llm error:', err.message);
    verdict = safeDeny('The doorman is offline, so the door stays shut. Try again in a few minutes or do the thing you opened this tab to avoid.');
  }

  // Server-side clamp: the model never has final authority on minutes.
  const used = store.dailyAllowedSum(startOfDay(nowTs), nowTs + 1);
  const remaining = Math.max(0, config.dailyAllowanceMinutes - used);
  const finalCheck = validateVerdict(verdict, { dailyMinutesCap: remaining });
  verdict = finalCheck.ok ? finalCheck.verdict : safeDeny('The math did not add up, so the door stayed shut.');

  // Distress override: supportive, persona-free, no roast, no game.
  if (verdict.distress_flag) {
    verdict = distressOverride(verdict);
  }

  const logged = store.insertAttempt({
    ts: nowTs,
    site: payload.site,
    energy: payload.energy,
    excuse: payload.excuse,
    verdict: verdict.verdict,
    need_category: verdict.need_category,
    minutes_granted: verdict.minutes_granted,
    micro_task: verdict.micro_task.type,
    reason: 'ok',
    source: 'live',
    llm: !config.mockLlm,
    distress: !!verdict.distress_flag,
  });

  res.json({ ...verdict, prefilter: 'ok', attemptId: logged.id, attemptCount, serverNow: nowTs });
});

app.get('/stats', apiLimiter, (req, res) => {
  const filter = String(req.query.source || 'all'); // all | live | simulated
  let attempts = store.allAttempts();
  if (filter === 'live') attempts = attempts.filter((a) => a.source === 'live');
  if (filter === 'simulated') attempts = attempts.filter((a) => a.source === 'simulated');
  res.json({ ...computeStats(attempts, Date.now(), config), storeEngine: engine, filter });
});

app.post('/insight', apiLimiter, async (req, res) => {
  try {
    const filter = String((req.body && req.body.source) || 'all');
    let attempts = store.allAttempts();
    if (filter === 'live') attempts = attempts.filter((a) => a.source === 'live');
    if (filter === 'simulated') attempts = attempts.filter((a) => a.source === 'simulated');
    const stats = computeStats(attempts, Date.now(), config);
    const out = await getInsight(stats);
    res.json(out);
  } catch (err) {
    console.error('[insight] failed:', err.message);
    res.status(500).json({ error: 'insight generation failed' });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.use('/dashboard', express.static(path.join(__dirname, 'dashboard'), { maxAge: 0 }));

/* First-run setup: paste your key in the dashboard, it lands in the local
   config file (git-ignored) and hot-reloads into the running server. */
app.post('/setup', apiLimiter, (req, res) => {
  const patch = {};
  if (typeof req.body.apiKey === 'string') patch.apiKey = req.body.apiKey.trim();
  if (typeof req.body.model === 'string') patch.model = req.body.model;
  if (typeof req.body.baseUrl === 'string') patch.baseUrl = req.body.baseUrl;
  if (typeof req.body.mockLlm === 'boolean') patch.mockLlm = req.body.mockLlm;

  if (patch.apiKey === undefined && patch.model === undefined && patch.baseUrl === undefined && patch.mockLlm === undefined) {
    return res.status(400).json({ error: 'nothing to save' });
  }
  if (patch.mockLlm === false && (!patch.apiKey && !config.apiKey)) {
    return res.status(400).json({ error: 'a real key is required when mock mode is off' });
  }

  try {
    writeConfigFile(patch);
    clearInsightCache();
    res.json({ ok: true, ...keyStatus() });
  } catch (err) {
    res.status(500).json({ error: 'could not write config: ' + err.message });
  }
});

app.delete('/data', apiLimiter, (req, res) => {
  store.deleteAll();
  clearInsightCache();
  res.json({ ok: true, counts: store.counts() });
});

/* ------------------------------------------------------------- helpers - */

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function autoDenyCopy(reason) {
  switch (reason) {
    case 'repeat_excuse':
    case 'near_identical_excuse':
      return 'Same excuse, same door, same answer. The reset is the point: stand up, drink water, then come back with a real reason or not at all.';
    case 'cooldown_active':
      return 'A granted window is already running somewhere else. Finish it or let it lapse; the door opens again when the timer is done.';
    case 'daily_budget_exhausted':
      return "Today's allowance is spent. This is the part of the evening where the tab closes itself.";
    case 'hourly_attempt_budget':
      return 'That is a lot of knocking in one hour. The knob needs a rest, and honestly, so do you.';
    default:
      return 'The door stayed shut.';
  }
}

function distressOverride(v) {
  return {
    ...v,
    verdict: 'deny',
    minutes_granted: 0,
    micro_task: { type: 'breathing', seconds: 60 },
    roast:
      'That sounds heavier than any website. Please put the phone down and reach out to someone you trust, or a local crisis line; the feed will still be here tomorrow.',
    distress_flag: true,
  };
}

/* --------------------------------------------------------------- start - */

const server = app.listen(config.port, () => {
  console.log('');
  console.log('  FocusForge v2 bouncer on duty');
  console.log('  ---------------------------------------------');
  console.log(`  dashboard    http://localhost:${config.port}/dashboard`);
  console.log(`  judge        POST http://localhost:${config.port}/judge`);
  console.log(`  storage      ${engine}`);
  console.log(`  mock LLM     ${config.mockLlm ? 'yes (canned verdicts, no key needed)' : 'no'}`);
  console.log(`  model        ${config.model}`);
  console.log(`  api key      ${config.apiKey ? 'configured (kept server-side)' : 'not configured'}`);
  console.log('  ---------------------------------------------');
  console.log('');
});

module.exports = server;
