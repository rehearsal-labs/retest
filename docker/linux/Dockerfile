# Retest's own checks on Linux: Node.js 24 on Debian 13 with Google Chrome and Debian's Chromium, run as a
# non-root user with Chrome's sandbox on. Start it with docker/linux/run.sh, which passes the seccomp profile, --init
# and --cap-drop ALL; docs/guide.md explains them.
FROM node:24-trixie-slim

# Google Chrome is the browser chrome() finds, and Debian's Chromium is the second, plain Chromium build the
# integration tests need. procps gives the tests ps; fonts-liberation gives pages a real font.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates chromium curl fonts-liberation gnupg procps \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --output /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install --yes --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node/retest
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .

# The two browsers the integration tests run on. /opt/google/chrome/chrome is also where chrome() looks first.
ENV RETEST_TEST_BROWSER=/opt/google/chrome/chrome \
  RETEST_TEST_SECOND_BROWSER=/usr/bin/chromium
CMD ["sh", "-c", "npm run build && npm run typecheck && npm test"]
