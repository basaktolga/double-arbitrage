#!/usr/bin/env python3
"""
Push the local scrapers' arbs to the hosted Arb Finder.

Runs the same analysis as `arb_finder.py --json` over the scraped odds files and
uploads the result, so the arbs show up in the hosted app (tagged SCRAPER) next to
the OddsPapi and Stake-boost arbs. Standard library only.

    export ARB_FINDER_URL=https://arb-finder.onrender.com
    export ARB_FINDER_UPLOAD_KEY=...        # UPLOAD_KEY (or APP_PASSWORD) on Render
    python3 push_to_hosted.py               # all *.json in this folder
    python3 push_to_hosted.py a.json b.json # specific files

The upload carries the newest file's modification time, so the app can show how old
the scraped odds are and warn when they're stale.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from arb_finder import collect  # noqa: E402


def main():
    url = os.environ.get("ARB_FINDER_URL", "").rstrip("/")
    key = os.environ.get("ARB_FINDER_UPLOAD_KEY", "")
    if not url or not key:
        sys.exit("Set ARB_FINDER_URL and ARB_FINDER_UPLOAD_KEY first.")

    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    paths = [Path(a) for a in args] if args else sorted(HERE.glob("*.json"))
    if not paths:
        sys.exit(f"No odds files found in {HERE}")

    arbs, groups, counts, skipped = collect(paths)
    newest = max((p.stat().st_mtime for p in paths if p.exists()), default=None)
    body = json.dumps({
        "scrapedAt": int(newest * 1000) if newest else None,
        "counts": counts,
        "groups": len(groups),
        "arbs": arbs,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{url}/api/local/upload",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Upload-Key": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:  # free Render may need ~60s to wake
            reply = json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"Upload failed: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as e:
        sys.exit(f"Upload failed: {e.reason}")
    print(f"Uploaded {reply.get('count', 0)} arbs from {len(paths)} files ({len(groups)} matched games).")


if __name__ == "__main__":
    main()
