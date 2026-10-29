// The doctor: health checks for every data source, plus an optional AI diagnosis.
//
// Rule checks always run and need no keys. If ANTHROPIC_API_KEY is set, the
// snapshot (with no secrets in it) is sent to Claude for a plain-language diagnosis
// and next steps, in the same DIAGNOSIS / ACTION NEEDED style as the local console's
// doctor. The hosted doctor only reads — it never edits code or settings.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** levels: ok | warn | error | off */
export function healthChecks(snap) {
  const out = [];
  const add = (source, level, title, detail = "") => out.push({ source, level, title, detail });
  const s = snap.settings;
  const scan = snap.lastScan;

  // ---- OddsPapi
  if (!snap.hasOddsKey && !snap.demo) {
    add("oddspapi", "error", "No OddsPapi key", "Set ODDSPAPI_KEY in the Render environment, then redeploy.");
  } else if (snap.demo) {
    add("oddspapi", "warn", "Demo mode", "DEMO=1 — prices are fake. Remove DEMO and set ODDSPAPI_KEY for real data.");
  }
  const recent = snap.apiCalls.slice(-50);
  const has = (st) => recent.some((c) => c.status === st);
  if (has(401)) add("oddspapi", "error", "API key rejected (401)", "The key is wrong, expired or disabled. Copy it again from your OddsPapi account.");
  if (has(403)) add("oddspapi", "warn", "Some endpoints not allowed (403)", "Your plan may not include an endpoint or a bookmaker. Scans fall back to slower per-fixture requests.");
  const rl = recent.filter((c) => c.status === 429).length;
  if (rl >= 3) add("oddspapi", "warn", `Rate limited ${rl}× recently`, "Lower 'max fixtures per sport' or the number of sports, or scan less often.");
  if (snap.unknownBooks?.length) {
    add("oddspapi", "error", `Unknown bookmaker slug: ${snap.unknownBooks.join(", ")}`, "These slugs are not in your key's /bookmakers list — check spelling in Settings (e.g. 'bet365', 'pinnacle', '1xbet').");
  }
  if (scan) {
    if (scan.stats.fixtures === 0 && !scan.errors.length) add("oddspapi", "warn", "No upcoming fixtures", "Nothing starts in your look-ahead window for the selected sports. Add sports or widen the window.");
    const missing = s.bookmakers.filter((b) => !scan.stats.books[b] && b !== s.stakeSlug);
    if (scan.stats.fixturesWithOdds > 0 && missing.length) {
      add("oddspapi", "warn", `No prices from: ${missing.join(", ")}`, "These books returned no odds on any scanned fixture — wrong slug, not covered by your plan, or not pricing these sports.");
    }
    if (scan.skippedBooks?.length) add("oddspapi", "warn", `Skipped (stale/suspended): ${scan.skippedBooks.join(", ")}`, "OddsPapi flagged these books' prices as untrustworthy right now; they're ignored until the flag clears.");
    if (!out.some((c) => c.source === "oddspapi" && c.level === "error") && scan.stats.fixturesWithOdds > 0) {
      add("oddspapi", "ok", `${scan.stats.fixturesWithOdds} fixtures priced`, `${Object.keys(scan.stats.books).length} books returned prices.`);
    }
  }

  // ---- Stake boosted (userscript)
  const b = snap.boosted;
  if (!b) {
    add("stake", "off", "No boosted odds yet", snap.collector?.enabled ? "The server collects them at the next scan. The phone userscript also works as a backup." : "Install the userscript, tap ⚡ → Cloud setup, then Scan ALL categories.");
  } else {
    const ageMin = Math.round((snap.now - b.uploadedAt) / 60000);
    if (b.count === 0) add("stake", "error", "Last upload had 0 boosted items", "If Stake clearly shows boosts, the page layout changed — use the userscript's Debug button and send the copied HTML.");
    else if (ageMin > s.boostedMaxAgeMin) add("stake", "warn", `Boosted odds are ${ageMin} min old`, "Alerts for boosted arbs are paused until fresh data — from the server collector or the phone userscript.");
    else add("stake", "ok", `${b.count} boosted items, ${ageMin} min old`, b.source === "server" ? "Collected by the server." : "Uploaded from your phone.");
    if (scan && b.count) {
      const unmatched = scan.unmatchedBoosted.length;
      const ratio = unmatched / b.count;
      if (ratio > 0.6) {
        const top = topReason(scan.unmatchedBoosted);
        add("stake", "warn", `${unmatched}/${b.count} boosts couldn't be compared`, `Most common reason: ${top}.`);
      }
    }
  }

  // ---- Stake collector (server-side browser)
  const c = snap.collector;
  if (c && !c.available) {
    if (!b) add("collector", "off", "Server collector off", "STAKE_COLLECTOR=0 — boosts only come from the phone userscript.");
  } else if (c && !c.enabled) {
    add("collector", "off", "Server collector paused", "Turned off in Settings.");
  } else if (c) {
    const L = c.last;
    const next = c.nextDueAt > snap.now ? ` Next try in ${fmtAge(Math.round((c.nextDueAt - snap.now) / 60000))}.` : "";
    if (c.running) add("collector", "ok", "Collecting Stake boosts now", "One page at a time; a full run takes a few minutes.");
    else if (!L) add("collector", "off", "Not run yet", "Runs at the start of the next scan.");
    else {
      const ago = `${fmtAge(Math.round((snap.now - L.at) / 60000))} ago`;
      const peak = L.peakMb ? ` Peak memory ${L.peakMb} MB of ${c.maxMb}.` : "";
      const msgs = {
        ok: ["ok", `Collected ${L.count} boosts ${ago}`, `${L.pages.length} pages in ${Math.round(L.durationMs / 1000)}s.${peak}`],
        blocked: ["error", "Stake served a bot-check page", `The server's browser was challenged (${L.error}). The app does not try to get past bot checks — use the phone userscript for boosts instead.${next}`],
        geo_blocked: ["error", "Stake is not available from the server's location", `The site showed a region block. Change STAKE_URL only to an address you're allowed to use, or use the phone userscript.${next}`],
        no_odds_elements: ["warn", "Pages loaded but no odds were found", `${L.error ?? ""} Use the userscript's Debug button on your phone and send the copied HTML so the selectors can be updated.${next}`],
        no_browser: ["error", "No browser on the server", "playwright-core / Chromium is missing. Deploy with the Dockerfile (render.yaml does this)."],
        memory_limit: ["warn", "Collector stopped for using too much memory", `Peak ${L.peakMb} MB. The server itself kept running.${L.count ? ` Kept ${L.count} boosts it had already read.` : ""} Try fewer Stake categories in Settings.${next}`],
        timeout: ["warn", "Collector run took too long and was stopped", `The server itself kept running.${L.count ? ` Kept ${L.count} boosts it had already read.` : ""} Try fewer categories, or the site is slow.${next}`],
        crashed: ["warn", "Collector crashed", `${L.error ?? ""} The server itself kept running.${next}`],
        error: ["warn", "Collector failed", `${L.error ?? ""}${next}`],
      };
      const [level, title, detail] = msgs[L.status] ?? ["warn", `Collector: ${L.status}`, L.error ?? ""];
      add("collector", level, title, detail.trim());
      const failed = (L.pages ?? []).filter((p) => p.error);
      if (L.status === "ok" && failed.length) add("collector", "warn", `${failed.length} Stake page(s) failed`, failed.map((p) => `${p.category}: ${p.error}`).join("; ").slice(0, 300));
    }
  }

  // ---- Local scrapers
  const l = snap.local;
  if (!l) add("local", "off", "No local scraper results", "Optional: run json-2file-arbfinder/push_to_hosted.py on your PC after scraping.");
  else {
    const ageMin = Math.round((snap.now - (l.scrapedAt ?? l.uploadedAt)) / 60000);
    add("local", ageMin > 120 ? "warn" : "ok", `${l.count} local arbs, data ${fmtAge(ageMin)} old`, ageMin > 120 ? "Scraped odds this old are likely gone — rescrape before betting." : "");
  }

  // ---- Keep-alive
  if (!snap.selfUrl) add("server", "warn", "Self-ping URL unknown", "RENDER_EXTERNAL_URL is not set (it is on Render). Without it the server sleeps ~15 min after your last visit.");
  else if (snap.window.until > snap.now) add("server", "ok", `Awake for ${fmtAge(Math.round((snap.window.until - snap.now) / 60000))} more`, `Scanning every ${s.scanIntervalMin} min.`);
  else add("server", "off", "Keep-alive window closed", "Tap Scan to wake the server for another window.");
  if (snap.pingFailures >= 2) add("server", "warn", "Self-ping failing", "The server can't reach its own URL; it will sleep when idle.");
  if (!snap.alertsEnabled) add("server", "off", "Push alerts off", "Set NTFY_TOPIC to get phone notifications.");

  return out;
}

