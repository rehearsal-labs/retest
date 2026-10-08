# Media crate review fixes

## Changes

- media/src/ledger.rs and jobs.rs preserve capture-gap overflow uncertainty; protocol.rs and src/media/protocol.ts carry the optional count. src/evaluation/frames.ts classifies it as missing evidence.
- media/src/recording.rs, place.rs and main.rs supervise file finalization within the finish budget, including source unlink. Timeout names the partial and any uncertain publication outcome.
- media/src/replies.rs, server.rs, jobs.rs and main.rs bound reply admission and writer shutdown, count lost replies, and report blocked stdout through structured stderr and exit 2. Its separate stdout descriptor is atomically close-on-exec to prevent encoder descendants retaining the reply pipe.
- media/src/place.rs replaces the checked ordinary rename with exclusive link-then-unlink and refuses unsupported placement.
- media/src/frame.rs validates matching-format images by decoding. jobs.rs and live.rs name undecodable thumbnail/live refusals.
- media/tests/process.rs adds the five requested scenario regressions; ledger.rs and place.rs add boundary/race units. tests/unit/evaluation-frames.test.ts and media-protocol.test.ts verify evidence classification and additive-field validation. media-client-v2.md records the actual contract and reader compatibility.

## Protocol changes

- `FrameSequence.captureGapsOmitted?: number` counts omitted capture-gap details across the recording when their conservative bounds may overlap the requested interval. A positive count always makes evaluation evidence partial. The `message` also names the omission for consumers that tolerate additive fields. Older strict protocol-2 readers reject replies carrying the new fields because unknown keys are refused. Run-folder schemaVersion stays 1 and has no new field or event. Protocol version stays 2; no method changes.
- `Bye.repliesDropped?: number` counts normal replies dropped before bye admission, absent when zero. Stderr's versioned `mediaReplyFailure` names final drop totals and an unknown in-flight write, with stdout_blocked or replies_dropped. Any reply loss or blocked writer exits 2. The protocol note records both.

## Scope and starting state

Assigned findings 1, 7, 8, 10 and 11, in that order. Changes are confined to media/, excluding encoder.rs, the single missing-evidence change in src/evaluation/frames.ts, supporting protocol types and regression tests, and this report and media-client-v2.md. Other builders own the named reporter, store, installer, client-start, runner and capture files. Existing edits are preserved. No commit, stash, reset, revert, download or benchmark is authorized.

Read common-rules.md, phase-4/common.md and the second-read review. The review establishes a retained-gap cap of 1024, finalization after mark_done, an unbounded normal-reply wait and writer join, a checked-rename race, and a fit fast path without decoding. These still need failing-first reproductions against the current tree.

Logs and command scripts go under /tmp/retest-fix-media-crate/. Homebrew Rust will be named explicitly and Cargo runs offline. The manifest currently declares Rust 1.88; the requested edition floor is 1.85. No minimum-toolchain claim follows from using the installed newer compiler.

## Finding 1

Fixed. Failing-first Rust and TypeScript evidence and exact commands are recorded below.

## Finding 7

Fixed. Slow and stuck supervised finalization are exercised below.

## Finding 8

Fixed. The real media-process pipe saturation and EOF regression is recorded below.

## Finding 10

Fixed. A barrier-controlled foreign-writer race exercises the unsupported rename branch.

## Finding 11

Fixed. Matching-format PNG/JPEG thumbnails and JPEG live refusal are exercised below.

## Verification

Heavy gates use /tmp/retest-heavy-gate.lock and /tmp/retest-fix-media-crate/run.py checks pgrep for benchmarks/run.ts before each command, refusing an actual Node/Bun/tsx benchmark process. Each command is logged with its exact argument list and exit, and its launched PID, start time and command are recorded in the matching .owner.json. No benchmark ran. Final verification: three offline Rust runs each passed 92 unit and 54 process tests; all-target clippy passed both default and allocation-counts with warnings denied; media/evaluation units passed 169; the locked media client passed 32; scoped TypeScript 6 and 7 passed. Final log paths and earlier failures follow in the execution record.

