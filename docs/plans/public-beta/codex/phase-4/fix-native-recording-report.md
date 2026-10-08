# Native recording fixes

## Result

Implemented the native recording delegation, bounded source look-again and a separate proof for cleaned failed starts. The unchanged iOS evidence suite passes 5/5. Recording on/off both return passed/check_failed/passed and CLI 1. The third recording-off boot completes; the historical ownership-metadata timeout did not reproduce and is not claimed repaired.

All three recorded flow engines reach the intended application outcomes. Normal passes with CLI 0; broken-sync fails at the desk's stale Open-versus-Done check with CLI 1, then stops. There is no lease expiry or cleanup failure in these six runs. Each evidence gate remains failing at 4/10 because Wispr Flow covers TaskDesk and the capture check refuses its pixels. Desk videos are not exercised. Native task checks also sit inside preserved password-withholding intervals, so complete state pixels remain unverified.

| Gate | Result | Log under `.retest/fix-native-recording/` |
| --- | --- | --- |
| Broader native/resource units | 210/210, exit 0 | `logs/owned-units-final.log` |
| Final source/session checks | 52/52, exit 0 | `logs/source-final.log` |
| Final typed frame-hook checks | 2/2, exit 0 | `logs/frame-hook-typed-final.log` |
| Unchanged iOS evidence, on and off | 5/5, exit 0 | `logs/ios-fixed.log` |
| Chrome flow, normal and broken-sync | 4/10, exit 1 | `logs/flow-chrome.log` |
| Firefox flow, normal and broken-sync | 4/10, exit 1 | `logs/flow-firefox.log` |
| WebKit flow, normal and broken-sync | 4/10, exit 1 | `logs/flow-webkit.log` |
| Proof type checks, eight invocations | Exit 0 | `logs/typecheck-proofs.log` |
| Full typecheck after reporter owner correction | Exit 0, all three invocations | `logs/typecheck-settled.log` |
| Native cleanup audit | 18 owned simulators absent, no TaskDesk, exit 0 | `logs/native-audit.log` |
| Final recorded-process audit | 167/167 absent, exit 0 | `logs/process-audit-final.log` |

Counts in different unit rows overlap. All test gates have zero skips and cancellations. The finding sections retain the step record, including earlier pending states, failed checks and superseded implementations. Unless a path is expanded, log and artifact paths below are relative to `.retest/fix-native-recording/` at the repository root.

## Scope

Assigned findings 1, 2 and 5. Existing work is preserved. The other builder's media colour, human reporter and pixel-artifact files are untouched. No benchmark, download or git mutation is run. All simulator, desktop, browser and compiler gates use `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock`, with the benchmark guard checked before tests. Logs and fresh artifacts go under `.retest/fix-native-recording/`.

Read README, architecture, repository instructions, both common-rule files, the evidence report's findings and native/flow step records, evidence proof, capture-sources and recording-runner reports, and the progress stop point. Prior evidence is background; it is not counted as this builder's verification.

## Finding 1, native frame source

Inspection confirms `NativePageAdapter` delegates capture and screenshots but omits `frameSource(identity)`. Both native session layers already expose that unchanged hook. `AttemptRecorder` records `no_frame_source` when the adapter has no hook. A failing-first adapter regression and the unchanged iOS evidence gate are pending. Native movies and secret-pixel video checks are unverified.

Failing-first command `node --conditions=retest-source --test --test-name-pattern='delegates a fresh native recording source' tests/unit/runner-native-wiring.test.ts` ran after `pgrep -f 'benchmarks/[r]un.ts'` found no benchmark. Both platform cases failed, 0/2, test exit 1, no skips or cancellations. Each fails because the page hook is `undefined` instead of a function. Log `.retest/fix-native-recording/logs/frame-hook-failing-first.log`. The added cases require exact identity delegation, the exact source object, a fresh source per call and no input/capture from opening the hook.

`NativePageAdapter.frameSource` now delegates directly to the native interaction session. No contract or scope/pixel policy changed. `node --conditions=retest-source --test tests/unit/runner-native-wiring.test.ts` passed 15/15, exit 0, no skips or cancellations, log `logs/frame-hook-fixed.log`. The unchanged iOS evidence gate was submitted through the shared lock with a fresh `ios-first/` output folder; results pending.