function topReason(list) {
  const c = new Map();
  for (const u of list) c.set(u.reason, (c.get(u.reason) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
}

function fmtAge(min) {
  if (min < 90) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} days`;
}

const SYSTEM = `You are the doctor for a personal sports-arbitrage finder. You receive a JSON snapshot of its data sources:
- OddsPapi (licensed odds API) for most bookmakers,
- Stake boosted odds uploaded by a userscript running in the user's own browser,
- optional local scraper results uploaded from the user's PC,
- a small server on Render's free plan that stays awake only during short keep-alive windows.

Diagnose what is wrong or degraded, most important first, and say exactly what the user should do (setting to change, key to re-copy, page to open). Be concrete and brief; the user reads this on a phone.
Never suggest bypassing a site's bot protection, geo-blocks, account limits or terms, and never suggest opening extra accounts. If nothing is wrong, say so in one line.

Reply in exactly this format:
DIAGNOSIS: <2-5 short sentences>
ACTION NEEDED: <numbered steps, or "none">`;

export async function aiDiagnosis(snapshot, { apiKey, model, fetchImpl = globalThis.fetch }) {
  if (!apiKey) return { ok: false, text: "AI doctor is off — set ANTHROPIC_API_KEY to enable it. The rule checks above still run." };
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: "Snapshot:\n```json\n" + JSON.stringify(snapshot, null, 1).slice(0, 60_000) + "\n```" }],
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg += j?.error?.message ? ` — ${j.error.message}` : "";
    } catch {
      /* ignore */
    }
    return { ok: false, text: `AI doctor request failed: ${msg}` };
  }
  const j = await res.json();
  const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  return { ok: true, text: text || "(empty reply)" };
}
