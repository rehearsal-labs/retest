# Fix lane: diagnostics tests, and the shared poll's early end

Brief: finish `codex/fix-round/diagnostics-tests-state.md`, the unit failures named for this lane, and the poll that gives up a hair early. Logs are in `.retest/scratch-fix-diagnostics-tests/logs/` (ignored by git). Old-code runs use scratch copies under `.retest/scratch-fix-diagnostics-tests/`, with the WebKit collector of `.retest/scratch-fix-webkit/old-tree` where named.

## Items

| Item | State | Test that fails on the old code |
| --- | --- | --- |
| `tests/unit/diagnostics-engines.test.ts` hangs | fixed in the test | the file never exits (`unit-diagnostics-engines-1.log`, stopped by hand after 46 s); exits now |
| WebKit message without a timestamp | fixed in the test, rule pinned | the two new no-time cases fail on the old collector (`old-webkit-collector-new-cases.log`) |
| `tests/unit/diagnostics-run.test.ts` failure | fixed in the test | the old case fails with the launch slowed by 400 ms (`slow-launch-diagnostics-run-original.log`) |
| `cli-help` and `cli-run` lists | updated | `before-cli-help.log` (2 fail), `before-cli-run.log` (1 fail) |
| `playwright-resolve` | stale test, updated | `before-playwright-resolve.log` (2 fail) |
| Poll ends before its deadline | fixed in `look-until.ts` and `deadline.ts` | two fractional-clock cases in `assertions-looks.test.ts` (`assertions-looks-before-fix.log`) |
| Chrome page answers early | fixed in `src/browser/page.ts` | `browser-page.test.ts` refusal case, 6 of 6 runs (`browser-page-before-fix*.log`) |
| D-4, D-10, D-13 | done | docs |

### The hang

- Cause, by reproduction: in the old file, `firefoxRig` (lines 155-162) and the Firefox branch of `latePage` (lines 472-476) open a `ScriptedBidi` server and a `BidiClient` socket, then await `collector.start`. When start throws, neither is closed. The Firefox collector threw on every start at the time (`src/diagnostics/firefox-collector.ts`, the refusal in `start`).
- After the last case, the process still held one `TCPServerWrap` and two `TCPSocketWrap` handles. It stayed alive with no CPU (`repro-hang-open.log`). Closing the two lets it exit (`repro-hang-closed.log`).
- The hang is in the test, not in a collector. The new `startedFirefox` helper closes the client and the endpoint before it rethrows. Both Firefox rigs use it.
- The file now ends.
- On the way: with the hang fixed, 8 Firefox cases failed while the collector refused every start (`unit-diagnostics-engines-2.log`). Then 3 failed once it captured requests only (`-3.log`). Those 3 now carry the Firefox expectation below, and the file passes 34 of 34 (`-4.log`).
- While Firefox refused every start, its "answers late" case passed without proving anything, since no collector ever answered. Now the late collector subscribes, and the case checks that it is unsubscribed when it answers.

### WebKit timestamps

- The rig's console message now carries WebKit's own time (`timestamp: at / 1000`) in both its required and its optional form. A comment says why: WebKit's protocol leaves the field optional, and the collector counts a message without one as unread. The required-fields case and the unreadable-network case pass again on WebKit. They check the engine's time and a complete console, as before.
- Two new cases pin the rule:
  - a console message and an uncaught error without a time leave no record, the console is partial ("2 console events from the browser could not be read"), and the network stays complete;
  - a repeat count without a time leaves the stamped message once, and the console is partial.
- Both fail on the old collector, which stamped Retest's own clock. Both pass on the current one.

### diagnostics-run

- The failing case is "a run stopped while a page is slow to start its capture…". It sent SIGINT on a fixed 300 ms timer. On a busy machine that stop lands before the scenario the title names. Two failures were seen in the full unit runs (`/tmp/retest-fix-agent/unit-all-restart-1.log`, `-2.log`, `/tmp/retest-fix-install-logs/gate-test-unit.log`):
  - stopped during collection: the result has no "saves a task";
  - stopped while the page opened: the test has no `diagnostics` summary.
- Both reproduce by moving the stop earlier: 5 and 60 ms give the first, 150 ms the second (`repro-diagnostics-run-stop-*.log`).
- Fix, test only: the stop now comes 100 ms after the page's `collectDiagnostics` was called. No expectation changed.
- The behaviour the case meets is documented: a run stopped while a page is starting its capture waits for no page, the test is interrupted, and that capture is `unavailable` (`docs/guide.md`, Records section; `proofs/diagnostics.md:123, 177`).
- The old case fails with a launch slowed by 400 ms. The new one passes (`slow-launch-diagnostics-run-*.log`). The file passes 9 of 9.
- Not documented, so reported and not asserted: what a stop at an earlier point leaves. See "In other lanes' files", item 6.

