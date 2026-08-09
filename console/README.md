# Arb Console

Local control panel for the double-arbitrage scrapers. Zero dependencies — plain
Node and a vanilla frontend, no build step.

```sh
node console/server.mjs      # → http://127.0.0.1:8790
```

Loopback only, by design: it spawns processes and rewrites config, so it must
never be reachable from the network.

## What each screen does

**Books** — one card per bookmaker. Edit the URL and hit *Save URLs*; the console
passes it to the scraper as an environment variable at launch, so **mirror domains
can be changed without touching any Python**. Scrape one book or all enabled ones,
and stop a run mid-flight (the whole browser process group is killed, not just the
parent). Each card shows its last result and whether its venv and runner exist.

**Matches** — every odds file grouped by match, with a pill per book showing who
has data. A match needs two or more books before it can produce an arb, so this is
where you see coverage gaps.

Both Matches and Arbs default to a **Today** tab. Anything scraped on an earlier
calendar day is tagged `old` and moved to **Older** (with **All** if you want
everything at once). Freshness is calendar-based, so data scraped at 23:50 reads
as "yesterday" at 00:10 — which is how you'd actually think about it. Odds
scraped today are the only ones worth acting on, so they're what you see first.

**Arbs** — runs `arb_finder.py --json` and renders the results sorted by profit.
Strong (≥1.5%) is green, thin (<0.5%) amber. Each row shows both legs, their books,
the stake split, and how old the underlying odds are. An arb inherits the age of
the files it came from, and viewing the Older tab shows a warning banner — a 30%
arb on month-old odds is a fiction, not an opportunity.

**Add book** — scaffolds `<id>-scraper/agent_run.py` from a template and registers
it in `providers.json`. You implement the fetching; the console handles launching,
progress streaming, and feeding the finder.

**The console drawer** (bottom bar, click to expand) streams stdout and stderr live
over SSE while scrapers run. stderr is red, so a Playwright traceback is visible
without digging through a terminal.

## Run statuses

| Status | Meaning |
|---|---|
| `done` | Exited cleanly and saved at least one file |
| `empty` | Exited cleanly but saved **nothing** — almost always a dead mirror domain |
| `failed` | Non-zero exit; the traceback is in the drawer |
| `cancelled` | You stopped it |

`empty` exists because a scraper pointed at a dead domain often exits 0 having
found nothing, which would otherwise look like success.

## Changes made to the existing project

Two additive edits, both backward compatible:

1. **`arb_finder.py` gained a `--json` flag.** Without it, the human-readable
   report is byte-for-byte what it always was. With it, one JSON object with
   `scanned`, `counts`, `groups`, `skipped`, and `arbs`.
2. **Each scraper's URL constants read from the environment**, falling back to
   the exact value that was hardcoded before:
   ```python
   BASE = os.environ.get("BWIN_BASE", "https://betwinner-52364.pro")
   ```
   Running the scrapers directly still behaves identically.

| Book | Environment variables |
|---|---|
| bwin | `BWIN_BASE` |
| bson | `BSON_BASE`, `BSON_API_ORIGIN` |
| rainbet | `RAINBET_BASE`, `RAINBET_API` |
| betsolutions | `BETSOLUTIONS_URL`, `BETSOLUTIONS_ORIGIN` |
| exonbet | `EXONBET_LIST_URL` |

## Known state of the books

At the time this was built, **the Betwinner mirror (`betwinner-52364.pro`) was
dead** — `Page.goto` times out. That is precisely what the URL fields are for:
find the current mirror, paste it into `BWIN_BASE`, save, and scrape again.

The odds data currently in `json-2file-arbfinder/` is from late June, so the arbs
listed are historical. They exercise the whole pipeline honestly, but don't bet
from them — rescrape first.

## Config

`console/providers.json` holds everything: each book's directory, python
interpreter, runner script, URLs, and enabled flag. The console rewrites this file
when you save, so hand-edits and UI edits are interchangeable.

`outputDir` controls where scraped JSON lands (default `json-2file-arbfinder`, so
the finder picks it up with no arguments).

## Scraping: league → matches → odds

Scrape opens a two-step picker instead of running blind:

1. **Choose a league.** The list comes from that book's own `LEAGUES` in its
   `main.py` — the console never invents a path, because names and URLs differ
   per book and per league.
2. **Choose matches.** The console opens the site, reads the *real* match names
   for that league, and shows them as a checklist. Only what you tick gets its
   odds scraped.

This is driven by `console_api.py` in each scraper directory, which implements:

```
python console_api.py leagues
python console_api.py matches <league-key>
python console_api.py odds <out-dir> <league-key> [id,id,...]
```

`agent_run.py` is untouched, so `website/local_agent.py` keeps working. A book
with no `console_api.py` still runs in legacy mode (whole slate, no picker).

## The agents

Both run **Claude Sonnet** via the Claude Code CLI, edit only inside the book's
own directory, and stream their reasoning to the drawer.

**Doctor** — click *Doctor* on any card, or let it fire automatically when a
scrape fails or comes back empty. It reads the scraper, checks the URL with
`curl`, and either fixes the code or tells you what it needs. It is instructed
never to guess a replacement mirror domain. Its report appears on the card:

```
DIAGNOSIS: ...
FIXED: yes|no
ACTION NEEDED: ... | none
```

A report needing you is marked with an amber bar and "Doctor needs you".

**Implementer** — the first time you press Scrape on a book that has no scraper
yet (one added via *Add book*), the agent writes its `console_api.py` instead of
running it: it inspects the live site, copies the output format from the existing
books, and implements the same three subcommands. Books that already work are
never touched.

Requires the `claude` CLI on PATH. Without it, both agents report that clearly
rather than failing silently.
