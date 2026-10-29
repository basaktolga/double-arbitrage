# Arb Finder (hosted)

A web app you open on your phone: tap **Scan**, close it, come back a few minutes
later and the arbs are there. Built to run on Render's free plan.

It combines three sources into one list of arbitrage opportunities:

| Source | How it gets in | What it covers |
|---|---|---|
| **OddsPapi** | The server calls the API | Pre-match odds from the bookmakers you list (Pinnacle, Bet365, 1xBet, Stake…) on every main market: winner, 1X2, totals, handicaps, BTTS, draw-no-bet |
| **Stake boosted odds** | Collected **on the server** by a headless browser (the phone userscript in `stake-userscript/` still works as a backup) | Stake's boosted prices, swapped in for Stake's normal price on that outcome |
| **Local scrapers** | `json-2file-arbfinder/push_to_hosted.py` uploads from your PC | The niche over/under markets (corners, fouls, throw-ins…) the existing scrapers find |

Pre-match only: anything already live, or starting within `MIN_LEAD_MINUTES`, is skipped.
You place every bet by hand.

## How the arb check works

OddsPapi gives every market a `marketId` whose outcomes form one complete set
(both sides of one exact line, or 1/X/2). For each market the app takes the best
price per outcome across your books; if `Σ 1/price < 1` it's an arb. That one rule
covers 2-way and 3-way markets alike, and never mixes "incl. overtime" with
"regulation" or 2.5 with 3.5, because those are different `marketId`s.

Filters applied before anything is shown:

