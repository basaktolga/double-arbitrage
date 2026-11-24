# Always-on scraper + arb runner. Same image on any Linux server (x86 or ARM):
#   docker compose up -d --build
# Code is bind-mounted by docker-compose.yml, so `git pull` + restart updates it.
FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

ENV PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends xvfb tini \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir playwright==1.49.1 patchright \
    && patchright install chromium \
    # Google Chrome (stealthier vs Cloudflare) only exists for x86-64; ARM servers use Chromium.
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then patchright install --with-deps chrome; fi

WORKDIR /app
# Cloudflare books run a real (headful) browser, so give them a virtual display.
ENTRYPOINT ["tini", "--", "sh", "-c", "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp & exec \"$@\"", "--"]
CMD ["python3", "runner/run.py"]
