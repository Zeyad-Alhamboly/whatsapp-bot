/**
 * configService.js
 *
 * Reads bot configuration from the Supabase `app_settings` table.
 * Provides an in-memory cache with TTL to avoid hammering the DB on every message.
 * Falls back to process.env (the .env file) if a DB setting is empty or unavailable.
 *
 * Usage:
 *   import { config } from './configService.js';
 *   await config.refresh();                // load settings once at startup
 *   const key = config.get('gemini_api_key');
 *   const groups = config.getList('target_group_ids');
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logger } from './logger.js';

dotenv.config();

const CACHE_TTL_MS = 60_000; // 1 minute

// ── Supabase client (service role to read settings) ───────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ── In-memory cache ───────────────────────────────────────────
let _cache = {}; // { key: value } flat map
let _lastFetch = 0;
let _initialized = false;

// ── Fetch all settings from Supabase ─────────────────────────
async function fetchFromDB() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('key, value');

    if (error) {
      logger.warn(`[configService] DB fetch failed: ${error.message}`);
      return false;
    }

    const newCache = {};
    for (const row of data) {
      if (row.value && row.value.trim() !== '') {
        newCache[row.key] = row.value;
      }
    }

    _cache = newCache;
    _lastFetch = Date.now();
    _initialized = true;
    logger.info(`[configService] Loaded ${data.length} settings from DB (${Object.keys(newCache).length} non-empty)`);
    return true;
  } catch (err) {
    logger.warn(`[configService] Unexpected error: ${err.message}`);
    return false;
  }
}

// ── Auto-refresh if TTL expired ───────────────────────────────
async function ensureFresh() {
  if (!_initialized || Date.now() - _lastFetch > CACHE_TTL_MS) {
    await fetchFromDB();
  }
}

// ── Public API ────────────────────────────────────────────────
export const config = {
  /**
   * Load/refresh settings from DB. Call once at startup.
   */
  async refresh() {
    return fetchFromDB();
  },

  /**
   * Get a single setting value.
   * Priority: DB cache → process.env fallback → defaultValue
   */
  async get(key, envFallback = null, defaultValue = '') {
    await ensureFresh();
    const dbVal = _cache[key];
    if (dbVal) return dbVal;
    if (envFallback) {
      const envVal = process.env[envFallback];
      if (envVal) return envVal;
    }
    return defaultValue;
  },

  /**
   * Synchronous get (uses last cached value, no DB call).
   * Only use after refresh() has been awaited.
   */
  getSync(key, envFallback = null, defaultValue = '') {
    const dbVal = _cache[key];
    if (dbVal) return dbVal;
    if (envFallback) {
      const envVal = process.env[envFallback];
      if (envVal) return envVal;
    }
    return defaultValue;
  },

  /**
   * Get a comma-separated setting as an array of trimmed non-empty strings.
   * e.g. "a,b,c" → ['a', 'b', 'c']
   */
  async getList(key, envFallback = null) {
    const raw = await this.get(key, envFallback, '');
    return raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  },

  /**
   * Get a JSON setting parsed into a JS value.
   * Falls back to `fallback` on parse error.
   */
  async getJson(key, envFallback = null, fallback = null) {
    const raw = await this.get(key, envFallback, '');
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      logger.warn(`[configService] Failed to parse JSON for key "${key}": ${raw}`);
      return fallback;
    }
  },

  /**
   * Format a message template by replacing {placeholders} with values.
   * e.g. config.format('{name} sent {amount}', { name: 'Ali', amount: 500 })
   */
  format(template, vars = {}) {
    return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
  },
};
