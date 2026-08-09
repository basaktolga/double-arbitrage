#!/usr/bin/env python3
"""Fetch the bet templates to understand G/T ID mappings."""
import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

BASE = "https://betwinner-16742.bar"

# Fetch the map file first
url = f"{BASE}/genfiles/cms/betstemplates/bets_model_map_short_en.json"
with urllib.request.urlopen(url, context=ctx) as resp:
    map_data = json.loads(resp.read())

print(f"Map has {len(map_data)} sport entries")
print(f"Sport '1' (Football) range: {map_data.get('1', 'N/A')}")

# Fetch football template (sport 1)
url = f"{BASE}/genfiles/cms/betstemplates/bets_model_short_en_1.json"
with urllib.request.urlopen(url, context=ctx) as resp:
    tmpl = json.loads(resp.read())

# tmpl["1"] contains the football bet types
football = tmpl.get("1", {})
print(f"\nFootball has {len(football)} bet type groups")

# Show first 15 groups with their names and selection names
for group_id, group in list(football.items())[:20]:
    group_name = group.get("N", "?")
    selections = group.get("M", {})
    sel_names = {k: v.get("N", "?") for k, v in list(selections.items())[:6]}
    group_numbers = group.get("GN", {})
    print(f"\n  Group {group_id}: {group_name}")
    print(f"    GN (group nums): {group_numbers}")
    print(f"    Selections: {sel_names}")
