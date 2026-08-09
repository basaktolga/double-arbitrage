"""
exonbet (Digitain) WC-2026 stat-market scraper — 5th independent book.

Digitain serves prematch markets as a single GET:
    /<guid>/common/getevent?eventId=<id>&isLive=false&langId=2&partnerId=742
The body is single-byte XOR obfuscated (key 8) with a framing byte (0x04)
that OVERWRITES content every 8192 bytes — lossy, so we (a) request English
(langId=2) where everything is ASCII and (b) identify stat sub-events by the
numeric EPTId rather than by their (corruptible) name.

Each getevent returns the whole "event family": the main match plus half
sub-events and one sub-event per officiated stat. Inside each stat sub-event
the "Total" stake groups carry Over/Under with line A.

Output: one  {t1}_-_{t2}_odds_exonbet.json  per match, in bson-style keys.
"""
import os, sys, json, re
from patchright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(os.path.dirname(HERE), "rainbet-scraper", ".pr-sites")
GUID = "1db1dafc-e851-495e-88f6-22668d9c9600"
FEED = f"https://sport.cnsprt2.com/{GUID}"
LIST_URL = os.environ.get("EXONBET_LIST_URL", "https://exonbet264.com/en/sport/pre-match/?sport=1&champ=52530")

# Digitain EPTId (period/sub-event type) -> canonical English stat name.
STAT_BY_PTID = {
    4: "Corners", 5: "Cards", 6: "Shots on Target", 7: "Fouls",
    8: "Offsides", 9: "Throw-ins", 10: "Goal Kicks", 14: "Shots",
}

# Full-match key templates per stat (mirror arb_finder MAPPING exactly).
FULL_KEYS = {
    "Corners":         ("Total Corners", "{t1} - Total Corners", "{t2} - Total Corners"),
    "Offsides":        ("Total Offsides", "{t1} -Total Offsides", "{t2} -Total Offsides"),
    "Throw-ins":       ("Total Throw-ins", "{t1} – Total Throw-ins", "{t2} – Total Throw-ins"),
    "Fouls":           ("Total Fouls Conceded", "{t1} - Total Fouls", "{t2} - Total Fouls"),
    "Goal Kicks":      ("Total Goal Kicks", "{t1} Total Goal Kicks", "{t2} Total Goal Kicks"),
    "Shots":           ("Total Shots", "{t1} - Total Shots", "{t2} - Total Shots"),
    "Shots on Target": ("Total Shots on Target", "{t1} - Total Shots on Target", "{t2} - Total Shots on Target"),
    "Cards":           ("Total Cards", "{t1} - Total Cards", "{t2} - Total Cards"),
}
# Stats for which arb_finder also has 1st/2nd-half markets.
HALF_STATS = {"Corners", "Offsides", "Throw-ins", "Fouls"}

# English GN fragments that mark a group as NOT a plain Over/Under total.
BAD_GN = ("asian", "3 way", "min.", "minutes", "odd", "even", "race",
          "handicap", "corner", "result", "chance", "scoring")


def fmt_line(a):
    f = float(a)
    return str(int(f)) if f.is_integer() else ("%g" % f)


def classify_gn(gn):
    """Return (half, scope) for a plain Over/Under total group, else None.
    half: 0 full / 1 first / 2 second. scope: 'total'/'t1'/'t2'."""
    low = " ".join(gn.split()).lower().rstrip(":")
    if any(b in low for b in BAD_GN):
        return None
    if "total" not in low:
        return None
    half = 0
    if "1st half" in low:
        half = 1
    elif "2nd half" in low:
        half = 2
    scope = "total"
    if "team 1" in low:
        scope = "t1"
    elif "team 2" in low:
        scope = "t2"
    return half, scope


def build_key(stat, half, scope):
    if half == 0:
        return FULL_KEYS[stat][{"total": 0, "t1": 1, "t2": 2}[scope]]
    if stat not in HALF_STATS:
        return None
    h = "1st" if half == 1 else "2nd"
    if scope == "total":
        return f"{h} Half - Total {stat}"
    tkn = "{t1}" if scope == "t1" else "{t2}"
    return f"{h} Half - {tkn} Total {stat}"