Final test review caught an ineffective no-input predicate in the added hook case: executor routes are full method/path strings. The test now requires the total request count to remain unchanged while opening/checking both sources. This strengthens the new assertion without altering existing tests or product behavior. The same focused hook command passed 2/2, exit 0, no skips/cancellations, `logs/frame-hook-final.log`.

First locked iOS on-run produced three actual simulator-display screenshot-loop movies with matching recording identity, with 99, 142 and 15 output frames. Ready passed and wrong failed with `check_failed`; both screenshot checks passed. The secret test stopped at its initial another-app tree read before input. This CLI loaded the source code before the look-again fix. Its unchanged video/secret children fail on that application refusal, so complete iOS evidence is not claimed. Artifacts `ios-first/ios-simulator-on/` and `ios-first/ios-simulator-observations/`; off comparison remains active under the same lock.

First iOS gate completed exit 1, 1/5 passed, 4 failed, no skips or cancellations, `logs/ios-first.log`. Recording-off's fresh CLI loaded the look-again fix and returned passed/check_failed/passed, CLI 1, with no cleanup failures or media starts. Equality correctly failed against the earlier on-run's refused secret test. The original bootstatus metadata failure did not reproduce in these six real sessions. A fresh `ios-fixed` gate runs both modes against the same current source. The evidence tests are unchanged.

Exact iOS gate commands, from the repository root:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py env RETEST_EVIDENCE_NATIVE=ios-simulator RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-native-recording/ios-first node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py env RETEST_EVIDENCE_NATIVE=ios-simulator RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-native-recording/ios-fixed node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts
```

Each command redirects stdout and stderr to the corresponding `logs/<gate>.log`. The inner guard checks `pgrep -f 'benchmarks/[r]un.ts'`, records its PID/start/command in `processes.jsonl`, and starts the command only after the lock is acquired.

## Finding 2, native trees and lease

Chrome's normal flow now reaches the final desk Done check and passes, CLI 0, with 20 assertions. Phone and web videos independently decode, with 347 and 379 output frames and matching identity. Desk recording is unavailable because of the existing covering window, not a source-scope or action failure. Exact retained refusal: "The first window-crop capture failed: 1 window(s) of other processes lie over the app's window (layer 1000), so a capture would hold their pixels. Retest captures the window only when nothing lies over it." Desk video and complete final state pixels are not exercised. Wispr Flow remains untouched. The evidence suite correctly fails the desk video child; no assertion is changed. Artifacts `flow-chrome/chromium-recorded/` and `flow-chrome/chromium-observations/`; broken-sync is still running under the same lock.

Chrome flow gate completed 4/10 passed, 6 failed, exit 1, no skips/cancellations, `logs/flow-chrome.log`. Both phone and web videos pass independent decode and identity; both desk video checks and their parents fail on the same coverage refusal. Broken-sync reaches the desk state check, CLI 1, `failed/check_failed`, actual Open, expected Done; it goes no further. It has no lease expiry or cleanup failure, and the test's native/browser disappearance assertions pass. The stale desktop tree is observed, but its pixels are not recorded. This gate is blocked by the covering window, not by a remaining source-scope rejection or an expired native setup lease. Raw events, reports and approved frames are retained in the two Chrome run/observation folders. Firefox is next, using the installed launch-services route.

Exact flow commands, from the repository root, each redirecting stdout/stderr to `logs/flow-<engine>.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-native-recording/flow-chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-native-recording/flow-firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/fix-native-recording/flow-webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Firefox normal flow passes, CLI 0, with 20 assertions; both phone and Firefox movies pass decode and identity. Desk capture has the identical layer-1000 coverage refusal quoted above, so its video is not exercised and the evidence parent remains failed. No scope refusal, lease expiry or cleanup failure appears in this completed normal run. Artifacts `flow-firefox/firefox-recorded/` and `flow-firefox/firefox-observations/`; broken-sync remains active under the same lock.

