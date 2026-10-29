// Stake boosted odds: uploaded by the userscript from the user's own browser,
// matched here to OddsPapi pre-match fixtures and outcome ids.

import { splitMatch, findFixture, sideOf, sportIdFor } from "./names.mjs";

// Sports where Stake's headline market is the 3-way regulation result.
const THREE_WAY_SPORTS = new Set([10, 15, 22, 26, 29]);

/** Clean an upload body into a list of boosted items. */
export function cleanUpload(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.slice(0, 3000).map((i) => ({
    label: String(i.label ?? "").slice(0, 200),
    match: String(i.match ?? "").slice(0, 300),
    category: String(i.category ?? "").slice(0, 60),
    oldOdds: i.oldOdds != null && Number(i.oldOdds) > 1 ? Number(i.oldOdds) : null,
    newOdds: Number(i.newOdds),
    uplift: i.uplift != null ? Number(i.uplift) : null,
  })).filter((i) => i.newOdds > 1);
}

/** Sports we need fixtures for so boosted items can be matched. */
export function boostedSports(items) {
  const s = new Set();
  for (const i of items) {
    const id = sportIdFor(i.category);
    if (id) s.add(id);
  }
  return s;
}

/** Find the headline winner market outcome for a side ("1"/"X"/"2"). */
export function winnerOutcome(registry, sportId, side) {
  const markets = new Map();
  for (const [oid, m] of registry) {
    if (m.handicap !== 0) continue;
    if (!["1x2", "moneyline"].includes(m.marketType)) continue;
    if (!markets.has(m.marketId)) markets.set(m.marketId, { m, outcomes: {} });
    markets.get(m.marketId).outcomes[m.outcomeName.toUpperCase()] = oid;
  }
  const want = side === "X" || THREE_WAY_SPORTS.has(sportId)
    ? [["1x2", "fulltime"], ["1x2", "result"]]
    : [["moneyline", "result"], ["moneyline", "fulltime"], ["1x2", "result"], ["1x2", "fulltime"]];
  for (const [type, period] of want) {
    for (const { m, outcomes } of markets.values()) {
      if (m.marketType === type && m.period === period && outcomes[side]) return outcomes[side];
    }
  }
  return null;
}

/**
 * items: cleaned upload. fixturesBySport: Map<sportId, fixture[]>. registries: Map<sportId, registry>.
 * Returns { matched: [{ fixtureId, sportId, outcomeId, price, oldPrice, item }], unmatched: [{ item, reason }] }
 */
export function matchBoosted(items, fixturesBySport, registries, { uploadedAt } = {}) {
  const matched = [];
  const unmatched = [];
  for (const item of items) {
    const pair = splitMatch(item.match);
    if (!pair) {
      unmatched.push({ item, reason: "no match name (probably a boosted multi / bet builder)" });
      continue;
    }
    const sid = sportIdFor(item.category);
    const pool = sid ? [sid] : [...fixturesBySport.keys()];
    let best = null;
    let bestSport = null;
    for (const s of pool) {
      const hit = findFixture(fixturesBySport.get(s) ?? [], pair.home, pair.away);
      if (hit && (!best || hit.score > best.score)) {
        best = hit;
        bestSport = s;
      }
    }
    if (!best) {
      unmatched.push({ item, reason: sid ? "no upcoming pre-match fixture found (live, finished or not covered)" : `unknown sport "${item.category}" and no fixture matched` });
      continue;
    }
    const side = sideOf(item.label, best.fixture);
    if (!side) {
      unmatched.push({ item, reason: "not a match-winner selection (other markets are not compared yet)" });
      continue;
    }
    const reg = registries.get(bestSport);
    const outcomeId = reg ? winnerOutcome(reg, bestSport, side) : null;
    if (!outcomeId) {
      unmatched.push({ item, reason: "no winner market in the OddsPapi registry for this sport" });
      continue;
    }
    matched.push({
      fixtureId: best.fixture.fixtureId,
      sportId: bestSport,
      outcomeId,
      side,
      price: item.newOdds,
      oldPrice: item.oldOdds,
      uploadedAt,
      item,
      fixture: best.fixture,
    });
  }
  return { matched, unmatched };
}
