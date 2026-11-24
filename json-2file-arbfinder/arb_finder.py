#!/usr/bin/env python3
"""
Batch arbitrage finder: scans all .json odds files in the current directory,
groups files from any number of books by match, and lists every arb found.

Works with every book: each file is identified by its `_odds_<book>.json` suffix
and normalised by books.py, so a new website needs a scraper and nothing else.

Usage:
    python3 arb_finder.py                       # scan all *.json in cwd
    python3 arb_finder.py file1.json file2.json # run on exactly these two files
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from books import (  # noqa: E402  (books.py sits next to this file)
    MARKET_LABEL, BOOK_FORMATS, book_from_filename, identify, file_teams, normalize,
)

# Tokens to ignore when matching filenames (filler words, format tags, club suffixes).
# The `_odds_<book>` suffix is stripped before tokenising, so book names never
# need adding here when a new website is added.
STOPWORDS = {
    "odds", "json",
    "fc", "cf", "sc", "ac", "afc", "cp", "vs",
    "1909",  # Bologna 1909 -> Bologna
    "de", "the", "and",
}


def filename_tokens(name):
    """Meaningful tokens from a filename for matching (book suffix removed)."""
    stem = Path(name).stem.lower()
    book = book_from_filename(stem)
    if book:
        stem = stem[: -len("_odds_" + book)]
    tokens = re.split(r'[^a-z0-9]+', stem)
    return {t for t in tokens if t and t not in STOPWORDS and t not in BOOK_FORMATS and not t.isdigit()}


def match_score(tokens_a, tokens_b):
    """How well two filename token sets correspond to the same match (0 = not at all)."""
    if not tokens_a or not tokens_b:
        return 0.0
    common = tokens_a & tokens_b
    # At least 2 common tokens (one for each team) for a real match
    if len(common) < 2:
        return 0.0
    return len(common) / min(len(tokens_a), len(tokens_b))


def detect_teams(group):
    """Best (team1, team2) for a match group: bwin's scoreboard, then any canonical
    file's declared teams, then team names read from bson-style keys."""
    order = {"bwin": 0, "canonical": 1, "bson": 2}
    for book, (path, fmt, data) in sorted(group.items(), key=lambda kv: order.get(kv[1][1], 3)):
        t1, t2 = file_teams(fmt, data)
        if t1 and t2:
            return t1, t2
    return None, None


def find_arbs(normalized, t1, t2, skip_integer_lines=True):
    """normalized: {book: {market_id: {line: {"Over", "Under"}}}}.
    Best Over and best Under across all books per market line; an arb is when
    the two best prices come from different books and 1/o + 1/u < 1."""
    results = []
    market_ids = sorted(set().union(*[set(d) for d in normalized.values()])) if normalized else []
    for mid in market_ids:
        per = {b: d[mid] for b, d in normalized.items() if d.get(mid)}
        if len(per) < 2:
            continue  # need at least two books to make an arb
        for line in sorted(set().union(*[set(d) for d in per.values()])):
            # whole-number lines push on an exact hit, so Over/Under isn't a true 2-way arb
            if skip_integer_lines and float(line).is_integer():
                continue
            overs = [(b, d[line]["Over"]) for b, d in per.items() if d.get(line, {}).get("Over")]
            unders = [(b, d[line]["Under"]) for b, d in per.items() if d.get(line, {}).get("Under")]
            if not overs or not unders:
                continue
            best_over = max(overs, key=lambda x: x[1])
            best_under = max(unders, key=lambda x: x[1])
            if best_over[0] == best_under[0]:
                continue
            inv = 1 / best_over[1] + 1 / best_under[1]
            if inv < 1.0:
                stake_over_pct = (1 / best_over[1]) / inv * 100
                label = MARKET_LABEL.get(mid, mid)
                results.append({
                    "market_id": mid,
                    "market": label.replace("{t1}", t1 or "Team 1").replace("{t2}", t2 or "Team 2"),
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


def group_matches(typed):
    """typed: list of (path, book, fmt, data). Cluster files of the same match by
    filename tokens (union-find). Returns a list of {book: (path, fmt, data)}."""
    n = len(typed)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    toks = [filename_tokens(t[0].name) for t in typed]
    for i in range(n):
        for j in range(i + 1, n):
            if typed[i][1] != typed[j][1] and match_score(toks[i], toks[j]) > 0:
                parent[find(i)] = find(j)

    clusters = {}
    for i, (p, book, fmt, data) in enumerate(typed):
        g = clusters.setdefault(find(i), {})
        # two files from the same book in one cluster: keep the newer one
        if book in g and g[book][0].stat().st_mtime >= p.stat().st_mtime:
            continue
        g[book] = (p, fmt, data)
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
        book, fmt = identify(path, data)
        if book:
            typed.append((path, book, fmt, data))
        else:
            skipped.append((path.name, "unknown format"))
    return typed, skipped


def book_counts(typed):
    counts = {b: 0 for b in BOOK_FORMATS}
    for _, book, _, _ in typed:
        counts[book] = counts.get(book, 0) + 1
    return counts


def analyse_group(g):
    t1, t2 = detect_teams(g)
    if not t1:
        return None, []
    normalized = {book: normalize(fmt, data, t1, t2) for book, (path, fmt, data) in g.items()}
    arbs = find_arbs(normalized, t1, t2)
    for a in arbs:
        a["match"] = f"{t1} vs {t2}"
    return f"{t1} vs {t2}", arbs


def collect(paths):
    """Shared analysis path: returns (arbs, groups, counts, skipped)."""
    typed, skipped = load_typed(paths)
    counts = book_counts(typed)
    groups = [g for g in group_matches(typed) if len(g) >= 2]
    all_arbs, group_info = [], []
    for g in groups:
        match, arbs = analyse_group(g)
        group_info.append({
            "books": sorted(g),
            "files": {k: v[0].name for k, v in sorted(g.items())},
            "match": match,
        })
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
    counts = book_counts(typed)
    print(f"Scanned {len(paths)} JSON files")
    print("  Detected: " + ", ".join(f"{n} {b}" for b, n in counts.items()))
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
        match, arbs = analyse_group(g)
        if not match:
            names = [v[0].name for v in g.values()]
            print(f"\nWARNING: could not detect teams for {names}, skipping")
            continue
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