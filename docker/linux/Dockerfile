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
  && apt-get install --yes --no-install-recommends build-essential ca-certificates chromium curl ffmpeg fonts-liberation gnupg procps \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --output /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install --yes --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

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
ARG TARGETARCH
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

# The two browsers the integration tests run on. /opt/google/chrome/chrome is also where chrome() looks first.
ENV RETEST_TEST_BROWSER=/opt/google/chrome/chrome \
  RETEST_TEST_SECOND_BROWSER=/usr/bin/chromium \
  RETEST_TEST_MEDIA_BINARY=/home/node/retest/media/target/release/retest-media \
  RETEST_MEDIA_BINARY=/home/node/retest/media/target/release/retest-media \
  RETEST_TEST_FFMPEG=/usr/bin/ffmpeg \
  RETEST_FFMPEG=/usr/bin/ffmpeg \
  RETEST_TEST_FFPROBE=/usr/bin/ffprobe
CMD ["sh", "-c", "npm run build && npm run typecheck && npm test"]
