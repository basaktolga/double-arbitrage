from playwright.sync_api import sync_playwright
import json

URL = "https://www.1467bets10.com/en/sportsbook?eventId=f-dGMoE42KtkaAr5khfrMXhQ&eti=0&fs=true&mtg=1"
ROOT_SELECTOR = "obg-m-event-market-tabs-container"

def expand_all_markets(page):
    print("Expanding all accordions...")

    buttons = page.locator('[test-id="accordion-item-toggle-button"]')
    count = buttons.count()
    print(f"Found {count} accordion buttons")

    for i in range(count):
        try:
            btn = buttons.nth(i)
            btn.click(force=True)
        except:
            pass

    page.wait_for_timeout(3000)  # allow Angular to render


def extract_market(group):
    try:
        title = group.locator("obg-m-event-market-group-header span").first.inner_text().strip()
    except:
        return None

    selections = group.locator("obg-selection-container-v2")
    items = []

    for i in range(selections.count()):
        sel = selections.nth(i)
        try:
            name = sel.locator(".obg-selection-v2-label").inner_text().strip()
            odds = sel.locator('[test-id="odds"]').inner_text().strip()
            items.append({
                "name": name,
                "odds": float(odds)
            })
        except:
            continue

    if items:
        return {title: items}

    return None


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        print("Loading page...")
        page.goto(URL, wait_until="domcontentloaded")

        page.wait_for_selector(ROOT_SELECTOR)
        page.wait_for_timeout(3000)

        # 🔥 EXPAND EVERYTHING
        expand_all_markets(page)

        root = page.locator(ROOT_SELECTOR).first
        groups = root.locator("obg-m-event-market-group")

        total_groups = groups.count()
        print(f"Parsing {total_groups} market groups")

        final_data = {}

        for i in range(total_groups):
            group = groups.nth(i)
            parsed = extract_market(group)
            if parsed:
                final_data.update(parsed)

        with open("all_markets.json", "w", encoding="utf-8") as f:
            json.dump(final_data, f, indent=2, ensure_ascii=False)

        print("Saved all expanded markets ✅")
        browser.close()


if __name__ == "__main__":
    main()
