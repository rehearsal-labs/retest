# Fix lane C: process ownership, media, Chromium process, evaluation, fixtures, tests that signal

Repository: /Users/dragon/Documents/Projects/Gruvi/Products/retest. Nothing committed, staged, stashed or reverted. Nothing written before the restart survived; this run started from the tree as it stood. Nothing of this lane is still running.

## 1. Each finding, what changed, and the test that fails on the old code

**T-1** (service tests failing in teardown, services left running)
- New `tests/integration/service-teardown.ts`: `endService(child, what)` sends SIGKILL through the test's own `ChildProcess` handle if the service still runs, waits for its exit, then fails by name if any process of its group is left.
- `tests/integration/cross-platform-service.test.ts` (startService) and `tests/integration/electron-web-flow.test.ts` (startService) use it in place of `signalGroup(pid, 'SIGKILL')`.
- Old code failed in the after hook (the review ran it). Now: cross-platform-service 17 of 17, electron-web-flow 3 of 3, no service or Electron process left.

**T-3** (Rust ownership compared exact commands)
- `media/src/process_ownership.rs`: `matches` treats an unreadable command (kernel short name, at most 16 characters in parentheses or 15 in brackets) as no difference; two readable commands that differ are still refused. A record taken while unreadable keeps the first readable command. `capture` and `stop` are split into `capture_from(readings)` and `stop_with(read, signal)` so the decision is tested on given readings; the public functions are unchanged.
- New tests in the same file: an encoder read as `(ffmpeg)` in states S, R, U and ?E is stopped; another process at the pid (readable change, new start, a 17-character name) is refused; a launch recorded as `(sh)` still owns its child. Toggled off: 3 of 7 failed (`/tmp/retest-lane-c-t3-off.log`); on: 7 of 7.
- One existing assertion changed, because it held the old rule: `zombies_have_exited_even_when_ps_changes_their_command` asserted `!live.matches(zombie)` for a zombie reading `(ffmpeg)`. Under the brief's rule they match; the zombie state, still asserted, keeps it from a signal.

**T-4** (one stalled metadata read disabled all later reads)
- `src/shared/metadata-process.ts`: no permanent failure. A failed or unanswered query ends that worker and throws for that query only; the next query starts a fresh worker. Shared `submit`/`answer` code; a new `readMetadataProcessAsync` uses `Atomics.waitAsync` on the same worker. `useMetadataWorkerModule(file)` lets a test stand in a stalling worker.
- `src/shared/metadata-process-worker.ts`: children whose query failed are kept until their exit is seen and never signalled; up to 4 may be outstanding before later queries are refused with a count. Children still answering are not counted.
- Tests in `tests/unit/metadata-process.test.ts`: a worker made to stall once (`tests/unit/metadata-stalled-worker.ts`), then the next query answers; a stuck child fails only its own query; the backlog bound. Toggled to the old rules: all three fail (`/tmp/retest-lane-c-t4-off.log`, `/tmp/retest-lane-c-t4-off-*.log`).
- One assertion in another lane's file changed: `tests/unit/native-processes.test.ts:305` asserted that one unanswered child refuses the next query, the exact behaviour the brief removes. It now asserts that a later reading is still taken; the backlog bound is tested in metadata-process.test.ts. The file had no other edits in the tree.