- prices from books OddsPapi flags `staleOdds`, `suspended` or `participantsRotated` are dropped
- inactive selections / closed markets are dropped
- player props are ignored
- whole-number totals and handicaps are skipped by default (push rules differ by book)
- an "arb" with every leg at one normal book is dropped (that's a pricing error)
- Stake boosts on both sides of a game are kept but flagged **ONE BOOK** and never
  alerted: they're usually multi-only promos or will be voided

Each leg shows its price age and, where the book publishes one, its stake limit;
the card shows the largest total the limits allow.

## Stake collector (server-side)

At the start of a scan, if the last collection is older than `STAKE_COLLECT_EVERY_MIN`
(default 30), the server reads Stake's boosted odds itself. It's slow on purpose so it
fits in the free plan's 512 MB and never takes the app down:

- It runs in **its own process** (`collector-worker.mjs`). The web server only ever gets
  a result back; a browser crash can't crash the server.
- **One page at a time** (`STAKE_CATEGORIES`), a pause between pages, and the browser
  is restarted every 3 pages so memory can't build up. Images, video and fonts aren't
  downloaded.
- A **watchdog** measures the browser's memory every second and kills the whole browser
  if it goes over `STAKE_COLLECTOR_MAX_MB` (default 400) or if the container is >92% full.
  The same happens if a run takes longer than `STAKE_COLLECTOR_TIMEOUT_MIN` (default 8).
  Boosts read before the stop are kept.
- Failures back off (up to 2 h) instead of retrying in a loop.

It identifies itself honestly as a headless browser and **does not try to get past bot
checks or region blocks**. If Stake shows a challenge or a "not available in your
region" page, the collector reports it in **Sources**, waits 3 h before trying again,
and you can keep using the phone userscript for boosts. Set `STAKE_URL` only to an
address you're allowed to use.

## Keep-alive windows (free plan)

Render's free plan sleeps a service after ~15 min without traffic. Tapping **Scan**
opens a window (default 2 h). During the window the server pings its own URL every
10 min and rescans every `SCAN_INTERVAL_MIN`. When the window ends it stops pinging
and Render puts it to sleep. Opening the page again (or a userscript upload) wakes
it; the first load after sleeping takes about a minute.

Consequences: no scans or alerts while asleep, and the in-memory results and
settings reset when it sleeps. Check Render's current free-plan terms before relying
on keep-alive pings.

## Deploy on Render (from a phone)

1. **OddsPapi key** — sign up at oddspapi.io and copy your API key.
2. **Render** — dashboard → **New → Blueprint** → connect GitHub → pick this repo
   (and this branch until it's merged). Render reads `render.yaml` and builds the
   Docker image (it includes Chromium, so the first build takes a few minutes).
3. Fill in the values it asks for:
   - `APP_PASSWORD` — the page password
   - `ODDSPAPI_KEY`
   - `NTFY_TOPIC` — optional; a long random name, then subscribe to it in the ntfy app
   - `ANTHROPIC_API_KEY` — optional; turns on the AI doctor
   - `UPLOAD_KEY` is generated for you; copy it from the service's Environment tab
4. Open `https://<your-service>.onrender.com`, enter the password, tap **Scan**.
5. Check **Sources → Stake collector** after the first scan. If it says the server was
   blocked, use the backup: put `stake-userscript/boosted-odds.user.js` in your
   Userscripts folder, open Stake, tap ⚡ → **Cloud setup**, enter the Render URL and
   `UPLOAD_KEY`, then **Scan ALL categories**.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | — | Required. Page/API password |
| `ODDSPAPI_KEY` | — | Required for real data |
| `UPLOAD_KEY` | `APP_PASSWORD` | Key for userscript and local uploads |
| `BOOKMAKERS` | `stake,pinnacle,bet365,1xbet` | OddsPapi slugs of books you can bet with |
| `SPORTS` | `10,11,12,17` | OddsPapi sport ids |
| `STAKE_SLUG` | `stake` | Stake's slug in OddsPapi |
| `MIN_PROFIT` | `1` | Minimum % for push alerts |
| `LOOKAHEAD_HOURS` | `48` | How far ahead to look |
| `MIN_LEAD_MINUTES` | `10` | Skip events starting sooner than this |
| `MAX_FIXTURES_PER_SPORT` | `150` | Soonest N fixtures priced per sport |
| `MARKET_TYPES` | winner, 1x2, totals, spreads, … | OddsPapi market types to compare |
| `SKIP_INTEGER_LINES` | `1` | `0` to include whole-number lines |
| `BOOSTED_MAX_AGE_MIN` | `45` | Boosted data older than this is marked stale; no boosted alerts |
| `WINDOW_HOURS` | `2` | Keep-alive window length |
| `SCAN_INTERVAL_MIN` | `10` | Rescan interval inside a window |
| `NTFY_TOPIC` / `NTFY_SERVER` | — / ntfy.sh | Push alerts |
| `ALERT_BOOSTED_ONLY` | `0` | `1` to alert only on arbs with a boosted leg |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-sonnet-5-5` | AI doctor |
| `STAKE_COLLECTOR` | `1` (`0` in demo) | `0` to turn the server collector off |
| `STAKE_URL` | `https://stake.com` | Stake address the server reads |
| `STAKE_CATEGORIES` | `home,soccer,basketball,tennis,ice-hockey,esports` | Sports pages to read |
| `STAKE_COLLECT_EVERY_MIN` | `30` | How often to collect (inside a keep-alive window) |
| `STAKE_COLLECTOR_MAX_MB` | `400` | Browser memory cap |
| `STAKE_COLLECTOR_TIMEOUT_MIN` | `8` | Max length of one collection run |
| `DEMO` | `0` | `1` = fake odds, password `demo` |

Settings changed in the app last until the server sleeps; put permanent values here.

## The doctor

**Sources** runs rule checks on every source (bad or missing key, rate limits,
unknown bookmaker slugs, books returning nothing, stale or empty Stake uploads, boosts
that couldn't be matched, old scraper data, keep-alive problems). **Diagnose** sends
that snapshot — never your keys — to Claude and shows a DIAGNOSIS / ACTION NEEDED
report, same style as the local console's doctor. The hosted doctor only reads; the
local console's doctor is still the one that edits scraper code.

## Run locally

```sh
cd hosted
DEMO=1 node server.mjs          # http://localhost:10000, password: demo
npm install && npm test         # collector tests need Playwright + Chromium; they skip otherwise
```

## Adding bookmakers

Any book OddsPapi carries is one slug away — add it to `BOOKMAKERS` (or in Settings).
The **Sources** tab tells you if a slug is unknown to your key or never returns prices.
