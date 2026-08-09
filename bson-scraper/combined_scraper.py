from playwright.sync_api import sync_playwright
import json

BASE = "https://www.1503bets10.com"
FOOTBALL = f"{BASE}/en/sportsbook/football"
ROOT_SELECTOR = "obg-m-event-market-tabs-container"

LEAGUES = {
    "1": ("Champions League", "champions-league"),
    "2": ("Europa League", "europa-league/europa-league"),
    "3": ("Conference League", "conference-league"),
    "4": ("Premier League", "england/england-premier-league"),
    "5": ("Bundesliga", "germany/germany-bundesliga"),
    "6": ("La Liga", "spain/spain-la-liga"),
    "7": ("Serie A", "italy/italy-serie-a"),
    "8": ("Ligue 1", "france/france-ligue-1"),
    "9": ("Eredivisie", "netherlands/netherlands-eredivisie"),
    "10": ("Turkish Super Lig", "turkey/turkey-super-lig"),
    "11": ("Jupiler League", "belgium/belgium-jupiler-league"),
    "12": ("Saudi Pro League", "saudi-arabia/saudi-arabia-proleague"),
}

# -----------------------------
# LEAGUE SELECTION
# -----------------------------
def choose_league():
    print("\nSelect League:\n")
    for k, (name, _) in LEAGUES.items():
        print(f"{k}. {name}")

    choice = input("\nEnter number: ").strip()
    if choice not in LEAGUES:
        raise ValueError("Invalid selection")

    return LEAGUES[choice]

# -----------------------------
# FIND TODAY ACCORDION
# -----------------------------
def find_today_accordion(page):
    accordions = page.locator("obg-uiuplift-accordion-item").all()
    for acc in accordions:
        if acc.locator("obg-event-row-container").count() > 0:
            return acc
    return None

# -----------------------------
# BUILD CORRECT SPORTSBOOK URL
# -----------------------------
def build_event_url(event_id, league_path):
    """
    Converts:
    england/england-premier-league
    -> england sportsbook root
    """
    country_root = league_path.split("/")[0]

    return (
        f"{FOOTBALL}/{country_root}"
        f"?tab=liveAndUpcoming"
        f"&eventId={event_id}"
        f"&fs=true&eti=0&mtg=1"
    )

# -----------------------------
# SCRAPE MATCHES
# -----------------------------
def scrape_matches(page, league_path):
    accordion = find_today_accordion(page)
    if not accordion:
        return []

    rows = accordion.locator("obg-event-row-container").all()
    matches = []

    for row in rows:
        try:
            # --- EVENT ID (CRITICAL) ---
            event_id = row.get_attribute("test-id")
            if not event_id:
                continue

            # --- TEAM NAMES ---
            teams = row.locator(
                "obg-event-scorecard div.obg-event-scorecard-labels div > div > span"
            ).all()

            if len(teams) >= 2:
                home = teams[0].inner_text().strip()
                away = teams[1].inner_text().strip()
                name = f"{home} - {away}"
            else:
                name = row.inner_text().split("\n")[0]

            # --- BUILD CORRECT LINK ---
            full_link = build_event_url(event_id, league_path)

            matches.append({
                "name": name,
                "link": full_link,
                "event_id": event_id
            })

        except:
            continue

    return matches

# -----------------------------
# EXPAND MARKETS
# -----------------------------
def expand_all_markets(page):
    buttons = page.locator('[test-id="accordion-item-toggle-button"]')
    for i in range(buttons.count()):
        try:
            buttons.nth(i).click(force=True)
        except:
            pass
    page.wait_for_timeout(3000)

# -----------------------------
# PARSE MARKETS
# -----------------------------
def extract_market(group):
    try:
        title = group.locator(
            "obg-m-event-market-group-header span"
        ).first.inner_text().strip()
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

# -----------------------------
# MAIN FLOW
# -----------------------------
def main():
    league_name, path = choose_league()
    league_url = f"{FOOTBALL}/{path}?tab=liveAndUpcoming"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()

        print(f"\nLoading {league_name}...")
        page.goto(league_url, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)

        matches = scrape_matches(page, path)

        if not matches:
            print("No matches today.")
            browser.close()
            return

        # -------- MATCH PICKER --------
        print("\nToday's Matches:\n")
        for i, m in enumerate(matches, 1):
            print(f"{i}. {m['name']}")

        idx = int(input("\nSelect match number: ")) - 1
        match = matches[idx]

        print(f"\nLoading match: {match['name']}")
        page.goto(match["link"], wait_until="domcontentloaded")

        # -------- ODDS SCRAPING --------
        page.wait_for_selector(ROOT_SELECTOR)
        page.wait_for_timeout(3000)

        expand_all_markets(page)

        root = page.locator(ROOT_SELECTOR).first
        groups = root.locator("obg-m-event-market-group")

        final_data = {}
        for i in range(groups.count()):
            parsed = extract_market(groups.nth(i))
            if parsed:
                final_data.update(parsed)

        # -------- SAVE --------
        filename = match["name"].replace(" ", "_").lower() + "_odds.json"
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(final_data, f, indent=2, ensure_ascii=False)

        print(f"\n✅ Saved {len(final_data)} markets to {filename}")
        browser.close()


if __name__ == "__main__":
    main()
