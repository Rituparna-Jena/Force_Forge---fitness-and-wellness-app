# FocusForge v2

An AI bouncer for the open tab. When you knock on YouTube or Instagram, a full-screen
overlay asks your energy level and your excuse, a local server runs the excuse past an
LLM "doorman", and the door answers: **denied with a reset**, **micro-task first**, or
**a time-boxed allow**. Every attempt is logged and surfaced on a ledger-style analytics
dashboard with an Attention & Energy Fingerprint and a 3-day experiment.

Everything is local-first: no accounts, no cloud database, no telemetry. The only
outbound call is from your server to the LLM provider you configure.

---

## Setup in 5 steps

1. **Install dependencies**
   ```bash
   npm install
   ```
   (If `better-sqlite3` fails to build on your machine, the server automatically falls
   back to a JSON file store. You will see a one-line notice; everything else works.)

2. **Configure the key (or skip to mock mode)**
   Either copy the template and paste your Groq key:
   ```bash
   cp .env.example .env
   # then edit .env and set GROQ_API_KEY=gsk_...
   ```
   or start the server and paste the key into the dashboard's first-run setup form
   (it is written to the git-ignored `data/config.json` and hot-reloaded), or run
   `MOCK_LLM=true` for canned verdicts with no key at all.

3. **Start the server**
   ```bash
   npm start
   ```
   Open http://localhost:3000/dashboard to confirm it is alive.

4. **Load the extension**
   Chrome (or any Chromium browser) > `chrome://extensions` > enable **Developer mode** >
   **Load unpacked** > select the `extension/` folder in this project.

5. **Knock**
   Visit https://www.youtube.com. The overlay appears before the page is usable.
   Pick an energy level, type an honest excuse, knock. Repeat on Instagram if you
   like being judged twice.

### Mock mode (zero API key)

```bash
MOCK_LLM=true npm start
```

Every `/judge` call returns a deterministic canned verdict keyed off the excuse text
(distress wording, "long shift", "stressed/exam", "bored", "message from a friend", and
a default avoidance path), so you can demo every overlay screen and the full dashboard
without spending a token. The dashboard setup screen can also toggle mock mode at
runtime. `/insight` likewise falls back to a stats-derived canned narrative.

### Seed data

```bash
npm run seed            # ~14 days of simulated history, tagged source:"simulated"
npm run seed -- --wipe  # wipe everything first
```

Simulated rows are marked in the database and can be excluded with the
**live data only** toggle on the dashboard.

---

## Architecture overview

```
Chrome extension (MV3)                Express server (localhost:3000)
+--------------------------+          +--------------------------------------+
| content.js               |          | POST /judge                          |
|  Shadow DOM overlay      |          |  1. prefilter (deterministic)        |
|  energy + excuse + UI    |          |     repeat excuse / cooldown /       |
|        | chrome.runtime  |  HTTP    |     daily + hourly budgets           |
|        v                 | -------> |  2. LLM call (Groq, OpenAI-compat)   |
| background.js            |          |  3. strict JSON validation, 1 retry  |
|  service worker: ALL     | <------- |  4. server clamp on minutes granted  |
|  fetches, grant state in |          |  5. distress override                |
|  chrome.storage          |          |  6. log -> sqlite (or JSON fallback) |
+--------------------------+          | GET  /stats   plain-JS aggregates    |
                                      | POST /insight cached LLM narration   |
                                      | GET  /dashboard static page          |
                                      | GET  /health   POST /setup           |
                                      | DELETE /data  wipe everything        |
                                      +--------------------------------------+
```

Key decisions:

- **The content script never touches the network.** The MV3 service worker makes all
  calls and holds allow-grant state in `chrome.storage`, so a killed worker cannot
  lose track of an open door. If the worker is unreachable, the overlay fails closed.
- **The model never has final authority.** A deterministic pre-filter can auto-deny
  (repeat excuse, cooldown running, daily allowance spent, hourly attempt budget)
  without spending an API call, and the server clamps `minutes_granted` to the
  remaining daily allowance no matter what the model says.
- **Prompt-injection hardening.** The excuse is wrapped in `<untrusted_user_input>`
  delimiters declared as data, the system rules are restated after the user text,
  temperature is low, few-shot examples (including one injection attempt) are in the
  system prompt, and output is schema-validated with one retry before a canned fallback.
