#!/usr/bin/env python3
"""List all sub-game categories for a match and try fetching one."""
from playwright.sync_api import sync_playwright
import json
import sys

MATCH_URL = sys.argv[1] if len(sys.argv) > 1 else None
if not MATCH_URL:
    print("Usage: python list_categories.py <match_url>")
    sys.exit(1)

api_data = {}

def on_response(response):
    global api_data
    if "GetGameZip" in response.url and "isSubGames=true" in response.url:
        try:
            api_data = response.json()
        except Exception:
            pass

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.on("response", on_response)
    page.goto(MATCH_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(8000)
    browser.close()

if not api_data.get("Success"):
    print("Failed to capture API data")
    sys.exit(1)

value = api_data["Value"]
print(f"Main game ID: {value['CI']}")
print(f"Teams: {value.get('O1')} vs {value.get('O2')}")
print(f"\nSub-games ({len(value.get('SG', []))}):\n")

for i, sg in enumerate(value.get("SG", [])):
    print(f"  {i+1:2d}. ID={sg['I']:<12} N={sg['N']:<10} "
          f"GE={len(sg.get('GE',[]))} events  "
          f"EC={sg.get('EC',0)} markets  "
          f"PN={sg.get('PN','?')}")

# Save for reference
with open("categories.json", "w", encoding="utf-8") as f:
    json.dump([{"index": i, "id": sg["I"], "N": sg["N"], "PN": sg.get("PN"),
                "EC": sg.get("EC"), "MG": sg.get("MG")}
               for i, sg in enumerate(value.get("SG", []))], f, indent=2)
print("\nSaved to categories.json")
