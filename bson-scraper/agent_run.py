"""Scrape ALL current World Cup matches on Bets10 -> write <match>_odds_bson.json
to the output dir given as argv[1]. Used by website/local_agent.py."""
import sys, os, json
from playwright.sync_api import sync_playwright
import main as m

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
path = "world-cup/world-cup"
url = f"{m.BASE}/{path}?tab=events"


def get_matches(page):
    for _ in range(4):
        page.wait_for_timeout(3500)
        m.dismiss_overlays(page)
        # Expand every date accordion AND scroll to lazy-load all matches —
        # the WC schedule spans several days and only near-term rows render
        # until you scroll, so without this we miss most matches.
        for _ in range(8):
            btns = page.locator("[test-id='accordion-item-toggle-button']")
            for i in range(btns.count()):
                try:
                    btns.nth(i).click(force=True)
                except Exception:
                    pass
            page.mouse.wheel(0, 4000)
            page.wait_for_timeout(1200)
        ms = m.scrape_matches(page, path)
        if ms:
            return ms
        page.goto(url, wait_until="domcontentloaded")
    return []


api_headers = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = m._new_context(browser).new_page()
    m.capture_widget_headers(page, api_headers)
    page.goto(url, wait_until="domcontentloaded")
    matches = get_matches(page)
    print(f"[bson] {len(matches)} matches", flush=True)
    for match in matches:
        try:
            markets = m.scrape_odds_api(page, match["event_id"], api_headers)
            if not markets:
                continue
            fn = os.path.join(OUT, match["name"].replace(" ", "_").lower() + "_odds_bson.json")
            json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
            print(f"[bson] saved {os.path.basename(fn)}", flush=True)
        except Exception as e:
            print(f"[bson] {match['name']} failed: {e}", flush=True)
    browser.close()