- **Distress override.** If the model flags `distress_flag`, the server replaces the
  verdict with a supportive, persona-free message and a nudge toward a trusted person
  or a crisis line. No roast, no game.
- **Analytics without the model.** `/stats` is plain JS over the log: hour-of-day,
  weekday, site, need-category, energy-vs-attempts, 14-day denial/allow rates, and an
  honestly-labeled minutes-reclaimed estimate with its assumptions printed in the API
  response and the dashboard. `/insight` sends only the computed stats (never raw logs
  or excuse text) and caches the result until the log changes.
- **The model is swappable.** `LLM_BASE_URL` + `FOCUSFORGE_MODEL` point at any
  OpenAI-compatible endpoint (Groq default, works with OpenAI, Together, LM Studio,
  Ollama's OpenAI shim).

### Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `GROQ_API_KEY` | empty | API key, read only server-side |
| `FOCUSFORGE_MODEL` | `llama-3.1-8b-instant` | model id, read at runtime |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | any OpenAI-compatible base URL |
| `MOCK_LLM` | `false` | canned verdicts, no key needed |
| `PORT` | `3000` | server port |
| `DAILY_ALLOWANCE_MINUTES` | `30` | hard daily cap on granted minutes |
| `ATTEMPT_BUDGET_PER_HOUR` | `8` | auto-deny after this many attempts/hour |
| `COOLDOWN_MINUTES` | `10` | settle time after an allow expires |

The dashboard setup form writes `data/config.json` (git-ignored, mode 600) which
overrides `.env` values and hot-reloads without a restart.

---

## Testing

```bash
npm run smoke        # boots the server on a scratch port, exercises every endpoint
```

The smoke test uses its own temporary data directory, checks pre-filter firing,
schema validation, distress override, stats shape, insight caching, CORS behavior
(extension origins allowed, foreign origins 403), and delete-all. Add `--live` to
run the same suite against your real key (`node scripts/smoke.js --live`).

Manual extension check: load `extension/` unpacked, open YouTube, submit an excuse,
then try the same excuse twice in a row to see the pre-filter's instant deny.

---

## Third-party licenses

- [express](https://github.com/expressjs/express) - MIT
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - MIT
- [dotenv](https://github.com/motdotla/dotenv) - MIT
- [cors](https://github.com/expressjs/cors) - MIT
- [Chart.js](https://github.com/chartjs/Chart.js) - MIT (loaded via cdnjs)
- Fraunces and IBM Plex Mono via Google Fonts - SIL Open Font License 1.1
- Groq API is a third-party service; your key and excuse text go to the provider you
  configure when mock mode is off.

This project is MIT licensed; see `LICENSE`.

---

## Pre-event vs built-during-event disclosure

Honest accounting for anyone evaluating this prototype:

- **Prepared before the event:** the project concept and scope, familiarity with
  Chrome MV3 extension structure, Express, better-sqlite3, Chart.js, and the Groq
  OpenAI-compatible API. Design references and the general visual direction
  (ledger/print aesthetic) were informed by prior exposure to editorial web design.
- **Built during the event:** all code in this repository, written for this project,
  including the bouncer prompt and its few-shot examples, the pre-filter and clamping
  logic, the storage layer and its JSON fallback, the seed generator, the smoke test,
  the overlay flow, and the dashboard.
- **AI assistance:** code was authored with the help of an AI coding agent
  (Codebuff), reviewed and tested end to end with `npm run smoke` and a live key
  where available. All judgments about product behavior, copy tone, and the safety
  override are documented above so a reviewer can verify them directly.
- **Not built:** user accounts, sync, mobile support, and anything resembling
  medical advice. This is a prototype, not a wellbeing intervention.

---

## Privacy, in one paragraph

The local database stores: your excuse text, the site label, timestamps, the energy
level you reported, the verdict, and the inferred need category. It never stores page
content, page titles, or full URLs. When mock mode is off, the excuse text and energy
level are sent to the LLM provider you configured, and nothing else goes anywhere.
The API key lives in `.env` or `data/config.json`, both git-ignored, and is never
returned to any client. `DELETE /data` (or the dashboard button) erases everything
immediately, including the cached insight.
