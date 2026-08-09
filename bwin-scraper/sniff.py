#!/usr/bin/env python3
"""Open a match page and log all XHR/Fetch responses to find the odds API endpoint."""
from playwright.sync_api import sync_playwright
import json
import sys

# Use a real match link from the scraped data
MATCH_URL = sys.argv[1] if len(sys.argv) > 1 else None

if not MATCH_URL:
    print("Usage: python sniff.py <match_url>")
    print("Example: python sniff.py https://betwinner-16742.bar/en/line/football/...")
    sys.exit(1)

captured = []

def on_response(response):
    url = response.url
    content_type = response.headers.get("content-type", "")

    # Only care about JSON/API responses
    if "json" in content_type or "/api/" in url or "sport" in url.lower():
        try:
            body = response.json()
        except Exception:
            body = "(could not parse JSON)"

        entry = {
            "url": url,
            "status": response.status,
            "content_type": content_type,
            "body_preview": str(body)[:500],
        }
        captured.append(entry)
        print(f"\n[{response.status}] {url}")
        print(f"  Content-Type: {content_type}")
        print(f"  Body preview: {str(body)[:300]}")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(ignore_https_errors=True).new_page()

    page.on("response", on_response)

    print(f"Loading: {MATCH_URL}\n")
    page.goto(MATCH_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)

    print(f"\n{'=' * 60}")
    print(f"Captured {len(captured)} JSON/API responses total")
    print(f"{'=' * 60}")

    browser.close()

# Dump full log to file for inspection
with open("sniff_log.json", "w", encoding="utf-8") as f:
    json.dump(captured, f, indent=2, ensure_ascii=False, default=str)

print(f"\nFull log saved to sniff_log.json")
