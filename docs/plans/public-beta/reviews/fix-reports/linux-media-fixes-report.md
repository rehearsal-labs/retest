# Linux media fixes

Final status: Linux container Cargo tests pass on two consecutive default parallel runs, with 103 asserted units, 57 process tests and one named absent-ffmpeg skip per run. Homebrew Mac Cargo tests pass 104 units and 57 process tests with no skip. Mac Clippy passes all targets with warnings denied, both default and all features. Linux Clippy is **unverified**: the authorized cached image lacks cargo-clippy and another download is forbidden. Both release builds pass.

This lane completed its source fixes and the runnable checks. This lane owns media source and tests, excluding encoder environment filtering, and its scripts under `.retest/linux-build/media-fixes/`. Other builders' files and existing work are preserved. No benchmark, commit, stash, reset or revert runs here. Docker is already running and is left running.

The previous lane built the Linux GNU x64 release successfully and passed 28 Node checks with one macOS-only skip. Its full Rust run passed 97 units and failed the profiled-JPEG ffmpeg case. Its independently executed process target passed 51 and failed four. Those results remain in `.retest/linux-build/logs/` and are not counted as this lane's verification.

The authorized image is `rust:1-trixie`, previously amd64 image `sha256:73cdc6244792c9cbdb24999b60ff327b0b6d1999ab61be75f99e852e7b220ff5`. It is absent at this lane's initial inspection. Only that image may be pulled. The host's existing Cargo registry is available locally; commands will use `--locked --offline`, with no crate downloads. The container route uses amd64 emulation, numeric user 501:20, read-only crate/repository mounts and a writable output mount.

All heavy commands queue one at a time through `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock`. The retained runner checks for a benchmark before acquiring the gate and again inside it. Busy attempts launch no check. Exact commands, exit codes, launched identities and logs are retained under `.retest/linux-build/media-fixes/logs/` and appended below as each command completes.

## Initial evidence

The previous image inventory reports ffmpeg and ffprobe absent. Its profiled-JPEG test failed on a broken stdin pipe before printing the encoder's error. The new reproduction must distinguish actual absence from any installed tool failure.

The panics at `jobs.rs:219` and `recording.rs:837` name deliberate debug test hooks. The prior log shows both corresponding failure-reporting tests passed. Current code catches job panics and sends `job_failed`; the server joins failed recording threads and sends an unavailable `encoder_failed` ending. These observations do not settle the four failed process cases. Both hooks will be exercised directly in this lane.

The remaining prior failures are missing-encoder startup classification, an ownership-query failure during the no-codec probe, 61 kept frames where the long-id test requires 64, and release refused after an ending. Causes and failing-first evidence are pending reproduction.

## Execution record

## Prepared regressions and tool inventory

A debug-only post-ending worker hold and `an_ended_recording_can_be_released_before_its_worker_returns` now make the release race deterministic. Every media operation is already complete before the hold. The new test requires an `ok` ending with complete evidence, immediate requested release with the exact frame-store path, file removal, a subsequent `released` sequence reply, and clean process exit. Production release behavior has not changed yet.

The long-id test currently starts with the default `queueFrames` of 60 and bursts 64 frames. Its unchanged 64-frame requirement depends on worker scheduling. A fixture that requires all 64 must admit the whole burst; the eventual correction will explicitly reserve 64 queue slots and add received/dropped/shown checks, preserving every header, omission and payload assertion.

Mac tools are Homebrew rustc/cargo 1.98.1 and ffmpeg 9.0.2. Full version, encoder, decoder and format lists are `logs/mac-rustc.log`, `mac-cargo.log`, `mac-ffmpeg-version.log`, `mac-ffmpeg-encoders.log`, `mac-ffmpeg-decoders.log`, `mac-ffmpeg-formats.log` under this lane's output folder. This ffmpeg includes libx264 and libvpx encoders, mjpeg/h264/rawvideo decoders and image2pipe/rawvideo/mp4/webm formats. The cached-archive check found no missing Cargo.lock archive, `logs/cache-check.json`.

The first queue helper had an incorrect repository-root calculation before any command acquired the lock. Only that owned waiting process was ended after recording its pid and command. Its mistakenly located helper logs were moved into this lane's folder and the empty folders it created removed. The corrected queue is the only pending command. No test or download ran in the failed helper setup.

