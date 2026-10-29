# Arb Finder with the server-side Stake collector.
# The official Playwright image ships Chromium and every system library it needs;
# the playwright-core version in package.json must match this tag.
FROM mcr.microsoft.com/playwright:v1.48.2-noble

ENV NODE_ENV=production \
    PORT=10000
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# Run as the image's unprivileged user, not root.
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 10000
CMD ["node", "server.mjs"]
