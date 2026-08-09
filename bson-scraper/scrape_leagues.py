from playwright.sync_api import sync_playwright
import json

BASE = "https://www.1469bets10.com/en/sportsbook/football"

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


# ✅ NEW: Stable event link builder
def build_event_link(href, event_id):
    if not href or not event_id:
        return None

    # remove domain if present
    href = href.replace("https://www.1467bets10.com", "")

    parts = href.split("/")

    try:
        football_index = parts.index("football")
        root_parts = parts[:football_index + 2]  # keep country level
        root_path = "/".join(root_parts)
    except ValueError:
        root_path = "/en/sportsbook/football"

    return (
        f"https://www.1467bets10.com{root_path}"
        f"?eventId={event_id}&fs=true&eti=0&mtg=1"
    )


def choose_league():
    print("\nSelect League:\n")
    for k, (name, _) in LEAGUES.items():
        print(f"{k}. {name}")

    choice = input("\nEnter number: ").strip()
    if choice not in LEAGUES:
        raise ValueError("Invalid selection")

    return LEAGUES[choice]


def find_today_accordion(page):
    accordions = page.locator("obg-uiuplift-accordion-item").all()

    for acc in accordions:
        if acc.locator("obg-event-row-container").count() > 0:
            return acc

    return None


def scrape_matches(page):
    accordion = find_today_accordion(page)
    if not accordion:
        return []

    rows = accordion.locator("obg-event-row-container").all()
    matches = []

    for row in rows:
        try:
            # --- GET HREF ---
            link_el = row.locator("a").first
            href = link_el.get_attribute("href")

            # --- GET EVENT ID ---
            event_id = row.get_attribute("test-id")

            # --- GET TEAM NAMES ---
            teams = row.locator(
                "obg-event-scorecard div.obg-event-scorecard-labels div > div > span"
            ).all()

            if len(teams) >= 2:
                home = teams[0].inner_text().strip()
                away = teams[1].inner_text().strip()
                name = f"{home} - {away}"
            else:
                name = row.inner_text().split("\n")[0]

            # ✅ FIXED URL BUILDER
            full_link = build_event_link(href, event_id)
            if not full_link:
                continue

            matches.append({
                "name": name,
                "link": full_link,
                "event_id": event_id
            })

        except:
            continue

    return matches


def main():
    league_name, path = choose_league()
    url = f"{BASE}/{path}?tab=liveAndUpcoming"

    print(f"\nLoading {league_name}...")
    print("URL:", url)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)

        matches = scrape_matches(page)
        browser.close()

    if not matches:
        print("\nNo matches found today.")
        return

    output = {
        "league": league_name,
        "matches": matches
    }

    filename = f"{league_name.lower().replace(' ', '_')}_today.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Saved {len(matches)} matches to {filename}")


if __name__ == "__main__":
    main()
