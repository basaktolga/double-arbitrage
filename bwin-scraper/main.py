#!/usr/bin/env python3
import os
from playwright.sync_api import sync_playwright
import json
import sys
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.environ.get("BWIN_BASE", "https://betwinner-52364.pro")

LEAGUES = [
    ("Champions League",  "topgame/line/football/118587-uefa-champions-league"),
    ("Europa League",     "topgame/line/football/118593-uefa-europa-league"),
    ("Conference League", "topgame/line/football/2252762-uefa-conference-league"),
    ("Premier League",    "topgame/line/football/88637-england-premier-league"),
    ("Bundesliga",        "topgame/line/football/96463-germany-bundesliga"),
    ("La Liga",           "topgame/line/football/127733-spain-la-liga"),
    ("Serie A",           "topgame/line/football/110163-italy-serie-a"),
    ("Ligue 1",           "topgame/line/football/12821-france-ligue-1"),
    ("Eredivisie",        "topgame/line/football/2018750-netherlands-eredivisie"),
    #("Primeira Liga",     "topgame/line/football/118663-portugal-primeira-liga"),
    ("Turkish Superliga", "topgame/line/football/11113-turkey-superliga"),
    ("Jupiler League",    "topgame/line/football/28787-belgium-jupiler-league"),
    ("Saudi Pro League",  "line/football/16819-saudi-arabia-saudi-professional-league"),
    ("Copa Libertadores",  "line/football/142091-copa-libertadores"),
    ("Copa Sudamericana",  "line/football/1528791-copa-sudamericana"),
    ("World Cup 2026",     "line/football/2708736-world-cup-2026"),
]

# ─────────────────────────────────────────
# BET TEMPLATES (ID → name mapping)
# ─────────────────────────────────────────

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_templates_cache = None

def _fetch_template(sport_id):
    """Fetch a single template file and return parsed (gs, t) dicts."""
    url = f"{BASE}/genfiles/cms/betstemplates/bets_model_short_en_{sport_id}.json"
    gs = {}
    t = {}
    try:
        with urllib.request.urlopen(url, context=_ssl_ctx) as resp:
            file_data = json.loads(resp.read())
    except Exception:
        return gs, t

    for sid, sport_data in file_data.items():
        if not isinstance(sport_data, dict):
            continue
        for gs_id, group in sport_data.items():
            if not isinstance(group, dict):
                continue
            gn = group.get("GN", {})
            if gn:
                for gn_key, gn_val in gn.items():
                    gs[int(gn_key)] = gn_val
            for t_id, sel in group.get("M", {}).items():
                if isinstance(sel, dict):
                    t[int(t_id)] = sel.get("N", t_id)
    return gs, t


def load_templates():
    """Fetch bet-name templates from ALL sport template files in parallel."""
    global _templates_cache
    if _templates_cache is not None:
        return _templates_cache

    print("  Loading bet templates...")
    gs_to_name = {}
    t_to_name = {}

    # Fetch the map to discover all sport IDs
    map_url = f"{BASE}/genfiles/cms/betstemplates/bets_model_map_en.json"
    try:
        with urllib.request.urlopen(map_url, context=_ssl_ctx) as resp:
            sport_ids = list(json.loads(resp.read()).keys())
    except Exception:
        sport_ids = ["0", "1"]

    # Fetch all template files in parallel
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(_fetch_template, sid): sid for sid in sport_ids}
        for future in as_completed(futures):
            try:
                gs, t = future.result()
                gs_to_name.update(gs)
                t_to_name.update(t)
            except Exception:
                continue

    print(f"  Loaded {len(gs_to_name)} market names, {len(t_to_name)} selection names")
    _templates_cache = (gs_to_name, t_to_name)
    return _templates_cache


def resolve_selection_name(t_to_name, t_id, team1, team2, param=None):
    """Resolve a selection T id to a human-readable name."""
    raw = t_to_name.get(t_id, f"T{t_id}")
    raw = raw.replace("W1", team1).replace("W2", team2)
    raw = raw.replace("Team 1", team1).replace("Team 2", team2)
    if param is not None:
        raw = raw.replace("()", str(param), 1)
    return raw


# ─────────────────────────────────────────
# MENU HELPERS
# ─────────────────────────────────────────

