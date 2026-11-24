"""
Book registry and odds-file normalisation for arb_finder.

Every scraped odds file is turned into one shape before any arb maths runs:

    {market_id: {line: {"Over": odds, "Under": odds}}}

so the finder compares any number of books on equal terms. Adding a website means
writing its scraper; nothing in here or in arb_finder.py has to change as long as
the scraper writes `<match>_odds_<book>.json` in one of these formats:

  canonical  (recommended for new books)
      {"book": "k9win", "teams": ["Spain", "Uruguay"],
       "markets": {"corners_total": {"9.5": {"over": 1.91, "under": 1.95}},
                   "corners_t1":    {"4.5": {"over": 1.80, "under": 2.00}}}}
      Market ids are the `id`s in MAPPING below; `t1` is teams[0] (home).

  bson-style  {"Total Corners": [{"name": "Over 9.5", "odds": 1.91}, ...],
               "Spain - Total Corners": [...], ...}
  bwin-style  {"Corners": {"Total": [{"name": "Total Over 9.5", "odds": 1.9}, ...],
                           "Total 1": [...], "1X2": [...]}, ...}

The format is sniffed from the content, so a new book that copies an existing
book's output works with zero registration. BOOK_FORMATS only pins it for the
books we already know.
"""

import re
from collections import Counter
from pathlib import Path

