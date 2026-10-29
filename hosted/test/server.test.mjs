import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { demoFetch } from "../lib/demo.mjs";
import { clearRegistryCache } from "../lib/scanner.mjs";

async function start(env, fetchImpl) {
  clearRegistryCache();
  const app = createApp({ env: { NODE_ENV: "test", ...env }, fetchImpl, tickMs: 0 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, { method = "GET", key, body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { app, base, call };
}

const waitIdle = async (app) => {
  for (let i = 0; i < 200 && app.state.running; i++) await new Promise((r) => setTimeout(r, 25));
};

test("demo mode end to end: auth, scan, boosted arbs, settings, doctor", async () => {
  const { app, call } = await start({ DEMO: "1", APP_PASSWORD: "pw", UPLOAD_KEY: "up", BOOKMAKERS: "stake,pinnacle,bet365", SPORTS: "10,11" });
  try {
    assert.equal((await call("/healthz")).status, 200);
    assert.equal((await call("/api/state")).status, 401);
    assert.equal((await call("/api/state", { key: "nope" })).status, 401);
    const page = await call("/");
    assert.match(await page.text(), /<title>/);
    assert.equal((await call("/../server.mjs")).status, 404);

    const s = await call("/api/scan", { method: "POST", key: "pw" });
    assert.equal(s.status, 202);
    await waitIdle(app);
    const st = await (await call("/api/state", { key: "pw" })).json();
    assert.ok(st.scan.stats.fixtures > 0, "fixtures scanned");
    assert.ok(st.scan.stats.fixturesWithOdds > 0, "odds fetched");
    assert.ok(st.window.until > Date.now(), "keep-alive window opened");
    assert.ok(st.boostedChecks.length >= 2, "boosted selections compared");
    // Every check is a market containing a boosted outcome (another book may still beat the boost)
    assert.ok(st.boostedChecks.every((c) => c.legs.length === 0 || c.boostedMarket));
    assert.ok(st.unmatchedBoosted.some((u) => /multi/.test(u.reason)));
    for (const a of st.arbs) {
      assert.ok(a.profitPct > 0);
      assert.ok(Math.abs(a.legs.reduce((x, l) => x + l.share, 0) - 1) < 1e-6);
      // Single-book results are only allowed when flagged (Stake boosts on both sides)
      assert.ok(new Set(a.legs.map((l) => l.book.replace(" ★", ""))).size >= 2 || a.sameBook === true);
    }
    assert.ok(st.health.some((h) => h.source === "oddspapi" && /Demo/.test(h.title)));

    // Settings edit
    const set = await (await call("/api/settings", { method: "POST", key: "pw", body: { minProfit: 2.5, sports: "11" } })).json();
    assert.equal(set.settings.minProfit, 2.5);
    assert.deepEqual(set.settings.sports, [11]);

    // Uploads: upload key works, password works, wrong key fails
    assert.equal((await call("/api/stake/upload", { method: "POST", key: "wrong", body: { items: [] } })).status, 401);
    const up = await call("/api/stake/upload", { method: "POST", headers: { "x-upload-key": "up" }, body: { items: [{ label: "Boston Celtics", match: "Boston Celtics vs Miami Heat", category: "basketball", oldOdds: 1.8, newOdds: 2.4 }] } });
    assert.equal((await up.json()).count, 1);
    await waitIdle(app);
    const lu = await call("/api/local/upload", { method: "POST", key: "up", body: { scrapedAt: Date.now(), arbs: [{ match: "A vs B", market: "Total Corners", line: 9.5, over_book: "bwin", over_odds: 2.1, under_book: "bson", under_odds: 2.05 }] } });
    assert.equal((await lu.json()).count, 1);
    const st2 = await (await call("/api/state", { key: "pw" })).json();
    assert.equal(st2.boosted.count, 1);
    assert.ok(st2.arbs.some((a) => a.source === "local"));

    // Doctor without an Anthropic key: rule checks + clear message
    const doc = await (await call("/api/doctor", { method: "POST", key: "pw" })).json();
    assert.ok(Array.isArray(doc.checks) && doc.checks.length);
    assert.match(doc.doctor.text, /ANTHROPIC_API_KEY/);

    // Window stop
    const w = await (await call("/api/window", { method: "POST", key: "pw", body: { action: "stop" } })).json();
    assert.equal(w.window.until, 0);

    // Bad JSON
    const bad = await fetch(`http://127.0.0.1:${app.server.address().port}/api/settings`, { method: "POST", headers: { authorization: "Bearer pw" }, body: "{nope" });
    assert.equal(bad.status, 400);
  } finally {
    app.close();
  }
});

test("no password configured → API disabled", async () => {
  const { app, call } = await start({}, demoFetch());
  try {
    assert.equal((await call("/api/state", { key: "" })).status, 503);
  } finally {
    app.close();
  }
});

test("real-mode errors surface: 401 key, unknown slugs, self-ping and alerts", async () => {
  const pings = [];
  const ntfy = [];
  const fake = demoFetch();
  let keyOk = false;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === "ntfy.sh") {
      ntfy.push(opts);
      return new Response("ok");
    }
    if (u.host === "me.example") {
      pings.push(url);
      return new Response("ok");
    }
    if (u.host === "v5.oddspapi.io") {
      if (!keyOk) return new Response(JSON.stringify({ error: 401, code: "invalid_api_key", message: "invalid apiKey" }), { status: 401 });
      return fake(url);
    }
    throw new Error("unexpected " + url);
  };
  const { app, call } = await start(
    { APP_PASSWORD: "pw", ODDSPAPI_KEY: "k", BOOKMAKERS: "stake,pinnacle,notabook", SPORTS: "11", NTFY_TOPIC: "t", MIN_PROFIT: "0", RENDER_EXTERNAL_URL: "https://me.example" },
    fetchImpl,
  );
  try {
    await call("/api/scan", { method: "POST", key: "pw" });
    await waitIdle(app);
    let st = await (await call("/api/state", { key: "pw" })).json();
    assert.ok(st.scan.errors.some((e) => e.status === 401));
    assert.ok(st.health.some((h) => h.level === "error" && /401/.test(h.title)));

    keyOk = true;
    app.state.knownBooks = null;
    app.state.lastScan.startedAt = 0;
    // timer path: tick() pings self once the interval has passed and rescans
    app.state.lastPingAt = 0;
    app.state.window.until = Date.now() + 60_000;
    app.state.lastPingAt = Date.now() - 11 * 60_000;
    await app.tick();
    await waitIdle(app);
    assert.equal(pings.length, 1);
    st = await (await call("/api/state", { key: "pw" })).json();
    assert.ok(st.health.some((h) => /Unknown bookmaker slug: notabook/.test(h.title)));
    assert.ok(st.scan.stats.fixturesWithOdds > 0);
    if (st.arbs.length) assert.ok(ntfy.length >= 1, "alert sent for arbs ≥ MIN_PROFIT");
  } finally {
    app.close();
  }
});
