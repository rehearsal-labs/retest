# Retest's own checks on Linux: Node.js 24 on Debian 13 with Google Chrome and Debian's Chromium, run as a
# non-root user with Chrome's sandbox on. Start it with docker/linux/run.sh, which passes the seccomp profile, --init
# and --cap-drop ALL; docs/guide.md explains them.
# The official Rust image supplies the exact compiler on either CI architecture. Its Bookworm binaries also run
# on the newer Debian 13 base; the linker comes from that base.
FROM rust:1.88.0-slim-bookworm@sha256:38bc5a86d998772d4aec2348656ed21438d20fcdce2795b56ca434cf21430d89 AS rust-tools
FROM node:24-trixie-slim

# Google Chrome is the browser chrome() finds, and Debian's Chromium is the second, plain Chromium build the
# integration tests need. procps gives the tests ps; fonts-liberation gives pages a real font. build-essential
# supplies the media crate's linker. ffmpeg supplies the encoder and ffprobe for independent video inspection.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential ca-certificates chromium curl ffmpeg fonts-liberation gnupg procps unzip \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --output /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install --yes --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# Chrome's headless shell of the Chrome for Testing release Retest pins, which a headless chromium() target runs, and
# Chrome for Testing of the same release, which the shell's comparison with Chrome needs: the archives Google publishes,
# refused unless they have the SHA-256 of the pins in src/browser/builds.ts (Linux x64) or the ones read from Google's
# linux-arm64 downloads on 15 November 2026, for which Retest pins nothing. They sit in a layer of their own, before the
# source is copied, so a change to Retest does not fetch them again.
ARG TARGETARCH
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) platform=linux64; shell=a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d; chrome=8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a ;; \
    arm64) platform=linux-arm64; shell=d433c45172c7836e38124fe545f767b02210bfb43a6262f08a297473a8e91c99; chrome=7d8a4b4ff289efe44a06501a519df142c4c18fff7aaf1c1401a3fbb12b3bd069 ;; \
    *) echo "No Chrome for Testing for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  release="https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/$platform"; \
  curl -fsSL -o /tmp/shell.zip "$release/chrome-headless-shell-$platform.zip"; \
  curl -fsSL -o /tmp/chrome.zip "$release/chrome-$platform.zip"; \
  printf '%s  /tmp/shell.zip\n%s  /tmp/chrome.zip\n' "$shell" "$chrome" | sha256sum -c -; \
  mkdir -p /opt/chrome-headless-shell /opt/chrome-for-testing; \
  unzip -q /tmp/shell.zip -d /opt/chrome-headless-shell; \
  unzip -q /tmp/chrome.zip -d /opt/chrome-for-testing; \
  mv "/opt/chrome-headless-shell/chrome-headless-shell-$platform" /opt/chrome-headless-shell/build; \
  mv "/opt/chrome-for-testing/chrome-$platform" /opt/chrome-for-testing/build; \
  rm /tmp/shell.zip /tmp/chrome.zip; \
  /opt/chrome-headless-shell/build/chrome-headless-shell --version; \
  /opt/chrome-for-testing/build/chrome --version

ENV CARGO_HOME=/home/node/.cargo \
  RUSTUP_HOME=/home/node/.rustup \
  PATH="/home/node/.cargo/bin:${PATH}"
COPY --from=rust-tools --chown=node:node /usr/local/cargo /home/node/.cargo
COPY --from=rust-tools --chown=node:node /usr/local/rustup /home/node/.rustup

USER node
WORKDIR /home/node/retest
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .

# The installer test builds a fresh npm-packed copy offline, so its locked crates must already be cached.
# Linux arm64 has no verified media target; leave its binary absent so those tests keep their honest skips.
RUN rustc --version \
  && cargo --version \
  && ffmpeg -version \
  && ffprobe -version \
  && if [ "$TARGETARCH" = "amd64" ]; then \
    cargo fetch --locked --manifest-path media/Cargo.toml \
    && cargo build --release --locked --offline --manifest-path media/Cargo.toml \
    && media/target/release/retest-media --version \
    && cargo test --locked --offline --manifest-path media/Cargo.toml replies::tests; \
  fi

# The browsers the integration tests run on. /opt/google/chrome/chrome is also where chrome() looks first, a headless
# chromium() target runs the headless shell RETEST_HEADLESS_SHELL names, and the shell is compared with Chrome for Testing.
ENV RETEST_TEST_BROWSER=/opt/google/chrome/chrome \
  RETEST_TEST_SECOND_BROWSER=/usr/bin/chromium \
  RETEST_TEST_HEADLESS_SHELL=/opt/chrome-headless-shell/build/chrome-headless-shell \
  RETEST_TEST_CHROME_FOR_TESTING=/opt/chrome-for-testing/build/chrome \
  RETEST_HEADLESS_SHELL=/opt/chrome-headless-shell/build/chrome-headless-shell \
  RETEST_TEST_MEDIA_BINARY=/home/node/retest/media/target/release/retest-media \
  RETEST_MEDIA_BINARY=/home/node/retest/media/target/release/retest-media \
  RETEST_TEST_FFMPEG=/usr/bin/ffmpeg \
  RETEST_FFMPEG=/usr/bin/ffmpeg \
  RETEST_TEST_FFPROBE=/usr/bin/ffprobe
CMD ["sh", "-c", "npm run build && npm run typecheck && npm test"]