# Each comparable market. `bwin_*` locate it in bwin-style files, `bson_mkt` in
# bson-style files ({t1}/{t2} = team names), `id` is the canonical key.
# bwin's per-team "Total 1/2" lists are reversed relative to everyone else.
MAPPING = [
    {"id": "corners_total",   "bwin_cat": "Corners",                "bwin_mkt": "Total",   "bson_mkt": "Total Corners"},
    {"id": "corners_t1",      "bwin_cat": "Corners",                "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Corners",         "bwin_reversed": True},
    {"id": "corners_t2",      "bwin_cat": "Corners",                "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Corners",         "bwin_reversed": True},
    {"id": "offsides_total",  "bwin_cat": "Offsides",               "bwin_mkt": "Total",   "bson_mkt": "Total Offsides"},
    {"id": "offsides_t1",     "bwin_cat": "Offsides",               "bwin_mkt": "Total 1", "bson_mkt": "{t1} -Total Offsides",         "bwin_reversed": True},
    {"id": "offsides_t2",     "bwin_cat": "Offsides",               "bwin_mkt": "Total 2", "bson_mkt": "{t2} -Total Offsides",         "bwin_reversed": True},
    {"id": "goalkicks_total", "bwin_cat": "Goal kicks",             "bwin_mkt": "Total",   "bson_mkt": "Total Goal Kicks"},
    {"id": "goalkicks_t1",    "bwin_cat": "Goal kicks",             "bwin_mkt": "Total 1", "bson_mkt": "{t1} Total Goal Kicks",        "bwin_reversed": True},
    {"id": "goalkicks_t2",    "bwin_cat": "Goal kicks",             "bwin_mkt": "Total 2", "bson_mkt": "{t2} Total Goal Kicks",        "bwin_reversed": True},
    {"id": "fouls_total",     "bwin_cat": "Fouls",                  "bwin_mkt": "Total",   "bson_mkt": "Total Fouls Conceded"},
    {"id": "fouls_t1",        "bwin_cat": "Fouls",                  "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Fouls",           "bwin_reversed": True},
    {"id": "fouls_t2",        "bwin_cat": "Fouls",                  "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Fouls",           "bwin_reversed": True},
    {"id": "throwins_total",  "bwin_cat": "Throw-ins",              "bwin_mkt": "Total",   "bson_mkt": "Total Throw-ins"},
    {"id": "throwins_t1",     "bwin_cat": "Throw-ins",              "bwin_mkt": "Total 1", "bson_mkt": "{t1} – Total Throw-ins", "bwin_reversed": True},
    {"id": "throwins_t2",     "bwin_cat": "Throw-ins",              "bwin_mkt": "Total 2", "bson_mkt": "{t2} – Total Throw-ins", "bwin_reversed": True},
    {"id": "shots_total",     "bwin_cat": "Shots Towards The Goal", "bwin_mkt": "Total",   "bson_mkt": "Total Shots"},
    {"id": "shots_t1",        "bwin_cat": "Shots Towards The Goal", "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Shots",           "bwin_reversed": True},
    {"id": "shots_t2",        "bwin_cat": "Shots Towards The Goal", "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Shots",           "bwin_reversed": True},
    {"id": "shots_ot_total",  "bwin_cat": "Shots On Target",        "bwin_mkt": "Total",   "bson_mkt": "Total Shots on Target"},
    {"id": "shots_ot_t1",     "bwin_cat": "Shots On Target",        "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Shots on Target", "bwin_reversed": True},
    {"id": "shots_ot_t2",     "bwin_cat": "Shots On Target",        "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Shots on Target", "bwin_reversed": True},
    {"id": "saves_total",     "bwin_cat": "Saves",                  "bwin_mkt": "Total",   "bson_mkt": "Total Goalkeepers Saves"},
    {"id": "saves_t1",        "bwin_cat": "Saves",                  "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Goalkeeper Saves", "bwin_reversed": True},
    {"id": "saves_t2",        "bwin_cat": "Saves",                  "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Goalkeeper Saves", "bwin_reversed": True},
    {"id": "tackles_total",   "bwin_cat": "Tackles",                "bwin_mkt": "Total",   "bson_mkt": "Total Tackles"},
    {"id": "tackles_t1",      "bwin_cat": "Tackles",                "bwin_mkt": "Total 1", "bson_mkt": "{t1} Total Tackles",           "bwin_reversed": True},
    {"id": "tackles_t2",      "bwin_cat": "Tackles",                "bwin_mkt": "Total 2", "bson_mkt": "{t2} Total Tackles",           "bwin_reversed": True},
    # Cards (officiated)
    {"id": "cards_total",     "bwin_cat": "Cards",                  "bwin_mkt": "Total",   "bson_mkt": "Total Cards"},
    {"id": "cards_t1",        "bwin_cat": "Cards",                  "bwin_mkt": "Total 1", "bson_mkt": "{t1} - Total Cards",                "bwin_reversed": True},
    {"id": "cards_t2",        "bwin_cat": "Cards",                  "bwin_mkt": "Total 2", "bson_mkt": "{t2} - Total Cards",                "bwin_reversed": True},
    # 1st-half markets
    {"id": "corners_1h",      "bwin_cat": "1st half Corners",       "bwin_mkt": "Total",   "bson_mkt": "1st Half - Total Corners"},
    {"id": "corners_1h_t1",   "bwin_cat": "1st half Corners",       "bwin_mkt": "Total 1", "bson_mkt": "1st Half - {t1} Total Corners",     "bwin_reversed": True},
    {"id": "corners_1h_t2",   "bwin_cat": "1st half Corners",       "bwin_mkt": "Total 2", "bson_mkt": "1st Half - {t2} Total Corners",     "bwin_reversed": True},
    {"id": "offsides_1h",     "bwin_cat": "1st half Offsides",      "bwin_mkt": "Total",   "bson_mkt": "1st Half - Total Offsides"},
    {"id": "offsides_1h_t1",  "bwin_cat": "1st half Offsides",      "bwin_mkt": "Total 1", "bson_mkt": "1st Half - {t1} Total Offsides",    "bwin_reversed": True},
    {"id": "offsides_1h_t2",  "bwin_cat": "1st half Offsides",      "bwin_mkt": "Total 2", "bson_mkt": "1st Half - {t2} Total Offsides",    "bwin_reversed": True},
    {"id": "throwins_1h",     "bwin_cat": "1st half Throw-ins",     "bwin_mkt": "Total",   "bson_mkt": "1st Half - Total Throw-ins"},
    {"id": "throwins_1h_t1",  "bwin_cat": "1st half Throw-ins",     "bwin_mkt": "Total 1", "bson_mkt": "1st Half - {t1} Total Throw-ins",   "bwin_reversed": True},
    {"id": "throwins_1h_t2",  "bwin_cat": "1st half Throw-ins",     "bwin_mkt": "Total 2", "bson_mkt": "1st Half - {t2} Total Throw-ins",   "bwin_reversed": True},
    {"id": "fouls_1h",        "bwin_cat": "1st half Fouls",         "bwin_mkt": "Total",   "bson_mkt": "1st Half - Total Fouls"},
    {"id": "fouls_1h_t1",     "bwin_cat": "1st half Fouls",         "bwin_mkt": "Total 1", "bson_mkt": "1st Half - {t1} Total Fouls",       "bwin_reversed": True},
    {"id": "fouls_1h_t2",     "bwin_cat": "1st half Fouls",         "bwin_mkt": "Total 2", "bson_mkt": "1st Half - {t2} Total Fouls",       "bwin_reversed": True},
    # 2nd-half markets
    {"id": "corners_2h",      "bwin_cat": "2nd half Corners",       "bwin_mkt": "Total",   "bson_mkt": "2nd Half - Total Corners"},
    {"id": "corners_2h_t1",   "bwin_cat": "2nd half Corners",       "bwin_mkt": "Total 1", "bson_mkt": "2nd Half - {t1} Total Corners",     "bwin_reversed": True},
    {"id": "corners_2h_t2",   "bwin_cat": "2nd half Corners",       "bwin_mkt": "Total 2", "bson_mkt": "2nd Half - {t2} Total Corners",     "bwin_reversed": True},
    {"id": "offsides_2h",     "bwin_cat": "2nd half Offsides",      "bwin_mkt": "Total",   "bson_mkt": "2nd Half - Total Offsides"},
    {"id": "offsides_2h_t1",  "bwin_cat": "2nd half Offsides",      "bwin_mkt": "Total 1", "bson_mkt": "2nd Half - {t1} Total Offsides",    "bwin_reversed": True},
    {"id": "offsides_2h_t2",  "bwin_cat": "2nd half Offsides",      "bwin_mkt": "Total 2", "bson_mkt": "2nd Half - {t2} Total Offsides",    "bwin_reversed": True},
    {"id": "fouls_2h",        "bwin_cat": "2nd half Fouls",         "bwin_mkt": "Total",   "bson_mkt": "2nd Half - Total Fouls"},
    {"id": "fouls_2h_t1",     "bwin_cat": "2nd half Fouls",         "bwin_mkt": "Total 1", "bson_mkt": "2nd Half - {t1} Total Fouls",       "bwin_reversed": True},
    {"id": "fouls_2h_t2",     "bwin_cat": "2nd half Fouls",         "bwin_mkt": "Total 2", "bson_mkt": "2nd Half - {t2} Total Fouls",       "bwin_reversed": True},
]
MARKET_IDS = {m["id"] for m in MAPPING}
MARKET_LABEL = {m["id"]: m["bson_mkt"] for m in MAPPING}

