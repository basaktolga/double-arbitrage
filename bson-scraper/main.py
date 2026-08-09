#!/usr/bin/env python3
import os
from playwright.sync_api import sync_playwright
import json
import sys

BASE = os.environ.get("BSON_BASE", "https://www.10012bets10.com/en/sportsbook/football")
API_ORIGIN = os.environ.get("BSON_API_ORIGIN", "https://www.10012bets10.com")
ROOT_SELECTOR = "obg-m-event-market-tabs-container"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

LEAGUES = [
    ("Champions League",  "champions-league"),
    ("Europa League",     "europa-league"),
    ("Conference League", "conference-league"),
    ("Premier League",    "england/england-premier-league"),
    ("Bundesliga",        "germany/germany-bundesliga"),
    ("La Liga",           "spain/spain-la-liga"),
    ("Serie A",           "italy/italy-serie-a"),
    ("Ligue 1",           "france/france-ligue-1"),
    ("Eredivisie",        "netherlands/netherlands-eredivisie"),
    ("Turkish Super Lig", "turkey/turkey-super-lig"),
    ("Jupiler League",    "belgium/belgium-jupiler-league"),
    ("Saudi Pro League",  "saudi-arabia/saudi-arabia-proleague"),
    ("Copa Libertadores",  "copa-libertadores"),
    ("Copa Sudamericana",  "copa-sudamericana"),
    ("World Cup 2026",     "world-cup"),
]

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
# SCRAPING
# ─────────────────────────────────────────

def build_event_url(event_id, league_path):
    country = league_path.split("/")[0]
    return (
        f"{BASE}/{country}"
        f"?tab=liveAndUpcoming&eventId={event_id}&fs=true&eti=0&mtg=1"
    )


def dismiss_overlays(page):
    """Close blocking popups (e.g. anti-phishing dialog) that intercept clicks."""
    for sel in (
        "site-anti_phishing_dialog .anti-phishing-dialog-close-button",
    ):
        try:
            btn = page.locator(sel)
            if btn.count():
                btn.first.click(force=True, timeout=2000)
                page.wait_for_timeout(300)
        except Exception:
            pass


def scrape_matches(page, league_path):
    # Matches can be split across several date-group accordions (e.g. World Cup),
    # so aggregate event rows from every accordion that contains them.
    accordions = page.locator("obg-uiuplift-accordion-item").all()
    matches = []
    seen_ids = set()
    for accordion in accordions:
        if accordion.locator("obg-event-row-container").count() == 0:
            continue
        for row in accordion.locator("obg-event-row-container").all():
            try:
                event_id = row.get_attribute("test-id")
                if not event_id or event_id in seen_ids:
                    continue
                teams = row.locator(
                    "obg-event-scorecard div.obg-event-scorecard-labels div > div > span"
                ).all()
                if len(teams) >= 2:
                    name = f"{teams[0].inner_text().strip()} - {teams[1].inner_text().strip()}"
                else:
                    name = row.inner_text().split("\n")[0]
                seen_ids.add(event_id)
                matches.append({
                    "name": name,
                    "link": build_event_url(event_id, league_path),
                    "event_id": event_id,
                })
            except Exception:
                continue
    return matches


def _extract_selections(container):
    """Extract selection name + odds pairs from a container element."""
    items = []
    for j in range(container.locator("obg-selection-container-v2").count()):
        sel = container.locator("obg-selection-container-v2").nth(j)
        try:
            name = sel.locator(".obg-selection-v2-label").inner_text().strip()
            odds = float(sel.locator('[test-id="odds"]').inner_text().strip())
            items.append({"name": name, "odds": odds})
        except Exception:
            continue
    return items


def _expand_accordions(page):
    """Click all accordion toggle buttons to expand collapsed sections."""
    buttons = page.locator('[test-id="accordion-item-toggle-button"]')
    for i in range(buttons.count()):
        try:
            buttons.nth(i).click(force=True)
        except Exception:
            pass
    page.wait_for_timeout(1000)


