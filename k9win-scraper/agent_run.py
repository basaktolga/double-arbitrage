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

    # TODO: fetch the match list, then for each match build a dict of
    #   { "<market name>": { "<line>": {"over": 1.95, "under": 1.90} }, ... }
    # matching the shape the other scrapers emit (see bson-scraper output),
    # and save it so arb_finder can pair it with the other books:
    #
    # matches = fetch_matches()
    # for match in matches:
    #     markets = fetch_markets(match)
    #     fn = os.path.join(OUT, match["name"].replace(" ", "_").lower() + "_odds_k9win.json")
    #     json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    #     print(f"[k9win] saved {os.path.basename(fn)}", flush=True)

    print("[k9win] not implemented yet — edit k9win-scraper/agent_run.py", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