### CLI lists

- `report` is registered (`src/cli/cli.ts:25`). It appears in the general help as `report <run-folder>` and has its own help (`cli-general-help.log`, `cli-report-help.log`).
- `cli-run`'s failure is a different change from the same Phase 4 lane: the `html` reporter (`src/cli/commands/run.ts:31`). The run help documents it (`cli-run-help.log`).
- Updated:
  - `cli-help.test.ts`: the unknown-command and option-first lists;
  - `cli-help.test.ts`: the general help now must list `install <engine...>` and `report <run-folder>`, and the run help must name `human, jsonl, agent or html`;
  - `cli-run.test.ts`: the reporter list.
- Now 11 of 11 and 35 of 35.

### playwright-resolve

- A stale test, not a product defect. The founder's signed commit `9b38691` added `.tsx` and `.jsx` candidates (`src/loader/resolve.ts:15-16`), so a JSX source is refused by name before a JavaScript sibling can load. That commit updated `tests/unit/loader-resolve.test.ts` to the new order (16 of 16 pass) but not this file.
- Updated: the folder lookup order, and a missing import now asks 11 times. The exact list of the 11 is asserted, besides the count. Now 4 of 4.

### The shared poll's early end

- Cause, in `src/assertions/look-until.ts`, on the old code:
  - `:76`: `if (deadline.expired) break`. `Deadline.expired` is `remainingMs === 0`, and `remainingMs` is `floor(end - now)` (`src/protocol/deadline.ts`). On `performance.now()`, which reads fractions, the deadline therefore reads expired up to a millisecond before its end.
  - `:56`: the wait before a look is `min(pollDelay, remainingMs)`, also rounded down. A wait cut to the deadline ends up to a millisecond early, and a Node timer can fire a fraction early by that clock too.
  - So a look that answers inside the last millisecond ends the poll there. The event's `durationMs` (`elapsedMs`, rounded) reads 1499 of 1500.
- Not the driver. The S11 run kept by the Firefox lane shows `check_failed` after 4 looks at 299 ms (`/tmp/retest-fix-firefox/round3/conformance-chrome-runs/chrome/web/run/events.jsonl`). Chrome's look path already holds a CDP timeout until its budget has passed (`page.ts:443`).
- Fix at the cause:
  - `Deadline` gains `reached` (the clock reads the end or later) and `waitToEndMs` (the time left, rounded up). `expired`, `remainingMs` and `commandTimeoutMs` are unchanged for their other callers.
  - `lookUntil` waits `waitToEndMs` and stops only when `reached`. A look's timeout still counts as the deadline when `expired`: the look was given the whole milliseconds left, so an honest timeout can come with a sliver to go. The loop then looks once more at the end.
  - With an integer clock nothing changes, so every manual-time test stands.
- Tests:
  - `assertions-looks.test.ts`, two cases on a clock that reads fractions: looks of 0.1 ms, and the same with every wait ending 0.6 ms early. On the old code the last look was sent at 119.2 and at 119.0 of 120 ms, and the assertion gave up after 119 ms (`assertions-looks-before-fix.log`, `assertions-looks-duration-before-fix.log`). Both pass now.
  - `deadline.test.ts`: two cases for `reached` and `waitToEndMs`.
- Does this make WebKit's `waitedWholeBudget` hold redundant? No. `lookUntil` runs in the test process and covers assertions only. The hold covers what the driver tells inside one command: an action's refusal at the end of its own actionability wait (A12), and a look's driver call that times out early by more than the sliver `lookUntil` tolerates. Such a timeout still stops an assertion as `timeout`, not `check_failed`.

### Chrome's page (the coordinator's addition)