def _scrape_current_view(page, root, markets):
    """Scrape all market groups + featured markets from the currently visible tab."""
    # 1) Scrape accordion-based market groups (uses Playwright locators — shadow-DOM safe)
    for i in range(root.locator("obg-m-event-market-group").count()):
        group = root.locator("obg-m-event-market-group").nth(i)
        try:
            title = group.locator(
                "obg-m-event-market-group-header span"
            ).first.inner_text().strip()
        except Exception:
            continue
        if title in markets:
            continue  # Deduplicate: first occurrence wins
        items = _extract_selections(group)
        if items:
            markets[title] = items

    # 2) Scrape featured/orphan selections (not inside any market-group)
    #    Single batch evaluate on the root handle to avoid per-element round-trips
    try:
        root_handle = root.element_handle()
        if root_handle:
            orphans = page.evaluate("""(root) => {
                const results = [];
                const sels = root.querySelectorAll('obg-selection-container-v2');
                for (const sel of sels) {
                    if (sel.closest('obg-m-event-market-group')) continue;
                    let parent = sel.parentElement;
                    let title = null;
                    for (let d = 0; d < 10 && parent && parent !== root; d++) {
                        const hdr = parent.querySelector(
                            '[class*="market-name"], [class*="market-title"], ' +
                            '[class*="header"] span, [class*="market"] > span'
                        );
                        if (hdr && hdr.textContent.trim()) {
                            title = hdr.textContent.trim();
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    const labelEl = sel.querySelector('.obg-selection-v2-label');
                    const oddsEl = sel.querySelector('[test-id="odds"]');
                    if (labelEl && oddsEl) {
                        results.push({
                            title: title || '__featured__',
                            name: labelEl.textContent.trim(),
                            odds: oddsEl.textContent.trim()
                        });
                    }
                }
                return results;
            }""", root_handle)
            for item in orphans:
                title = item["title"]
                try:
                    odds_val = float(item["odds"])
                except (ValueError, TypeError):
                    continue
                if title not in markets:
                    markets[title] = []
                existing_names = {s["name"] for s in markets[title]}
                if item["name"] not in existing_names:
                    markets[title].append({"name": item["name"], "odds": odds_val})
    except Exception:
        pass  # Orphan scan is best-effort; grouped markets are the priority


def _debug_dom_structure(page):
    """Temporary debug: dump DOM structure using Playwright locators (shadow-DOM safe)."""
    root = page.locator(ROOT_SELECTOR).first
    info = {}

    # 1) Direct children — use evaluate on the root handle
    try:
        root_handle = root.element_handle()
        info["directChildren"] = page.evaluate("""(el) => {
            return [...el.children].map(c => ({
                tag: c.tagName.toLowerCase(),
                classes: c.className || '',
                testId: c.getAttribute('test-id') || ''
            }));
        }""", root_handle)
    except Exception as e:
        info["directChildren"] = f"Error: {e}"

    # 2) Tab-like elements — use Playwright locators (pierce shadow DOM)
    tab_selectors = [
        '[role="tab"]',
        '[test-id*="tab"]',
        '[test-id*="Tab"]',
        'button',
        'a',
    ]
    info["tabs"] = {}
    for sel in tab_selectors:
        try:
            els = root.locator(sel).all()
            if els:
                items = []
                for el in els[:20]:
                    try:
                        items.append({
                            "text": el.inner_text().strip()[:80],
                            "testId": el.get_attribute("test-id") or "",
                            "role": el.get_attribute("role") or "",
                            "tagName": el.evaluate("e => e.tagName.toLowerCase()"),
                        })
                    except Exception:
                        continue
                if items:
                    info["tabs"][sel] = items
        except Exception:
            continue

    # 3) Orphan selections (not inside market-group) — Playwright locators
    all_sels = root.locator("obg-selection-container-v2").all()
    grouped_sels = root.locator("obg-m-event-market-group obg-selection-container-v2").all()
    info["totalSelections"] = len(all_sels)
    info["groupedSelections"] = len(grouped_sels)
    info["orphanCount"] = len(all_sels) - len(grouped_sels)

    orphans = []
    for sel in all_sels[:30]:
        try:
            handle = sel.element_handle()
            is_orphan = page.evaluate(
                "(el) => !el.closest('obg-m-event-market-group')", handle
            )
            if not is_orphan:
                continue
            ancestor_info = page.evaluate("""(el) => {
                const chain = [];
                let p = el.parentElement;
                for (let d = 0; d < 8 && p; d++) {
                    chain.push({
                        tag: p.tagName.toLowerCase(),
                        classes: (p.className || '').substring(0, 100),
                        testId: p.getAttribute('test-id') || ''
                    });
                    p = p.parentElement;
                }
                let headerText = '';
                let pp = el.parentElement;
                for (let d = 0; d < 10 && pp; d++) {
                    const hdr = pp.querySelector(
                        '[class*="market-name"], [class*="market-title"], ' +
                        '[class*="header"] span, span[class*="market"]'
                    );
                    if (hdr) { headerText = hdr.textContent.trim(); break; }
                    pp = pp.parentElement;
                }
                return { ancestors: chain, headerText: headerText };
            }""", handle)
            label = ""
            odds = ""
            try:
                label = sel.locator(".obg-selection-v2-label").inner_text().strip()
            except Exception:
                pass
            try:
                odds = sel.locator('[test-id="odds"]').inner_text().strip()
            except Exception:
                pass
            orphans.append({
                "label": label,
                "odds": odds,
                "headerText": ancestor_info.get("headerText", ""),
                "ancestors": ancestor_info.get("ancestors", []),
            })
        except Exception:
            continue
    info["orphanSelections"] = orphans

    # 4) Market group count
    info["marketGroupCount"] = root.locator("obg-m-event-market-group").count()

    # 5) innerHTML snippet of the root
    try:
        info["innerHTMLSnippet"] = root.evaluate("el => el.innerHTML.substring(0, 3000)")
    except Exception:
        info["innerHTMLSnippet"] = "Error getting innerHTML"

    return info


