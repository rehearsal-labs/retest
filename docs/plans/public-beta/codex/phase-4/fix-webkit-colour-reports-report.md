# WebKit colour and report fixes

Findings 4, 6 and 7 are fixed. Results were added finding by finding during the work; failed attempts remain below. Existing work is preserved. The other builder's native runner, capture, simulator and native evidence files were not edited. No benchmark, download, commit, stash, reset or revert was run.

| Final check | Result | Log under `.retest/fix-webkit-colour-reports/logs/` |
| --- | --- | --- |
| Offline full Rust | 97 unit + 55 process tests passed | `rust-final-attempt-8.log` |
| All-target clippy, default and allocation-counts | passed, warnings denied | `clippy-locked.log`, `clippy-allocations.log` |
| Real media client | 32/32 passed | `media-client.log` |
| WebKit / Chrome / Firefox evidence targets | 2/2 each passed | `webkit-target.log`, `chrome-target.log`, `firefox-target.log` |
| Corrected pixel routes, all three browsers | 4/4 each passed | `pixels-webkit.log`, `pixels-chrome.log`, `pixels-firefox.log` |
| Full failure/report suite | 21/21 passed, including both formerly failing report children | `report-final.log` |
| Reporter/client/protocol units | 226/226 passed; final reporter fixture 22/22 | `reporter-client-units.log`, `reporter-final.log` |
| TypeScript 6, TypeScript 7 and example | passed | `typecheck-final-attempt-1.log` |
| Read-only process audit | 312 checked PIDs absent | `process-audit-final.log` |

All final test gates had zero skips and cancellations. Cargo had zero ignored or filtered tests. The final media binary is `.retest/fix-webkit-colour-reports/media-target/release/retest-media`, SHA-256 `378bf67a11941052c9113b802488bc66bac2f87ca9e5079e6e97f51ba51ebde6`, recorded in `release-binary-verified.json`.

The record below retains the interim failures and queue states. The table above and the first paragraph of each finding give the final status.

Logs and fresh artifacts go under `.retest/fix-webkit-colour-reports/`. Real browser and compiler gates use `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock`, with a benchmark check before each test and again inside the lock. Cargo uses the explicitly named Homebrew tools and `--locked --offline`; clippy names `cargo-clippy` and `clippy-driver` explicitly.

## Finding 4

Fixed and exercised on real WebKit; Chrome and Firefox still pass. WebKit's unchanged secret-video witness now finds 10 blue and 4 green frames in 14 decoded frames. Its independent ColorSync sample errors range from 0.03515625 to 0.8317057291666666, below the unchanged limit 12. Both media recording routes also pass the known non-sRGB JPEG witness through real ffmpeg.

At initial read, decoding dropped the embedded ICC profile before raw RGB admission, resizing and re-encoding. The retained gate had failed its unchanged safe-green witness, 0/2 passed, exit 1, `.retest/evidence-targets/logs/webkit-release.log`. The contract is that video pixels represent the source's intended colours in sRGB, within codec error, rather than treating profile-encoded channel values as sRGB.

