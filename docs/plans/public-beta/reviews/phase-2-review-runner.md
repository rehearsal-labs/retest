# Phase 2 review, part two: the runner, the protocol and the records

Read-only review by an Opus 5.5 reviewer of the committed Phase 2 runner, protocol, store, capture, reporting and config code, against the current tree. Phase 3's uncommitted edits to `running-test.ts`, `browser-pool.ts`, `target-drivers.ts`, `cli-harness.ts` and the config types were read with `git diff HEAD` and are judged only where they change a Phase 2 invariant.

Counts: 1 high, 4 medium, 9 low. Of the held findings in scope, 2 are fixed, 2 are fixed only in the uncommitted Phase 3 tree, 18 still apply, and 1 was a note rather than a defect.

## Findings, most severe first

**R-1 · high · new** · `src/runner/running-test.ts:571-577` with `src/runner/observations.ts:111-117`
- **Claim:** when an `assertion.failed` names a look the parent served, the parent keeps the child's failure class and adds it to its own list of observed failures, so the child chooses the class of a failure the parent saw.
- **Scenario:** the parent serves look `o1` for `getByTestId('task-title')`, which reads `""`. The test process sends `assertion.failed` naming `o1` and `{ matcher: 'toHaveText', text: 'Something else' }` with `failure.class: 'session_lost'`, then `test-finished` with the same failure.
  - `report.observed` becomes `[session_lost]` and the verdict is `session_lost`.
  - `testStatus` gives `error` (exit 2) where the app failed a check (exit 1). In Rehearsal that counts as ours and the run restarts, so the customer never sees the failure.
  - `setup_failed`, `unsupported` and `outcome_unknown` work the same way. The existing unit test only tries `usage`, which is not one of the error classes.
- **Fix:** for an `assertion.failed` naming a served look on which the parent's rule fails, write the parent's own failure (`not_found`, `ambiguous` or `check_failed`, as the poller decides it) first, with the child's failure in `also`. Never record a child-sent error class as observed unless the parent saw that loss itself.

**R-2 · medium · new** · `src/store/rebuild-result.ts:147-150` against `src/runner/run-session.ts:1215-1216, 1250-1251, 1258-1259`
- **Claim:** `result.json` lists host checks and host AI checks that never ran as `not_run`, but no event records them, so the rebuilt result drops them.
- **Scenario:** run `host-checks.retest.ts` with a text host check keyed to `fails itself`.
  - `result.json` has `hostChecks: [{ check, app: 'page', status: 'not_run' }]`.
  - `rebuildRecordedResult(events)` has no `hostChecks` for that test, and `assert.deepEqual` fails.
  - The same happens for skipped tests, not-run tests, and host AI checks built by `notRunRecords`.
  - The identity record says the rebuild is equal "file for file and field for field", which no test covers in this case.
- **Fix:** emit a not-run event, or rebuild these rows from `run.started` options and the attempt's ending. Add the failing case as a test.

**R-3 · medium · new (regression in fb8eb41)** · `src/runner/run-session.ts:836-845`, `1420-1448`, comment at `245`
- **Claim:** sessions held for contexts that could not close are given back only when `whenFree` resolves. The run-end drain that Phase 1 had (`for (const finish of [...this.#heldSessions]) finish()`) is gone, and a native close that fails is swallowed by `.then(finish, () => undefined)`.
- **Scenario:** a run with a host `SessionBudget` has a native page whose `dispose` fails, so the page is left open. Then the adapter's close rejects, for example when the `ps` read times out, as the diagnostics record saw in two of three runs. The test's sessions never come back:
  - no `session.released` is written, and no `lease.expired` names them;
  - the comment still says they come back when the run ends;
  - in a host process that keeps its budget across runs, every later run of that owner has that many fewer sessions, and its attempts fail "did not come free".
- **Fix:** give the sessions back at run end once every runtime has been asked to close, as Phase 1 did, or record them as held past the run in an event.

