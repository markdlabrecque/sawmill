# Runs the Board browser tests with a real Chromium, so they never skip.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium git \
  && rm -rf /var/lib/apt/lists/*

ENV SAWMILL_TEST_CHROMIUM=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

CMD ["node", "--test", "--test-timeout=120000", "dist/test/board-pick-actions.test.js", "dist/test/board-picks-appended.test.js", "dist/test/board-sawblade.test.js", "dist/test/board-workshop.test.js"]