- S11 is the poll above, not `page.ts`. It passed in all 10 valid Chrome runs after the fix.
- What `page.ts` did answer early is an action's refusal. `waitUntilActionable` stops when `deadline.expired` (`src/browser/actionability.ts:96-97`). Its last look's CDP timeout becomes the refusal (`:104-107`). The refusal says `waitedMs` equals the budget, and `#execute` passed it through with no hold.
- Fix in `src/browser/page.ts` `#execute`: a failed result that comes when the deadline reads expired, or that says it waited its whole budget (`waitedWholeBudget`, the WebKit page's rule), is told only once `startedAt + timeoutMs` has passed. A stop during that wait ends it with the stop's own class. A failure that comes early, such as an ambiguous match, is not held.
- The root, the floor in `actionability.ts:96-97`, is not this lane's file. See "In other lanes' files", item 3.
- Tests in `tests/unit/browser-page.test.ts`:
  - "a click on an element that never appears is refused only once its whole budget has passed, every time": 40 refusals at 20 ms. On the old code it failed 6 of 6 runs, with 1 to 8 refusals early each, the earliest at 19.16 ms. It passed 4 of 4 runs after the fix.
  - "a refusal that comes at once, before the budget runs out, is not held".
- The browser unit files pass 371 of 371.

### Firefox expectations (the coordinator's second addition)

The Firefox collector now records requests only, and names its console unavailable through the collection's `unavailable` field. The two diagnostics files now expect that, from the Firefox report's "Second pass" list. They do it through one explicit table, not by reading what the engine declares, so Chrome and WebKit cannot pass a console check by declaring less.

- `tests/unit/diagnostics-engines.test.ts`:
  - `consoleUnavailable` names Firefox's reason (`firefoxConsoleUnavailable`).
  - The three cases that expected console records now assert, on Firefox: the collection names the console unavailable with that reason, its scope covers no console area, and nothing the page logged reached the capture. The network part of each case runs on every engine.
  - 34 of 34 (`unit-diagnostics-engines-4.log`).
- `tests/integration/diagnostics-engines.test.ts`: `expected` holds the two differences the release decided, Firefox's missing console and its worker requests named by the page. Each item of the list:
  1. Console levels, message text, other console calls, uncaught error and rejection: each is a `consoleCheck`. On Firefox it asserts the console is `unavailable` with the reason and holds no console record or runtime error.
  2. The frame and worker console subtests are `consoleCheck`s too. On Firefox they assert the kind is unavailable, so they no longer pass on an empty capture. On the other engines the scope must match what arrived, so a covered area must leave its record.
  3. "The capture is complete…": the network must be complete. On Firefox the console must be unavailable with the reason and cover no area. On every engine the artifact's end marker must state what the summary states (new).
  4. The worker's network: on Firefox the page's own fetches must be exactly 3, the worker's counted as the page's. Its scope's reason must say so.
  5. Counts: no console counts, and no console record, on an unavailable console.
  6. Navigation, two apps, the pooled browser, a stopped run, the limits, a lost browser, an ended capture: these already had network markers (each marker page fetches `/diagnostics/marker/<name>/data`), now asserted on every engine. The console markers are asserted where there is a console.
  7. Secrets: the network path, `/diagnostics/echo/{{password}}`, is asserted on every engine, and the console paths where there is a console.
  8. Strict policy: on Firefox a runtime-error rule fails as `reporting_failed` with the exact "could not judge" message naming the unavailable console. A new run on every engine shows network rules judging alone: with each match allowed, the test passes.
  9. Quiet page: on Firefox the console is unavailable and the network complete, with only the document.
- The failing-test case also gained network checks on every engine: no request from the other test's page, and the failed test's own `/diagnostics/broken`.

### D-4, D-10, D-13

- D-4, `docs/guide.md`, "Per engine": rewritten to name what ran per engine. It names the thirteen cases, the strict policy and the failing test on Chrome and WebKit, and what ran on Chrome only (the byte limit, the oversized cut, a renderer crash, reports, `inspect`). It drops "the policy work the same". The WebKit differences are restated from the current collector. Firefox is described as it is now, requests only, from the Firefox runs here. The intro says the same.
- D-10, record finding 8: "Honest" dropped. The finding now says what the unlabelled frame records could do, and how it was fixed.
- D-13, record and build report:
  - the fixture case had 12 subtests (Firefox failed 5 of 12, 6 of 13 counting the case);
  - the pixel judge is matched by hash, the fake judge by size in bytes and dimensions only.
- The progress row still says "the fixture page as 13 checks" (`progress.md:164`). That file is the orchestrator's, so it was left alone.
- "After the review" sections were added to the record and to the build report.

## Gates

Logs are in `.retest/scratch-fix-diagnostics-tests/logs/`. The heavy gates ran through `.retest/scratch-fix-diagnostics-tests/gates.sh` and `gates-more.sh`. Those run each gate as `lockf -t 0 /tmp/retest-heavy-gate.lock <command>`, retry every sixty seconds while the lock is held, and wait while `pgrep -f benchmarks/run.ts` matches. That pattern also matched other agents' shells whose commands held the text; no benchmark ran.

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| Collector contract, unit | `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts` | before: never exits; after the hang fix 26 of 34, then 31 of 34 on the network-only Firefox collector; after the Firefox expectations 34 of 34 | `unit-diagnostics-engines-1.log` to `-4.log` |
| New WebKit cases on the old collector | the same file against `.retest/scratch-fix-webkit/old-tree/src/diagnostics/webkit-collector.ts`, pattern `webkit\|WebKit` | 10 of 12, the 2 new cases fail | `old-webkit-collector-new-cases.log` |
| diagnostics-run | `node --conditions=retest-source --test tests/unit/diagnostics-run.test.ts` | 9 of 9; the old case with a slowed launch fails, the new passes | `after-diagnostics-run.log`, `slow-launch-diagnostics-run-{original,current}.log` |
| CLI and resolver | same, `cli-help`, `cli-run`, `playwright-resolve` | before 9/11, 34/35, 2/4; after 11/11, 35/35, 4/4 | `before-*.log`, `after-*.log` |
| Poll and deadline | same, `deadline`, `assertions-looks`, `assertions-poll`, `agent-looks`, `inspect-looks`, `runner-page-looks`, `runner-lost-look`, `runner-parent-look-verdict` | 92 of 92; the two fractional-clock cases fail on the old code | `look-and-deadline-units.log`, `assertions-looks-before-fix.log` |
| Chrome page | same, `tests/unit/browser-*.test.ts` | 371 of 371; the refusal case fails 6 of 6 runs on the old code | `browser-units-after-fix.log`, `browser-page-before-fix*.log` |
| Whole unit suite | `npm run test:unit` | first 3587 of 3591, the failures being 3 Firefox cases (since changed) and `native-ios-simulator.test.ts:100`. Last 3720 of 3735: 15 failures, none in this lane's files, in nine files of other lanes. Run alone those files give 186 of 187; the one left fails in `runner-recording.test.ts:465`, which is in progress in another lane | `unit-all-1.log`, `unit-all-2.log`, `unit-all-2-failing-alone.log` |
| Type tests | `npm run test:types` | exit 1, only `src/runner/run-media.ts:176`, another lane's | `types-1.log` |
| Typecheck | `npm run typecheck`, then `node_modules/typescript-7/bin/tsc -p tsconfig.json` and the examples' tsconfig apart, since the script stops at the first compiler | last round, both compilers: no error in this lane's files, no `FATAL`, errors only in other lanes' files. Earlier rounds caught two of mine, both fixed: `page.ts:446` (a narrowed signal) and `diagnostics-engines.test.ts:540` (TS7022). Examples clean | `typecheck-{1..4}.log`, `typecheck7-{2..4}.log`, `typecheck-examples-2.log` |
| Diagnostics, Chrome | `node --conditions=retest-source --test --test-concurrency=1 '--test-name-pattern=^Chrome: ' tests/integration/diagnostics-engines.test.ts` | 30 of 30 in three rounds, the last on the final file | `diagnostics-chrome-{1,2,3}.log` |
| Diagnostics, WebKit | the same with `^WebKit: ` | 30 of 30, twice, the last on the final file | `diagnostics-webkit-{1,3}.log` |
| Diagnostics, Firefox | `env RETEST_FIREFOX_ROUTE=launch-services`, the same with `^Firefox: ` | before the expectations 11 of 30 (the console unavailable, and the worker's fetch counted as the page's); after, 30 of 30 | `diagnostics-firefox-{2,3}.log` |
| Chrome actions | `env RETEST_TEST_ENGINE=chromium node --conditions=retest-source --test --test-concurrency=1 tests/integration/browser-actions.test.ts` | 80 of 80, with the page's hold | `browser-actions-chrome-2.log` |
| Conformance, Chrome, ten times | `env RETEST_CONFORMANCE_OPT_OUT=firefox,webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/conformance.test.ts` | S7, N5, F10.5 and S11 passed in all 10 valid runs. Run 7: every case passed, but the `web` group's run exited 2 instead of 1 and left two Chrome profiles in its temporary folder, cause not established. Run 10 is void: another lane's half-written `src/store/rebuild-result.ts:156` ("Identifier 'recorded' has already been declared") stopped the CLI from loading, so no case ran. Run 11 replaced it, once that file loaded, with 164 of 164 | `conformance-chrome-{1..11}-2.log`, `tally-conformance.sh` |

## In other lanes' files

1. `src/assertions/poll-value.ts:42` and `:50` (`expect.poll`): the same rounded-down wait and the same `deadline.expired` stop, so a poll can end up to a millisecond early. Read, not run. A fractional-clock case like those in `assertions-looks.test.ts`, written against `expect.poll`, would show it.
2. `src/native/assertions.ts:244`, `:257` and `:260`: the same pattern in the native assertion loop.
3. `src/browser/actionability.ts:96-97` and `:104-107`: the root of Chrome's early action refusal. `reached` and `waitToEndMs` would end it there. `page.ts` now holds the refusal either way.
4. `tests/unit/native-ios-simulator.test.ts:100`: failed in the full unit run ("no process the fakes started is left", pid 39121, gone when checked). It passes 27 of 27 alone (`native-ios-simulator-alone.log`). Load-dependent.
5. `src/runner/run-session.ts:934-938`: a run stopped while an attempt's pages open leaves the test with no `diagnostics` summary at all, since web capture starts only once every page is open. A run stopped during collection lists no test for the file. Neither is documented. Reproduce: `repro-diagnostics-run-stop-150.log` and `-5.log`.
6. `docs/plans/public-beta/progress.md:164`: "the fixture page as 13 checks" should read 12.
7. `src/diagnostics/webkit-collector.ts:395` (this lane's file, left as it is): a resource served from WebKit's memory cache is stamped with `Date.now()`, Retest's clock, though the event carries WebKit's monotonic `timestamp`. It breaks the same rule as D-8. Not changed, because no real-engine run here shows a memory-cache hit.

## Not verified, most important first

1. WebKit, where S7 was seen, did not run the conformance cases after the poll fix. Only Chrome ran them, ten times. The early end was intermittent before: on Chrome in 1 of 3 earlier rounds, and S11 once in the Firefox lane's rounds. Ten clean runs are evidence, not proof. The fractional-clock unit cases are the proof of the mechanism.
2. Conformance run 7's `web` group exited 2 and left two Chrome profiles, with every case passing. No run folder was kept, so the cause is not known. A link to this lane's changes was not found and not ruled out.
3. On Chrome, no real-browser test times a refusal against its budget. The new hold is shown with a scripted session, and `browser-actions` passed 80 of 80 with it. A12 on Chrome was not seen failing before or after.
4. `expect.poll` and the native assertion loop keep the rounded-down end ("In other lanes' files", items 1 and 2). They were read, not run.
5. Every Firefox run used Launch Services. The spawn route was not exercised.
6. The console frame subtests on Chrome and WebKit require a record only where the engine's scope covers the area. An engine whose scope stopped covering an area, and whose record stopped arriving, would still pass them. Closing that would need a per-engine table of covered areas in `tests/integration/diagnostics-engines.test.ts`.
7. What an earlier stop leaves in diagnostics-run's scenario is undocumented ("In other lanes' files", item 5).
8. WebKit memory-cache records still carry Retest's clock ("In other lanes' files", item 7).
9. The whole integration suite was not run; only the files named above.

## Files changed

- Tests:
  - `tests/unit/diagnostics-engines.test.ts`: `startedFirefox`, the WebKit timestamp, two new WebKit cases, and Firefox's console expectation (`consoleUnavailable`, `assertNoConsole`);
  - `tests/integration/diagnostics-engines.test.ts`: the `expected` table, `assertNoConsole`, `assertConsoleHolds`, `consoleCheck`, the nine Firefox changes, the end-marker check, the network-only strict run, the failing test's network checks;
  - `tests/unit/diagnostics-run.test.ts`: the stop on capture start;
  - `tests/unit/cli-help.test.ts`, `tests/unit/cli-run.test.ts`, `tests/unit/playwright-resolve.test.ts`;
  - `tests/unit/assertions-looks.test.ts` and `tests/unit/deadline.test.ts`: new cases;
  - `tests/unit/browser-page.test.ts`: two new cases.
- Source:
  - `src/protocol/deadline.ts`: `reached`, `waitToEndMs`;
  - `src/assertions/look-until.ts`;
  - `src/browser/page.ts`: the hold in `#execute`, `waitedWholeBudget`, `stopped`.
- Docs:
  - `docs/guide.md`, "Console and network diagnostics": the intro sentence and "Per engine";
  - `docs/plans/public-beta/proofs/engines-diagnostics.md`;
  - `docs/plans/public-beta/codex/phase-3/build-engines-diagnostics-report.md`.
- Scratch, ignored by git: `.retest/scratch-fix-diagnostics-tests/`.
- No dependency, script or environment change.
