#!/usr/bin/env python3
"""
Always-on loop: find domains -> scrape every enabled book -> find arbs -> alert.

    python3 runner/run.py            # forever, every RUN_INTERVAL_MIN minutes
    python3 runner/run.py --once     # one cycle (for cron / systemd timers / testing)

Reads the same console/providers.json as the local console, so a book added there
(or with "Add book") is scraped here too. Every setting is an environment variable
so the whole thing moves between servers by copying one .env file.

  RUN_INTERVAL_MIN     15     minutes between cycles
  SCRAPE_TIMEOUT_MIN   20     kill a scraper that runs longer than this
  DOMAIN_CHECK_EVERY   4      refresh mirror domains every N cycles (and whenever a book comes back empty)
  RUNNER_PYTHON        -      use this interpreter for every scraper (Docker); default = each book's own venv
  MIN_PROFIT           1      % threshold for alerts
  NTFY_TOPIC / NTFY_SERVER    push alerts via ntfy (https://ntfy.sh)
  ARB_FINDER_URL / ARB_FINDER_UPLOAD_KEY   also upload arbs to the hosted app
  DATA_DIR             <repo>/data   where odds files, logs and state live
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "json-2file-arbfinder"))
sys.path.insert(0, str(REPO / "domains"))
from arb_finder import collect  # noqa: E402
import find_domains  # noqa: E402

ENV = os.environ.get
DATA = Path(ENV("DATA_DIR", REPO / "data"))
ODDS = DATA / "odds"
STATE = DATA / "state.json"
INTERVAL = float(ENV("RUN_INTERVAL_MIN", "15"))
SCRAPE_TIMEOUT = float(ENV("SCRAPE_TIMEOUT_MIN", "20")) * 60
DOMAIN_EVERY = int(ENV("DOMAIN_CHECK_EVERY", "4"))
MIN_PROFIT = float(ENV("MIN_PROFIT", "1"))


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {"cycle": 0, "alerted": {}}


def providers():
    path = find_domains.PROVIDERS if find_domains.PROVIDERS.exists() else find_domains.PROVIDERS_EXAMPLE
    return json.loads(path.read_text())["providers"]


def refresh_domains(books=None):
    try:
        results = find_domains.resolve(books)
        find_domains.save(results)
        for b, r in results.items():
            log(f"domains: {b}: {'ok' if r['ok'] else 'FAIL'} {r['detail']}")
    except Exception as e:
        log(f"domains: error {e}")


def scrape(p, out):
    """Run one book's runner into `out`. Returns number of files written."""
    cwd = REPO / p["dir"]
    python = ENV("RUNNER_PYTHON") or str((cwd / p["python"]).resolve())
    runner = cwd / p["runner"]
    if not runner.exists():
        log(f"{p['id']}: no runner, skipped")
        return 0
    before = set(out.glob(f"*_odds_{p['id']}.json"))
    try:
        r = subprocess.run([python, p["runner"], str(out)], cwd=cwd, timeout=SCRAPE_TIMEOUT,
                           env={**os.environ, **p.get("urls", {}), "PYTHONUNBUFFERED": "1"},
                           capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        status = f"exit {r.returncode}" + (f" | {' / '.join(tail)}" if r.returncode else "")
    except subprocess.TimeoutExpired:
        status = "timeout"
    n = len(set(out.glob(f"*_odds_{p['id']}.json")) - before)
    log(f"{p['id']}: {n} files, {status}")
    return n


def alert(arbs, state):
    topic = ENV("NTFY_TOPIC")
    fresh = []
    for a in arbs:
        if a["profit_pct"] < MIN_PROFIT:
            continue
        key = f"{a['match']}|{a['market_id']}|{a['line']}|{a['over_book']}|{a['under_book']}"
        if state["alerted"].get(key, 0) >= a["profit_pct"]:
            continue
        state["alerted"][key] = a["profit_pct"]
        fresh.append(a)
    if not fresh or not topic:
        return len(fresh)
    body = "\n\n".join(
        f"+{a['profit_pct']:.2f}% {a['match']}\n{a['market']} {a['line']}\n"
        f"Over {a['over_odds']} @ {a['over_book']} ({a['stake_over_pct']}%) / "
        f"Under {a['under_odds']} @ {a['under_book']} ({a['stake_under_pct']}%)" for a in fresh[:10])
    req = urllib.request.Request(f"{ENV('NTFY_SERVER', 'https://ntfy.sh').rstrip('/')}/{topic}",
                                 data=body.encode(), method="POST",
                                 headers={"Title": f"{len(fresh)} new arb(s)", "Tags": "moneybag"})
    try:
        urllib.request.urlopen(req, timeout=20).close()
    except Exception as e:
        log(f"ntfy failed: {e}")
    return len(fresh)


def upload(arbs, counts, groups, scraped_at):
    url, key = ENV("ARB_FINDER_URL", "").rstrip("/"), ENV("ARB_FINDER_UPLOAD_KEY")
    if not url or not key:
        return
    body = json.dumps({"scrapedAt": int(scraped_at * 1000), "counts": counts,
                       "groups": len(groups), "arbs": arbs}).encode()
    req = urllib.request.Request(f"{url}/api/local/upload", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Upload-Key": key})
    try:
        urllib.request.urlopen(req, timeout=90).close()
        log(f"uploaded {len(arbs)} arbs to {url}")
    except Exception as e:
        log(f"upload failed: {e}")


def cycle(state):
    state["cycle"] += 1
    if DOMAIN_EVERY and state["cycle"] % DOMAIN_EVERY == 1:
        refresh_domains()

    # Scrape into a fresh folder so odds from a previous cycle never mix in.
    work = DATA / "odds.next"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    started = time.time()
    empty = []
    for p in providers():
        if p.get("enabled", True) and scrape(p, work) == 0:
            empty.append(p["id"])
    if empty:  # empty usually means the mirror moved: re-resolve and retry once
        refresh_domains(empty)
        for p in providers():
            if p["id"] in empty:
                scrape(p, work)

    shutil.rmtree(ODDS, ignore_errors=True)
    work.rename(ODDS)
    paths = sorted(ODDS.glob("*.json"))
    arbs, groups, counts, _ = collect(paths)
    (DATA / "arbs.json").write_text(json.dumps({"at": started, "counts": counts, "arbs": arbs}, indent=1))
    sent = alert(arbs, state)
    upload(arbs, counts, groups, started)
    log(f"cycle {state['cycle']}: {len(paths)} files, {len(groups)} matches, {len(arbs)} arbs, {sent} new alerts")
    # forget alerts older than the current slate so the state file stays small
    live = {f"{a['match']}|{a['market_id']}|{a['line']}|{a['over_book']}|{a['under_book']}" for a in arbs}
    state["alerted"] = {k: v for k, v in state["alerted"].items() if k in live}


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    once = "--once" in sys.argv
    while True:
        state = load_state()
        t0 = time.time()
        try:
            cycle(state)
        except Exception as e:
            log(f"cycle failed: {e!r}")
        STATE.write_text(json.dumps(state))
        if once:
            return
        time.sleep(max(30, INTERVAL * 60 - (time.time() - t0)))


if __name__ == "__main__":
    main()
