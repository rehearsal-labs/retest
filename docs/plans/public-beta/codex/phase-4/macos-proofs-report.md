# macOS proofs after the covering app was quit

## Scope and current result

The founder quit Wispr Flow and authorized fresh macOS proofs. Every requested TaskDesk check instead stopped before application execution because the existing desktop record lacks `startTimeVersion: 1`. The refusal at `src/native/desktop-lock.ts:181-182` is outside this worker's repair scope and belongs to the native lifecycle/process owner. No successful macOS screenshot, frame source, video or secret-pixel proof was added.

Results below were written after each check, before the next started. Existing work and the two other workers' files are preserved. This worker may fix tests, fixtures, `src/native/capture*` and the macOS frame source. No defect in those allowed files was demonstrated, so none was changed.

| Check | Counts | Exit | Log under `.retest/macos-proofs/logs/` |
| --- | --- | --- | --- |
| Desk public API | 0/2 passed, 2 failed | 1 | `native-api-desk.log` |
| macOS capture | 0/1 passed, 1 cancelled by failed before hook; failed suite | 1 | `capture-macos.log` |
| macOS evidence | 1/5 passed, 4 failed; passing child compares refused setups only | 1 | `evidence-macos.log` |
| Chromium recorded flows | 0/4 passed, 4 failed | 1 | `flow-chromium.log` |
| Firefox recorded flows | 0/4 passed, 4 failed | 1 | `flow-firefox.log` |
| WebKit recorded flows | 0/4 passed, 4 failed | 1 | `flow-webkit.log` |
| macOS lifecycle proof | 1/2 steps passed; only local build lookup | 1 | `proof-lifecycle-macos.log` |
| macOS interaction proof | 1/2 steps passed; only local build lookup | 1 | `proof-interaction-macos.log` |

All test gates have zero skips. Only the capture test has a cancellation. Nested test counts include failed parents. Proof-step counts are separate from test counts. Each actual test/proof command ran once; busy lock submissions started nothing.

All real-target commands use `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock`. The inner guard refuses to start while a benchmark runs. No benchmark, download, commit, stash, reset, revert or window workaround is authorized. No passing requirement may be weakened. Only recorded processes started by these checks may be ended.

Fresh logs and supporting records are under `.retest/macos-proofs/`. The source CLI and installed local binaries are used. Prior proofs are background and are not counted as fresh verification.

## Read and preparation

Read `AGENTS.md`, `README.md`, `docs/architecture.md`, both common-rule files, the supplied evidence, native recording, capture-source and native lifecycle reports, and `proofs/evidence.md` and `proofs/native.md`. Read the release invariants and native/evidence verification requirements. Applied the unslop writing skill. The prior findings distinguish a covering-window refusal from native password withholding and native paint-clock limits.

The initial benchmark guard found no matching benchmark. The tree already contains other workers' changes. No existing change was discarded.

## Check 1, desk public API

Exact command, from the repository root, with stdout and stderr redirected to `.retest/macos-proofs/logs/native-api-desk.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-api-desk python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-desk.test.ts
```

Exit 1. Two tests, zero passed, two failed, zero skipped or cancelled. The retained CLI results have `error`, with all three application tests `not_run/setup_failed`. No application capture was exercised.

Exact refusal:

> Retest cannot confirm the recorded start time zone in the desktop record /Users/dragon/Library/Caches/retest/macos-desktop.json; the record and processes were left alone.

Read the log, both retained `result.json` files and the desktop record. Cause is the required `startTimeVersion === 1` check at `src/native/desktop-lock.ts:181-182`, before runner startup. The existing record names holder PID 31017 and a holder start, but no `startTimeVersion`. It has no xcodebuild entry and empty runner/untied arrays. This is not a covering-window refusal. Native lifecycle/process owner must resolve the legacy record under its ownership rules. This worker did not edit the record or product files outside scope.

Artifacts:

- `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-cVjSik/`, including `events.jsonl` and `result.json`.
- `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-OLhEoh/`, including `events.jsonl` and `result.json`.
- `.retest/macos-proofs/logs/native-api-desk.exit` records exit 1.

## Check 2, macOS capture source

Exact command, with output redirected to `.retest/macos-proofs/logs/capture-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=capture-macos RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs/capture-macos python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-macos.test.ts
```