def select(prompt, options, label_fn=str):
    """Generic numbered selection menu. Returns chosen item."""
    print()
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {label_fn(opt)}")
    print()
    while True:
        raw = input(f"{prompt}: ").strip()
        if raw.lower() in ("q", "quit", "exit"):
            print("Bye.")
            sys.exit(0)
        try:
            idx = int(raw) - 1
            if 0 <= idx < len(options):
                return options[idx]
        except ValueError:
            pass
        print(f"  Please enter a number between 1 and {len(options)}.")


def header(title):
    print(f"\n{'─' * 40}")
    print(f"  {title}")
    print(f"{'─' * 40}")


# ─────────────────────────────────────────
# SCRAPING - MATCHES (Playwright/DOM)
# ─────────────────────────────────────────

DASHBOARD_SELECTOR = (
    "#__BETTING_APP__ > div.default-layout-container > div > div > "
    "div.layout__main > main > div.betting-main.betting-content__main > "
    "div > div > div > div.betting-main-dashboard > div > ul > li"
)
MATCH_BLOCK = "div.dashboard-game-block.dashboard-game__block"
MATCH_LINK = "span:nth-child(1) > a"
TEAM_NAME = "div.ui-team-score-name--nowrap.ui-team-score-name > span"


def scrape_matches(page, league_path):
    """Scrape today's matches from a league page."""
    matches = []
    date_groups = page.locator(DASHBOARD_SELECTOR).all()

    for group in date_groups:
        inner_items = group.locator("ul > li").all()
        for item in inner_items[1:]:
            try:
                block = item.locator(MATCH_BLOCK)
                if block.count() == 0:
                    continue

                link_el = block.locator(MATCH_LINK)
                href = link_el.get_attribute("href") or ""

                teams = block.locator(TEAM_NAME).all()
                if len(teams) >= 2:
                    name = f"{teams[0].inner_text().strip()} - {teams[1].inner_text().strip()}"
                else:
                    name = block.inner_text().strip().split("\n")[0]

                link = href if href.startswith("http") else f"{BASE}{href}"

                matches.append({
                    "name": name,
                    "link": link,
                })
            except Exception:
                continue
    return matches


# ─────────────────────────────────────────
# SCRAPING - ODDS (API interception)
# ─────────────────────────────────────────

DROPDOWN_SELECTOR = "#game_toolbar div.sub-games-dropdown div.multiselect"
DROPDOWN_ITEMS = "#game_toolbar div.sub-games-dropdown div.multiselect__content-wrapper ul li"


def parse_api_odds(api_data, gs_to_name, t_to_name):
    """Parse a GetGameZip API response into a markets dict."""
    if not api_data or not api_data.get("Success"):
        return {}, "", ""

    value = api_data["Value"]
    team1 = value.get("O1", "Team 1")
    team2 = value.get("O2", "Team 2")
    markets = {}

    for group in value.get("GE", []):
        gs_id = group.get("GS", group.get("G"))
        group_name = gs_to_name.get(gs_id, f"Market {gs_id}")

        items = []
        for selection_list in group.get("E", []):
            for sel in selection_list:
                t_id = sel.get("T")
                odds = sel.get("C")
                param = sel.get("P")
                if t_id is None or odds is None:
                    continue
                name = resolve_selection_name(t_to_name, t_id, team1, team2, param)
                items.append({"name": name, "odds": odds})

        if items:
            if group_name in markets:
                markets[group_name].extend(items)
            else:
                markets[group_name] = items

    return markets, team1, team2


def _fetch_subgame(url, gs_to_name, t_to_name):
    """Fetch a single sub-game via direct API call."""
    with urllib.request.urlopen(url, context=_ssl_ctx) as resp:
        data = json.loads(resp.read())
    return parse_api_odds(data, gs_to_name, t_to_name)


