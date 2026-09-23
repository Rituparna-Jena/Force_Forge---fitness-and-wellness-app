/**
 * FocusForge v2 - seed data generator.
 *
 * Produces ~14 days of SIMULATED history, every row tagged
 * source: "simulated", so the dashboard can tell it apart from live data.
 * Deterministic seed for reproducible charts.
 *
 * Usage:
 *   npm run seed            # adds to whatever exists
 *   npm run seed -- --wipe  # delete everything first
 */
'use strict';

const { attemptStore } = require('../lib/storage');

// xorshift32: tiny deterministic PRNG so charts are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const rng = makeRng(20260923);

const EXCUSES = {
  youtube: [
    'just one video then back to work',
    'need to check that tutorial thing',
    'listening to music while i work i swear',
    'quick look at the algorithm picks',
    'watching while eating lunch, legit',
    'tutorial for the thing i am building',
  ],
  instagram: [
    'checking messages real quick',
    'just scrolling a bit while tired',
    'friend posted something, need to see',
    'looking for that recipe i saw',
    'bored, nothing better to do',
    'just checking notifications i swear',
  ],
};

const NEEDS = ['tired', 'bored', 'stressed', 'lonely', 'avoiding', 'genuine'];

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function simulateDay(dayStartTs, attemptsThatDay) {
  const rows = [];
  for (let i = 0; i < attemptsThatDay; i++) {
    // Cluster attempts toward evening hours, heavy tail late.
    const hour = weightedHour();
    const ts = dayStartTs + hour * 3600000 + Math.floor(rng() * 3600000);
    const site = rng() < 0.55 ? 'youtube' : 'instagram';
    const energy = 1 + Math.floor(rng() * 5);
    const excuse = pick(EXCUSES[site]);
    const need = pick(NEEDS);

    // Outcome distribution varies with time of day: late-night denials rise.
    const denyBias = hour >= 22 ? 0.75 : hour >= 18 ? 0.55 : 0.4;
    const r = rng();
    let verdict, minutes = 0, task = 'none';
    if (r < denyBias) {
      verdict = 'deny';
    } else if (r < denyBias + 0.35) {
      verdict = 'task';
      task = pick(['breathing', 'water', 'stretch', 'eye_rest', 'walk', 'first_step']);
    } else {
      verdict = 'allow';
      minutes = 3 + Math.floor(rng() * 8); // 3-10
    }
    rows.push({
      ts,
      site,
      energy,
      excuse,
      verdict,
      need_category: need,
      minutes_granted: minutes,
      micro_task: task,
      reason: 'ok',
      source: 'simulated',
      llm: true,
      distress: false,
    });
  }
  return rows;
}

function weightedHour() {
  const r = rng();
  if (r < 0.15) return 8 + Math.floor(rng() * 4);   // morning-ish
  if (r < 0.45) return 12 + Math.floor(rng() * 5);  // lunch / afternoon
  if (r < 0.8) return 17 + Math.floor(rng() * 4);   // evening
  return 21 + Math.floor(rng() * 3);                // late night
}

function main() {
  const wipe = process.argv.includes('--wipe');
  const { store, engine } = attemptStore();

  if (wipe) {
    store.deleteAll();
    console.log('[seed] wiped all existing attempts');
  }

  const now = Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  let inserted = 0;
  // 14 days ending yesterday, plus a handful earlier today.
  for (let d = 13; d >= 0; d--) {
    const dayStart = todayStart - d * 86400000;
    if (dayStart > now) continue;
    // 3-12 attempts per day, weekend slightly heavier.
    const weekday = new Date(dayStart).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const base = weekend ? 6 + Math.floor(rng() * 6) : 3 + Math.floor(rng() * 7);
    const rows = simulateDay(Math.min(dayStart, todayStart), d === 0 ? Math.min(base, 5) : base);
    for (const row of rows) {
      if (row.ts > now) continue; // never seed the future
      store.insertAttempt(row);
      inserted++;
    }
  }

  console.log(`[seed] inserted ${inserted} simulated attempts (${engine})`);
  console.log('[seed] totals:', store.counts());
}

main();
