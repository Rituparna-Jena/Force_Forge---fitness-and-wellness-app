/**
 * FocusForge v2 - deterministic analytics.
 *
 * Plain JS over the attempt log. No model involved. /insight consumes the
 * JSON produced here, never the raw logs.
 */
'use strict';

const NEEDS = ['tired', 'bored', 'stressed', 'lonely', 'avoiding', 'genuine', 'other'];
const SITES = ['youtube', 'instagram', 'other'];
const VERDICTS = ['deny', 'task', 'allow'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * @param {Array} attempts  storage rows (ts, site, energy, excuse, verdict,
 *                          need_category, minutes_granted, reason, source, llm)
 * @param {number} now      epoch ms
 * @param {object} config   app config (for the allowance assumption line)
 */
function computeStats(attempts, now, config) {
  const total = attempts.length;

  // hour-of-day (0-23)
  const byHour = range(24, () => ({ count: 0, denied: 0, allowed: 0 }));
  // weekday (0-6, Sun first)
  const byWeekday = range(7, () => ({ count: 0, denied: 0 }));
  // site
  const bySite = Object.fromEntries(SITES.map((s) => [s, { count: 0, denied: 0, minutes: 0 }]));
  // need category
  const byNeed = Object.fromEntries(NEEDS.map((n) => [n, 0]));
  // verdicts
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  // energy 1-5
  const byEnergy = range(6, () => ({ count: 0, denied: 0, tasks: 0, allowed: 0 })); // index 0 unused

  let minutesGrantedTotal = 0;
  let liveCount = 0;
  let firstTs = null;
  let lastTs = null;

  for (const a of attempts) {
    const d = new Date(a.ts);
    const site = SITES.includes(a.site) ? a.site : 'other';

    byHour[d.getHours()].count++;
    if (a.verdict === 'deny') byHour[d.getHours()].denied++;
    if (a.verdict === 'allow') byHour[d.getHours()].allowed++;

    byWeekday[d.getDay()].count++;
    if (a.verdict === 'deny') byWeekday[d.getDay()].denied++;

    bySite[site].count++;
    if (a.verdict === 'deny') bySite[site].denied++;
    bySite[site].minutes += a.minutes_granted || 0;

    if (byNeed[a.need_category] !== undefined) byNeed[a.need_category]++;
    if (byVerdict[a.verdict] !== undefined) byVerdict[a.verdict]++;

    const e = Math.min(5, Math.max(1, a.energy | 0));
    byEnergy[e].count++;
    if (a.verdict === 'deny') byEnergy[e].denied++;
    if (a.verdict === 'task') byEnergy[e].tasks++;
    if (a.verdict === 'allow') byEnergy[e].allowed++;

    minutesGrantedTotal += a.minutes_granted || 0;
    if (a.source === 'live') liveCount++;
    if (firstTs === null || a.ts < firstTs) firstTs = a.ts;
    if (lastTs === null || a.ts > lastTs) lastTs = a.ts;
  }

  // denial rate over time: per-day series for the last 14 days
  const days = [];
  const dayStart = startOfDay(now) - 13 * 86400000;
  for (let i = 0; i < 14; i++) {
    const from = dayStart + i * 86400000;
    const to = from + 86400000;
    const rows = attempts.filter((a) => a.ts >= from && a.ts < to);
    const denies = rows.filter((a) => a.verdict === 'deny').length;
    const allows = rows.filter((a) => a.verdict === 'allow').length;
    days.push({
      date: new Date(from).toISOString().slice(0, 10),
      attempts: rows.length,
      denied: denies,
      allowed: allows,
      denialRate: rows.length ? round2(denies / rows.length) : null,
      allowRate: rows.length ? round2(allows / rows.length) : null,
    });
  }

  // estimated minutes reclaimed: minutes the bouncer did NOT grant, and
  // therefore (assumption) were not spent on the site. Each denied attempt
  // is assumed to have cost 6 minutes of doomscrolling that now did not
  // happen; each micro-task is assumed to have replaced the visit with a
  // 1.5 minute reset. Labelled an estimate everywhere it is shown.
  const deniedCount = byVerdict.deny;
  const taskCount = byVerdict.task;
  const ASSUMED_LOST_MINUTES_PER_DENY = 6;
  const ASSUMED_RESET_MINUTES_PER_TASK = 1.5;
  const minutesReclaimedEstimate = round1(
    deniedCount * ASSUMED_LOST_MINUTES_PER_DENY + taskCount * ASSUMED_RESET_MINUTES_PER_TASK
  );

  const peakHour = argmax(byHour, (h) => h.count);
  const topNeed = argmaxDict(byNeed);
  const topSite = argmaxDict(countMap(bySite));

  return {
    generatedAt: now,
    window: { firstTs, lastTs, days: 14 },
    totals: {
      attempts: total,
      liveAttempts: liveCount,
      simulatedAttempts: total - liveCount,
      denied: byVerdict.deny,
      tasks: byVerdict.task,
      allowed: byVerdict.allow,
      denialRate: total ? round2(byVerdict.deny / total) : null,
      taskRate: total ? round2(taskCount / total) : null,
      allowRate: total ? round2(byVerdict.allow / total) : null,
      minutesGrantedTotal,
      minutesReclaimedEstimate,
      estimateAssumptions: {
        perDeniedAttemptMinutes: ASSUMED_LOST_MINUTES_PER_DENY,
        perTaskMinutes: ASSUMED_RESET_MINUTES_PER_TASK,
        note:
          'Estimate assumes each denied attempt would have become a 6-minute scroll session and each micro-task replaced the visit with a 1.5-minute reset. Granted minutes are counted exactly.',
      },
    },
    byHour,
    byWeekday: byWeekday.map((w, i) => ({ day: DAYS[i], ...w })),
    bySite,
    byNeed,
    byEnergy: byEnergy.slice(1).map((e, i) => ({ energy: i + 1, ...e })),
    days,
    peaks: {
      peakHour,
      topNeed,
      topSite,
    },
    sampleSizeWarning: total < 20,
    allowance: {
      dailyCap: config.dailyAllowanceMinutes,
      modelCapPerVerdict: 10,
    },
  };
}

/* ------------------------------------------------------------ utilities */

function range(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function argmax(arr, get) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (get(arr[i]) > get(arr[best])) best = i;
  return best;
}

function argmaxDict(dict) {
  let bestKey = null;
  let bestVal = -1;
  for (const [k, v] of Object.entries(dict)) {
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestKey;
}

function countMap(bySite) {
  const out = {};
  for (const [k, v] of Object.entries(bySite)) out[k] = v.count;
  return out;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = { computeStats };
