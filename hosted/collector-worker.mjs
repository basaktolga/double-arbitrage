#!/usr/bin/env node
/**
 * Stake boosted-odds collector — runs in its OWN process so a browser crash or an
 * out-of-memory kill can never take the web server down with it.
 *
 * Reads its job from env (STAKE_URL, STAKE_CATEGORIES, …), visits one category page
 * at a time in a low-memory headless Chromium, scrolls to load lazy lists, reads the
 * same elements the userscript reads, and prints newline-delimited JSON to stdout:
 *
 *   {"type":"progress","page":2,"pages":6,"category":"soccer"}
 *   {"type":"result","status":"ok","items":[…],"pages":[…]}
 *
 * It does not try to get past bot checks or geo-blocks: if the site serves a
 * challenge or a "not available in your region" page, it reports that and stops.
 */

const env = process.env;
const BASE = (env.STAKE_URL || "https://stake.com").replace(/\/+$/, "");
const CATEGORIES = (env.STAKE_CATEGORIES || "home,soccer,basketball,tennis,ice-hockey,esports")
  .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
const PAGE_TIMEOUT_MS = Number(env.STAKE_PAGE_TIMEOUT_MS || 45_000);
const ODDS_WAIT_MS = Number(env.STAKE_ODDS_WAIT_MS || 25_000);
const RESTART_EVERY = Math.max(1, Number(env.STAKE_RESTART_EVERY || 3));
const PAUSE_MS = Number(env.STAKE_PAUSE_MS || 2500);
const MAX_SCROLLS = Number(env.STAKE_MAX_SCROLLS || 22);

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadChromium() {
  for (const mod of ["playwright-core", "playwright"]) {
    try {
      const m = await import(mod);
      return m.chromium ?? m.default?.chromium;
    } catch {
      /* try next */
    }
  }
  // Globally installed Playwright (found through NODE_PATH, which ESM import ignores)
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  for (const mod of ["playwright-core", "playwright"]) {
    try {
      return require(mod).chromium;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Chromium flags chosen for a 512 MB container: one renderer, no GPU, small JS heap,
// no /dev/shm (tiny in containers), no background services.
const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints",
  "--renderer-process-limit=1",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--js-flags=--max-old-space-size=192",
];

/** Runs inside the page. Same logic as the userscript's scanDom(). */
function readBoosts(category) {
  const num = (s) => parseFloat(String(s).trim().replace(",", "."));
  const txt = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const matchName = (btn) => {
    let n = btn.parentElement;
    for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement) {
      const sibs = n.querySelectorAll('[data-testid="fixture-outcome"]');
      if (sibs.length >= 2) {
        const names = [];
        sibs.forEach((s) => {
          const nm = s.getAttribute("aria-label") || txt(s.querySelector('[data-testid="outcome-button-name"]'));
          if (nm && !names.includes(nm)) names.push(nm);
        });
        return names.slice(0, 3).join(" vs ");
      }
    }
    return "";
  };
  const out = [];
  const seen = new Set();
  document.querySelectorAll('[data-testid="multi-bet-boosted-odds"]').forEach((boostedEl) => {
    const btn = boostedEl.closest('button, a, [data-testid="fixture-outcome"]') || boostedEl.parentElement?.parentElement;
    if (!btn || seen.has(btn)) return;
    seen.add(btn);
    const oldEl = btn.querySelector('[data-testid="multi-bet-original-odds"]');
    const nameEl = btn.querySelector('[data-testid="outcome-button-name"]');
    const newOdds = num(txt(boostedEl));
    const oldOdds = oldEl ? num(txt(oldEl)) : null;
    if (!(newOdds > 1)) return;
    out.push({
      label: btn.getAttribute("aria-label") || txt(nameEl) || "(selection)",
      match: matchName(btn),
      oldOdds: oldOdds > 1 ? oldOdds : null,
      newOdds,
      uplift: oldOdds > 1 ? (newOdds / oldOdds - 1) * 100 : null,
      category,
    });
  });
  return { items: out, outcomes: document.querySelectorAll('[data-testid="fixture-outcome"]').length };
}

/** Runs inside the page: is this a bot-check or region-block page instead of the site? */
function pageVerdict() {
  const title = document.title || "";
  const body = (document.body?.innerText || "").slice(0, 4000);
  if (/just a moment|attention required|verify you are human|access denied/i.test(title) ||
      document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]')) {
    return { verdict: "blocked", title };
  }
  if (/not available in your (region|country|location)|restricted (region|jurisdiction|territory)|bölgenizde kullanılamıyor|your country is restricted/i.test(body)) {
    return { verdict: "geo_blocked", title };
  }
  return { verdict: "ok", title };
}

