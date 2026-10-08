# Media processor and client report

The final client tests, Chrome proof and combined typecheck scripts could not execute because another worker held the shared gate lock. Five blocking attempts exited 75 before launching any gate. This lane is implemented, with passing Rust and scoped TypeScript checks and a completed paired route measurement, but its final execution gates remain unverified. Linux x64 is also unverified.

The processor and TypeScript client speak protocol 2. The proof uses the required recording identity and frame ids. Thumbnails, retained frame sequences, live views, explicit evidence status, copy finalization and owner-managed leftovers are implemented. Client method signatures remain as documented. The older failed attempts remain under `/tmp/retest-media-resume/`.

## Implementation

| Paths | Result |
| --- | --- |
| `media/src/protocol.rs`, `src/media/protocol.ts` | Version 2 framing, identity, validated command and reply types, bounded binary image and frame-map payloads |
| `media/build.rs`, `media/src/main.rs`, `media/src/server.rs`, `media/src/encoder.rs` | Binary build identity, greeting, bounded background ffmpeg probe and readiness, waiting starts that leave the input loop free, decoded and encoded recording routes |
| `media/src/frame.rs`, `media/src/jobs.rs`, `media/src/store.rs`, `media/src/ledger.rs` | Bounded thumbnails and interval images, retained frame identity and placement, omissions and stretches without frames |
| `media/src/live.rs`, `media/src/replies.rs` | One bounded newest-frame watcher per recording, with losses counted independently of the recording queue |
| `media/src/queue.rs`, `media/src/recording.rs`, `media/src/place.rs` | Queue and frame-loss accounting, capture gaps and evidence status, finite encoder cleanup, no-clobber link or synced copy, retained partial files when cleanup is uncertain |
| `media/src/process_ownership.rs` | Targeted metadata reads while preserving launch ancestry, pid and start identity, refusal of changed readable commands and unknown processes |
| `src/media/client.ts` | All client operations, binary version refusal with installation guidance, bounded writes and requests, targeted metadata discovery, encoder reclaim and kept-frame cleanup after loss |
| `media/tests/process.rs`, `proofs/media/client.test.ts` | Processor and real-encoder client tests for the new operations and existing failure paths |
| `proofs/media/run.ts`, `proofs/media/support.ts`, `proofs/media/recording-child.ts`, `proofs/media/stubborn-process.ts` | Protocol 2 proof and fixtures, saved capture input, independent decoding and order checks, process and group absence checks |
| `media/src/allocations.rs`, `proofs/media/compare-routes.ts` | Separate measuring build and paired replays of identical saved input |
| `media/Cargo.toml` | Measuring feature and explicit Rust 1.88 minimum. No new crate or runtime npm dependency |

The completion path now checks the finishing deadline even when the encoder has already exited or the watchdog was delayed. It preserves an earlier stop reason. Two Rust regression tests cover those decisions. The proof stops its own encoder before the deadline case, so that a faster encoding run cannot make the intended failure disappear. The fake hanging encoder stays alive after its child is stopped, preserving the existing assertion that its leader is killed. No deadline, density, frame-order or process-absence assertion was relaxed.

A forced client close can stop recorded encoder descendants while stopping the media worker. The lost-recording message now says they were stopped or exited during forced cleanup, instead of claiming they exited on their own. The existing forced-close test still requires a lost-recording rejection before close returns, a named partial file and no encoder or group left.

The proof also compares VP8 and close-while-finishing duration with the reported ending, requires the crash partial to contain playable frames with a matching duration, and requires every whole-decode order check to cover the full ffprobe count. These are additional assertions; no existing assertion was removed or weakened.

The client uses link discovery and selected full-identity reads, so unrelated process arguments cannot exhaust its metadata response. `OwnedProcessGroup` still verifies launch ancestry, pid and start time, readable commands, unknown group members and each signal. The Rust owner retires as soon as complete discovery proves all relevant pids absent, avoiding repeated queries and future signals. An added test requires retirement to prevent both reads and signals. No shared ownership file was edited by this lane.

## Client compatibility and other lanes

No client method or parameter changed during this continuation. `MediaRecorder` and `RecordingTarget` keep their call shapes. `src/media/capture.ts` was left to its owner.

One source type differs from the interface note at `media-client-v2.md:13`: `SequenceFrame.fate` in `src/media/protocol.ts:326` is `'shown' | 'superseded' | 'pending'`. This was already present on disk. A running recording's newest kept image is real capture evidence, but its final video placement is unknown until a later frame or finish arrives. Calling it shown before placement would invent evidence. The note should add `pending` and explain that it is not a finalized video placement. This report requests that documentation correction; no caller signature change is required.

No runner, capture-source, driver, installer, run-event, schema or reporter file was edited by this lane. Other lanes own any resulting run-folder schema additions and reader compatibility claims.

The orchestrator also needs these outside-lane failures reviewed:

- `src/shared/process-ownership.ts:312` and `:316` read full arguments for the whole host. The shared metadata response limit at `src/shared/metadata-process.ts:22` is 4 MiB; a byte-only measurement of that query returned 4,409,291 bytes. Browser, native and runner ownership checks in the unit log failed at this limit. Consider selecting relevant identities after link discovery, while preserving all ownership checks, as the media client does. The failure must remain explicit whenever discovery fails.
- `src/evaluation/frames.ts:97` passes possibly absent attempt recordings to a function requiring recordings. Both type-fixture compilers reported this error. Its owner needs to resolve the missing-recording case without inventing evidence.

## Verification commands

The Rust test runs used the default parallel mode, with no `RUST_TEST_THREADS` override. These logs are under `/tmp/retest-media-finish/`:

| Exact command | Result | Log |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path media/Cargo.toml`, three consecutive runs | Each passed 80 unit and 40 process tests; exit 0 | `cargo-1.log`, `cargo-2.log`, `cargo-3.log` |
| `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings` | Exit 0 | `clippy.log` |
| `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets --features allocation-counts -- -D warnings` | Exit 0 | `clippy-measuring.log` |
| `cargo fmt --manifest-path media/Cargo.toml --check` | Exit 0 | `fmt.log` |
| `cargo build --release --locked --offline --manifest-path media/Cargo.toml` | Exit 0; production binary without allocation counting | `build.log` |
| `node_modules/typescript/bin/tsc -p /tmp/retest-media-finish/tsconfig-media.json` | Exit 0; isolated client and protocol check | `media-types-6.log` |
| `node_modules/typescript-7/bin/tsc -p /tmp/retest-media-finish/tsconfig-media.json` | Exit 0; isolated client and protocol check | `media-types-7.log` |
| `node_modules/typescript/bin/tsc -p proofs/media/tsconfig.json` | Exit 0; media proofs and media types, including the final proof assertions | `media-proof-types-6.log` |
| `node_modules/typescript-7/bin/tsc -p proofs/media/tsconfig.json` | Exit 0; media proofs and media types, including the final proof assertions | `media-proof-types-7.log` |
| `npm run test:unit`, launched by `node --conditions=retest-source /tmp/retest-media-finish/unit-gate.ts` | External gate exit 124; 3360 passed, 177 failed, 5 cancelled, 0 skipped, all named failures outside this lane | `unit.log` |
| `npm run test:types` | Exit 1; undefined recordings in the evaluation lane on both compilers | `types.log` |

The unit command was stopped only through recorded launch ownership. Its initial guard could not read ownership because the whole-host metadata query exceeded the response limit. The later targeted cleanup kept the common ownership decisions and fresh identity checks. `unit-cleanup.log` confirms the recorded unit processes stopped with no ownership or read problem. No other worker was signaled.

Before the final proof and client edits, `npm run typecheck` exited 2, log `/tmp/retest-media-resume/typecheck.log`. Its errors were in `fixtures/evaluation-corpus/runner/score.ts:93` and `:117`, `src/evaluation/frames.ts:90` and `:97`, and `tests/unit/evaluation-frames.test.ts:334`. `npm run typecheck:proofs` exited 0, log `/tmp/retest-media-resume/typecheck-proofs.log`. These are retained results of the earlier tree. The final scoped media checks above passed after the edits; the combined scripts could not be rerun under the lock.

The first Rust attempt's two cleanup-bound failures are preserved in `cargo-first-failure.log`. The earlier failed client and proof attempts remain under `/tmp/retest-media-resume/`; they are not counted as passes. The failed lock attempts are `lock-wait.log`, `lock-wait-second.log`, `lock-wait-third.log`, `lock-wait-fourth.log` and `lock-wait-fifth.log`, each exit 75. `/tmp/retest-media-finish/gates.log` is the last lock error, not a gate result. No final client or Chrome proof log was created. The lock was last held by another worker's agent integration command, with Chrome descendants still present. It was left untouched. No command launched by this continuation remains running.

The exact blocked command was:

```sh
lockf -t 540 /tmp/retest-heavy-gate.lock sh /tmp/retest-media-finish/gates.sh
```

The script's unexecuted gates are:

```sh
node --conditions=retest-source --test 'proofs/media/**/*.test.ts'
RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-finish/proof \
  node --conditions=retest-source /tmp/retest-media-finish/bounded-proof.ts
