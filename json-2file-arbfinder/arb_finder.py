#!/usr/bin/env python3
"""
Batch arbitrage finder: scans all .json odds files in the current directory,
auto-pairs bson and bwin files for the same match, and lists every arb found.

Usage:
    python3 arb_finder.py                       # scan all *.json in cwd
    python3 arb_finder.py file1.json file2.json # run on exactly these two files
"""

import json
import re
import sys
from pathlib import Path

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
    {"id": "throwins_t1",     "bwin_cat": "Throw-ins",              "bwin_mkt": "Total 1", "bson_mkt": "{t1} \u2013 Total Throw-ins", "bwin_reversed": True},
    {"id": "throwins_t2",     "bwin_cat": "Throw-ins",              "bwin_mkt": "Total 2", "bson_mkt": "{t2} \u2013 Total Throw-ins", "bwin_reversed": True},
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

LINE_RE = re.compile(r'(Over|Under)\s*([0-9]+(?:\.[0-9]+)?)', re.I)

# Tokens to ignore when matching filenames (filler words, suffixes like _odds, format tags, club suffixes)
STOPWORDS = {
    "odds", "bson", "bwin", "bwinner", "rainbet", "betsolutions", "exonbet", "json",
    "fc", "cf", "sc", "ac", "afc", "cp", "vs",
    "1909",  # Bologna 1909 -> Bologna
    "de", "the", "and",
}


def detect_format(data):
    keys = set(data.keys())
    bwin_markers = {"Corners", "Throw-ins", "Offsides", "Shots Towards The Goal", "Goal kicks", "Fouls"}
    bson_markers = {"Total Corners", "Total Throw-ins", "Total Offsides", "Total Shots", "Total Goal Kicks"}
    bwin_hits = len(keys & bwin_markers)
    bson_hits = len(keys & bson_markers)
    if bwin_hits > bson_hits:
        return "bwin"
    if bson_hits > bwin_hits:
        return "bson"
    return None


def filename_tokens(name):
    """Extract meaningful tokens from a filename for matching."""
    stem = Path(name).stem.lower()
    # Split on non-alphanumeric
    tokens = re.split(r'[^a-z0-9]+', stem)
    return {t for t in tokens if t and t not in STOPWORDS and not t.isdigit()}


def match_score(tokens_a, tokens_b):
    """Jaccard-like score: how well do these two filename token sets correspond to the same match?"""
    if not tokens_a or not tokens_b:
        return 0.0
    common = tokens_a & tokens_b
    if not common:
        return 0.0
    # We require at least 2 common tokens (one for each team) for a real match
    if len(common) < 2:
        return 0.0
    # Score: fraction of the smaller set that overlaps
    return len(common) / min(len(tokens_a), len(tokens_b))


def pair_files(files_with_format):
    """files_with_format: list of (path, fmt). Returns list of (bson_path, bwin_path, score)."""
    bson_files = [f for f, fmt in files_with_format if fmt == "bson"]
    bwin_files = [f for f, fmt in files_with_format if fmt == "bwin"]

    # Compute all candidate scores
    candidates = []
    for bs in bson_files:
        bs_tokens = filename_tokens(bs.name)
        for bw in bwin_files:
            bw_tokens = filename_tokens(bw.name)
            score = match_score(bs_tokens, bw_tokens)
            if score > 0:
                candidates.append((score, bs, bw))

    # Greedy assignment: take highest score first, mark both files as used
    candidates.sort(key=lambda x: -x[0])
    used_bson, used_bwin = set(), set()
    pairs = []
    for score, bs, bw in candidates:
        if bs in used_bson or bw in used_bwin:
            continue
        pairs.append((bs, bw, score))
        used_bson.add(bs)
        used_bwin.add(bw)

    unmatched_bson = [f for f in bson_files if f not in used_bson]
    unmatched_bwin = [f for f in bwin_files if f not in used_bwin]
    return pairs, unmatched_bson, unmatched_bwin


def detect_team_names(bwin_data):
    for cat in ("Corners", "Throw-ins", "Offsides", "Shots Towards The Goal", "Fouls"):
        c = bwin_data.get(cat)
        if not c:
            continue
        for mkt_name in ("1X2", "Match Result"):
            m = c.get(mkt_name)
            if m and len(m) >= 3:
                names = [e["name"] for e in m if e["name"] != "X"]
                if len(names) >= 2:
                    return names[0], names[1]
    return None, None


def find_bson_team_alias(bson_data, bwin_team):
    keys = list(bson_data.keys())
    if any(bwin_team in k for k in keys):
        return bwin_team
    candidates = set()
    for k in keys:
        for suffix in (" - Total Corners", " - Total Shots", " – Total Throw-ins",
                       " -Total Offsides", " - Total Fouls", " - Total Goals",
                       " Total Goal Kicks", " - Clean Sheet", " Win No Bet"):
            if k.endswith(suffix):
                candidates.add(k[: -len(suffix)])
    bwin_first = bwin_team.split()[0].lower()
    for c in candidates:
        if c.lower().startswith(bwin_first):
            return c
    return bwin_team


