import test from "node:test";
import assert from "node:assert/strict";
import { nameScore, splitMatch, findFixture, sideOf, sportIdFor } from "../lib/names.mjs";
import { buildRegistry, evaluateFixture, splitStakes } from "../lib/arb.mjs";
import { matchBoosted, winnerOutcome, cleanUpload } from "../lib/boosted.mjs";
import { normaliseLocal } from "../lib/scanner.mjs";
import { applySettings, envSettings } from "../lib/config.mjs";

const NBA = { fixtureId: "id1100000001", home: "Denver Nuggets", away: "Golden State Warriors", startTime: 2_000_000_000 };

const MARKETS_11 = [
  { marketId: 111, marketType: "moneyline", period: "result", handicap: 0, marketName: "Winner", outcomes: [{ outcomeId: 111, outcomeName: "1" }, { outcomeId: 112, outcomeName: "2" }] },
  { marketId: 1150, marketType: "totals", period: "result", handicap: 221.5, marketName: "Total", outcomes: [{ outcomeId: 1150, outcomeName: "Over" }, { outcomeId: 1151, outcomeName: "Under" }] },
  { marketId: 1160, marketType: "totals", period: "result", handicap: 222, marketName: "Total", outcomes: [{ outcomeId: 1160, outcomeName: "Over" }, { outcomeId: 1161, outcomeName: "Under" }] },
  { marketId: 1170, marketType: "players-points", period: "result", handicap: 25.5, playerProp: true, outcomes: [{ outcomeId: 1170, outcomeName: "Over" }, { outcomeId: 1171, outcomeName: "Under" }] },
];
const MARKETS_10 = [
  { marketId: 101, marketType: "1x2", period: "fulltime", handicap: 0, marketName: "Full Time Result", outcomes: [{ outcomeId: 101, outcomeName: "1" }, { outcomeId: 102, outcomeName: "X" }, { outcomeId: 103, outcomeName: "2" }] },
];
const reg11 = buildRegistry(MARKETS_11);
const reg10 = buildRegistry(MARKETS_10);
const row = (price, extra = {}) => ({ price, active: true, marketActive: true, changedAt: 1_000_000, ...extra });

test("names: aliases, accents, order, initials", () => {
  assert.equal(nameScore("Denver Nuggets", "Denver Nuggets"), 1);
  assert.ok(nameScore("Man Utd", "Manchester United") >= 0.99);
  assert.ok(nameScore("Beşiktaş", "Besiktas JK") >= 0.6);
  assert.ok(nameScore("Djokovic N.", "Novak Djokovic") >= 0.99);
  assert.ok(nameScore("Inter Miami", "Inter Milan") < 0.6);
  assert.ok(nameScore("Real Madrid", "Real Sociedad") < 0.6);
  assert.deepEqual(splitMatch("A FC vs B"), { home: "A FC", away: "B" });
  assert.equal(splitMatch("lonely"), null);
  // 3-way markets list the draw button between the teams
  assert.deepEqual(splitMatch("Galatasaray vs Draw vs Fenerbahce"), { home: "Galatasaray", away: "Fenerbahce" });
  assert.deepEqual(splitMatch("Galatasaray vs Beraberlik vs Fenerbahçe"), { home: "Galatasaray", away: "Fenerbahçe" });
  const hit = findFixture([{ ...NBA, fixtureId: "x", home: "Boston Celtics", away: "Miami Heat" }, NBA], "Golden State Warriors", "Denver Nuggets");
  assert.equal(hit.fixture.fixtureId, NBA.fixtureId);
  assert.equal(sideOf("Golden State Warriors", NBA), "2");
  assert.equal(sideOf("Beraberlik", NBA), "X");
  assert.equal(sideOf("Over 220.5", NBA), null);
  assert.equal(sportIdFor("Basketball"), 11);
});

test("registry skips player props and keeps complete outcome lists", () => {
  assert.equal(reg11.get(111).outcomeIds.length, 2);
  assert.equal(reg11.has(1170), false);
  assert.deepEqual(reg10.get(102).outcomeIds, [101, 102, 103]);
});

