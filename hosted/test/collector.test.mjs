// Collector tests use a real headless Chromium against a local fake Stake site.
// Skipped automatically when Playwright isn't installed.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runCollector, treeRssMb } from "../lib/stake-collector.mjs";
import { startFakeStake } from "./fake-stake.mjs";
import { createApp } from "../server.mjs";
import { demoFetch } from "../lib/demo.mjs";
import { clearRegistryCache } from "../lib/scanner.mjs";

const require = createRequire(import.meta.url);
let hasBrowser = false;
for (const m of ["playwright-core", "playwright"]) {
  try {
    require.resolve(m);
    hasBrowser = true;
  } catch {
    /* not installed */
  }
}
const opts = { skip: hasBrowser ? false : "playwright not installed", timeout: 180_000 };
const FAST = { STAKE_PAUSE_MS: "200", STAKE_ODDS_WAIT_MS: "4000", STAKE_PAGE_TIMEOUT_MS: "8000" };

test("treeRssMb measures this process", () => {
  const mb = treeRssMb(process.pid);
  assert.ok(mb === null || mb > 10);
});

test("collects boosts from lazy-loaded pages, comma decimals, match names", opts, async () => {
  const site = await startFakeStake();
  try {
    const progress = [];
    const r = await runCollector({ url: site.url, categories: ["basketball", "soccer"], env: FAST, onProgress: (p) => progress.push(p) });
    assert.equal(r.status, "ok", r.error);
    const key = (i) => `${i.label}|${i.newOdds}`;
    const got = new Set(r.items.map(key));
    assert.ok(got.has("Golden State Warriors|3.81"));
    assert.ok(got.has("Denver Nuggets|1.7"));
    assert.ok(got.has("Galatasaray|2.6"));
    assert.ok(got.has("Trabzonspor|4.6"), "boost far down the page found after scrolling");
    assert.equal(r.items.length, 4, "non-boosted prices ignored");
    const w = r.items.find((i) => i.label === "Golden State Warriors");
    assert.equal(w.match, "Denver Nuggets vs Golden State Warriors");
    assert.equal(w.oldOdds, 3.05);
    assert.equal(w.category, "basketball");
    assert.equal(r.items.find((i) => i.label === "Galatasaray").match, "Galatasaray vs Draw vs Fenerbahce");
    assert.deepEqual(progress.map((p) => p.category), ["basketball", "soccer"]);
    assert.ok(r.peakMb > 0 || treeRssMb(process.pid) === null);
    assert.ok(site.hits.every((h) => /HeadlessChrome/.test(h.ua)), "identifies honestly as headless");
  } finally {
    site.close();
  }
});

test("bot-check page → status blocked, stops immediately", opts, async () => {
  const site = await startFakeStake({ mode: "challenge" });
  try {
    const r = await runCollector({ url: site.url, categories: ["home", "soccer", "tennis"], env: FAST });
    assert.equal(r.status, "blocked");
    assert.equal(site.hits.filter((h) => h.path.startsWith("/sports")).length, 1, "no retries against a challenge");
  } finally {
    site.close();
  }
});

test("region-block page → status geo_blocked", opts, async () => {
  const site = await startFakeStake({ mode: "geo" });
  try {
    const r = await runCollector({ url: site.url, categories: ["home"], env: FAST });
    assert.equal(r.status, "geo_blocked");
  } finally {
    site.close();
  }
});

test("pages without odds → no_odds_elements with a sample of what loaded", opts, async () => {
  const site = await startFakeStake({ mode: "empty" });
  try {
    const r = await runCollector({ url: site.url, categories: ["home"], env: FAST });
    assert.equal(r.status, "no_odds_elements");
    assert.match(r.error, /Maintenance/);
  } finally {
    site.close();
  }
});

test("memory watchdog kills the browser tree, caller gets a result", opts, async () => {
  const site = await startFakeStake({ mode: "heavy" });
  try {
    const r = await runCollector({ url: site.url, categories: ["home"], maxMb: 300, timeoutMs: 90_000, env: { ...FAST, STAKE_ODDS_WAIT_MS: "60000" } });
    assert.equal(r.status, "memory_limit", r.error);
    assert.ok(r.peakMb > 300);
    await new Promise((res) => setTimeout(res, 500));
    const { execSync } = await import("node:child_process");
    const left = execSync("ps -eo args | grep -c '[c]hrome.*--renderer-process-limit=1' || true").toString().trim();
    assert.equal(left, "0", "no Chromium left behind");
  } finally {
    site.close();
  }
});

test("hung site → timeout, caller gets a result", opts, async () => {
  const site = await startFakeStake({ mode: "slow" });
  try {
    const r = await runCollector({ url: site.url, categories: ["home"], timeoutMs: 6000, env: { ...FAST, STAKE_PAGE_TIMEOUT_MS: "60000" } });
    assert.equal(r.status, "timeout");
  } finally {
    site.close();
  }
});

test("server: scan runs the collector first, uses its boosts, survives failures", opts, async () => {
  const site = await startFakeStake();
  clearRegistryCache();
  const fake = demoFetch();
  const app = createApp({
    env: {
      NODE_ENV: "test",
      APP_PASSWORD: "pw",
      ODDSPAPI_KEY: "k",
      BOOKMAKERS: "stake,pinnacle,bet365",
      SPORTS: "10,11",
      STAKE_URL: site.url,
      STAKE_CATEGORIES: "basketball,soccer",
      STAKE_COLLECTOR_EXTRA_ENV: JSON.stringify(FAST),
    },
    fetchImpl: (url, o) => (String(url).includes("oddspapi") ? fake(url, o) : fetch(url, o)),
    tickMs: 0,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => (await fetch(base + p, { headers: { authorization: "Bearer pw" } })).json();
  try {
    const r = await fetch(base + "/api/scan", { method: "POST", headers: { authorization: "Bearer pw" } });
    assert.equal(r.status, 202);
    // While the collector runs, the API stays responsive
    const mid = await get("/api/state");
    assert.ok(mid.running);
    for (let i = 0; i < 600 && app.state.running; i++) await new Promise((res) => setTimeout(res, 100));
    const st = await get("/api/state");
    assert.equal(st.collector.last.status, "ok");
    assert.equal(st.boosted.source, "server");
    assert.equal(st.boosted.count, 4);
    assert.ok(st.boostedChecks.some((c) => /Denver Nuggets/.test(c.event)), "server-collected boosts compared");
    assert.ok(st.health.some((h) => h.source === "collector" && h.level === "ok"));

    // Now the site starts serving a challenge: collector reports it, server keeps working,
    // previous boosts are kept (they age out on their own), next try backs off 3 h.
    site.close();
    const blocked = await startFakeStake({ mode: "challenge" });
    app.state.collector.url = blocked.url;
    app.state.collector.nextDueAt = 0;
    await app.scan("test");
    const st2 = await get("/api/state");
    assert.equal(st2.collector.last.status, "blocked");
    assert.equal(st2.boosted.count, 4);
    assert.ok(st2.collector.nextDueAt - Date.now() > 2.5 * 3600_000);
    assert.ok(st2.health.some((h) => h.source === "collector" && h.level === "error" && /bot-check/.test(h.title)));
    assert.ok(st2.scan.stats.fixturesWithOdds > 0, "OddsPapi part of the scan still ran");
    blocked.close();
  } finally {
    app.close();
    site.close();
  }
});
