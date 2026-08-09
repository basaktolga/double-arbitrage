"""Scrape ONE World Cup match from Bets10 by name (no event link needed).

Usage: python one_match.py "<out_dir>" "<name substring>"  e.g. "portugal"
Lists the WC schedule, finds the match whose name contains all given tokens,
then fetches odds for just that event via the widget API.
"""
import sys, os, json
from playwright.sync_api import sync_playwright
import main as m

OUT = sys.argv[1]
QUERY = " ".join(sys.argv[2:]).lower().split()
URL = f"{m.BASE}/world-cup/world-cup?tab=events"


def list_matches(page):
    page.wait_for_timeout(4000)
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
    return m.scrape_matches(page, "world-cup/world-cup")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = m._new_context(browser).new_page()
    hdr = {}
    m.capture_widget_headers(page, hdr)
    page.goto(URL, wait_until="domcontentloaded")
    matches = list_matches(page)
    hit = next((x for x in matches
                if all(t in x["name"].lower() for t in QUERY)), None)
    if not hit:
        print(f"[bson] no match for {QUERY}; have: {[x['name'] for x in matches]}")
        browser.close(); sys.exit(1)
    markets = m.scrape_odds_api(page, hit["event_id"], hdr)
    fn = os.path.join(OUT, hit["name"].replace(" ", "_").lower() + "_odds_bson.json")
    json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"[bson] {hit['name']}: {len(markets)} markets -> {os.path.basename(fn)}")
    browser.close()