npm run test:types
npm run typecheck
npm run typecheck:proofs
```

The external proof guard launches the required `node --conditions=retest-source proofs/media/run.ts`, records its descendants and fails if its limit or cleanup fails. It does not change any proof assertion. The orchestrator needs a clean lock handoff to run these commands. `proofs/media/run.ts` can also be invoked directly under the lock with a fresh artifact directory. A passing client and whole Chrome proof must be obtained before treating this lane's execution verification as complete.

## Route measurement and default

The final comparison is `/tmp/retest-media-finish/routes/results.json`, with log `/tmp/retest-media-finish/routes.log`. It replayed the same 89 recorded Chrome PNGs, 800 by 600, totaling 1,313,351 bytes, three times per route with alternating order. Both routes produced H.264 MP4 and passed a whole decode, frame count and every-frame order check for 90 output frames in each replay. Their evidence was complete. The input hash matches the earlier completed comparison; the final measuring binary hash was checked from disk. The earlier comparison is preserved under `/tmp/retest-media-resume/routes-complete/`.

| Median of three, on this machine | Decoded RGB | Encoded PNG |
| --- | ---: | ---: |
| Image bytes into media | 1,313,351 | 1,313,351 |
| Request headers and prefixes into media | 10,164 | 10,186 |
| Bytes into ffmpeg | 129,600,000 | 1,325,840 |
| Rust allocation requests | 2,781 | 2,456 |
| Rust cumulative allocation bytes | 170,284,753 | 18,792,975 |
| Rust peak live allocation bytes | 3,497,907 | 633,827 |
| Media own CPU, seconds | 0.06 | 0.01 |
| ffmpeg user plus system CPU, seconds | 0.26 | 0.31 |
| Combined CPU, seconds | 0.32 | 0.32 |
| Media sampled peak RSS, bytes | 10,420,224 | 4,276,224 |
| ffmpeg maximum RSS, bytes | 166,739,968 | 189,333,504 |

Decoded remains the default because ffmpeg used less peak memory on this input and combined CPU was comparable. `encodedFormat` remains available for a caller choosing a smaller image pipe. The recording fixes one encoder image format; matching images pass through, and another format or size is decoded, fitted and converted. These are single-machine measurements on a shared host, with no speed claim. The method, exact commands, input hash, artifacts and copy observations are in `docs/plans/public-beta/proofs/media.md`.

The measuring feature counts Rust allocation requests across the process lifetime. `ps` measures the media worker's own recording CPU and sampled RSS. `/usr/bin/time -l` independently measures ffmpeg CPU and maximum RSS. The media timing wrapper includes reaped children and is not its own CPU or memory measurement. Buffer moves and raw RGB materialization were traced through the code; codec-internal, kernel and ffmpeg copy and allocation counts were not profiled.

## Linux

The repository's Docker script and Dockerfile were read. The installed `retest-linux:dev` image is Linux arm64 and has no Cargo, rustc or ffmpeg. The existing x64 attempt used no pull or download:

```sh
docker run --rm --pull never --platform linux/amd64 --init --cap-drop ALL \
  --security-opt seccomp=docker/linux/chromium-seccomp.json \
  --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media,dst=/media,readonly \
  retest-linux:dev sh -c 'uname -m; cargo build --locked --offline --manifest-path /media/Cargo.toml --target-dir /tmp/retest-media-target && cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /tmp/retest-media-target'
