/**
 * FocusForge v2 - deterministic server-side pre-filter.
 *
 * Runs BEFORE any LLM call. Cheap checks that auto-deny without spending
 * an API request:
 *   1. repeat / near-identical excuse (trigram Jaccard >= 0.8 against any
 *      excuse from the last REPEAT_WINDOW_MINUTES)
 *   2. cooldown: an allow granted inside COOLDOWN_MINUTES is still running
 *      (plus a short settle period after it ends)
 *   3. daily minute budget exhausted, or hourly attempt budget hit
 *
 * Everything here is plain JS. No model, no randomness, same input and
 * same database state produce the same output.
 */
'use strict';

const REPEAT_WINDOW_MINUTES = 20;
const SIMILARITY_THRESHOLD = 0.8;

/**
 * @param {object} p
 * @param {{site:string, energy:number, excuse:string}} p.payload
 * @param {object} p.store            storage interface
 * @param {number} p.now              epoch ms
 * @param {object} p.config           app config
 * @returns {{pass: boolean, reason: string, detail?: object}}
 */
function prefilter({ payload, store, now, config }) {
  const excuse = String(payload.excuse || '').trim();
  const site = String(payload.site || '');

  // 1. repeat / near-identical excuse
  const windowStart = now - REPEAT_WINDOW_MINUTES * 60 * 1000;
  const recent = store.attemptsSince(windowStart);
  for (const a of recent) {
    const aExcuse = String(a.excuse || '').trim();
    if (!aExcuse) continue;
    if (aExcuse.toLowerCase() === excuse.toLowerCase() && excuse.length > 0) {
      return {
        pass: false,
        reason: 'repeat_excuse',
        detail: { similarity: 1, matchedTs: a.ts },
      };
    }
    const sim = trigramJaccard(excuse, aExcuse);
    if (excuse.length >= 8 && sim >= SIMILARITY_THRESHOLD) {
      return {
        pass: false,
        reason: 'near_identical_excuse',
        detail: { similarity: Math.round(sim * 100) / 100, matchedTs: a.ts },
      };
    }
  }

  // 2. cooldown: an allow inside the last (cooldown + its runtime) is live.
  // Seeded/simulated rows keep real wall-clock gaps, so an old seed grant
  // (e.g. minutes_granted=8 from yesterday) never blocks today.
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const liveGrants = recent.filter((a) => a.verdict === 'allow');
  for (const g of liveGrants) {
    const endsAt = g.ts + (g.minutes_granted || 0) * 60 * 1000;
    if (now < endsAt + cooldownMs) {
      return {
        pass: false,
        reason: 'cooldown_active',
        detail: { endsAt, settleAt: endsAt + cooldownMs },
      };
    }
  }

  // 3a. daily minute budget
  const dayStart = startOfDay(now);
  const used = store.dailyAllowedSum(dayStart, now + 1);
  const remaining = Math.max(0, config.dailyAllowanceMinutes - used);
  if (remaining <= 0) {
    return {
      pass: false,
      reason: 'daily_budget_exhausted',
      detail: { used, cap: config.dailyAllowanceMinutes },
    };
  }

  // 3b. hourly attempt budget (a soft kill-switch against hammering)
  const hourCount = store.countSince(now - 60 * 60 * 1000);
  if (hourCount >= config.attemptBudgetPerHour) {
    return {
      pass: false,
      reason: 'hourly_attempt_budget',
      detail: { used: hourCount, cap: config.attemptBudgetPerHour },
    };
  }

  return { pass: true, reason: 'ok', detail: { remainingMinutes: remaining } };
}

/* ------------------------------------------------------------ utilities */

function trigrams(s) {
  const t = ' ' + String(s).toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function trigramJaccard(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = { prefilter, trigramJaccard, SIMILARITY_THRESHOLD, REPEAT_WINDOW_MINUTES };
