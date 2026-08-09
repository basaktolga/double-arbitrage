"""Scrape ONE World Cup match from Betwinner by name (no event link needed).

Usage: python one_match.py "<out_dir>" "<name substring>"  e.g. "portugal"
Lists the WC schedule, finds the match whose name contains all given tokens,
then navigates to just that event and scrapes its odds.
"""
import sys, os, json
from playwright.sync_api import sync_playwright
import main as m

OUT = sys.argv[1]
QUERY = " ".join(sys.argv[2:]).lower().split()
URL = f"{m.BASE}/line/football/2708736-world-cup-2026"


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(9000)
    matches = m.scrape_matches(page, "line/football/2708736-world-cup-2026")
    matches = [x for x in matches if x["name"] and "-" in x["name"]
               and x["name"].split(" - ")[-1].strip()]
    hit = next((x for x in matches
                if all(t in x["name"].lower() for t in QUERY)), None)
    if not hit:
        print(f"[bwin] no match for {QUERY}; have: {[x['name'] for x in matches]}")
        browser.close(); sys.exit(1)
    page.goto(hit["link"], wait_until="domcontentloaded")
    am = m.scrape_odds_for_categories(page)
    fn = os.path.join(OUT, hit["name"].replace(" ", "_").lower() + "_odds_bwin.json")
    json.dump(am, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"[bwin] {hit['name']}: {len(am)} categories -> {os.path.basename(fn)}")
    browser.close()