def scrape_odds(page, debug=False):
    page.wait_for_selector(ROOT_SELECTOR)
    page.wait_for_timeout(3000)

    # Phase 1: optional debug dump
    if debug:
        _expand_accordions(page)
        info = _debug_dom_structure(page)
        debug_file = "debug_dom_structure.json"
        with open(debug_file, "w", encoding="utf-8") as f:
            json.dump(info, f, indent=2, ensure_ascii=False)
        print(f"\n  [DEBUG] DOM structure saved → {debug_file}")
        return {}

    root = page.locator(ROOT_SELECTOR).first
    markets = {}

    # Discover tab buttons using Playwright locators (shadow-DOM safe)
    tab_selectors = ['[role="tab"]', '[test-id*="tab"]', '[test-id*="Tab"]']
    tab_els = []
    tab_selector_used = None
    for sel in tab_selectors:
        candidates = root.locator(sel).all()
        if len(candidates) > 1:
            tab_els = candidates
            tab_selector_used = sel
            break

    if tab_els:
        # Build list of (name, element), deduplicate by name, skip junk
        seen_names = set()
        unique_tabs = []
        for t in tab_els:
            try:
                name = t.inner_text().strip()[:40]
            except Exception:
                continue
            if not name or name == "0" or name in seen_names:
                continue
            seen_names.add(name)
            unique_tabs.append((name, t))

        tab_names = [n for n, _ in unique_tabs]
        print(f"  Found {len(unique_tabs)} unique tabs: {tab_names}")
        for tab_name, tab_el in unique_tabs:
            try:
                print(f"    Scraping tab: {tab_name}...")
                tab_el.click(force=True)
                page.wait_for_timeout(1500)
            except Exception:
                continue
            _expand_accordions(page)
            root = page.locator(ROOT_SELECTOR).first
            _scrape_current_view(page, root, markets)
    else:
        # No tabs found — just scrape the single view
        _expand_accordions(page)
        _scrape_current_view(page, root, markets)

    return markets


# ─────────────────────────────────────────
# FLOWS
# ─────────────────────────────────────────

def _new_context(browser):
    return browser.new_context(
        ignore_https_errors=True,
        user_agent=USER_AGENT,
        locale="en-US",
        viewport={"width": 1366, "height": 900},
    )


# ─────────────────────────────────────────
# SCRAPING - ODDS (widget API)
#
# The Match Stats markets (Total Throw-ins, Total Offsides, team totals, …)
# render as virtualized/collapsed accordions whose odds never materialize in
# the headless DOM. Instead we hit the same JSON widget API the site uses:
#   1. event/v2      → accordionSummaries → every market id for the event
#   2. event-market  → batch-fetch those ids → markets + selections with odds
# Selection labels already arrive as "Over 5.5"/"Under 5.5", matching the
# arb finder's parser. The API rejects calls missing the site's x-sb-* headers,
# so we capture a live set off the page's own requests and replay them.
# ─────────────────────────────────────────

def capture_widget_headers(page, store):
    """Attach a request listener that records the first widget API headers seen."""
    def on_request(req):
        if "/api/sb/v1/widgets/" in req.url and not store:
            h = dict(req.headers)
            for k in ("content-length", "host", ":authority", ":method", ":path", ":scheme"):
                h.pop(k, None)
            store.update(h)
    page.on("request", on_request)


