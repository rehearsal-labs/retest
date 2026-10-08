# Firefox recording investigation

Firefox failed because the unoptimized debug media build could not drain its image-processing queue within the finish deadline. The 1366 by 683 PNG screenshot path resizes every processed frame into an even 1366 by 682 recording canvas. A fresh release build passed the same recording/decode test under the unchanged deadline. Enabling `opt-level = 1` for the development profile fixed the debug run without changing pixels, bounds or assertions.

The final fixed debug build passed the full Firefox, Chrome and WebKit capture gates through the shared lock, each once. Firefox passed 5/5, Chrome 7/7 and WebKit 5/5. All decoded ticker-video frames matched their mapped screen states and all three ticker recordings had complete evidence. The full Rust suite passed 92 unit and 55 process tests. All-target clippy passed with warnings denied.

## Cause and candidate checks

| Candidate | Evidence and conclusion |
| --- | --- |
| Stale debug binary | The binary identified itself as protocol 2, aarch64-apple-darwin, debug, revision `b59eed5d6b4ffc6e903198fdbabdd0356946aa41` with local changes. No crate source was newer. An offline debug build accepted Cargo's existing fingerprint in 0.03s and left binary SHA-256 `3c6da1df49706f1e0dbbdd7e24ac6a0fcdef27d80d12e04168c5713315e40833` unchanged. This rules out a stale debug binary for the reproduced run. A dirty revision alone cannot identify source contents; the source/hash snapshots are retained. |
| Debug processing too slow | The locked debug reproduction received 80 frames, showed 44, dropped 14 and left 22 unprocessed, with a queue peak of 60. It expired at `finalizeMs: 20489` and killed the encoder on signal 9. A browser-free process regression also failed with 15 of 24 frames unprocessed. Fresh release and optimized debug builds both completed the same real resize path without drops or unprocessed frames. This is the demonstrated cause on this host. |
| New file-finalization deadline too tight | The failed debug run still had queued frames and an unfinished encoder when it expired, before successful file publication. The fresh release run finished in 76 ms and the fixed debug run in 74 ms under the existing 20000 ms deadline. `finalizeMs` covers queue drain, encoder exit and file publication together; it is not a standalone filesystem timer. The Phase 4 brief requires bounded finalization and explicit incomplete evidence on failure, and gives no reason to widen this deadline. |
| Withholding or `earliestUs` delayed Firefox stop | The retained retry delivered 79 frames at 29.19/s and stopped at 3006396 us. This lane's failing reproduction delivered 80 at 29.25/s and stopped at 3002345 us. Both had zero withheld frames/stretches, zero source drops and no source problems. The fresh release and fixed debug recordings stopped at 3001190 and 3001278 us. There is no lengthened capture or delayed stop in these failures. The real withholding test also passed unchanged. |

The shared recording proof captures for 3000 ms at requested 30 fps. Its media finish deadline remains 20000 ms, source stop bound 5000 ms and client finish wait 30000 ms. The failure is retained as `deadline_exceeded` with unavailable evidence; no result was softened.

The earlier capture-source report records 78 Firefox frames at 28.91/s. Its listed browser commands do not override `RETEST_MEDIA_BINARY`; `tests/integration/capture-proof.ts` selects the release binary by default. The withholding-fix runs explicitly selected the debug binary. This build-profile change explains why the earlier successful source proof and today's failed recording are compatible. The shared helper and Firefox screenshot source were not changed in this lane.

Chrome and WebKit had less image work in the retained debug runs. Each captured 756 by 469 into a 756 by 468 canvas, versus Firefox's 1366 by 683 source. That is 354564 source pixels versus 932978. The retained Chrome finish took 12247 ms for 80 received frames, with 6 drops and partial evidence. WebKit took 8731 ms for 56 received frames and complete evidence. Their passed status did not establish that the larger Firefox debug path could keep up.

These are single-host lifecycle measurements collected from actual test endings and independently decoded recordings. No benchmark was run and no general speed claim follows.