def decode_body(text):
    """Decode Digitain XOR body -> JSON object/list."""
    raw = text.encode("latin-1", "ignore")
    candidates = []
    for b0 in raw[:4]:
        candidates += [b0 ^ 0x5B, b0 ^ 0x7B]
    candidates += list(range(256))
    seen = set()
    for k in candidates:
        if k in seen:
            continue
        seen.add(k)
        d = bytes(x ^ k for x in raw)
        d = bytes(x for x in d if x >= 0x20 or x in (9, 10, 13))
        s = d.decode("utf-8", "ignore")
        i = s.find("[")
        j = s.find("{")
        i = min([p for p in (i, j) if p >= 0] or [-1])
        if i < 0:
            continue
        try:
            return json.loads(s[i:])
        except Exception:
            continue
    return None


def base_teams(events):
    """English (t1, t2) from the main (non-sub) event's name."""
    main = None
    for e in events:
        if e.get("EPTId") == 0 and not e.get("SEPN"):
            main = e
            break
    if main is None:
        main = events[0]
    n = main.get("N") or ""
    t1, _, t2 = n.partition(" - ")
    return t1.strip(), t2.strip()


def parse_family(events):
    """events: decoded list for one match. Returns (t1, t2, markets dict)."""
    t1, t2 = base_teams(events)
    markets = {}

    def add(key, name, odds):
        key = key.replace("{t1}", t1).replace("{t2}", t2)
        markets.setdefault(key, []).append({"name": name, "odds": odds})

    for ev in events:
        stat = STAT_BY_PTID.get(ev.get("EPTId"))
        if not stat:
            continue
        for st in ev.get("StakeTypes") or []:
            stakes = st.get("Stakes") or []
            if not stakes:
                continue
            cg = classify_gn(stakes[0].get("GN") or "")
            if not cg:
                continue
            key = build_key(stat, *cg)
            if not key:
                continue
            for s in stakes:
                sn = (s.get("N") or "").strip()
                a, f = s.get("A"), s.get("F")
                if a is None or f is None:
                    continue
                if sn == "Over":
                    side = "Over"
                elif sn == "Under":
                    side = "Under"
                else:
                    continue
                add(key, f"{side} {fmt_line(a)}", f)
    return t1, t2, markets


def fetch_event(pg, eid):
    url = (f"{FEED}/common/getevent?eventId={eid}"
           "&isLive=false&langId=2&partnerId=742&countryCode=TR")
    js = ("async (u)=>{const r=await fetch(u,{credentials:'include'});"
          "return await r.text();}")
    return decode_body(pg.evaluate(js, url))


def scrape_all(out_dir="."):
    written = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE, channel="chrome", headless=False, no_viewport=True,
            # Headless is blocked by Cloudflare, so run headful but off-screen
            # so the window never appears on the user's display.
            args=["--window-position=-3000,-3000", "--window-size=1280,900"])
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()

        captured = {"list": None}

        def on_resp(r):
            if "gettopeventslist" not in r.url.lower():
                return
            try:
                body = r.body()
            except Exception:
                return
            j = decode_body(body.decode("latin-1", "ignore"))
            if isinstance(j, list) and j:
                captured["list"] = j

        pg.on("response", on_resp)
        pg.goto(LIST_URL, wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(6000)

        lst = captured["list"] or []
        ids, seen = [], set()
        for e in lst:
            eid = e.get("Id")
            if isinstance(eid, int) and eid not in seen and " - " in (e.get("N") or ""):
                seen.add(eid); ids.append(eid)
        print(f"WC events found: {len(ids)}", flush=True)

        for eid in ids:
            fam = None
            for attempt in range(3):
                try:
                    fam = fetch_event(pg, eid)
                except Exception as e:
                    print(f"  ! {eid}: fetch failed {e}", flush=True)
                if isinstance(fam, list):
                    break
                pg.wait_for_timeout(800)
            if not isinstance(fam, list):
                print(f"  ! {eid}: decode failed (3 tries)", flush=True)
                continue
            t1, t2, markets = parse_family(fam)
            label = f"{t1} - {t2}"
            if not markets:
                print(f"  - {label}: no stat markets", flush=True)
                continue
            fn = os.path.join(
                out_dir,
                f"{t1}_-_{t2}_odds_exonbet.json".replace(" ", "_").lower())
            json.dump(markets, open(fn, "w", encoding="utf-8"),
                      indent=2, ensure_ascii=False)
            written.append(fn)
            print(f"  ✓ {label}: {len(markets)} markets -> {os.path.basename(fn)}", flush=True)

        ctx.close()
    print(f"DONE: wrote {len(written)} files", flush=True)
    return written


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    scrape_all(out)
