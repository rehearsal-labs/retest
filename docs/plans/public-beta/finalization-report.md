# Finalization of phases 1 to 4

8 and 9 October 2026, on tree b68b6f1 plus the uncommitted changes this report describes. Local logs and artifacts under `.retest/finalization/` are ignored evidence; this file keeps the commands, counts and conclusions. Every count below was read from a log, not inferred.

## Starting state

- Branch `main`, HEAD b68b6f1 (signed), tree clean apart from the untracked `pnpm-lock.yaml`. Node 24.12.0 selected explicitly.
- The three pinned browser archives were missing from `~/Library/Caches/retest-proofs/downloads/`. They were downloaded again from the pinned publisher URLs in `src/browser/builds.ts`; each SHA-256 matched its pin (Chrome for Testing 153.0.8010.12, Firefox 133.0.3, WebKit build 2359).

## Gates on the committed tree b68b6f1

| Gate | Result |
| --- | --- |
| `npm run build`, `npm run typecheck`, `npm run typecheck:proofs` | exit 0 each |
| `npm run test:types` | 246 expected errors matched 246 markers, TypeScript 6.0.3 and 7.0.2 |
| `npm run test:unit` (default concurrency) | run 1: 4255 tests, 4254 passed, 1 failed (a 2000 ms fake-driver budget under load); run 2: 4255/4255, exit 0, 166 s |
| `tests/integration/install.test.ts` alone | 16 tests, 15 passed, 1 failed once (Chromium doctor: process group still there 1000 ms after SIGKILL on the first launch of the fresh build); the Chromium case alone passed 2/2 afterwards and all three install cases passed in the complete list |
| Complete browser list (129 files) | 1663 tests, 1657 passed, 2 failed, 4 skipped (3 live-provider gates without keys; the timeline test skipped itself on Wispr Flow's window). The two failures passed alone: `agent-sessions.test.ts` 11/11, `capture-firefox.test.ts` 5/5 |
| `cargo test` (Homebrew cargo 1.98.1, offline) | 104 unit and 57 process tests passed |
| `cargo clippy --all-targets -- -D warnings` | clean, with `CARGO`, `RUSTC` and `RUSTC_WORKSPACE_WRAPPER` naming the Homebrew toolchain; plain `cargo clippy` selects rustup 1.81 and refuses |
| Azure live evaluator gate (`evaluation-ai-sdk.test.ts`, deployment gpt-6.1-sol, base URL ending in `/openai/v1`, no api version) | 6 tests, 4 passed, 2 skipped (Anthropic and OpenAI without keys), key absent from every log |
| `evidence-timelines.test.ts` alone with the desktop clear | 5/5 |
| Complete native list (19 files), desktop clear of overlays | 100 tests, 97 passed, 3 failed: all three the broken-sync reference flow, whose desk recording ended early |

## Defects found and fixed

1. **A failed process reading ended a native recording.** The desk's window-crop capture confirmed its app processes before and after every image; one `lsappinfo find` that answered late was treated as the app being gone and the recording ended for the rest of the attempt (`recording.finished` gap `capture_ended_early`). Now `nativeCaptureTargetCheck` answers `{ problem, gone }`; a reading that could not be taken drops that frame, hands over no pixels, and lets the next tick or the start budget ask again; readings that prove the app gone or outside the session's launch still end the source. Unit tests cover both routes. Codex (GPT-6.1 Sol, read-only) reviewed the change: no findings. `evidence-flows.test.ts` alone afterwards: 13/13.
2. **macOS capture by window number** (founder decision, 9 October). The display crop refused whenever another process's window lay over the app's window, which Wispr Flow's floating window did on every run. The capture now takes the app's own window by its number through `screencapture -l`, chosen among the session's recorded pids at the tree's frame, requires the same window and owner before and after the image, checks the image is the window's points at a whole scale, and hands the bytes over untouched. Overlays never enter the image. The in-front and overlap refusals are gone from capture only; input still refuses a window of another process over the element's centre. Prerequisite: Screen Recording for the app that runs Retest; `retest doctor` reports it (`macos  Screen Recording`), README and guide say so. Real proof with Wispr Flow's window over TaskDesk: `capture-macos.test.ts` 2/2 three times; the image under the overlay held 0 overlay pixels. Measured window images: 1.3 to 2.3 s each, against 1.8 to 3.0 s for the old display route.
3. **Capture budget.** The window image and its readings now leave the command's termination grace and the reply margin inside the 5000 ms capture timeout, so an over-budget capture is a dropped frame rather than an unanswered grab that ends the recording; a window-route start retries only while a whole capture's time is left, so a window that never comes is refused by its last reading rather than as "did not answer".
4. **Startup race.** A capture asked before the app's window exists in the tree is retryable at start; the overlay test waits for the window.
5. **Free port.** `freePort` drew ports that a `[::1]` client socket held, which stopped the executor twice; it now draws below the ephemeral range and probes both loopback addresses.
6. **Runner kill race** (found on Linux). After a forged pass the child could answer the stop before the kill landed, and the next test of the file was dispatched to the dying process and reported failed. `processKilled` on the body report makes later tests `not_run`. Failing-first test in `runner-observations.test.ts`.

## Linux

The full Linux suite had not run since the 30 September commit. On this Mac's Docker (linux arm64, `docker/linux/run.sh`, per-test timeouts): first run 4257 unit tests, 4083 passed, 70 failed, 102 skipped; integration 858 tests, 700 passed, 46 failed, 112 skipped. Classification in `reviews/fix-reports/linux-classification-report.md`: one product defect (item 6 above), one product question settled (Chrome on Linux honours the environment's proxy variables; Retest keeps passing them, and the evaluation test attributes stand-in tunnels by destination host), the rest tests assuming macOS tools or an unpinned architecture, now running with fakes or skipping by name. After the changes: whole unit suite 4245 tests, 4088 passed, 0 failed, 157 skipped; the 16 changed integration files 50 tests, 4 passed, 0 failed, 46 skipped by name. An earlier run hung for 1 h 45 min in `media-discovery-bounds.test.ts`; its wait is now bounded and the case skips on unpinned hosts.