Firefox gate completed 4/10 passed, 6 failed, exit 1, no skips/cancellations, `logs/flow-firefox.log`. Normal application run passes; broken-sync fails only at the intended desk Open-versus-Done check, CLI 1, with no later action. Both runs have zero lease expiries/cleanup failures and pass disappearance checks. Phone/web movies independently decode with identity in both runs; desk videos and complete final-state pixels remain unexercised because of the same covering window. Firefox is 133.0.3, build 20241209150345, through launch-services. Raw broken-sync artifacts are `flow-firefox/firefox-broken-sync-recorded/` and `flow-firefox/firefox-broken-sync-observations/`. WebKit follows as the only next heavy gate.

Timeline inspection also finds a separate limit on complete state evidence. In each completed Chrome/Firefox flow, phone task checks and final desk checks lie inside named password-withholding intervals. These native stretches end only with `session_ended`; the browser resumes at `new_document`, after its early sign-in/list checks. The coverage refusal is the direct cause of each missing desk movie, but removing that host blocker alone would not prove complete state pixels. Phone movies hold earlier frames during their withheld task checks. No tree read or successful login is taken as proof that secret pixels are gone. The privacy policy is preserved, and complete task-state video evidence remains unverified independently of the covering window.

WebKit normal flow passes the application, CLI 0, with 20 assertions. Phone and WebKit videos pass independent decode and identity; desk capture has the identical layer-1000 coverage refusal, so the evidence suite remains failing. This is WebKit 626.1.6+, build 2359. It has no lease expiry or cleanup failure and passes target disappearance checks. Artifacts `flow-webkit/webkit-recorded/` and `flow-webkit/webkit-observations/`; broken-sync is still running under the same lock.

WebKit gate completed 4/10 passed, 6 failed, exit 1, no skips/cancellations, `logs/flow-webkit.log`. Broken-sync reaches only the intended desk Open-versus-Done failure, CLI 1, with zero lease expiry/cleanup failure and no later action. Its phone/web movies pass decode and identity; its desk movie has the same coverage refusal. Artifacts `flow-webkit/webkit-broken-sync-recorded/` and `flow-webkit/webkit-broken-sync-observations/`. All three engines now have the expected application verdicts, with desk video unexercised. None is a complete three-app visual-evidence pass.

Read-only inspection command `python3 .retest/fix-native-recording/flow-summary.py` saves identity, verdict, lease, movie and withholding facts in `flow-summary.json`, with output `logs/flow-summary.log`. Across all six runs, each has five phone checks and three web checks inside password-withholding. Each normal run has six desk checks inside withholding; each broken-sync run has five, including the final failed state check. Whole-decode output counts, phone/web, are Chrome normal 347/379 and broken 503/515, Firefox normal 351/371 and broken 582/592, WebKit normal 437/446 and broken 531/544. These are output frames including held images, not native paint ticks or a cadence claim.

Chrome recorded-flow submission found the shared lock busy, exit 75, and started no test. Log `logs/flow-chrome-lock-busy-1.log`. No second heavy command is queued; retry follows the required lock wait.

Fresh iOS on-run passed all three unchanged evidence children: normal/failure PNGs, all three movie whole-decodes and frame identities, and the secret withheld stretch. Its application verdicts are passed/check_failed/passed, CLI 1. Artifacts `ios-fixed/ios-simulator-on/` and `ios-fixed/ios-simulator-observations/*/decode.json`. Off comparison is still running; the full gate result remains pending. `run-media.ts` needs no change: its existing hook lookup now receives the native adapter's source and opens the normal recording path.

Fresh iOS gate completed 5/5 passed, exit 0, no skips/cancellations, `logs/ios-fixed.log`. Both CLIs returned passed/check_failed/passed and exit 1, with zero cleanup failures or lease expiries. On used one media worker; off used none and emitted no recording events. Whole-decode counts are 163, 192 and 161 frames; forwarded native images are 12, 11 and 2. Ready/wrong recordings are complete with no gaps; secret recording is partial with `capture_gaps` and `pixels_withheld`, and no approved post-secret frame or image artifact. Identity, frame-map/run-clock checks, source-pixel samples, PNG decode and report agreement all passed. The third recording-off boot now completes in this real scenario. The historical host ownership timeout remains unreproduced and is not claimed repaired by retrying or ignoring it.

