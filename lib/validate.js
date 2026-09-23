/**
 * FocusForge v2 - strict validation of the LLM verdict.
 *
 * The bouncer prompt demands exact JSON. Whatever comes back is checked
 * field by field against the schema; anything malformed is rejected here
 * and the caller retries once, then falls back to a canned verdict.
 */
'use strict';

const NEEDS = ['tired', 'bored', 'stressed', 'lonely', 'avoiding', 'genuine', 'other'];
const VERDICTS = ['deny', 'task', 'allow'];
const TASKS = ['breathing', 'water', 'stretch', 'eye_rest', 'walk', 'first_step', 'none'];

/** Returns { ok: true, verdict } or { ok: false, errors }.
 *  `caps` may carry server-side authority overrides (dailyMinutesCap). */
function validateVerdict(obj, caps = {}) {
  const errors = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, errors: ['not an object'] };
  }

  const verdict = obj.verdict;
  if (!VERDICTS.includes(verdict)) errors.push(`verdict must be one of ${VERDICTS.join(', ')}`);

  const need_category = obj.need_category;
  if (!NEEDS.includes(need_category)) errors.push(`need_category must be one of ${NEEDS.join(', ')}`);

  const excuse_strength = toInt(obj.excuse_strength);
  if (excuse_strength === null || excuse_strength < 1 || excuse_strength > 10) {
    errors.push('excuse_strength must be an integer 1-10');
  }

  let minutes_granted = toInt(obj.minutes_granted);
  if (minutes_granted === null || minutes_granted < 0 || minutes_granted > 10) {
    errors.push('minutes_granted must be an integer 0-10');
  }

  const task = obj.micro_task && typeof obj.micro_task === 'object' && !Array.isArray(obj.micro_task)
    ? obj.micro_task
    : {};
  const microTaskType = task.type;
  if (!TASKS.includes(microTaskType)) errors.push(`micro_task.type must be one of ${TASKS.join(', ')}`);
  const microTaskSeconds = toInt(task.seconds);
  if (microTaskSeconds === null || microTaskSeconds < 0 || microTaskSeconds > 120) {
    errors.push('micro_task.seconds must be an integer 0-120');
  }

  const roast = typeof obj.roast === 'string' ? obj.roast.trim() : '';
  if (!roast) errors.push('roast must be a non-empty string');
  if (roast.length > 280) errors.push('roast must be 280 characters or fewer');

  if (typeof obj.distress_flag !== 'boolean') errors.push('distress_flag must be true or false');

  if (errors.length) return { ok: false, errors };

  // ---- server authority: clamp minutes regardless of what the model said.
  if (verdict === 'allow' && minutes_granted === 0) minutes_granted = 1;
  if (verdict !== 'allow') minutes_granted = 0;
  if (caps.dailyMinutesCap !== undefined) {
    minutes_granted = Math.min(minutes_granted, Math.max(0, caps.dailyMinutesCap));
    if (verdict === 'allow' && minutes_granted === 0) {
      // Cap exhausted: an allow is impossible, downgrade to deny.
      return {
        ok: true,
        verdict: {
          verdict: 'deny',
          need_category,
          excuse_strength,
          minutes_granted: 0,
          micro_task: { type: microTaskType === 'none' ? 'none' : microTaskType, seconds: microTaskSeconds },
          roast,
          distress_flag: obj.distress_flag,
          _downgraded: true,
        },
      };
    }
  }

  // Consistency rules: tasks need a real task; denies grant nothing.
  let micro = { type: microTaskType, seconds: microTaskSeconds };
  if (verdict === 'task') {
    if (micro.type === 'none') micro = { type: 'breathing', seconds: 60 };
    if (micro.seconds < 10) micro.seconds = 30;
  } else {
    micro = { type: 'none', seconds: 0 };
  }

  return {
    ok: true,
    verdict: {
      verdict,
      need_category,
      excuse_strength,
      minutes_granted,
      micro_task: micro,
      roast,
      distress_flag: obj.distress_flag,
    },
  };
}

/** Best-effort coercion used only for the CANNED fallbacks, never for raw
 *  model output. Raw model output must pass strict validation. */
function coerceVerdict(partial) {
  const v = validateVerdict(partial);
  return v.ok ? v.verdict : safeDeny('The door stayed shut.');
}

function safeDeny(roast, need = 'other') {
  return {
    verdict: 'deny',
    need_category: need,
    excuse_strength: 5,
    minutes_granted: 0,
    micro_task: { type: 'breathing', seconds: 60 },
    roast: String(roast || 'The door stayed shut.').slice(0, 280),
    distress_flag: false,
  };
}

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

module.exports = { validateVerdict, safeDeny, NEEDS, VERDICTS, TASKS };
