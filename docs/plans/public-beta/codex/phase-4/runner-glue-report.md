# Runner glue report

This run preserves the shared tree and edits only the assigned paths. Logs are under `.retest/runner-glue/logs/`; launched guarded verification commands and pids are in `.retest/runner-glue/processes.log`. The guard checks `pgrep -f benchmarks/run.ts` before tests and excludes only identified worker instruction-text matches. No benchmark, download or git mutation is requested.

## Step 1, started

Read the assigned handovers and repository rules. Baseline commands: `node_modules/typescript/bin/tsc -p tsconfig.json` and `node_modules/typescript-7/bin/tsc -p tsconfig.json`. Outputs: `step-1-ts6-before.log`, `step-1-ts7-before.log`.

## Step 1 result

Added explicit inspector descriptions for recording starts/endings, media lifecycle/refusals, pixel withholding/resumption/masked entry, and retention requests/failures. `TimelineEvent` allows these run-wide records without labelling them test-scoped; timeline overloads preserve existing callers’ types. The initial test helper excluded optional-scope retention variants from `TestEvent`; the final refinement below preserves those with both required identities.

Regression: `the timeline names recording loss, media refusal, pixel withholding and failed retention`, which the old switch cannot render. `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/inspect-looks.test.ts`: 9 passed, `step-1-inspect.log`. Both explicit compiler commands were repeated; `step-1-ts6-after.log` and `step-1-ts7-after.log` contain only the same three external errors: `tests/unit/process-ownership.test.ts:208,430,446`, property `pid` on `never`. That file belongs to the running ownership worker and was not edited. Full locked typecheck is reserved for the final step.

## Step 2 result

`src/media/locate.ts` accepts `mode: 'discover'` and returns checked executable/ffmpeg paths without a greeting or probe process. Default probing is unchanged for doctor and installer. The checked-cache and explicit-path refusal rules are shared by both modes. `src/runner/run-media.ts` resolves asynchronously on acquisition and starts with `installHint: 'npx retest install media'`. `RunSession` only creates this lazy acquisition when recording is requested. Explicit locations with an injected `StartMedia` retain their stand-in behavior; the optional internal discovery injection supports off-run/refusal checks.

Failing-first command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test --test-name-pattern='discovery resolves' .retest/runner-glue/media-locate-before.test.ts`, exit 1, `step-2-before.log`. The saved pre-change locator starts the marker binary and refuses its exit instead of returning paths. Verification: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/media-locate.test.ts tests/unit/runner-media-lifecycle.test.ts tests/unit/runner-recording.test.ts`, exit 0, `step-2-unit-fixed.log`. The initial run (`step-2-unit.log`) found that the new off-run fixture had no required assertion; the fixture now asserts the visible save control, preserving the normal runner requirement. The focused suite covers damaged-cache refusal, no off-run discovery, retained application outcome, injected starts, worker replacement and cancellation during readiness. No real installed media binary was exercised here.

## Step 3 result

The store now names recording videos and partial files with test/attempt/app/session identity. Event references reconcile retention requests and failures; result references omit removed videos while retaining named partial files. The runner’s retention and the HTML recording view use the store’s shared `recordingArtifactReferences`; `folder-view.ts` removed its duplicate recording naming. Settled recording records contain no thumbnail field, so no thumbnail record was invented; existing `of` handling remains in the retention planner.

Failing-first command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test --test-name-pattern='recording artifact references' .retest/runner-glue/store-artifacts-before.test.ts`, exit 1, both new recording cases fail against the saved store, `step-3-before.log`. Verification: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/store-artifacts.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/runner-recording.test.ts`, 112 passed, exit 0, `step-3-unit.log`. Existing safe-read/traversal assertions are unchanged. `node_modules/typescript-7/bin/tsc -p tsconfig.json` leaves only the three external ownership-worker errors, `step-3-ts7.log`. The step 2 suite passed 43 tests; the commentary’s earlier 58 was incorrect.

## Step 4 result

Host-check and app-server readiness loops use `Deadline.reached` and `waitToEndMs`, recheck capped pauses, and dispatch the final probe on or after the clock limit. Running-test command/evaluation checks use `reached`; its timeout timer rearms when it wakes before the deadline clock reaches the limit. The app-server’s internal optional dependency argument lets unit tests supply a probe and server handle without launching anything.