Prior retained flows refuse another-app phone trees and desk trees without a window. Scope checks must continue to refuse those reads. Any look-again must fit the caller's remaining budget and must send input once. Lease renewal during native setup is under investigation. Real recorded flow and stale desktop pixels are unverified. Wispr Flow will remain untouched; any coverage refusal will be copied exactly and separated from code failure.

Failing-first `node --conditions=retest-source --test tests/unit/native-source-retry.test.ts` produced 1/4 passed, 3 failed, exit 1, no skips or cancellations, `logs/source-failing-first.log`. Both transient observations fail at the original scope refusal; the permanent-tree case returns before the whole budget. Cancellation already passes. The tests use the runner adapter and the same executor tree shapes as the evidence lane; no real-platform claim follows from these fakes.

Lease inspection and retained Chrome events disprove a startup lease-length diagnosis. `ResourceLease` starts its expiry clock in `release`, after the attempt, and uses the cleanup budget. Chrome's lease was taken at run elapsed 262 ms, its test ended at 83513 ms, and expiry occurred at 143514 ms with the device held. Startup itself is bounded by setup and test budgets, not a renewable lease. No lease removal or arbitrary enlargement is justified. Native cleanup and idle proof remain under investigation.

The source fix retries only internally generated another-app and missing-window refusals, inside the source turn's original deadline, with the same redactor and signal. Each new driver read gets only the remaining budget. No refused tree is accepted or kept. At exhaustion the original scope refusal stands; cancellation stops further reads. Both ordinary observations and field verification use this read path.

Additional checks `node --conditions=retest-source --test --test-name-pattern='remaining source budget|malformed tree' tests/unit/native-session.test.ts tests/unit/native-source-retry.test.ts` passed 2/2, exit 0, no skips/cancellations, `logs/source-budget.log`. They require shrinking command budgets and exactly one read for a malformed tree. The frame-hook checks now also require the source's own identity, platform source name and availability; focused command with the original hook pattern passed 2/2 in `logs/frame-identity.log`.

Added account-fill coverage for each platform, both before input and during read-back, plus a permanent missing-window refusal. `node --conditions=retest-source --test tests/unit/native-source-retry.test.ts` passed 10/10, exit 0, `logs/fill-scope-fixed.log`. Each fill must focus, clear and type once, verify the field, or preserve not-sent input at exhaustion. An in-memory loader removing the new session retry hooks also passes these five fill cases, because the existing actionability and fill layers already retry their tree reads; these are additional regression coverage, not failing-first evidence for the new helper. The original failing-first observation cases remain the discriminating reproduction. Logs `fill-scope-failing-first-2.log` and loader `drop-source-retries.mjs` retain that result. The first added fill check incorrectly required clearing an empty field; it was corrected by starting with the fixture text `old`, without changing product behavior. Its failed run is retained in `fill-scope-failing-first.log`. Source-wait cancellation catches only an actual aborted signal; other wait errors propagate.

After that cancellation change, `node --conditions=retest-source --test tests/unit/native-source-retry.test.ts tests/unit/native-session.test.ts` passed 52/52, exit 0, no skips/cancellations, `logs/source-final.log`. No command budget is reset by the retry; a permanent refused tree remains refused and cancellation sends no further read or input.

`node --conditions=retest-source --test tests/unit/native-source-retry.test.ts tests/unit/native-source-scope.test.ts tests/unit/native-actionability.test.ts tests/unit/native-session.test.ts` passed 67/67, exit 0, no skips or cancellations, `logs/source-fixed.log`. Existing scope, actionability and lifecycle checks remain intact. Inspection of the Chrome result's `cleanupFailures` confirms the held device came from native ownership metadata queries timing out during app close, not from simulator startup consuming a lease TTL. The recorded failure names process 98821 and the caller deadline. That ownership implementation is outside the assigned files and is not relaxed here.

## Finding 5, recording-off simulator startup

Prior `.retest/evidence-targets/ios/ios-simulator-off/result.json` has CLI exit 2, passed/check_failed/not_run, and an unproved native start whose lease stays held. The failure occurred on the third session's bootstatus call. Simulator boot, command ownership and startup cleanup budgets are under investigation. A reproduction and failing-first regression are pending; recording-on/off equality is unverified.

