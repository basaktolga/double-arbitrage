# Running it on its own (24/7)

One server runs two containers:

| Service | What it does |
|---|---|
| `runner` | Every `RUN_INTERVAL_MIN`: refreshes mirror domains, runs every enabled scraper, runs the arb finder, pushes new arbs to your phone (ntfy) and to the web app |
| `hosted` | The phone web app from `hosted/` (OddsPapi + Stake boosts + scraper arbs). Unlike Render's free plan it never sleeps |

Everything a server needs is this repo, `.env`, and `data/`. Moving to another
provider is the same four commands.

## Which server

| Option | Cost | Fits? |
|---|---|---|
| **Oracle Cloud Always Free, Ampere A1** (ARM, up to 4 cores / 24 GB) | $0, permanently | **Start here.** The 30-day part of Oracle's offer is only the $300 trial credit; Always Free resources keep running after it. Upgrade the account to Pay-As-You-Go (still $0 while you stay inside Always Free) so idle-reclaim and trial expiry don't touch the VM |
| Hetzner CX22 (x86, 2 vCPU / 4 GB) | ~€4–5 / month | The fallback. x86 means real Google Chrome, which gets through Cloudflare more reliably than Chromium (Rainbet, Dumanbet, Exonbet) |
| Render free (current) | $0 | Fine for `hosted/` only. Can't run the Playwright scrapers (512 MB, sleeps) |
| GitHub Actions cron | $0 | Not recommended: runs at most every ~5 min with delays, GitHub IPs are often Cloudflare-blocked, and betting scrapers are against Actions' acceptable use |

Notes for the scrapers specifically:

- Run them from a server **outside Turkey**: Turkish ISPs block the mirrors (that's why
  they rotate), a server abroad sees them directly. Pick a region in the EU (e.g. Frankfurt).
  Some books may geo-limit foreign IPs; the runner's log shows that as a book saving 0 files.
- ARM (Oracle A1) has no Google Chrome build, so set `BROWSER_CHANNEL=` (empty) and the
  Cloudflare books use the bundled Chromium. If one of them keeps coming back empty there,
  that's the signal to move to an x86 box and set `BROWSER_CHANNEL=chrome`.

## Set up (any Ubuntu server)

```sh
# 1. Docker
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER && newgrp docker

# 2. Code + config
git clone https://github.com/basaktolga/double-arbitrage && cd double-arbitrage
cp .env.example .env                                   # fill in the values
cp console/providers.example.json console/providers.json

# 3. First domain lookup (also runs automatically every few cycles)
docker compose run --rm runner python3 domains/find_domains.py --write

# 4. Go
docker compose up -d --build
docker compose logs -f runner
```

Open `http://<server-ip>:10000` for the web app. On Oracle, also open port 10000 in the
VCN security list *and* in the VM's firewall (`sudo iptables -I INPUT -p tcp --dport 10000 -j ACCEPT`),
or keep it closed and use an SSH tunnel.

Update: `git pull && docker compose up -d --build`.

## Moving to another server

```sh
# old server
tar czf arb-backup.tgz .env data console/providers.json domains/domains.json
# new server: steps 1–2 above, then
tar xzf arb-backup.tgz && docker compose up -d --build
```

Nothing is tied to a provider: no cloud SDKs, no managed services, just Docker.