## Fix and failing-first test

Only these existing product/test files were edited by this lane:

- `media/Cargo.toml` adds `[profile.dev] opt-level = 1`. Local media builds optimize the image-processing loops while keeping the profile's default debug assertions, overflow checks and symbols. Release settings, runtime dependencies and behavior are unchanged.
- `media/tests/process.rs` adds `odd_height_screenshot_frames_finish_without_loss_inside_their_budget`. It sends 24 Firefox-sized PNGs into an even recording canvas through the real process, queue, decoder, resizer and finalizer with a copying encoder fixture. It requires every frame shown, complete evidence, no drops/unprocessed frames, exact output size, source centre pixels, black padding, encoder exit and successful process shutdown.

The new regression failed before the profile change, exit 101. All 24 inputs arrived without drops; 9 were shown, 15 remained unprocessed, and the 5000 ms finish budget expired at `finalizeMs: 5214`. After the fix it passed with all 24 shown/resized, complete evidence and `finalizeMs: 666`. It also passed in the full parallel Rust suite. The fixture is a lifecycle regression, not a benchmark.

No existing assertion, required outcome, pixel fitting rule, queue bound or deadline changed. No Rust runtime source, including `encoder.rs`, was edited. The other workers' client, protocol, runner and evidence-test files were left alone. The initial and final runtime-source hashes differ only in `media/Cargo.toml`; the new test is separate from that runtime-source manifest. Existing work was preserved.

Documentation added by this lane is this report and `docs/plans/public-beta/proofs/firefox-recording.md`.

## Retained results and timings

| Run | Source delivered/sent | Media shown / superseded / dropped / unprocessed | Queue peak | Finish ms | Independently decoded ticker frames | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Prior Firefox retry, unoptimized debug | 79 / 79 | 41 / 2 / 13 / 23 | 60 | 20436 | Decode not reached | Failed; unavailable evidence |
| Focused Firefox reproduction, unoptimized debug | 80 / 80 | 44 / 0 / 14 / 22 | 60 | 20489 | Decode not reached | Failed; unavailable evidence |
| Fresh release Firefox comparison | 76 / 76 | 74 / 2 / 0 / 0 | 1 | 76 | 79/79 matched | Passed; complete evidence |
| Final optimized debug Firefox | 79 / 79 | 77 / 2 / 0 / 0 | 1 | 74 | 82/82 matched | 5/5 gate passed; complete ticker evidence |
| Final optimized debug Chrome | 80 / 80 | 79 / 1 / 0 / 0 | 1 | 80 | 81/81 matched | 7/7 gate passed; complete ticker evidence |
| Final optimized debug WebKit | 56 / 56 | 56 / 0 / 0 / 0 | 1 | 66 | 80/80 matched | 5/5 gate passed; complete ticker evidence |

Firefox is 133.0.3 and uses `RETEST_FIREFOX_ROUTE=launch-services`, the recorded host route, not a defect. Chrome is 154.0.8037.98. WebKit is 626.1.6+ build 2359. The host has Node v24.12.0, Homebrew rustc/cargo 1.98.1 and ffmpeg 9.0.2.

Original failure logs remain `/tmp/retest-fix-capture-firefox-webkit.log` and `/tmp/retest-fix-capture-firefox-retry.log`. The prior full ending is `/tmp/retest-fix-capture-artifacts/firefox-retry/firefox-failed-recording.json`. The earlier smaller debug comparisons are `/tmp/retest-fix-capture-artifacts/chromium/chrome-ticker-report.json` and `/tmp/retest-fix-capture-artifacts/firefox-webkit/webkit-ticker-report.json`.

This lane's logs, source/binary identity snapshots, failed ending and successful raw reports are under `/tmp/retest-firefox-recording/`. Successful folders retain raw source images, decoder process records, the MP4, capture/frame maps and ticker comparisons. The new failed ending is `firefox-debug-before/firefox-failed-recording.json`. Successful reports are `firefox-release-before/firefox-ticker-report.json`, `firefox-debug-final/firefox-ticker-report.json`, `chromium-debug-final/chrome-ticker-report.json` and `webkit-debug-final/webkit-ticker-report.json`. The binary/source snapshots are `baseline-identity.json`, `final-debug-identity.json` and `final-release-identity.json`.