The long-id regression now holds the first decode before the remaining burst is processed, making its scheduling dependency reproducible. The old queue setup is preserved for failing-first execution. Ownership-query failure diagnostics now include the selected `ps` arguments and actual exit status; refusal behavior is unchanged. These diagnostics will distinguish selected-process disappearance from an unrelated query failure in the new image.

Command `docker pull --platform linux/amd64 rust:1-trixie`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/rust-image-pull.log`.

Command `python3 .retest/linux-build/media-fixes/start.py`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-container-start.log`.

## Container prerequisites

The pulled image digest exactly matches the earlier lane, `sha256:15ad267e7a4cb2dce5905c90c76765adb6714945c5ea6d7c82673897a5e4067b`. This lane's container has networking disabled as well as read-only source mounts. Image/container inspection and its owned id are retained in `logs/image-inspect.json`, `container-inspect.json` and `container.id`.

ffmpeg and ffprobe are genuinely absent. No ffmpeg version or codec is available in this image. `logs/linux-tools.log` records path discovery; each attempted ffmpeg version/encoder/decoder/format command fails at Docker exec with executable-not-found, with its exact command and exit retained alongside its log.

The image installs only cargo, rustc and rust-std for Rust 1.99.0, as `logs/linux-components.log` shows. `cargo clippy --version` reports cargo-clippy not installed, `logs/linux-clippy-version.log`. Linux Clippy cannot be verified without another download, which this task forbids. No component installation is attempted. The actual all-target Clippy command will still be recorded, and Mac Clippy remains required.

Reproduction `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d sh /repo/.retest/linux-build/media-fixes/spawn-probe.sh`. Exit 0.  Log `.retest/linux-build/media-fixes/logs/linux-spawn-before.log`.

Reproduction `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d /out/target/x86_64-unknown-linux-gnu/debug/deps/retest_media-c655b4f03a60b663 --exact frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video --nocapture`. Exit 101. test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 97 filtered out; finished in 0.03s Log `.retest/linux-build/media-fixes/logs/linux-colour-legacy-before.log`.

Reproduction `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d /out/target/x86_64-unknown-linux-gnu/debug/deps/process-119988d8a73d813e`. Exit 101. test result: FAILED. 52 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 13.91s Log `.retest/linux-build/media-fixes/logs/linux-process-legacy-before.log`.

Reproduction `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --bin retest-media`. Exit 101. test result: FAILED. 97 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.29s Log `.retest/linux-build/media-fixes/logs/linux-units-before.log`.

Reproduction `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --test process`. Exit 101. test result: FAILED. 53 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 14.26s Log `.retest/linux-build/media-fixes/logs/linux-process-before.log`.

Command `python3 .retest/linux-build/media-fixes/reproduce.py`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-reproductions.log`.

## Reproduced causes and first fixes

The retained profiled-JPEG unit again failed with BrokenPipe, 0 passed and 1 failed. The fresh unit target failed identically, 97 passed and 1 failed. The image has no executable at any ffmpeg path. The test now locates the executable through metadata before launch and writes a named prerequisite skip to the real stderr descriptor only if every candidate is absent. An unreadable candidate, failed executable, failed encoder listing, missing libx264 or failed conversion still fails. ffmpeg failure status and stderr are checked before reporting a stdin write error. All original intended-colour and pixel-size assertions remain.

The retained missing-encoder process test failed unchanged. The standalone Rust launch diagnostic proves that this image/emulation route returns a spawned child exiting 127 with empty stderr for `/no/such/ffmpeg`, with and without a new process group. A PATH-name miss with null stdin returns ENOENT. No physical Linux host was used, so the difference is attributed only to this observed container route. `spawn_in_group` now checks metadata for an explicit path before dispatch. A known-absent path therefore reports could-not-be-started with no invented encoder exit. The original error reply assertion is unchanged. Encoder environment filtering is unchanged.

The deterministic long-id test failed with received 64, shown 61, dropped 3, queue peak 60 and saturation 3. The product correctly reported partial evidence. The fixture now requests `queueFrames: 64` for its required 64-frame burst and additionally requires received 64, shown 64, dropped 0 and complete evidence. Every original header bound, 64-available, omission and exact payload-size assertion remains. The default production queue stays 60.

The deterministic post-ending release test failed with recording_running after an ok/complete ending. The worker sets its terminal state and sends ended before its JoinHandle becomes finished, while release checked map membership alone. Release now honors that terminal state, removes the store immediately, and leaves the thread supervised until its ordinary join. A released store is not retained again when the server later joins it. The original running-release refusal remains unchanged.

The retained process target passed 52 and failed 3. Its ownership-query failure moved from the no-codec test to the command-change test, while no-codec and the original release test passed. The fresh target passed 53 and failed 3, including the deterministic release regression; no ownership-query failure occurred in that run. Ownership remains under investigation, with no refusal weakened. Both deliberately injected panic tests passed in both process runs, with structured error replies and the existing cleanup checks.

Ownership observation regressions are now added before changing its decisions. They inject a failed selected query followed by successful fresh discovery and a complete identity, require exactly one bounded re-observation, and require repeated failures to preserve both reasons with no identity. A separate control requires failed fresh discovery to remain an error. The production snapshot has only been factored to accept these observation callbacks; its original refusal decision remains unchanged. The queued first-after run will therefore also serve as failing-first evidence for this remaining defect. This is a metadata observation retry, never a retried signal or encoder action.

Added `concurrent_fast_probes_keep_the_missing_codec_result_and_clean_exit`, with 16 independent real media processes and fast no-codec scripts. Every one must return the missing-codec status and reason, unavailable evidence, exact clean bye and successful exit. All worker joins are reconciled even when one fails. The Linux command helper independently runs the process target when Cargo stops at a unit failure, logs that additional exact command, and preserves the original failed exit. This allows both ownership regressions to run under the sole queued gate.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-first-after.log`.