test("boosted price replaces stake's normal price and creates an arb", () => {
  const { results } = evaluateFixture({
    fixture: NBA,
    registry: reg11,
    books: ["stake", "pinnacle"],
    oddsByBook: {
      stake: { "f:stake:111:0": row(1.36), "f:stake:112:0": row(3.05) },
      pinnacle: { "f:pinnacle:111:0": row(1.5, { limit: 1000 }), "f:pinnacle:112:0": row(2.9, { limit: 1000 }) },
    },
    boosted: [{ outcomeId: 112, price: 3.81, oldPrice: 3.05, uploadedAt: 1_000_000 }],
    now: 1_060_000,
  });
  const ml = results.find((r) => r.marketId === 111);
  assert.ok(ml.complete && ml.boosted);
  const expected = (1 / (1 / 1.5 + 1 / 3.81) - 1) * 100;
  assert.ok(Math.abs(ml.profitPct - expected) < 1e-9);
  const boostLeg = ml.legs.find((l) => l.boosted);
  assert.equal(boostLeg.book, "stake ★");
  assert.equal(boostLeg.ageSec, 60);
  assert.equal(ml.legs.find((l) => !l.boosted).book, "pinnacle");
  // limit 1000 on the 1.5 leg (share ~0.72) caps the total at ~1390
  assert.ok(ml.maxTotal > 1300 && ml.maxTotal < 1450);
  assert.equal(ml.sameBook, false);
  // Boosts on both sides at Stake → flagged as one-book
  const both = evaluateFixture({
    fixture: NBA,
    registry: reg11,
    oddsByBook: { stake: { "f:stake:111:0": row(1.36), "f:stake:112:0": row(3.05) } },
    boosted: [{ outcomeId: 111, price: 1.7 }, { outcomeId: 112, price: 3.81 }],
  }).results.find((r) => r.marketId === 111);
  assert.equal(both.sameBook, true);
  assert.ok(both.profitPct > 17 && both.profitPct < 18);
  const split = splitStakes(ml.legs, 100);
  const returns = split.map((l) => l.stake * l.price);
  assert.ok(Math.abs(returns[0] - returns[1]) < 0.1 && returns[0] > 100);
});

test("ignores stale/suspended books, inactive rows, player props and same-book arbs", () => {
  const { results, skipped } = evaluateFixture({
    fixture: NBA,
    registry: reg11,
    oddsByBook: {
      a: { "f:a:111:0": row(9), "f:a:112:0": row(9) },
      b: { "f:b:111:0": row(9), "f:b:112:0": row(9) },
      c: { "f:c:111:0": row(2.2, { active: false }), "f:c:112:0": row(2.2), "f:c:111:77": row(50) },
      d: { "f:d:1150:0": row(2.2), "f:d:1151:0": row(2.2) },
    },
    bookMeta: { a: { staleOdds: true }, b: { suspended: true } },
  });
  assert.equal(skipped.length, 2);
  assert.equal(results.find((r) => r.marketId === 111), undefined); // outcome 111 has no valid price
  assert.equal(results.find((r) => r.marketId === 1150), undefined); // same-book "arb" dropped
});

test("whole-number lines are skipped by default (push risk), half lines kept", () => {
  const odds = {
    p: { "f:p:1160:0": row(2.1), "f:p:1161:0": row(1.8), "f:p:1150:0": row(2.1), "f:p:1151:0": row(1.8) },
    q: { "f:q:1160:0": row(1.8), "f:q:1161:0": row(2.1), "f:q:1150:0": row(1.8), "f:q:1151:0": row(2.1) },
  };
  const on = evaluateFixture({ fixture: NBA, registry: reg11, oddsByBook: odds }).results;
  assert.ok(on.some((r) => r.marketId === 1150 && r.profitPct > 0));
  assert.ok(!on.some((r) => r.marketId === 1160));
  const off = evaluateFixture({ fixture: NBA, registry: reg11, oddsByBook: odds, skipIntegerLines: false }).results;
  assert.ok(off.some((r) => r.marketId === 1160));
});

