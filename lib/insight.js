/**
 * FocusForge v2 - insight narration (the "Attention & Energy Fingerprint").
 *
 * Sends ONLY the computed stats JSON to the LLM, never raw logs, never
 * excuse text. Asks for a 3-sentence narrative that cites only numbers
 * present in the stats, plus a structured 3-day experiment. Response is
 * cached on disk so page loads do not re-bill the API.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('./config');
const { extractJson } = require('./llm');

const CACHE_FILE = path.join(config.dataDir, 'insight-cache.json');

const SYSTEM_PROMPT = `You are the analyst of a digital-wellbeing tool. You receive ONLY aggregate statistics about when, where and why a person's attention was intercepted, and you produce a short "Attention & Energy Fingerprint" plus a 3-day wellness experiment.

Hard rules:
1. Reply with EXACTLY one JSON object, no markdown, no commentary.
2. narrative: exactly 3 sentences. Every number you cite MUST appear verbatim in the stats you were given. Do not invent numbers, percentages, dates or trends the stats do not show.
3. If sampleSizeWarning is true, your first sentence must explicitly say the sample is small.
4. experiment: exactly 3 items (day 1, 2, 3), each with keys "day" (1-3), "hypothesis" (one sentence, testable), "change" (one concrete behavioral change), "measure" (what number from the stats to watch).
5. No medical claims, no diagnoses, no promises. No emojis. No em dashes. Max 2 sentences per field.
6. Tone: specific, wry, humane. Never mean. Never SaaS-marketing.

JSON schema:
{"narrative":"sentence one. sentence two. sentence three.","sampleSizeSmall":true,"experiment":[{"day":1,"hypothesis":"...","change":"...","measure":"..."},{"day":2,...},{"day":3,...}]}`;

/** Returns { cached: true, insight, generatedAt } or fresh insight. */
async function getInsight(stats) {
  const cached = readCache();
  if (cached && cached.statsFingerprint === fingerprint(stats)) {
    return { ...cached, cached: true };
  }

  const insight = await narrate(stats);
  const entry = {
    insight,
    generatedAt: Date.now(),
    statsFingerprint: fingerprint(stats),
    source: config.mockLlm ? 'mock' : 'llm',
  };
  writeCache(entry);
  return { ...entry, cached: false };
}

async function narrate(stats) {
  if (config.mockLlm) return mockInsight(stats);

  const userText =
    'Stats JSON (the only data you may cite):\n' +
    JSON.stringify(compactStats(stats), null, 1) +
    '\n\nReminder: reply with exactly one JSON object matching the schema. Cite only numbers present above.';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ];

  for (let i = 0; i < 2; i++) {
    try {
      const raw = await chatCompletion(messages);
      const parsed = extractJson(raw);
      if (!parsed) continue;
      const clean = validateInsight(parsed);
      if (clean) return clean;
    } catch (err) {
      console.warn('[insight] attempt %d failed: %s', i + 1, err.message);
    }
  }
  return mockInsight(stats); // safe fallback, clearly derived from stats
}

/* ----------------------------------------------------------- validation */

function validateInsight(parsed) {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const narrative = typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '';
  const sentences = narrative.split(/[.!?]+\s/).filter(Boolean);
  if (!narrative || narrative.length > 900 || sentences.length === 0) return null;

  const expRaw = Array.isArray(parsed.experiment) ? parsed.experiment : [];
  if (expRaw.length !== 3) return null;
  const experiment = [];
  for (let i = 0; i < 3; i++) {
    const e = expRaw[i] || {};
    const hypothesis = typeof e.hypothesis === 'string' ? e.hypothesis.trim() : '';
    const change = typeof e.change === 'string' ? e.change.trim() : '';
    const measure = typeof e.measure === 'string' ? e.measure.trim() : '';
    if (!hypothesis || !change || !measure) return null;
    experiment.push({
      day: i + 1,
      hypothesis: hypothesis.slice(0, 300),
      change: change.slice(0, 300),
      measure: measure.slice(0, 200),
    });
  }

  return {
    narrative: narrative.slice(0, 900),
    sampleSizeSmall: !!parsed.sampleSizeSmall,
    experiment,
  };
}

