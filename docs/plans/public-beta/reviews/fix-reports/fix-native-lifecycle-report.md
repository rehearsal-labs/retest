# Fix lane B: native lifecycle and processes

Every fix has a test that fails on the code at HEAD and passes now. "Before" runs used a copy of the tree with my native sources put back to HEAD (`/tmp/retest-lane-b/before/`); logs `/tmp/retest-lane-b/before-native-*.log`.

## Findings

- **N-33 + T-2.** Records carry the start reading; every native kill and ownership decision goes through `sameProcessIdentity`. `src/native/processes.ts:708` `recordedIdentity`, `:739` `endRecorded`, `:815` `killRecordedNow`, `:668` `commandOf`, `:644` `listProcesses`; `src/native/session.ts:478` `#owns`; desktop record `src/native/desktop-lock.ts:300-345`; `src/native/ios-simulator.ts:545`; `proofs/native/macos/mac2.ts` (recordedState). An exiting `(TaskDesk)` reading is the recorded process, never `other`; a record without a start leaves it unreadable. Failing first: "an app ps shows by its short name while it exits is still the recorded process", "a record without a start leaves a process ps shows by its short name undecided", "a pid another process took under the identical command line is left alone", "an exit-hook kill leaves a pid another process took…", "every process listed carries its start" (`native-processes.test.ts`); "a terminate waits while the app it launched still shows by its short name", "a process under a recorded pid with another start is not the session's" (`native-session.test.ts`); "a recorded runner app whose pid another process took…", "a process a record names without a start is never ended" (`native-desktop-lock.test.ts`). All fail on HEAD, pass now.
- **N-9.** Ownership readings no longer block the main thread: a table reading per synchronous step through the shared `readMetadataProcessAsync`, descendant watch every 2 s via `captureAsync` (was 100 ms, synchronous), one-pid `readProcess` right before each signal. `src/native/processes.ts:367-574`. Failing first: "a short command takes its ownership readings without blocking the main thread", "a long-running process takes no blocking ownership reading while it runs". Kept guarantee: "a child the executor starts after its own start is still found and ended at the stop" (passes before and after). Event loop with one owned process, 2 s: old 119-137 ticks of 10 ms, p99 39-43 ms; new 195 ticks, p99 1.5-2.1 ms (no process: 195 ticks, p99 1.4-1.9 ms). Ten `commandOf` in a row: old p99 35-40 ms, new 1.7-1.9 ms, per reading 65 vs 76 ms. Logs `/tmp/retest-lane-b/event-loop.log`, `event-loop-final.log`, `command-of.log`.
- **N-11.** Run folders name their maker (pid + start) in `retest-owner.json` (`src/native/temporary-folders.ts`, new); each start sweeps `retest-executor-*`, `retest-macos-*`, `retest-ios-*` whose maker is gone (`executor-process.ts:92`); a folder is deleted at close after a bounded wait even while unowned members remain, and by the exit hook whatever remains (`processes.ts:217`, `:288`). Failing first: "the temporary output is deleted once the process closed, even while an unowned member…", "the exit hook deletes the temporary output even while members of the group remain" (`native-processes.test.ts`), "a start deletes the run folders a gone Retest process left…" (`native-macos-app.test.ts`); sweep tests ("a sweep deletes… keeps every other", "keeps a folder whose maker cannot be read") are new-only. Stale folders on this Mac: 120 deleted whose maker is shown gone (made before the oldest running JavaScript runtime started, named by no running command; `/tmp/retest-lane-b/legacy-folders.ts`), 187 left. **Killed run** (real iOS, marker typed into TaskPhone, SIGKILL): the staged result bundle holds the whole typed value, not only the prefix: `Session-WebDriverAgentRunner-….log` in `result.xcresult/Staging/1_Test/Diagnostics/` has `Type string '<whole value>'` beside `Type '<first 12>…'`. Nothing in the simulator folder or `~/Library/Logs`. Record `/tmp/retest-lane-b/killed-run/`.
- **N-12.** A clean close leaves the record naming nothing (`desktop-lock.ts:103` `clear`, `macos-app.ts:307`); a record still naming processes is recovered only once its holder is gone by pid + start (`desktop-lock.ts:282`), group presence read only then. Failing first: "a holder clears its record once everything it named ended", "a record whose holder still runs is refused whole", "a desktop closed cleanly leaves its record naming nothing of its runner".
- **N-13.** Sweep stays report-only; report names `xcrun simctl delete <udid>` (`ios-simulator.ts:235-250`); comment and record fixed. Failing first: "the sweep reports an orphan name without claiming or deleting its device" (strengthened). Seen on the real simulator after the killed run.
- **N-17.** Menu text decoded and redacted with the session's redactor before hashing (`source-scope.ts:14`, `:77`, `:97`; `session.ts` passes `redact` to `driver.source`). Failing first: "menu text is decoded and redacted before it is hashed…", "a tree is read with the session's redactor…".
- **N-18.** Both paragraphs of `docs/plans/public-beta/proofs/native.md` rewritten to the current rules (no group signal; recovery by pid + start, holder check, group refusal naming the record).
- **N-19, my side.** `NativeAppSession` refuses references and requests once cancelled; read-only facts **`cancelled`** and **`ended`** (`session.ts:202`, `:207`, `:371`). Failing first: "a cancelled session refuses its references and every new request…", "a lost session says it has ended".
- **N-27.** Lifecycle tests end the app and runner apps through `endRecorded` with recorded pid + start + command (`tests/integration/native-ios-lifecycle.test.ts`, `native-macos-lifecycle.test.ts`). Test-only change; no product test to fail first.
- **N-30.** macOS logged app spawned detached with an exit hook until stopped (`logs.ts:160`, `:166`); iOS console launcher ended on a failed reconciliation (`logs.ts:241`). Failing first: both tests in `tests/unit/native-logs.test.ts` (new file).
- **N-32.** Build lock is the `lockf` kernel lock (`executors.ts:602`, using `holdKernelLock`/`endHolder` exported from `desktop-lock.ts:214`, `:243`). Failing first: "a build another live process holds is refused; a lock its dead holder left is taken over" (rewritten for a real lock holder), "a build lock whose file is still empty… is never taken over".
- **N-34.** Exercised on the real simulator: a certificate added with `simctl keychain add-cert` took the first simulator's keychain from 0 to 1 certificate; the second runtime's held 0. Contract stays `keychain: 'reset'`. Test: "nothing the app wrote in one runtime is there in the next, and its keychain starts empty" (`native-ios-lifecycle.test.ts`); passed 9 of 9 on the real simulator before the process table filled.
- **R-4.** Shape `{ ok: false; failure: Failure; idle?: true }`. Carries `idle: true`: `macos-app.ts:103` wrong platform, `:104` wrong executor, `:105` this process already runs the runner, `:121` Xcode check, `:123` Automation Mode, `:146` refusals after the lock but before xcodebuild starts (another runner present, sw_vers unreadable, executor refusals before spawn) only when the lock was let go; `desktop-lock.ts:167` another Retest process holds the desktop, `:382` every other refusal holding no lock (this process holds it, lockf failure, refusals after a confirmed release); `executor-process.ts:234` refusals before xcodebuild starts; `ios-simulator.ts:288` platform, `:289` executor, `:292` Xcode, `:294` missing or untested runtime or device type, `:296` app bundle, `:298` orphan simulator, `:303` folder, `:313` a create that never ran with nothing to clean. Never after xcodebuild or a create may have started. Runner lane passes it through (`src/runner/native-pool.ts:448`, `:452`). Failing first: "a desktop start refused before its runner was started says it left nothing behind", "an iOS start refused before any simulator could exist…", "a refusal because another process holds the desktop says it left nothing behind"; negatives "…whose runner was started never says…", "…that created its simulator never says…".