test("3-way market needs every outcome; boosted draw included", () => {
  const fx = { ...NBA, home: "Arsenal", away: "Chelsea" };
  const { results } = evaluateFixture({
    fixture: fx,
    registry: reg10,
    oddsByBook: { pinnacle: { "f:pinnacle:101:0": row(2.9), "f:pinnacle:102:0": row(3.6), "f:pinnacle:103:0": row(3.1) } },
    boosted: [{ outcomeId: 102, price: 4.5 }],
  });
  const r = results[0];
  assert.equal(r.legs.length, 3);
  assert.equal(r.legs.find((l) => l.selection === "Draw").price, 4.5);
  assert.ok(Math.abs(r.legs.reduce((s, l) => s + l.share, 0) - 1) < 1e-9);
});

test("boosted matching to fixtures and winner outcomes", () => {
  assert.equal(winnerOutcome(reg11, 11, "2"), 112);
  assert.equal(winnerOutcome(reg10, 10, "1"), 101);
  assert.equal(winnerOutcome(reg10, 10, "X"), 102);
  const items = cleanUpload({
    items: [
      { label: "Golden State Warriors", match: "Denver Nuggets vs Golden State Warriors", category: "basketball", oldOdds: 3.05, newOdds: 3.81 },
      { label: "Over 220.5", match: "Denver Nuggets vs Golden State Warriors", category: "basketball", newOdds: 2 },
      { label: "Combo", match: "", category: "home", newOdds: 5 },
      { label: "Lakers", match: "Lakers vs Suns", category: "basketball", newOdds: 2 },
      { label: "bad", match: "x vs y", newOdds: "nope" },
    ],
  });
  assert.equal(items.length, 4);
  const { matched, unmatched } = matchBoosted(items, new Map([[11, [NBA]]]), new Map([[11, reg11]]), { uploadedAt: 5 });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].outcomeId, 112);
  assert.equal(matched[0].uploadedAt, 5);
  assert.equal(unmatched.length, 3);
  assert.match(unmatched.map((u) => u.reason).join("|"), /not a match-winner/);
  assert.match(unmatched.map((u) => u.reason).join("|"), /multi/);
});

test("local scraper arbs are normalised from arb_finder --json", () => {
  const arbs = normaliseLocal({
    scrapedAt: Date.now() - 60_000,
    arbs: [
      { match: "Uruguay vs Spain", market: "Spain Total Goal Kicks", market_id: "goalkicks_t2", line: 5.5, over_book: "rainbet", over_odds: 2.24, under_book: "bson", under_odds: 1.93, profit_pct: 3.54 },
      { match: "x vs y", market: "m", line: 1.5, over_book: "a", over_odds: 1.5, under_book: "b", under_odds: 1.5 },
    ],
  });
  assert.equal(arbs.length, 1);
  assert.ok(Math.abs(arbs[0].profitPct - 3.6) < 0.1);
  assert.equal(arbs[0].source, "local");
  assert.equal(arbs[0].legs[0].book, "rainbet");
});

test("settings: env defaults and validated runtime edits", () => {
  const s = envSettings({ BOOKMAKERS: "Stake, Pinnacle", SPORTS: "10,11", MIN_PROFIT: "0.5" });
  assert.deepEqual(s.bookmakers, ["stake", "pinnacle"]);
  assert.deepEqual(s.sports, [10, 11]);
  const { settings, rejected } = applySettings(s, { minProfit: "2", bookmakers: "", evil: 1, windowHours: 99 });
  assert.equal(settings.minProfit, 2);
  assert.deepEqual(settings.bookmakers, ["stake", "pinnacle"]);
  assert.equal(settings.windowHours, 6);
  assert.deepEqual(rejected.sort(), ["bookmakers", "evil"]);
});