## Gates on the finished tree

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run test:types` | 246/246 on both compilers |
| `npm run test:unit` (default concurrency) | 4273/4273, exit 0 |
| Touched native, capture, doctor and runner unit files | 565/565 |
| `capture-macos.test.ts` with Wispr Flow running | 2/2 |
| `evidence-timelines.test.ts` with Wispr Flow running | 5/5 |
| Codex read-only review of the whole diff (GPT-6.1 Sol) | four findings, all fixed and each checked by removing its fix: a window image could survive a process exit before its removal (the desktop's exit hook now removes its folder); a fixed 5000 ms start-retry floor stopped short start budgets retrying (the floor now follows the time the next attempt gets); short grabs reserved no kill grace (the reserve is kept inside whatever time a grab gets); two stale doc sentences. `reviews/fix-reports/finalization-codex-review.md` |
| `capture-ios.test.ts` with the repaired deadline fixture | 10/10 |
| `capture-macos.test.ts` after the review fixes and the image command's own 500 ms kill grace, Wispr Flow running | 2/2, recording complete, captures 1266 to 2426 ms |
| Final whole-tree typecheck, proofs typecheck, type tests and default unit suite | see the last section |

## Not verified

1. The complete native and browser lists on the finished tree. They ran once on an intermediate tree (native 101 tests, 97 passed; browsers 1663 tests, 1657 passed, every miss passing alone), while a builder's edits landed mid-list, so those counts are diagnostic. Both lists and the Linux lane run again on the committed tree before anything is pushed.
2. Linux x64, the pinned platform: no amd64 image here; the promotion's CI runs it.
3. The full Linux integration suite after the classification: only the 16 changed files ran.
4. Anthropic and OpenAI live evaluator gates: no keys supplied. The corpus keeps 4 reviewed labels and 41 awaiting the founder.
5. Native input still needs the app frontmost and the desktop left alone; only capture became overlay-proof. A trackpad swipe to a full-screen Space and later desktop use each failed one native run.
6. The window image command gets 4000 ms of a 5000 ms grab after its own 500 ms kill grace; a process reading that ignored SIGTERM near the end of a grab could still outlast it, which no real tool does and no test covers. Two unit cases failed once each under the parallel suite and passed on rerun without a cause found: the media worker restart case, and a desktop sessions case whose free port was taken (a loopback bind on macOS succeeds beside a wildcard listener).

## Host notes

- Docker's disk was full; the build cache and unused images were pruned with the founder's permission (about 34 GB).
- A Codex session from the ChatGPT app ran Retest tests in this tree under the shared lock during the first night; the tree stayed clean.
- Screen Recording was granted to the Claude app on this Mac for the window capture proofs.

## Final gates on the finished tree

Recorded from `.retest/finalization/logs/final-*.log` on 9 October, on the tree exactly as it is committed, before any commit was made.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0, 0 errors, no FATAL |
| `npm run typecheck:proofs` | exit 0 |
| `npm run test:types` | 246 expected errors matched 246 markers in 11 projects, TypeScript 6.0.3 and 7.0.2 |
| `npm run test:unit` (default concurrency) | 4278 tests, 4278 passed, 0 failed, 0 skipped, exit 0 |

## After the push

The 62 commits (5 to 9 October, b59eed5..0d8f47d) were pushed and the lanes ran again on that head.

| Lane on 0d8f47d | Result |
| --- | --- |
| typecheck, type tests, unit suite, cargo test, clippy | all exit 0; unit 4278/4278 |
| Complete native list, Wispr Flow running | 101 tests, 101 passed, 0 skipped |
| Complete browser list | 1667 tests, 1663 passed, 1 failed, 3 skipped (live gates): a Firefox install left an empty disk-image mount folder |
| Linux lane (arm64 Docker, per-test timeouts) | units 4257 tests, 4092 passed, 0 failed, 165 skipped; integration 857 tests, 700 passed, 2 failed, 155 skipped |

Fixes, each its own commit, pushed after its proof:

- c0b463b `fix(install)`: the mount point is removed with a bounded retry after `hdiutil detach` and named when it cannot be, instead of a swallowed `rmdir`; `install.test.ts` alone 16/16 with no folder left.
- b0d94fe `test(evaluation)`: on Linux, Chrome sends plain requests through the run's proxy; the stand-in now refuses them unjudged, and each caller awaits its own install promise, so an error is filed against the test it happens in rather than the first test's "activity after it ended".
- bfd14ca `fix(ownership)`: a Chrome helper on Linux rewrites its own command line as it starts (a fork copy of the root's line, `/proc/self/exe` becoming the executable, a zygote gaining headless switches); a recorded descendant with the same birth, the same recorded parent and exactly that change is the process recorded and is ended; a changed birth, parent, executable or any other change stays refused; macOS paths with spaces never match. Failing-first units; in Docker `cdp.test.ts` 3/3 and a 15-run early-recording probe with 0 refusals.

On bfd14ca: the Mac browser files that exercise ownership 32/32; the full Linux lane green (units 4266 tests, 4101 passed, 0 failed; integration 856 tests, 701 passed, 0 failed); the Mac unit suite 4287 tests, 4285 passed, 2 failed in `runner-stop-reason.test.ts` under the parallel suite only: a host-stopped test's failure carried the child's location when the child answered the stop first. Fixed in `src/runner/running-test.ts`: a child's first failure that only repeats the revocation is recorded as the parent's reason, whichever arrives first; failing-first test with the kill held back; unit suite 4288/4288 afterwards.
