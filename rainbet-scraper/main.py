#!/usr/bin/env python3
"""
Rainbet (SptPub / BetBy feed) football odds scraper.

Rainbet sits behind a Cloudflare Turnstile that ordinary Playwright can't pass,
so we use *patchright* (a stealth-patched Playwright) with real Chrome. Once the
challenge clears, odds come from the SptPub JSON API:
  - prematch feed:  markets[typeId][specifier][outcomeId] = {"k": odds}
  - descriptions:   typeId -> market name (with {$competitor1/2} + {total}/{hcp})
Output uses bson-style market keys so it slots into the existing arb finder.
"""
from patchright.sync_api import sync_playwright
import json
import sys
import os
import re

BASE = os.environ.get("RAINBET_BASE", "https://rainbet.com/sportsbook")
API = os.environ.get("RAINBET_API", "https://api-a-c7818b61-600.sptpub.com")
BRAND = "2374656571012681728"
PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pr-profile")

LEAGUES = [
    ("World Cup 2026", "soccer/international/world-cup-1670073988614852608"),
    ("Soccer (all)",   "soccer-1"),
]

# SptPub total/handicap outcomes are universal: 12 = Over, 13 = Under.
OVER_UNDER = {"12": "Over", "13": "Under"}

# Map SptPub market *type id* (stable across events) -> bson-style key template.
# {c1}=home, {c2}=away. Dash/spacing follows the bson naming so files are
# interchangeable in the arb finder. Only stat over/under totals are kept.
MARKET_IDS = {
    # ── full match ──
    "166": "Total Corners",
    "167": "{c1} - Total Corners",
    "168": "{c2} - Total Corners",
    "139": "Total Cards",
    "140": "{c1} - Total Cards",
    "141": "{c2} - Total Cards",
    "150125": "Total Fouls Conceded",
    "150127": "{c1} - Total Fouls",
    "150128": "{c2} - Total Fouls",
    "150037": "Total Goal Kicks",
    "150039": "{c1} Total Goal Kicks",
    "150040": "{c2} Total Goal Kicks",
    "50256": "Total Offsides",
    "50258": "{c1} -Total Offsides",
    "50259": "{c2} -Total Offsides",
    "150042": "Total Goalkeepers Saves",
    "50242": "Total Shots",
    "50243": "{c1} - Total Shots",
    "50244": "{c2} - Total Shots",
    "50237": "Total Shots on Target",
    "50238": "{c1} - Total Shots on Target",
    "50239": "{c2} - Total Shots on Target",
    "50248": "Total Throw-ins",
    "50249": "{c1} – Total Throw-ins",
    "50250": "{c2} – Total Throw-ins",
    # ── 1st half ──
    "177": "1st Half - Total Corners",
    "178": "1st Half - {c1} Total Corners",
    "179": "1st Half - {c2} Total Corners",
    "152": "1st Half - Total Cards",
    "153": "1st Half - {c1} Total Cards",
    "154": "1st Half - {c2} Total Cards",
    "50320": "1st Half - Total Offsides",
    "50321": "1st Half - {c1} Total Offsides",
    "50322": "1st Half - {c2} Total Offsides",
    "50253": "1st Half - Total Throw-ins",
    "60141": "1st Half - Total Goal Kicks",
}


# ─────────────────────────────────────────
# MENU HELPERS
# ─────────────────────────────────────────

def select(prompt, options, label_fn=str):
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
    print(f"\n{'─' * 40}\n  {title}\n{'─' * 40}")


# ─────────────────────────────────────────
# BROWSER
# ─────────────────────────────────────────

def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _new_context(p):
    return p.chromium.launch_persistent_context(
        PROFILE, channel="chrome", headless=False, no_viewport=True,
        # Headless is blocked by Cloudflare, so run headful but off-screen
        # so the window never appears on the user's display.
        args=["--window-position=-3000,-3000", "--window-size=1280,900"],
    )