## Unverified

- Linux x64 and the minimum Rust toolchain were not exercised. This host uses Homebrew Rust 1.98.1, above the manifest's 1.88 minimum.
- A real kernel/filesystem syscall stuck inside finalization was not exercised; the debug hook proves supervision of slow/stuck work. If a syscall was dispatched before cancellation, its publication outcome can be unknown and is named.
- A real filesystem lacking both hard links and exclusive rename was not exercised. That route now fails explicitly; the deterministic race injects the unsupported rename result.
- Native capture, HTML playback, whole-tree TypeScript/unit gates and release/installation are outside this verification scope.

## Execution record

### Finding 1, failing-first progress

Added the overflow Rust process regression and an evaluation regression. The first Rust command exited 101 on incorrect test-helper calls, so it is fixture failure, not defect evidence: /tmp/retest-fix-media-crate/finding-1-rust-before.log. Those calls are corrected before repeating it. The evaluation regression ran against unchanged evaluation code and failed with pass/complete/true instead of inconclusive/partial/false, 1 test, 0 passed, 1 failed. Exact command: `node --conditions=retest-source --test --test-name-pattern='omitted capture gaps make' tests/unit/evaluation-frames.test.ts`. Log: /tmp/retest-fix-media-crate/finding-1-ts-before.log. No product fix applied yet.

The corrected Rust regression now reproduces the review scenario. It retained two shown frames and zero losses, but captureGapsOmitted was absent and there was no missing-evidence warning. Exit 101, 1 process test failed; 0 unit tests selected. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml a_sequence_names_capture_gaps_omitted_after_the_retained_list_fills`. Log: /tmp/retest-fix-media-crate/finding-1-rust-before-corrected.log.

### Finding 1, fixed

The ledger now holds only two bounds plus the existing count for omitted capture gaps. Sequence replies whose interval may overlap those bounds carry captureGapsOmitted and a message warning. Evaluation missingParts treats any positive marker as missing evidence. The count covers all omitted details across the recording, rather than inventing an exact interval count. The new field is optional and absent outside the omitted bounds. The protocol note is updated.

Repeated the two commands above with the fix: Rust 1 process test passed, 0 unit tests selected, exit 0, /tmp/retest-fix-media-crate/finding-1-rust-after.log; evaluation 1 test passed, exit 0, /tmp/retest-fix-media-crate/finding-1-ts-after.log.

### Finding 7, design finding

Confirmed that mark_done precedes place_video, and exited_at disables the watchdog's deadline check before copy/sync/rename. A filesystem call cannot be interrupted safely on a Rust thread. Finalization will run in a supervised child of this same binary, retain the original partial until accepted, and report deadline_exceeded on a finish-budget overrun. Test infrastructure will add a debug-only slow/stuck finalization hook before changing recording behavior.

Finding 7 failing-first command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml slow_or_stuck_file_finalization_is_deadline_exceeded_with_the_partial_named`. Exit 101, 1 process test failed, 0 unit tests selected. The slow hook returned ok/complete after 1049 ms despite deadlineMs 400; the stuck branch was not reached in this failing run. Log: /tmp/retest-fix-media-crate/finding-7-before.log.

The first fixed-tree attempt did not compile because an edit also touched wait_for_encoder, which has no ending variable. Corrected that edit; /tmp/retest-fix-media-crate/finding-7-after.log is not a test result. The helper is a private --finalize-file mode of the same binary, with an empty environment and only explicit debug hooks forwarded. The supervising Child handle authorizes only this unreaped worker.

### Finding 7, fixed

Both slow and stuck finalization branches passed with the fix, 1 process test containing both cases, exit 0. Command is the same as failing-first; log /tmp/retest-fix-media-crate/finding-7-after-corrected.log. The watchdog remains active until conclude returns. A supervised child performs file metadata, copy, sync and publication with the remaining finish budget. A timed-out child is stopped through its Child handle and its exit reconciled; the original .partial remains named, and no ok reply is produced. Encoder stderr and descendant cleanup keep their existing separate checks. Debug-only hooks are absent from release builds. The existing killed-copy regression's whole-process crash is preserved when the helper is killed mid-copy. A real blocked filesystem syscall remains unverified; the test isolates slow/stuck work with the debug hook.