def find_bson_market(bson_data, target):
    if target in bson_data:
        return bson_data[target]
    norm = lambda s: re.sub(r'\s+', ' ', s.replace('–', '-').replace('—', '-')).strip().lower()
    t = norm(target)
    for k, v in bson_data.items():
        if norm(k) == t or norm(k).replace(' ', '') == t.replace(' ', ''):
            return v
    return None


def find_bwin_market(bwin_data, cat, mkt):
    c = bwin_data.get(cat)
    return c.get(mkt) if c else None


def parse_ou(entries):
    out = {}
    for e in entries:
        m = LINE_RE.search(e['name'])
        if not m:
            continue
        out.setdefault(float(m.group(2)), {})[m.group(1).capitalize()] = e['odds']
    return out


# bson, rainbet and betsolutions all use the "Total X" / "{team} - Total X" keys.
BSON_STYLE = ("bson", "rainbet", "betsolutions", "exonbet")


def book_lines(book, data, m, t1, t2):
    """Return {line: {'Over': odds, 'Under': odds}} for one book + mapping entry,
    already oriented so 'Over' means more events (bwin 'Total 1/2' is reversed)."""
    if book == "bwin":
        mkt = find_bwin_market(data, m["bwin_cat"], m["bwin_mkt"])
        if not mkt:
            return {}
        ou = parse_ou(mkt)
        if m.get("bwin_reversed"):
            ou = {ln: {"Over": d.get("Under"), "Under": d.get("Over")}
                  for ln, d in ou.items()}
        return ou
    # bson-style book
    a1 = find_bson_team_alias(data, t1)
    a2 = find_bson_team_alias(data, t2)
    key = m["bson_mkt"].replace("{t1}", a1).replace("{t2}", a2)
    mkt = find_bson_market(data, key)
    return parse_ou(mkt) if mkt else {}


def find_arbs(books, t1, t2):
    """books: {book_name: data}. Best Over/Under across all books per line."""
    results = []
    for m in MAPPING:
        per = {name: book_lines(name, data, m, t1, t2) for name, data in books.items()}
        per = {name: lines for name, lines in per.items() if lines}
        if len(per) < 2:
            continue  # need at least two books to make an arb
        all_lines = set().union(*[set(d) for d in per.values()])
        for line in all_lines:
            # skip whole-number lines: an exact hit pushes (refund), so an
            # Over/Under pair on an integer total isn't a true 2-way arb.
            if float(line).is_integer():
                continue
            overs, unders = [], []
            for name, d in per.items():
                cell = d.get(line, {})
                if cell.get("Over") is not None:
                    overs.append((name, cell["Over"]))
                if cell.get("Under") is not None:
                    unders.append((name, cell["Under"]))
            if not overs or not unders:
                continue
            best_over = max(overs, key=lambda x: x[1])
            best_under = max(unders, key=lambda x: x[1])
            if best_over[0] == best_under[0]:
                continue
            inv = 1 / best_over[1] + 1 / best_under[1]
            if inv < 1.0:
                stake_over_pct = (1 / best_over[1]) / inv * 100
                results.append({
                    "market_id": m["id"],
                    "market": m["bson_mkt"].replace("{t1}", t1).replace("{t2}", t2),
                    "line": line,
                    "over_book": best_over[0], "over_odds": best_over[1],
                    "under_book": best_under[0], "under_odds": best_under[1],
                    "books": "+".join(sorted(per)),
                    "profit_pct": round((1 - inv) * 100, 3),
                    "stake_over_pct": round(stake_over_pct, 1),
                    "stake_under_pct": round(100 - stake_over_pct, 1),
                })
    results.sort(key=lambda r: -r["profit_pct"])
    return results


def classify(path, data):
    """Book a file belongs to: rainbet/betsolutions (by filename) else bson/bwin (by content)."""
    n = path.name.lower()
    if "rainbet" in n:
        return "rainbet"
    if "betsolutions" in n:
        return "betsolutions"
    if "exonbet" in n:
        return "exonbet"
    return detect_format(data)


def bsonstyle_teams(data):
    """Derive (team1, team2) from a bson/rainbet file's '{team} - Total X' keys."""
    from collections import Counter
    suffixes = (" - Total Corners", " - Total Shots", " – Total Throw-ins",
                " -Total Offsides", " - Total Fouls", " Total Goal Kicks",
                " - Total Cards", " - Total Shots on Target")
    cnt = Counter()
    for k in data:
        for s in suffixes:
            if k.endswith(s):
                cnt[k[:-len(s)]] += 1
    top = [t for t, _ in cnt.most_common(2)]
    return (top + [None, None])[:2]


def detect_teams(books):
    """Best team-name guess from the available books (bwin scoreboard preferred)."""
    if "bwin" in books:
        t1, t2 = detect_team_names(books["bwin"])
        if t1:
            return t1, t2
    for name in BSON_STYLE:
        if name in books:
            t1, t2 = bsonstyle_teams(books[name])
            if t1 and t2:
                return t1, t2
    return None, None