The retained bootstatus failure names ownership metadata deadlines, not setup timeout: its third setup ended at elapsed 155627 ms after a lease taken at 128758 ms, despite a 300000 ms setup budget. There is no bootstatus retry loop here; it is the third separate session. The process-group cleanup bound in `src/native/processes.ts` is separate from simulator boot/setup. An actual load/ownership failure cannot be swallowed or changed into a successful boot.

A deterministic startup-proof defect is reproduced independently: after bootstatus refuses and the created simulator is removed and independently checked absent, `IosSimulatorRuntime.start` still omits `idle`, so the native pool reports an unproved start and holds the lease. Failing-first `node --conditions=retest-source --test --test-name-pattern='refused bootstatus' tests/unit/native-ios-simulator.test.ts` ran after the benchmark guard and produced 1/2 passed, 1 failed, exit 1, no skips/cancellations, `logs/boot-ownership-failing-first.log`. Successful cleanup fails the exact `idle: true` assertion; failed deletion correctly keeps ownership held. This is a fake-tools reproduction of lease retention, not reproduction of the original host metadata timeout.

`failStart` now marks a recorded device's successfully verified removal as `idle`, while preserving the original startup failure. Unanswered creation, failed deletion, failed process cleanup and ownership-reading failures keep the lease held. The pool's refusal now accurately says the start must prove it left no resource in use. No boot success, input undo or successful verdict is inferred from cancellation.

`node --conditions=retest-source --test --test-name-pattern='refused bootstatus|uncertain native start|proves it launched nothing' tests/unit/native-ios-simulator.test.ts tests/unit/runner-native-wiring.test.ts` passed 4/4, exit 0, no skips/cancellations, `logs/boot-ownership-fixed.log`. These include both cleanup proof outcomes and the pool's unchanged uncertainty checks. The original host ownership-query timeout has not yet reproduced in this builder's real run and is not claimed fixed by this signal change.

Broader check `node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-wiring.test.ts tests/unit/native-ios-simulator.test.ts tests/unit/native-source-retry.test.ts tests/unit/native-source-scope.test.ts tests/unit/native-session.test.ts tests/unit/native-actionability.test.ts tests/unit/native-input.test.ts tests/unit/runner-resources.test.ts` completed 188/189, exit 1, no skips/cancellations, `logs/owned-units.log`. It caught an existing constraint: `idle` specifically means a start created nothing, and the unchanged test at native-ios-simulator.test.ts:423 requires no idle flag after creation. That test is preserved. The cleanup proof will use a separate `cleaned` flag, keeping the old idle meaning and the original startup failure. The preceding idle implementation is superseded; no existing assertion is changed to make it pass.

Final startup signal is `cleaned: true`, passed unchanged through `startBuilt` and consumed by the pool. `idle` retains its old meaning. `node --conditions=retest-source --test --test-name-pattern='refused bootstatus|created its simulator never' tests/unit/native-ios-simulator.test.ts` failed first at 1/3 after the conflict was included (`logs/boot-proof-signal-failing-first.log`), then passed 3/3, exit 0 (`logs/boot-proof-signal-fixed.log`). Failed cleanup still withholds both flags.

Added a pool-to-built-runtime check that keeps the exact boot failure and requires immediate device release, a later start and clean pool ending. Removing only the cleaned-signal delegation with an in-memory loader makes it fail 0/1, exit 1, `logs/cleaned-delegation-failing-first-2.log`. Product files were not replaced. The first loader failed to mutate buffer source and passed 1/1; that attempt proves nothing and is retained in `logs/cleaned-delegation-failing-first.log`. The corrected loader requires its exact mutation target. Commands are `node --import ./.retest/fix-native-recording/drop-cleaned-hook.mjs --conditions=retest-source --test --test-name-pattern='proved-cleaned iOS' tests/unit/runner-native-run-end.test.ts` and, without the import, the same test command. Unmutated code passed 1/1, exit 0, `logs/cleaned-delegation-fixed.log`.