**R-4 · medium · new** · `src/runner/native-pool.ts:104-109, 387-391, 143`
- **Claim:** only a start answering `idle: true` frees a native resource. `MacosDesktop.start` and `IosSimulatorRuntime.start` never answer it, so a start that provably launched nothing is kept as uncertain.
- **Scenario:** another Retest process holds the desktop. This process's first macOS test fails setup with "Another Retest process … drives this Mac's desktop", which is correct. Then:
  - `#free` and `#runtimeHolders['macos']` stay set and the desktop part never comes free;
  - every later macOS attempt in the process waits the whole setup budget behind the expired lease, then fails with "did not come free … held it past the end of its lease";
  - `NativePool.close` adds a run-level `cleanup_failed`, so the run exits 2;
  - a long-lived host process can never drive the desktop again;
  - wrong platform, wrong executor, "this process already runs the macOS runner" and a missing iOS runtime behave the same way.
- **Fix:** have the native runtimes mark refusals that happen before any process starts as `idle`, and pass that through `startBuilt`.

**R-5 · low · new (record overclaim)** · `src/runner/native-pool.ts:92-93` against `src/runner/resources.ts:62-69`; `docs/guide.md:419`; resources record lines 17 and 57
- **Claim:** `resourceNeeds` gives two macOS apps of one test one desktop part, but `NativePool.#ensure` refuses any second runtime on that desktop, or on the same simulator device and runtime.
- **Scenario:** `apps: ['desk', 'plain']`, both on `macos`. The lease covers both. `ensure('desk')` succeeds and `ensure('plain')` answers "The native resource already has an active runtime." The test fails setup, while the guide and the record say two apps on one desktop take it once (the record's unit test used a stand-in, not the pool).
- **Fix:** refuse such a test by name at planning, or share one runtime between apps of one attempt. Correct the guide and the record.

**R-6 · low · new (Phase 1 path, missed by the cancelled-run fix)** · `src/runner/run-session.ts:939-943`
- **Claim:** a run interrupted while web diagnostics start returns without closing the pages and without `leftOpen`, so the sessions go back at once as `contexts_closed` while the contexts are still open.
- **Scenario:** a stop arrives during `diagnostics.start` in a run with session limits. `session.released after: 'contexts_closed'` is written and the budget returns the sessions. Another run sharing the budget can open contexts before this run's browsers close, which goes over the host limit. The event's `after` is also false.
- **Fix:** return `leftOpen` (or close the pages) as the interruption branch two lines above does.

**R-7 · low · new** · `src/runner/native-pool.ts:142` with `src/runner/run-session.ts:769, 1421`
- **Claim:** `#apps` never drops an adapter, so a native close that failed in the attempt is reported again at run end under a different message.
- **Scenario:** an attempt fails `check_failed` and its native close fails. The attempt records `cleanup_failed` beside the failure, and `NativePool.close` reports the same rejection as a run-level output failure, so the run exits 2 rather than 1, counting one fault twice.
- **Fix:** drop adapters whose failure the attempt already recorded, or report the held lease once.

**R-8 · low · new (protocol honesty)** · `src/protocol/execution.ts:147, 314`
- **Claim:** `StartingState.browserStorage` went from required to optional, which is not an additive change.
- **Scenario:** a consumer typed against the Phase 1 declarations reads `startingState[i].browserStorage` as always present and gets `undefined` for native apps. The wiring record calls the starting-state changes "additive native fields".
- **Fix:** keep `browserStorage` required, with a value for native apps, or record the narrowing as a compatibility change.

**R-9 · low · new** · `src/diagnostics/attempt.ts:88`
- **Claim:** a native session's diagnostics scope always says the console covers `owned_process`, even when the target keeps no log or capture is off.
- **Scenario:** the `quiet` target (`logs: 'none'`) writes `diagnostics.started` with console covering `owned_process`, then a summary saying unavailable, "the app provides no log source". The scope and the state contradict each other.
- **Fix:** build the console scope from whether a log source will be bound.

**R-10 · low · new** · `src/runner/test-pages.ts:57-62`
- **Claim:** `openPage` turns every `NativeError` class other than `unsupported` into `setup_failed`, so a launch whose outcome is unknown reads as a plain setup failure.
- **Scenario:** a logged launch throws after it may have started the app. `newPage` throws `outcome_unknown`, and the test's failure class becomes `setup_failed`; only `native.ended` keeps the uncertainty.
- **Fix:** keep the `NativeError`'s own class (`outcome_unknown`, `cleanup_failed`) when one is given.

**R-11 · low · new** · `src/config/validate.ts:176`
- **Claim:** in a config with any native target, any dotted string in `secretOrigins` is accepted as a bundle id instead of being refused as a malformed origin.
- **Scenario:** `secretOrigins: { password: ['example.com'] }` loads without a problem in a config that has a native app, and the web fill is then refused at run time. The same config without a native app refuses it at load.
- **Fix:** accept a bundle id only when it matches an installed native target's id, or warn when a string looks like a host name.

**R-12 · low · new** · `tests/integration/reference-flow.test.ts:59`
- **Claim:** the service teardown falls back to `signalGroup(pid, 'SIGKILL')` on a group the ownership layer never recorded, which throws since 9b38691.
- **Scenario:** a service that does not exit within the wait after SIGTERM is left running, and the teardown throws "has no recorded launch ownership".
- **Fix:** record the group through `OwnedProcessGroup`, as the reworked harness does, or kill only the recorded pid after re-checking it.

**R-13 · low · new (records)** · the identity, resources, wiring and reference-flow records
- **Claim:** four records say more than their tests show:
  - the identity record's rebuild equality (see R-2);
  - the resources record's "two apps on one desktop" (see R-5);
  - the wiring record's line saying the parent refuses the keyboard controls "on macOS as `unsupported`", when `dismissFirstRunCard` is not refused there (loose-ends 6);
  - the reference-flow record's "2 of 2 passed": the last runs, recorded in the native-diagnostics record, failed in CLI harness cleanup at the Phase 2 commit, and no rerun after the harness fix is recorded.
- **Fix:** narrow each sentence to what ran, and rerun the reference flow under the lock after the harness fix.

**R-14 · low · new (records)** · `docs/guide.md:255, 261, 1622`
- **Claim:** the guide still says the public native helpers are unfinished and native secret input is refused. Both landed.
- **Fix:** update the native section and the support list.

## Held findings in scope

| Held item | Status on the current code |
| --- | --- |
| Identity 1, repeated evaluation id | Fixed: `running-test.ts:595` (and `327` for commands); test at `tests/unit/runner-command-lanes.test.ts:228`. |
| Identity 2, harness cleanup signals groups unchecked | Fixed only in the uncommitted Phase 3 tree (`tests/integration/cli-harness.ts:231-246`, `OwnedProcessGroup`). Still present at the Phase 2 commit. `reference-flow.test.ts:59` and `m2-guarantees.test.ts:138` keep the old pattern (R-12). |
| Identity 3, frame dropped silently on a failed start | Fixed: `src/browser/capture.ts:99` counts the waiting frame as dropped; test at `browser-capture.test.ts:193`. |
| Identity 4, cleanup failure overwrites the media-loss reason | Still applies: `src/media/capture.ts:262-264`. A `lost` reason from `finishRecording` is replaced by `status: 'unavailable', reason`. |
| Identity 5, aborted signal still starts | Still applies: `src/media/capture.ts:236-253`. `media.record` and `source.start` run before the signal is checked. |
| Identity 6, `identify` keeps part of the owner | Still applies: `src/browser/page.ts:355-362`. `runId` is neither kept nor compared, and `formatSessionId('', '')` is `':'`, so empty owner parts pass. |
| Identity 7, frozen report shares mutable objects | Still applies: `src/media/capture.ts:409-411` (`identity`, `started`, `capture`, `ended` shared). `page.ts:376-378` hands the page's stored identity object to the source. |
| Identity 8, no test of the cap on frames held before start | Still applies: no test sends more frames than the cap before start; the identity record (line 158) still says every revert failed or hung. |
| Loose-ends 1, alert description drops the button | Still applies: `src/protocol/commands.ts:284-285`. |
| Loose-ends 2, no swipe direction, keyboard operation or alert button in events | Still applies: `running-test.ts:807-823`; the event schema (`events.ts:157-192`) has no field for them. |
| Loose-ends 3, options read under the command kind | Still applies: `src/api/test-run.ts:201`; worked around at `app-page.ts:389`. |
| Loose-ends 4, header reads the first browser to arrive | Still applies: `src/reporters/run-record.ts:80` with `human.ts:84-85`. |
| Loose-ends 5, case probe written in the parent folder | Still applies: `src/runner/resources.ts:470-472, 484`. |
| Loose-ends 7, guide says helpers unfinished | Still applies: `docs/guide.md:255, 1622` (R-14). |
| Loose-ends 8, new public native types not exported | Still applies: `src/index.ts:5` exports none of `NativeLocatorStep`, `NativeStepPick`, `SwipeDirection`, `NativeKeyboard`, `Alert`. |
| Reference flow 1, guide says native secrets refused | Still applies: `docs/guide.md:261, 1622` (R-14). |
| Reference flow 2, native check classed `timeout` | Still applies: `fixtures/cross-platform/tests/native-phone.retest.ts:28`. In the phone case the first tree read never answered within the call's `{ timeout: 300 }` (what remains of 300 ms), so no look exists and `timeout` is the honest class: the fixture's expectation, or its budget, is what is wrong (a budget above one iOS tree read still fails, since the state never becomes Done). **What the parent must do** for the case where a look exists: in `RunningTest#childEvent`, when an `assertion.failed` names a served look on which the parent's rule fails, write `not_found`, `ambiguous` or `check_failed` from that look, first, with the child's class in `also` (this is also R-1's fix). Without that, a native read that gives up a few milliseconds early ("no answer within 297 ms") can arrive before the child's own deadline, and `lookUntil` keeps `timeout` over a mismatching last look. When no look was served, keep `timeout`. |
| Reference flow 3, no `textContent()` on native locators | Still applies: `src/api/page.ts:322-341`; the flow reads the id through the web address (`reference-flow.retest.ts:38-44`). |
| Reference flow 4, edits beyond named files | Read in full; this was a note, not a defect. It led to R-4 and R-5. |
| Native diagnostics wiring 1, shared network file across runs | Still applies: `src/config/read-apps.ts` `checkNetworkSources` guards one config only; `native-network.ts:123` attributes records by client name alone. |
| Harness fix lane 2, lost browser between looks | Still applies (uncommitted Phase 3 code): `running-test.ts:247-263, 543-544`. A loss with nothing in flight has no location. `#looking` is set by plain reads (`page.url()`, `title()`), so a loss after one waits up to the abort grace. A check whose process never reports leaves no `assertion.failed`. |

Loose-ends 6 (`dismissFirstRunCard` on macOS) still applies at `src/native/keyboard.ts:119` with no refusal in `NativePageAdapter.execute` (`native-pool.ts:301-307`), and it makes the wiring record's claim false (R-13).

## Confirmed by running

- `node --conditions=retest-source --test --test-timeout=120000 tests/unit/runner-command-lanes.test.ts tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-secrets.test.ts tests/unit/store-rebuild-result.test.ts tests/unit/media-capture.test.ts tests/unit/browser-capture.test.ts tests/unit/protocol-identity.test.ts`: 102 pass, 0 fail.
- R-1: `node --conditions=retest-source --test /tmp/retest-review-runner/forged-class.test.ts`. The assertion is written with the forged class, `observed` is `[session_lost]`, the verdict is `session_lost` and the status is `error`.
- R-2: `node --conditions=retest-source --test /tmp/retest-review-runner/rebuild-hostchecks.test.ts`. The deep-equal fails: the rebuild lacks the `not_run` host check that `result.json` has.
- R-5: `node --conditions=retest-source --test --test-timeout=60000 /tmp/retest-review-runner/two-macos.test.ts`. The lease has one desktop part with both apps; the first `ensure` succeeds and the second is refused with "already has an active runtime".
- Before running, `pgrep -f benchmarks/run.ts` found no benchmark. Its only match was another session's shell whose command text contains that string.

## Not verified, most important first

1. R-3 and R-4 were reasoned from the code, not driven through a real or fake run.
2. No real-target integration file was run (simulator, desktop, Chrome), so nothing here re-confirms the reference flow, its broken-sync variant or the native API tests. That includes whether the Phase 3 harness fix clears the reference flow's teardown failure.
3. The early-timeout race in reference flow 2 was not measured.
4. R-7's exit code was reasoned from `runOutcome` and the event log, not run.
5. The two-process desktop behaviour behind R-4 was read from `desktop-lock.ts`, not exercised.
6. The older reader refusing new run folders was taken from the records: the wiring record ran it once; the identity and resources records reasoned it.
7. Host AI checks in R-2 and the skipped and not-run variants were reasoned; only page host checks were run.
8. Native secret handling was reviewed only at the runner (destination rule, page check, redaction of events and records). Executor-side output belongs to the native part of this review.