### Finding 8, reproduction started

Confirmed unbounded queue wait and writer join. Adding a process test that retains stdout unread, fills normal replies, and closes stdin. It checks both input progress and bounded exit, then requires structured stderr accounting for dropped replies and stdout_blocked. A blocked stdout cannot receive its own failure report; stderr and exit status must carry that reason.

Finding 8 failing-first command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml unread_stdout_and_a_full_normal_reply_queue_cannot_hold_eof_or_shutdown`. Exit 101, 1 process test failed, 0 unit tests selected. The client closed stdin, but the media process remained alive with stdout unread until the test stopped its own unreaped Child. Log: /tmp/retest-fix-media-crate/finding-8-before.log.

### Finding 8, fixed

The failing-first command now passes, 1 process test, 0 unit tests selected, exit 0, /tmp/retest-fix-media-crate/finding-8-after.log. Normal reply admission waits only within its bound, escapes on input EOF/shutdown, and counts dropped replies. After a pressure drop, a still-full queue no longer repeats the wait for every request. The input reader signals closure directly before sending EOF through the bounded channel. Jobs release reply waits before joining. Writer close waits within its bound; a blocked write is an unknown delivery, queued discarded replies are counted, stderr records the final reason, and the process exits 2. The writer owns a duplicated stdout descriptor so it cannot block Rust's global stdout shutdown flush. Bye gains the optional count documented at the top of this report.

### Finding 10, reproduction started

The unsupported-exclusive-rename branch still checks the destination then uses ordinary rename, which can replace a foreign file. Adding a deterministic foreign-writer race at that boundary before replacing this fallback with link-then-unlink. If the filesystem cannot support either exclusive rename or linking, placement must fail explicitly and preserve the partial.

Finding 10 failing-first command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml a_foreign_writer_at_the_unsupported_rename_boundary_is_never_replaced`. Exit 101, 1 unit test failed. A barrier lets the foreign writer create its completed video after the destination check. The ordinary rename then succeeds and replaces it. Log: /tmp/retest-fix-media-crate/finding-10-before.log.

### Finding 10, fixed

The same race command passes, 1 unit test, exit 0, /tmp/retest-fix-media-crate/finding-10-after.log. The fallback uses hard_link then removes the copying name. Exclusive publication sees the foreign writer's file and returns AlreadyExists with its path named; both foreign bytes and this producer's source remain intact. A filesystem lacking both exclusive rename and hard links is refused instead of taking a replacing rename. This is a deliberate availability limit and is documented in the TypeScript recording contract. No real such filesystem was exercised.

### Finding 11, reproduction started

The fit fast path still returns matching-format bytes after reading dimensions only. Thumbnail uses it directly, and live receives images before the encoder validates them. Adding thumbnail and live process regressions with header-readable image data that the image decoder rejects.

Finding 11 first attempt: 2 tests failed at the JPEG fixture's own decode assertion, not at product behavior. This image library accepts a scan with no pixel data, so truncation alone does not reproduce this defect for JPEG. Log /tmp/retest-fix-media-crate/finding-11-before.log. The fixture is being corrected to use a malformed scan marker while preserving readable dimension headers; no product change yet.