Fresh failing-first command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml a_profiled_jpeg_normalizes`. Exit 101, 0/2 unit tests passed, 92 filtered. Log `.retest/fix-webkit-colour-reports/logs/colour-before.log`. The original linear RGB profile fixture's green should encode as sRGB 188; unchanged raw decode returned `[0,128,1]`. Matching encoded-route admission returned the original JPEG instead of normalized pixels. No product fix preceded these failures.

Retained WebKit JPEGs have an RGB/XYZ matrix profile with shared 1024-entry channel curves. The fix will normalize this profile class before encoding and refuse unsupported or malformed profiles explicitly. No crate or platform dependency is added. The equations follow the [ICC sRGB specification](https://registry.color.org/rgb-registry/files/sRGB.pdf) and [ICC profile format](https://www.color.org/icc1-v41.pdf); code and fixtures are original.

The first fixed-tree run, `colour-after.log`, still failed 0/2 because the new test assumed JPEG preserved a zero blue channel. Its actual stored witness is `[0,128,1]`; linear blue 1/255 correctly becomes sRGB 13. The fixture now explicitly checks those stored JPEG channels and expects `[0,188,13]`, with the same channel tolerances. This corrects the new fixture's arithmetic; it does not relax the real WebKit witness. The fixture also now writes the required D50 header illuminant. The original failing green value 128 remains incompatible with the corrected expected green 188.

After that fixture correction, the same Rust command passed 2/2, exit 0, `.retest/fix-webkit-colour-reports/logs/colour-after-2.log`. `frame.rs` converts valid RGB matrix/TRC profiles to sRGB before canvas fitting and re-encodes profiled frames even when size/format match the encoder route. Unsupported LUT profiles, invalid tag offsets and invalid channel curves fail explicitly. Unprofiled matching bytes retain their existing path. Expanded boundary tests and real ffmpeg/video checks are pending.

First fresh fixed-binary WebKit run acquired the lock on retry 6. Exit 1, 0/1 passed, no skips/cancellations, `logs/webkit-fixed-attempt-6.log`; exact locked command is in its `.command` file. Artifacts `webkit-fixed/{webkit-on,webkit-observations}`. It stopped before the green witness because `verifyVideo` compares the normalized movie to ffmpeg's unmanaged decode of the original profiled JPEG. Mapped frame 4 differed by mean gray error 33.3828125 against the unchanged limit 12. This check still assumes profile channels are sRGB, so its source oracle needs the same intended-colour contract, independently implemented. The fix will use macOS ColorSync through `/usr/bin/sips` to normalize the reference only, preserve the original JPEG, and retain the same sample mapping, sizing and error limit. The actual green-witness predicate is unchanged. No passing WebKit target is claimed yet.

The independent reference is implemented in `tests/integration/evidence-support.test.ts`: `/usr/bin/sips --matchToWithIntent '/System/Library/ColorSync/Profiles/sRGB Profile.icc' relative --setProperty format png <original> --out <separate reference>`. Every sampled WebKit frame must still meet mean error below 12 against this independently normalized source, and all original map/decode/witness checks remain. The reference path and method are written into each decode record. ColorSync is a macOS verification prerequisite, not a product dependency or conversion fallback. Rust also refuses an RGB ICC profile attached to grayscale pixels, avoiding an unsupported interpretation and expansion beyond the decoded pixel bound; its regression is added. Final locked Rust and new WebKit results are pending.

## Finding 6

Fixed. Both real killed-run report children pass in the 21/21 failure suite. Human output names `run_stopped` and the full reason; HTML retains the same full reason, and reconstructed JSONL/result retains its code and message. Application outcome, CLI exit, incomplete status and cleanup checks remain intact.

At initial read, `src/reporters/human.ts` printed recording-gap messages from terminal events. A killed runner has no ending event for its recording; JSONL reconstruction creates `run_stopped` gaps only in the rebuilt result. `onRunEnd` printed aggregate evidence status without those result-only messages.

Fresh failing-first command: `node --conditions=retest-source --test --test-name-pattern='JSONL reconstruction names every' tests/unit/reporters-human.test.ts`. Exit 1, 0/1 passed, no skips or cancellations, `.retest/fix-webkit-colour-reports/logs/reports-before.log`. Realistic recording events are cut before `recording.finished` and rebuilt through the production JSONL reader. The terminal omits `run_stopped` and its reason.

`human.ts` now prints result-only gaps with the test/app, code and exact reason at run end, and names run-level gaps. It tracks already printed attempt reasons to avoid duplicate output. Full human reporter file passed 21/21, exit 0, `.retest/fix-webkit-colour-reports/logs/reports-after.log`, command `node --conditions=retest-source --test tests/unit/reporters-human.test.ts`. After adding the multiple-gap/duplicate regression, the same command passed 22/22, exit 0, `logs/reporter-units.log`. The two real-suite checks now additionally require gap codes and every exact escaped HTML reason, without removing their original assertions; those gates are pending.

## Finding 7

Corrected against the guide and exercised on Chrome, Firefox and WebKit, 4/4 per browser. The screenshot still requires an error and its exact policy reason. The wholly withheld interval requires an inconclusive result, its exact no-frame reason and strictly empty unavailable evidence. No withheld request reaches the judge, and all original decoder/privacy checks pass.

The retained pixel gates failed two expectations per browser, `.retest/evidence-targets/logs/pixels-{chrome-final,firefox,webkit}.log`. The screenshot expectation requires the word `pixel` instead of its actual policy reason. The frame expectation requires `error`, though the documented settlement table makes a wholly withheld interval with no kept frames inconclusive. New runs against unchanged expectations are pending. Corrections must require the exact reasons, no persisted secret image, no frames and no judge dispatch. Neither unavailable check may pass.

First fresh locked submission returned 75, lock busy; no test started. Exact command and benchmark result are `.retest/fix-webkit-colour-reports/logs/pixels-before.command` and `pixels-before.benchmark.log`; lock output is `pixels-before.log`. The gate will be retried after the shared-lock wait.

Submissions `pixels-before-2` and `pixels-before-3` also returned 75 without starting tests. Each exact command, benchmark check and lock result is retained under `logs/`. Product and pixel-test expectations remain unchanged for this finding.

Submissions `pixels-before-4` and `pixels-before-5` likewise returned 75. Read-only lock-owner inspection identifies the other builder's native evidence gate. Its process and devices were left alone.

Submission `pixels-before-6` acquired the lock and reproduced both failures with unchanged pixel expectations. Command: `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-webkit-colour-reports/run.py --inside env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/pixels-before-6 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Exit 1, 1/4 passed, 3 failed including the parent, zero skips/cancellations, `logs/pixels-before-6.log`. Screenshot reason is exactly `Retest withheld this capture of web by policy: the secret "value" was typed into a field Retest could not read, and the field had not been seen to stop showing it.` The frame request is inconclusive with zero bytes, unavailable evidence, empty frames, and the exact reason `The recording of web kept no frame from 2705 ms to 3205 ms on the run's clock, so the check has nothing to judge.` Both withheld requests stayed out of the judge calls. Artifacts are in `pixels-before-6/pixels/` and `pixels-before-6/observations/`.