**T-6** (renderers unrecorded until close; hung unrecorded child makes `gone` wait forever)
- `src/browser/browser.ts`: `newPage` records descendants after every open, success or failure, from a background reading (`recordDescendantsSoon`); a dropped connection records synchronously.
- `src/shared/process-ownership.ts`: optional `readAsync` on `ProcessOwnershipSystem`, `OwnedProcessGroup.captureAsync()` (falls back to `capture()` on a system without it; a failed background reading records nothing and is not a read problem), exported `unverifiedMembersProblem(groupId)`.
- `src/browser/chromium-process.ts`: `stop` settles identity refusals and the unverified-members problem once the main process has exited and a fresh reading shows the group empty; read and signal failures stay. `gone()` and `waitForOwnedExit` reject naming the group when processes remain 5 close graces (5000 ms) after the main process exited; nothing unrecorded is signalled. The rejection is marked handled for a browser nobody awaits.
- Why the page recording runs in the background: one `capture()` took 46 ms minimum, 79 ms median, here (`/tmp/retest-lane-c-capture-cost.log`), and blocks the main thread; synchronous, every page open would wait that long.
- Tests in `tests/unit/browser-chromium-process.test.ts`: a renderer recorded at page open is ended after the main dies first; unrecorded helpers that end on their own leave a clean close; a hung unrecorded helper is reported, never signalled, and `gone` settles. Toggled off: all three fail (`/tmp/retest-lane-c-chromium-unit-off.log`). Real browser, `tests/integration/browser-lifecycle.test.ts`: main process killed from outside after two pages opened, close settles, group gone, profile removed: passed. Not run against the old code on a real browser (toggling a shared source file for a minute would disturb other lanes' runs).

**Output-close bound** (held "WebKit driver lane 4", Chromium part)
- Cause, shown on real Chrome: the bound was a timer racing an output close that needs several event-loop turns. With the main thread blocked as synchronous readings block it (150 ms of every 175 ms), 8 of 8 healthy closes reported "redacted output did not finish writing and closing within 1000 ms" (`/tmp/retest-lane-c-probe-load-2.log`). Timed from a worker thread, the group was gone at about 260 ms and the output settled at about 2.4 s (`/tmp/retest-lane-c-probe-phases-1.log`). At 35 ms blocks, 0 of 10 failed (`/tmp/retest-lane-c-probe-load-1.log`). Chrome's crash handler (one per launch, launchd parent, own group, database outside the profile) exited with each close in 3 of 3 runs, so it is not the holder (`/tmp/retest-lane-c-probe-crashpad-1.log`).
- Fix in `src/browser/chromium-process.ts` `outputWithin`: when the bound passes, two `setImmediate` turns let waiting I/O be read, then the output is judged by `writersRemain()` (redacted: either pipe not yet at its end; unredacted: the group still has processes). Writers left: reported and cancelled as before. None left: Retest's own writing gets its own bound of 10 close graces, with its own message.
- On the same load after the fix: 0 of 8 refused (`/tmp/retest-lane-c-probe-load-3.log`). Unit tests: writers gone but writing finishing after the bound is not reported (fails on the old code, `/tmp/retest-lane-c-output-synthetic-off.log`); writers still there is reported; own writing is bounded. A real-shell busy-thread test passes on both old and new code; it reproduces nothing and is kept as a guard.
- The same timer race exists in `src/browser/webkit/process.ts` `outputWithin` (around 446-455), not edited here.

**T-7** (`cargo test` red in parallel)
- Cause of the forking-wrapper failures, found by reproduction: right after start a shell script's arguments are briefly unreadable (`KERN_PROCARGS2` gave EIO 7800 times and EINVAL 48 times over 200 launches), `ps` prints `(sh)`, the root's record never matched again, its child was never recorded and counted as of unknown launch, and the probe refused the encoder. The tests waited 10 s for a child of a refused start. Fixed by T-3. Both tests now also assert the start was answered `started`. Parallel, 20 runs each: old rule 11 of 20 failed, all "launch ownership is unknown"; fixed 0 of 20.
- `media/src/server.rs` `output_in_use`: running recording asked before files, one order always. The test waits until the encoder created its `.partial`, when both reasons hold: old order 3 of 3 failed, new 5 of 5 passed. The assertion was not loosened; it still names "recording c is writing".

**T-9 / T-11** (records)
- `docs/plans/public-beta/proofs/media.md`, `fixtures.md`, `electron.md`: new "After the Phase 2 review" sections with what ran on the current tree, commands, counts and log paths.
- `docs/plans/public-beta/proofs/evaluation.md`: "The live run" records the Azure live gate as progress.md reports it and as `/tmp/retest-azure-live-gate-2.log` shows (4 passed, 1 skipped: the Anthropic and OpenAI gate), says the log was never kept in the repository and that the run predates 9b38691; "After the Phase 2 review" records T-12; unverified items 1, 2, 3 and 6 corrected. Not rerun: no key.
- progress.md rows not edited (not in this lane's files); they still say Done with pre-9b38691 counts.

**T-10** (my guide lines, `docs/guide.md`)
- Azure endpoint shapes (now about line 937): the `services.ai.azure.com/openai/v1` shape was used by one live run.
- "no Azure deployment has judged anything yet" (now about line 948): replaced by the one live run's facts; Anthropic and OpenAI still uncalled.
- Firefox (line 186): already true on the tree (another lane changed it to "Firefox on Retest's Firefox driver", matching the driver's record); left as is.
- Two-app Electron check (now about lines 339 and 349): true again (electron-web-flow 3 of 3); no edit needed.

**T-12** (error record kept sampling as given)
- `src/evaluation/ai-sdk.ts`: warnings read before the answer is checked; an unreadable answer throws `AiSdkAnswerError` with `samplingNotSent`.
- `src/evaluation/answer.ts`: `unsentSettingsOf(error)` reads that list by shape, naming nothing if it breaks the answer's rules. `src/evaluation/attempt.ts`: the failed path applies it (`withUnsent`, shared with `withAnswer`). `src/evaluation/contract.ts`: documented for other evaluators.
- Tests in `tests/unit/evaluation-ai-sdk.test.ts`: adapter error names the dropped temperature; malformed lists name nothing; through the parent, the error record keeps `{ topP, maxOutputTokens }` under `sampling` and names `temperature` beside it. Toggled off: 2 failed (`/tmp/retest-lane-c-t12-off.log`); on: 31 of 31.

**T-13** (hidden fields carried by a later merged write)
- `fixtures/cross-platform/service/store.ts`: each stored change also records the fields it set (`changed`, optional, absent means all, so older state files read as before). A client reads each field from the newest change it may see that set it and is not hidden from it; a delayed-only change is not hidden, so the in-delay merge is unchanged; a task whose creation is hidden from a client is never seen by it.
- `fixtures/cross-platform/README.md` says this. The service test's leak assertion (desk saw `done: true`) now asserts the closed form (`done: false`), plus the web keeps its own done and a web-created task never reaches the desk.
- New `tests/unit/cross-platform-store.test.ts`: with the store from HEAD, 3 of 4 fail (the in-delay merge case passes on both, as intended) (`/tmp/retest-lane-c-t13-off.log`).

**T-14** (my five files)
- `run-interrupt.test.ts`: records what retest launches beneath it (`OwnedProcessGroup(retest.pid)`, captured at `browser.started`); teardown kills retest through its handle, then signals only recorded, re-verified processes, and fails by name if the browser group is left.
- `matrix-lifecycle.test.ts`, `m3-press.test.ts`: new `tests/integration/outside-kill.ts` `killBrowserFromOutside(launchedPid, browserPid)` kills the main process by pid right after `verifiedIdentity` under the test's own child. A first version that signalled the whole recorded tree newest first changed the scenario (renderer died before the main, the next test then lost the browser mid-goto: 3 failures, `/tmp/retest-lane-c-int-*-1.log`); killing the main alone matches the old whole-group kill.
- `session-contract.test.ts`: `signalGroup` (this process launched the browser) in place of `process.kill(-pid)`.
- `native-diagnostics-wired.test.ts`: SIGTERM first as before, then `endService`. Not run (needs the simulator and the desktop; not in the gate list); typecheck only.

**T-15** (window between reading and signal)
- `src/shared/process-ownership.ts`: optional `readProcess(pid)` on the system; the host reads `ps -ww -o … -p <pid>,<own pid>` (own pid keeps an absent pid a successful reading); `signalReport` reads each pid alone right before its signal. Comments say what stays impossible without a pidfd on macOS, and that a real command shaped like a kernel name passes the unreadable rule. Measured: one `ps -p` run 24 ms against 32 ms for the table, most of it process start before the reading.
- Tests in `tests/unit/process-ownership.test.ts`: call order (read one pid, signal it, next); a reuse visible only on the one-pid reading is refused; a failing one-pid reading signals nothing; the host reads an absent pid as absent. Toggled off: 3 failed (`/tmp/retest-lane-c-t15-off.log`).

**T-18**: `tests/integration/browser-lifecycle.test.ts` `firstOutput(child, exited, timeoutMs)` races the first output against the exit and a timer; `launchInChild` uses it. Two new tests (child exits first, child prints nothing) pass; with the old unbounded `once` the first would hang.

**T-19**: not implemented, by the coordinator's decision (9b38691 keeps every profile on purpose). Proposal and the profiles left are in section 4.

## 2. Gates, commands and results

- `npm run test:unit`: last full run 3190 tests, 3180 pass, 10 fail (`/tmp/retest-lane-c-unit-1.log`). One was mine (native-processes:305, fixed above). The rest are outside my files: api-native-helpers ×3 (native lane mid-edit), diagnostics-engines ×2, playwright-resolve ×2 (the known loader tests), protocol-identity ×1, runner-lost-look ×1. A later run (`/tmp/retest-lane-c-unit-2.log`) hit `src/browser/webkit/target-session.ts` mid-edit (syntax error), which failed 70+ files at load; those pass when run now. My unit files together: 156 of 156 (`/tmp/retest-lane-c-own-units-1.log`), plus the deterministic output test.
- `npm run test:types`: 234 expected errors matched 234 markers in 10 projects on TypeScript 6.0.3 and 7.0.2 (`/tmp/retest-lane-c-types-1.log`).
- `cargo test` in media/, three runs in a row, default parallel mode: each 46 unit + 25 process tests passed (`/tmp/retest-lane-c-cargo-1.log` to `-3.log`).
- Under `lockf -t 0 /tmp/retest-heavy-gate.lock`, `node --conditions=retest-source --test --test-concurrency=1 tests/integration/<file>.test.ts`:
  - browser-lifecycle 21 of 21, m3-press 2 of 2, matrix-lifecycle 8 of 8, cross-platform-service 17 of 17, electron 5 of 5, electron-web-flow 3 of 3 (`/tmp/retest-lane-c-int-<file>-4.log`)
  - browser-ownership 2 of 2, session-contract 4 of 4 (`-5.log`, final code)
  - run-interrupt: 3 of 3 on the first version (`-1.log`); 0 of 3 in run 5 (`-5.log`), when a `browser.started` line did not parse while another lane was editing `src/protocol/events.ts`, `src/browser/launch.ts` and `src/browser/browser.ts` (all at 12:18:29); 3 of 3 on the final code (`-7.log`)
  - m3-press and matrix-lifecycle failed 1 and 2 in run 1 with the first version of the kill helper (signalled the recorded tree newest first); fixed as described under T-14
- `npm run typecheck` under the lock: exit 2 on errors only in other lanes' files being edited (`src/agent/host.ts`, `src/cli/doctor/checks.ts`, `tests/unit/agent-recipes.test.ts`, `tests/unit/runner-native-run-end.test.ts`) (`/tmp/retest-lane-c-typecheck-6.log`). Both compilers run separately under the lock: TypeScript 6.0.3 7 errors and 7.0.2 8 errors (adds `tests/unit/builds-fixtures.ts`), none in this lane's files (`/tmp/retest-lane-c-tsc6-8.log`, `/tmp/retest-lane-c-tsc7-8.log`); `tsc -p examples/tasks/tsconfig.json` exit 0 (`/tmp/retest-lane-c-tsc-examples-9.log`). An earlier run stopped on `src/native/executors.ts` and two native tests mid-edit (`/tmp/retest-lane-c-typecheck-1.log`).
- `tests/integration/evaluation-ai-sdk.test.ts` under the lock: could not run; its `npm run build` stopped on the same other-lane type errors, 3 failed at packing, 3 skipped (no keys) (`/tmp/retest-lane-c-int-evaluation-ai-sdk-6.log`). Not a result about this lane's code.
- A last full `npm run test:unit` (`/tmp/retest-lane-c-unit-3.log`) hung in `tests/unit/webkit-target-session.test.ts` (WebKit lane, under edit), as two other lanes' runs did at the same time; I stopped my own run after 1360 tests had passed. Its failures before the hang were in agent, native-helper, playwright-resolve, protocol-identity, pool-and-Electron and doctor tests (other lanes), and `diagnostics-run.test.ts`, which passed 9 of 9 alone (`/tmp/retest-lane-c-diag-run-1.log`).

## 3. Artifacts

Logs only, all under /tmp: `retest-lane-c-*.log`, probes in `.retest/scratch-lane-c/` (ignored folder). No screenshots or videos.

## 4. T-19 proposal, and profiles left

Proposal: remove `<tmpdir>/retest-profile-<pid>-<suffix>` only when all hold: a real directory directly in the temporary folder, owned by this user, not a link; its marker a regular file of this user, `{ version: 1, pid, path, startedAt }` with `path` its real path and `pid` the one in its name; the owner gone, by pid plus start time (record `startedAt` in the marker from now on; for a marker without it, only an absent pid counts); no live process naming the folder in its arguments; and the folder renamed to a tombstone name before it is removed. What stays unprovable: a process holding the folder without naming it (a path passed through a file, the environment or IPC), a person or app reusing the folder as storage after its owner died (the reason 9b38691 keeps them), a reused pid within the same start second, other users' processes, and the instant between the check and the rename.

Left in `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T`, deleted none:
- `retest-profile-93028-bRsqi9`, created 00:40, 9.9 MB, owner 93028 not running, no process names it, marker valid, no start time recorded.
- `retest-profile-44402-p3jFFr`, created 03:06, 9.9 MB, owner 44402 not running, no process names it, marker valid, no start time recorded.
- `retest-profile-37855-bN2OB9`, created 12:19:07 by a Retest run my `run-interrupt` run 5 started: the case timed out, the teardown killed that Retest outright, so its exit hook never removed the profile; its Chrome exited when its pipe closed. Owner 37855 not running, no process names it, marker valid. Left, as decided.

## 5. Needed from other lanes

- WebKit lane: `src/browser/webkit/process.ts` `outputWithin` (around 446-455) has the same timer race; the Chromium fix (I/O turns, then judge by open pipes) applies.
- Runner/records: progress.md rows for fixtures, Electron and the Azure provider still claim pre-9b38691 results; the current results are in the four proofs.
- T-14 remainder: `m2-guarantees.test.ts:138` and `reference-flow.test.ts:59` (runner lane).

## 6. Not verified, most important first

1. The T-6 real-browser test against the old code (shown on fakes only).
2. Linux: the bracket rule, `ps -p` with two pids under procps, renderers that retitle themselves.
3. `native-diagnostics-wired.test.ts` after its teardown change (simulator and desktop).
4. A live Azure rerun (no key may be read).
5. The exit-event race in `#ended` (`waitForExit` against a timer) on a starved host; not seen in 8 loaded closes.
6. Whether a background page recording can lose a renderer that starts and outlives a main-process crash within one reading's time.

## 7. Files changed

Source: `src/shared/process-ownership.ts`, `src/shared/metadata-process.ts`, `src/shared/metadata-process-worker.ts`, `src/browser/chromium-process.ts`, `src/browser/browser.ts`, `src/evaluation/ai-sdk.ts`, `src/evaluation/answer.ts`, `src/evaluation/attempt.ts`, `src/evaluation/contract.ts`, `media/src/process_ownership.rs`, `media/src/server.rs`, `fixtures/cross-platform/service/store.ts`, `fixtures/cross-platform/README.md`.
Tests: `media/tests/process.rs`, `tests/unit/process-ownership.test.ts`, `tests/unit/metadata-process.test.ts`, `tests/unit/browser-chromium-process.test.ts`, `tests/unit/evaluation-ai-sdk.test.ts`, `tests/unit/native-processes.test.ts` (one assertion), `tests/integration/{cross-platform-service,electron-web-flow,native-diagnostics-wired,run-interrupt,matrix-lifecycle,session-contract,m3-press,browser-lifecycle}.test.ts`. New: `tests/unit/metadata-stalled-worker.ts`, `tests/unit/cross-platform-store.test.ts`, `tests/integration/service-teardown.ts`, `tests/integration/outside-kill.ts`.
Docs: `docs/guide.md` (two Azure sentences), `docs/plans/public-beta/proofs/{media,fixtures,electron,evaluation}.md`.
No dependency, script or environment change. `src/browser/profiles.ts` unchanged. Another lane also edited `src/browser/browser.ts` meanwhile (a `revision` field); left as is.
