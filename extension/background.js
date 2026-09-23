/**
 * FocusForge v2 - service worker (MV3).
 *
 * ALL network calls to the backend happen here, never in the content
 * script. Session state (active allow-grants, per-site attempt counts)
 * lives in chrome.storage so the worker can be killed at any moment
 * without losing the door state.
 *
 * Messages understood:
 *   FF_CHECK_GATE  {site}              -> {open, until}
 *   FF_JUDGE       {site, energy, excuse} -> verdict payload from /judge
 *   FF_TASK_DONE   {attemptId}         -> {ok}
 *   FF_CLEAR_GRANT {site}              -> {ok}
 */

const DEFAULT_API = "http://localhost:3000";

/* ------------------------------------------------------------ storage -- */

async function get(key, fallback) {
  try {
    const bag = await chrome.storage.local.get(key);
    return key in bag ? bag[key] : fallback;
  } catch (_) {
    return fallback;
  }
}

async function set(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (_) { /* storage unavailable: fail closed next check */ }
}

async function apiBase() {
  return (await get("apiBase", null)) || DEFAULT_API;
}

async function getGrants() {
  return (await get("grants", {})) || {};
}

async function setGrant(site, grant) {
  const grants = await getGrants();
  grants[site] = grant;
  await set("grants", grants);
}

async function clearGrant(site) {
  const grants = await getGrants();
  delete grants[site];
  await set("grants", grants);
}

/** An allow-grant is open while now < until. Expired grants are pruned. */
async function gateState(site) {
  const grants = await getGrants();
  const g = grants[site];
  const now = Date.now();
  if (g && now < g.until) {
    return { open: true, until: g.until, attemptId: g.attemptId };
  }
  if (g) await clearGrant(site);
  return { open: false, until: 0, attemptId: null };
}

/* -------------------------------------------------------------- fetch -- */

async function judgeRequest({ site, energy, excuse }) {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/judge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site, energy, excuse }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.error || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: `server unreachable: ${err.message}` };
  }
}

/** Track today's attempt count in storage for the overlay's intro line. */
async function bumpAttemptCount(serverOut) {
  const today = new Date().toDateString();
  const rec = await get("attemptCount", null);
  const count = rec && rec.day === today ? (rec.count || 0) + 1 : 1;
  const n = serverOut && typeof serverOut.attemptCount === "number"
    ? serverOut.attemptCount
    : count;
  await set("attemptCount", { day: today, count: n });
}

/** Offline / backend-down fallback so the overlay always has a verdict. */
function offlineVerdict(msg) {
  return {
    verdict: "deny",
    need_category: "other",
    excuse_strength: 0,
    minutes_granted: 0,
    micro_task: { type: "breathing", seconds: 60 },
    roast: `The doorman is unreachable (${msg}), so the door stays shut by default. Do the sixty-second reset, then decide if the tab is still worth it.`,
    distress_flag: false,
    offline: true,
    serverNow: Date.now(),
    attemptCount: null,
  };
}

/* ----------------------------------------------------------- messages -- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "FF_CHECK_GATE": {
        const state = await gateState(String(msg.site || ""));
        sendResponse(state);
        break;
      }

      case "FF_JUDGE": {
        const site = String(msg.site || "");
        const energy = Number(msg.energy);
        const excuse = String(msg.excuse || "");
        const out = await judgeRequest({ site, energy, excuse });
        if (out.error) {
          sendResponse(offlineVerdict(out.error));
          break;
        }
        if (out.verdict === "allow" && out.minutes_granted > 0) {
          await setGrant(site, {
            until: (out.serverNow || Date.now()) + out.minutes_granted * 60000,
            attemptId: out.attemptId || null,
          });
        }
        await bumpAttemptCount(out);
        sendResponse(out);
        break;
      }

      case "FF_TASK_DONE": {
        // Kept simple: the log of record lives server-side; the worker only
        // remembers that the current gate-holder finished their task.
        await set("lastTaskDone", { attemptId: msg.attemptId || null, at: Date.now() });
        sendResponse({ ok: true });
        break;
      }

      case "FF_CLEAR_GRANT": {
        await clearGrant(String(msg.site || ""));
        sendResponse({ ok: true });
        break;
      }

      case "FF_ATTEMPT_COUNT": {
        const rec = await get("attemptCount", null);
        const today = new Date().toDateString();
        sendResponse({ count: rec && rec.day === today ? rec.count : 0 });
        break;
      }

      case "FF_PING": {
        const base = await apiBase();
        try {
          const res = await fetch(`${base}/health`);
          sendResponse({ ok: res.ok, base });
        } catch (err) {
          sendResponse({ ok: false, base, error: err.message });
        }
        break;
      }

      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});