Corrected the two new expectations in `tests/integration/evidence-pixel-artifacts.test.ts`. The screenshot must still be `error` with no evidence, and now must equal the full policy-withholding reason, which is stricter than a word search. The interval must be `inconclusive` and carry one unavailable frame record, empty frames, zero bytes, the empty-byte hash, no path, exactly the requested 500000 microsecond interval entirely inside withholding, and an exact reason reconstructed from that recorded interval. These checks cannot accept a pass or a judged missing image. The existing no-persisted-image, HTML reason, no-judge-dispatch, secret-byte and independent decoder assertions remain. The guide's settlement table at `docs/guide.md:939` explains why missing interval evidence cannot settle an appearance check. No product evaluation behavior changed. Fresh corrected gates are pending.

## Additional verification record

`env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml frame::tests` passed 12/12 unit tests, 84 filtered, 0 process tests selected, exit 0, `logs/frame-units.log`. This includes malformed/LUT profile refusals and channel-curve boundary checks. A real ffmpeg round-trip test was added afterward and is pending.

First all-target clippy exited 101 on three uses of constant-sized `chunks_exact_mut` in this lane's new code, `logs/clippy.log`. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings`. The code now uses `as_chunks_mut`, available at the manifest's Rust 1.88 floor. No warning is suppressed. Rerun is pending.