Final broader unit command `node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/native-ios-simulator.test.ts tests/unit/native-source-retry.test.ts tests/unit/native-source-scope.test.ts tests/unit/native-session.test.ts tests/unit/native-actionability.test.ts tests/unit/native-input.test.ts tests/unit/runner-resources.test.ts` passed 210/210, exit 0, no skips/cancellations, `logs/owned-units-final.log`. The benchmark guard ran first. Existing action, lease, unknown outcome, scope and created-device idle assertions are preserved. The nine unit files use stand-ins and launch no real target.

## Final checks

Locked `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py npm run typecheck` failed, exit 2, `logs/typecheck.log`. My new hook test widened the adapter to `OwnedPage`, which does not declare this optional recording hook; I removed that annotation and use the adapter's concrete type. No contract was changed. The same gate also reports readonly evidence-gap errors at `tests/unit/reporters-human.test.ts:68` and `:70`, in the other builder's reporter work. That file is left untouched; a fresh gate will follow the correction/wait. No TypeScript 7 or example pass is claimed from this first gate.

The corrected hook test passed 2/2, exit 0, `logs/frame-hook-typed-final.log`, using the original focused command. Locked `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py npm run typecheck:proofs` passed exit 0, `logs/typecheck-proofs.log`. All eight declared compiler invocations, TypeScript 6 and 7 for Firefox, WebKit, native and media proofs, ran. A compiler pass is not an exercised-platform claim.

After the wait and the busy-lock attempt, the identical full typecheck command acquired the lock and failed exit 2, `logs/typecheck-final.log`. Only the two readonly evidence-gap errors in `tests/unit/reporters-human.test.ts:68` and `:70` remain. There are no diagnostics in this builder's files. The full TypeScript 6 gate is still failing, so its chained TypeScript 7 and example invocations did not run. Reporter owner must fix the fixture's readonly gap tuple without weakening its assertions. This builder leaves that file untouched.

The reporter file changed during the subsequent wait; the other builder annotated the mapped event as `RetestEvent` and replaced the status's `as const` type assertion. Its behavioral assertions remain. This builder made no edit there. A fresh identical locked `npm run typecheck` passed exit 0, `logs/typecheck-settled.log`. TypeScript 6 project, TypeScript 7 project and TypeScript 6 example all ran. The earlier failing logs remain retained. Hash observations around the wait are `reporter-types-before-wait.txt` and `reporter-types-after-wait.txt`.