Failing-first command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test .retest/runner-glue/runner-deadline-before.test.ts`, 0 passed/7 failed, `step-4-before.log`. The saved app-server received only the same probe/launch injection seam; its old wait loop was left intact. Current fake-clock command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/runner-deadline-clock.test.ts`, 7 passed, `step-4-clock.log`. Broader command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/runner-deadline-clock.test.ts tests/unit/runner-host-checks.test.ts tests/unit/runner-running-test.test.ts tests/unit/runner-command-lanes.test.ts tests/unit/runner-app-server.test.ts`, 68 passed, exit 0, `step-4-unit.log`. Both explicit compiler commands after the type corrections leave only external ownership errors, `step-4-ts6-fixed.log`, `step-4-ts7-fixed.log`. No native platform was exercised.

## Step 5 result

Both interrupted exits in `src/runner/run-session.ts` merge native summaries with one summary for each prepared web session missing from those summaries. Enabled capture names console and network `unavailable` with `the run was interrupted before capture started`; disabled capture names both `disabled`. Each new summary emits `diagnostics.finished` with test/attempt/app/logical session identity. No scope, artifact, start event or new page is invented. The interruption stays the test failure.

Only the assigned page-opening test changed in `tests/integration/diagnostics-engines.test.ts`. The locked baseline attempt returned 75 without starting a test (`step-5-before.log`). This selected case uses fake browsers and real test subprocesses only, so its scoped commands need no heavy lock: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test --test-name-pattern='a run stopped while its web page opens' tests/integration/diagnostics-engines.test.ts`. The new expectation fails on the old runner, exit 1, `step-5-fake-before.log`; it passes with the fix, exit 0, `step-5-fake-fixed.log`.

Additional unit cases cover two prepared web apps, enabled/disabled capture, exactly one opening before cancellation, finish events, preserved interruption/exit 130, browser closure, and persisted-result agreement. `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/runner-diagnostics-interruption.test.ts tests/unit/diagnostics-run.test.ts tests/unit/runner-deadline-clock.test.ts`, final output `step-5-unit-final.log`. Earlier new-fixture runs failed: disabled capture cannot require completeness, and the recording fake intentionally bypasses the opening hook. The fixture now uses the ordinary fake browser and a valid disabled policy. Existing assertions were not changed. Explicit TS6 and TS7 commands pass (`step-5-ts6.log`, `step-5-ts7.log`); scoped TS7 after the final fixture adjustment also passes (`step-5-ts7-final.log`). The ownership worker’s errors have cleared without edits from this run.

## Step 6 design question

Seeking a video from a step requires executable script to assign the video’s `currentTime`. The safety tests require exactly one script element, the non-executable outcome JSON block, and reject executable scripts. Per the task, no seek script was built and those tests stay unchanged.

Decision needed: may the report add one fixed script authorized by an exact CSP hash and one escaped recording-clock JSON block, then update the safety contract to verify that exact script/data pair? The implementation would use `elapsedMs * 1000 - videoZeroUs`, subtract applicable shortened gaps, refuse incomplete gap mappings, and clamp only inside the recording interval. No report/application text would become code or a URL. This is a design question, not an implemented capability.

## Final refinements and checks in progress

The actual inspector’s `RunRecord` now keeps retention events on the test timeline only when both test and attempt identities are present; run-wide removals remain in the run list. The test filter narrows those required identities instead of dropping scoped retention. HTML gives these events explicit retention descriptions. The inspector regression covers every new recording/media/capture/retention variant. Its old switch was reproduced in an isolated file with only the added branches removed; `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test --test-name-pattern='the timeline names recording' .retest/runner-glue/inspect-before.test.ts` fails, `step-1-runtime-before.log`. Scoped TS7 passes (`final-refinement-ts7.log`); inspector/report tests passed 66 before the final explicit HTML retention descriptions (`final-inspector-report.log`). The media runner refusal regression now uses the real discovery function against an invalid cache record.

The final step 5 unit command passed 18 tests, exit 0, `step-5-unit-final.log`.

Final focused command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/inspect-looks.test.ts tests/unit/media-locate.test.ts tests/unit/runner-media-lifecycle.test.ts tests/unit/store-artifacts.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/runner-diagnostics-interruption.test.ts tests/unit/runner-deadline-clock.test.ts tests/unit/reporters-agent.test.ts tests/unit/reporters-human.test.ts`, 159 passed, exit 0, `final-focused-unit.log`. This includes the final explicit retention descriptions and real damaged-cache discovery regression. Safety assertions remain unchanged.

`python3 .retest/runner-glue/guard.py lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` first returned 75 because the lock was held; npm never started (`final-typecheck-attempt-1.log`). The scoped compilers were queued by their explicit paths while waiting, with outputs `final-ts6.log` and `final-ts7.log`.

The final raw compilers caught an edit in the HTML page-event predicate: retention description objects had also been inserted there by a broad replacement. Those objects are now only in the description switch. This was an assigned-file compile error and was repaired here; `final-ts6.log` and `final-ts7.log` record the failed intermediate check. The final scoped and locked checks below determine completion.

Final corrected inspector/report command: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/inspect-looks.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts`, 66 passed, exit 0, `final-inspector-report-fixed.log`. `node_modules/typescript/bin/tsc -p tsconfig.json` and `node_modules/typescript-7/bin/tsc -p tsconfig.json` both pass, exit 0, `final-ts6-fixed.log`, `final-ts7-fixed.log`.

