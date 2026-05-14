# Optional Dockerfile — use this if Railway's default Nixpacks build keeps failing
# on Playwright Chromium system dependencies. To enable: in Railway → Settings →
# Service Settings → Builder, switch from Nixpacks to Dockerfile.
#
# The Playwright base image has Chromium + every system .so pre-installed,
# so postinstall doesn't need root or apt-get.

FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Cache deps layer
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source
COPY . .

# Persistent profile dir (mount a Railway Volume here for cross-redeploy persistence)
RUN mkdir -p /app/.farm-profiles && chmod -R 777 /app/.farm-profiles

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