```

Docker refused the platform with exit 125, before either Cargo command ran. Log `/tmp/retest-media-resume/linux.log`; the arm64 tool check is `/tmp/retest-media-resume/linux-tools.log`, exit 127. Linux x64 remains unverified. No image or toolchain was downloaded and nothing was installed system-wide.

## What remains unverified

- The final client tests, whole Chrome proof and combined typechecks, blocked before execution by the shared gate lock.
- A passing whole-unit and type-fixture gate across the other lanes' work in progress.
- Linux x64 build and tests.
- The declared minimum Rust toolchain. Builds and tests used the installed toolchain.
- The copy fallback on an actual filesystem without hard links. Its forced debug path is tested.
- JPEG route measurements, another machine and recording on/off complete-run measurements. JPEG encoding has a client test, but the paired measurement used PNG without resize.
- Codec-internal and kernel copy counts, ffmpeg allocation counts, and memory peaks between media RSS samples.
- Native capture or recording and the runner's full evidence pipeline. This lane exercises Chrome screenshots and replayed media; it makes no native capability claim.

## Files changed

Existing files changed by the builder and continuation:

`media/Cargo.toml`; `media/src/encoder.rs`; `media/src/frame.rs`; `media/src/main.rs`; `media/src/process_ownership.rs`; `media/src/protocol.rs`; `media/src/queue.rs`; `media/src/recording.rs`; `media/src/replies.rs`; `media/src/server.rs`; `media/tests/process.rs`; `src/media/client.ts`; `src/media/protocol.ts`; `proofs/media/client.test.ts`; `proofs/media/recording-child.ts`; `proofs/media/run.ts`; `proofs/media/stubborn-process.ts`; `proofs/media/support.ts`; `docs/plans/public-beta/proofs/media.md`.

New files:

`media/build.rs`; `media/src/allocations.rs`; `media/src/jobs.rs`; `media/src/ledger.rs`; `media/src/live.rs`; `media/src/place.rs`; `media/src/store.rs`; `proofs/media/compare-routes.ts`; this report.

The client's interface note and the earlier state note predate this continuation. They were read and preserved. No commit, stash, reset, discard, publication, ownership change or system-wide installation was made.

## After the restart

Continued on 5 October 2026 after the Mac's restart. Every log named here is in `/tmp/retest-media-restart/`. The record of what was shown is the "After the restart" section of `docs/plans/public-beta/proofs/media.md`.

### Signature changes

No method or parameter changed. `media-client-v2.md` is corrected to match the source:

- `SequenceFrame.fate` is now `'shown' | 'superseded' | 'pending' | 'unprocessed'`. `unprocessed` is new: a kept frame of an ended recording that never reached a video. `pending` was already in the source, and the note lacked it. No consumer switches on `fate`; the evaluation corpus only assigns `'shown'`.
- `WatchEnded.reason` never had `'released'`. The note listed it, and the note is corrected.
- `MAX_PATH_BYTES` (4096) is exported. `record`, `thumbnail` and `leftovers` reject with `RangeError`, before writing anything, an output longer than that many UTF-8 bytes.

The evaluation lane's typecheck errors do not follow from these signatures:

- `src/evaluation/frames.ts:97` passes `recordings`, still `AttemptRecordings | undefined` after `recordings?.recording(app)` was checked, to a function that needs it defined.
- `src/evaluation/frames.ts:90` has an unused `id`.
- `tests/unit/evaluation-frames.test.ts:334` lacks `length` in a `TruncatedText`.
- `fixtures/evaluation-corpus/runner/score.ts:93` and `:117` are its own types.

None of them names a media type.

### What the reading found and fixed

From my own reading of the lane's diff:

1. **A long output path could end every recording.** The client never checked `output` in starts, thumbnails or leftovers. A path long enough to carry the header past 64 KiB is a protocol violation: the process ends every recording and exits 2. The client now refuses such a path before writing. Client test: a 70 000-character output is refused by all three and nothing is written; an output of exactly 4096 bytes reaches the process and is refused there without harm. This test was not run against the earlier client.
2. **The reply reader was quadratic.** It joined the pending bytes with each new chunk. One 48 MiB reply in 64 KiB chunks held Node's event loop for 1.5 s, measured once with `/tmp/retest-media-restart/scratch/reader-cost.ts`. That is the thread that captures screenshots during a run. The reader now keeps chunks apart and joins each reply once. The new unit file `tests/unit/media-protocol.test.ts` counts the bytes `Buffer.concat` copies. On the old reader it fails at 19,402,784,934 bytes for a 50,331,814-byte reply (`unit-media-protocol-old-reader.log`); now it passes in about 20 ms.
3. **An ending's frame map could pass the 64 MiB the client accepts.** It had 200 000 entries at most and ids of up to 128 characters, at four bytes each in the worst case. The client would then end the process. `Ledger::frame_map` now stops at the payload limit and counts the rest in `frameMapOmitted`, which makes the evidence `partial` with `frame_map_truncated`. Unit test in `ledger.rs`.
4. **The reply queue was bounded by count only.** That was 1024 replies, each up to 48 MiB of images or a 64 MiB frame map. It now waits at 256 MiB as well; one reply larger than that still goes once the queue is empty. Unit test in `replies.rs`, which fails without the bound (`cargo-replies-without-byte-bound.log`).
5. **The Chrome proof exercised no protocol 2 feature on real input.** It now checks four things on the real recording:
   - for each of the 90 decoded frames, the screenshot the frame map names is the one its timestamp maps to;
   - a live view watches the whole capture while every existing count and frame assertion still holds;
   - the kept frames come back byte for byte as the PNGs sent, with fates matching the frame map and stretches matching the timestamps;
   - a thumbnail of a real screenshot is fitted and as bright as the screenshot.

   The VP8 and close-while-finishing videos also have their frame maps checked against their decoded frames.

From an outside reading of the crate by a read-only reviewer. I checked each claim against the code before acting:

1. **Stop failures could hang a recording and the shutdown.** Confirmed. The watchdog returned after one stop. If that stop failed (a failed `ps` reading, or the ownership rule refusing an exec wrapper whose readable command changed) while the encoder was wedged, the encoder thread blocked forever in its write. No `ended` came, and the shutdown's join blocked forever. Fixed in two parts. The watchdog retries a stop once a second while the recording is overdue. The shutdown waits for a stopped thread no longer than its deadline, its stall limit and ten seconds more; a thread still blocked then gets no made-up ending, the process says `bye`, and the client reclaims the recording as lost. Process test with the debug-only hook `RETEST_MEDIA_TEST_REFUSE_STOPS`. Without the bounded wait it failed: no `bye` within 25 s. That failed run left its fake encoder group, which I then killed by its group id. The ownership rule is unchanged. The refusal it makes for an unreaped direct child whose readable command changed is the ownership lane's to judge (`media/src/process_ownership.rs:221`).
2. **The copy fallback writes straight into the video's path.** Confirmed: a kill during the copy leaves a partial copy at `path`. Not fixed. A copy beside the path followed by a no-clobber rename depends on `renamex_np` or `renameat2` support per filesystem, and I could not exercise it on a real filesystem without hard links. `Started`'s documentation now states the exception. Open: `media/src/place.rs:75-86`.
3. **Frame sequences hid some missing frames.** Confirmed. Losses between kept frames closer than `minGapUs` are in no stretch. That is by design, and the documentation now says `inInterval - available` counts them. Past the 200 000 frames a recording lists, later frames were in no count at all, so an interval there read as one empty stretch. The ledger now records from when it stopped listing, and a sequence reaching past that names it in `message`. Unit test in `ledger.rs`.
4. **Ended recordings reported `pending` frames.** Confirmed: the last kept frame of a recording whose encoder died was reported `pending`. It is now `unprocessed`. The process test asserted only `available >= 1`; it now asserts the fates. Without the fix it failed with `["shown", "shown", "shown", "shown", "pending"]`. The client test also asserts that no frame of the ended recording is pending.
5. **Cleanup time could make a finished video late.** Confirmed: `mark_done` applied the deadline after `finish_cleanup`, so cleanup time could turn an in-time exit into `deadline_exceeded` and remove a whole video. The encoder's exit is now noted when the encoder thread sees it, and the deadline is judged against that moment. The watchdog no longer calls an encoder that has already exited late. Unit test in `recording.rs`. Not shown with a real encoder exiting just inside its deadline.
6. **`leftovers` compared path spellings.** Confirmed. The process test now names the running recording's output through a symlinked folder. Without the fix, the running recording's `.mp4.partial` and kept frames were listed and removed (`cargo-alias-without-fix.log`). Outputs are now compared by resolved folder and file name.
7. **The stretch search was quadratic.** Confirmed. Only the 64 listed stretches are now searched for losses; the rest are counted. Unit test in `jobs.rs`.
8. **Memory bounds were missing from the record.** The reply bytes are fixed as in 4 above. Ledgers retained for up to 64 ended recordings are now written into the record's bounds.
9. **Oversized replies could end the process.** The frame map is fixed as in 3 above. A sequence of 64 frames with three 128-character multi-byte ids each carried its header past 64 KiB. The frame list now stays within 48 KiB, and frames left out are counted in `omitted.byBytes`. Process test: without the fix, the test's reader refused the header.
10. **The encoded route counts as `shown` a frame ffmpeg cannot decode.** Confirmed by reading. Not fixed, since the route is not the default. The `StartRecording` documentation now says so. Open: `media/src/frame.rs:139-147`.

The reviewer's lower findings are not fixed. Each is open:

- A job worker that panics loses its reply and stays gone, and a thumbnail path stays marked in use (`media/src/jobs.rs:100-152`, no `catch_unwind`).
- `watch` on a start still waiting for the probe is answered "finishing or over" (`media/src/server.rs:650-668`).
- `StoreReader` reopens the store by path after its check, a narrow race with a release and a new start at the same output (`media/src/store.rs:110-117`).
- `FrameWrite::to` can mark a frame `shown` with zero output frames at the duration cap (`media/src/recording.rs`).

The reviewer found no test that cannot fail and no assertion removed or loosened. My changes remove or weaken no assertion either. Every test change adds an assertion or a case.

### Gates

| Exact command | Result | Log |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path media/Cargo.toml`, before any change | 80 unit, 40 process passed | `cargo-baseline.log` |
| the same, three runs in a row, default parallel mode, final tree | each 85 unit and 42 process passed | `cargo-1.log`, `cargo-2.log`, `cargo-3.log` |
| `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings` | exit 0 | `clippy-final.log` |
| the same with `--features allocation-counts` | exit 0 | `clippy-measuring-final.log` |
| `cargo fmt --manifest-path media/Cargo.toml --check` | exit 0 | `fmt-final.log` |
| `cargo build --release --locked --offline --manifest-path media/Cargo.toml` | exit 0, 1,364,960 bytes | `build-release-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test "proofs/media/**/*.test.ts"` | 32 of 32 passed, first on the binary before the reviewer's fixes, then on the final binary | `client-1.log`, `client-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-restart/proof-final node --conditions=retest-source proofs/media/run.ts` | every check passed, nothing left behind; also passed once before the reviewer's fixes | `proof-final.log`, `proof-1.log` |
| `node --conditions=retest-source --test tests/unit/media-protocol.test.ts` | 5 of 5 passed | `unit-media-protocol-final.log` |
| `npm run test:unit` | exit 1: 3590 tests, 3576 passed, 14 failed, none cancelled or skipped. All failures are in `cli-help`, `cli-run`, `diagnostics-engines`, `diagnostics-run` and `playwright-resolve`, other lanes' files. Every media test passed | `unit.log` |
| `npm run test:types` | exit 1, only `src/evaluation/frames.ts:97` on TypeScript 6.0.3 and 7.0.2 | `types.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | exit 2, five errors, all in the evaluation lane's files listed above. The first run also had one in my new unit test (`call.result` possibly undefined), since fixed | `typecheck.log`, then `typecheck-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript-7/bin/tsc -p tsconfig.json` | exit 1, the same five evaluation errors, none in media files | `typecheck-7-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck:proofs` | exit 0 | `typecheck-proofs.log` |

Each heavy gate went through `/tmp/retest-media-restart/gate.sh`, which:

- refuses to start while a node process runs `benchmarks/run.ts`;
- runs the command under `lockf -t 0 /tmp/retest-heavy-gate.lock`;
- records the exit code.

A busy lock was retried every sixty seconds. My first benchmark check matched another session's shell that merely named the benchmark, so the script now matches only a `node` process.

The tests run without their fixes are listed in the record. All were scratch copies under `/tmp/retest-media-restart/scratch/`, outside the repository.

### Linux x64

Not built and not tested. Nothing is installed for it:

- No x86_64 Linux standard library for either Rust: Homebrew's 1.98.1 and rustup's toolchain carry only `aarch64-apple-darwin`. `cargo check --target x86_64-unknown-linux-gnu --offline` stops at "can't find crate for `core`" (`linux-cross-check.log`).
- No cross linker.
- Docker was running during this session; I did not start it. The repository's image `retest-linux:dev` is linux/arm64 and has no cargo, rustc or ffmpeg (`linux-tools.log`).
- The amd64 images on the machine belong to other products, and none carries Rust.

The lane brief allows no download, so it stopped there. The command that would do it in the brief's container route needs an amd64 Rust image and the crates downloaded:

```sh
docker run --rm --platform linux/amd64 --init --cap-drop ALL \
  --mount type=bind,src="$PWD/media",dst=/media,readonly \
  rust:1-trixie sh -c 'uname -m && cargo test --locked --manifest-path /media/Cargo.toml --target-dir /tmp/target'
