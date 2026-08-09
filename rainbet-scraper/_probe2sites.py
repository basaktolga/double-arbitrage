from patchright.sync_api import sync_playwright
from urllib.parse import urlparse
from collections import Counter
import json, re

SITES = {
    "exonbet": "https://exonbet264.com/tr/sport/event-details/?sport=1&country=1239&champ=52530&event=36325508&live=0&supertip=0",
    "1king":   "https://1-king-063.club/tr/events/spain-saudi-arabia-16422505?tab=shots-all",
}

def safe(f, d=""):
    try: return f()
    except Exception: return d

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        "rainbet-scraper/.pr-sites", channel="chrome", headless=False, no_viewport=True)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    for name, url in SITES.items():
        rest = []; ws_hosts = Counter(); ws_text = []
        def on_resp(r):
            ct = r.headers.get("content-type", "")
            if "json" not in ct: return
            b = safe(lambda: r.body(), b"")
            if len(b) < 300: return
            txt = b.decode("utf-8", "ignore")
            # odds-ish?
            score = len(re.findall(r'coefficient|"odd"|"price"|"rate"|markets|runners|"k":|outcome', txt))
            rest.append((len(b), r.url.split("?")[0], score, txt[:0]))
        def on_ws(ws):
            ws_hosts[urlparse(ws.url).netloc] += 1
            ws.on("framereceived", lambda pl: ws_text.append(pl[:300]) if isinstance(pl, str) else None)
        page.on("response", on_resp); page.on("websocket", on_ws)
        print(f"\n========== {name} ==========", flush=True)
        safe(lambda: page.goto(url, wait_until="domcontentloaded", timeout=60000))
        for _ in range(12):
            page.wait_for_timeout(2500)
            if "moment" not in safe(lambda: page.title(), "").lower(): break
        page.wait_for_timeout(8000)
        print("final url:", safe(lambda: page.url))
        print("title:", safe(lambda: page.title())[:60])
        print("ws hosts:", dict(ws_hosts))
        print("JSON responses by odds-score:")
        seen = set()
        for sz, u, score, _ in sorted(rest, key=lambda x: -x[2])[:14]:
            base = urlparse(u).netloc + urlparse(u).path
            if base in seen: continue
            seen.add(base)
            print(f"   [score {score:>3}] [{sz:>7}b] {base}")
        page.remove_listener("response", on_resp); page.remove_listener("websocket", on_ws)
    ctx.close()
