#!/usr/bin/env node
/**
 * Hosted arb finder — Stake boosted odds + OddsPapi bookmakers + local scraper results.
 *
 *   node server.mjs            → http://localhost:10000   (DEMO=1 for fake data)
 *
 * Zero dependencies (Node 20+). Built for Render's free plan: tapping Scan opens a
 * keep-alive window (default 2 h) during which the server pings itself and rescans
 * on a timer. When the window closes it stops pinging and Render puts it to sleep.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createClient } from "./lib/oddspapi.mjs";
import { runScan, normaliseLocal } from "./lib/scanner.mjs";
import { cleanUpload } from "./lib/boosted.mjs";
import { envSettings, applySettings } from "./lib/config.mjs";
import { createAlerter } from "./lib/alerts.mjs";
import { healthChecks, aiDiagnosis } from "./lib/doctor.mjs";
import { demoFetch, demoBoosted } from "./lib/demo.mjs";
import { runCollector } from "./lib/stake-collector.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const MAX_BODY = 3 * 1024 * 1024;
const PING_EVERY_MS = 10 * 60_000;
const UPLOAD_RESCAN_DEBOUNCE_MS = 2 * 60_000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function createApp({ env = process.env, fetchImpl = globalThis.fetch, tickMs = 30_000 } = {}) {
  const demo = env.DEMO === "1";
  const password = env.APP_PASSWORD || (demo ? "demo" : "");
  const uploadKey = env.UPLOAD_KEY || password;
  const selfUrl = (env.RENDER_EXTERNAL_URL || env.SELF_URL || "").replace(/\/$/, "");
  const oddsFetch = demo ? demoFetch() : fetchImpl;

  const logs = [];
  const log = (text, level = "info") => {
    logs.push({ at: Date.now(), level, text });
    if (logs.length > 300) logs.shift();
    if (env.NODE_ENV !== "test") console.log(`[${level}] ${text}`);
  };

  const client = createClient({ apiKey: demo ? "demo" : env.ODDSPAPI_KEY, fetchImpl: oddsFetch, log: (t) => log(t, "warn") });
  const alerter = createAlerter({ topic: env.NTFY_TOPIC, server: env.NTFY_SERVER, fetchImpl, log: (t) => log(t, "warn") });

  const state = {
    settings: envSettings(env),
    boosted: demo ? demoBoosted() : null, // { uploadedAt, items }
    local: null, // { uploadedAt, scrapedAt, arbs }
    lastScan: null,
    running: false,
    progress: "",
    window: { until: 0, openedAt: 0 },
    lastPingAt: 0,
    pingFailures: 0,
    lastUploadScanAt: 0,
    knownBooks: null, // { at, slugs[] }
    doctor: null, // { at, text, ok }
    alertsSent: 0,
    collector: {
      enabled: env.STAKE_COLLECTOR ? env.STAKE_COLLECTOR !== "0" : !demo,
      url: (env.STAKE_URL || "https://stake.com").replace(/\/+$/, ""),
      maxMb: Number(env.STAKE_COLLECTOR_MAX_MB) || 400,
      timeoutMs: (Number(env.STAKE_COLLECTOR_TIMEOUT_MIN) || 8) * 60_000,
      running: false,
      last: null, // { at, status, error, count, pages, peakMb, durationMs }
      nextDueAt: 0,
      failures: 0,
    },
  };

  // ------------------------------------------------------------ scanning

  async function refreshBooks() {
    if (state.knownBooks && Date.now() - state.knownBooks.at < 12 * 3600_000) return;
    try {
      const list = await client.bookmakers();
      state.knownBooks = { at: Date.now(), slugs: list.map((b) => String(b.slug).toLowerCase()) };
    } catch (e) {
      log(`bookmaker list unavailable: ${e.message}`, "warn");
    }
  }

  function unknownBooks() {
    if (!state.knownBooks?.slugs?.length) return [];
    return state.settings.bookmakers.filter((b) => !state.knownBooks.slugs.includes(b));
  }

  // ------------------------------------------------------------ stake collector

  async function collect(reason) {
    const c = state.collector;
    if (c.running) return null;
    c.running = true;
    const cats = state.settings.stakeCategories;
    state.progress = `Collecting Stake boosts (0/${cats.length})…`;
    log(`stake collector started (${reason}): ${cats.join(", ")}`);
    let r;
    try {
      r = await runCollector({
        url: c.url,
        categories: cats,
        maxMb: c.maxMb,
        timeoutMs: c.timeoutMs,
        env: env.STAKE_COLLECTOR_EXTRA_ENV ? JSON.parse(env.STAKE_COLLECTOR_EXTRA_ENV) : {},
        onProgress: (p) => {
          state.progress = `Collecting Stake boosts (${p.page}/${p.pages}: ${p.category})… slow on purpose`;
        },
      });
    } catch (e) {
      r = { status: "error", items: [], pages: [], error: e.message, peakMb: 0, durationMs: 0 };
    } finally {
      c.running = false;
    }
    const now = Date.now();
    const every = state.settings.collectEveryMin * 60_000;
    // A run that finished with usable pages replaces the boosted list, even if it is empty
    // (no boosts right now). Failed runs keep the previous list, which then ages out.
    const usable = r.status === "ok" || (["timeout", "memory_limit"].includes(r.status) && r.items.length > 0);
    if (usable) state.boosted = { uploadedAt: now, items: r.items, source: "server" };
    if (r.status === "ok") c.failures = 0;
    else c.failures++;
    const backoff =
      r.status === "ok" ? every
      : ["blocked", "geo_blocked"].includes(r.status) ? 3 * 3600_000
      : r.status === "no_browser" ? 24 * 3600_000
      : Math.min(every * 2 ** Math.min(c.failures, 3), 2 * 3600_000);
    c.nextDueAt = now + backoff;
    c.last = {
      at: now,
      status: r.status,
      error: r.error ?? null,
      count: r.items.length,
      pages: (r.pages ?? []).map((p) => ({ category: p.category, items: p.items, outcomes: p.outcomes, error: p.error, ms: p.ms })),
      peakMb: r.peakMb,
      durationMs: r.durationMs,
      usedForScan: usable,
    };
    log(`stake collector ${r.status}: ${r.items.length} boosts, ${Math.round(r.durationMs / 1000)}s, peak ${r.peakMb} MB${r.error ? ` — ${r.error}` : ""}`, r.status === "ok" ? "info" : "warn");
    return r;
  }

  function collectorDue() {
    const c = state.collector;
    return c.enabled && state.settings.stakeCollector && !c.running && Date.now() >= c.nextDueAt;
  }

  async function scan(reason = "manual") {
    if (state.running) return false;
    state.running = true;
    state.progress = "Starting…";
    log(`scan started (${reason})`);
    try {
      if (collectorDue()) await collect(reason);
      await refreshBooks();
      const boostedDoc = boostedFresh() ? state.boosted : state.boosted ? { ...state.boosted, stale: true } : null;
      const result = await runScan({
        client,
        settings: state.settings,
        boostedDoc,
        progress: (p) => {
          state.progress = p;
        },
      });
      result.reason = reason;
      state.lastScan = result;
      log(`scan done: ${result.arbs.length} arbs, ${result.boostedChecks.length} boosted checks, ${result.errors.length} errors`);
      for (const e of result.errors.slice(0, 5)) log(e.message, "error");
      const alertable = [...result.arbs.filter((a) => !a.boosted || boostedFresh()), ...localArbs()];
      const n = await alerter.notify(alertable, { minProfit: state.settings.minProfit, boostedOnly: state.settings.alertBoostedOnly });
      if (n) log(`sent ${n} alert(s)`);
      state.alertsSent += n;
    } catch (e) {
      log(`scan crashed: ${e.stack || e.message}`, "error");
      state.lastScan = { ...(state.lastScan ?? {}), crashedAt: Date.now(), crash: e.message };
    } finally {
      state.running = false;
      state.progress = "";
    }
    return true;
  }

  function boostedFresh() {
    return state.boosted && Date.now() - state.boosted.uploadedAt <= state.settings.boostedMaxAgeMin * 60_000;
  }

  function localArbs() {
    if (!state.local) return [];
    return normaliseLocal({ arbs: state.local.arbs, scrapedAt: state.local.scrapedAt ?? state.local.uploadedAt });
  }

  // ------------------------------------------------------------ keep-alive

  function openWindow(hours = state.settings.windowHours) {
    const now = Date.now();
    state.window = { until: Math.max(state.window.until, now + hours * 3600_000), openedAt: state.window.openedAt && state.window.until > now ? state.window.openedAt : now };
    if (state.lastPingAt === 0) state.lastPingAt = now; // first ping one interval from now
  }

  async function tick() {
    const now = Date.now();
    if (state.window.until <= now) return;
    if (selfUrl && now - state.lastPingAt >= PING_EVERY_MS) {
      state.lastPingAt = now;
      try {
        const r = await fetchImpl(`${selfUrl}/healthz?ping=1`, { headers: { "user-agent": "arb-finder-keepalive" } });
        state.pingFailures = r.ok ? 0 : state.pingFailures + 1;
      } catch (e) {
        state.pingFailures++;
        log(`self-ping failed: ${e.message}`, "warn");
      }
    }
    const last = state.lastScan?.startedAt ?? 0;
    if (!state.running && now - last >= state.settings.scanIntervalMin * 60_000) scan("timer");
  }
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : null;
  timer?.unref?.();

  // ------------------------------------------------------------ http helpers

  const safeEq = (a, b) => {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  const bearer = (req, url) => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) return h.slice(7);
    return req.headers["x-upload-key"] ?? url.searchParams.get("key") ?? "";
  };

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
    res.writeHead(status, {
      "content-type": isJson ? "application/json" : "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function snapshot() {
    return {
      now: Date.now(),
      demo,
      hasOddsKey: Boolean(env.ODDSPAPI_KEY),
      settings: state.settings,
      lastScan: state.lastScan?.stats ? state.lastScan : null,
      apiCalls: client.calls,
      unknownBooks: unknownBooks(),
      boosted: state.boosted ? { uploadedAt: state.boosted.uploadedAt, count: state.boosted.items.length, source: state.boosted.source ?? "phone" } : null,
      local: state.local ? { uploadedAt: state.local.uploadedAt, scrapedAt: state.local.scrapedAt, count: localArbs().length } : null,
      selfUrl,
      window: state.window,
      pingFailures: state.pingFailures,
      alertsEnabled: alerter.enabled,
      collector: collectorInfo(),
    };
  }

  function collectorInfo() {
    const c = state.collector;
    return { enabled: c.enabled && state.settings.stakeCollector, available: c.enabled, url: c.url, running: c.running, last: c.last, nextDueAt: c.nextDueAt, maxMb: c.maxMb };
  }

  function publicState() {
    const snap = snapshot();
    const scanRes = state.lastScan;
    const arbs = [
      ...(scanRes?.arbs ?? []).map((a) => ({ ...a, boostedStale: a.boosted && !boostedFresh() })),
      ...localArbs(),
    ].sort((a, b) => b.profitPct - a.profitPct);
    return {
      now: snap.now,
      demo,
      running: state.running,
      progress: state.progress,
      window: state.window,
      selfPing: Boolean(selfUrl),
      settings: state.settings,
      alertsEnabled: alerter.enabled,
      aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
      scan: scanRes
        ? {
            startedAt: scanRes.startedAt,
            finishedAt: scanRes.finishedAt,
            reason: scanRes.reason,
            stats: scanRes.stats,
            errors: scanRes.errors,
            usedFallback: scanRes.usedFallback,
            crash: scanRes.crash ?? null,
          }
        : null,
      arbs: arbs.slice(0, 300),
      boostedChecks: scanRes?.boostedChecks ?? [],
      unmatchedBoosted: scanRes?.unmatchedBoosted ?? [],
      boosted: state.boosted
        ? { uploadedAt: state.boosted.uploadedAt, source: state.boosted.source ?? "phone", count: state.boosted.items.length, fresh: Boolean(boostedFresh()), items: state.boosted.items.slice(0, 300) }
        : null,
      collector: collectorInfo(),
      local: snap.local,
      health: healthChecks(snap),
      doctor: state.doctor,
      logs: logs.slice(-80),
    };
  }

  // ------------------------------------------------------------ routes

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, { ok: true, awakeUntil: state.window.until });

    if (p.startsWith("/api/")) {
      if (!password) return send(res, 503, { error: "APP_PASSWORD is not set on the server" });
      const token = bearer(req, url);

      // Uploads (userscript / local scrapers) use the upload key.
      if (req.method === "POST" && (p === "/api/stake/upload" || p === "/api/local/upload")) {
        if (!(safeEq(token, uploadKey) || safeEq(token, password))) return send(res, 401, { error: "unauthorized" });
        const body = await readBody(req);
        if (p === "/api/stake/upload") {
          const items = cleanUpload(body);
          state.boosted = { uploadedAt: Date.now(), items, source: "phone" };
          log(`stake upload: ${items.length} boosted items`);
          if (!state.running && Date.now() - state.lastUploadScanAt > UPLOAD_RESCAN_DEBOUNCE_MS) {
            state.lastUploadScanAt = Date.now();
            scan("stake upload");
          }
          return send(res, 200, { ok: true, count: items.length });
        }
        const arbs = Array.isArray(body.arbs) ? body.arbs.slice(0, 1000) : [];
        state.local = { uploadedAt: Date.now(), scrapedAt: Number(body.scrapedAt) || null, arbs };
        log(`local upload: ${arbs.length} arbs`);
        return send(res, 200, { ok: true, count: arbs.length });
      }

      if (!safeEq(token, password)) return send(res, 401, { error: "unauthorized" });

      if (p === "/api/state" && req.method === "GET") return send(res, 200, publicState());

      if (p === "/api/scan" && req.method === "POST") {
        openWindow();
        const started = await Promise.race([scan("manual").then(() => true), new Promise((r) => setTimeout(() => r(true), 50))]);
        return send(res, 202, { ok: true, started, window: state.window });
      }

      if (p === "/api/collect" && req.method === "POST") {
        if (!state.collector.enabled) return send(res, 409, { error: "server collector is disabled (STAKE_COLLECTOR=0)" });
        openWindow();
        state.collector.nextDueAt = 0;
        if (!state.settings.stakeCollector) state.settings = { ...state.settings, stakeCollector: true };
        scan("collect");
        return send(res, 202, { ok: true });
      }

      if (p === "/api/window" && req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "stop") state.window = { until: 0, openedAt: 0 };
        else openWindow(Number(body.hours) > 0 ? Math.min(6, Number(body.hours)) : state.settings.windowHours);
        return send(res, 200, { ok: true, window: state.window });
      }

      if (p === "/api/settings") {
        if (req.method === "GET") return send(res, 200, state.settings);
        if (req.method === "POST") {
          const { settings, rejected } = applySettings(state.settings, await readBody(req));
          state.settings = settings;
          log(`settings updated${rejected.length ? ` (ignored: ${rejected.join(", ")})` : ""}`);
          return send(res, 200, { settings, rejected });
        }
      }

      if (p === "/api/doctor" && req.method === "POST") {
        const snap = snapshot();
        const checks = healthChecks(snap);
        const brief = {
          checks,
          settings: snap.settings,
          lastScan: snap.lastScan ? { stats: snap.lastScan.stats, errors: snap.lastScan.errors, usedFallback: snap.lastScan.usedFallback, unmatchedBoosted: snap.lastScan.unmatchedBoosted.slice(0, 25) } : null,
          recentApiCalls: snap.apiCalls.slice(-30),
          unknownBooks: snap.unknownBooks,
          boosted: snap.boosted,
          stakeCollector: snap.collector,
          local: snap.local,
          window: snap.window,
          recentLogs: logs.slice(-40),
        };
        try {
          const r = await aiDiagnosis(brief, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", fetchImpl });
          state.doctor = { at: Date.now(), ...r };
        } catch (e) {
          state.doctor = { at: Date.now(), ok: false, text: `AI doctor error: ${e.message}` };
        }
        return send(res, 200, { checks, doctor: state.doctor });
      }

      return send(res, 404, { error: "not found" });
    }

    // Static files
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "not found");
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : "server error" });
      if (!e.status) log(`request failed: ${e.stack || e.message}`, "error");
    });
  });

  return { server, state, scan, collect, tick, openWindow, close: () => { if (timer) clearInterval(timer); server.close(); } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 10000);
  app.server.listen(port, "0.0.0.0", () => {
    console.log(`arb finder listening on :${port}${process.env.DEMO === "1" ? " (DEMO data, password: demo)" : ""}`);
    if (!process.env.APP_PASSWORD && process.env.DEMO !== "1") console.log("WARNING: APP_PASSWORD is not set — the API is disabled until you set it.");
  });
}