## Ownership failing-first result and correction

The queued first-after gate acquired the lock. Units returned 98 ok and 3 failed, with the absent-ffmpeg witness explicitly skipped by name. All three new ownership regressions failed as intended: a failed selection was not re-observed, a repeated failure had only one reason, and failed fresh discovery discarded the first query's reason. The independently run process target passed 56 and failed 1, a timeout in the unchanged forking-wrapper deadline case. The missing encoder, long-id, deterministic release, original release and 16 concurrent no-codec probes all passed. Log `logs/linux-first-after.log` retains both targets and every failure.

Snapshot discovery and selected identity reads now share one existing SNAPSHOT_LIMIT budget. A selected-query failure gets one fresh discovery and, when relevant pids remain, one full-identity read of those fresh pids. Every resulting identity still passes the original birth, command, ancestry and unknown-group checks. Failed fresh discovery or repeated failed selection preserves both reasons and yields no identity; a failed read never proves absence. Query diagnostics are bounded to keep failure replies below the protocol header limit. No signal, encoder dispatch or test assertion is retried or weakened.

The observed intermittent Linux query failure moved between fast fixtures across the retained runs. The exact failed syscall or procps internal branch was not captured in that earlier binary; no physical Linux or tool-version diagnosis is invented. The deterministic units establish and fix the crate's own response to that failure. The shared query budget also prevents multiple metadata waits from multiplying while holding the watchdog's ownership lock; the unchanged deadline timeout needs a clean rerun.

