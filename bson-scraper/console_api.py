#!/usr/bin/env python3
"""Console protocol for Bets10 (bson). See bwin-scraper/console_api.py."""
import sys, os, json, hashlib
from playwright.sync_api import sync_playwright
import main as m

MARKER = "CONSOLE_JSON"


def emit(obj):
    print(MARKER, flush=True)
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def leagues():
    return [
        {"key": hashlib.sha1(p.encode()).hexdigest()[:8], "name": n, "path": p}
        for n, p in m.LEAGUES
    ]


def find_league(key):
    for lg in leagues():
        if lg["key"] == key or lg["name"].lower() == key.lower():
            return lg
    raise SystemExit(f"[bson] unknown league: {key}")


def match_id(match):
    seed = str(match.get("event_id") or match.get("link") or match["name"])
    return hashlib.sha1(seed.encode()).hexdigest()[:10]


def open_league(p, lg, headers):
    browser = p.chromium.launch(headless=True)
    page = m._new_context(browser).new_page()
    m.capture_widget_headers(page, headers)
    url = f"{m.BASE.rstrip('/')}/{lg['path']}?tab=events"
    page.goto(url, wait_until="domcontentloaded")
    # The schedule lazy-loads: expand every date accordion and scroll, or most
    # rows never render.
    for _ in range(4):
        page.wait_for_timeout(3500)
        m.dismiss_overlays(page)
        for _ in range(8):
            btns = page.locator("[test-id='accordion-item-toggle-button']")
            for i in range(btns.count()):
                try:
                    btns.nth(i).click(force=True)
                except Exception:
                    pass
            page.mouse.wheel(0, 4000)
            page.wait_for_timeout(1200)
        found = m.scrape_matches(page, lg["path"])
        if found:
            return browser, page, found
        page.goto(url, wait_until="domcontentloaded")
    return browser, page, []


def list_matches(key):
    lg = find_league(key)
    headers = {}
    with sync_playwright() as p:
        print(f"[bson] opening {lg['name']}", flush=True)
        browser, _page, found = open_league(p, lg, headers)
        browser.close()
    print(f"[bson] {len(found)} matches in {lg['name']}", flush=True)
    emit({
        "league": lg,
        "matches": [{"id": match_id(x), "name": x["name"], "link": x.get("link")} for x in found],
    })


def scrape_odds(out, key, wanted):
    lg = find_league(key)
    os.makedirs(out, exist_ok=True)
    headers = {}
    saved = 0
    with sync_playwright() as p:
        browser, page, found = open_league(p, lg, headers)
        chosen = [x for x in found if not wanted or match_id(x) in wanted]
        print(f"[bson] scraping {len(chosen)} of {len(found)} matches", flush=True)
        for match in chosen:
            try:
                markets = m.scrape_odds_api(page, match["event_id"], headers)
                if not markets:
                    print(f"[bson] {match['name']}: no markets", flush=True)
                    continue
                fn = os.path.join(out, match["name"].replace(" ", "_").lower() + "_odds_bson.json")
                json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
                saved += 1
                print(f"[bson] saved {os.path.basename(fn)}", flush=True)
            except Exception as e:
                print(f"[bson] {match['name']} failed: {e}", flush=True)
        browser.close()
    print(f"[bson] done, {saved} file(s)", flush=True)
    return 0 if saved else 1


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "leagues":
        emit({"leagues": leagues()})
    elif cmd == "matches":
        list_matches(sys.argv[2])
    elif cmd == "odds":
        ids = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else set()
        sys.exit(scrape_odds(sys.argv[2], sys.argv[3], ids))
    else:
        raise SystemExit("usage: console_api.py leagues|matches|odds ...")


if __name__ == "__main__":
    main()
