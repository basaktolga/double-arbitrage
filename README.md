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
| `console/` | Local web control panel — run scrapers, edit mirror URLs, browse matches and arbs |
| `<book>-scraper/` | One scraper per bookmaker (Playwright / patchright) |
| `json-2file-arbfinder/arb_finder.py` | Pairs the scraped files by match and computes the arbs |

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

## Notes

- Bookmaker mirror domains change often. When a book returns nothing, update its
  URL in the console — no code change needed.
- Scraped odds JSON is not versioned; regenerate it with the console.
- Arbitrage windows close fast, and stale odds are worse than no odds. The
  console defaults to showing only data scraped today.