Release state is stored on RecordingData itself, rather than depending on the bounded remembered-id set, so a late join cannot re-retain an already released store. This is an internal state only, with no protocol addition.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-ownership-after.log`.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /out/media-fixes/ownership-before/media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --test process an_encoder_with_neither_codec_is_unavailable -- --exact`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-no-codec-before-policy.log`.

## Linux passing results and original no-codec regression

`linux-ownership-after.log` passed 101 libtest unit entries and all 57 process tests. One unit entry is the explicitly named absent-ffmpeg skip, so this means 100 asserted units and one prerequisite skip, not 101 colour-verified tests. Neither target has ignored or filtered tests. The previously timed-out forking-wrapper deadline and both injected worker-panic cases passed unchanged.

The original `an_encoder_with_neither_codec_is_unavailable` now also injects one selected-query failure after a real full identity read succeeds. A disposable copy of the crate with the old snapshot refusal policy failed that exact process test: 0 passed, 1 failed, 56 filtered, exit 101. It returned encoder_failed with unavailable evidence and the named query failure, rather than the required encoder_unavailable missing-codec result. This is `logs/linux-no-codec-before-policy.log`; the working tree was never reverted. The debug-only hook does not exist in release builds. Every original no-codec assertion remains.

The next full Cargo run, `logs/linux-final.log`, passed 101 unit entries (100 asserted and the same named absent-ffmpeg skip) and 57 process tests, 0 failed, 0 ignored, 0 filtered in both targets, exit 0. It includes that stronger original no-codec regression and all three observation unit regressions. These are default parallel runs, not single-threaded passes hiding a scheduling issue.

Both installed-tool negative controls behaved as required: `/bin/false` failed its encoder listing, and an executable listing libvpx but no libx264 failed the explicit required-codec assertion. Each exact colour unit returned 0 passed, 1 failed, 100 filtered, exit 101, with no SKIP line. Logs are `linux-present-failing-ffmpeg.log` and `linux-present-missing-codec.log`. These intentional failures are not counted as passing Cargo suites.

The deterministic release regression also failed first on this Mac using Homebrew's toolchain and a disposable pre-fix server: 0 passed, 1 failed, 55 filtered, exit 101, `logs/mac-release-before.log`. An ok/complete ending was followed by recording_running instead of the exact requested Released reply. This proves a real lifecycle defect which macOS scheduling previously masked, rather than a Linux-only protocol difference.

## Repeat caught another ownership path

`logs/linux-final-repeat.log` retained a failed default parallel repeat: 101 unit entries ok (including the named absent-ffmpeg skip), process 54 passed and 3 failed, exit 101. The no-codec and concurrent-probe failures were joined by a reply timeout in the unchanged copy-finalization case. The final-check sequence stopped immediately; later checks did not run under a falsely green summary.

The new diagnostic captures the external tool failure: a selected `/bin/ps` process exited with signal 5, SIGTRAP, for `-ww -p 23790 -o pid=,ppid=,pgid=,stat=,lstart=,args=`. This establishes the image/emulation tool behavior, though its internal cause and exact calling phase are unverified. The separate per-pid observation before a signal also had the old refusal policy after fresh discovery found that pid, and reset the observation budget. Source inspection and failing-first units establish that defect independently. It needs the same bounded re-observation and error preservation as snapshots, while retaining the unchanged final birth/command comparison before any signal.

The debug selection-failure hook was too broad: it could inject into that per-pid signal check as well as a snapshot. It is now limited to snapshot selection. Three new units pin the separate per-pid failure policy before changing it: successful fresh identity after one failed read, both failure reasons after repeated reads, and the original reason preserved when fresh discovery fails. Neither real SIGTRAP failures nor the timeout are skipped or erased.

`logs/linux-signal-observation-before.log` failed first with 1 passed, 3 failed, 100 filtered, exit 101. The three new per-pid observation regressions all failed for the same policies as the snapshots. That path now shares one observation budget and permits one full fresh identity read when successful fresh discovery still finds the pid. Repeated query failure preserves both reasons and yields no identity; failed discovery never proves absence. `stop_recorded` still refuses changed birth or command, unknown group membership, and every unreadable observation. No signal is retried.

Tool inventory adds `docker exec 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d /bin/ps --version`, exit 0, `logs/linux-ps-version.log`: procps-ng 4.0.4. `docker top` of this lane's container shows `/run/rosetta/rosetta` for its idle process, `logs/container-idle-audit.log`. That records the translation route actually used, without claiming that Rosetta's internal implementation caused SIGTRAP. The idle audit contains only Docker init and this lane's sleep, with no retained test or encoder process.

Static source audit `logs/source-audit.json` compares against this lane's initial working-tree copy, not against git HEAD. Changed files are `src/encoder.rs`, `src/frame.rs`, `src/process_ownership.rs`, `src/recording.rs`, `src/server.rs` and `tests/process.rs`. All other media files, including Cargo.toml, Cargo.lock and jobs.rs, remain byte-identical to that copy. The encoder environment-filter block is compared separately and remains byte-identical. Rustfmt check and scoped diff whitespace check both returned 0, `logs/rustfmt-check.log` and `logs/diff-check.log`.

## Final Linux observations

`logs/linux-final-observations.log` and `logs/linux-final-observations-repeat.log` both return exit 0: 104 libtest unit entries ok, of which 103 actually assert their behavior and one prints the named absent-ffmpeg prerequisite skip; all 57 process tests pass in each run. Both targets report 0 failed, 0 ignored, 0 filtered. Default parallel scheduling is unchanged. All original process failures, both deliberate worker-panic cases, the fast concurrent probes, copy finalization and the forking-wrapper deadline pass in both runs. The additional three per-pid observation regressions now pass as well.

The all-target, all-feature Linux Clippy command was actually attempted, with locked offline dependencies and warnings denied. It exits 1 before source analysis because cargo-clippy is not installed for the image's Rust toolchain. This is `logs/linux-clippy-all-targets.log`. It is an unavailable check, not a clean Clippy result; no component download is attempted.

## Homebrew verification

`logs/mac-final.log` returns exit 0 with 104 asserted units and all 57 process tests, 0 failed, 0 ignored, 0 filtered and no prerequisite skip. The real profiled-JPEG witness uses `/opt/homebrew/bin/ffmpeg` 9.0.2, successfully encoding and decoding both original/resized and raw/encoded routes with every original colour tolerance unchanged. Both intentional worker-panic cases return their required failure replies and pass their existing assertions.

`logs/mac-clippy-all-targets.log` and `logs/mac-clippy-all-features.log` both return exit 0, with Homebrew rustc/cargo/clippy-driver, locked offline dependencies, all targets and `-D warnings`. The second also checks `allocation-counts`; it runs no allocation benchmark. Exact environment and commands are in the execution record and `.command` files.

Both locked offline production release builds return exit 0 without compiler warnings: `logs/linux-release.log` for x86_64-unknown-linux-gnu in the container and `logs/mac-release.log` for Homebrew aarch64-apple-darwin. They write only this lane's isolated target directories. The source-file hashes in `source-audit.json` still match the checked and built working source; no source edit followed the final passes.

## Copied-crate output isolation correction

The original `frames_are_returned_from_a_running_and_an_ended_recording_until_released` was then reproduced exactly on a disposable pre-fix server copy, with only the debug post-ending worker hold added to its fixture: 0 passed, 1 failed, 56 filtered, exit 101, `logs/linux-original-release-before.log`. Every original assertion remained. It failed the requested release with recording_running after successful ended frame retrieval.

The first paired after-copy unexpectedly failed identically, `logs/linux-original-release-after.log`. Its source contains the release fix and reads `RecordingData.released`, yet Cargo replayed the pre-fix binary's warning that the field was never read. The two copied packages shared the same target directory and reused the executable; `logs/copied-crate-cache-evidence.json` retains that source/binary discrepancy. This was a reproduction-helper defect, not a reason to change the source or assertions. That failed run and its raw log remain.

The corrected reproduction gives each copy a distinct fresh target directory. The final working-crate suites are also repeated in fresh directories used only by `/media/Cargo.toml` and the real Mac crate, respectively. Their results supersede the earlier shared-directory suite results as the final verification. The two production release builds and Mac Clippy checks never ran on copied crates in their respective release/check profiles; their successful results remain, with the unchanged source hashes pinned.

With those distinct fresh targets, the exact original release test fails first with the original server and passes with the current server. `logs/linux-original-release-v2-before.log`: 0 passed, 1 failed, 56 filtered, exit 101, the exact recording_running mismatch. `logs/linux-original-release-v2-after.log`: 1 passed, 0 failed, 56 filtered, exit 0 and no warning. The same original fixture gets only the post-ending worker hold in both copies; every assertion is byte-identical. The working test file is unchanged by this reproduction. This pins the original release failure itself, as well as the new direct terminal-release regression already run on both platforms.

## Fresh-directory timeout investigation

`logs/linux-final-isolated.log` has units 104 ok (103 asserted plus the named skip), but the first process target passes 56 and fails 1: frames_of_a_recording_whose_encoder_died_are_still_returned times out waiting for a reply. The helper mistakenly labelled any Cargo exit 101 as an unreached process target and independently ran the target again, which passed 57. The original exit remains 101. The helper is now corrected to preserve failures without automatic test reruns; an unreached target is run explicitly as its own queued command when needed.

Test reply helpers now use `#[track_caller]` so a future timeout names the exact caller stage instead of only the generic receiver. WAIT and every assertion are unchanged. `logs/linux-reply-stage-diagnostic.log` then passes all 104 unit entries (103 asserted plus the named skip) and 57 process tests, exit 0, in the working crate's isolated output directory. The intermittent earlier timeouts remain under investigation, rather than being called fixed from a rerun alone.