function urlFor(category) {
  return category === "home" ? `${BASE}/sports/home` : `${BASE}/sports/${encodeURIComponent(category)}`;
}

async function main() {
  const chromium = await loadChromium();
  if (!chromium) {
    emit({ type: "result", status: "no_browser", error: "playwright-core is not installed (use the Docker deploy)", items: [], pages: [] });
    return;
  }

  const results = new Map();
  const pages = [];
  let browser = null;
  let context = null;
  let opened = 0;
  let status = "ok";
  let error = null;
  let sample = null;

  const startBrowser = async () => {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    context = await browser.newContext({ viewport: { width: 1024, height: 900 }, locale: "en-US", serviceWorkers: "block" });
    // Images, video and web fonts aren't needed to read odds and cost the most memory.
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
    });
  };

  try {
    for (const [i, category] of CATEGORIES.entries()) {
      if (!browser || opened % RESTART_EVERY === 0) await startBrowser();
      opened++;
      emit({ type: "progress", page: i + 1, pages: CATEGORIES.length, category });
      const page = await context.newPage();
      const rec = { category, items: 0, outcomes: 0, ms: 0, error: null };
      const t0 = Date.now();
      try {
        page.setDefaultTimeout(PAGE_TIMEOUT_MS);
        const resp = await page.goto(urlFor(category), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
        rec.http = resp?.status() ?? null;
        await page.waitForSelector('[data-testid="fixture-outcome"]', { timeout: ODDS_WAIT_MS }).catch(() => {});
        const v = await page.evaluate(pageVerdict);
        if (v.verdict !== "ok") {
          status = v.verdict;
          error = `${category}: ${v.verdict === "blocked" ? "bot check page" : "region block page"} ("${v.title}")`;
          rec.error = v.verdict;
          pages.push(rec);
          await page.close().catch(() => {});
          break;
        }
        let still = 0;
        for (let s = 0; s <= MAX_SCROLLS; s++) {
          const r = await page.evaluate(readBoosts, category);
          rec.outcomes = Math.max(rec.outcomes, r.outcomes);
          for (const it of r.items) results.set([it.match, it.label, it.oldOdds, it.newOdds].join("|"), it);
          const moved = await page.evaluate(() => {
            const y = window.scrollY;
            window.scrollBy(0, Math.round(window.innerHeight * 0.8));
            return Math.abs(window.scrollY - y) > 4;
          });
          await sleep(700);
          if (!moved && ++still >= 2) break;
          if (moved) still = 0;
        }
        rec.items = [...results.values()].filter((x) => x.category === category).length;
        if (!sample && rec.outcomes === 0) {
          sample = await page.evaluate(() => (document.title + " :: " + (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300))).catch(() => null);
        }
      } catch (e) {
        rec.error = String(e.message || e).split("\n")[0].slice(0, 200);
        if (/Target (page|crashed)|browser has been closed|crash/i.test(rec.error)) browser = null; // relaunch next page
      } finally {
        rec.ms = Date.now() - t0;
        pages.push(rec);
        await page.close().catch(() => {});
      }
      if (i < CATEGORIES.length - 1) await sleep(PAUSE_MS);
    }
  } catch (e) {
    status = "error";
    error = String(e.message || e).split("\n")[0].slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (status === "ok") {
    const okPages = pages.filter((p) => !p.error);
    if (!okPages.length) {
      status = "error";
      error = error || pages.map((p) => `${p.category}: ${p.error}`).join("; ").slice(0, 400);
    } else if (okPages.every((p) => p.outcomes === 0)) {
      status = "no_odds_elements";
      error = `No odds buttons found on any page — layout may have changed or nothing loaded. Page said: ${sample ?? "?"}`;
    }
  }
  emit({ type: "result", status, error, items: [...results.values()], pages });
}

main().catch((e) => {
  emit({ type: "result", status: "error", error: String(e.message || e).slice(0, 300), items: [], pages: [] });
  process.exitCode = 1;
});