The clippy rerun passed with warnings denied, exit 0, `logs/clippy-2.log`, same command. The independent offline release build passed, exit 0, `logs/release-build.log`: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc CARGO_TARGET_DIR=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target /opt/homebrew/bin/cargo build --release --locked --offline --manifest-path media/Cargo.toml`. This separate target directory avoids replacing the other builder's media binary. Installed compiler and Cargo are Homebrew 1.98.1; the minimum toolchain is unverified. First fixed WebKit submission was lock-busy, exit 75, `logs/webkit-first.log`, no tests started.

Full Rust submission `rust-all` was lock-busy, exit 75, `logs/rust-all.log`, no tests started. Its `.command` file records the locked invocation. Only one heavy gate is submitted at a time.

Reporter, media-client and protocol units passed 226/226, exit 0, no skips/cancellations, `logs/reporter-client-units.log`. Command: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-*.test.ts tests/unit/media-client-*.test.ts tests/unit/media-protocol.test.ts`; the `.command` file lists every expanded file. WebKit submissions `webkit-fixed-2` and `webkit-fixed-3` remained lock-busy, exit 75, no test started. Their commands and benchmark checks are retained alongside their logs.

`wait-lock.py` now records its own process identity and retries the sole pending WebKit gate at the common-rules lock interval. `webkit-fixed-attempt-1` and `-2` returned 75 with no test started. Source documentation now states the colour contract and supported profile type. Normalized pixels also carry sRGB metadata in memory. The ffmpeg regression now checks both raw and encoded inputs at both source and resized sizes. These last source/test changes need a new final build after the queued diagnostic gate; its current binary digest is retained in `release-binary.json` and no mutable-source release claim is made.

The all-target Rust compile check passed, exit 0, `logs/rust-check.log`: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo check --locked --offline --manifest-path media/Cargo.toml --all-targets`. This preceded the last test-fixture metadata completion. The final offline release build then passed, exit 0, `logs/release-final.log`, same release command as above. Its digest is separately retained in `release-binary-final.json`. WebKit retry attempts 3 through 5 returned 75, no tests started. The final rebuild finished while all attempts were still lock-busy, so no running target's binary was replaced.

The sole queued gate is now full Rust, `rust-final-attempt-{1,2}` lock-busy, exit 75, no tests started. The waiter has a recorded identity in `logs/rust-final.wait-owner.json`. A final independent release rebuild after the grayscale guard is underway in `logs/release-verified.log`.

That final offline release rebuild passed, exit 0, `logs/release-verified.log`, with the same release command and separate target directory. The exact tested binary path/digest is now `release-binary-verified.json`. Rust lock attempts 3 and 4 also returned 75 without starting tests. No second heavy command is queued.

Rust attempts 5 through 7 likewise returned 75. The other builder's recorded Firefox flow owns the current lock, confirmed by read-only process identity. No process, simulator or desktop window belonging to that gate was modified. Logs, exact commands and clear benchmark checks remain in each attempt's files.

Full Rust acquired the lock on attempt 8 and passed, exit 0, 97 unit tests and 55 process tests, none ignored or filtered, `logs/rust-final-attempt-8.log`. Exact command: `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/run.py --inside env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml`. The original process lifecycle, exit, timeout, malformed-image and cleanup tests passed. The new profiled-JPEG ffmpeg test passed on raw and encoded inputs, at 16 by 16 and 8 by 8, while preserving its known sRGB witness and codec tolerance. Unsupported/malformed profile and grayscale mismatch tests passed.

Standalone final clippy submission was lock-busy, exit 75, `logs/clippy-final.log`. The remaining checks are now one sequential shared-lock gate, `remaining.py`, with no concurrent commands and a stop on the first failure. It writes a separate exact command, owner identity, benchmark check, result and log for each check. First outer submission returned 75, `logs/remaining-attempt-1.log`, no test started. This avoids multiple pending heavy gates. The outer command is `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-webkit-colour-reports/run.py --inside python3 .retest/fix-webkit-colour-reports/remaining.py`; the script names final clippy, media client, three browser targets, three pixel routes, the failure/report suite and `npm run typecheck` in that order. Every nested test checks for a benchmark before starting while the outer lock remains held.

Remaining-gate attempts 2 and 3 were also lock-busy, exit 75. The shared `media/target/release/retest-media` used by the other builder was left intact. This lane's tests explicitly select the separate verified binary. A combined candidate using the default shared path needs an offline rebuild after both builders finish; the source-oracle colour check now requires intended colours from whichever binary a gate selects.

## What this lane did not verify

This lane did not exercise native platforms, physical devices, other operating systems, the minimum Rust toolchain, compiled/package installation, live views or remote model quality. The browser gates use Retest's source CLI and a fake judge that verifies approved evidence handoff. Whole-tree unit/integration suites were not run. Matrix/TRC ICC conversion is the implemented contract; LUT profiles and other unsupported profile types are explicitly refused. ColorSync reference conversion was exercised only on this macOS host. The mutable shared tree was not a frozen release candidate, and the other builder's default release binary was left intact.

## Locked remaining gate, results as completed

Outer attempt 4 acquired the shared lock. The following commands ran sequentially under that one lock, with an additional benchmark check before each.

### Final clippy, default and allocation-counts

Exit 0, all targets checked, warnings denied. Log `.retest/fix-webkit-colour-reports/logs/clippy-locked.log`. Exact nested command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings`.