Exit 1. One test, zero passed, zero failed, one cancelled, zero skipped; one suite failed in its before hook. The before hook throws at `tests/integration/capture-macos.test.ts:67`, from the same desktop-record refusal at `src/native/desktop-lock.ts:182`. The capture test body never ran. The log was read and the saved `.retest/macos-proofs/capture-macos/macos-runtime-logs/` folder was inspected. It contains no runner log, PNG, media report or movie because startup was refused before any runner. The `RETEST_CAPTURE_PROOF_OUT` requirement was met. No successful capture or covering-window refusal occurred. The lifecycle owner handoff above remains the cause; no repair within this worker's scope applies.

## Check 3, macOS evidence target

Exact command, with output redirected to `.retest/macos-proofs/logs/evidence-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=evidence-macos RETEST_EVIDENCE_NATIVE=macos RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs/evidence-macos python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts
```

Exit 1. Five tests including the parent, one passed and four failed, zero skipped or cancelled. Normal/failure screenshot, recording identity/decode and secret-pixel children fail because the application tests are all `not_run/setup_failed`, with the same exact desktop-record refusal above. Recording-off equality passes only for those refused setups. It does not prove normal pass, intended assertion failure or secret input with recording off.

Read the gate log and both saved run folders. `.retest/macos-proofs/evidence-macos/macos-on/` and `macos-off/` retain events, result and reconstructed HTML/terminal reports; `macos-observations/cli-output.json` retains the CLI outcome. No native, browser or media launch, PNG or movie exists in these runs. The source cause remains `src/native/desktop-lock.ts:182`, outside scope. No test or assertion was changed. The actual macOS screenshot, video identity, secret-pixel and successful on/off claims remain unverified.

## Check 4, recorded flow with Chromium

Exact command, with output redirected to `.retest/macos-proofs/logs/flow-chromium.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-chromium RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs/flow-chromium python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1. Four tests including two parents, zero passed and four failed, zero skipped or cancelled. Both retained application results are `error`, CLI 2, `not_run/setup_failed`, with the same desktop-record refusal. Each has zero application assertions, recordings or PNGs. Their simulator, runner, TaskDesk and browser disappearance checks completed. No cleanup failure or lease expiry is recorded. Chrome 154.0.8037.98 launched during preparation, but no browser application action ran. Missing required three-app recordings fails at `tests/integration/evidence-flows.test.ts:210`; normal outcome fails at `:341`, and broken-sync exit fails at `:375`. The source cause remains `src/native/desktop-lock.ts:182`, for the lifecycle owner.

Read both saved results and event logs. Retained roots are `.retest/macos-proofs/flow-chromium/chromium-recorded/` and `chromium-broken-sync-recorded/`, with reports and separate approved-observation folders. Cache copies are named in the gate log, including normal `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/chromium/run-paJhRO/`. This check proves neither intended application outcome nor desk movie, identity or stale-state pixels. No assertion was changed.

## Check 5, recorded flow with Firefox

Exact command, with output redirected to `.retest/macos-proofs/logs/flow-firefox.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-firefox RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs/flow-firefox python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1. Four tests, zero passed and four failed, zero skipped or cancelled. Read both saved results and event logs. Both normal and broken-sync are `error`, CLI 2, `not_run/setup_failed`, with the same exact desktop-record refusal. Zero application assertions, recordings or PNGs. Their simulator, runner, TaskDesk and Firefox disappearance checks completed; no cleanup failure or lease expiry is recorded. Firefox 133.0.3, build 20241209150345, launched during preparation through `launch-services`. Its launch route is recorded in the log. Failure sites are the unchanged required recordings at fixture `:210`, normal verdict `:341` and broken-sync exit `:375`; source cause `src/native/desktop-lock.ts:182` remains the lifecycle owner's.

Retained roots `.retest/macos-proofs/flow-firefox/firefox-recorded/` and `firefox-broken-sync-recorded/` hold results, events and HTML/terminal reports, with separate observation folders. Cache copies `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/firefox/run-9Fg4Ok/` and the broken-sync copy named in the log hold the service network records. Intended outcomes, desk video/identity and stale-state pixels are unverified. No assertion was changed.

## Check 6, recorded flow with WebKit

