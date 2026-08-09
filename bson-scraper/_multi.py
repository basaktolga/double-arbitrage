import json, re
from playwright.sync_api import sync_playwright
import main as m

WANT = [("Spain","Saudi"), ("Belgium","Iran"), ("Uruguay","Cape Verde"), ("New Zealand","Egypt")]
path = "world-cup"
url = f"{m.BASE}/{path}?tab=liveAndUpcoming"

def norm(s): return s.lower().replace("ç","c").replace("ü","u")

def get_matches(page):
    for _ in range(4):
        page.wait_for_timeout(3500)
        m.dismiss_overlays(page)
        for _ in range(5):
            btns = page.locator("[test-id='accordion-item-toggle-button']")
            for i in range(btns.count()):
                try: btns.nth(i).click(force=True)
                except: pass
            page.wait_for_timeout(2000)
            if page.locator("obg-event-row-container").count() > 0: break
        ms = m.scrape_matches(page, path)
        if ms: return ms
        page.goto(url, wait_until="domcontentloaded")
    return []

api_headers = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = m._new_context(browser).new_page()
    m.capture_widget_headers(page, api_headers)
    page.goto(url, wait_until="domcontentloaded")
    matches = get_matches(page)
    print("matches available:", len(matches))
    for a, b in WANT:
        match = next((x for x in matches if a.lower() in norm(x["name"]) and b.lower() in norm(x["name"])), None)
        if not match:
            print(f"  NOT FOUND: {a} - {b}"); continue
        mk = m.scrape_odds_api(page, match["event_id"], api_headers)
        fn = match["name"].replace(" ", "_").lower() + "_odds_bson.json"
        json.dump(mk, open(fn,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
        stats = [k for k in mk if re.search(r'Total (Corners|Throw-ins|Offsides|Shots|Fouls|Goal Kicks)', k)]
        print(f"  saved {fn}  ({len(mk)} markets, {len(stats)} stat markets)")
    browser.close()
