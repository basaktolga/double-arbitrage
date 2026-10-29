// One full scan: fixtures → odds → boosted matching → arbitrage evaluation.

import { buildRegistry, evaluateFixture } from "./arb.mjs";
import { matchBoosted, boostedSports } from "./boosted.mjs";
import { SPORT_NAMES } from "./names.mjs";

const REGISTRY_TTL_MS = 12 * 3600 * 1000;
const registryCache = new Map(); // sportId → { at, registry }

export function clearRegistryCache() {
  registryCache.clear();
}

async function registryFor(client, sportId) {
  const hit = registryCache.get(sportId);
  if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.registry;
  const registry = buildRegistry(await client.markets(sportId));
  registryCache.set(sportId, { at: Date.now(), registry });
  return registry;
}

/**
 * settings: { bookmakers[], sports[], lookaheadHours, minLeadMinutes, maxFixturesPerSport,
 *             stakeSlug, marketTypes[], skipIntegerLines }
 * boostedDoc: { uploadedAt, items[] } | null
 */
export async function runScan({ client, settings, boostedDoc, now = Date.now(), progress = () => {} }) {
  const out = {
    startedAt: now,
    finishedAt: null,
    arbs: [],
    boostedChecks: [],
    unmatchedBoosted: [],
    stats: { sports: 0, fixtures: 0, fixturesWithOdds: 0, markets: 0, books: {} },
    errors: [],
    skippedBooks: [],
    usedFallback: false,
  };
  const books = settings.bookmakers;
  const nowSec = Math.floor(now / 1000);
  const fromSec = nowSec + settings.minLeadMinutes * 60;
  const toSec = nowSec + settings.lookaheadHours * 3600;

  const items = boostedDoc?.items ?? [];
  const sports = [...new Set([...settings.sports, ...boostedSports(items)])];
  out.stats.sports = sports.length;

  const fixturesBySport = new Map();
  const registries = new Map();
  for (const sid of sports) {
    progress(`Loading ${SPORT_NAMES[sid] ?? "sport " + sid} fixtures…`);
    try {
      registries.set(sid, await registryFor(client, sid));
      const fx = (await client.fixtures(sid, fromSec, toSec)).filter(
        (f) => f.fixtureId && f.home && f.away && f.statusId === 0 && f.startTime && f.startTime >= fromSec && f.startTime <= toSec,
      );
      fx.sort((a, b) => a.startTime - b.startTime);
      fixturesBySport.set(sid, fx);
    } catch (e) {
      out.errors.push({ source: "oddspapi", message: `${SPORT_NAMES[sid] ?? sid}: ${e.message}`, status: e.status ?? null, code: e.code ?? null });
      if (e.code === "missing_api_key" || e.status === 401) break;
    }
  }

  // Boosted items → fixtures/outcomes
  const { matched, unmatched } = matchBoosted(items, fixturesBySport, registries, { uploadedAt: boostedDoc?.uploadedAt });
  out.unmatchedBoosted = unmatched.map((u) => ({ ...u.item, reason: u.reason }));
  const boostedByFixture = new Map();
  for (const m of matched) {
    if (!boostedByFixture.has(m.fixtureId)) boostedByFixture.set(m.fixtureId, []);
    boostedByFixture.get(m.fixtureId).push(m);
  }

  // Which fixtures to price: every boosted one, plus the soonest N per sport.
  const chosen = new Map();
  for (const m of matched) chosen.set(m.fixtureId, { fixture: m.fixture, sportId: m.sportId });
  for (const [sid, list] of fixturesBySport) {
    let n = 0;
    for (const f of list) {
      if (n >= settings.maxFixturesPerSport) break;
      if (!chosen.has(f.fixtureId)) chosen.set(f.fixtureId, { fixture: f, sportId: sid });
      n++;
    }
  }
  out.stats.fixtures = chosen.size;
  if (!chosen.size) {
    out.finishedAt = Date.now();
    return out;
  }

  progress(`Fetching odds for ${chosen.size} fixtures from ${books.length} books…`);
  let views = [];
  try {
    views = await client.oddsMain([...chosen.keys()], books);
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      out.usedFallback = true;
      progress("Main-odds endpoint not available for this key — fetching fixtures one by one…");
      const ids = [...chosen.keys()].slice(0, 60);
      for (const [i, id] of ids.entries()) {
        if (i % 10 === 0) progress(`Fetching odds ${i + 1}/${ids.length}…`);
        try {
          views.push(await client.odds(id, books));
        } catch (e2) {
          out.errors.push({ source: "oddspapi", message: e2.message, status: e2.status ?? null, code: e2.code ?? null });
          if (e2.status === 401 || e2.status === 403) break;
        }
      }
    } else {
      out.errors.push({ source: "oddspapi", message: e.message, status: e.status ?? null, code: e.code ?? null });
    }
  }

  progress("Comparing prices…");
  const skippedBooks = new Set();
  for (const v of views) {
    const ctx = chosen.get(v.fixtureId);
    if (!ctx) continue;
    const registry = registries.get(ctx.sportId);
    if (!registry) continue;
    const bookCount = Object.keys(v.odds ?? {}).length;
    if (bookCount) out.stats.fixturesWithOdds++;
    for (const b of Object.keys(v.odds ?? {})) out.stats.books[b] = (out.stats.books[b] ?? 0) + 1;
    const boosted = boostedByFixture.get(v.fixtureId) ?? [];
    const { results, skipped } = evaluateFixture({
      fixture: ctx.fixture,
      oddsByBook: v.odds,
      bookMeta: v.bookmakers,
      registry,
      boosted,
      books,
      stakeSlug: settings.stakeSlug,
      marketTypes: settings.marketTypes,
      skipIntegerLines: settings.skipIntegerLines,
      now,
    });
    skipped.forEach((s) => skippedBooks.add(s.split(":")[0]));
    out.stats.markets += results.length;
    const base = {
      fixtureId: v.fixtureId,
      event: `${ctx.fixture.home} vs ${ctx.fixture.away}`,
      startTime: ctx.fixture.startTime,
      sportId: ctx.sportId,
      sport: SPORT_NAMES[ctx.sportId] ?? `Sport ${ctx.sportId}`,
      tournament: ctx.fixture.tournament,
      source: "oddspapi",
    };
    for (const r of results) {
      const row = { ...base, ...r, profitPct: r.profitPct != null ? round(r.profitPct, 3) : null };
      if (r.boostedMarket) {
        const b = boosted.find((x) => r.legs.some((l) => l.outcomeId === x.outcomeId)) ?? boosted[0];
        out.boostedChecks.push({ ...row, boostedItem: b?.item ?? null });
      }
      if (r.complete && r.profitPct > 0) out.arbs.push(row);
    }
  }
  // Boosted fixtures that came back with no odds at all
  for (const [fid, list] of boostedByFixture) {
    if (!views.some((v) => v.fixtureId === fid)) {
      for (const m of list) out.unmatchedBoosted.push({ ...m.item, reason: "no odds returned for this fixture from your bookmakers" });
    }
  }
  out.skippedBooks = [...skippedBooks];
  out.arbs.sort((a, b) => b.profitPct - a.profitPct);
  out.boostedChecks.sort((a, b) => (b.profitPct ?? -999) - (a.profitPct ?? -999));
  out.finishedAt = Date.now();
  return out;
}

/** Normalise arb_finder.py --json output (local scrapers) to the common arb shape. */
export function normaliseLocal(doc) {
  const arbs = Array.isArray(doc?.arbs) ? doc.arbs : [];
  const at = Number(doc?.scrapedAt) || Number(doc?.uploadedAt) || null;
  return arbs.slice(0, 500).map((a) => {
    const over = Number(a.over_odds);
    const under = Number(a.under_odds);
    const sumInv = 1 / over + 1 / under;
    const ageSec = at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
    return {
      source: "local",
      fixtureId: null,
      event: String(a.match ?? "?"),
      startTime: null,
      sport: "Soccer (scrapers)",
      market: `${a.market ?? a.market_id} ${a.line}`,
      marketType: "totals",
      complete: true,
      profitPct: round((1 / sumInv - 1) * 100, 3),
      boosted: false,
      maxTotal: null,
      legs: [
        { selection: `Over ${a.line}`, book: String(a.over_book), price: over, share: 1 / over / sumInv, limit: null, ageSec },
        { selection: `Under ${a.line}`, book: String(a.under_book), price: under, share: 1 / under / sumInv, limit: null, ageSec },
      ],
    };
  }).filter((a) => a.profitPct > 0);
}

function round(x, d) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