/** Strip fields the model should not see to keep the payload minimal. */
function compactStats(stats) {
  return {
    totals: stats.totals,
    byNeed: stats.byNeed,
    bySite: stats.bySite,
    byEnergy: stats.byEnergy,
    byWeekday: stats.byWeekday,
    peakHours: stats.byHour.map((h, i) => ({ hour: i, count: h.count })).filter((h) => h.count > 0),
    days: stats.days,
    peaks: stats.peaks,
    sampleSizeWarning: stats.sampleSizeWarning,
    allowance: stats.allowance,
  };
}

/* ---------------------------------------------------------------- cache */

function fingerprint(stats) {
  // Cheap cache key: totals + last attempt ts. New logs invalidate cache.
  return JSON.stringify([stats.totals.attempts, stats.window.lastTs]);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(entry) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.warn('[insight] cache write failed: %s', err.message);
  }
}

/* ----------------------------------------------------------------- mock */

function mockInsight(stats) {
  const t = stats.totals;
  const peak = stats.peaks.peakHour;
  const topNeed = stats.peaks.topNeed || 'other';
  const topNeedCount = stats.byNeed[topNeed] || 0;
  const denialPct = t.denialRate === null ? 'no' : Math.round(t.denialRate * 100);
  const small = stats.sampleSizeWarning;

  const narrative = small
    ? `The sample is small (${t.attempts} attempts), so read this as a sketch rather than a diagnosis. Most of the action came from ${topNeed} (${topNeedCount} attempts), and the bouncer denied ${denialPct === 'no' ? 'nothing yet' : denialPct + '%'} so far. ${peakLabel(peak)} is where the pattern is strongest so far; watch it before drawing conclusions.`
    : `The log shows ${t.attempts} attempts and the door stayed shut on ${denialPct}% of them, with ${topNeed} as the loudest need at ${topNeedCount} attempts. ${peakLabel(peak)} is your weak hour, and energy ${topEnergy(stats)} attempts outnumber the rest, which points at depletion rather than genuine demand. Of ${t.allowed} allowed visits you took ${t.minutesGrantedTotal} granted minutes, so the experiment below aims at the pattern, not the person.`;

  return {
    narrative,
    sampleSizeSmall: small,
    experiment: [
      {
        day: 1,
        hypothesis: `Delaying the first attempt of the day by one hour lowers total attempts versus the ${peakLabel(peak)} habit.`,
        change: 'No watched sites before ' + String((peak + 1) % 24).padStart(2, '0') + ':00; put the phone in another room at breakfast.',
        measure: 'attempts in the 14-day daily series',
      },
      {
        day: 2,
        hypothesis: `Most ${topNeed} attempts convert to micro-tasks without losing anything real.`,
        change: 'Accept every micro-task offered today instead of closing the overlay.',
        measure: `tasks (${t.tasks} so far) vs denied (${t.denied})`,
      },
      {
        day: 3,
        hypothesis: 'Allowed minutes cluster late in the day when energy is lowest.',
        change: 'Cap yourself to the daily allowance before 20:00 and log how the rest of the evening feels.',
        measure: `allowed (${t.allowed}) and minutesGrantedTotal (${t.minutesGrantedTotal})`,
      },
    ],
  };
}

function peakLabel(hour) {
  if (typeof hour !== 'number') return 'No clear peak hour yet';
  const h = ((hour + 1) % 12) || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  return `${h}${ampm}`;
}

function topEnergy(stats) {
  let best = 1;
  let bestCount = -1;
  for (const e of stats.byEnergy) {
    if (e.count > bestCount) {
      bestCount = e.count;
      best = e.energy;
    }
  }
  return best;
}

module.exports = { getInsight, clearInsightCache: () => { try { fs.unlinkSync(CACHE_FILE); } catch (_) {} } };
