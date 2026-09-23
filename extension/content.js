/**
 * FocusForge v2 - content script / overlay gate.
 *
 * Injects a full-screen Shadow DOM overlay before the page is usable.
 * All network calls go through the service worker via chrome.runtime
 * messages; nothing here fetches directly.
 */
'use strict';

(() => {
  if (window.__focusforgeLoaded) return;
  window.__focusforgeLoaded = true;

  const SITE = location.hostname.replace(/^www\./, '').replace(/^m\./, '').split('.')[0];

  const TASK_COPY = {
    breathing: { label: 'Box breathing', line: 'In 4, hold 4, out 4, hold 4. Follow the number.' },
    water: { label: 'Drink water', line: 'Fill a glass and actually finish it.' },
    stretch: { label: 'Stretch out', line: 'Roll your shoulders back slowly until the timer ends.' },
    eye_rest: { label: 'Eye rest', line: 'Look at something far away. Blink on purpose.' },
    walk: { label: 'Short walk', line: 'One lap of the room, hallway or floor. No phone in hand.' },
    first_step: { label: 'First step', line: 'Open the thing you are avoiding and do the smallest piece of it.' },
  };

  const RESET_LINE =
    'Stand up. Roll your shoulders once. Drink water. Look out a window for twenty ' +
    'seconds, then go do the first small piece of the actual thing.';

  /* ---------------------------------------------------------- state -- */
  let overlayOpen = false;
  let taskTimer = null;

  /* --------------------------------------------------- shadow setup -- */
  const host = document.createElement('div');
  host.id = 'focusforge-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .ff-gate {
      position: fixed; inset: 0; z-index: 2147483647;
      background: #14140f; color: #e8e2d4;
      font-family: Georgia, 'Times New Roman', serif;
      display: flex; align-items: center; justify-content: center;
      padding: 24px; overflow-y: auto;
    }
    .ff-card { width: 100%; max-width: 560px; }
    .ff-kicker {
      font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: .28em;
      text-transform: uppercase; color: #b4552d; margin-bottom: 10px;
    }
    .ff-h1 { font-size: 34px; line-height: 1.12; font-weight: 700; margin: 0 0 6px; }
    .ff-sub { font-family: 'Courier New', monospace; font-size: 13px; color: #8f8778; margin: 0 0 24px; }
    .ff-label {
      font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: .18em;
      text-transform: uppercase; color: #8f8778; margin: 22px 0 10px;
    }
    .ff-attempt {
      font-family: 'Courier New', monospace; font-size: 12px; color: #e8e2d4;
      border-bottom: 1px solid #3a3a30; padding-bottom: 12px;
    }
    .ff-attempt b { font-weight: 700; }
    .ff-energy { display: flex; gap: 8px; }
    .ff-energy button {
      all: unset; flex: 1; text-align: center; padding: 14px 0 12px; cursor: pointer;
      border: 1px solid #3a3a30; font-family: 'Courier New', monospace; font-size: 15px; color: #e8e2d4;
      box-sizing: border-box;
    }
    .ff-energy button:hover { border-color: #b4552d; color: #b4552d; }
    .ff-energy button[aria-pressed="true"] { background: #b4552d; border-color: #b4552d; color: #14140f; font-weight: 700; }
    .ff-energy .cap { display: block; font-size: 9.5px; letter-spacing: .12em; color: #8f8778; margin-top: 5px; text-transform: uppercase; }
    .ff-energy button[aria-pressed="true"] .cap { color: #14140f; }
    .ff-input {
      all: unset; display: block; width: 100%; box-sizing: border-box; padding: 12px;
      border: 1px solid #3a3a30; background: #1c1c15; color: #e8e2d4;
      font-family: 'Courier New', monospace; font-size: 14px;
    }
    .ff-input:focus { border-color: #e8e2d4; }
    .ff-input::placeholder { color: #5d5749; }
    .ff-counter { font-family: 'Courier New', monospace; font-size: 10.5px; color: #5d5749; text-align: right; margin-top: 5px; }
    .ff-actions { display: flex; gap: 10px; margin-top: 24px; align-items: center; }
    .ff-btn {
      all: unset; cursor: pointer; padding: 12px 22px; border: 1px solid #e8e2d4;
      font-family: 'Courier New', monospace; font-size: 12px; letter-spacing: .14em;
      text-transform: uppercase; color: #e8e2d4; box-sizing: border-box;
    }
    .ff-btn:hover { background: #e8e2d4; color: #14140f; }
    .ff-btn.primary { background: #e8e2d4; color: #14140f; }
    .ff-btn.primary:hover { background: #b4552d; border-color: #b4552d; color: #14140f; }
    .ff-btn:disabled { opacity: .4; cursor: wait; }
    .ff-btn:disabled:hover { background: #e8e2d4; color: #14140f; }
    .ff-skip {
      font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: .1em;
      text-transform: uppercase; color: #5d5749; cursor: pointer; margin-left: auto;
    }
    .ff-skip:hover { color: #b4552d; }

    /* loading skeletons */
    .ff-skel {
      background: #1c1c15; border: 1px solid #3a3a30; position: relative; overflow: hidden;
      height: 18px; margin: 14px 0;
    }
    .ff-skel::after {
      content: ""; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(232,226,212,.08), transparent);
      animation: ff-sweep 1.2s infinite;
    }
    @keyframes ff-sweep { to { transform: translateX(100%); } }

    .ff-verse { font-size: 25px; line-height: 1.45; margin: 18px 0; max-width: 24em; }
    .ff-meta {
      font-family: 'Courier New', monospace; font-size: 11.5px; color: #8f8778;
      letter-spacing: .06em; line-height: 1.7;
    }
    .ff-tag {
      display: inline-block; border: 1px solid #3a3a30; padding: 3px 9px; margin: 0 8px 8px 0;
      font-family: 'Courier New', monospace; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase;
    }
    .ff-timer {
      font-size: 58px; font-weight: 700; letter-spacing: .04em; line-height: 1;
      font-variant-numeric: tabular-nums; margin: 18px 0 6px;
    }
    .ff-progress { height: 4px; background: #3a3a30; margin: 16px 0 6px; }
    .ff-progress > i { display: block; height: 100%; background: #b4552d; transition: width .3s linear; }
    .ff-footer {
      margin-top: 30px; border-top: 1px solid #3a3a30; padding-top: 14px;
      font-family: 'Courier New', monospace; font-size: 11px; color: #5d5749; line-height: 1.7;
    }
    .ff-offline {
      border: 1px solid #a8781f; color: #a8781f; padding: 10px 12px;
      font-family: 'Courier New', monospace; font-size: 11.5px; margin-top: 14px;
    }
  `;
  root.appendChild(style);

  const page = document.createElement('div');
  root.appendChild(page);

  function mount() {
    if (!document.documentElement) {
      // document_start on a fresh navigation: wait for the document element.
      const iv = setInterval(() => {
        if (document.documentElement) {
          clearInterval(iv);
          if (!host.isConnected) document.documentElement.appendChild(host);
        }
      }, 10);
      return;
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function closeGate() {
    overlayOpen = false;
    clearInterval(taskTimer);
    host.remove();
  }

  function openGate() {
    if (overlayOpen) return;
    overlayOpen = true;
    mount();
    renderIntro();
  }

  /* ------------------------------------------------------- screens -- */

  function renderIntro() {
    page.innerHTML = `
      <div class="ff-gate">
        <div class="ff-card">
          <div class="ff-kicker">FocusForge &middot; the door</div>
          <h1 class="ff-h1">State your business at ${escapeHtml(SITE)}.</h1>
          <p class="ff-sub">The bouncer reads the excuse, guesses the need, and rules. Three honest taps and a sentence.</p>
          <div class="ff-attempt">attempt no. <b id="ff-attempt">?</b> today</div>

          <div class="ff-label">Energy right now</div>
          <div class="ff-energy" id="ff-energy">
            ${[1, 2, 3, 4, 5].map((n) => `
              <button type="button" data-n="${n}" aria-pressed="false">
                ${n}<span class="cap">${['drained', 'low', 'okay', 'good', 'wired'][n - 1]}</span>
              </button>`).join('')}
          </div>

          <div class="ff-label">The excuse</div>
          <input id="ff-excuse" class="ff-input" maxlength="280" autocomplete="off"
                 placeholder="why this, why now, in one honest sentence">
          <div class="ff-counter"><span id="ff-count">0</span>/280</div>

          <div class="ff-actions">
            <button class="ff-btn primary" id="ff-submit" disabled>knock</button>
            <span class="ff-skip" id="ff-leave">leave instead</span>
          </div>

          <div class="ff-footer">
            The bouncer sees only your excuse text and energy level. Page content is never read, never logged.
            Everything else stays on your machine.
          </div>
        </div>
      </div>
    `;

    // Ask the ledger how many attempts came before this one (best effort).
    chrome.runtime.sendMessage({ type: 'FF_ATTEMPT_COUNT' }).then((r) => {
      const elx = page.querySelector('#ff-attempt');
      if (elx && r && r.count) elx.textContent = String(r.count + 1);
    }).catch(() => {});

    let energy = 0;
    const submit = page.querySelector('#ff-submit');
    page.querySelectorAll('#ff-energy button').forEach((b) => {
      b.addEventListener('click', () => {
        page.querySelectorAll('#ff-energy button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        energy = Number(b.dataset.n);
        submit.disabled = false;
      });
    });

    page.querySelector('#ff-excuse').addEventListener('input', (e) => {
      page.querySelector('#ff-count').textContent = String(e.target.value.length);
    });
    page.querySelector('#ff-excuse').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submit.disabled) submit.click();
    });

    page.querySelector('#ff-leave').addEventListener('click', () => {
      history.length > 1 ? history.back() : (window.location.href = 'about:blank');
    });

    submit.addEventListener('click', async () => {
      const excuse = page.querySelector('#ff-excuse').value.trim();
      if (!energy || !excuse) return;
      submit.disabled = true;
      renderJudging({ energy, excuse });
      let out;
      try {
        out = await chrome.runtime.sendMessage({ type: 'FF_JUDGE', site: SITE, energy, excuse });
      } catch (err) {
        out = { error: 'extension messaging failed: ' + err.message };
      }
      renderVerdict(out);
    });
  }

  function renderJudging({ energy, excuse }) {
    const short = excuse.length > 60 ? excuse.slice(0, 60) + '...' : excuse;
    page.innerHTML = `
      <div class="ff-gate">
        <div class="ff-card">
          <div class="ff-kicker">FocusForge &middot; the door</div>
          <h1 class="ff-h1">Consulting the doorman...</h1>
          <p class="ff-sub">Energy ${energy}/5. Excuse on file: "${escapeHtml(short)}"</p>
          <div class="ff-skel" style="width: 82%"></div>
          <div class="ff-skel" style="width: 64%"></div>
          <div class="ff-skel" style="width: 42%"></div>
          <div class="ff-meta">the verdict will land in a moment; nothing here is frozen</div>
          <div class="ff-footer">The bouncer sees only the excuse text and the energy level. Page content is never read, never logged.</div>
        </div>
      </div>
    `;
  }

  function renderVerdict(out) {
    if (!out || out.error) {
      page.innerHTML = `
        <div class="ff-gate"><div class="ff-card">
          <div class="ff-kicker">FocusForge &middot; the door</div>
          <h1 class="ff-h1">The door stayed shut.</h1>
          <p class="ff-sub">${escapeHtml((out && out.error) || 'The doorman did not answer.')}</p>
          <div class="ff-offline">Offline rule: when the doorman cannot be reached, the door defaults to shut. Start the local server, then knock again.</div>
          <div class="ff-actions"><button class="ff-btn" id="ff-try">back</button></div>
        </div></div>
      `;
      page.querySelector('#ff-try').addEventListener('click', renderIntro);
      return;
    }

    const v = out.verdict;
    if (v === 'deny' && out.distress_flag) return renderDistress(out);
    if (v === 'deny') return renderDeny(out);
    if (v === 'task') return renderTask(out);
    if (v === 'allow') return renderAllow(out);
    renderDeny(out);
  }

  function renderDeny(out) {
    const tags = [
      `<span class="ff-tag">need: ${escapeHtml(out.need_category || 'other')}</span>`,
      out.excuse_strength ? `<span class="ff-tag">excuse strength ${out.excuse_strength}/10</span>` : '',
      out.prefilter && out.prefilter !== 'ok' ? `<span class="ff-tag">rule: ${escapeHtml(out.prefilter)}</span>` : '',
      out.offline ? '<span class="ff-tag">offline mode</span>' : '',
    ].join('');

    page.innerHTML = `
      <div class="ff-gate"><div class="ff-card">
        <div class="ff-kicker">Verdict: denied</div>
        <h1 class="ff-h1">Not tonight.</h1>
        <p class="ff-verse">${escapeHtml(out.roast || 'The door stayed shut.')}</p>
        <div>${tags}</div>
        <div class="ff-label">The reset</div>
        <div class="ff-meta">${RESET_LINE}</div>
        <div class="ff-actions">
          <button class="ff-btn primary" id="ff-reset-run">run the reset (60s)</button>
          <button class="ff-btn" id="ff-reset-done">did it, leaving</button>
        </div>
        <div class="ff-footer">Denials are cheap. The reset is the part that actually buys the evening back.</div>
      </div></div>
    `;

    page.querySelector('#ff-reset-run').addEventListener('click', () => {
      renderTask({
        micro_task: { type: 'breathing', seconds: 60 },
        roast: '',
        fromDeny: true,
      });
    });
    page.querySelector('#ff-reset-done').addEventListener('click', closeGate);
  }

  function renderDistress(out) {
    page.innerHTML = `
      <div class="ff-gate"><div class="ff-card">
        <div class="ff-kicker">Verdict: paused</div>
        <h1 class="ff-h1">Not a website problem.</h1>
        <p class="ff-verse">${escapeHtml(out.roast || '')}</p>
        <div class="ff-meta">
          If tonight feels heavier than a tab, tell one trusted person, or call or text a local
          crisis line (988 works in the US). This overlay is a doorman, not a counselor, and it
          will happily stay shut for the rest of the evening.
        </div>
        <div class="ff-actions">
          <button class="ff-btn primary" id="ff-distress-done">understood</button>
        </div>
      </div></div>
    `;
    page.querySelector('#ff-distress-done').addEventListener('click', closeGate);
  }

  function renderTask(out) {
    const t = out.micro_task || { type: 'breathing', seconds: 60 };
    const copy = TASK_COPY[t.type] || TASK_COPY.breathing;
    const seconds = Math.min(120, Math.max(10, t.seconds || 60));
    page.innerHTML = `
      <div class="ff-gate"><div class="ff-card">
        <div class="ff-kicker">Verdict: micro-task first</div>
        ${out.roast ? `<p class="ff-verse" style="font-size:20px">${escapeHtml(out.roast)}</p>` : ''}
        <h1 class="ff-h1">${escapeHtml(copy.label)}</h1>
        <p class="ff-sub">${escapeHtml(copy.line)}</p>
        <div class="ff-timer" id="ff-task-timer">${seconds}</div>
        <div class="ff-progress"><i id="ff-task-bar" style="width:0%"></i></div>
        <div class="ff-actions">
          <button class="ff-btn primary" id="ff-task-done">done</button>
          <button class="ff-btn" id="ff-task-bail">bail out</button>
        </div>
        <div class="ff-footer">The feed will still be there in ${seconds} seconds. The ${escapeHtml(copy.label.toLowerCase())} might actually help.</div>
      </div></div>
    `;
    runCountdown(seconds, (remaining) => {
      const tEl = page.querySelector('#ff-task-timer');
      const bar = page.querySelector('#ff-task-bar');
      if (tEl) tEl.textContent = String(remaining);
      if (bar) bar.style.width = (((seconds - remaining) / seconds) * 100).toFixed(1) + '%';
    }, () => {
      const done = page.querySelector('#ff-task-done');
      if (done) done.textContent = out.fromDeny ? 'reset done, leaving' : 'done, open the page';
    });

    page.querySelector('#ff-task-done').addEventListener('click', () => {
      if (out.fromDeny) {
        closeGate();
        return;
      }
      // Task verdict: grant a short landing window without a second /judge.
      chrome.runtime.sendMessage({ type: 'FF_TASK_DONE', attemptId: out.attemptId || null }).catch(() => {});
      startAllowPill(Date.now() + 90_000);
      closeGate();
    });
    page.querySelector('#ff-task-bail').addEventListener('click', closeGate);
  }

  function renderAllow(out) {
    const minutes = out.minutes_granted || 1;
    const until = (out.serverNow || Date.now()) + minutes * 60000;
    page.innerHTML = `
      <div class="ff-gate"><div class="ff-card">
        <div class="ff-kicker">Verdict: granted</div>
        <h1 class="ff-h1">${minutes} minutes. Go on then.</h1>
        <p class="ff-verse">${escapeHtml(out.roast || '')}</p>
        <div class="ff-actions">
          <button class="ff-btn primary" id="ff-go">take me in</button>
        </div>
        <div class="ff-footer">A pill counts down in the corner. At zero the door re-locks itself, no hard feelings.</div>
      </div></div>
    `;
    page.querySelector('#ff-go').addEventListener('click', () => {
      startAllowPill(until);
      closeGate();
    });
  }

  /* ----------------------------------------------------- allow pill -- */

  function startAllowPill(until) {
    const chip = document.createElement('div');
    chip.id = 'ff-pill-host';
    chip.style.cssText = 'all: initial; position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;';
    const chipRoot = chip.attachShadow({ mode: 'closed' });
    chipRoot.innerHTML = `
      <style>
        .pill {
          font-family: 'Courier New', monospace; font-size: 12px;
          background: #e8e2d4; color: #14140f; border: 1px solid #14140f;
          padding: 7px 12px; letter-spacing: .08em; font-variant-numeric: tabular-nums;
        }
        .pill b { font-weight: 700; }
      </style>
      <div class="pill">FF <b id="t">--:--</b></div>
    `;
    document.documentElement.appendChild(chip);

    const tEl = chipRoot.querySelector('#t');
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, '0');
      if (tEl) tEl.textContent = `${m}:${s}`;
      if (left <= 0) {
        clearInterval(tick);
        chip.remove();
        openGate(); // re-blocks at zero
        chrome.runtime.sendMessage({ type: 'FF_CLEAR_GRANT', site: SITE }).catch(() => {});
      }
    }, 250);
  }

  /* ------------------------------------------------------- utility -- */

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function runCountdown(seconds, onTick, onDone) {
    clearInterval(taskTimer);
    const start = Date.now();
    taskTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.max(0, seconds - elapsed);
      onTick(remaining);
      if (remaining <= 0) {
        clearInterval(taskTimer);
        onDone();
      }
    }, 250);
  }

  /* ----------------------------------------------------------- gate -- */

  async function checkGate() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'FF_CHECK_GATE', site: SITE });
      if (state && state.open) {
        startAllowPill(state.until);
      } else {
        openGate();
      }
    } catch (_) {
      openGate(); // worker unavailable: block by default, fail closed
    }
  }

  checkGate();
})();
