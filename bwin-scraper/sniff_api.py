#!/usr/bin/env python3
"""Fetch the GetGameZip API directly and dump the full response for analysis."""
from playwright.sync_api import sync_playwright
import json
import sys

MATCH_URL = sys.argv[1] if len(sys.argv) > 1 else None
if not MATCH_URL:
    print("Usage: python sniff_api.py <match_url>")
    sys.exit(1)

# Extract game ID from URL (last path segment before the name, e.g. 300956136)
game_id = MATCH_URL.rstrip("/").split("/")[-1].split("-")[0]
print(f"Game ID: {game_id}")

API_URL = (
    f"https://betwinner-16742.bar/service-api/LineFeed/GetGameZip"
    f"?id={game_id}&lng=en&isSubGames=true&GroupEvents=true"
    f"&countevents=250&grMode=4&partner=152&country=190&marketType=1&isNewBuilder=true"
)

captured = {}

def on_response(response):
    global captured
    if "GetGameZip" in response.url:
        try:
            captured = response.json()
        except Exception:
            pass

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.on("response", on_response)
    page.goto(MATCH_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(8000)
    browser.close()

if captured:
    with open("api_response.json", "w", encoding="utf-8") as f:
        json.dump(captured, f, indent=2, ensure_ascii=False)
    print(f"Saved full API response to api_response.json")

    # Quick overview of the structure
    value = captured.get("Value", {})
    print(f"\nTop-level keys in Value: {list(value.keys())}")

    ge = value.get("GE", [])
    print(f"Number of market groups (GE): {len(ge)}")

    sg = value.get("SG", [])
    print(f"Number of sub-games (SG): {len(sg)}")

    # Show first few market groups
    for i, group in enumerate(ge[:3]):
        print(f"\n--- Market Group {i} ---")
        print(f"  Keys: {list(group.keys())}")
        print(f"  GN (group name?): {group.get('GN', 'N/A')}")
        print(f"  G (group id?): {group.get('G', 'N/A')}")
        events = group.get("E", [])
        print(f"  Number of events/selections (E): {len(events)}")
        if events:
            print(f"  First event: {events[0]}")
else:
    print("No GetGameZip response captured!")
