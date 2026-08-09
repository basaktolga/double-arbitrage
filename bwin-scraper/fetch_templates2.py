#!/usr/bin/env python3
"""Fetch sport=0 base template which has 1X2, Total, Handicap etc."""
import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

BASE = "https://betwinner-16742.bar"

url = f"{BASE}/genfiles/cms/betstemplates/bets_model_short_en_0.json"
with urllib.request.urlopen(url, context=ctx) as resp:
    tmpl = json.loads(resp.read())

base = tmpl.get("0", {})
print(f"Base template has {len(base)} bet type groups\n")

for group_id, group in list(base.items()):
    group_name = group.get("N", "?")
    selections = group.get("M", {})
    sel_names = {k: v.get("N", "?") for k, v in list(selections.items())[:6]}
    group_numbers = group.get("GN", {})
    print(f"  GS {group_id}: {group_name}")
    print(f"    GN: {group_numbers}")
    print(f"    Selections (T ids): {sel_names}")
    print()