# Known books and the format their scraper writes. Anything not listed is sniffed.
BOOK_FORMATS = {
    "bwin": "bwin",
    "bson": "bson",
    "rainbet": "bson",
    "betsolutions": "bson",
    "exonbet": "bson",
}

FORMATS = ("canonical", "bson", "bwin")

LINE_RE = re.compile(r'(Over|Under)\s*([0-9]+(?:\.[0-9]+)?)', re.I)
BOOK_SUFFIX_RE = re.compile(r'_odds_([a-z0-9]+)$', re.I)

BWIN_MARKERS = {"Corners", "Throw-ins", "Offsides", "Shots Towards The Goal", "Goal kicks", "Fouls"}
BSON_MARKERS = {"Total Corners", "Total Throw-ins", "Total Offsides", "Total Shots", "Total Goal Kicks"}

TEAM_SUFFIXES = (" - Total Corners", " - Total Shots", " – Total Throw-ins",
                 " -Total Offsides", " - Total Fouls", " Total Goal Kicks",
                 " - Total Cards", " - Total Shots on Target")


# ---------------------------------------------------------------- detection

def sniff_format(data):
    """Which of FORMATS a parsed odds file is in, or None."""
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("markets"), dict):
        return "canonical"
    keys = set(data.keys())
    bwin_hits = len(keys & BWIN_MARKERS)
    bson_hits = len(keys & BSON_MARKERS)
    if bwin_hits > bson_hits:
        return "bwin"
    if bson_hits > bwin_hits:
        return "bson"
    return None


def book_from_filename(path):
    m = BOOK_SUFFIX_RE.search(Path(path).stem)
    return m.group(1).lower() if m else None


def identify(path, data):
    """(book, format) for one file, or (None, None) if it isn't an odds file.

    Book: the `_odds_<book>` filename suffix, else the canonical "book" field,
    else the format name (legacy files without a suffix were bson or bwin)."""
    fmt = sniff_format(data)
    book = book_from_filename(path)
    if fmt == "canonical" and data.get("book"):
        book = book or str(data["book"]).lower()
    if book and not fmt:
        fmt = BOOK_FORMATS.get(book)
    if not fmt:
        return None, None
    return (book or fmt), fmt


# ---------------------------------------------------------------- teams

