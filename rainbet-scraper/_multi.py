from patchright.sync_api import sync_playwright
import json
import main as m

WANT = [("Spain","Saudi"), ("Belgium","Iran"), ("Uruguay","Cape Verde"), ("New Zealand","Egypt")]
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
    print("matches available:", len(matches))
    for a, b in WANT:
        match = next((x for x in matches if a in x["name"] and b in x["name"]), None)
        if not match:
            print(f"  NOT FOUND: {a} {b}"); continue
        page.goto(match["link"], wait_until="domcontentloaded")
        m._wait_cleared(page)
        page.wait_for_timeout(4000)
        for _ in range(16):
            m._safe(lambda: page.mouse.wheel(0, 1200)); page.wait_for_timeout(900)
        page.wait_for_timeout(2000)
        res = m.scrape_odds(page, match["event_id"], match["name"], feed["events"])
        if not res:
            print(f"  no odds for {match['name']}"); continue
        markets, c1, c2 = res
        fn = f"{c1}_-_{c2}_odds_rainbet.json".replace(" ", "_").lower()
        json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        print(f"  saved {fn}  ({len(markets)} markets, teams {c1}/{c2})")
    ctx.close()
