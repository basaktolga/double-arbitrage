#!/usr/bin/env python3
"""Click the category dropdown and read the labels, then map them to sub-game IDs."""
from playwright.sync_api import sync_playwright
import json
import sys

MATCH_URL = sys.argv[1] if len(sys.argv) > 1 else None
if not MATCH_URL:
    print("Usage: python sniff_categories.py <match_url>")
    sys.exit(1)

# Also try to fetch a sub-game to confirm we can get its odds
sub_game_responses = []

def on_response(response):
    if "GetGameZip" in response.url:
        try:
            data = response.json()
            sub_game_responses.append({"url": response.url, "data": data})
        except Exception:
            pass

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)  # visible so we can debug
    page = browser.new_context(ignore_https_errors=True).new_page()
    page.on("response", on_response)

    page.goto(MATCH_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)

    # Try to read the dropdown options
    dropdown_selector = (
        "#game_toolbar div.sub-games-dropdown div.multiselect__content-wrapper ul li"
    )

    # First, click the dropdown to open it
    dropdown_toggle = page.locator(
        "#game_toolbar div.sub-games-dropdown div.multiselect"
    )
    try:
        dropdown_toggle.click()
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"Could not click dropdown: {e}")

    items = page.locator(dropdown_selector).all()
    print(f"\nDropdown items ({len(items)}):\n")
    for i, item in enumerate(items):
        try:
            text = item.inner_text().strip()
            # Check for data attributes
            attrs = {}
            for attr in ["data-id", "data-value", "id"]:
                v = item.get_attribute(attr)
                if v:
                    attrs[attr] = v
            print(f"  {i+1:2d}. {text:<30} {attrs}")
        except Exception as e:
            print(f"  {i+1:2d}. ERROR: {e}")

    # Try clicking on one of them (e.g., item 3 which might be Corners)
    # and see what API call gets triggered
    if len(items) > 3:
        print(f"\n--- Clicking item 4 to see API call ---")
        prev_count = len(sub_game_responses)
        try:
            items[3].click()
            page.wait_for_timeout(4000)
        except Exception as e:
            print(f"Click failed: {e}")

        new_responses = sub_game_responses[prev_count:]
        for r in new_responses:
            url = r["url"]
            data = r["data"]
            val = data.get("Value", {})
            print(f"\n  URL: {url}")
            print(f"  Game ID in response: {val.get('CI', 'N/A')}")
            print(f"  Teams: {val.get('O1', '?')} vs {val.get('O2', '?')}")
            print(f"  GE count: {len(val.get('GE', []))}")
            if val.get("GE"):
                for g in val["GE"][:3]:
                    print(f"    G={g['G']}, GS={g.get('GS')}, sels={len(g['E'])}")

    page.wait_for_timeout(2000)
    browser.close()
