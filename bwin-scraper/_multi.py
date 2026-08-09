import json
from playwright.sync_api import sync_playwright
import main as m

WANT = [("Spain","Saudi"), ("Belgium","Iran"), ("Uruguay","Cape Verde"), ("New Zealand","Egypt")]
path = "line/football/2708736-world-cup-2026"
url = f"{m.BASE}/{path}"

def norm(s): return s.lower().replace("ç","c").replace("ü","u")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(9000)
    matches = m.scrape_matches(page, path)
    print("matches available:", len(matches))
    for a, b in WANT:
        match = next((x for x in matches if a.lower() in norm(x["name"]) and b.lower() in norm(x["name"])), None)
        if not match:
            print(f"  NOT FOUND: {a} - {b}"); continue
        print(f"  scraping {match['name']} ...")
        page.goto(match["link"], wait_until="domcontentloaded")
        am = m.scrape_odds_for_categories(page)
        fn = match["name"].replace(" ", "_").lower() + "_odds_bwin.json"
        json.dump(am, open(fn,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
        print(f"  saved {fn}  ({len(am)} categories)")
    browser.close()