def group_matches(typed):
    """typed: list of (path, kind, data). Cluster files of the same match by
    filename tokens. Returns list of {kind: (path, data)} dicts."""
    n = len(typed)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    toks = [filename_tokens(p.name) for p, _, _ in typed]
    for i in range(n):
        for j in range(i + 1, n):
            if match_score(toks[i], toks[j]) > 0:
                parent[find(i)] = find(j)

    clusters = {}
    for i, (p, kind, data) in enumerate(typed):
        clusters.setdefault(find(i), {})[kind] = (p, data)
    return list(clusters.values())


def load_typed(paths):
    typed, skipped = [], []
    for p in paths:
        path = Path(p)
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as e:
            skipped.append((path.name, f"parse error: {e}"))
            continue
        kind = classify(path, data)
        if kind:
            typed.append((path, kind, data))
        else:
            skipped.append((path.name, "unknown format"))
    return typed, skipped


def collect(paths):
    """Shared analysis path: returns (arbs, groups, counts, skipped)."""
    typed, skipped = load_typed(paths)
    counts = {
        k: sum(1 for _, kk, _ in typed if kk == k)
        for k in ("bson", "bwin", "rainbet", "betsolutions", "exonbet")
    }
    groups = [g for g in group_matches(typed) if len(g) >= 2]
    all_arbs = []
    group_info = []
    for g in groups:
        books = {kind: data for kind, (path, data) in g.items()}
        t1, t2 = detect_teams(books)
        info = {
            "books": sorted(g),
            "files": {k: v[0].name for k, v in sorted(g.items())},
            "match": f"{t1} vs {t2}" if t1 else None,
        }
        group_info.append(info)
        if not t1:
            continue
        arbs = find_arbs(books, t1, t2)
        for a in arbs:
            a["match"] = f"{t1} vs {t2}"
        all_arbs.extend(arbs)
    all_arbs.sort(key=lambda r: -r["profit_pct"])
    return all_arbs, group_info, counts, skipped


def main_json(args):
    paths = [Path(a) for a in args] if args else sorted(Path.cwd().glob("*.json"))
    arbs, groups, counts, skipped = collect(paths)
    print(json.dumps({
        "scanned": len(paths),
        "counts": counts,
        "skipped": [{"file": n, "reason": r} for n, r in skipped],
        "groups": groups,
        "arbs": arbs,
    }, ensure_ascii=False))


def main():
    # --json prints one machine-readable object instead of the human report.
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    if as_json:
        return main_json(args)
    if args:
        paths = args
    else:
        paths = sorted(Path.cwd().glob("*.json"))
        if not paths:
            print(f"No .json files found in {Path.cwd()}")
            sys.exit(1)

    typed, skipped = load_typed(paths)
    counts = {k: sum(1 for _, kk, _ in typed if kk == k) for k in ("bson", "bwin", "rainbet", "betsolutions", "exonbet")}
    print(f"Scanned {len(paths)} JSON files")
    print(f"  Detected: {counts['bson']} bson, {counts['bwin']} bwin, "
          f"{counts['rainbet']} rainbet, {counts['betsolutions']} betsolutions, "
          f"{counts['exonbet']} exonbet")
    if skipped:
        print(f"  Skipped {len(skipped)}:")
        for name, reason in skipped:
            print(f"    - {name} ({reason})")

    groups = group_matches(typed)
    usable = [g for g in groups if len(g) >= 2]
    print(f"\nMatched {len(usable)} multi-book match group{'s' if len(usable) != 1 else ''}:")
    for g in usable:
        print(f"  [{'+'.join(sorted(g))}]  " +
              "  ".join(f"{k}={v[0].name}" for k, v in sorted(g.items())))

    all_arbs = []
    for g in usable:
        books = {kind: data for kind, (path, data) in g.items()}
        t1, t2 = detect_teams(books)
        if not t1:
            names = [v[0].name for v in g.values()]
            print(f"\nWARNING: could not detect teams for {names}, skipping")
            continue
        arbs = find_arbs(books, t1, t2)
        for a in arbs:
            a["match"] = f"{t1} vs {t2}"
        all_arbs.extend(arbs)

    all_arbs.sort(key=lambda r: -r["profit_pct"])

    print(f"\n{'=' * 72}")
    print(f"FOUND {len(all_arbs)} ARBITRAGE OPPORTUNIT{'Y' if len(all_arbs) == 1 else 'IES'} ACROSS ALL MATCHES")
    print("=" * 72)
    for r in all_arbs:
        marker = " <<< STRONG" if r["profit_pct"] >= 1.5 else (" (thin)" if r["profit_pct"] < 0.5 else "")
        print(f"\n{r['match']}  --  [{r['market_id']}] line {r['line']}  --  profit {r['profit_pct']:+.2f}%{marker}")
        print(f"  Over  @ {r['over_odds']:>5}  on {r['over_book']:<8} (stake {r['stake_over_pct']}%)")
        print(f"  Under @ {r['under_odds']:>5}  on {r['under_book']:<8} (stake {r['stake_under_pct']}%)")
        print(f"  market: {r['market']}   (books: {r['books']})")


if __name__ == "__main__":
    main()