Also found and fixed: `/usr/bin/xcodebuild` (xcode-select's shim) execs the selected Xcode's tool under the same pid, so `ps` showed another command line after the start and the record no longer matched; starts now run the tool `xcrun --find` names (`executor-process.ts:209`). Test: "a start runs the selected Xcode's own xcodebuild…" plus a check in the iOS lifecycle test.

Changed existing assertions, each to the new rule: `native-processes.test.ts` "a recorded descendant whose live command changed…" now asserts the temporary output is deleted while the changed descendant remains (N-11 reverses the old rule); "a long-running process stops…" unchanged; `processesRemain` is now an async method. Test fixtures moved to the start-reading format (scripted `ps` lines, records). No test title removed.

## For other lanes

- src/shared: export `unreadableCommand` (I derive it through `sameProcessIdentity`, `processes.ts` `commandUnreadable`). The 4 MiB metadata output limit is reached on this Mac now (table 4.53 MB, about 3,600 processes): every ownership reading fails until the table shrinks.
- Records built without `startedAt` (matched by exact command only): `tests/integration/native-diagnostics.test.ts:44`, `tests/integration/native-evaluation.test.ts:44`, fakes in `tests/unit/runner-native-diagnostics.test.ts:109,160,263`, `tests/unit/native-interaction-fake.ts:537`. Once they pass `startedAt`, `RecordedProcess.startedAt` can become required.
- This Mac: no macOS runner starts. launchd removed `com.apple.secinitd` (user and system domains) at 07:59:56 today after errno 23 (file table full); every sandboxed launch fails. A restart should clear it; not tried.

## Gates

None ran before the Mac's restart: the process table was full and macOS had dropped the sandbox service. Every gate ran after the restart; see "After the restart" below.

## Not verified, most important first

1. Every macOS real-target gate (macOS lifecycle integration, the macOS halves of the lifecycle proof, the Phase 1 macOS proof): waiting for the Mac's restart. The desktop-lock clearing, the detached logged app and the runner-start changes ran on fakes and real `lockf` only.
2. N-11's sweep on a real start: by the time my cleanup's sweep ran, the killed run's folder was already gone (it removed nothing). What deleted it is not established; another lane's native start, whose sweep would delete it, is the likely one. The sweep's rules ran in unit tests with real processes.
3. The killed-run finding is for iOS; whether the macOS runner's bundle holds typed text likewise was not looked at (the runner cannot start).
4. A keychain item an app writes itself on iOS; only a `simctl` certificate was used.

## After the restart

The work of the round above was already in the tree. This part covers the machine checks, the runner-abort cause, the 4 MiB table limit, the gates that had not run, and what those runs found. Logs are under `/tmp/retest-lane-b/after-restart/`.

### The machine

- `automationmodetool`: "This device DOES NOT REQUIRE user authentication to enable Automation Mode."
- A sandboxed app starts. Calculator, opened through Launch Services, logged the `libsystem_secinit` "AppSandbox" activity. I ended it by its recorded pid and start. An earlier try ran its binary directly as a child; AMFI's launch constraint for system apps refused that, which is unrelated to the sandbox. That try left two Calculator crash reports in `~/Library/Logs/DiagnosticReports`.
- The simulator boots. I created a throwaway iPhone 17 on iOS 26.5; it reached the home screen (`/tmp/retest-lane-b/boot-check.png`), and I shut it down and deleted it.
- `com.apple.secinitd` is registered again in the user and system domains.

### Why the macOS runner aborted at start

It no longer aborts: the macOS lifecycle test passed 7 of 7 at the first try after the restart. The cause was outside Retest. launchd had dropped `com.apple.secinitd`, the service that sets up each sandboxed process's App Sandbox. The macOS runner `WebDriverAgentRunner-Runner.app` carries `com.apple.security.app-sandbox`, so with the service gone it died at start. Evidence:
- loginwindow keeps every check-in and death of the runner app (`runner-checkins.txt`). The 17 starts before launchd dropped the service at 07:59:56 lived 8.8 s to 110 s. All 10 starts from 11:27 to 13:26 died 63 to 272 ms after checking in. The first start after the restart lived through the whole test.
- launchd's own log (`/private/var/log/com.apple.xpc.launchd/launchd.log.2`, the oldest kept, from 19:17) has 132 lines "failed lookup: name = com.apple.secinitd … error = 3: No such process" from sandboxed processes before the restart. The two files written since have none.
- After the restart, the system log shows "secinitd: WebDriverAgentRunner-Runner[50720]: AppSandbox request successful".
- The runner's own lines from the failed starts were not kept, and no crash report was written. I did not reproduce the failure, since that would mean stopping a system service. No Retest change.

### The 4 MiB process-table limit

The shared reader gave every query one 4 MiB output buffer, so a whole `ps -ww` table over 4 MiB failed every ownership reading. With about 3,600 processes it was 4.53 MB.
- `src/shared/metadata-process.ts`:
  - each query now carries its own bound (`outputLimit`, from 4 MiB up to the new `processTableOutputLimit`, 64 MiB);
  - the shared buffer is sized to that bound, and macOS commits its pages only as they are written;
  - `answer` checks the length against the query's own buffer.
- `src/shared/metadata-process-worker.ts` measures against the buffer it was handed.
- `src/shared/process-ownership.ts` (the whole table, sync and async) and `src/native/processes.ts` (`ProcessTable.read`, `readProcessTable`) ask for the table bound. One-pid readings keep 4 MiB.
- Columns, the one snapshot and the one-pid reading right before each signal are unchanged. A table past 64 MiB still fails as unreadable, with the same message, which the Firefox reader's fallback matches. It is never cut.
- Also `src/native/processes.ts` `listProcesses`: `runCommand` keeps at most 16 MiB of output. A list cut there could end inside a line and read as a shorter command, so a list that long is now refused.
- Tests:
  - `tests/unit/metadata-process.test.ts` "a whole process table larger than a short reading may print is read whole under the table bound…" uses a stand-in table of 5,000 processes, 6.3 MB.
  - `tests/unit/native-processes.test.ts` "ownership readings take a whole process table larger than 4 MiB, and still read a pid again before signalling it" starts sleeps with 200 KB names until the real table is over 5 MiB. It reads it through the native and the shared readers, records one launch with the shared rule's own host and signals it.
  - "a process list longer than a command's output limit is refused…" covers the cut list.
  - Kept guarantee, passes before and after: "a short reading keeps its 4 MiB bound, a bound past the table bound is refused, and a table past its bound fails rather than being cut".
  - Fix toggled off in a scratch copy: all three fail. The first two fail with "The metadata process exceeded its output limit.", the third with "Missing expected rejection" (`before-metadata.log`, `before-table.log`). With the fix on, they pass (`unit-metadata-1.log`, `unit-table-1.log`).

### Found by the runs

1. **A system banner on a new simulator.** A short while after boot, an iOS 26.5 simulator posts "Ready for Apple Intelligence". While it shows, WebDriverAgent serves SpringBoard's tree, and the session refuses it as another app's, which is correct. The lifecycle proof's tree step read once and failed (`proof-lifecycle-1.log`; the capture before it shows the banner). Its macOS half never ran.
   - Fixed in `proofs/native/lifecycle.ts` (`keepTree`) and `tests/integration/native-ios-lifecycle.test.ts` (`ownTree`). Both look again within the same budget, and only while the refusal says the tree is another app's. What passes is unchanged.
   - Rerun: the proof passed 19 of 19, with the iOS tree on look 6. The iOS test passed 9 of 9.
   - Retest's own waits already look again (`readTreeSteadily`).
2. **Desk API test, 1 of 2.** A window of a dictation app the user runs lay over TaskDesk's window in every capture today: layer 1000, 512×614 at 608,445, over TaskDesk's fixed frame 20,60,700,480. The coverage check refused each capture, correctly. The lifecycle tests and proofs accept a refusal that names the window. "TaskDesk public API: find a task by id…" requires a capture and fails. The cause is the desktop, not code. That file is the runner lane's.
3. **N-11's sweep on a real start, now seen.** I planted two run folders before a real iOS start. The one whose recorded maker was a process I had started and ended was deleted. The one whose maker is launchd (pid 1, only read) was kept, and I removed it afterwards. After the restart, no older `retest-executor-*`, `retest-macos-*` or `retest-ios-*` folder was left in the temporary folder. The 187 folders without an owner record that the earlier pass left are gone. The sweep keeps such folders, so something else removed them; the restart is likely, not established.

### Gates after the restart

Each heavy gate ran as `lockf -t 0 /tmp/retest-heavy-gate.lock <command>`. A busy lock was retried every sixty seconds, after checking that no benchmark ran (`/tmp/retest-lane-b/gate.sh`). Real-target runs:

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/integration/native-macos-lifecycle.test.ts` | 7 of 7 before the table change, 7 of 7 after; capture refused by the dictation window both times | `integration-macos-lifecycle-1.log`, `-2.log` |
| `node --conditions=retest-source --test tests/integration/native-ios-lifecycle.test.ts` | 9 of 9 (keychain test included), then 9 of 9 with `ownTree` | `integration-ios-lifecycle-1.log`, `-2.log` |
| `node --conditions=retest-source proofs/native/lifecycle.ts` | 7 of 8, stopped at the iOS tree (banner); after the fix 19 of 19, both halves | `proof-lifecycle-1.log`, `-2.log` |
| `node --conditions=retest-source --test tests/integration/native-interaction.test.ts` | 11 of 11, iOS and macOS; TaskDesk's secure field read back `length_matched`; typed lengths 160/160/160 and 120/120/120 | `integration-interaction-1.log` |
| `node --conditions=retest-source proofs/native/interaction.ts` | 19 of 19, iOS and macOS; no password in the report | `proof-interaction-1.log` |
| `node --conditions=retest-source proofs/native/macos/run.ts` | 25 of 25, unattended; nothing left | `proof-macos-phase-1-1.log` |
| `node --conditions=retest-source --test tests/integration/reference-flow.test.ts` | 2 of 2: the flow passes, and the broken-sync variant fails at the desk state check as the test requires | `integration-reference-flow-1.log` |
| `node --conditions=retest-source --test tests/integration/native-api-desk.test.ts` | 1 of 2 (finding 2 above); the desk-with-web lease test passes | `integration-api-desk-1.log` |

Typechecks and unit tests:

| Command | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | exit 2; TypeScript 6 errors only in `fixtures/evaluation-corpus/runner/score.ts`, `src/evaluation/frames.ts`, `tests/unit/evaluation-frames.test.ts` | `typecheck-1.log` |
| `node_modules/typescript-7/bin/tsc -p tsconfig.json` | exit 1; 6 errors, only in those files and `src/browser/firefox/accessible-names.ts` | `typecheck-ts7-1.log` |
| `npm run typecheck:proofs` | clean on both compilers, after the proof change | `typecheck-proofs-1.log` |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` (no lock) | 351 of 351 before the change, 353 of 353 after | `unit-native-1.log`, `-2.log` |
| the shared reader's users: `metadata-process`, `process-ownership`, `firefox-process-table`, `firefox-orphans`, `firefox-process`, `firefox-spawn`, `browser-chromium-process`, `media-capture`, `webkit-process`, `webkit-sweep`, `webkit-browser` | 137 of 137 | `unit-shared-readers-1.log` |
| `npm run test:types` | fails only on `src/evaluation/frames.ts:97`, on both compilers | `test-types-1.log`, `-2.log` |

### Other lanes

- `src/evaluation/frames.ts`, `tests/unit/evaluation-frames.test.ts`, `fixtures/evaluation-corpus/runner/score.ts`, `src/browser/firefox/accessible-names.ts`: the type errors above, which keep `npm run typecheck` and `test:types` from a clean exit.
- An orphaned unit-test process, pid 36744, `node … tests/unit/diagnostics-engines.test.ts`. Its parent is 1 and its group leader 35594 is gone. It has run since 21:20:36. It is not from a run of mine, so I left it alone.
- `tests/integration/native-api-desk.test.ts`: passes only on a desktop where nothing lies over TaskDesk's window.

### Not verified, most important first

1. A window capture that passes on the real desktop, the capture-pass branch of the macOS tests and the desk API assertion. The dictation app's window covered TaskDesk in every run.
2. Whether a killed macOS run's result bundle holds typed text. Not looked at; the iOS finding above stands.
3. The runner-abort cause rests on persisted logs, not on reproducing the failure.
4. A keychain item the app writes itself on iOS. The keychain test uses a `simctl` certificate.
5. A clean exit of `npm run typecheck` and `npm run test:types`, which other lanes' files block.

### Files changed after the restart

- `src/shared/metadata-process.ts`, `src/shared/metadata-process-worker.ts`, `src/shared/process-ownership.ts`: the per-query bound, the one change this lane may make there.
- `src/native/processes.ts`: the table bound, and the refused cut list.
- `tests/unit/metadata-process.test.ts`, `tests/unit/native-processes.test.ts`: the new tests.
- `proofs/native/lifecycle.ts`, `tests/integration/native-ios-lifecycle.test.ts`: the look-again tree read.
- This report.

No dependency, script or environment change. What I started has ended: no simulator, runner, xcodebuild, TaskDesk, TaskPhone or TextEdit is left, and the desktop record names nothing. My scratch copy is deleted.
