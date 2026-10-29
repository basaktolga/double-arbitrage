// Generic N-way arbitrage over OddsPapi-style odds.
//
// OddsPapi decomposes every market into marketId → outcomeIds, where one marketId is a
// complete probability space (all sides of exactly one line). So the rule is simple:
// for each marketId, take the best price per outcome across books; if every outcome
// has a price and sum(1/price) < 1, it is an arbitrage.
//
// Stake's boosted prices are injected as extra candidates ("stake ★") and replace
// Stake's normal price on that outcome.

export const DEFAULT_MARKET_TYPES = [
  "1x2", "moneyline", "totals", "spreads", "spreads-european",
  "drawnobet", "bothteamsscore", "teamtotals-team1", "teamtotals-team2",
];

/**
 * registry: Map<outcomeId, { marketId, marketName, marketType, period, handicap,
 *                            outcomeName, outcomeIds: number[] }>
 */
export function evaluateFixture({
  fixture,
  oddsByBook = {},
  bookMeta = {},
  registry,
  boosted = [],
  books = null,
  stakeSlug = "stake",
  marketTypes = DEFAULT_MARKET_TYPES,
  skipIntegerLines = true,
  now = Date.now(),
}) {
  const allowedBook = (b) => !books || !books.length || books.includes(b);
  const allowedType = (t) => !marketTypes || marketTypes.includes(t);
  const skipped = [];
  const markets = new Map(); // marketId → { market, cands: Map<outcomeId, cand[]> }

  const slot = (market) => {
    let m = markets.get(market.marketId);
    if (!m) {
      m = { market, cands: new Map() };
      markets.set(market.marketId, m);
    }
    return m;
  };

  for (const [book, rows] of Object.entries(oddsByBook)) {
    if (!allowedBook(book)) continue;
    const meta = bookMeta[book];
    if (meta && (meta.staleOdds || meta.suspended || meta.participantsRotated)) {
      skipped.push(`${book}: ${meta.staleOdds ? "stale" : meta.suspended ? "suspended" : "home/away rotated"}`);
      continue;
    }
    for (const [oddsId, row] of Object.entries(rows ?? {})) {
      const parts = String(oddsId).split(":");
      if (parts.length < 4) continue;
      const playerId = parts[parts.length - 1];
      if (playerId !== "0") continue; // player props: not comparable across books reliably
      const outcomeId = Number(row.outcomeId ?? parts[parts.length - 2]);
      const market = registry.get(outcomeId);
      if (!market || !allowedType(market.marketType)) continue;
      if (row.active === false || row.marketActive === false) continue;
      const price = Number(row.price);
      if (!(price > 1)) continue;
      const m = slot(market);
      if (!m.cands.has(outcomeId)) m.cands.set(outcomeId, []);
      m.cands.get(outcomeId).push({
        book,
        price,
        boosted: false,
        limit: row.limit != null ? Number(row.limit) : null,
        changedAt: row.changedAt ?? null,
        ageSec: row.changedAt ? Math.max(0, Math.round((now - row.changedAt) / 1000)) : null,
      });
    }
  }

  const boostedMarketIds = new Set();
  for (const b of boosted) {
    const market = registry.get(b.outcomeId);
    if (!market) continue;
    const m = slot(market);
    const list = (m.cands.get(b.outcomeId) ?? []).filter((c) => c.book !== stakeSlug);
    list.push({
      book: `${stakeSlug} ★`,
      price: Number(b.price),
      oldPrice: b.oldPrice ?? null,
      boosted: true,
      limit: b.limit ?? null,
      changedAt: b.uploadedAt ?? null,
      ageSec: b.uploadedAt ? Math.max(0, Math.round((now - b.uploadedAt) / 1000)) : null,
    });
    m.cands.set(b.outcomeId, list);
    boostedMarketIds.add(market.marketId);
  }

  const results = [];
  for (const { market, cands } of markets.values()) {
    const isBoosted = boostedMarketIds.has(market.marketId);
    if (!isBoosted && skipIntegerLines && market.outcomeIds.length === 2 && isWholeLine(market)) continue;
    const legs = [];
    let complete = true;
    for (const oid of market.outcomeIds) {
      const list = cands.get(oid);
      if (!list || !list.length) {
        complete = false;
        break;
      }
      const best = [...list].sort((a, b) => b.price - a.price || (a.ageSec ?? 1e9) - (b.ageSec ?? 1e9))[0];
      legs.push({ outcomeId: oid, selection: outcomeLabel(registry.get(oid), fixture), ...best });
    }
    if (!complete) {
      if (isBoosted) results.push({ market: describe(market), marketId: market.marketId, complete: false, boosted: true, legs: [] });
      continue;
    }
    // A same-book "arb" is a pricing error the book will void, not an opportunity.
    if (new Set(legs.map((l) => l.book)).size < 2) {
      if (!isBoosted) continue;
    }
    const sumInv = legs.reduce((s, l) => s + 1 / l.price, 0);
    for (const l of legs) l.share = 1 / l.price / sumInv;
    const capped = legs.filter((l) => l.limit > 0);
    const maxTotal = capped.length ? Math.min(...capped.map((l) => l.limit / l.share)) : null;
    const books = new Set(legs.map((l) => l.book.replace(" ★", "")));
    results.push({
      marketId: market.marketId,
      market: describe(market),
      marketType: market.marketType,
      complete: true,
      // Every leg at one book (e.g. Stake boosts on both sides): usually a multi-only
      // promo or a mistake the book will void — never treat it as a clean arb.
      sameBook: books.size < 2,
      profitPct: (1 / sumInv - 1) * 100,
      sumInv,
      boosted: legs.some((l) => l.boosted),
      boostedMarket: isBoosted,
      legs,
      maxTotal,
    });
  }
  return { results, skipped };
}

