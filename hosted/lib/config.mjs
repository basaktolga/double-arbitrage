// Settings: environment defaults, overridable at runtime from the Settings tab.
// Runtime overrides live in memory only (free Render instances lose disk on sleep),
// so anything you want to keep belongs in the environment variables.

import { DEFAULT_MARKET_TYPES } from "./arb.mjs";

const list = (v, fallback = []) =>
  (v ? String(v).split(",") : fallback).map((s) => String(s).trim()).filter(Boolean);
const num = (v, fallback) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function envSettings(env = process.env) {
  return {
    bookmakers: list(env.BOOKMAKERS, ["stake", "pinnacle", "bet365", "1xbet"]).map((s) => s.toLowerCase()),
    sports: list(env.SPORTS, ["10", "11", "12", "17"]).map(Number).filter(Boolean),
    stakeSlug: String(env.STAKE_SLUG ?? "stake").toLowerCase(),
    minProfit: num(env.MIN_PROFIT, 1),
    lookaheadHours: num(env.LOOKAHEAD_HOURS, 48),
    minLeadMinutes: num(env.MIN_LEAD_MINUTES, 10),
    maxFixturesPerSport: num(env.MAX_FIXTURES_PER_SPORT, 150),
    marketTypes: list(env.MARKET_TYPES, DEFAULT_MARKET_TYPES),
    skipIntegerLines: env.SKIP_INTEGER_LINES !== "0",
    boostedMaxAgeMin: num(env.BOOSTED_MAX_AGE_MIN, 45),
    scanIntervalMin: num(env.SCAN_INTERVAL_MIN, 10),
    windowHours: num(env.WINDOW_HOURS, 2),
    alertBoostedOnly: env.ALERT_BOOSTED_ONLY === "1",
    // Server-side Stake collector (headless browser). Slow on purpose: one page at a time.
    stakeCollector: env.STAKE_COLLECTOR !== "0",
    stakeCategories: list(env.STAKE_CATEGORIES, ["home", "soccer", "basketball", "tennis", "ice-hockey", "esports"]).map((s) => s.toLowerCase()),
    collectEveryMin: num(env.STAKE_COLLECT_EVERY_MIN, 30),
  };
}

const EDITABLE = {
  bookmakers: (v) => list(v).map((s) => s.toLowerCase()).slice(0, 40),
  sports: (v) => list(v).map(Number).filter((n) => n > 0 && n < 100).slice(0, 20),
  minProfit: (v) => Math.max(0, Math.min(50, Number(v))),
  lookaheadHours: (v) => Math.max(1, Math.min(240, Number(v))),
  minLeadMinutes: (v) => Math.max(0, Math.min(600, Number(v))),
  maxFixturesPerSport: (v) => Math.max(5, Math.min(500, Math.round(Number(v)))),
  marketTypes: (v) => list(v).slice(0, 40),
  skipIntegerLines: (v) => v === true || v === "true" || v === "1",
  scanIntervalMin: (v) => Math.max(3, Math.min(120, Number(v))),
  windowHours: (v) => Math.max(0.25, Math.min(6, Number(v))),
  alertBoostedOnly: (v) => v === true || v === "true" || v === "1",
  stakeCollector: (v) => v === true || v === "true" || v === "1",
  stakeCategories: (v) => list(v).map((s) => s.toLowerCase().replace(/[^a-z0-9-]/g, "")).filter(Boolean).slice(0, 20),
  collectEveryMin: (v) => Math.max(10, Math.min(240, Number(v))),
};

/** Apply a partial update from the UI; returns the new settings and any rejected keys. */
export function applySettings(current, patch) {
  const next = { ...current };
  const rejected = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!EDITABLE[k]) {
      rejected.push(k);
      continue;
    }
    const val = EDITABLE[k](Array.isArray(v) ? v.join(",") : v);
    if (typeof val === "number" && !Number.isFinite(val)) {
      rejected.push(k);
      continue;
    }
    if (Array.isArray(val) && !val.length) {
      rejected.push(k);
      continue;
    }
    next[k] = val;
  }
  return { settings: next, rejected };
}