Final native audit passed exit 0, `logs/native-audit.log`, with all 18 recorded simulators absent, no process using their device paths, and no TaskDesk process. It lists 22 other existing simulators and sends no signal or removal command. The exact locked command is:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/fix-native-recording/inside.py node --conditions=retest-source .retest/fix-native-recording/native-audit.ts ios-first/ios-simulator-on ios-first/ios-simulator-off ios-fixed/ios-simulator-on ios-fixed/ios-simulator-off flow-chrome/chromium-recorded flow-chrome/chromium-broken-sync-recorded flow-firefox/firefox-recorded flow-firefox/firefox-broken-sync-recorded flow-webkit/webkit-recorded flow-webkit/webkit-broken-sync-recorded
```

Readings and recorded device identities are retained in `native-audit.json`. Each unchanged flow test also independently checks no own simulator, runner, xcodebuild, TaskDesk or browser remains; those assertions passed in all six runs.

The full typecheck retry found the shared lock busy, exit 75, and started nothing. Log `logs/typecheck-final-lock-busy-1.log`. Its next retry follows the required lock wait. No heavy command is queued while waiting.

Read-only `python3 .retest/fix-native-recording/process-audit.py` passed exit 0, `logs/process-audit.log`. It queried 165 retained PID/start records from gate roots, media owners, decoder children and own descendant snapshots. None remains present; no signal was sent. Full readings are in `process-audit.json`. Processes from other workers and pre-existing apps are neither adopted nor ended.

After the final compiler command ended, the audit was repeated with explicit unreadable-start/command refusal and confirmed-absence counts. It passed exit 0, `logs/process-audit-final.log`: 166 recorded readings, 166 confirmed absent, none present, no signals. `process-audit.json` holds the final result. No owned simulator, runner, app, browser, media or ffmpeg process remains in these retained readings and native disappearance checks.

After the settled compiler pass, the last process audit passed exit 0 with 167 recorded readings, all 167 confirmed absent, none present, no signals. It supersedes the preceding count in `process-audit.json` and `logs/process-audit-final.log`. No target or heavy command remains queued.

Scoped whitespace checks passed across all ten files edited here. `python3 .retest/fix-native-recording/file-audit.py` checks tracked and untracked files, final newlines and trailing whitespace, exit 0, `logs/file-audit.log`, `file-audit.json`. `git diff --check -- src/runner/native-pool.ts src/native/source-scope.ts src/native/ios-simulator.ts src/native/session.ts tests/unit/runner-native-wiring.test.ts tests/unit/native-ios-simulator.test.ts tests/unit/native-session.test.ts tests/unit/native-source-retry.test.ts tests/unit/runner-native-run-end.test.ts docs/plans/public-beta/codex/phase-4/fix-native-recording-report.md` also passed exit 0. No commit, stash, reset, revert, publication, download or benchmark was performed.

## Files changed by this builder

The shared tree was already dirty. These are this builder's edits, not an ownership claim on the full git diff:

| File | Edit |
| --- | --- |
| `src/runner/native-pool.ts:372` | Delegate the unchanged frame hook. |
| `src/runner/native-pool.ts:55`, `:117`, `:451` | Carry and consume proven cleanup, preserving unproved holds and the startup failure. |
| `src/native/source-scope.ts:59` | Identify only generated transient owner/window refusals. All scope checks remain. |
| `src/native/session.ts:349`, `:356`, `:558` | Retry those source reads within the original turn budget, including field reads; stop on cancellation. |
| `src/native/ios-simulator.ts:284`, `:484` | Separate verified failed-start cleanup from the unchanged created-nothing meaning of idle. |
| `tests/unit/runner-native-wiring.test.ts:30` | Both platform frame delegation, identity, fresh sources and no requests. |
| `tests/unit/native-source-retry.test.ts` | New observation, action, read-back, exhaustion, malformed-tree and cancellation checks. |
| `tests/unit/native-session.test.ts:172` | Driver reads receive shrinking remaining budgets. |
| `tests/unit/native-ios-simulator.test.ts:99` | Boot refusal with proven/unproven deletion; original idle test preserved. |
| `tests/unit/runner-native-run-end.test.ts:249` | Built-runtime-to-pool cleanup proof frees the device without softening the failure. |
| `docs/plans/public-beta/codex/phase-4/fix-native-recording-report.md` | This finding-by-finding step record and final results. |

`run-media.ts` was read but unchanged; its existing hook lookup accepts the adapter. `run-session.ts` was read but unchanged; its lease expires during release, and no lease-age or renewal defect was found. The other builder's three named files and reporter tests are untouched. There are no changes to evidence integration tests, fixture flows, public contracts, package exports, npm scripts, dependencies, npm ownership or release state. Ignored helpers, logs and artifacts belong under `.retest/fix-native-recording/`.

## Unverified and owner handoff

1. Desk video and complete task-state pixels remain unexercised. All six flows refuse the covering window. Separate native password-withholding intervals also cover the task-state checks. `src/runner/run-session.ts:1032` ends native stretches only when the session ends; `:1415` resumes browser stretches on a new document. A reviewed pixel-lifecycle design and proof would be needed to resume native evidence safely. This is outside the allowed lease-only edit there; no successful tree check is used as pixel clearance.
2. The original bootstatus and close ownership-metadata timeouts did not reproduce. The retained failure's separate cleanup bound is in `src/native/processes.ts:473`, and its fresh ownership readings are in the shared ownership implementation. Those files are outside this builder's scope. The startup-proof fix does not repair an unreadable ownership query, enlarge its budget or turn unknown cleanup into success. Recording-off equality is proven on this host's fresh run, not for every boot under load.
3. Native paint-to-run-clock mapping, physical devices, other platforms, installed-package execution and release readiness were not exercised. Native video here is a simulator-display screenshot loop. Flow videos decode with approved-source comparison; this lane makes no new WebKit colour-profile or every-tick claim.