Default probe compatibility: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test tests/unit/media-install.test.ts tests/unit/media-locate.test.ts`, 17 passed, exit 0, `final-media-install-unit.log`. No downloads were performed. Locked full-typecheck retries 2 and 3 returned 75 without starting npm (`final-typecheck-attempt-2.log`, `final-typecheck-attempt-3.log`). Retry 3 was made before the required full pause; later retries wait the full pause.

## Files edited by this run

- `src/cli/inspect/looks.ts`, `src/cli/inspect/test-timeline.ts`.
- `src/media/locate.ts`.
- `src/runner/run-media.ts`, `run-session.ts`, `run-host-checks.ts`, `running-test.ts`, `app-server.ts`.
- `src/store/artifacts.ts`.
- `src/reporters/run-record.ts`, `src/reporters/html/timeline-view.ts`, `folder-view.ts`, `recordings-view.ts`.
- `tests/unit/inspect-looks.test.ts`, `media-locate.test.ts`, `runner-media-lifecycle.test.ts`, `runner-recording-fakes.ts`, `store-artifacts.test.ts`.
- New unit files `tests/unit/runner-deadline-clock.test.ts`, `tests/unit/runner-diagnostics-interruption.test.ts`.
- Only the assigned page-opening test in `tests/integration/diagnostics-engines.test.ts`.
- This report and `runner-glue-state.md`.

No config/protocol/capture/driver/installer/evaluation/ownership implementation file was changed. Existing shared-tree work was preserved. `git diff --check` on the assigned paths passed. Verification helpers and isolated old-source copies are gitignored under `.retest/runner-glue/`.

The runner discovery regression also fails against the saved pre-change `RunSession`/`RunMedia`, with current test fakes rebased onto those isolated files: `python3 .retest/runner-glue/guard.py node --conditions=retest-source --test --test-name-pattern='a discovery refusal' .retest/runner-glue/runner-discovery-before.test.ts`, exit 1, `step-2-runner-before.log`. The old constructor ignores discovery and uses its stand-in start; the current runner invokes real discovery and refuses the damaged cache. No working file was replaced or restored for this check.

The remaining full-typecheck component, `node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json`, passes, exit 0, `final-examples-ts6.log`. Thus each command in the npm script has passed by its explicit path. The locked npm wrapper remains a separate verification item until it runs.

## Final result

Steps 1 through 5 are implemented. The optional seeking step stopped at the requested design question. `python3 .retest/runner-glue/guard.py lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` acquired the lock on attempt 4 and passed, exit 0, `final-typecheck-attempt-4.log`. This runs TS6 and TS7 on `tsconfig.json` and TS6 on the tasks example. No compile errors remain, including in files owned by other workers.

The final `git diff --check` on assigned source/test paths passed. Process audit queried every pid in `.retest/runner-glue/processes.log`; none remained present, `final-process-audit.log`. All tool sessions from this run have finished. No process was manually ended; production/unit ownership code closed the processes it launched. No benchmark, download, commit, stash, reset, revert, publication or remote/ownership change was performed.

## What remains unverified

- Real-browser/native/media recording execution after this glue change. The scoped interruption test uses fake browsers and real test subprocesses; it makes no platform claim. No full integration, conformance, native or benchmark suite was run.
- A successful checked-cache recording on a real installed media binary. Discovery without probing, checked-cache damage, default probe behavior and injected-start compatibility were exercised by unit cases.
- The second interrupted exit and a mixed native/web interruption were not independently forced by the new test. Both exits call the same summary merge, which preserves already returned native summaries; enabled/disabled multi-web interruption and event/result identity were exercised.
- Step-to-video seeking is not implemented. It requires the script/safety-contract decision above; strict HTML safety tests remain unchanged and pass.

Logs named throughout this report resolve under `.retest/runner-glue/logs/`. Saved old-source copies and verification helpers are under `.retest/runner-glue/`.