def scrape_odds_api(page, event_id, headers):
    """Fetch all markets for an event via the widget API. Returns {market: [{name, odds}]}."""
    req = page.request

    # 1) event schema → every market id (+ fallback label) for this event
    schema_url = f"{API_ORIGIN}/api/sb/v1/widgets/event/v2?eventId={event_id}&subTabs=133"
    try:
        schema = req.get(schema_url, headers=headers).json().get("data", {})
    except Exception as e:
        print(f"  Schema fetch failed: {e}")
        return {}
    summaries = schema.get("accordionSummaries", {})
    id_to_label = {}
    all_ids = []
    for tmpl, summ in summaries.items():
        for mid in summ.get("marketIds", []) or []:
            all_ids.append(mid)
            id_to_label[mid] = summ.get("label", tmpl)
    if not all_ids:
        print("  No market ids in schema (headers may be stale).")
        return {}

    # 2) batch-fetch market odds
    markets = {}
    selections = []
    CHUNK = 40
    for i in range(0, len(all_ids), CHUNK):
        chunk = all_ids[i:i + CHUNK]
        url = (f"{API_ORIGIN}/api/sb/v1/widgets/event-market/v1"
               f"?includescoreboards=true&marketids={','.join(chunk)}")
        try:
            data = req.get(url, headers=headers).json().get("data", {})
        except Exception:
            continue
        for mo in data.get("markets", []) or []:
            markets[mo["id"]] = mo
        selections.extend(data.get("marketSelections", []) or [])

    # 3) build {market label: [{name, odds}]}, merging all lines of a market
    by_mkt = {}
    for s in selections:
        by_mkt.setdefault(s["marketId"], []).append(s)
    out = {}
    for mid, mo in markets.items():
        label = mo.get("marketFriendlyName") or id_to_label.get(mid, "")
        if not label:
            continue
        items = out.setdefault(label, [])
        seen = {it["name"] for it in items}
        for s in sorted(by_mkt.get(mid, []), key=lambda x: x.get("sortOrder", 0)):
            name = s.get("label") or s.get("alternateLabel")
            odds = s.get("odds")
            if name is None or odds is None or name in seen:
                continue
            seen.add(name)
            items.append({"name": name, "odds": odds})
    return {k: v for k, v in out.items() if v}


def flow_matches():
    header("Scrape Today's Matches")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])

    url = f"{BASE}/{path}?tab=liveAndUpcoming"
    print(f"\n  Loading {league_name}...")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = _new_context(browser).new_page()
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(6000)
        dismiss_overlays(page)
        matches = scrape_matches(page, path)
        browser.close()

    if not matches:
        print("  No matches found today.")
        return

    filename = f"{league_name.lower().replace(' ', '_')}_today.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump({"league": league_name, "matches": matches}, f, indent=2, ensure_ascii=False)

    print(f"\n  Saved {len(matches)} matches → {filename}")


def flow_odds(debug=False):
    header("Debug DOM Structure" if debug else "Scrape Match Odds")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])

    url = f"{BASE}/{path}?tab=liveAndUpcoming"
    print(f"\n  Loading {league_name}...")

    api_headers = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = _new_context(browser)
        page = context.new_page()
        capture_widget_headers(page, api_headers)

        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(6000)
        dismiss_overlays(page)
        matches = scrape_matches(page, path)

        if not matches:
            print("  No matches found today.")
            browser.close()
            return

        header("Select Match")
        match = select("Select match", matches, label_fn=lambda m: m["name"])

        print(f"\n  Loading odds for: {match['name']}")

        if debug:
            # Old DOM dump path (kept for the debug menu). SPA-click the row.
            target = next((r for r in page.locator("obg-event-row-container").all()
                           if r.get_attribute("test-id") == match["event_id"]), None)
            if target:
                dismiss_overlays(page)
                try:
                    target.scroll_into_view_if_needed()
                    target.click()
                    page.wait_for_timeout(3000)
                    scrape_odds(page, debug=True)
                except Exception as e:
                    print(f"  Click failed: {e}")
            browser.close()
            return

        # Odds come from the widget API (the Match Stats markets never render in
        # the headless DOM). We just need the event id + a live set of headers,
        # which the league page's own widget requests already provided.
        if not api_headers:
            page.wait_for_timeout(2000)
        if not api_headers:
            print("  Could not capture widget API headers.")
            browser.close()
            return
        markets = scrape_odds_api(page, match["event_id"], api_headers)
        browser.close()

    filename = match["name"].replace(" ", "_").lower() + "_odds_bson.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(markets, f, indent=2, ensure_ascii=False)

    print(f"\n  Saved {len(markets)} markets → {filename}")


# ─────────────────────────────────────────
# MAIN MENU
# ─────────────────────────────────────────

ACTIONS = [
    ("Scrape today's matches",       flow_matches),
    ("Scrape odds for a match",      flow_odds),
    ("Debug: dump DOM structure",    lambda: flow_odds(debug=True)),
    ("Exit",                         None),
]

def main():
    print("\n  Football Odds Scraper")
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