def _wait_cleared(page, secs=50):
    for _ in range(int(secs / 2)):
        page.wait_for_timeout(2000)
        t = _safe(lambda: page.title(), "") or ""
        if "moment" not in t.lower() and "just a" not in t.lower():
            return True
    return False


def attach_feed_capture(page, store):
    """Merge every SptPub prematch feed's events into store['events'] as they load."""
    store.setdefault("events", {})

    def on_resp(r):
        if "sptpub.com" not in r.url or "prematch" not in r.url:
            return
        try:
            data = json.loads(r.body())
        except Exception:
            return
        for eid, ev in (data.get("events") or {}).items():
            if not ev:
                continue
            # SptPub spreads an event's markets across several prematch chunks,
            # so merge market dicts rather than replacing the whole event.
            slot = store["events"].setdefault(eid, {"markets": {}})
            slot.setdefault("markets", {}).update(ev.get("markets") or {})

    page.on("response", on_resp)


# ─────────────────────────────────────────
# MATCH LIST
# ─────────────────────────────────────────

# Event links look like .../world-cup/germany-curacao-2609327863110971393 ;
# the league/tournament header link (.../world-cup-167...) has no second team,
# so we require a '/<slug>-<id>' segment that itself sits under another segment.
EVENT_RE = re.compile(r"^/sportsbook/.+/(?P<slug>[a-z0-9]+(?:-[a-z0-9]+)+)-(?P<id>\d{15,})$")


def scrape_matches(page, retries=6):
    """Return [{name, event_id, link}] from the loaded league page (retrying)."""
    for _ in range(retries):
        hrefs = _safe(lambda: page.eval_on_selector_all(
            "a[href*='/sportsbook/']",
            "els => els.map(e => e.getAttribute('href'))"), []) or []
        seen, out = set(), []
        for h in hrefs:
            if not h:
                continue
            m = EVENT_RE.match(h)
            if not m:
                continue
            # Event links sit one level deeper than league/tournament links
            # (.../world-cup/germany-curacao-<id> vs .../world-cup-<id>), so
            # require at least 4 path segments after the leading '/sportsbook/'.
            if h.strip("/").count("/") < 4:
                continue
            eid = m.group("id")
            if eid in seen:
                continue
            seen.add(eid)
            out.append({"name": m.group("slug").replace("-", " ").title(),
                        "event_id": eid, "link": "https://rainbet.com" + h})
        if len(out) >= 2:
            return out
        page.wait_for_timeout(2500)
    return out


# ─────────────────────────────────────────
# ODDS (SptPub feed)
# ─────────────────────────────────────────

def _find_competitors(obj):
    """Recursively locate a 2-entry 'competitors' list and return their names."""
    if isinstance(obj, dict):
        c = obj.get("competitors")
        if isinstance(c, list) and len(c) >= 2 and all(isinstance(x, dict) for x in c[:2]):
            return c[0].get("name"), c[1].get("name")
        for v in obj.values():
            r = _find_competitors(v)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_competitors(v)
            if r:
                return r
    return None


def _competitor_names(page, event_id, slug_name):
    """Home/away names from SptPub's event endpoint; fall back to the slug."""
    data = _safe(lambda: page.request.get(
        f"{API}/api/v4/prematch/brand/{BRAND}/event/en/{event_id}",
        headers={"accept": "application/json"}).json(), {}) or {}
    names = _find_competitors(data)
    if names and names[0] and names[1]:
        return names[0], names[1]
    parts = slug_name.split()
    mid = len(parts) // 2
    return " ".join(parts[:mid]) or "Home", " ".join(parts[mid:]) or "Away"