def bwin_teams(data):
    for cat in ("Corners", "Throw-ins", "Offsides", "Shots Towards The Goal", "Fouls"):
        c = data.get(cat)
        if not isinstance(c, dict):
            continue
        for mkt_name in ("1X2", "Match Result"):
            m = c.get(mkt_name)
            if m and len(m) >= 3:
                names = [e["name"] for e in m if e["name"] != "X"]
                if len(names) >= 2:
                    return names[0], names[1]
    return None, None


def bson_teams(data):
    """(team1, team2) from a bson-style file's '{team} - Total X' keys.

    Ordered by first appearance, which is home-then-away in every scraper."""
    cnt, first = Counter(), {}
    for i, k in enumerate(data):
        for s in TEAM_SUFFIXES:
            if k.endswith(s) and not k.startswith(("1st Half", "2nd Half")):
                t = k[:-len(s)]
                cnt[t] += 1
                first.setdefault(t, i)
    top = sorted((t for t, _ in cnt.most_common(2)), key=lambda t: first[t])
    return tuple((top + [None, None])[:2])


def file_teams(fmt, data):
    if fmt == "canonical":
        t = data.get("teams") or []
        return (t + [None, None])[:2] if len(t) >= 2 else (None, None)
    if fmt == "bwin":
        return bwin_teams(data)
    return bson_teams(data)


# ---------------------------------------------------------------- normalise

def parse_ou(entries):
    out = {}
    for e in entries or []:
        m = LINE_RE.search(str(e.get("name", "")))
        if not m or e.get("odds") is None:
            continue
        out.setdefault(float(m.group(2)), {})[m.group(1).capitalize()] = float(e["odds"])
    return out


def _norm_key(s):
    return re.sub(r'\s+', ' ', s.replace('–', '-').replace('—', '-')).strip().lower()


def find_bson_market(data, target):
    if target in data:
        return data[target]
    t = _norm_key(target)
    for k, v in data.items():
        nk = _norm_key(k)
        if nk == t or nk.replace(' ', '') == t.replace(' ', ''):
            return v
    return None


def team_alias(data, team):
    """The spelling this bson-style file uses for `team` (books differ:
    'Bosnia & Herzegovina' vs 'Bosnia and Herzegovina')."""
    keys = list(data.keys())
    if any(team in k for k in keys):
        return team
    candidates = set()
    for k in keys:
        for suffix in TEAM_SUFFIXES + (" - Total Goals", " - Clean Sheet", " Win No Bet"):
            if k.endswith(suffix):
                candidates.add(k[: -len(suffix)])
    first = team.split()[0].lower()
    for c in candidates:
        if c.lower().startswith(first):
            return c
    return team


def normalize(fmt, data, t1, t2):
    """{market_id: {line(float): {"Over": odds, "Under": odds}}} for one file,
    oriented so 'Over' always means more events and t1/t2 are the group's teams."""
    out = {}
    if fmt == "canonical":
        own = file_teams(fmt, data)
        swap = bool(t1 and own[0] and own[1] and _same_team(own[0], t2) and _same_team(own[1], t1))
        for mid, lines in (data.get("markets") or {}).items():
            if swap:
                mid = re.sub(r'_t([12])$', lambda m: "_t" + ("2" if m.group(1) == "1" else "1"), mid)
            for line, cell in (lines or {}).items():
                try:
                    ln = float(line)
                except (TypeError, ValueError):
                    continue
                cell = {k.capitalize(): float(v) for k, v in (cell or {}).items()
                        if k.lower() in ("over", "under") and v is not None}
                if cell:
                    out.setdefault(mid, {})[ln] = cell
        return out

    for m in MAPPING:
        if fmt == "bwin":
            c = data.get(m["bwin_cat"])
            ou = parse_ou(c.get(m["bwin_mkt"]) if isinstance(c, dict) else None)
            if m.get("bwin_reversed"):
                ou = {ln: {k: v for k, v in (("Over", d.get("Under")), ("Under", d.get("Over"))) if v}
                      for ln, d in ou.items()}
        else:
            if "{t" in m["bson_mkt"] and not (t1 and t2):
                continue
            key = m["bson_mkt"]
            if t1:
                key = key.replace("{t1}", team_alias(data, t1))
            if t2:
                key = key.replace("{t2}", team_alias(data, t2))
            ou = parse_ou(find_bson_market(data, key))
        if ou:
            out[m["id"]] = ou
    return out


def _same_team(a, b):
    if not a or not b:
        return False
    a, b = a.lower(), b.lower()
    return a == b or a.split()[0] == b.split()[0]