Two submissions acquired no lock and started no test. Each exit 75, exact output `lockf: /tmp/retest-heavy-gate.lock: already locked`. Saved separately as `.retest/macos-proofs/logs/flow-webkit-lock-busy-1.log` and `flow-webkit-lock-busy-2.log`, each with a matching `.exit`. The command below is retried only after the required lock wait. No other heavy command is queued.

The next submission acquired the lock and ran each scenario once. Exact command, with output redirected to `.retest/macos-proofs/logs/flow-webkit.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-webkit RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs/flow-webkit python3 .retest/macos-proofs/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1. Four tests, zero passed and four failed, zero skipped or cancelled. Read both saved results and event logs. Both normal and broken-sync are `error`, CLI 2, `not_run/setup_failed`, with the same exact desktop-record refusal. Zero application assertions, recordings or PNGs. Simulator, runner, TaskDesk and WebKit disappearance checks completed; no cleanup failure or lease expiry is recorded. WebKit 626.1.6+, build 2359, launched during preparation. Failure sites remain the unchanged recordings requirement at `tests/integration/evidence-flows.test.ts:210`, normal verdict `:341` and broken-sync exit `:375`; source cause `src/native/desktop-lock.ts:182` is outside this worker's scope.

Retained roots `.retest/macos-proofs/flow-webkit/webkit-recorded/` and `webkit-broken-sync-recorded/` hold results, events and HTML/terminal reports, with separate observation folders. Cache copies are named in the gate log, including normal `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/webkit/run-GLsc2C/`. Intended outcomes, desk video/identity and stale-state pixels remain unverified. No assertion was changed.

## Check 7, macOS lifecycle proof

The native record still lacks a successful TaskDesk window capture under the coverage check. Rerun the macOS portion only, using the proof's implemented `--only macos`. The post-restart lifecycle report already records the separate TextEdit Phase 1 proof at 25/25; that record does not require another TextEdit run. Its existing successful capture is not substituted for TaskDesk evidence.

The first lifecycle submission found the shared lock busy, exit 75, and started no proof. Exact output `lockf: /tmp/retest-heavy-gate.lock: already locked`, saved as `.retest/macos-proofs/logs/proof-lifecycle-macos-lock-busy-1.log` and matching `.exit`. Wait for the required retry interval; no other heavy command is queued.

The next submission ran the proof once. Exact command, with output redirected to `.retest/macos-proofs/logs/proof-lifecycle-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=proof-lifecycle-macos python3 .retest/macos-proofs/inside.py node --conditions=retest-source proofs/native/lifecycle.ts --only macos
```

Exit 1. One of two proof steps passed. The pinned macOS executor was reused from the adopted local build; desktop startup failed with the same exact refusal from `src/native/desktop-lock.ts:182`. Read the log and `/Users/dragon/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-06T11-44-39Z/report.json`. No runner, TaskDesk capture or PNG was started. The capture and lifecycle outcomes remain unverified. No proof requirement or product code changed.

## Check 8, macOS interaction proof

The interaction record's before-click and found-task PNGs were previously refused by coverage. Its macOS portion ran once through the shared lock. Exact command, with output redirected to `.retest/macos-proofs/logs/proof-interaction-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=proof-interaction-macos python3 .retest/macos-proofs/inside.py node --conditions=retest-source proofs/native/interaction.ts --only macos
```

Exit 1. One of two proof steps passed. The pinned executor build was reused, then desktop startup was refused by the same marker check at `src/native/desktop-lock.ts:182`. Read the log and `/Users/dragon/Library/Caches/retest-proofs/artifacts/interaction/2026-10-06T11-44-51Z/report.json`. Its artifact array is empty; no input, before-click PNG or found-task PNG ran. The lifecycle owner handoff applies; no authorized test/fixture or capture-code repair addresses this cause.

## Cleanup and final record checks

The interim process audit after the three flow gates found all 38 recorded readings absent, with no signals sent. The final process audit includes the two proof scripts and found all 40 readings absent. No requested test or proof is queued for a rerun.

Five submissions of an extra native audit found the shared lock busy, each exit 75, and started no audit. Saved `.retest/macos-proofs/logs/native-audit-lock-busy-{1,2,3,4,5}.log`, each with matching `.exit`. Exact submitted command:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-audit python3 .retest/macos-proofs/inside.py node --conditions=retest-source .retest/macos-proofs/native-audit.ts
```