## Exact commands and logs

Commands below ran from `/Users/dragon/Documents/Projects/Gruvi/Products/retest`, in the listed execution order. The gate helper checks `pgrep -f benchmarks/run.ts` before launching each command, records the launched PID and argument list plus observed descendant PID/start/command-hash identities, and captures stdout/stderr to the named log. Real browser commands run inside `lockf -t 0 /tmp/retest-heavy-gate.lock`. Unit/process tests and builds need no heavy lock. One initial focused debug lock attempt returned 75, `already locked`, before starting any test; its foreign holder was left alone, and the next attempt was made after the required wait.

All Node test executions below had zero cancelled, skipped or todo tests. The new Rust regression selected zero unit tests and filtered the unrelated tests; the full Rust run filtered none.

`build-release`: exit 0; Build only; Cargo accepted the existing release fingerprint. Log `/tmp/retest-firefox-recording/build-release.log`; process records `/tmp/retest-firefox-recording/build-release.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/build-release.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo build --release --locked --offline --manifest-path media/Cargo.toml
```

`build-release-fresh`: exit 0; Build only; all dependencies and crate compiled into an empty target directory. Log `/tmp/retest-firefox-recording/build-release-fresh.log`; process records `/tmp/retest-firefox-recording/build-release-fresh.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/build-release-fresh.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo build --release --locked --offline --manifest-path media/Cargo.toml --target-dir /tmp/retest-firefox-recording/fresh-target
```

`firefox-debug-before`: exit 1; 1 test, 0 passed, 1 failed. Log `/tmp/retest-firefox-recording/firefox-debug-before.log`; process records `/tmp/retest-firefox-recording/firefox-debug-before.log.owners.json`.

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/firefox-debug-before.log env RETEST_FIREFOX_ROUTE=launch-services RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/debug/retest-media RETEST_CAPTURE_PROOF_OUT=/tmp/retest-firefox-recording/firefox-debug-before node --conditions=retest-source --test --test-concurrency=1 '--test-name-pattern=changing pixels' tests/integration/capture-firefox.test.ts
```

`build-debug-identity`: exit 0; Build only; Cargo accepted the current debug fingerprint, hash unchanged. Log `/tmp/retest-firefox-recording/build-debug-identity.log`; process records `/tmp/retest-firefox-recording/build-debug-identity.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/build-debug-identity.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo build --locked --offline --manifest-path media/Cargo.toml
```

`firefox-release-before`: exit 0; 1 test, 1 passed, 0 failed. Log `/tmp/retest-firefox-recording/firefox-release-before.log`; process records `/tmp/retest-firefox-recording/firefox-release-before.log.owners.json`.

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/firefox-release-before.log env RETEST_FIREFOX_ROUTE=launch-services RETEST_MEDIA_BINARY=/tmp/retest-firefox-recording/fresh-target/release/retest-media RETEST_CAPTURE_PROOF_OUT=/tmp/retest-firefox-recording/firefox-release-before node --conditions=retest-source --test --test-concurrency=1 '--test-name-pattern=changing pixels' tests/integration/capture-firefox.test.ts
```

`odd-height-before`: exit 101; 0 unit tests selected; 1 process test, 0 passed, 1 failed. Log `/tmp/retest-firefox-recording/odd-height-before.log`; process records `/tmp/retest-firefox-recording/odd-height-before.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/odd-height-before.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml odd_height_screenshot_frames_finish_without_loss_inside_their_budget -- --nocapture
```

`odd-height-after`: exit 0; 0 unit tests selected; 1 process test, 1 passed, 0 failed. Log `/tmp/retest-firefox-recording/odd-height-after.log`; process records `/tmp/retest-firefox-recording/odd-height-after.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/odd-height-after.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml odd_height_screenshot_frames_finish_without_loss_inside_their_budget -- --nocapture
```

