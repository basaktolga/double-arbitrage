// A tiny local imitation of Stake's sports pages for testing the collector.
// The markup copies the data-testid structure seen on the real site (fixture-outcome
// buttons with multi-bet-original-odds / multi-bet-boosted-odds), comma decimals, and
// rows that only render as you scroll — the parts the collector depends on.

import http from "node:http";

const GAMES = {
  basketball: [
    ["Denver Nuggets", "Golden State Warriors", [["1,36", "1,70"], ["3,05", "3,81"]]],
    ["Boston Celtics", "Miami Heat", [[null, "1,55"], [null, "2,45"]]],
  ],
  soccer: [
    ["Galatasaray", "Fenerbahce", [["2,10", "2,60"], [null, "3,40"], [null, "3,10"]]],
    ...Array.from({ length: 30 }, (_, i) => [`Team A${i}`, `Team B${i}`, [[null, "2,00"], [null, "3,30"], [null, "3,60"]]]),
    ["Besiktas", "Trabzonspor", [[null, "1,90"], [null, "3,50"], ["3,90", "4,60"]]], // boosted row far down the page
  ],
};

function outcome(name, [oldOdds, newOdds]) {
  const odds = oldOdds
    ? `<span data-testid="multi-bet-original-odds" class="line-through">${oldOdds}</span>
       <div class="flex"><span data-testid="multi-bet-boosted-odds">${newOdds}</span><div role="img"><svg viewBox="0 0 10 10"></svg></div></div>`
    : `<span data-testid="fixture-odds">${newOdds}</span>`;
  return `<button aria-label="${name}" data-testid="fixture-outcome" class="outcome">
      <div class="outcome-content"><span data-testid="outcome-button-name">${name}</span>
      <div class="relative">${odds}</div></div></button>`;
}

function card([home, away, prices]) {
  const names = prices.length === 3 ? [home, "Draw", away] : [home, away];
  return `<div class="card" style="height:260px;border:1px solid #333;margin:8px">
    <div>${home}</div><div>${away}</div>
    <div class="outcomes">${names.map((n, i) => outcome(n, prices[i])).join("")}</div></div>`;
}

function sportsPage(category) {
  const games = GAMES[category] ?? [];
  // First 4 cards render immediately; the rest are appended as you scroll (lazy list).
  return `<!doctype html><html><head><title>Stake Sports</title>
  <style>body{background:#0f212e;color:#fff;font-family:sans-serif}</style></head><body>
  <div id="list">${games.slice(0, 4).map(card).join("")}</div>
  <script>
    const rest = ${JSON.stringify(games.slice(4).map(card))};
    addEventListener("scroll", () => {
      if (innerHeight + scrollY > document.body.scrollHeight - 300 && rest.length) {
        setTimeout(() => { document.getElementById("list").insertAdjacentHTML("beforeend", rest.splice(0, 4).join("")); }, 150);
      }
    });
  </script></body></html>`;
}

export function startFakeStake({ mode = "ok" } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push({ path: u.pathname, ua: req.headers["user-agent"] });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (mode === "challenge") {
      res.statusCode = 403;
      return res.end(`<!doctype html><title>Just a moment...</title><div id="challenge-running">Checking your browser</div>`);
    }
    if (mode === "geo") return res.end(`<!doctype html><title>Stake</title><p>Stake is not available in your region.</p>`);
    if (mode === "empty") return res.end(`<!doctype html><title>Maintenance</title><p>We'll be right back.</p>`);
    if (mode === "heavy") {
      // Allocates a lot of memory in the page so the memory watchdog has to step in.
      return res.end(`<!doctype html><title>Heavy</title><script>
        // Typed arrays live outside the JS heap limit, like images/video buffers do.
        window.hog = []; setInterval(() => { const a = new Float64Array(4e6); a.fill(Math.random()); window.hog.push(a); }, 100);
      </script>`);
    }
    if (mode === "slow") return; // never answers
    const m = u.pathname.match(/^\/sports\/([a-z0-9-]+)/);
    if (!m) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.end(sportsPage(m[1] === "home" ? "basketball" : m[1]));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() })),
  );
}
