"""Scrape ALL current World Cup matches on Rainbet -> write <match>_odds_rainbet.json
to the output dir given as argv[1]. Opens real Chrome (Cloudflare). Used by website/local_agent.py."""
import sys, os, json
from patchright.sync_api import sync_playwright
import main as m

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
url = f"{m.BASE}/{m.LEAGUES[0][1]}"
feed = {"events": {}}

with sync_playwright() as p:
    ctx = m._new_context(p)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    m.attach_feed_capture(page, feed)
    page.goto(url, wait_until="domcontentloaded")
    m._wait_cleared(page)
    page.wait_for_timeout(5000)
    matches = m.scrape_matches(page)
    print(f"[rainbet] {len(matches)} matches", flush=True)
    for match in matches:
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
                continue
            markets, c1, c2 = res
            fn = os.path.join(OUT, f"{c1}_-_{c2}_odds_rainbet.json".replace(" ", "_").lower())
            json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
            print(f"[rainbet] saved {os.path.basename(fn)}", flush=True)
        except Exception as e:
            print(f"[rainbet] {match['name']} failed: {e}", flush=True)
    ctx.close()
