"""Scrape ALL current World Cup matches on Betwinner -> write <match>_odds_bwin.json
to the output dir given as argv[1]. Used by website/local_agent.py."""
import sys, os, json
from playwright.sync_api import sync_playwright
import main as m

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
path = "line/football/2708736-world-cup-2026"
url = f"{m.BASE}/{path}"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(9000)
    matches = m.scrape_matches(page, path)
    matches = [x for x in matches if x["name"] and "-" in x["name"] and x["name"].split(" - ")[-1].strip()]
    print(f"[bwin] {len(matches)} matches", flush=True)
    for match in matches:
        try:
            page.goto(match["link"], wait_until="domcontentloaded")
            am = m.scrape_odds_for_categories(page)
            if not am:
                continue
            fn = os.path.join(OUT, match["name"].replace(" ", "_").lower() + "_odds_bwin.json")
            json.dump(am, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
            print(f"[bwin] saved {os.path.basename(fn)}", flush=True)
        except Exception as e:
            print(f"[bwin] {match['name']} failed: {e}", flush=True)
    browser.close()
