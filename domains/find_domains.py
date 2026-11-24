#!/usr/bin/env python3
"""
Find each bookmaker's current mirror domain and (with --write) save it.

    python3 domains/find_domains.py               # report only
    python3 domains/find_domains.py --write       # also update domains.json + console/providers.json
    python3 domains/find_domains.py bson exonbet  # only these books

Strategies (per book, in domains.json):
  numbered  sites like 10012bets10.com / dumanbet920.com that move by bumping a
            number: probe n-back .. n+ahead in parallel, keep the HIGHEST number
            that serves the real site (newest mirror = least likely to be blocked)
  redirect  follow the brand's redirector links to wherever they land today
  fixed     the domain doesn't rotate; just check it's up

A host counts as alive only if it answers 2xx/3xx->2xx and its HTML contains the
book's `expect` word, so parked domains and ISP block pages are rejected.

Run it from the machine that does the scraping: a domain blocked by your ISP is
still "alive" from a server abroad, and vice versa. Standard library only.
"""

import concurrent.futures as cf
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
RULES = HERE / "domains.json"
PROVIDERS = REPO / "console" / "providers.json"
PROVIDERS_EXAMPLE = REPO / "console" / "providers.example.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
TIMEOUT = float(os.environ.get("DOMAIN_TIMEOUT", "8"))


def fetch(url):
    """(final_url, status, html_head) or (None, error, '')."""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,tr;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            return r.geturl(), r.status, r.read(200_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # Cloudflare challenges answer 403/503 but prove the host is the real site
        body = e.read(50_000).decode("utf-8", "replace") if e.fp else ""
        return e.geturl() if hasattr(e, "geturl") else url, e.code, body
    except Exception as e:  # DNS failure, timeout, TLS error (typical ISP block)
        return None, type(e).__name__, ""


def alive(url, expect):
    final, status, html = fetch(url)
    if not final:
        return None
    ok_status = isinstance(status, int) and (status < 400 or status in (403, 503))
    looks_real = expect.lower() in (html.lower() + final.lower())
    if status in (403, 503) and not re.search(r"cloudflare|cf-ray|challenge", html, re.I):
        return None
    return final if ok_status and looks_real else None


def numbered(rule):
    n0 = int(rule["n"])
    candidates = range(max(0, n0 - int(rule.get("back", 3))), n0 + int(rule.get("ahead", 50)) + 1)
    found = {}
    with cf.ThreadPoolExecutor(max_workers=int(os.environ.get("DOMAIN_WORKERS", "16"))) as ex:
        futs = {ex.submit(alive, rule["probe"].format(n=n), rule["expect"]): n for n in candidates}
        for f in cf.as_completed(futs):
            if f.result():
                found[futs[f]] = f.result()
    if not found:
        return None, f"no live mirror between {candidates.start} and {candidates.stop - 1}"
    best = max(found)
    return {"n": best}, f"{len(found)} live, newest {urlparse(rule['probe'].format(n=best)).hostname}"


def redirect(rule):
    for entry in rule.get("entries", []):
        final = alive(entry, rule["expect"])
        if final:
            host = urlparse(final).hostname
            return {"host": host}, f"{entry} -> {host}"
    return None, "no entry link led to a live site"


def fixed(rule):
    url = f"https://{rule['host']}/"
    return ({"host": rule["host"]}, "up") if alive(url, rule["expect"]) else (None, "down")


STRATEGIES = {"numbered": numbered, "redirect": redirect, "fixed": fixed}


def urls_for(rule, found):
    vals = {"n": found.get("n", rule.get("n")), "host": found.get("host", rule.get("host"))}
    return {k: v.format(**vals) for k, v in rule["urls"].items()}


def resolve(names=None):
    """{book: {"ok", "detail", "urls", "found"}} for every (or the named) book."""
    rules = json.loads(RULES.read_text())["books"]
    out = {}
    for book, rule in rules.items():
        if names and book not in names:
            continue
        found, detail = STRATEGIES[rule["strategy"]](rule)
        out[book] = {"ok": bool(found), "detail": detail, "found": found,
                     "urls": urls_for(rule, found) if found else None}
    return out


def save(results):
    """Write the winners back to domains.json and console/providers.json."""
    doc = json.loads(RULES.read_text())
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for book, r in results.items():
        if r["ok"]:
            doc["books"][book].update(r["found"])
            doc["books"][book]["checkedAt"] = now
    RULES.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

    src = PROVIDERS if PROVIDERS.exists() else PROVIDERS_EXAMPLE
    cfg = json.loads(src.read_text())
    for p in cfg["providers"]:
        r = results.get(p["id"])
        if r and r["ok"]:
            p.setdefault("urls", {}).update(r["urls"])
    PROVIDERS.write_text(json.dumps(cfg, indent=2) + "\n")


def main(argv):
    write = "--write" in argv
    as_json = "--json" in argv
    names = [a for a in argv if not a.startswith("-")] or None
    results = resolve(names)
    if write:
        save(results)
    if as_json:
        print(json.dumps(results))
    else:
        for book, r in results.items():
            mark = "OK  " if r["ok"] else "FAIL"
            print(f"{mark} {book:<13} {r['detail']}")
            for k, v in (r["urls"] or {}).items():
                print(f"       {k}={v}")
        if write:
            print(f"\nSaved to {RULES.relative_to(REPO)} and {PROVIDERS.relative_to(REPO)}")
    return 0 if all(r["ok"] for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
