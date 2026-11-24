"""Headless runner for K9.

Called by the arb console as:  python agent_run.py <output-dir>
Write one <match>_odds_k9win.json per match into that directory, and print
progress lines so the console can show them live.
"""
import os, sys, json

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
BASE = os.environ.get("K9WIN_BASE", "https://change-me.example")


def main():
    print(f"[k9win] starting against {BASE}", flush=True)

    # TODO: fetch the match list, then for each match write the canonical format
    # (json-2file-arbfinder/books.py). arb_finder picks it up with no other change:
    #
    #   {"book": "k9win", "teams": ["<home>", "<away>"],
    #    "markets": {"corners_total": {"9.5": {"over": 1.95, "under": 1.90}},
    #                "corners_t1":    {"4.5": {"over": 1.80, "under": 2.00}}}}
    #
    # Market ids (corners_total, fouls_1h, shots_ot_t2, ...) are the "id" values in books.MAPPING.
    #
    # for match in fetch_matches():
    #     data = {"book": "k9win", "teams": [match["home"], match["away"]],
    #             "markets": fetch_markets(match)}
    #     fn = os.path.join(OUT, f"{match['home']}_-_{match['away']}".replace(" ", "_").lower()
    #                       + "_odds_k9win.json")
    #     json.dump(data, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    #     print(f"[k9win] saved {os.path.basename(fn)}", flush=True)

    print("[k9win] not implemented yet — edit k9win-scraper/agent_run.py", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
