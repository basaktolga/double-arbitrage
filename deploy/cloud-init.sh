#!/bin/bash
# First-boot setup for an Ubuntu 24.04 VM (paste into "cloud-init script" when creating
# the instance, or run once with sudo). Installs Docker, clones the repo to /opt/arb,
# writes .env with random secrets, finds the mirror domains, starts everything.
# Progress: /var/log/arb-setup.log
set -eux
exec > >(tee -a /var/log/arb-setup.log) 2>&1

REPO_URL=${REPO_URL:-https://github.com/basaktolga/double-arbitrage}
BRANCH=${BRANCH:-main}
NTFY_TOPIC=${NTFY_TOPIC:-arb-$(openssl rand -hex 8)}

# Small VMs: 4 GB swap so a Chromium spike never OOM-kills the scraper
if [ ! -f /swapfile ]; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

apt-get update
apt-get install -y docker.io docker-compose-v2 git python3
systemctl enable --now docker
id ubuntu >/dev/null 2>&1 && usermod -aG docker ubuntu

[ -d /opt/arb/.git ] || git clone --branch "$BRANCH" "$REPO_URL" /opt/arb
cd /opt/arb

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^NTFY_TOPIC=.*/NTFY_TOPIC=$NTFY_TOPIC/" .env
  sed -i "s/^APP_PASSWORD=.*/APP_PASSWORD=$(openssl rand -hex 12)/" .env
  sed -i "s/^UPLOAD_KEY=.*/UPLOAD_KEY=$(openssl rand -hex 16)/" .env
  # ARM has no Google Chrome; x86 keeps the stealthier real Chrome
  [ "$(dpkg --print-architecture)" = "amd64" ] && sed -i "s/^BROWSER_CHANNEL=.*/BROWSER_CHANNEL=chrome/" .env
fi

if [ ! -f console/providers.json ]; then
  python3 - <<'PY'
import json
cfg = json.load(open("console/providers.example.json"))
for p in cfg["providers"]:
    if p["id"] == "k9win":
        p["enabled"] = False  # scraper not written yet
json.dump(cfg, open("console/providers.json", "w"), indent=2)
PY
fi

python3 domains/find_domains.py --write || true   # reports books it couldn't find
docker compose up -d --build
echo "ARB SETUP DONE"
