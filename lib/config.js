/**
 * FocusForge v2 - runtime configuration.
 *
 * Layered sources, first match wins:
 *   1. data/config.json (written by the dashboard setup form, hot-reloaded)
 *   2. process env (populated from .env by dotenv)
 *   3. built-in defaults
 * The setup form therefore outranks .env without a restart; delete
 * data/config.json to fall back to the .env values.
 *
 * The API key NEVER leaves this process: it is read here, used for the
 * outbound LLM call, and is never included in any HTTP response.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

try {
  // dotenv ships a tiny warning if .env is missing; keep the log clean.
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
} catch (_) {
  /* dotenv not installed yet: env vars still work */
}

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch (_) {
    return {};
  }
}

const fileConfig = readConfigFile();

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  configFile: CONFIG_FILE,

  port: int(process.env.PORT, 3000) || 3000,

  // LLM. The dashboard setup form wins over .env so runtime changes stick.
  mockLlm: bool(fileConfig.mockLlm) ?? bool(process.env.MOCK_LLM) ?? false,
  apiKey: (fileConfig.apiKey || process.env.GROQ_API_KEY || '').trim(),
  model: (fileConfig.model || process.env.FOCUSFORGE_MODEL || 'llama-3.1-8b-instant').trim(),
  baseUrl: (fileConfig.baseUrl || process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, ''),

  // Guardrails. The server, not the model, has final authority.
  dailyAllowanceMinutes: int(process.env.DAILY_ALLOWANCE_MINUTES, 30),
  attemptBudgetPerHour: int(process.env.ATTEMPT_BUDGET_PER_HOUR, 8),
  cooldownMinutes: int(process.env.COOLDOWN_MINUTES, 10),

  // Insight cache lifetime (ms)
  insightCacheMs: int(process.env.INSIGHT_CACHE_MS, 10 * 60 * 1000),
};

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

/** Persist settings from the dashboard setup form. The key is stored on
 *  disk in a local file that git ignores; it is never returned to clients. */
function writeConfigFile(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = readConfigFile();
  const next = { ...current };

  if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim();
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  if (typeof patch.mockLlm === 'boolean') next.mockLlm = patch.mockLlm;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });

  // Hot reload into the running process.
  if (typeof patch.apiKey === 'string') config.apiKey = patch.apiKey.trim();
  if (typeof patch.model === 'string' && patch.model.trim()) config.model = patch.model.trim();
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) config.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  if (typeof patch.mockLlm === 'boolean') config.mockLlm = patch.mockLlm;
  return next;
}

/** Redacted status for the dashboard: never expose the key itself. */
function keyStatus() {
  return {
    hasKey: config.mockLlm ? false : config.apiKey.length > 0,
    mockMode: config.mockLlm,
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

module.exports = { config, writeConfigFile, keyStatus, CONFIG_FILE };