The malformed-scan-marker fixture was also accepted, so /tmp/retest-fix-media-crate/finding-11-before-corrected.log remains fixture failure, 2 failed tests. The corrected missing-Huffman-table JPEG proves dimensions are readable and full decoding fails. With it, the unchanged product failed both route regressions: the PNG thumbnail returned ok with invalid bytes at its completed path; the live JPEG was sent to the watcher. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml header_readable_undecodable`. Exit 101, 2 process tests failed, 0 unit tests selected. Log: /tmp/retest-fix-media-crate/finding-11-before-tables.log.

### Finding 11, fixed

The corrected failing-first command passes with the fix, 2 process tests, exit 0, /tmp/retest-fix-media-crate/finding-11-after.log. fit now runs the recording route's bounded decode_image check before its matching-format fast path. Original bytes are retained only after decoding succeeds. Thumbnail refuses undecodable by status and message, with no completed file. Live never offers the bad frame, counts it failed, and names the last refusal and frame id in watchEnded.message. Both PNG and JPEG thumbnail branches and JPEG live were exercised with the fake encoder process.

### Pre-gate correction to finding 7

Moved source removal into the supervised finalizer too, so the successful recording thread performs no filesystem operation after it accepts that child's result. The deadline also covers unlink. If a timeout interrupts a dispatched filesystem operation, the reply names both the possible partial and the publication path and explicitly preserves uncertainty; it does not claim the source is certainly still present. The slow/stuck hook before publication continues to require a retained partial and no completed artifact. No cancellation claim assumes a dispatched filesystem call was undone.

### Verification progress

The first whole Rust run passed, 90 unit and 54 process tests, none ignored or filtered, exit 0. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml`. Log: /tmp/retest-fix-media-crate/cargo-1.log. This includes the existing killed-copy and encoder-deadline assertions. Installed tools report rustc 1.98.1 Homebrew, cargo 1.98.1 Homebrew and Node v24.12.0.