An isolated diagnostic copy adds only versioned stderr metadata-query begin/end records, elapsed observations, result byte counts/errors and synthetic fixture/pid correlation. It does not log application commands or query results, change a signal, change a timeout, or change an assertion. Each diagnostic run's exit is preserved and stops the diagnostic sequence on failure. Its target directory is private to that copy. Actual procps stderr is inherited there to retain any Rosetta/tool diagnostic normally discarded by the metadata reader.

The first trace copy failed compilation before running any test, `logs/linux-metadata-trace-1.log`, exit 101: its diagnostic fixture label referenced scratch outside that helper's scope. The diagnostic script now derives the label from its actual ffmpeg-path argument, and uses a new copy, new target and new log names. The failed copy/log are preserved. This changes no working media source or test assertion.

## Rosetta failure evidence

All three corrected traced process targets pass 57 tests, 0 failed, 0 ignored, 0 filtered, exit 0: `logs/linux-metadata-trace-v2-1.log`, `linux-metadata-trace-v2-2.log`, `linux-metadata-trace-v2-3.log`. This includes real selected-query SIGTRAP failures which the bounded fresh observation reconciles, rather than ignoring a failed read or authorizing a signal without identity.

Actual inherited tool stderr now identifies the trapping component. Run 2, lines 1345–1350, prints `Could not readlinkat /proc/56284/exe`, with `ThreadContextFcntl.cpp:142 was_rosetta_process_invoked_directly`, followed by a selected ps SIGTRAP. Run 3, lines 417–429, prints `Could not open /proc/58350/auxv: 13`, with `InitStack.cpp:262 get_argv_skip_for_other_rosetta`, followed by SIGTRAP; lines 1795–1799 repeat the readlinkat assertion for `/proc/60105/exe`. These are Rosetta assertion diagnostics in the actual container route. They are not missing ffmpeg, missing codecs or an uncaught Retest worker panic. The reason that each underlying `/proc` lookup failed, and behavior on physical Linux, remain unverified.