function isWholeLine(market) {
  const h = Number(market.handicap ?? 0);
  if (!["totals", "teamtotals-team1", "teamtotals-team2", "spreads"].includes(market.marketType)) return false;
  return Number.isInteger(h);
}

function describe(m) {
  const name = m.marketName || m.marketType;
  const line = m.handicap && Number(m.handicap) !== 0 ? ` ${Number(m.handicap) > 0 && m.marketType.startsWith("spread") ? "+" : ""}${m.handicap}` : "";
  const period = m.period && !["fulltime", "result"].includes(m.period) ? ` (${m.period})` : "";
  return `${name}${line}${period}`;
}

function outcomeLabel(market, fixture) {
  const n = String(market?.outcomeName ?? "");
  if (n === "1") return fixture?.home ?? "Home";
  if (n === "2") return fixture?.away ?? "Away";
  if (n === "X") return "Draw";
  if (/^(over|under)$/i.test(n)) return `${n} ${market.handicap}`;
  return n;
}

/** Stake split for a given total so every outcome returns the same amount. */
export function splitStakes(legs, total) {
  return legs.map((l) => ({ ...l, stake: Math.round(total * l.share * 100) / 100 }));
}

/** Build the outcomeId registry from a GET /markets response. */
export function buildRegistry(list) {
  const arr = Array.isArray(list) ? list : list?.markets ?? list?.data ?? [];
  const reg = new Map();
  for (const m of arr) {
    if (m.playerProp) continue;
    const outcomes = (m.outcomes ?? []).map((o) => ({ id: Number(o.outcomeId), name: String(o.outcomeName) }));
    if (outcomes.length < 2) continue;
    const outcomeIds = outcomes.map((o) => o.id);
    for (const o of outcomes) {
      reg.set(o.id, {
        marketId: Number(m.marketId),
        marketName: m.marketNameShort || m.marketName || m.marketType,
        marketType: m.marketType,
        period: m.period,
        handicap: Number(m.handicap ?? 0),
        outcomeName: o.name,
        outcomeIds,
      });
    }
  }
  return reg;
}