`firefox-debug-final`: exit 0; 5 tests, 5 passed, 0 failed. Log `/tmp/retest-firefox-recording/firefox-debug-final.log`; process records `/tmp/retest-firefox-recording/firefox-debug-final.log.owners.json`.

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/firefox-debug-final.log env RETEST_FIREFOX_ROUTE=launch-services RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/debug/retest-media RETEST_CAPTURE_PROOF_OUT=/tmp/retest-firefox-recording/firefox-debug-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-firefox.test.ts
```

`chromium-debug-final`: exit 0; 7 tests, 7 passed, 0 failed. Log `/tmp/retest-firefox-recording/chromium-debug-final.log`; process records `/tmp/retest-firefox-recording/chromium-debug-final.log.owners.json`.

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/chromium-debug-final.log env RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/debug/retest-media RETEST_CAPTURE_PROOF_OUT=/tmp/retest-firefox-recording/chromium-debug-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-chromium.test.ts
```

`webkit-debug-final`: exit 0; 5 tests, 5 passed, 0 failed. Log `/tmp/retest-firefox-recording/webkit-debug-final.log`; process records `/tmp/retest-firefox-recording/webkit-debug-final.log.owners.json`.

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/webkit-debug-final.log env RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/debug/retest-media RETEST_CAPTURE_PROOF_OUT=/tmp/retest-firefox-recording/webkit-debug-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-webkit.test.ts
```

`cargo-final`: exit 0; 92 unit tests and 55 process tests passed; 0 failed, ignored or filtered. Log `/tmp/retest-firefox-recording/cargo-final.log`; process records `/tmp/retest-firefox-recording/cargo-final.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/cargo-final.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml
```

`clippy-final`: exit 0; All targets passed with warnings denied. Log `/tmp/retest-firefox-recording/clippy-final.log`; process records `/tmp/retest-firefox-recording/clippy-final.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/clippy-final.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings
```

`build-release-final`: exit 0; Build only; fresh-target release rebuilt against the final manifest. Log `/tmp/retest-firefox-recording/build-release-final.log`; process records `/tmp/retest-firefox-recording/build-release-final.log.owners.json`.

```sh
node /tmp/retest-firefox-recording/gate.mjs /tmp/retest-firefox-recording/build-release-final.log env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo build --release --locked --offline --manifest-path media/Cargo.toml --target-dir /tmp/retest-firefox-recording/fresh-target
```

Formatting and whitespace checks also passed, exit 0:

```sh
/opt/homebrew/bin/rustfmt --check --edition 2024 media/tests/process.rs
git diff --check -- media/Cargo.toml media/tests/process.rs docs/plans/public-beta/codex/phase-4/firefox-recording-report.md docs/plans/public-beta/proofs/firefox-recording.md
```

## Process audit and limits

`/tmp/retest-firefox-recording/process-audit.json` compares 1398 recorded PID/start/command-hash identities against the current process table. Zero still matched. All 741 separately reported browser/decoder/encoder PIDs were absent. The benchmark precheck was empty. The audit sent no signal. No process started by this lane remains running.

`python3 /tmp/retest-firefox-recording/verify-report.py` exited 0. Its retained `report-verification.json` cross-checks the reported frame counts, queue peaks, finish timings, final gate counts and artifact/log references against the actual records. The final formatting/whitespace checks above also exited 0.

No commit, push, stash, checkout, reset, revert or download occurred. No foreign process was ended.

Separate filesystem-publication time was not measured. Successful `finalizeMs` bounds that phase together with queue/encoder work, and the existing slow/stuck finalization regression still passed. This task did not validate arbitrary host load, Linux x64, another architecture or the minimum Rust toolchain. No broader platform claim follows from these browser runs. Whole-tree TypeScript, npm unit/integration and native gates were not rerun; the product change is confined to the Rust development profile and its regression.
