// DEMO=1: a fake OddsPapi responder so the app (and tests) run without an API key.
// Prices are generated so a few markets are genuine arbs and most are not.

const TEAMS = {
  10: [["Galatasaray", "Fenerbahce"], ["Arsenal", "Chelsea"], ["Real Madrid", "Sevilla"], ["Inter", "Napoli"], ["Besiktas", "Trabzonspor"]],
  11: [["Denver Nuggets", "Golden State Warriors"], ["Boston Celtics", "Miami Heat"], ["Anadolu Efes", "Fenerbahce Beko"]],
  12: [["Novak Djokovic", "Carlos Alcaraz"], ["Iga Swiatek", "Aryna Sabalenka"]],
  17: [["Natus Vincere", "FaZe Clan"], ["Team Vitality", "G2 Esports"]],
};

const MARKETS = {
  10: [
    { marketId: 101, marketType: "1x2", period: "fulltime", handicap: 0, marketName: "Full Time Result", outcomes: [[101, "1"], [102, "X"], [103, "2"]] },
    { marketId: 1010, marketType: "totals", period: "fulltime", handicap: 2.5, marketName: "Over Under", outcomes: [[1010, "Over"], [1011, "Under"]] },
    { marketId: 104, marketType: "bothteamsscore", period: "fulltime", handicap: 0, marketName: "Both Teams To Score", outcomes: [[104, "Yes"], [105, "No"]] },
  ],
  11: [
    { marketId: 111, marketType: "moneyline", period: "result", handicap: 0, marketName: "Winner (incl. overtime)", outcomes: [[111, "1"], [112, "2"]] },
    { marketId: 1150, marketType: "totals", period: "result", handicap: 221.5, marketName: "Total Points", outcomes: [[1150, "Over"], [1151, "Under"]] },
  ],
  12: [{ marketId: 121, marketType: "moneyline", period: "result", handicap: 0, marketName: "Winner", outcomes: [[121, "1"], [122, "2"]] }],
  17: [{ marketId: 171, marketType: "moneyline", period: "result", handicap: 0, marketName: "Winner", outcomes: [[171, "1"], [172, "2"]] }],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fixturesFor(sportId, nowSec) {
  return (TEAMS[sportId] ?? []).map(([home, away], i) => ({
    fixtureId: `id${sportId}0000${String(i + 1).padStart(8, "0")}`,
    participants: { participant1Name: home, participant2Name: away },
    status: { statusId: 0 },
    startTime: nowSec + 3600 * (2 + i * 3),
    sport: { sportId },
    tournament: { tournamentName: sportId === 10 ? "Demo League" : "Demo Cup" },
    hasOdds: true,
  }));
}

function oddsFor(fixtureId, books) {
  const sportId = Number(fixtureId.slice(2, 4));
  const r = rng([...fixtureId].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7));
  const odds = {};
  const meta = {};
  for (const book of books) {
    odds[book] = {};
    meta[book] = { bookmaker: book, hasOdds: true, suspended: false, staleOdds: false };
  }
  // The first game of each sport gets realistic fixed probabilities on the winner
  // market so the demo boosts produce believable (small) edges.
  const FIXED = { 111: [0.7, 0.3], 101: [0.46, 0.28, 0.26] };
  const first = fixtureId.endsWith("00000001");
  for (const m of MARKETS[sportId] ?? []) {
    const n = m.outcomes.length;
    const fair = first && FIXED[m.marketId] ? [...FIXED[m.marketId]] : m.outcomes.map(() => 0.4 + r());
    const total = fair.reduce((a, b) => a + b, 0);
    m.outcomes.forEach(([oid], k) => {
      const p = fair[k] / total;
      books.forEach((book, bi) => {
        const margin = 1.04 + r() * 0.04;
        const noise = 1 + (r() - 0.5) * (n === 2 ? 0.12 : 0.09) * (bi === 1 ? 1.4 : 1);
        const price = Math.max(1.01, Math.round((1 / (p * margin)) * noise * 100) / 100);
        odds[book][`${fixtureId}:${book}:${oid}:0`] = {
          price,
          active: true,
          marketActive: true,
          limit: book === "pinnacle" ? 2000 : book === "stake" ? 500 : null,
          changedAt: Date.now() - Math.round(r() * 600_000),
        };
      });
    });
  }
  return { fixtureId, odds, bookmakers: meta };
}

/** fetch-compatible responder for https://v5.oddspapi.io */
export function demoFetch() {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/[a-z]{2}/, "");
    const q = Object.fromEntries(u.searchParams);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    const nowSec = Math.floor(Date.now() / 1000);
    if (path === "/bookmakers") {
      return json(["stake", "pinnacle", "bet365", "1xbet", "betfair-ex", "bc.game"].map((slug) => ({ slug, bookmakerName: slug, active: true })));
    }
    if (path === "/markets") {
      return json((MARKETS[Number(q.sportId)] ?? []).map((m) => ({
        ...m,
        marketLength: m.outcomes.length,
        playerProp: false,
        outcomes: m.outcomes.map(([outcomeId, outcomeName]) => ({ outcomeId, outcomeName })),
      })));
    }
    if (path === "/fixtures") return json(fixturesFor(Number(q.sportId), nowSec));
    const books = String(q.bookmakers ?? "stake,pinnacle").split(",").filter(Boolean);
    if (path === "/fixtures/odds/main") return json(String(q.fixtureIds ?? "").split(",").filter(Boolean).map((id) => oddsFor(id, books)));
    if (path === "/fixtures/odds") return json(oddsFor(q.fixtureId, books));
    return new Response(JSON.stringify({ error: 404, code: "not_found" }), { status: 404 });
  };
}

/** A boosted upload matching the demo fixtures. */
export function demoBoosted() {
  return {
    uploadedAt: Date.now() - 4 * 60_000,
    items: [
      { label: "Golden State Warriors", match: "Denver Nuggets vs Golden State Warriors", category: "basketball", oldOdds: 3.05, newOdds: 3.81, uplift: 24.9 },
      { label: "Denver Nuggets", match: "Denver Nuggets vs Golden State Warriors", category: "basketball", oldOdds: 1.36, newOdds: 1.7, uplift: 25 },
      { label: "Galatasaray", match: "Galatasaray vs Fenerbahce", category: "soccer", oldOdds: 2.1, newOdds: 2.6, uplift: 23.8 },
      { label: "Combo: 3 favourites", match: "", category: "home", oldOdds: 4.2, newOdds: 5.0, uplift: 19 },
    ],
  };
}