Clippy passed on all targets with warnings denied, exit 0. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings`. Log: /tmp/retest-fix-media-crate/clippy.log. Rustfmt was applied only to this lane's files with `--config skip_children=true`, excluding encoder.rs.

Added a ledger boundary unit to verify omitted gaps reported out of order extend both bounds, disjoint intervals have no marker, and intervening intervals conservatively retain uncertainty. Also made an unreadable finalizer child status stop/reconcile that owned child before returning an error. These additions require a fresh three-run Rust series and final clippy, rather than counting earlier runs as the final tree.

The second earlier Rust run also passed, 90 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-2.log. Final source adds the boundary unit and status-read cleanup afterward. A new final series is running. The additive protocol parser regression now checks both optional markers and refuses negative/fractional counts.

Scoped compiler configuration is /tmp/retest-fix-media-crate/tsconfig-media.json. It extends the repository's strict config, names the same installed Node type root, and includes src/media/**/*.ts, src/evaluation/frames.ts, tests/unit/media-*.test.ts and tests/unit/evaluation-frames.test.ts. Imports are checked normally. It changes no strictness or compatibility setting. proofs/media/tsconfig.json is checked separately.

The first final-series Rust run passed, 91 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-final-1.log. The scoped compiler gate did not run: lockf exited 75 because the shared lock was held by another builder, /tmp/retest-fix-media-crate/types-gate.log. That worker was left alone. Schema inspection also established that older strict protocol-2 clients reject replies carrying new optional keys; the protocol note now says this rather than claiming those readers accept additive fields. No persisted run-folder field is added.

Scoped TypeScript checks passed through the shared lock, gate exit 0, /tmp/retest-fix-media-crate/types-gate-2.log. Exact gate: `lockf -t 0 /tmp/retest-heavy-gate.lock python3 /tmp/retest-fix-media-crate/types.py`. Each command below exited 0:

- `node /Users/dragon/Documents/Projects/Gruvi/Products/retest/node_modules/typescript/bin/tsc -p /tmp/retest-fix-media-crate/tsconfig-media.json --noEmit --incremental false`, /tmp/retest-fix-media-crate/media-types-6.log.
- `node /Users/dragon/Documents/Projects/Gruvi/Products/retest/node_modules/typescript/bin/tsc -p proofs/media/tsconfig.json --noEmit --incremental false`, /tmp/retest-fix-media-crate/proofs-types-6.log.
- `node /Users/dragon/Documents/Projects/Gruvi/Products/retest/node_modules/typescript-7/bin/tsc -p /tmp/retest-fix-media-crate/tsconfig-media.json --noEmit --incremental false`, /tmp/retest-fix-media-crate/media-types-7.log.
- `node /Users/dragon/Documents/Projects/Gruvi/Products/retest/node_modules/typescript-7/bin/tsc -p proofs/media/tsconfig.json --noEmit --incremental false`, /tmp/retest-fix-media-crate/proofs-types-7.log.

The second final-series Rust run passed, 91 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-final-2.log. The command is identical to the first final-series run.

The media unit gate's first attempt was also lock-busy, exit 75, /tmp/retest-fix-media-crate/media-unit.log. No unit test ran in that attempt and no other builder was interrupted.

The third final-series Rust run passed, 91 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-final-3.log. All three final runs used default parallel execution, with no ignored, skipped or filtered tests.

Final clippy and the offline release build passed:

- `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings`, exit 0, /tmp/retest-fix-media-crate/clippy-final.log.
- `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path media/Cargo.toml --all-targets --features allocation-counts -- -D warnings`, exit 0, /tmp/retest-fix-media-crate/clippy-allocation-counts.log.
- `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo build --release --locked --offline --manifest-path media/Cargo.toml`, exit 0, /tmp/retest-fix-media-crate/build-release.log.

The second media-unit lock attempt was busy too, exit 75, /tmp/retest-fix-media-crate/media-unit-2.log; no test ran.

The combined unit/client gate was lock-busy too, exit 75, /tmp/retest-fix-media-crate/tests-gate.log. No test ran.

Formatting check passed, exit 0: `/opt/homebrew/bin/rustfmt --edition 2024 --config skip_children=true --check media/src/main.rs media/src/ledger.rs media/src/jobs.rs media/src/recording.rs media/src/place.rs media/src/replies.rs media/src/server.rs media/src/frame.rs media/src/live.rs media/src/protocol.rs media/tests/process.rs`. Log: /tmp/retest-fix-media-crate/fmt-check.log. encoder.rs is excluded and skip_children prevents traversal into it. Scoped git diff --check also returned 0.

Release binary SHA-256: effa8cc72e5936e1a49162d4b4437f733caa3227e835bd2be19b611f0451a543. This identifies the offline build waiting for the client gate.

Source changes preserve all existing test assertions. Failed fixture/compile attempts remain in the record and are not counted as product reproductions or passes.

The next combined gate attempt also found the lock busy, exit 75, /tmp/retest-fix-media-crate/tests-gate-2.log. Unit files are now running without the lock under common.md's explicit unit-file exception; the real client test remains queued for the lock. The proof record is docs/plans/public-beta/proofs/media-review-fixes.md. The Started documentation now says a video is only claimed on ok, since cancellation may leave publication uncertain even though no artifact is claimed.

### Media unit result and other-lane handoff

Exact command: `node --conditions=retest-source --test tests/unit/media-capture.test.ts tests/unit/media-discovery-bounds.test.ts tests/unit/media-environment.test.ts tests/unit/media-install.test.ts tests/unit/media-locate.test.ts tests/unit/media-ownership.test.ts tests/unit/media-policy.test.ts tests/unit/media-protocol.test.ts tests/unit/evaluation-frames.test.ts`. Exit 1, 169 tests, 168 passed, 1 failed, none cancelled/skipped. Log: /tmp/retest-fix-media-crate/media-unit-final.log. The new evaluation omission and protocol marker tests passed, as did every capture, ownership, policy, environment, install and discovery-bound case.

The sole failure belongs to the discovery builder: tests/unit/media-locate.test.ts:67 expects its /var/folders spelling, while src/media/locate.ts now returns the canonical /private/var/folders executable. This lane changes neither file and does not alter TMPDIR or the assertion to force a pass. Its owner needs to reconcile that return contract and assertion. A retry will check the updated shared tree.

The standalone real-client gate was lock-busy, exit 75, /tmp/retest-fix-media-crate/client-lock-1.log. Exact attempted command: `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test proofs/media/client.test.ts`. No client test ran.

### Files changed by this lane

- media/src/main.rs, ledger.rs, jobs.rs, recording.rs, place.rs, replies.rs, server.rs, frame.rs, live.rs and protocol.rs
- media/tests/process.rs
- src/media/protocol.ts and the single missingParts insertion in src/evaluation/frames.ts
- tests/unit/media-protocol.test.ts and tests/unit/evaluation-frames.test.ts
- docs/plans/public-beta/codex/phase-4/media-client-v2.md and this report
- New proof record docs/plans/public-beta/proofs/media-review-fixes.md

No edit to encoder.rs, any other builder's production file, Cargo.toml, Cargo.lock, package files, schemas, ownership rules or the protected planning files was made by this lane. Source hashes for the listed implementation/test/contract files are recorded in /tmp/retest-fix-media-crate/source-sha256.json.

The second standalone client lock attempt was busy, exit 75, /tmp/retest-fix-media-crate/client-lock-2.log; no test ran. The install builder's report has already observed the final Rust series and refreshed its source pins; this lane does not count its separate gate results as its own.

The third standalone client attempt was lock-busy, exit 75, /tmp/retest-fix-media-crate/client-lock-3.log; no test ran. A recorded wait-client.py now retries the same lockf -t 0 command once per minute, checking for an active benchmark on each attempt. Each attempt has its own log; client-final.log will copy the attempt that actually ran, not a lock failure. No other worker is signalled.

The recorded client retry script saw attempts 4, 5 and 6 return 75, without running a test. Logs: /tmp/retest-fix-media-crate/client-lock-4.log, client-lock-5.log and client-lock-6.log. The lock file then disappeared between read-only checks; no lock or process was removed by this lane.

The standalone discovery retry still fails the same canonical-path assertion. Exact command: `node --conditions=retest-source --test --test-name-pattern='discovery resolves executable' tests/unit/media-locate.test.ts`. Exit 1, 1 test failed, none cancelled/skipped. Log: /tmp/retest-fix-media-crate/media-locate-retry.log. This remains an unresolved other-lane verification result; no expectation or environment was weakened.

The install/discovery builder resolved the canonical-path mismatch in its production code and kept the original assertion. This lane then reran the full unit command above against the shared tree: exit 0, 169 tests passed, 0 failed/cancelled/skipped. Log: /tmp/retest-fix-media-crate/media-unit-retry.log. The earlier failed gate and standalone retry remain preserved.

Client lock attempts 7 through 10 also returned 75 and ran no test. Logs: /tmp/retest-fix-media-crate/client-lock-7.log through client-lock-10.log. The wait-client.py process remains active only to acquire the required gate; it will be reconciled before closeout.

### Client gate finding and correction

Attempt 12 acquired the lock and ran the exact requested client file. Exit 1, 32 tests, 30 passed, 2 failed, none cancelled/skipped. Logs: /tmp/retest-fix-media-crate/client-lock-12.log and its copy client-final.log. The wait-client.py process exited with that result and is no longer waiting. Attempt 11 was lock-busy, exit 75.

The failures are proofs/media/client.test.ts:427 and :441. Their lingering encoder fixtures exited on their own instead of being stopped after the media process died. This is this lane's defect: libc::dup created a stdout descriptor without close-on-exec, so encoder descendants inherited the pipe and prevented the client from observing its closure until their sleep ended. The two existing assertions remain unchanged. An OS descriptor regression is being added before changing that duplicate to atomic F_DUPFD_CLOEXEC. This correction requires a new final Rust/clippy/build series and client rerun.

The new stdout descriptor regression failed against dup: exit 101, 1 unit test failed, flags lacked FD_CLOEXEC. Exact command: `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --locked --offline --manifest-path media/Cargo.toml the_writer_stdout_descriptor_is_closed_when_an_encoder_executes`. Log: /tmp/retest-fix-media-crate/stdout-inheritance-before.log. The duplicate now uses atomic F_DUPFD_CLOEXEC, with no changes to the client assertions or ownership rules.

Install-builder handoff: media/src/replies.rs changed after the earlier pin refresh for this discovered descriptor leak. Refresh that source hash after the new final series; do not loosen the allowlist or digest checks. This lane will record the final file/binary hashes.

The first post-descriptor-fix Rust run passed, 92 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-close-1.log. The exact command is the whole-crate offline command recorded above. The final closeout clippy/build logs will use /tmp/retest-fix-media-crate/close/ so earlier build and clippy evidence is preserved.

The second post-descriptor-fix Rust run passed, 92 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-close-2.log. No tests were ignored or filtered in either whole run. The changed replies.rs SHA-256 is 82726ffed2e5097354575e3abee7850c97a005441497d1ed00dd42072c5c8547; this is the hash the install lane needs after refreshing its manifest.

The third post-descriptor-fix Rust run passed, 92 unit and 54 process tests, exit 0, /tmp/retest-fix-media-crate/cargo-close-3.log. All three final runs used default parallel execution with no ignored or filtered tests.

Post-descriptor-fix all-target clippy passed with warnings denied, both default and allocation-counts, exit 0. Exact commands are the two clippy commands above; logs: /tmp/retest-fix-media-crate/close/clippy-final.log and /tmp/retest-fix-media-crate/close/clippy-allocation-counts.log. The offline release build passed, exit 0, using the release command above; log: /tmp/retest-fix-media-crate/close/build-release.log. Final release binary SHA-256: 6cd7160729dfc2bc2cc10ed8da10bffda1b4f8efb53d9ee7be87967af7fe27e7. A separate recorded client retry script uses client-close-lock-*.log and client-close-final.log to preserve the first failed client gate.

Final scoped rustfmt check passed, exit 0, /tmp/retest-fix-media-crate/close/fmt-check.log, using the assigned-file command above. Client closeout attempt 1 was lock-busy, exit 75, /tmp/retest-fix-media-crate/client-close-lock-1.log; no client test ran. The media/evaluation unit set is rerunning against the final refreshed install pins.

The final media/evaluation unit rerun passed, exit 0, 169 tests, 169 passed, 0 failed/cancelled/skipped, /tmp/retest-fix-media-crate/close/media-unit.log. It used the full unit command above against the descriptor fix and refreshed installer pins. No assertion or fixture expectation changed for this rerun.

Client closeout attempt 2 was lock-busy, exit 75, /tmp/retest-fix-media-crate/client-close-lock-2.log; no test ran. The remaining retry process is recorded as pid 27472 with its observed start time in /tmp/retest-fix-media-crate/client-close-wait.log.owner.json. Scoped git diff --check returned 0 after the contract update.

Client closeout attempt 3 acquired the shared lock and passed: exit 0, 32 tests, 32 passed, 0 failed/cancelled/skipped. Exact command: `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test proofs/media/client.test.ts`. Logs: /tmp/retest-fix-media-crate/client-close-lock-3.log and its copy /tmp/retest-fix-media-crate/client-close-final.log. The two original encoder-cleanup assertions now pass with the close-on-exec descriptor. The recorded retry process exited 0, /tmp/retest-fix-media-crate/client-close-wait.log; nothing remains queued by that process.

Final scoped TypeScript checks also passed against the shared final tree, gate exit 0, /tmp/retest-fix-media-crate/close/types-gate.log. Exact gate: `lockf -t 0 /tmp/retest-heavy-gate.lock python3 /tmp/retest-fix-media-crate/types-close.py`. All four compiler commands listed above exited 0; their final logs are /tmp/retest-fix-media-crate/close/media-types-6.log, proofs-types-6.log, media-types-7.log and proofs-types-7.log. The same strict scoped configuration was used.

Closeout process audit checked 70 recorded command identities using pid and observed start time and found none still running. Artifact: /tmp/retest-fix-media-crate/close/process-audit.json. All launched command sessions have completed; this lane has no retry script, media child, encoder, browser or benchmark left running. No other builder was signalled.

Final source hashes are /tmp/retest-fix-media-crate/source-sha256.json; the earlier snapshot is preserved as source-sha256-before-close.json. Final binary SHA-256 still matches 6cd7160729dfc2bc2cc10ed8da10bffda1b4f8efb53d9ee7be87967af7fe27e7. The unverified list above remains: Linux/minimum Rust, actual stuck kernel work, unsupported filesystems, native capture, playback and whole-tree gates. All checks requested for this lane passed.