```

### What remains unverified

Most important first:

1. Linux x64 build and tests, as above.
2. A stop the ownership rule refuses on a real host. It is shown only through the debug hook. The permanent cure is in the ownership rule (`media/src/process_ownership.rs:221`), which this lane keeps.
3. Finalizing on a filesystem without hard links, still shown only through the debug hook, and the partial copy a kill during that copy leaves at the video's path (`media/src/place.rs:75-86`).
4. The deadline fix with a real encoder exiting just inside its deadline. It is shown by unit tests only.
5. The output path check against the client as it was before the fix.
6. Start latency. On this machine, spawn to greeting took a median of 67.6 ms and spawn to the first `started` 473 ms, over 10 starts. Protocol 1 took 2.2 ms and 53.2 ms. These are single-machine measurements, and where the time goes was not profiled.
7. The open findings listed above: the encoded route's `shown` for undecodable frames, job worker panics, `watch` during the probe, the store reader's reopen race, and zero-frame `shown` at the duration cap.
8. Whole-tree unit, type-fixture and typecheck gates, which other lanes' work in progress keeps red.

### Files changed in this continuation

Existing files:

- `media/src/jobs.rs`, `ledger.rs`, `recording.rs`, `replies.rs`, `server.rs` and `protocol.rs`
- `media/tests/process.rs`
- `src/media/protocol.ts` and `src/media/client.ts`
- `proofs/media/run.ts` and `proofs/media/client.test.ts`
- `docs/plans/public-beta/codex/phase-4/media-client-v2.md`
- `docs/plans/public-beta/proofs/media.md`
- this report

New file: `tests/unit/media-protocol.test.ts`.

There is no new crate, npm dependency, script or environment variable outside the debug-only test hook `RETEST_MEDIA_TEST_REFUSE_STOPS`. I made no commit and installed nothing. No process I started is still running.

## Second pass

Done on 6 October 2026 on the coordinator's second brief. Logs are in `/tmp/retest-media-restart/second/`.

### Signature changes

No method or parameter changed. `media-client-v2.md` records these:

- `MediaErrorCode` gains `'job_failed'`. It is the `error` answering a thumbnail or frame sequence that failed inside the process; the client rejects that request with `MediaRequestError`.
- `Hello.encoder` is now usually `{ state: 'probing' }`, because the greeting no longer waits for the probe. `media.ready(timeoutMs)` gives the probe's answer. A start waits for the probe, as before. Nothing in `src/` read the greeting's probe.
- `FrameCounts.outOfRange` and the frame map's `out_of_range` also count a frame past the last video frame the duration allows. Such a frame was `shown` with no video frame.
- `Leftovers.files` may name a `.copying` file left by a copy into place: `.mp4.copying` and `.webm.copying` as `video_partial`, `.png.copying` and `.jpg.copying` as `thumbnail_partial`.

### Failing first

I wrote six process tests and one store unit test before any fix. All seven failed against the code as it was, each for its reason (`failing-first.log`, `failing-first-process.log`):

| Test | Failure before the fix |
| --- | --- |
| `an_encoded_frame_that_cannot_be_decoded_is_counted_undecodable_not_shown` | `undecodable` was 0; the cut frame was `shown` |
| `a_job_that_fails_inside_the_process_is_answered_with_an_error_and_holds_nothing` | no reply within 10 s |
| `a_live_view_asked_for_before_the_probe_answers_begins_with_the_recording` | the first reply was `watchEnded` `recording_ended` |
| `a_frame_past_the_last_frame_the_video_may_hold_is_not_called_shown` | the frame at the cap was `shown` with no video frame |
| `an_encoder_whose_command_changed_is_still_stopped_through_its_child_handle` | no `ended` within 5 s; the test's guard then killed the wedged `sleep` |
| `a_process_killed_while_copying_its_video_into_place_leaves_nothing_at_the_video_path` | a partial copy was at the video's path |
| `store::tests::a_reader_reads_the_store_s_own_file_even_after_its_path_names_another` | read `thei` from the other file instead of `mine` |

Three hooks were added first as test infrastructure. All are debug-build only, so release builds have none:

- `RETEST_MEDIA_TEST_JOB_PANIC` makes the job with that request id panic.
- `RETEST_MEDIA_TEST_KILL_DURING_COPY` makes the process send itself SIGKILL after the first 256 KiB chunk of a copy. A kill leaves what a kill from outside leaves, and writes no crash report, as an abort would.
- The fake encoder gains the mode `exec-sleep`, which becomes `sleep 600` after 300 ms.

### What was fixed

1. **The encoded route** (`media/src/frame.rs`, `for_route`). A frame handed over undecoded is still decoded once and its pixels let go. A frame that cannot be decoded is `undecodable` and never sent. The media CPU the route saved in the earlier measurement is spent on this decode; the route was not measured again.
2. **A job that panics** (`media/src/jobs.rs`). Each job runs inside `catch_unwind`. A panic is answered with an `error` of code `job_failed`, naming the request and its id. The thumbnail's output is released whatever happened, and the worker goes on.
3. **A live view during the probe** (`media/src/server.rs`). A view asked for a recording still waiting for the probe waits with it. Once the probe answers, it begins with the recording, or is told the truth if the recording ended before it began. An `unwatch` or a shutdown answers a waiting view with `watchEnded` and nothing sent. One view per recording, so at most 16 wait.
4. **The kept-frames reader** (`media/src/store.rs`). The store opens its file for reading and writing, and readers take a duplicate of that handle. The path is never opened again.
5. **The duration cap** (`media/src/recording.rs`). `FrameWrite::to` says how many video frames it wrote. A frame given none is `out_of_range`, and the end is clipped, which makes the evidence `partial`.
6. **Stopping the launch through its child handle** (`media/src/process_ownership.rs`). `Ownership::stop` and `cleanup` now take the launch's `Child`. The launch is stopped through that handle (`Child::kill`, which cannot reach another process while the child is unreaped), whatever its command reads as. Every other recorded process is still found by pid and keeps the identity check. The pid-only `stop_with` remains for its tests, unchanged, and now compiles only under test. Every caller holds the child: the recording's watchdog and cleanup, the start's failure paths, and the probe's `wait_until` and cleanup. A new unit test covers both cases: a launch whose command changed is stopped through the handle, and a descendant whose command changed is still refused.
7. **The copy fallback** (`media/src/place.rs`). The copy goes to `<path>.copying` and is synced, then renamed to the path with `renamex_np(RENAME_EXCL)` on macOS or `renameat2(RENAME_NOREPLACE)` on Linux. Where the filesystem refuses an exclusive rename (`ENOTSUP`, `EOPNOTSUPP`, `EINVAL`, `ENOSYS`), the path is checked and then renamed. Another program creating a file there in between is the one case left. A start or thumbnail refuses while a `.copying` file is there. `leftovers` lists and removes it. A unit test shows the rename never replaces a file; the process test shows a kill during the copy leaves nothing at the path, and the next process removes the `.copying` file.
8. **Start-up**, below.
9. **The output-path test against the old client.** I copied `src/` and `proofs/media/` to `/tmp/retest-media-restart/second/oldclient/` and removed only the three output checks. Run there, the test failed: the start with a 70 000-character output reached the process, which ended with exit code 2, instead of being refused with `RangeError` (`old-client-output-path.log`).

One existing assertion changed. `a_start_before_the_probe_answers_waits_without_holding_the_loop` asserted that the greeting comes 2 to 3 s after spawn while the probe sleeps 3 s. That was the blocking greeting this pass removes. It now asserts the greeting comes within 1 s. Every other assertion of that test is unchanged. It still asserts the start waits for the probe while the loop answers other requests.

### Start-up: where the time went, and before and after

**Method.** `/tmp/retest-media-restart/second/startup.ts` runs 15 rounds. In each round it times:

- the raw protocol: spawn to `hello`, then a start sent at once to its `started`, read with the reply reader and no client;
- the client: `MediaProcess.start`, then `record` to its resolution;
- `retest-media --version`;
- the pieces: each of the probe's three ffmpeg listings alone, `ps -axo pid=,ppid=,pgid=`, and one `ps -ww -o … -p <pid>`.

Each run is timed with `performance.now()`, and the table gives medians, with minimum and maximum in the logs. It ran under `lockf -t 0 /tmp/retest-heavy-gate.lock`, so no gate of any lane ran beside it, and with no other work of mine running. About 780 processes were on the host. Both measurements used release builds, real ffmpeg 9.0.2 and recordings that keep no frames:

- the before binary, sha256 `2e99f9af…`, copied at `second/before/retest-media` before any change;
- the after binary, `second/after-retest-media`, byte-identical to the final release build.

**Where the time went before** (`startup-before.log`, old binary and old client):

- **Raw spawn to greeting, 53.9 ms.** It is almost all the wait for the probe. The probe runs three ffmpeg listings of about 21 ms each, in parallel, each with its own ownership readings. The binary itself starts in 1.9 ms (`--version`).
- **Raw start to `started`, 25.9 ms.** This is spawning ffmpeg plus one ownership reading of it.
- **Client spawn to greeting, 66.9 ms.** It is set by the client's own ownership reading of the new process right after spawn, which takes two readings through the shared metadata reader. One such reading costs about 28 ms, against 16 ms for `ps` alone.
- **Client record to `started`, 394 ms.** About 368 ms of that was in the client after the process had answered. `captureEncoderOwnership` read the host's process table four times plus one single-pid reading: once itself, once inside `groupFor` for the worker, once inside `groupFor` for the encoder's group, and once more through `owner.capture()`. The first and the last repeated a reading `groupFor` makes and checks itself.

**What was waste and is removed:**

- The greeting's wait for the probe. The greeting now goes at once, and a start, as before, waits for the probe, so no recording begins on an unprobed encoder.
- The two repeated readings in `captureEncoderOwnership`. A refusal still reads again, to say why. The capture unit tests, which pin down which refusals are made, pass unchanged: 50 of 50 with the protocol tests.

**After** (`startup-after.log`, 15 rounds alternating both binaries with the new client, medians in ms):

| Measure | Before binary, old client | Before binary, new client | After binary, new client |
| --- | ---: | ---: | ---: |
| Raw spawn to greeting | 53.9 | 52.1 | 1.7 |
| Raw start to `started`, sent at once | 25.9 | 25.3 | 81.1 |
| Client spawn to greeting | 66.9 | 69.0 | 68.3 |
| Client record to `started` | 394 | 282.2 | 281.0 |

The proof's own start-up measurement, 10 starts through the client on the final binary, gave spawn to greeting a median of 70 ms (67.6 before) and spawn to the first `started` 360 ms (473 before).

How to read these:

- The probe's time moved from the greeting to a start sent at once. It was not removed, so the raw path to the first `started` is about the same: 53.9 + 25.9 before, 1.7 + 81.1 after.
- Through the client, the greeting did not get faster. The client's ownership reading of the new process takes longer than the probe.
- What remains in the client's first `started`, about 200 ms over the raw protocol, is three process-table readings and one single-pid reading that the ownership rule needs. Each goes through `src/shared/metadata-process.ts`, which adds about 12 ms over `ps` per reading. That file belongs to another lane and was not touched.

These are single-machine measurements, not speed claims.

### Gates

| Exact command | Result | Log |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path media/Cargo.toml`, three runs in a row, default parallel | each 88 unit and 48 process tests passed | `cargo-1.log`, `cargo-2.log`, `cargo-3.log` |
| `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings`, and with `--features allocation-counts` | exit 0 both | `clippy-final.log`, `clippy-measuring-final.log` |
| `cargo fmt --manifest-path media/Cargo.toml --check` | exit 0 | `fmt-final.log` |
| `cargo build --release --locked --offline --manifest-path media/Cargo.toml` | exit 0, identical to the measured and proven binary | `build-release-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test "proofs/media/**/*.test.ts"` | 32 of 32 | `client.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-restart/second/proof node --conditions=retest-source proofs/media/run.ts` | every check passed: complete evidence, 90 frames against the frame map, 22 stretches, nothing left | `proof.log`, `proof/summary.json` |
| `node --conditions=retest-source --test tests/unit/media-capture.test.ts tests/unit/media-protocol.test.ts` | 50 of 50 | `unit-media.log` |
| `npm run test:unit` | exit 1: 3595 tests, 3591 passed, 4 failed in `diagnostics-engines` and `native-ios-simulator`, other lanes' files. Every media test passed | `unit.log` |
| `npm run test:types` | exit 1, only `src/evaluation/frames.ts:97` | `types.log` |
| `lockf … npm run typecheck`, and `lockf … node_modules/typescript-7/bin/tsc -p tsconfig.json` | exit 2 and 1. All errors are in other lanes' files: the evaluation errors as before, plus `src/cli/install/lock.ts` and `tests/unit/builds-lock.test.ts` from the installer lane's work in progress. None in media files | `typecheck.log`, `typecheck-7.log` |
| `lockf … npm run typecheck:proofs` | exit 0 | `typecheck-proofs.log` |

### Still unverified

Most important first:

1. Linux x64, which waits for the founder to allow a download.
2. The copy fallback on a real filesystem without hard links. It is shown through the debug hook. The exclusive rename was shown on APFS. Whether FAT or exFAT on macOS accept `RENAME_EXCL`, or take the checked-rename path, is not known.
3. The encoded route's cost now that it decodes each frame to check it.
4. A launch stopped through its handle on Linux, where `Child::kill` may use a pidfd. It was shown on macOS only.

### Files changed in the second pass

Existing files:

- `media/src/frame.rs`, `jobs.rs`, `server.rs`, `store.rs`, `recording.rs`, `place.rs`, `process_ownership.rs`, `encoder.rs` and `protocol.rs`
- `media/tests/process.rs`
- `src/media/protocol.ts` and `src/media/client.ts`
- `docs/plans/public-beta/codex/phase-4/media-client-v2.md`
- `docs/plans/public-beta/proofs/media.md`
- this report

No new file, crate, npm dependency or script. The new environment variables are only the debug-build test hooks named above. I made no commit and downloaded nothing. No process I started is still running.
