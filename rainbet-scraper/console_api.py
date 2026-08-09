#!/usr/bin/env python3
"""Console protocol for Rainbet. Uses patchright (Cloudflare Turnstile)."""
import sys, os, json, hashlib
from patchright.sync_api import sync_playwright
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
    raise SystemExit(f"[rainbet] unknown league: {key}")


def match_id(match):
    seed = str(match.get("event_id") or match.get("link") or match["name"])
    return hashlib.sha1(seed.encode()).hexdigest()[:10]


def open_league(p, lg, feed):
    ctx = m._new_context(p)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    m.attach_feed_capture(page, feed)
    page.goto(f"{m.BASE.rstrip('/')}/{lg['path']}", wait_until="domcontentloaded")
    m._wait_cleared(page)
    page.wait_for_timeout(5000)
    return ctx, page


def list_matches(key):
    lg = find_league(key)
    feed = {"events": {}}
    with sync_playwright() as p:
        print(f"[rainbet] opening {lg['name']}", flush=True)
        ctx, page = open_league(p, lg, feed)
        found = m.scrape_matches(page)
        ctx.close()
    print(f"[rainbet] {len(found)} matches in {lg['name']}", flush=True)
    emit({
        "league": lg,
        "matches": [{"id": match_id(x), "name": x["name"], "link": x.get("link")} for x in found],
    })


def scrape_odds(out, key, wanted):
    lg = find_league(key)
    os.makedirs(out, exist_ok=True)
    feed = {"events": {}}
    saved = 0
    with sync_playwright() as p:
        ctx, page = open_league(p, lg, feed)
        found = m.scrape_matches(page)
        chosen = [x for x in found if not wanted or match_id(x) in wanted]
        print(f"[rainbet] scraping {len(chosen)} of {len(found)} matches", flush=True)
        for match in chosen:
            try:
                page.goto(match["link"], wait_until="domcontentloaded")
                m._wait_cleared(page)
                page.wait_for_timeout(4000)
                for _ in range(14):
                    m._safe(lambda: page.mouse.wheel(0, 1200))
                    page.wait_for_timeout(800)
                page.wait_for_timeout(1500)
                res = m.scrape_odds(page, match["event_id"], match["name"], feed["events"])
                if not res:
                    print(f"[rainbet] {match['name']}: no markets", flush=True)
                    continue
                markets, c1, c2 = res
                fn = os.path.join(out, f"{c1}_-_{c2}_odds_rainbet.json".replace(" ", "_").lower())
                json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
                saved += 1
                print(f"[rainbet] saved {os.path.basename(fn)}", flush=True)
            except Exception as e:
                print(f"[rainbet] {match['name']} failed: {e}", flush=True)
        ctx.close()
    print(f"[rainbet] done, {saved} file(s)", flush=True)
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