`logs/metadata-trace-summary.json` retains parsed begin/end counts and failures. Parallel stderr writes interleave some records, so its counts cover parsed records only and are not a complete pairing proof. The longest parsed query observations in the three runs were 506, 301 and 401 ms; no query timeout was captured there. The earlier generic reply timeouts did not recur, and their individual cause is still unverified. The report does not turn their later passing reruns into a claim that those timeouts were diagnosed.

## Release identities and final source pins

`logs/release-artifacts.json` records both isolated release artifacts, their exact version replies, sizes and `file` identification. Linux is ELF x86-64 GNU, 1,635,280 bytes, SHA-256 `30b5ff04585b3b706f2860fe7b818dd47ca23ac5f78404861fa8be42e107fe81`; `--version` reports Retest 0.1.0, protocol 2, x86_64-unknown-linux-gnu, release. Mac is Mach-O arm64, 1,398,272 bytes, SHA-256 `0db4c9d0ac2090f9c1e71d4633a8a0a363b050614b9a25bf386665c993ffd87e`; its version reports aarch64-apple-darwin, release, protocol 2 and the recorded local revision with local changes. Both version commands return 0. These are artifact identities, not a distribution or minimum-OS compatibility claim.

The final `source-audit.json` includes the diagnostic caller annotations in the test helper; the earlier pin is retained as `source-audit-before-caller.json`. Production source is byte-identical to the source of the successful release builds. Final Rustfmt and scoped diff checks return 0, `logs/rustfmt-final-check.log` and `logs/diff-final-check.log`. The encoder environment-filter block is still byte-identical to this lane's initial copy.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-final.log`.

Negative prerequisite control `docker exec --workdir /media --env RETEST_FFMPEG=/bin/false 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --bin retest-media frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video -- --exact`. Exit 101. Expected a failed test, with no skip: True. Log `.retest/linux-build/media-fixes/logs/linux-present-failing-ffmpeg.log`.

Negative prerequisite control `docker exec --workdir /media --env RETEST_FFMPEG=/repo/.retest/linux-build/media-fixes/ffmpeg-without-libx264 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --bin retest-media frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video -- --exact`. Exit 101. Expected a failed test, with no skip: True. Log `.retest/linux-build/media-fixes/logs/linux-present-missing-codec.log`.

