# Conformance cases on Chrome, Firefox and WebKit

Written 5 October 2026 for the conformance lane of [release-0.1.0.md](../release-0.1.0.md), "Firefox and WebKit parity", item 2: run the fixed basic browser and method-conformance cases on Chrome, Firefox and WebKit, preserve defaults, regex and exact behaviour, strict matching, actionability and deadlines, and fix driver differences instead of editing assertions. The generated table is [docs/compatibility/conformance.md](../../../compatibility/conformance.md). The cases were then made stricter after [the review of the conformance cases](../reviews/phase-3-review-conformance-playwright.md), so that a case means the same on every engine; the sections below describe the cases as they are now, and the results before and after that change.

## What was built

- `tests/conformance/cases.ts`: the fixed list, 148 cases. 131 are tests in 33 files under `fixtures/conformance/`, each with its declared outcome; 17 are facts about whole runs. A declared outcome is `passed`, `skipped`, `left out` (by a filter or `test.only`), `not run` with a class, or a failure with its class, the operation it failed at (an action's command, an assertion's matcher, or `test` for the test's own budget) and, where the case names them, its step, which must itself have finished failed, the line of its file it is located at, and what its message says. The workflow cases F1.1 to F10.5 are the forty of [workflow-cases.md](../workflow-cases.md), their sources copied from the Chromium integration tests with only the interpolated values replaced; family 3's four cases are seven tests, F3.1a to F3.4b, and F8.1 is two, F8.1a and F8.1b.
- Facts beside an outcome check what the outcome alone cannot show. Every fact a Chromium workflow file checks is carried into the cases: each intended failure's step, line and message; the sign-ups the server received under each name (F6.1 to F6.4); the pages opened by the test's own actions (F9.1 to F9.4); each recorded select, check and uncheck, with whether it changed the control and how its input reached the page (F4.1, F7.1, F7.2, F7.4); each fill by its secret's name and each path signed in and out (F2.1 to F2.4); the state each setup saved, the state each test started from, and which tests the run restored a state for (F3.1a to F3.3b and run R16); the session cookie absent from the run folder once a state was saved (R17); and the test that needs a failed setup sending nothing to a page (F3.4b). The method cases gained the facts their titles promise: what the page heard after a refused action, read by an `afterEach`, which runs after a failure too (L6 clicks none, A12 and A13 hear no part of a click, A14 hears no wheel); the task app's own counts (A1 saves once, A4 submits once, U1 saves once); a page counter that shows a click came once, after the button was enabled (A8); the order and end of each step (T1, T2); the message where a title says "naming" (N5, S7, S11) and what covers a covered button (A9); a poll that must read again (S4).
- A deadline is now waited in full: a failed operation gives up no earlier than its time, and within a quarter of it, at least 250 ms, past it; a failed check looks at least twice (three times for F10.4 and F10.5, as their Chromium file asks). T7's failure must record the test's own 1.5 second budget, not the run's 20 seconds, and end within a second of it, which allows for ending the test's process.
- A case whose meaning rests on another requires it: U2 needs U1, F3.1b and F3.3a need the setup, F3.2 needs F3.1b, F3.3b needs F3.3a, P3 and P8 their setups, T8 and the three tests after a stopped or lost browser the case before them. Each premise must end as declared and start first, or the case differs. A secret's absence (R10 to R12) counts only after a fill of that secret completed in the run, and the cookie's (R17) only after a state was saved.
- F8.1: the contract no longer holds that a table row has no name. F8.1a reads the table by position and finds cells and a column header by name; F8.1b asks for `getByRole('row', { name })` and must be refused by name, at once, as `unsupported`. The runner refuses it for every web command on every engine before the page is asked (`namedRowProblem` in `src/runner/running-test.ts`), and F8.1b ends as declared on all three engines.
- `fixtures/conformance/`: one folder per run, each with its own `retest.config.ts` built from `config.ts`, which reads the engine, the executable and the task app's address from variables the runner sets. `unregistered.ts` types `state` and `apps` for these unregistered configs, as `fixtures/cross-platform` does for its flow: a registration would apply to the whole repository's TypeScript program.
- `tests/conformance/execute.ts`: makes the fifteen runs on one engine through Retest's command line from source, one of them through a host program that calls `runFiles` with session limits, against task apps and app servers it starts. It reads the task app's counts before and after each run, stops or ends the browser of the three failure-handling runs at the moment that matters, and judges each case from the run folder, the events and the task app's own counters only. Each run is checked as the CLI harness checks one: stdout is exactly the events, every passed assertion was judged by whom it must be, and nothing is left behind. A run that does not end within five minutes has its process group ended and is reported. `judgeGroupRecord` judges a kept run folder again.
- `tests/conformance/process.ts`: starts each run in its own process group and records every process the run launches beneath it through the ownership layer while the run lives, as the CLI harness does. It signals the run's own group while the run's process is unreaped; a browser it is asked to end has its main process ended alone, after a fresh reading beneath the run shows it is still the process recorded there, as `tests/integration/outside-kill.ts` does. A Firefox started through macOS Launch Services is no descendant of the run, so for it the start and command read when the run reported it, a command that names the run's own temporary folder, must still hold. Leftovers found after a run are ended only when they are recorded, and what could not be ended is reported.
- `tests/conformance/engines.ts`: Chrome always; Firefox and WebKit on macOS (Firefox from `RETEST_TEST_FIREFOX` or `/Applications/Firefox.app`, WebKit from `RETEST_TEST_WEBKIT` or Playwright's cached build 2359). On macOS a missing browser or driver fails the gate unless `RETEST_CONFORMANCE_OPT_OUT` names the engine (`firefox`, `webkit`, or both; Chrome always runs); an engine opted out is reported as not verified, by name, never as passed. On another platform Firefox and WebKit are not run, since 0.1.0 does not support them there, and the table says so. A run that refuses every test because no driver runs the engine is no longer "not available": every case differs. Firefox is started through Launch Services when this process may not read `~/Library/Application Support/Firefox`, as the Firefox driver's own tests do, and the table says so.
- `tests/conformance/run.ts` writes the table, then judges each engine in a test of its own, so one engine's differences never hide another's; `tests/integration/conformance.test.ts` fails when a case or a run differs from its declaration, or when an engine that was not excused did not run.

## Results

Generated on this machine with the tree at `b59eed5` and the uncommitted work of the other lanes, whose drivers were being edited while these runs were made; the results are those of drivers in progress.

| Engine | Identity | Before the cases were made stricter | After |
| --- | --- | --- | --- |
| Chrome | Chrome 154.0.8037.93, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | 144 of 145 cases, 15 of 15 runs | 147 of 148 cases, 15 of 15 runs |
| Firefox | Firefox 133.0.3, `/Applications/Firefox.app/Contents/MacOS/firefox`, through Launch Services | 141 of 145 cases, 15 of 15 runs | 146 of 148 cases, 15 of 15 runs |
| WebKit | WebKit 626.1.6+, build 2359, `~/Library/Caches/ms-playwright/webkit-2359/Playwright.app/Contents/MacOS/Playwright` | 144 of 145 cases, 15 of 15 runs | 142 of 148 cases, 15 of 15 runs |

The "before" run used the cases as the review found them; its one Chrome difference was F8.1, whose `toHaveCount(0)` on a row by name the runner now refuses. Its Firefox differences were A7, F3.1b (a page that could not be opened), F8.1 and F9.4 (an Enter not confirmed in time); WebKit's was F8.1. The table is the "after" run.

## Correction to the earlier record

The earlier record said X5 differed on all three engines and gave Chrome 144, Firefox 111 and WebKit 133 of 145. X5 has ended as declared on every engine since the runner's fix for a browser lost while a check looks. The table that record pointed to had been written by the WebKit lane's own run, and that run's log asserted only Chrome and Firefox, because the runner stopped at the first engine with differences; "WebKit 144 of 145" rested on the table alone. Each engine now has a verdict of its own.

## Driver findings

Each is a case that ends otherwise than declared on the engine named, with the stricter case that shows it. No declared outcome was changed for any engine.

### Chrome

1. N5, `toHaveURL fails naming both addresses`: the failed check gave up after 299.x ms of its 300 ms. The page reports a timeout a fraction of a millisecond early, the race the WebKit lane recorded for Chrome's page; it was hidden by the old deadline fact's 50 ms of early slack. Where: `src/browser/page.ts` or `src/assertions/look-until.ts` (`lookUntil` breaks on `deadline.expired`), the runner lane's.

### Firefox

1. A7, `the wheel scrolls an element to its end…`: `getByTestId('terms').scroll({ y: 2000 })` on `/actions/scroll` leaves Accept disabled for the whole check. Where: `src/browser/firefox/page.ts`, which scales the delta before `wheelAt` in `src/browser/firefox/input.ts`.
2. F8.1a: `getByRole('cell', { name: 'Grace Hopper' })` on `/workflow/team` is refused as `unsupported`: "Chrome names a cell from its text, and Firefox's accessibility tree does not". A cell by name is in the Release 1 locator scope and Chrome finds it. Where: `src/browser/firefox/accessible-names.ts:79`.

### WebKit

1. A11, `a click on a hidden element is refused when its time runs out`: the refusal came after 499.x ms of its 500 ms, before its time. Where: the WebKit page's action deadline in `src/browser/webkit/page.ts`.
2. F7.1 to F7.4: `getByLabel('Plan')`, `getByLabel('Product updates')` and `getByLabel('Weekly summary')` on `/workflow/preferences` are refused as `unsupported`: "the page holds a hidden <label>, whose text WebKit's accessibility tree still gives the control it labels and Chrome's does not". These four passed in the "before" run of the same cases, so the refusal arrived with the WebKit lane's edits during this round. F7.4 then never reaches its intended check. Where: the WebKit driver's label lookup under `src/browser/webkit/`.
3. F8.1a: `getByRole('cell', { name: 'Grace Hopper' })` is refused as on Firefox: "Chrome names a cell from its text, and WebKit's accessibility tree does not". Where: the WebKit driver's role lookup under `src/browser/webkit/`.

### Seen once more, on a loaded machine

The third run, with every run's own check spoiled by the harness's buffer, still judged each case. On a machine running more than three thousand processes it showed, beyond the findings above:

- Firefox: A5 and F4.1, `select(['Olives', 'Basil'])` and `select('High')` refused as `not_actionable` after the keys were typed; U1, the save button's click not heard (`saved-task` stayed empty, so no fill of the secret and no save was recorded); F8.1a, `getByRole('row')` itself refused: "native tables can be layout tables in Chrome and data tables in Firefox"; F9.3 and F9.4, an Enter that opened no page.
- WebKit: failed checks and actions that gave up long past their time (L7 2205 ms and S9 2115 ms of 1500, A12 931 ms and A14 1062 ms of 500, S6 579 ms and S10 685 ms of 300, T7 3015 ms of 1500); clicks the page did not confirm within 1.5 s (F2.4, F4.3, F5.2, F6.3) and a read that timed out (F1.1).

These rest on one run under unusual load; the timing ones in particular need a quiet machine to confirm.

### Outside the drivers

- `docs/plans/public-beta/workflow-cases.md` still describes F8.1 by a row that has no name in Chrome; the runner fix lane changed `tests/integration/workflow-lists.test.ts` to expect the refusal. The plan file is not this lane's.

## How the stricter cases were shown to catch their faults

`/tmp/retest-fix-k/judge-probe.ts` judges the kept Chrome `web` and `workflow` run folders with `judgeGroupRecord`, first as kept, then with one fault put into the record at a time, each the fault a finding names: a sign-up sent twice (F6.2), an Enter that submits twice (F9.1), F1.4 failing one line early or with another message, a state not restored (F3.3b, R16), a select set by script (F7.1), U1 failing (U2), no fill of the secret (R10), T7 running out the run's budget, S4's poll looking once, A8's counter reading 2, S7 giving up at 1460 ms, at 4400 ms or after one look, L6's afterEach reading "Buy milk", T1's steps out of order, T2 failing in the other afterEach, N5's message naming no address, and F8.1b not refused. Each made its case differ; the record as kept differed only in N5. Log: `/tmp/retest-fix-k/judge-probe.log`.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_CONFORMANCE_KEEP=/tmp/retest-fix-k/before-keep node --conditions=retest-source tests/conformance/run.ts` (the cases before this round) | exit 1: Chrome 144, Firefox 141, WebKit 144 of 145 | `/tmp/retest-fix-k/conformance-before.log`, table `/tmp/retest-fix-k/conformance-before-table.md` |
| the same with the stricter cases, first attempt | exit 1: every Firefox run but `web` and every WebKit run could not be made, as Retest's command line failed to start from source while other lanes edited it; Chrome's X4 and X6 differed because the browser's processes were ended one by one, children first | `/tmp/retest-fix-k/conformance-after-1.log` |
| the same, once the browser's main process was ended alone | exit 1: Chrome 147, Firefox 146, WebKit 142 of 148; 15 of 15 runs each | `/tmp/retest-fix-k/conformance-after-2.log`, run folders under `/tmp/retest-fix-k/after-keep-2/`, table `/tmp/retest-fix-k/conformance-after-2-table.md` |
| the same, a third time, after F8.1b's refusal was confirmed | exit 1: every run of every engine reported "stdout maxBuffer length exceeded" from the harness's own `ps` reading, a process table of about four megabytes on this machine; the harness now reads it with a larger buffer (`processesUsing` in `tests/integration/browser-harness.ts`). Its case-level results are listed below as seen on a loaded machine | `/tmp/retest-fix-k/conformance-after-3.log`, table `/tmp/retest-fix-k/conformance-after-3-table.md` |
| the same, a fourth and fifth time | could not judge: about 1,250 `bash -c python3` processes of another session (on the Gruvi repository) filled the process table, and Retest's own ownership reading failed at every browser launch ("The metadata process exceeded its output limit"); the fourth was also cut off by a restart of the host session | `/tmp/retest-fix-k/conformance-after-5.log`, table `/tmp/retest-fix-k/conformance-after-5-table.md` |
| `node --conditions=retest-source /tmp/retest-fix-k/judge-probe.ts` | every fault put into the record made its case differ | `/tmp/retest-fix-k/judge-probe.log` |

The table in `docs/compatibility/conformance.md` is the second run's, the last one that could judge every case; the case list and declared outcomes have not changed since.

## Not verified

1. Whether the WebKit label refusal of F7.1 to F7.4 stays: it appeared between two runs of the same cases while the WebKit driver was being edited.
2. The integration wrapper `tests/integration/conformance.test.ts` itself under the lock; `run.ts` runs the same `runEngine` for every engine.
3. Firefox through its default spawn route: this process may not read Firefox's data folder, so every Firefox run here used Launch Services. The lost-browser runs on Firefox ended as declared; which of the two checks in `endBrowser` let its main process be ended was not logged.
4. Linux: Firefox and WebKit are not run there by design; Chrome on Linux was not run.