### Final clippy with allocation counts

Exit 0, all targets checked, warnings denied. Log `.retest/fix-webkit-colour-reports/logs/clippy-allocations.log`. Exact nested command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets --features allocation-counts -- -D warnings`.

### Real media client

Exit 0, 32/32 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/media-client.log`. Exact nested command: `env RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg node --conditions=retest-source --test proofs/media/client.test.ts`.

### WebKit intended-colour evidence target

Exit 0, 2/2 passed, no skips/cancellations; 14 decoded secret-video frames, 10 blue and 4 green. Log `.retest/fix-webkit-colour-reports/logs/webkit-target.log`. Exact nested command: `env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`.

### Chrome evidence target

Exit 0, 2/2 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/chrome-target.log`. Exact nested command: `env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`.

Finding 4 now has a passing real WebKit target. The original green and no-red predicates, closed withholding interval exclusion, whole-video decode, identity/maps, screenshots and on/off verdict comparison all passed. Independent ColorSync reference sample errors were below the unchanged limit 12. Artifacts are `.retest/fix-webkit-colour-reports/webkit/{webkit-on,webkit-off,webkit-observations}`. Chrome also passed with the same final media binary. Firefox and the remaining report/pixel checks are still running or pending.

### Firefox evidence target

Exit 0, 2/2 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/firefox-target.log`. Exact nested command: `env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`.

### Finding 7, corrected Chrome pixel routes

Exit 0, 4/4 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/pixels-chrome.log`. Exact nested command: `env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/pixels-chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`.

All three browser evidence targets now pass with the verified binary. The corrected Chrome screenshot and empty-interval checks also pass, including exact reasons, unavailable/empty evidence, and no withheld judge call. Original screenshot/frame/video/thumbnail decodes and secret-scene rejection remain passing. Firefox uses Launch Services as in the retained evidence record.

### Finding 7, corrected Firefox pixel routes

Exit 0, 4/4 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/pixels-firefox.log`. Exact nested command: `env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/pixels-firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`.

### Finding 7, corrected WebKit pixel routes

Exit 0, 4/4 passed, no skips/cancellations. Log `.retest/fix-webkit-colour-reports/logs/pixels-webkit.log`. Exact nested command: `env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/pixels-webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`.

### Finding 6, full failure-suite readback

The first full failure suite exited 1, 17/21 passed, 4 failed including two parents, no skips/cancellations, `logs/report-failures.log`. Exact nested command: `env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/report-failures node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-failures.test.ts`. The sequential outer gate stopped there and did not run typecheck.

Both original exact terminal-gap assertions now pass. The new stronger terminal-code assertion also passes. The remaining failures are this lane's added requirement that HTML contain the literal gap code as well as its reason. Current HTML prints the complete exact interrupted reason but no code string. That extra literal-code requirement was not an existing assertion or the reported defect. The check will continue to require every exact HTML reason and every exact terminal reason/code, preserving the original checks; it will not require an unimplemented HTML code label. Failed artifacts are retained under `report-failures/{runner-exit,leftovers}`.

