# double-arbitrage

Finds two-way arbitrage opportunities across sportsbooks by scraping the same
match from several bookmakers and comparing over/under lines.

```
+3.54%  Uruguay vs Spain   Spain Total Goal Kicks  5.5
        over  2.24 @ rainbet   under 1.93 @ bson   stake 46.3/53.7
```

## Layout

| Path | What it is |
|---|---|
| `hosted/` | **Hosted arb finder** (Render) — Stake boosted odds + OddsPapi bookmakers + scraper results, phone UI, alerts, doctor. See `hosted/README.md` |
| `stake-userscript/` | Safari/Userscripts script that collects Stake's boosted odds and uploads them to the hosted app |
| `render.yaml` | Render Blueprint for `hosted/` |
| `console/` | Local web control panel — run scrapers, edit mirror URLs, browse matches and arbs |
| `<book>-scraper/` | One scraper per bookmaker (Playwright / patchright) |
| `json-2file-arbfinder/arb_finder.py` | Groups the scraped files from any number of books by match and computes the arbs |
| `json-2file-arbfinder/books.py` | Book registry + format adapters; documents the canonical format new scrapers should write |
| `domains/` | `find_domains.py` finds each book's current mirror and saves it (rules in `domains.json`) |
| `runner/run.py` | Always-on loop: domains → scrape → arbs → phone alerts. See `deploy/README.md` |
| `Dockerfile`, `docker-compose.yml` | Run runner + web app on any server |
| `json-2file-arbfinder/push_to_hosted.py` | Uploads the scrapers' arbs to the hosted app |

## Running it

```sh
node console/server.mjs      # → http://127.0.0.1:8790
```

Copy `console/providers.example.json` to `console/providers.json` first and set
the mirror URLs for the books you use. That file is gitignored because mirror
domains are personal and rotate constantly.

Each scraper needs its own virtualenv at `<book>-scraper/myenv` with playwright
(or patchright, for sites behind Cloudflare):

```sh
cd bwin-scraper && python3 -m venv myenv
./myenv/bin/pip install playwright && ./myenv/bin/playwright install chromium
```

See `console/README.md` for how the console, the two-phase league/match picker,
and the Claude-powered doctor and implementer agents work.

## Adding a website

1. Console → **Add book** (or copy `k9win-scraper/`). The scraper writes
   `<home>_-_<away>_odds_<book>.json` in the canonical format shown in
   `json-2file-arbfinder/books.py` (or copies an existing book's format).
2. If its domain rotates, add a rule to `domains/domains.json`.

That's all: the arb finder, the runner and the console pick it up automatically.

## Running it 24/7

`docker compose up -d` on any small Linux server. See `deploy/README.md` for which
server (Oracle Always Free works) and how to move it.

## Notes

- Bookmaker mirror domains change often. `python3 domains/find_domains.py --write`
  (or **Find current domains** in the console) finds the newest live mirror and saves it;
  the runner does this on its own every few cycles and whenever a book comes back empty.
  Run it from the machine that scrapes: a mirror blocked by your ISP can be fine from a server.
- Scraped odds JSON is not versioned; regenerate it with the console.
- Arbitrage windows close fast, and stale odds are worse than no odds. The
  console defaults to showing only data scraped today.