Command `python3 .retest/linux-build/media-fixes/prerequisite-controls.py`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-prerequisite-controls.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg /opt/homebrew/bin/cargo test --locked --offline --manifest-path .retest/linux-build/media-fixes/mac-before/media/Cargo.toml --target-dir .retest/linux-build/media-fixes/mac-target --test process an_ended_recording_can_be_released_before_its_worker_returns -- --exact`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/mac-release-before.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-final-repeat.log`.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --bin retest-media signal_`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-signal-observation-before.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-final-observations.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-final-observations-repeat.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py clippy --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --all-targets --all-features -- -D warnings`, through the shared gate. Exit 1. Log `.retest/linux-build/media-fixes/logs/linux-clippy-all-targets.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg /opt/homebrew/bin/cargo test --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/mac-target`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-final.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/mac-target --all-targets -- -D warnings`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-clippy-all-targets.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/mac-target --all-targets --all-features -- -D warnings`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-clippy-all-features.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py build --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/target --target x86_64-unknown-linux-gnu --release`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-release.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg /opt/homebrew/bin/cargo build --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/mac-target --release`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-release.log`.

Original release race `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/release-original-before/media/Cargo.toml --target-dir /out/media-fixes/release-race-target --target x86_64-unknown-linux-gnu --test process frames_are_returned_from_a_running_and_an_ended_recording_until_released -- --exact`. Exit 101. Expected result verified: True. Log `.retest/linux-build/media-fixes/logs/linux-original-release-before.log`.

Original release race `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/release-original-after/media/Cargo.toml --target-dir /out/media-fixes/release-race-target --target x86_64-unknown-linux-gnu --test process frames_are_returned_from_a_running_and_an_ended_recording_until_released -- --exact`. Exit 101. Expected result verified: False. Log `.retest/linux-build/media-fixes/logs/linux-original-release-after.log`.

Command `python3 .retest/linux-build/media-fixes/original-release-reproduction.py`, through the shared gate. Exit 1. Log `.retest/linux-build/media-fixes/logs/linux-original-release-reproduction.log`.

Original release race `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/release-original-v2-before/media/Cargo.toml --target-dir /out/media-fixes/release-race-target-before --target x86_64-unknown-linux-gnu --test process frames_are_returned_from_a_running_and_an_ended_recording_until_released -- --exact`. Exit 101. Expected result verified: True. Log `.retest/linux-build/media-fixes/logs/linux-original-release-v2-before.log`.

Original release race `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/release-original-v2-after/media/Cargo.toml --target-dir /out/media-fixes/release-race-target-after --target x86_64-unknown-linux-gnu --test process frames_are_returned_from_a_running_and_an_ended_recording_until_released -- --exact`. Exit 0. Expected result verified: True. Log `.retest/linux-build/media-fixes/logs/linux-original-release-v2-after.log`.

Command `python3 .retest/linux-build/media-fixes/original-release-reproduction.py`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-original-release-v2-reproduction.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/final-linux-target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-final-isolated.log`.

Command `python3 .retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/final-linux-target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-reply-stage-diagnostic.log`.

Diagnostic metadata trace `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/metadata-trace/media/Cargo.toml --target-dir /out/media-fixes/metadata-trace-target --target x86_64-unknown-linux-gnu --test process -- --nocapture`. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-metadata-trace-1.log`.

Command `python3 .retest/linux-build/media-fixes/metadata-trace.py`, through the shared gate. Exit 101. Log `.retest/linux-build/media-fixes/logs/linux-metadata-traces.log`.

Diagnostic metadata trace `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/metadata-trace-v2/media/Cargo.toml --target-dir /out/media-fixes/metadata-trace-target-v2 --target x86_64-unknown-linux-gnu --test process -- --nocapture`. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-metadata-trace-v2-1.log`.

Diagnostic metadata trace `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/metadata-trace-v2/media/Cargo.toml --target-dir /out/media-fixes/metadata-trace-target-v2 --target x86_64-unknown-linux-gnu --test process -- --nocapture`. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-metadata-trace-v2-2.log`.

Diagnostic metadata trace `docker exec --workdir /media 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d cargo test --locked --offline --manifest-path /out/media-fixes/metadata-trace-v2/media/Cargo.toml --target-dir /out/media-fixes/metadata-trace-target-v2 --target x86_64-unknown-linux-gnu --test process -- --nocapture`. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-metadata-trace-v2-3.log`.

Command `python3 .retest/linux-build/media-fixes/metadata-trace.py`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-metadata-traces-v2.log`.

Release identity `docker exec 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d /out/media-fixes/target/x86_64-unknown-linux-gnu/release/retest-media --version`. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-gnu-x64-release-version.log`.

Release identity `/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/mac-target/release/retest-media --version`. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-arm64-release-version.log`.

Command `/opt/homebrew/opt/python@3.14/bin/python3.14 /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/linux.py test --locked --offline --manifest-path /media/Cargo.toml --target-dir /out/media-fixes/final-linux-target --target x86_64-unknown-linux-gnu`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/linux-final-verified-repeat.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg /opt/homebrew/bin/cargo test --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/final-mac-target`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-final-isolated.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/final-mac-target --all-targets -- -D warnings`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-clippy-isolated-all-targets.log`.