def scrape_odds_for_categories(page):
    """Intercept initial API response, then fetch sub-games directly via HTTP."""
    gs_to_name, t_to_name = load_templates()

    all_markets = {}
    captured = {}

    def on_response(response):
        if "GetGameZip" in response.url:
            try:
                captured["latest"] = response.json()
            except Exception:
                pass

    page.on("response", on_response)

    # Wait for initial page load and capture "Regular time" odds
    page.wait_for_timeout(6000)

    initial_data = captured.get("latest")
    if not initial_data or not initial_data.get("Success"):
        print("  No initial API response captured.")
        return all_markets

    markets, team1, team2 = parse_api_odds(initial_data, gs_to_name, t_to_name)
    all_markets["Regular time"] = markets
    print(f"    Regular time: {len(markets)} markets")

    # Extract sub-game IDs from the initial response
    sub_games = initial_data.get("Value", {}).get("SG", [])
    if not sub_games:
        print("  No sub-games found in API response.")
        return all_markets

    # Read dropdown labels to map sub-game IDs to category names
    try:
        page.locator(DROPDOWN_SELECTOR).click()
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"  Could not open dropdown: {e}")
        return all_markets

    items = page.locator(DROPDOWN_ITEMS).all()
    item_labels = []
    for item in items:
        try:
            item_labels.append(item.inner_text().strip())
        except Exception:
            item_labels.append("")

    # Close dropdown
    page.locator(DROPDOWN_SELECTOR).click()
    page.wait_for_timeout(300)

    # Build mapping: category name → sub-game ID
    # Dropdown: [0]=Regular time (not in SG), then SG entries map 1:1
    SKIP_PREFIX = 1  # Only "Regular time" is not in SG
    cat_to_sg = {}
    for i, sg in enumerate(sub_games):
        sg_id = sg["I"] if isinstance(sg, dict) else sg
        label_idx = i + SKIP_PREFIX
        if label_idx < len(item_labels):
            label = item_labels[label_idx].strip()
            if label:
                cat_to_sg[label] = sg_id

    # Build list of (category_name, url) for ALL dropdown categories
    fetch_tasks = []
    for cat_name, sg_id in cat_to_sg.items():
        url = (
            f"{BASE}/service-api/LineFeed/GetGameZip?"
            f"id={sg_id}&lng=en&isSubGames=true&GroupEvents=true"
            f"&countevents=250&grMode=4&partner=152&country=190"
            f"&marketType=1&isNewBuilder=true"
        )
        fetch_tasks.append((cat_name, url))

    # Fetch all sub-game odds in parallel
    if fetch_tasks:
        print(f"  Fetching {len(fetch_tasks)} categories in parallel...")
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {
                executor.submit(_fetch_subgame, url, gs_to_name, t_to_name): cat_name
                for cat_name, url in fetch_tasks
            }
            for future in as_completed(futures):
                cat_name = futures[future]
                try:
                    markets, _, _ = future.result()
                    all_markets[cat_name] = markets
                    print(f"    {cat_name}: {len(markets)} markets")
                except Exception as e:
                    print(f"    {cat_name}: fetch failed ({e})")

    return all_markets


# ─────────────────────────────────────────
# FLOWS
# ─────────────────────────────────────────

def flow_matches():
    header("Scrape Today's Matches")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])

    url = f"{BASE}/{path}"
    print(f"\n  Loading {league_name}...")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(ignore_https_errors=True).new_page()
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)
        matches = scrape_matches(page, path)
        browser.close()

    if not matches:
        print("  No matches found today.")
        return

    filename = f"{league_name.lower().replace(' ', '_')}_today.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump({"league": league_name, "matches": matches}, f, indent=2, ensure_ascii=False)

    print(f"\n  Saved {len(matches)} matches → {filename}")


def flow_odds():
    header("Scrape Match Odds")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])

    url = f"{BASE}/{path}"
    print(f"\n  Loading {league_name}...")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()

        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)
        matches = scrape_matches(page, path)

        if not matches:
            print("  No matches found today.")
            browser.close()
            return

        header("Select Match")
        match = select("Select match", matches, label_fn=lambda m: m["name"])

        print(f"\n  Loading odds for: {match['name']}\n")
        page.goto(match["link"], wait_until="domcontentloaded")
        all_markets = scrape_odds_for_categories(page)
        browser.close()

    filename = match["name"].replace(" ", "_").lower() + "_odds_bwin.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(all_markets, f, indent=2, ensure_ascii=False)

    total = sum(len(m) for m in all_markets.values())
    print(f"\n  Saved {len(all_markets)} categories ({total} total markets) → {filename}")


# ─────────────────────────────────────────
# MAIN MENU
# ─────────────────────────────────────────

ACTIONS = [
    ("Scrape today's matches", flow_matches),
    ("Scrape odds for a match", flow_odds),
    ("Exit",                    None),
]

def main():
    print("\n  Betwinner Football Odds Scraper")
    print("  (enter q to quit at any prompt)")

    while True:
        header("Main Menu")
        action_name, fn = select("Select action", ACTIONS, label_fn=lambda a: a[0])
        if fn is None:
            print("Bye.")
            break
        fn()
        input("\n  Press Enter to return to main menu...")


if __name__ == "__main__":
    main()