No independent native-audit result is claimed. This additional query is not queued again. The six completed flow scenarios already passed their before/after simulator inventory, owned-device deletion, TaskDesk, runner, xcodebuild and browser disappearance assertions under the lock. The API checks also passed TaskDesk disappearance before their verdict failures. The capture and two proof scripts refused startup before any macOS runner. No media or ffmpeg process was started by these checks.

`python3 .retest/macos-proofs/verify-records.py` exited 0. Log `.retest/macos-proofs/logs/verify-records.log`, facts `.retest/macos-proofs/verification.json`. It cross-checks counts and exits in all six test logs, all ten retained CLI results and event logs, both proof reports, zero application assertions/recordings, zero PNG/movie files and eight successful benchmark guards. It does not rerun an application or relax a test.

`python3 .retest/macos-proofs/process-audit.py` exited 0. Log `.retest/macos-proofs/logs/process-audit.log`, facts `.retest/macos-proofs/process-audit.json`. All 40 recorded readings were absent; no reused PID, unreadable identity or remaining recorded process was found. No signals were sent. `.retest/macos-proofs/processes.jsonl` records the locked command roots; `observed-processes.jsonl` records descendants with C-locale UTC0 starts and commands. Earlier root readings retain their inherited-zone method; no signal depends on converting them. The tests' own process ledgers handled their cleanup. No process, app, simulator or window was manually ended or moved by this worker.

`git diff --check -- docs/plans/public-beta/proofs/evidence.md docs/plans/public-beta/codex/phase-4/capture-sources-report.md docs/plans/public-beta/codex/phase-4/macos-proofs-report.md` exited 0. The final whitespace and artifact inventory check also includes the untracked Markdown files.

## Artifacts and PNG paths

Primary retained run roots and proof reports are listed with each check. The flow service/network cache copies, all under `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/`, are:

| Scenario | Cache path |
| --- | --- |
| Chromium normal | `chromium/run-paJhRO/` |
| Chromium broken-sync | `chromium-broken-sync/run-PFBX7r/` |
| Firefox normal | `firefox/run-9Fg4Ok/` |
| Firefox broken-sync | `firefox-broken-sync/run-NmNmao/` |
| WebKit normal | `webkit/run-GLsc2C/` |
| WebKit broken-sync | `webkit-broken-sync/run-3tsbFv/` |

Fresh PNG paths are none. The normal-pass screenshot, expected-failure screenshot, raw macOS capture frames, lifecycle TaskDesk capture, and interaction before-click/found-task captures were never produced. The before hook or native setup stopped before each capture. There are no fresh desk movies, decoded frames or thumbnails. Historical PNGs were not substituted, and no screenshot was fabricated to fill the brief.

## Owner handoff and unverified work

1. Native lifecycle/process owner must resolve `/Users/dragon/Library/Caches/retest/macos-desktop.json` under its ownership rules. The existing record lacks the version marker required by `src/native/desktop-lock.ts:181-182`. It names no xcodebuild and has empty runner/untied arrays, yet the missing marker refuses every desktop start before those facts can permit work. The record and its holder PID were left alone. This worker's allowed tests/fixtures and capture-source files cannot repair that policy or migrate the record.
2. Successful macOS public API execution, full owned-window capture, input during capture, source-to-video strict matching, screenshot/video identity and finalization, actual secret-pixel withholding, and successful application on/off equality remain unverified. All fresh checks were refused setup, not covering-window capture. No covering window was identified or manipulated in this run.
3. All six intended recorded flow outcomes, desk videos and final stale/correct task-state pixels remain unverified in this run. The earlier native fix report's successful text outcomes and phone/web decodes are retained separately. Removing the record blocker alone will not resolve the separately documented native password-withholding or native paint-clock limits.
4. The extra final native inventory query never acquired the lock. Cleanup evidence is the completed integration disappearance assertions and the final 40-reading process audit. Whole-tree units, typechecks, installed-package execution, other Macs and physical devices were not run here.

Existing files changed by this worker are `docs/plans/public-beta/proofs/evidence.md` and `docs/plans/public-beta/codex/phase-4/capture-sources-report.md`. Added this report and ignored scratch guards, observation/audit/verification scripts, logs and records under `.retest/macos-proofs/`. No test, fixture, product source, package, ownership or lock record was changed. No benchmark, download, git mutation, publication or permission prompt occurred.