def scrape_odds(page, event_id, slug_name, feed_events):
    """Parse markets for event_id from the already-captured prematch feed events."""
    if event_id not in feed_events:
        print("  Event not present in captured odds feed.")
        return {}

    c1, c2 = _competitor_names(page, event_id, slug_name)

    markets = feed_events[event_id]["markets"]
    out = {}
    for mid, specs in markets.items():
        tmpl = MARKET_IDS.get(mid)
        if not tmpl:
            continue
        key_base = tmpl.replace("{c1}", c1).replace("{c2}", c2)
        items = out.setdefault(key_base, [])
        for spec, outcomes in specs.items():
            total = None
            m = re.search(r"total=([0-9.]+)", spec)
            if m:
                total = m.group(1)
            for oid, val in outcomes.items():
                side = OVER_UNDER.get(oid)
                odds = val.get("k")
                if side is None or odds is None or total is None:
                    continue
                try:
                    odds = float(odds)
                except (TypeError, ValueError):
                    continue
                items.append({"name": f"{side} {total}", "odds": odds})
        if not items:
            out.pop(key_base, None)
    return out, c1, c2


# ─────────────────────────────────────────
# FLOWS
# ─────────────────────────────────────────

def flow_matches():
    header("Scrape Today's Matches")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])
    url = f"{BASE}/{path}"
    print(f"\n  Loading {league_name}... (solve the Cloudflare check if it appears)")
    with sync_playwright() as p:
        ctx = _new_context(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url, wait_until="domcontentloaded")
        _wait_cleared(page)
        page.wait_for_timeout(5000)
        matches = scrape_matches(page)
        ctx.close()
    if not matches:
        print("  No matches found.")
        return
    fn = f"{league_name.lower().replace(' ', '_')}_today.json"
    json.dump({"league": league_name, "matches": matches},
              open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"\n  Saved {len(matches)} matches → {fn}")


def flow_odds():
    header("Scrape Match Odds")
    league_name, path = select("Select league", LEAGUES, label_fn=lambda l: l[0])
    url = f"{BASE}/{path}"
    print(f"\n  Loading {league_name}... (solve the Cloudflare check if it appears)")
    feed = {"events": {}}
    with sync_playwright() as p:
        ctx = _new_context(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        attach_feed_capture(page, feed)
        page.goto(url, wait_until="domcontentloaded")
        _wait_cleared(page)
        page.wait_for_timeout(5000)
        matches = scrape_matches(page)
        if not matches:
            print("  No matches found.")
            ctx.close()
            return
        header("Select Match")
        match = select("Select match", matches, label_fn=lambda m: m["name"])
        print(f"\n  Loading odds for: {match['name']}")
        # ensure the event's full markets are loaded: open its page so its
        # prematch feed fires (captured by the listener attached below)
        page.goto(match["link"], wait_until="domcontentloaded")
        _wait_cleared(page)
        page.wait_for_timeout(4000)
        # scroll through the event page so BetBy lazy-loads every market group
        # (corners, bookings, …) — their prematch chunks fire on scroll
        for _ in range(12):
            _safe(lambda: page.mouse.wheel(0, 1200))
            page.wait_for_timeout(900)
        page.wait_for_timeout(2000)
        result = scrape_odds(page, match["event_id"], match["name"], feed["events"])
        ctx.close()
    if not result:
        return
    markets, c1, c2 = result
    fn = f"{c1}_-_{c2}_odds_rainbet.json".replace(" ", "_").lower()
    json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    total = sum(len(v) for v in markets.values())
    print(f"\n  Saved {len(markets)} markets ({total} selections) → {fn}")


ACTIONS = [
    ("Scrape today's matches", flow_matches),
    ("Scrape odds for a match", flow_odds),
    ("Exit", None),
]


def main():
    print("\n  Rainbet Football Odds Scraper")
    print("  (a Chrome window opens; solve the Cloudflare check once if shown)")
    while True:
        header("Main Menu")
        _, fn = select("Select action", ACTIONS, label_fn=lambda a: a[0])
        if fn is None:
            print("Bye.")
            break
        fn()
        input("\n  Press Enter to return to main menu...")


if __name__ == "__main__":
    main()