### Finding 6, corrected full report gate

Exit 0, 21/21 passed, zero skips/cancellations, `logs/report-final.log`. Exact nested command: `env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/media-target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/report-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-failures.test.ts`. Both `runner-exit terminal, JSONL and HTML evidence agree` and `leftovers terminal, JSONL and HTML evidence agree` passed, as did their owned-process/partial-file cleanup parents. Original application outcomes and on/off exits remain checked. Fresh artifacts `report-final/{runner-exit,leftovers}` contain the exact interrupted reason in HTML and human output, and the terminal names `run_stopped`.

### Typecheck fixture correction

`npm run typecheck` exited 2, `logs/typecheck.log`. The first compiler rejected this lane's new reporter fixture because an `as const` assertion made `evidenceStatus.gaps` readonly while the event contract requires a mutable array. This is a test typing error; the runtime tests passed. The fixture will use a contextual `RetestEvent` return type with its ordinary copied gap array, without widening or ignoring errors. The gate stopped; later compilers have not yet run.

### Final reporter fixture and compiler checks

The corrected reporter fixture passed 22/22, exit 0, no skips/cancellations, `logs/reporter-final.log`, exact command `node --conditions=retest-source --test tests/unit/reporters-human.test.ts`. The contextual event type preserves strict mutable event fields; no error is ignored or widened.

Final locked `npm run typecheck` passed, exit 0, TypeScript 6 project, TypeScript 7 project and TypeScript 6 example, `logs/typecheck-final-attempt-1.log`. Exact command: `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-webkit-colour-reports/run.py --inside npm run typecheck`. Every requested test/check now has a passing final result. The recorded process audit and report closeout are the only remaining work.

### Process audit helper correction

The first audit returned 1 because it included its own recorded active PID, `logs/process-audit.log`; all other 311 recorded PIDs were absent. This was the auditor, not a leaked resource. The read-only audit now explicitly excludes its current PID and retains that exclusion in the result. It sends no signals and will check the first auditor's now-completed identity on rerun.

### Final process and benchmark audit

Read-only process audit passed, exit 0, 313 recorded readings and 312 unique PIDs checked, none present, `logs/process-audit-final.log` and `process-audit.json`. It excluded only its own active PID, which then exited and was reaped by `run.py`. Command: `python3 .retest/fix-webkit-colour-reports/audit.py`. Gate/waiter, decoder, thumbnail and reported browser/server/media identities were checked; no signal was sent. Harness cleanup and failure-suite owned-descendant/partial-file assertions passed independently. All 60 recorded pre-command benchmark checks were clear, with a second check inside each acquired outer lock. No task gate or waiter remains running.

## Files changed by this lane

- `media/src/frame.rs`: bounded ICC matrix/TRC normalization, profile-aware video admission, original profile fixtures and colour/refusal/ffmpeg tests.
- `src/reporters/human.ts`: result-only and run-level evidence reasons with exact codes/messages, avoiding duplicate attempt reasons.
- `tests/unit/reporters-human.test.ts`: interrupted JSONL reconstruction and multiple-gap/duplicate regressions.
- `tests/integration/evidence-support.test.ts`: independent ColorSync reference conversion for the intended-colour check, preserving source bytes and all thresholds/maps.
- `tests/integration/evidence-failures.test.ts`: exact HTML reason and terminal code checks added to the original report assertions.
- `tests/integration/evidence-pixel-artifacts.test.ts`: the two authorized expectation corrections, with exact reason, empty-evidence and wholly-withheld interval checks.
- This report.

Command scripts, logs, failed/final target artifacts, original source frames, independent sRGB references and process identities remain under `.retest/fix-webkit-colour-reports/`. No dependency, manifest, export, product CLI command or unrelated source file was added or changed.

Closeout readback confirmed every recorded waiter and the final auditor absent, `logs/closeout-processes.log`. All required final gate exit files are zero. Scoped `git diff --check` passed for every lane file and this report.