Command `env PATH=/opt/homebrew/bin:/usr/bin:/bin CARGO=/opt/homebrew/bin/cargo RUSTC=/opt/homebrew/bin/rustc RETEST_FFMPEG=/opt/homebrew/bin/ffmpeg RUSTC_WORKSPACE_WRAPPER=/opt/homebrew/bin/clippy-driver /opt/homebrew/bin/cargo-clippy clippy --locked --offline --manifest-path /Users/dragon/Documents/Projects/Gruvi/Products/retest/media/Cargo.toml --target-dir /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/media-fixes/final-mac-target --all-targets --all-features -- -D warnings`, through the shared gate. Exit 0. Log `.retest/linux-build/media-fixes/logs/mac-clippy-isolated-all-features.log`.

## Final verification

| Check | Units actually asserted | Process tests | Named prerequisite skips | Exit | Log under `.retest/linux-build/media-fixes/logs/` |
|---|---:|---:|---:|---:|---|
| linux-reply-stage-diagnostic | 103 | 57 | 1 | 0 | `linux-reply-stage-diagnostic.log` |
| linux-final-verified-repeat | 103 | 57 | 1 | 0 | `linux-final-verified-repeat.log` |
| mac-final-isolated | 104 | 57 | 0 | 0 | `mac-final-isolated.log` |

Each full target reports zero failures, zero ignored and zero filtered tests. Linux libtest reports 104 unit entries as ok because it counts the visible early prerequisite return as ok; the table subtracts that one entry. The Mac profiled-JPEG witness actually encodes and decodes the original/resized raw and encoded routes with ffmpeg 9.0.2 and retains every intended-colour assertion. `final-results.json` retains the machine-readable counts.

Clippy: `mac-clippy-isolated-all-targets.log` and `mac-clippy-isolated-all-features.log`, both exit 0 with `-D warnings`; `linux-clippy-all-targets.log`, exit 1 before source analysis because cargo-clippy is not installed. No Linux Clippy cleanliness is claimed. Release compilation: `linux-release.log` and `mac-release.log`, both exit 0. Exact commands and process identities accompany every command log.

## What remains unverified

Linux Clippy could not run under the download restriction. The image contains no ffmpeg or ffprobe, so no real Linux ffmpeg version, codec or colour/video conversion is verified; synthetic process fixtures verify the crate lifecycle and protocol there. This is Docker Linux GNU x64 under the recorded Rosetta route on a Mac, not a physical Linux host. The trace captured Rosetta assertions before selected ps SIGTRAP failures; why those underlying /proc lookups failed is unverified. The individual earlier reply timeouts were not captured in the traced runs; their failed logs remain and the final unchanged deadline cases pass in both consecutive working-crate runs. Rust 1.88, other toolchains, other Linux libc targets and native/mobile/browser capture were not exercised. No benchmark, fresh Node suite, installer/download flow or release distribution is claimed. The earlier Node results belong only to the previous lane.

The host's offline Rustup Clippy inventory contains only `stable-aarch64-apple-darwin` tools, `logs/host-offline-clippy-inventory.log`. No cached Linux Clippy executable was found there. Installing the missing image component would require the forbidden additional download.

Release outputs stay in this lane’s isolated target directories; the shared `media/target/release` binary and installer source-manifest pins were not replaced or refreshed. Those pins need the owning release lane to account for these source changes. Protocol 2 and client signatures are unchanged; `media-client-v2.md` records the terminal release and bounded observation behavior.

Owned cleanup `docker stop 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d`. Exit 0. Log `.retest/linux-build/media-fixes/logs/owned-container-stop.log`.

Owned cleanup `docker rm 7149e92d688c94638bedf473f213a73442d67dce8d508d6484c9b1bec2f4170d`. Exit 0. Log `.retest/linux-build/media-fixes/logs/owned-container-remove.log`.

Cleanup completed. The final container process audit contains only Docker init and this lane’s idle sleep, with no test, encoder or metadata process. Only the recorded owned container was stopped and removed. Docker daemon remains running, confirmed by `docker info --format '{{.ServerVersion}}'`, exit 0, `logs/docker-daemon-after-cleanup.log`. The authorized image and all evidence/artifacts remain cached. No commit, stash, reset, revert, publication or benchmark ran.
