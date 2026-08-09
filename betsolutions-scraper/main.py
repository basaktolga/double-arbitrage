#!/usr/bin/env python3
"""
BetSolutions (via dumanbet) World Cup odds scraper.

BetSolutions streams odds over a classic ASP.NET SignalR hub ("clienthub").
We open the book with patchright (clears Cloudflare), then run the SignalR
handshake *inside the page origin* and invoke the hub directly:
    getSports                      -> find the World Cup league id
    getEvents{leagueId}            -> the WC events
    GetEventMarkets{eventId,...}   -> markets + odds per event
Markets carry a stable type id (M); we map those to bson-style keys so the
output drops straight into the arb finder. Outcomes: "Üst"=Over, "Alt"=Under,
line is in A.h.
"""
from patchright.sync_api import sync_playwright
import json
import sys
import os
import re

URL = os.environ.get("BETSOLUTIONS_URL", "https://dumanbet920.com/tr/Sports/BSBetting?type=sport")
ORIGIN = os.environ.get("BETSOLUTIONS_ORIGIN", "https://sports.dumanbet920.com")
PROFILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "rainbet-scraper", ".pr-books")
LANG = 3  # Turkish market-name dict; team names still come in English

# BetSolutions market type id (M) -> bson-style key. {t1}=home, {t2}=away.
MARKET_IDS = {
    # full match
    "153": "Total Corners", "155": "{t1} - Total Corners", "157": "{t2} - Total Corners",
    "165": "Total Cards", "167": "{t1} - Total Cards", "169": "{t2} - Total Cards",
    "870": "Total Fouls Conceded", "872": "{t1} - Total Fouls", "874": "{t2} - Total Fouls",
    "864": "Total Offsides", "866": "{t1} -Total Offsides", "868": "{t2} -Total Offsides",
    "4016": "Total Throw-ins", "4018": "{t1} – Total Throw-ins", "4020": "{t2} – Total Throw-ins",
    "2377": "Total Shots on Target", "2379": "{t1} - Total Shots on Target", "2381": "{t2} - Total Shots on Target",
    "4399": "Total Shots", "4403": "{t1} - Total Shots",
    # 1st half
    "1971": "1st Half - Total Corners", "1973": "1st Half - {t1} Total Corners", "1975": "1st Half - {t2} Total Corners",
    "438": "1st Half - Total Cards", "2720": "1st Half - {t1} Total Cards", "2722": "1st Half - {t2} Total Cards",
    "2588": "1st Half - Total Fouls", "2649": "1st Half - {t1} Total Fouls", "2651": "1st Half - {t2} Total Fouls",
    "4104": "1st Half - Total Offsides",
    # 2nd half
    "436": "2nd Half - Total Corners", "4180": "2nd Half - {t1} Total Corners", "4181": "2nd Half - {t2} Total Corners",
    "440": "2nd Half - Total Cards", "4391": "2nd Half - {t1} Total Cards", "4393": "2nd Half - {t2} Total Cards",
}

# JS that runs the whole SignalR conversation inside the page origin and returns
# all received frames. Discovers the World Cup league, lists events, pulls each
# event's markets.
SIGNALR_JS = r"""
async (lang) => {
  const base = location.origin.indexOf("dumanbet") > -1 && location.origin.indexOf("sports") > -1
      ? location.origin : "https://sports.dumanbet920.com";
  const cd = encodeURIComponent(JSON.stringify([{name:"clienthub"}]));
  const cp = "2.1";
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const neg = await fetch(`${base}/signalr/negotiate?clientProtocol=${cp}&connectionData=${cd}`,{credentials:"include"}).then(r=>r.json());
  const tok = encodeURIComponent(neg.ConnectionToken);
  const wsUrl = `${base.replace('https','wss')}/signalr/connect?transport=webSockets&clientProtocol=${cp}&connectionToken=${tok}&connectionData=${cd}&tid=1`;
  const frames = [];
  let nextI = 1;
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((res)=>{ ws.onopen = res; });
  ws.onmessage = (e)=> frames.push(e.data);
  await ready;
  await fetch(`${base}/signalr/start?clientProtocol=${cp}&connectionToken=${tok}&connectionData=${cd}`,{credentials:"include"});
  const send = (m,a)=> ws.send(JSON.stringify({H:"clienthub",M:m,A:[JSON.stringify(a)],I:nextI++}));

  // 1) market-name dict + sports tree
  send("ClientGetMarketNames",{LanguageId:String(lang)});
  send("getSports",{gamblerToken:"",languageId:lang});
  await sleep(3500);

  // candidate football (SportId 1) leagues whose name looks like World Cup
  const cands = new Set([1431]);
  for (const f of frames){
    let o; try{o=JSON.parse(f);}catch(e){continue;}
    for (const msg of (o.M||[])){
      if (msg.M==="Response" && Array.isArray(msg.A) && Array.isArray(msg.A[1])){
        for (const sport of msg.A[1]){
          if (sport && sport.Id===1 && sport.Regions){
            for (const rg of sport.Regions)
              for (const lg of (rg.Leagues||[]))
                if (/world cup|d[üu]nya kupas/i.test(lg.Name||"")) cands.add(lg.Id);
          }
        }
      }
    }
  }
  // 2) query events for each candidate, then pick the league with the most events
  const before = frames.length;
  for (const c of cands){ send("getEvents",{leagueId:c, languageId:lang}); await sleep(400); }
  await sleep(3500);
  const byLeague = {};   // leagueId -> [eventId,...]
  for (const f of frames){
    let o; try{o=JSON.parse(f);}catch(e){continue;}
    for (const msg of (o.M||[])){
      if (msg.M==="Response" && Array.isArray(msg.A) && Array.isArray(msg.A[1])){
        for (const ev of msg.A[1]){
          if (ev && ev.Id && ev.HomeTeamName!==undefined && ev.LeagueId){
            (byLeague[ev.LeagueId] = byLeague[ev.LeagueId] || []).push(ev.Id);
          }
        }
      }
    }
  }
  let leagueId = 1431, best = -1;
  for (const lid in byLeague){ if (byLeague[lid].length > best){ best = byLeague[lid].length; leagueId = +lid; } }
  const eventIds = [...new Set(byLeague[leagueId] || [])];

  // 3) markets per event
  for (const id of eventIds){
    send("GetEventMarkets",{eventId:id, leagueId:leagueId, languageId:lang});
    await sleep(250);
  }
  await sleep(5000);
  try{ ws.close(); }catch(e){}
  return {leagueId, eventIds, frames};
}
"""


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _responses(frames):
    """Yield the data object from every SignalR ClientHub.Response frame."""
    for f in frames:
        try:
            o = json.loads(f)
        except Exception:
            continue
        for msg in o.get("M", []) or []:
            if msg.get("M") == "Response" and len(msg.get("A", [])) >= 2:
                yield msg["A"][1]


