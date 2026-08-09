#!/usr/bin/env python3
"""Console protocol for Betwinner. Leaves agent_run.py alone.

  python console_api.py leagues
  python console_api.py matches <league-key>
  python console_api.py odds <out-dir> <league-key> [id,id,...]

`leagues` and `matches` print one JSON object on the line after the marker
CONSOLE_JSON so progress chatter can share stdout.
"""
import sys, os, json, hashlib
from playwright.sync_api import sync_playwright
import main as m

MARKER = "CONSOLE_JSON"


def emit(obj):
    print(MARKER, flush=True)
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def league_key(name, path):
    return hashlib.sha1(path.encode()).hexdigest()[:8]


def leagues():
    return [{"key": league_key(n, p), "name": n, "path": p} for n, p in m.LEAGUES]


def find_league(key):
    for lg in leagues():
        if lg["key"] == key or lg["name"].lower() == key.lower():
            return lg
    raise SystemExit(f"[bwin] unknown league: {key}")


def match_id(match):
    return hashlib.sha1((match.get("link") or match["name"]).encode()).hexdigest()[:10]


def _page(p):
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    return browser, page


def list_matches(key):
    lg = find_league(key)
    with sync_playwright() as p:
        browser, page = _page(p)
        print(f"[bwin] opening {lg['name']}", flush=True)
        page.goto(f"{m.BASE.rstrip('/')}/{lg['path']}", wait_until="domcontentloaded")
        page.wait_for_timeout(9000)
        found = m.scrape_matches(page, lg["path"])
        browser.close()
    clean = [
        x for x in found
        if x.get("name") and " - " in x["name"] and x["name"].split(" - ")[-1].strip()
    ]
    print(f"[bwin] {len(clean)} matches in {lg['name']}", flush=True)
    emit({
        "league": lg,
        "matches": [{"id": match_id(x), "name": x["name"], "link": x.get("link")} for x in clean],
    })


def scrape_odds(out, key, wanted):
    lg = find_league(key)
    os.makedirs(out, exist_ok=True)
    with sync_playwright() as p:
        browser, page = _page(p)
        page.goto(f"{m.BASE.rstrip('/')}/{lg['path']}", wait_until="domcontentloaded")
        page.wait_for_timeout(9000)
        found = m.scrape_matches(page, lg["path"])
        chosen = [x for x in found if not wanted or match_id(x) in wanted]
        print(f"[bwin] scraping {len(chosen)} of {len(found)} matches", flush=True)
        saved = 0
        for match in chosen:
            try:
                page.goto(match["link"], wait_until="domcontentloaded")
                markets = m.scrape_odds_for_categories(page)
                if not markets:
                    print(f"[bwin] {match['name']}: no markets", flush=True)
                    continue
                fn = os.path.join(out, match["name"].replace(" ", "_").lower() + "_odds_bwin.json")
                json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
                saved += 1
                print(f"[bwin] saved {os.path.basename(fn)}", flush=True)
            except Exception as e:
                print(f"[bwin] {match['name']} failed: {e}", flush=True)
        browser.close()
    print(f"[bwin] done, {saved} file(s)", flush=True)
    return 0 if saved else 1


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: console_api.py leagues|matches|odds ...")
    cmd = sys.argv[1]
    if cmd == "leagues":
        emit({"leagues": leagues()})
    elif cmd == "matches":
        list_matches(sys.argv[2])
    elif cmd == "odds":
        ids = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else set()
        sys.exit(scrape_odds(sys.argv[2], sys.argv[3], ids))
    else:
        raise SystemExit(f"unknown command: {cmd}")


if __name__ == "__main__":
    main()