def parse_events(frames):
    """eventId -> full event dict (with EventMarkets)."""
    events = {}
    for d in _responses(frames):
        if isinstance(d, dict) and d.get("EventMarkets") and d.get("HomeTeamName") is not None:
            events[d["Id"]] = d
        elif isinstance(d, list):
            for ev in d:
                if isinstance(ev, dict) and ev.get("EventMarkets") and ev.get("HomeTeamName") is not None:
                    events[ev["Id"]] = ev
    return events


def build_markets(event):
    t1 = (event.get("HomeTeamName") or "").strip()
    t2 = (event.get("AwayTeamName") or "").strip()
    out = {}
    for m in event.get("EventMarkets", []) or []:
        tmpl = MARKET_IDS.get(str(m.get("M")))
        if not tmpl:
            continue
        key = tmpl.replace("{t1}", t1).replace("{t2}", t2)
        # line from A.h
        line = None
        a = m.get("A")
        if isinstance(a, str) and a:
            line = _safe(lambda: json.loads(a).get("h"))
        elif isinstance(a, dict):
            line = a.get("h")
        if line is None:
            continue
        items = out.setdefault(key, [])
        for oc in m.get("Oc", []) or []:
            name = (oc.get("N") or "")
            odds = oc.get("O")
            if odds is None:
                continue
            if "Üst" in name:
                side = "Over"
            elif "Alt" in name:
                side = "Under"
            else:
                continue
            items.append({"name": f"{side} {line}", "odds": odds})
        if not items:
            out.pop(key, None)
    return out, t1, t2


def _new_context(p):
    return p.chromium.launch_persistent_context(
        PROFILE, channel="chrome", headless=False, no_viewport=True,
        # Headless is blocked by Cloudflare, so run headful but off-screen
        # so the window never appears on the user's display.
        args=["--window-position=-3000,-3000", "--window-size=1280,900"])


def _wait_cleared(page, secs=50):
    for _ in range(int(secs / 2)):
        page.wait_for_timeout(2000)
        t = _safe(lambda: page.title(), "") or ""
        if "moment" not in t.lower() and "just a" not in t.lower():
            return True
    return False


def scrape_all(out_dir="."):
    with sync_playwright() as p:
        ctx = _new_context(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        _wait_cleared(page)
        page.wait_for_timeout(7000)
        # run the SignalR conversation in the sports.dumanbet frame if present
        target = page
        for f in page.frames:
            if "sports.dumanbet" in (f.url or ""):
                target = f
                break
        print("  Running SignalR (this takes ~30s)...")
        res = _safe(lambda: target.evaluate(SIGNALR_JS, LANG), {})
        ctx.close()

    frames = (res or {}).get("frames", [])
    print(f"  league={res.get('leagueId')}  events={len(res.get('eventIds', []))}  frames={len(frames)}")
    events = parse_events(frames)
    saved = []
    for ev in events.values():
        markets, t1, t2 = build_markets(ev)
        if not markets:
            continue
        fn = os.path.join(out_dir, f"{t1}_-_{t2}_odds_betsolutions.json".replace(" ", "_").lower())
        json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        saved.append((f"{t1} - {t2}", len(markets)))
        print(f"  saved {os.path.basename(fn)}  ({len(markets)} markets)")
    if not saved:
        print("  No markets parsed.")
    return saved


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    print("\n  BetSolutions World Cup scraper")
    print("  (Chrome opens; solve the Cloudflare check once if shown)\n")
    scrape_all(out)
