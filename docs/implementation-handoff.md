# Retest implementation handoff

This file has two parts. Part 1 is milestone 1's handoff, as that phase left it. Part 2 is milestone 2's, written by its verification phase on 30 September 2026. How to use Retest now is in [the guide](guide.md).

# Part 1: Milestone 1

30 September 2026. The verification phase wrote the first version from checks it ran itself. The originating session then reviewed the work, in `docs/plans/milestone-1/review.md`, and two fix waves followed it. A re-check of those waves found three more problems, N1 to N3, and a third wave fixed them. Section 10 lists every finding and what became of it. The commands and counts in section 5 come from the third wave's run, from 14:56 to 14:59 local time. The evidence runs in section 6 were made at 14:27, before it; their events and results still validate against the extended schemas.

## 1. What works

Retest loads `.retest.ts` files, runs each file in its own Node process, launches one Chromium or Chrome for the run, drives a page through its own CDP client over `--remote-debugging-pipe`, checks the page, writes a run folder and sets the exit code from the results. The command line has `list`, `run` and `inspect`.

Verified through the command line as a real subprocess, against real Chrome and a local fixture app:

- `examples/task.retest.ts`, the example from brief section 5, passes against the working fixture with exit 0.
- The same unchanged test fails against the broken fixture with exit 1. It prints a failure card with expected and received text, the comparison rule, a code frame, a screenshot path, a rerun command and an `inspect` command. The screenshot is a real PNG.
- Every row of the section 9 matrix has a real-browser check, listed in section 7 below.
- SIGINT and SIGTERM both stop a run cleanly: the result is written, the browser and its profile are gone, and the exit code is 130 or 143.
- A packed tarball installs offline outside the repository, typechecks by its public name with TypeScript 6 and 7, and its installed `retest` binary passes and fails the example with exit 0 and 1.

The environment every check ran in:

| Item | Version |
| --- | --- |
| Operating system | macOS, Darwin 27.0.0, arm64 |
| Node.js | 24.12.0 |
| npm | 11.6.2 |
| Browser | Google Chrome 154.0.8037.92, headless, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Runs before 03:23 on 30 September used 154.0.8037.58, until Chrome updated itself |
| TypeScript | 6.0.3 and 7.0.2 |

Nothing ran on Linux, Windows, Chromium builds other than this Chrome, a CI runner, or a headed browser.

## 2. Files and modules

The runtime, in `src/`:

| Folder | What it does |
| --- | --- |
| `src/index.ts` | Public exports: `test`, `expect` and their types |
| `src/api/` | The authoring API that runs in the test file's process: `test`, `test.step`, `page`, locators, the per-test run that tracks every action and assertion, and source locations |
| `src/assertions/` | `expect`: immediate `toBe`, and `toBeVisible` and `toHaveText` that poll the page |
| `src/protocol/` | Pure types and schemas: the schema builder, locators, failures, page commands, IPC messages, version 1 events, the stored result, run folder names, timeouts and deadlines. No Node imports; a test enforces it |
| `src/shared/` | Small Node-level helpers that the browser and the runner both need: `posix-path.ts`, `process-exit.ts` and `error-code.ts` |
| `src/runner/` | The parent's lifecycle: one child process per file, collection with a budget, test deadlines, revocation and kills, outcomes and exit codes. `child.ts` is the child's entry |
| `src/browser/` | Launch, the Chromium process group, temporary profiles, contexts, pages, navigation, actionability, input guards, input, observation and screenshots |
| `src/browser/cdp/` | The pipe transport, the connection, sessions and CDP errors |
| `src/reporters/` | Human, JSONL and agent output, failure cards, diffs and code frames. Reporters read events and never decide an outcome |
| `src/store/` | Writes the run folder: `events.jsonl` line by line, logs, screenshots, and `result.json` last |
| `src/cli/` | Argument parsing, the three commands, help, agent detection, interrupts and `inspect`'s reader |

`scripts/write-schemas.ts` writes `dist/schemas/event-v1.schema.json` and `result-v1.schema.json` during the build.

The verification phase added:

| Path | Purpose |
| --- | --- |
| `examples/task.retest.ts` | The example from brief section 5, word for word |
| `fixtures/tests/*.retest.ts` | The scenario files the checks run, plus `tests-in-process.ts`, a module counter for the isolation check |
| `fixtures/task-app/page.ts` | The page shows the title saved on an earlier visit, from `localStorage` (`last-saved`), and a load count for its tab, from `sessionStorage` (`page-loads`) |
| `fixtures/task-app/modes.ts` | `frozen` mode (the save press is counted, then the page never answers) and `noisy` mode (the page logs event-shaped text to its console). The `replaced` mode shows a `save-replaced` marker once the button is swapped |
| `tests/integration/cli-harness.ts` | Starts `retest` in its own process group with its own `TMPDIR`, reads stdout and the run folder through the protocol schemas, and checks what each run left behind |
| `tests/integration/matrix-*.test.ts` | The section 9 matrix, one behaviour per test |
| `tests/integration/cli-commands.test.ts` | Help, version, unknown options, `list --json`, a used output folder, the failure card with its `inspect` command, the agent report, and `test.step` in the real browser |
| `tests/integration/package-smoke.test.ts` | The external-consumer check |
| `README.md` | Instructions another session can follow |

The fix waves changed code across `src/` and added a test beside each fix. Section 10 names them.

## 3. Departures from the brief

Section 13 of the brief overrides earlier sections. These section 13 decisions are in the code:

1. Test files end in `.retest.ts`. The command line refuses any other name, including `.retest.js`. JavaScript syntax inside a `.retest.ts` file works. This replaces section 5's "ordinary ESM JavaScript tests".
2. `test(name, options?, fn)`, where `options` takes only `timeout`. Any other key fails collection with `usage`, and the types reject it.
3. `expect` is one function. Promises, `any` and value matchers on locators are compile errors through `RetestTypeError`. The package smoke test confirms the published declarations keep this. `Secret` is not in milestone 1: no `Secret` type exists yet, so passing one to `expect` is not a compile error, as brief 13.3 asks. Nothing in the API marks a value as secret; `fill` values stay out of events because of `valueLength`, not because of a type.
4. `toHaveText` trims both ends and reads each run of whitespace as one space. Every failure prints the rule.
5. One command at a time per page. A clash fails at once with `concurrent_commands`, naming both lines.
6. Event schema version 1. Locators are a JSON union, action and assertion events carry the page URL as origin plus path when there is one, `session` is always `page`, and `inconclusive` exists but is never produced. `pageUrl` is absent on value assertions and before the first navigation. The failure classes are the eight listed plus `cleanup_failed`, `collection_failed`, `test_error`, `no_assertions`, `not_awaited`, `concurrent_commands`, `unsupported`, `usage`, `interrupted` and `reporting_failed`.
7. Exit codes: 130 or 143 first, then 2 when nothing trustworthy came out, then 1 when any test failed its checks, then 2 for errors, tests not run, cleanup failures and files that failed outside their tests, then 0.
8. Default budgets: collection 10 s, setup 60 s, action 10 s, navigation 30 s, assertion 5 s, test 60 s, cleanup 10 s. Every integration test passes short explicit budgets.
9. A failure prints as one card: class, locator, expected and received text with a diff, the comparison rule, what Retest waited for, a code frame, the screenshot path, a rerun command and an `inspect` command. When a coding agent's variable is set, the terminal shows a short report ending in a `next:` line, and `--no-agent` turns that off.
10. The transport is `--remote-debugging-pipe`.
11. No sleep, `force`, element handles, `first()` or `nth()`.
12. TypeScript 6 and 7 both typecheck the source and run the compile-fail fixtures.
13. No browser download.

Other decisions the implementation made:

- One browser per run, launched when the first test needs it. Each test gets a new browser context and page. A lost browser is not relaunched; later tests become `not_run` with `session_lost`. This follows the milestone 1 build plan.
- Any test timeout ends the file's process, and the rest of that file becomes `not_run`, even after a cooperative timeout. Brief section 6 asked for this only after an uncooperative timeout. The code gives the reason: code from the timed-out test may still be running in that process. The next file still runs, in a new process.
- SIGTERM exits 143. Brief section 8 names only 130 for SIGINT; SIGTERM takes the same recorded path, and `ExitCode` includes 143.
- A file whose process fails outside its tests (an error after its last test, or an ending no test explains) has a `failure` of its own in `result.json`, with collection `ok`, and a `file.failed` event that `inspect` reads when there is no `result.json`. It makes the run incomplete and exit 2. `list` reports it the same way.
- A test whose file's process ended before its body started is `not_run`, even when its page was already opening, and gets no screenshot. So is every later test in the file.
- A command stopped because its test was revoked fails with the revocation's class: `timeout` for a test that ran out of time, `interrupted` for Ctrl+C or SIGTERM. Its `details.inputSent` says whether input had gone.
- Two fixed graces of 1000 ms sit beside the seven budgets: the abort grace for a test file's process and for a page whose browser was lost, and the close grace for a browser whose process group Retest killed.
- A file that declares no tests fails collection with `collection_failed`, so a run of it exits 2.
- `run.finished` and `result.json` carry an optional run-level `failure` for problems no single test explains, such as a browser that did not start or a file with no tests.
- `browser.started` carries `pid`, which is also the browser's process group, and `executablePath`.
- Profiles are named `retest-profile-<pid>-*` in the system temporary folder. Each launch first removes profiles whose owning process is gone, which is what a killed run leaves.
- The failure screenshot shares the cleanup budget. Screenshots are named `<test slug, up to 40 characters>-<10-character attempt id>-failure.png`.
- The tests left in a file after a timeout become `not_run` with a `timeout` failure that names the test that timed out.
- `inspect` gives a result it rebuilt from events a run-level failure: `interrupted` "The run stopped before it finished." when there is no `run.finished`, or `reporting_failed` when the run finished without writing `result.json`.
- A crashed page or an open JavaScript dialog makes the command waiting on that page, and every later command on it, fail at once instead of running out its budget.
- A reporter failure names the reporter, as in "The jsonl reporter failed on browser.started: ...", and becomes the run's `reporting_failed` failure with exit 2. That includes stdout closing under the report. A closed stderr changes nothing.
- The agent report writes status words in lowercase: `fail`, `error`, `not run`.
- `run` refuses an output folder that already holds files.
- The base URL keeps its user name and password for the browser, and loses them everywhere Retest records or prints it.
- The cleanup failure row is checked through the real browser with a 1 ms cleanup budget, a documented option, rather than a production flag. Section 7 explains.

## 4. Dependencies

There are no runtime dependencies. `package.json` has no `dependencies`, `optionalDependencies` or `peerDependencies`, and the package smoke test confirms that installing the tarball adds no other package.

Development dependencies, pinned in `package-lock.json` (lockfile version 3):

| Package | Version | Kind | Why |
| --- | --- | --- | --- |
| `typescript` | 6.0.3 | direct | Build, typecheck, compile-fail fixtures |
| `typescript-7` (`npm:typescript@7.0.2`) | 7.0.2 | direct | Typecheck and compile-fail fixtures on TypeScript 7 |
| `@types/node` | 24.19.0 | direct | Node types |
| `undici-types` | 7.24.6 | transitive, from `@types/node` | Types only |
| `@typescript/typescript-<platform>` | 7.0.2 | transitive, optional, from `typescript-7` | TypeScript 7's native compiler. The lockfile lists 20 platforms; only `@typescript/typescript-darwin-arm64` is installed here |

The fix waves added no dependency. `npm run build` now empties `dist/` with a Node one-liner before it compiles.

## 5. Commands and results

The final run, from the repository root, one command after another, from 14:56 to 14:59 on 30 September 2026, with Chrome 154.0.8037.92. No file in `src/`, `scripts/`, `fixtures/` or the tests changed after it.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | Empties `dist/`, then writes it, with `dist/schemas/event-v1.schema.json` and `result-v1.schema.json`. The event schema has 17 event types, `file.failed` among them. An earlier build with the same script removed a planted `dist/stale/leftover.js`; after the final one, the old `dist/posix-path.js` was gone too |
| `npm run typecheck` | 0 | TypeScript 6.0.3, then 7.0.2, no errors |
| `npm run test:unit` | 0 | 588 tests in 104 suites: 588 passed, 0 failed, 0 skipped, 13.0 s |
| `npm run test:types` | 0 | "33 expected errors matched 33 markers" on TypeScript 6.0.3, and again on 7.0.2 |
| `npm run test:integration` | 0 | 128 tests: 128 passed, 0 failed, 0 skipped, 78.5 s. This includes the package smoke test and its 6 checks |

`npm test` runs the last three in that order; the final run ran them one by one instead, to keep each exit code.

The integration tests use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` unless `RETEST_TEST_BROWSER` names another browser. The example commands are in section 6.

## 6. Evidence to open

Each run below was made once, from the repository root at 14:27, right after the final gate run, with Chrome 154.0.8037.92 and `--no-agent`, so the terminal shows the report for people. Beside each run folder, a `.txt` file keeps what the terminal printed. `.retest/` is ignored by Git. Every event line of the four runs validates against the version 1 event schema, and every `result.json` against the result schema.

| Run | Folder | Result |
| --- | --- | --- |
| Passing example | `.retest/example-runs/passing` | `passed`, exit 0, complete |
| Broken example | `.retest/example-runs/broken` | `failed`, exit 1, complete. `check_failed`, expected "Release checklist", received "Release checklis", 14 looks over the default 5 s assertion budget |
| Timeout | `.retest/example-runs/timeout` | `failed`, exit 1, incomplete. `loops forever` timed out after its 500 ms budget; its process did not stop within 1000 ms of being asked, so Retest ended it. `runs after the loop` is `not_run` with a `timeout` failure naming it |
| Browser disconnect | `.retest/example-runs/disconnect` | `error`, exit 2, incomplete. The browser group was killed while the click was unconfirmed. The page answered `outcome_unknown`: "Retest lost the page after it began to click getByTestId('save-task'), so it cannot tell whether that took effect: the browser closed the pipe." The click's `action.failed`, the test's `test.finished` and `result.json` carry that same failure. The fixture counted exactly one save. The screenshot is recorded as not taken because the browser was gone |

Screenshots:

- `.retest/example-runs/broken/artifacts/examples-task-retest-ts-sa-2i509v6rzrjac-whnccvb8b7-failure.png` shows the page with "Release checklis" under the Save button.
- `.retest/example-runs/timeout/artifacts/fixtures-tests-loop-timeou-1zarp9mn3i0zy-ob72km46e6-failure.png`.

How the runs were made, with `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` and the address the fixture printed as `$URL`. The old folders were removed first, since `run` refuses a used one:

```sh
node fixtures/task-app/cli.ts                    # prints $URL; --mode broken for the broken run, --mode frozen for the disconnect run
node --conditions=retest-source src/cli/main.ts run examples/task.retest.ts --browser "$CHROME" --base-url $URL --no-agent --output .retest/example-runs/passing
node --conditions=retest-source src/cli/main.ts run examples/task.retest.ts --browser "$CHROME" --base-url $URL --no-agent --output .retest/example-runs/broken
node --conditions=retest-source src/cli/main.ts run fixtures/tests/loop-timeout.retest.ts --browser "$CHROME" --base-url $URL --no-agent --output .retest/example-runs/timeout
node --conditions=retest-source src/cli/main.ts run fixtures/tests/browser-lost.retest.ts --browser "$CHROME" --base-url $URL --no-agent \
  --timeouts action=20000,assertion=20000,test=30000 --output .retest/example-runs/disconnect
# while the disconnect run waits on the frozen page, once `curl $URL/api/submissions` reports {"count":1}:
kill -KILL -- -<pid from the browser.started line of .retest/example-runs/disconnect/events.jsonl>
```

Read any of them back with `node --conditions=retest-source src/cli/main.ts inspect .retest/example-runs/broken`, adding `--json` or `--test "examples/task.retest.ts > saves a task"`.

## 7. Verification matrix

Every row was checked with the real `retest` command line as a subprocess, against Chrome 154 and the task-app fixture on an ephemeral loopback port, with short explicit budgets. The checks live in `tests/integration/matrix-*.test.ts`. After every run the harness also checks cleanup, as section 9 describes.

| Row | Real-browser check | What was observed |
| --- | --- | --- |
| Passing save | `matrix-outcomes`: passing save | Exit 0. Actions in order: `goto`, `fill task-title`, `click save-task`. `toHaveText` expected and received "Release checklist". Result `passed` and complete. One save reached the fixture. The fill event records `valueLength` 17 and no action event holds the typed text |
| Broken application | `matrix-outcomes`: broken application; `cli-commands`: failure card | Exit 1, `check_failed`, received "Release checklis", located at line 7. The PNG screenshot named in `result.json` and `evidence.captured` exists. The card shows the diff, the rule, the code frame and an `inspect` command, and that command reads the test back |
| Zero assertions | `matrix-outcomes`: zero assertions | Exit 1, `no_assertions`, assertion count 0, all three actions ran |
| Unawaited work | `matrix-outcomes`: four checks | An assertion still looking when the test returned fails with `not_awaited` "still running when the test returned". An unawaited assertion that failed is recorded as `not_found`, exit 1. A `test()` declared after the file loaded, and an `expect()` failing outside the running test's scope, do not leave a passing run |
| Empty selection | `matrix-selection`: two checks | A missing file exits 2 before any run starts, names the file, and makes no run folder. A file with no tests exits 2 with `collection_failed` "has no tests", a run-level failure, and no browser started |
| Collection error or hang | `matrix-selection`: two checks | A failed import exits 2 with `collection_failed` naming the missing module. An endless loop at the top of a file exits 2 after the 1000 ms collection budget, and the looping process is gone |
| Missing browser | `matrix-selection`: two checks | A path with nothing there: exit 2, the test `not_run` with `setup_failed` "No browser at /nonexistent/chromium.", `browser: null`, no save. The Node binary passed as the browser: `setup_failed` naming it |
| Duplicate targets | `matrix-targets` | Exit 1, `ambiguous` with `count: 2`, and no save reached the fixture |
| Covered target | `matrix-targets` | Exit 1, `not_actionable` with `{ check: 'hit-target', covering: '<div>', waitedMs: 500 }`, and no save reached the fixture. The input guard's own checks are below |
| Disabled or read-only field | `matrix-targets`: two checks | Exit 1, `not_actionable` "it is disabled" and "it is read-only". The test then saves, and the page shows "Existing task", the value the field already had |
| Replaced element | `matrix-targets` | A locator taken before the save button was swapped clicks the new button. Exit 0 and one save |
| Delayed result | `matrix-targets` | With a 1500 ms reply, the assertion looked more than once, waited at least 1400 ms and passed. One save |
| Submit counter | `matrix-targets` | A failing assertion looked at least 5 times over 1.5 s. One click event and exactly one save |
| Timeout | `matrix-lifecycle`: three checks | A test awaiting a promise that never settles, and a test stuck in an endless loop, both fail with `timeout` after their 500 ms budget. The rest of the file is `not_run`, with a `timeout` failure naming the test that timed out. The process id each file printed is gone. The next file in the same run still passes, in a new process |
| Browser disconnect | `matrix-lifecycle`: three checks | The harness reads `browser.started.pid` from the JSONL stream and kills only that process group. During an unconfirmed click: `outcome_unknown` from the page's own answer, the same failure on the click's event, the test and `result.json`, no completed click, and still exactly one save. While a click waits for its element: `session_lost` on all three, never `outcome_unknown`. During assertion polling: `session_lost`. All exit 2, and the later test is `not_run` with `session_lost` |
| Cleanup failure | `matrix-lifecycle`: cleanup failure | See below. Exit 1. The original `check_failed` stays the test's failure, and `cleanupFailures` holds `cleanup_failed` "Target.disposeBrowserContext got no response within 1 ms". The screenshot is recorded as not taken, with the reason |
| File and test isolation | `matrix-lifecycle`: isolation | Three tests in two files pass. The second test finds empty `localStorage` and a page-load count of 1 in its tab, so it has a new context and a new page. A module counter reads 2 in the second test of a file and 1 in the next file |
| Reporter integrity | `matrix-reporting`: three checks | Every stdout line validates against the version 1 schema and equals the matching `events.jsonl` line. Test output, event-shaped test output and the page's console text never reach stdout. The file's stdout, stderr and an unterminated line are in `logs/<file>.log`. When the reader of stdout goes away, the run exits 2, `result.json` records `reporting_failed`, and stderr says why. A reader that closes stderr leaves the report on stdout and the exit code alone |
| Report interruption | `matrix-reporting`: three checks; `run-interrupt`: three checks | After SIGKILL mid-assertion there is no `result.json` and no `run.finished`. `inspect --json` exits 0 and reports `complete: false`, `status: 'error'`, exit code 2, the test as `error`, and the run failure `interrupted` "The run stopped before it finished.", with a warning on stderr. The next run in the same temporary folder removes the profile left behind. SIGINT exits 130 and SIGTERM exits 143; both record `interrupted`, write `result.json` and release everything. A second signal of either kind exits at once and still takes the browser group and its profile |
| External consumer | `package-smoke` | Section 8 |

The cleanup failure row uses no production flag. `--timeouts cleanup=1` is a documented budget, and Chrome cannot confirm closing a context within 1 ms, so the runner meets a real CDP timeout on `Target.disposeBrowserContext`. This proves the reporting path through the real browser. A browser that refuses to close a context was not reproduced. That case is covered only with a mock: `tests/unit/runner-lifecycle.test.ts`, suite "cleanup", uses the fake browser's `disposeFails` at the `OwnedPage` boundary.

Other real-browser checks:

- `cli-commands.test.ts`: `--help`, `--version`, an unknown option, a used output folder, `list --json`, `list` on a file that throws once its tests were collected (exit 2), the agent report and its `next:` line, and nested `test.step` events with each action carrying its step.
- `browser-actions.test.ts`: the input guard. A cover that appears when the pointer arrives takes the press, and the page never hears the click. A cover that appears on the press takes the release, and Retest stops it. A same-origin frame that covers the button takes the click, and the outcome is `outcome_unknown`. A `fill` whose focus moves after Retest focused the field is stopped, naming where the focus went.
- `browser-navigation.test.ts`: a page that replaces itself twice before `load` counts as loaded when the last one loads, and a fragment `goto` completes at once.
- `browser-lifecycle.test.ts`: a click stopped before it pressed ends at once and sends nothing; a click stopped after its press was sent is never released and says the press was sent; a command stopped before it starts sends nothing; closing with a 1 ms budget still ends the browser within the close grace; a page that cannot open within 1 ms fails as `setup_failed`; plus crashed renderers, dialogs and killed browsers.

The 588 unit tests use fakes and mocks: the fake browser in `tests/support/fake-browser.ts`, fake transports, scripted CDP sessions and in-process runs. They show logic, not browser behaviour.

## 8. External consumer

`tests/integration/package-smoke.test.ts` builds, runs `npm pack`, and installs the tarball offline into a new project under the system temporary folder, outside the repository, with an npm cache of its own. All 6 checks passed in the final run:

- The tarball holds `package.json`, `README.md`, `LICENSE` and `dist/` only. No TypeScript source is published, and every packed `.js` file still has a source file.
- Installing it adds no other package, and its manifest declares no dependencies.
- A test that imports `@rehearsal-labs/retest` by name typechecks against the installed declarations with TypeScript 6.0.3 and 7.0.2, with `skipLibCheck: false` and no Node types. Calling `toBe` on a locator fails with the branded message under both.
- `node_modules/.bin/retest run tests/task.retest.ts` passes against the working fixture with exit 0 and fails against the broken fixture with exit 1 and a screenshot.

The test removes its temporary folders afterwards.

## 9. Cleanup

After every `retest` command it starts, the harness checks four things. It starts each command as the leader of a new process group, with `TMPDIR` set to a folder of its own.

1. No process is left in the command's process group, which holds the test file processes.
2. No `retest-profile-*` folder is left in its `TMPDIR`.
3. No running process mentions that `TMPDIR` in its command line. Every Chrome process carries its profile path.
4. The process group of every `browser.started` event is gone.

SIGKILL is the exception, checked on its own. The test file process and the browser end by themselves within the bound, the profile stays, and the next launch removes it. Fixture servers run inside the test process and close after each test. Should a check fail midway, the harness kills only the process groups it started and the browser groups those runs reported.

Unit tests make their folders through `tests/support/temp-folder.ts`, under one `retest-tests-*` root per test process that is removed when that process exits. Before this, the runner, store and event-log tests left about 1,800 folders in the temporary folder over this session. Those were removed, and a full unit run now leaves none.

After the final run and the evidence runs, `ps` showed no fixture server, `retest` process, test file process or Chrome with a Retest profile, and the temporary folder held no `retest-profile-*`, `retest-cli-*`, `retest-package-*`, `retest-consumer-*` or `retest-browser-test-*` folder.

## 10. Review findings

The originating session reviewed the work on 30 September 2026 (`docs/plans/milestone-1/review.md`). Two fix waves followed. Wave A fixed B1, M1, M2, M3, m2, m3, m5, m6, m8, m9, m10, m11 and most nits. Wave B fixed m1, m4, m7 and m12, and the `list` gap below. The review's re-check of both waves found N1, N2 and N3, and Wave C, the last, fixed them. The tests named are in `tests/unit/` unless marked as integration tests.

| Finding | Resolution | Proved by |
| --- | --- | --- |
| B1. An error after a file's last test was dropped, and the run passed | Fixed. The child sends a validated `process-error` message before it exits. The parent closes the process after the last test, reads its exit, and fails the file with `test_error`; collection stays `ok`. The run is incomplete and exits 2 | `runner-lifecycle`: "throws after the last test" (two tests), "dies after the last test", "is too busy to close after the last test", "dies between tests"; `runner-outcome`: "a file whose process failed outside its tests leaves the run incomplete"; `runner-process`: "an error thrown while no test runs is kept" |
| M1. `outcome_unknown` was decided in the parent, so the action and the test disagreed | Fixed. On browser loss the parent waits up to the 1000 ms abort grace for the command in flight, and the page's answer decides: `session_lost` when input was never sent, `outcome_unknown` when it was. A command with no answer by then is `outcome_unknown` | `runner-lifecycle`: the three "lost ..." tests, which assert the event, the test and `result.json` agree; integration `matrix-lifecycle`: the three browser disconnect tests; integration `browser-lifecycle`: "killing the browser while an action waits" and "after the press was sent" |
| M2. SIGTERM left no result and an orphaned browser | Fixed. SIGTERM takes the SIGINT path and exits 143, which `ExitCode` and the schema now include. A second signal of either kind exits at once | `cli-interrupt`; `runner-lifecycle`: "by SIGTERM takes the same path and exits 143"; `cli-run`: "returns 143 once stopped by SIGTERM"; `cli-list`: "exits 143"; integration `run-interrupt`: the SIGTERM and second-signal tests |
| M3. The check-then-press race was open and the README overclaimed | Fixed. Every document installs a guard in the `retest` isolated world before its own scripts run, and each action arms it. A press, release or click that lands on another element is stopped before the page hears it and fails `not_actionable` naming that element; a `fill` whose focus moved is stopped the same way. Input that never reached the element's document, or that a new document replaced, is `outcome_unknown`. Hover events still reach the page. The README now says exactly this | `browser-input-guard`; integration `browser-actions`: the cover-on-press, cover-on-hover, covering-frame and focus-moved tests; integration `matrix-targets`: covered target |
| m1. A revoked test's command kept running in the page | Fixed. `OwnedPage.execute(command, timeoutMs, signal?)`. A revocation aborts the command's signal with its reason. The page withdraws a press or text insertion not yet written, skips input not yet sent, and fails with the reason's class (`timeout` saying the test ran out of time) and `details.inputSent`. Input already sent is never recalled. A command still running when a test ends is stopped the same way once the cleanup budget has passed | `cdp-connection`: "stopping withdraws a command still queued behind a full pipe", "a signal that has already stopped sends nothing"; `browser-dispatch`; `browser-isolated-world`: "a stopped call ends at once"; `browser-navigation`: the two stopped-navigation tests; `browser-command-failures`: `commandStopped`; `runner-lifecycle`: "running out of time stops the command still in the page", the interruption tests, "an action still running when the test ends"; integration `browser-lifecycle`: "a click stopped before it pressed", "a click stopped after its press was sent", "a command stopped before it starts" |
| m2. The base URL was recorded with its credentials | Fixed. User name and password are stripped before the base URL is recorded or printed; the browser still gets them | `runner-lifecycle`: "keeps its credentials for the page, and is recorded and printed without them"; `protocol`: `withoutCredentials` |
| m3. A closed stderr turned a pass into exit 2 | Fixed. Only a stdout failure changes the exit code | integration `matrix-reporting`: "a reader that closes stderr"; `cli-terminal` |
| m4. Budgets outside the documented seven | Fixed. `newPage` takes the setup budget and `close` the cleanup budget. `pageSetupMs`, `closeRequestMs`, `exitGraceMs` and `killWaitMs` are gone. The one floor left is `closeGraceMs` (1000 ms) in `src/browser/contract.ts`: after it kills the browser's group, `close` waits that long for it to end. The build plan and README document it. A failed launch waits for the program's own exit at most the close grace, and the connection's default command timeout is the launch budget | `runner-lifecycle`: "opens each page within the setup budget and is closed within the cleanup budget"; integration `browser-lifecycle`: "closing within a budget too short to close gracefully", "a page that cannot open within its budget" |
| m5. `run.finished` and `result.json` were built three times | Fixed. The result is built once; a failure after `run.finished` changes only the stored outcome | `runner-lifecycle`: "a result that is kept after the report is the same result, with the same times", "a reporter that breaks at the end changes the stored outcome and nothing else" |
| m6. Stray errors were blamed on the running test | Fixed as far as the review asked. The failure still goes to the running test, since the file is not clean, but its message says an earlier test may be the cause and gives the `file:line` that threw. The README says so beside "module state is shared" | `runner-lifecycle`: "an error from code an earlier test left behind"; `api-helpers`: "an error from code an earlier test started" |
| m7. Duplicated pieces | Fixed. `Listeners` has one copy (Wave A). `src/shared/` holds `relativePosixPath`, one `ProcessExit` with `describeExit` for the runner and the browser, and one `errorCode` reader for the store, the CLI, the browser and the code frame. `errorMessage` in `src/protocol/failures.ts` replaced the browser's `messageOf`. `observationSchema` is exported from `src/protocol/commands.ts` and used by `element-queries.ts`. The reporters' `quoteText` is now `quoteRecorded`, so each name has one meaning | Both typechecks; `protocol`: "protocol modules import only each other"; `runner-process`: "describes how a process ended"; `reporters-format`: `quoteRecorded` |
| m8. The parent imported pure helpers from `src/api/` | Fixed. Only `src/runner/child.ts`, the child's own entry, imports `src/api/` | Both typechecks; a search of the imports |
| m9. Two isolated worlds could be created for one document | Fixed. Calls share one creation in flight per document | `browser-isolated-world`: "calls made at once share one creation of the world", "after the document changes, calls made at once share one new creation" |
| m10. Foreign child events were dropped silently | Fixed. An event for another test or attempt is a protocol violation: the test fails with `test_error` and its process is killed | `runner-lifecycle`: "an event for another test is a violation" |
| m11. Tests waited on the clock | Fixed. The absence checks wait on the fixtures' own signals, such as POST counters and the `save-replaced` marker | The tests themselves, in integration `browser-actions` and `browser-lifecycle` |
| m12. Documentation gaps and overclaims | Fixed. The README states the browser-loss rule, SIGTERM and 143, the input guard and its two unknown cases, that `--headed` never ran, that CI is untested, and when `pageUrl` is absent. This handoff says `Secret` is not in milestone 1 | Documentation |
| Nit: narrating comments in `main.ts` | Fixed. One comment is left, and it gives a reason | |
| Nit: `defaultLaunchTimeoutMs` and `renderAgentReport` exported without a consumer | Fixed. Neither is exported | |
| Nit: recursive `#command` after `#runOutOfTime` | Fixed. The deadline check runs first, then the refusal is computed | |
| Nit: `goto` within a document could return the previous URL | Fixed. It waits for `Page.navigatedWithinDocument` | `browser-navigation`: the two within-the-document tests; integration `browser-navigation`: "goto to a fragment of the current document is complete at once" |
| Nit: a client-side redirect before `load` timed out | Fixed. The navigation follows the replacing document to its `load` | `browser-navigation`: the two replaced-document tests; integration `browser-navigation`: "a page that sends the browser elsewhere before it loads" |
| Nit: the handoff's split of unit and real-browser checks | Kept; the review agreed with it | |
| N1. A test whose process died before its body started was `failed` with exit 1 | Fixed. The parent checks the file's process before it starts a test, again once the test's page is open, and `RunningTest.run()` checks once more before it sends the body; it reports `endedBeforeStart` instead of a `test_error` failure. Such a test is `not_run` with `test_error` "Not run: the process for this file ended before this test could run (exit code 1).", and so is every later test in the file. Its page is closed; a page that will not close is a cleanup failure of that test. The run exits 2 unless a test failed its checks. The message used to say "between tests", which was wrong for a file's first test | `runner-lifecycle`: "dies while the next test's page opens" and "... and that page will not close", with the fake holding `newPage` until the child is gone; "dies between tests", which holds the previous page's close instead and asserts no later test started or opened a page, so it fails if the first check goes; `runner-running-test`: "a body due in a process that has already ended never starts". The fixture's first test leaves a SIGUSR2 listener that throws, so the test decides when the error lands, with no delay. Reverting both new checks made the first two tests fail with the review's `failed` result and a screenshot. Real Chrome, by hand: the review's two-test file with a 15 ms stray timer, run 5 times, reached this window every time and gave `not_run`, exit 2 |
| N2. A screenshot was taken for a test that never ran | Fixed. The not-run path closes the page and never calls `#captureFailure` | `runner-lifecycle`: "dies while the next test's page opens" asserts no `evidence.captured` or `evidence.failed` event and empty `evidence`; making that path take a screenshot fails it. The 5 real-Chrome runs above recorded no evidence event |
| N3. A file's process failure had no event of its own | Fixed. `file.failed` `{ file, failure }` is emitted once the parent has closed the process and decided the file's failure, before `run.finished`. It is in the event schema, so in `dist/schemas/event-v1.schema.json`. The run record keeps it, `rebuildResult` puts it on the rebuilt file, and the human report marks the file under its tests as it arrives. The build plan's event list and the README describe it | `runner-lifecycle`: "throws after the last test: the file fails ..." (the event and its place before `run.finished`), "... the reports and inspect show it", "throws after the last test, and the run is killed before it finishes" (a real run folder cut after `file.failed`), "closes cleanly" (no event); `inspect-read`: "a file whose process failed keeps that failure"; `inspect-command`: "a run killed after its file failed outside its tests still shows that failure"; `protocol`: the sample and two malformed `file.failed` events; `reporters-human` and `reporters-agent`: the file-failure tests now replay the recorded events. Removing the emit fails three lifecycle tests. Real Chrome, by hand: `inspect` on a copy of a run cut after `file.failed` showed the file failure in `--json` and in the report |

Beyond the review, Wave B also fixed:

- `retest list` ignored an error a file threw after its tests were collected. `collectFiles` now closes each file's process, reads what it reported, and fails the file as a run does, keeping its tests. `list` prints the failure on stderr and exits 2. Proved by `runner-collect`: "an error thrown after the tests were collected fails the file", "a file whose process ends badly after collection fails"; `cli-list`: "a file that fails after its tests were collected"; integration `cli-commands`: "list reports a file that throws once its tests were collected".
- `npm run build` did not empty `dist/`. It does now.
- In the last full gate run, one unit test failed under load. It was "a creation cut short by another call deadline is made again for a call with time left" in `tests/unit/browser-isolated-world.test.ts`. On a busy machine, the patient call's second world creation could finish before the hurried call's 30 ms timer fired, and the hurried call then used that world. The test now holds the second creation until the hurried call has settled. It passed 20 of 20 runs alone and three full unit runs of 588 in a row.

## 11. Remaining limitations and incomplete requirements

Most important first.

1. Only macOS arm64 with Chrome 154 was exercised. Linux is untested. Windows cannot work, because Retest signals POSIX process groups. `--headed` was never run, and no check ran on a CI runner.
2. Input already sent is never recalled. A test stopped after its press was sent leaves the press in the page, with the button held, until the context closes; the action's event says `inputSent: true`. The two `outcome_unknown` guard cases (a covering same-origin frame, and a page that moved to a new document) mean the page may have acted on something else. Cross-origin frames were not tried.
3. An error thrown after a file's last test is caught only if it comes before the file's process takes the request to close, which is about one IPC round trip. A timer that fires later is never seen. The same holds for `list` after collection.
4. `Secret` from brief 13.3 is not in milestone 1.
5. Page console messages are recorded nowhere. They never corrupt stdout, but a failing test's console errors are lost. Chrome's own stderr goes to `logs/browser.log`.
6. The rerun and inspect commands on a card, and the agent report's `next:` line, begin with `npx retest`. In this checkout that runs the built `dist/`, which can lag behind `src/`; before a build it fails with "command not found". From a folder where Retest is not installed, npx would fetch the unrelated public `retest` package, and without a terminal npx assumes `--yes`. That last case was not run, because it needs the network.
7. The failure screenshot shares the cleanup budget, so a short cleanup budget also loses the screenshot.
8. A pipe write can fail after it returns. A JSONL reader that leaves just after the last event gets exit 2 from the process while `result.json` says `passed`. Found by reading the code; not tested.
9. A stopped command's message can name the command twice, as in "It was waiting for getByTestId('save-task').click(). Retest stopped before it could click getByTestId('save-task')". The not-run reason after a lost browser still puts the browser's reason after a full stop in lowercase: "...earlier in this run. the browser closed the pipe".
10. A test file's stdout and stderr share one log without stream labels. Order across the two is not kept, and an unterminated stdout line runs into the next stderr text. The human report prints what a file writes while loading above the `retest` header.
11. The published declaration maps point into `src/`, and the `retest-source` export condition names `./src/index.ts`; neither is in the tarball.
12. A browser that refuses to close a context is covered only by the fake browser.
13. Stale-profile removal trusts the process id in the folder name. A reused id keeps a stale profile, which is the safe direction.
14. `list --json` has no published JSON Schema. Events and results do.
15. Screenshots and page text are not redacted, and the test file process is not a sandbox for hostile code.
16. A test that did not run, whose page would not close, keeps that cleanup failure in `result.json` and its `test.finished` event. The terminal reports list only its not-run reason.
17. In a run of one file, the human report marks a file that failed outside its tests under its tests, and the failure card right after starts with the same line. A file that could not be collected already repeats its line the same way.

## 12. Issues the verification phase found in `src/`

These predate the review. The verification phase wrote a failing test for each and changed nothing in `src/`; the implementing agent fixed both during that session, and the tests pass.

1. False pass: Retest's own errors thrown outside a test's scope were dropped. A `test()` declared after the file loaded, or an `expect()` that failed in a callback registered while the file loaded, threw a `RetestError` that nothing had recorded. Failing tests: the two `unawaited work: ... cannot leave a passing run` checks in `matrix-outcomes.test.ts`, with `fixtures/tests/late-test.retest.ts` and `outside-check.retest.ts`. `report()` now passes every error to `TestRun.recordThrown`, which records any failure not already recorded.
2. A JSONL reader that went away left a stored pass. Failing test: `reporter integrity: a JSONL reader that goes away ...` in `matrix-reporting.test.ts`. Once stdout has failed, the report writer throws, so the run records `reporting_failed` and prints "error: The jsonl reporter failed on ...: write EPIPE".

# Part 2: Milestone 2

30 September 2026. The milestone 2 verification phase wrote this part from checks it ran itself, against the contract in `docs/plans/milestone-2/build-plan.md`. A fix agent changed `src/` while this phase worked; the final run in section 5 came after its last change. How to use what is described here is in [the guide](guide.md).

## 1. What works

Retest now runs a project from a config. Verified through the command line as a real subprocess, against real browsers and the task-app fixture on an ephemeral loopback port:

- `retest.config.ts` is found, loaded and checked. An invalid one names the file and each key at fault. Its `Register` block gives the type check the project's names on TypeScript 6 and 7.
- Several named apps in one test, each with its own browser context, its commands routed to its page, and a screenshot of each on failure.
- A matrix of targets: Google Chrome through `chrome()` and Chrome for Testing through `chromium({ executablePath })`. A test on an app with two targets runs twice. `runs` pairs the targets of two such apps. `--target` picks one.
- Device emulation: the viewport, pixel ratio, user agent and touch are applied, `tap()` works, `click()` becomes a tap, and every report says "emulated".
- Role, label and text locators with strict matching by default, `exact: false`, and the hidden-element rules, all resolved by Chrome's own accessibility tree or the page text.
- `test.describe`, `beforeEach`, `afterEach`, `test.for`, `test.setup` with saved sign-in `state`, `expect.poll`, `expect.soft`, and the new matchers.
- Secrets typed by the parent process only, bound to origins, and replaced by `{{name}}` in what Retest records. This phase found two exceptions, listed in section 11; the review fixed both.
- Choosing tests by `--grep`, `--tag`, `file:line`, `file:line#row`, `--last-failed` and `--target`.
- `retest init` writes a project that type-checks and runs. `retest doctor` checks browsers, apps, servers and secrets.
- `start` runs an app's server, waits for it, logs it and stops its process group.
- The packed tarball installs offline into an outside project, which type-checks with a registered config, runs from its installed command line, and runs `runFiles` from the `runner` subpath with an in-memory config.
- Milestone 1's mode, `--browser` with no config, still runs as before, and every milestone 1 integration test still passes.

## 2. Environment

| Item | Version |
| --- | --- |
| Operating system | macOS 27.0 (build 26A428), Darwin 27.0.0, arm64 |
| Node.js | 24.12.0 |
| npm | 11.6.2 |
| First browser | Google Chrome 154.0.8037.92, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, found by `chrome()` and passed as `--browser` in milestone 1's mode |
| Second browser | Chrome for Testing 153.0.8010.12, `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, given to `chromium({ executablePath })` or `RETEST_CHROMIUM`. No Playwright code ran |
| TypeScript | 6.0.3 and 7.0.2 |

Every browser ran headless. Nothing ran on Linux, Windows, Edge, a Chrome channel other than stable, a CI runner or a headed browser.

## 3. Files and modules

The build phases added these to `src/`. Each folder keeps milestone 1's separation: `protocol` is pure, `browser` knows nothing of tests, `runner` knows nothing of CDP, and reporters only read events.

| Folder | Milestone 2 modules |
| --- | --- |
| `src/config/` | The config's types, `defineConfig`, `app`, `chromium`, `chrome`, `edge` and `env`, the device table, validation into a `LoadedConfig`, loading the file, and the `Register` types |
| `src/api/` | App handles and their pages, locator recipes, `describe` blocks and hooks, `test.for`, `test.setup`, options, `secret()`, and per-app command lanes |
| `src/assertions/` | The value checks, deep equality, `expect.poll`, `expect.soft` and how assertions are reported |
| `src/browser/` | Accessibility-tree lookups for role and label, text matching, emulation, storage state capture and restore, finding executables, and refusing a secret on the wrong origin in the page |
| `src/runner/` | Planning variants and runs, scheduling setups, finding setups in other files, selection, secret resolution and redaction, the browser pool, app servers, the run config, `last-run.json`, and the `runner` subpath entry |
| `src/protocol/` | Variants, ARIA roles, emulation, storage state, secrets, `last-run.json`, source places, the JSON Schema URLs and the `protocol` subpath entry |
| `src/cli/` | `init`, `doctor`, prompts, finding the config, `--base-url` and `--target` pairs, tag expressions and selection flags |
| `src/reporters/` | Target labels and per-target summaries |
| `src/shared/` | Listing words and finding test files |

The verification phase added:

| Path | Purpose |
| --- | --- |
| `examples/tasks/` | The example project: `retest.config.ts` with the `Register` block, its own `tsconfig.json`, and four test files that use every part of the milestone 2 API |
| `fixtures/app-server/cli.ts` | A server for `start`: it listens on a given port after an optional delay, or never; it can ignore SIGTERM, start a child process, and print an environment variable; it logs to stdout and stderr, and serves a page with a heading and a field |
| `tests/integration/m2-*.test.ts` | Fifteen files, one for each area of the acceptance checks |
| `tests/integration/cli-harness.ts` | Extended: config runs without `--browser`, projects outside the repository that import Retest by name, JSONL checks, secret searches, app server fixtures, free ports, packing and installing the tarball, the second browser, and wider cleanup checks |
| `tests/integration/package-smoke.test.ts` | Now packs and installs through the shared helpers; its checks are unchanged |
| `docs/guide.md` | How to use milestone 2 |
| `tsconfig.json` | One line outside this phase's files: `examples/tasks` is excluded, because its `Register` block would apply to the whole root program. It type-checks as a project of its own |

## 4. Dependencies

Unchanged. There are no runtime dependencies. The development dependencies are still `typescript` 6.0.3, `typescript-7` (`npm:typescript@7.0.2`) and `@types/node` 24.19.0, with `undici-types` 7.24.6 and `@typescript/typescript-darwin-arm64` 7.0.2 beneath them, and `package-lock.json` is unchanged. The package smoke tests install only the packed tarball. Where a project outside the repository needs Node's types, the tests link this checkout's `@types/node` into it rather than install anything.

## 5. Commands and results

The final run, from the repository root, one command after another, on 30 September 2026 from 18:19 to 18:24 local time, with Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12. It came after the fix agent's last change to `src/`, which included the four changes it was making alongside this phase: the in-page origin check for secret fills, bringing in setups from other files, `doctor` logs under `.retest/doctor/`, and `file:line#row`.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | Empties `dist/`, then writes it, with `dist/schemas/event-v1.schema.json` and `result-v1.schema.json`. The event schema includes `app.started`, `app.reused`, `app.failed`, `state.saved`, `state.restored`, `origin` and `variantKey` |
| `npm run typecheck` | 0 | TypeScript 6.0.3, then 7.0.2, no errors, no `FATAL` |
| `npm run test:unit` | 0 | 1080 tests in 197 suites: 1080 passed, 0 failed, 0 skipped, 17.8 s |
| `npm run test:types` | 0 | "109 expected errors matched 109 markers in 4 projects" on TypeScript 6.0.3, and again on 7.0.2 |
| `npm run test:integration` | 1 | 235 tests: 233 passed, 2 failed, 0 cancelled, 0 skipped, 211.6 s. This phase's 15 `m2-*` files hold 54 of them, and the 2 failures are the bugs in section 11. The other 181 are milestone 1's suites, the package smoke test among them, and the build phases' browser-level tests |

The integration run exits 1 on purpose: the two failing tests show the bugs in section 11, and pass once those are fixed. Every other test passed, milestone 1's included.

`npm run test:integration` needs both browsers of section 2. It ran with neither `RETEST_TEST_BROWSER` nor `RETEST_TEST_SECOND_BROWSER` set, so it used the default paths.

## 6. Acceptance checks

Every check below ran through the `retest` command line as a real subprocess, against real browsers and the task-app fixture, with short explicit `--timeouts`. The projects the checks run are written into temporary folders outside the repository, and import Retest by its package name. After every run, the harness reads `events.jsonl` and `result.json` through the protocol schemas, checks that JSONL stdout is exactly those events, and checks cleanup as section 9 describes.

The last column lists the unit tests in `tests/unit/` that check the same logic with fakes and mocks: a fake browser, fake transports, scripted CDP sessions and in-process runs. They show logic, not browser behaviour.

| # | Check | Result | Real proof, in `tests/integration/` | Mocked only, in `tests/unit/` |
| --- | --- | --- | --- | --- |
| 1 | Config | Pass | `m2-config`, 8 tests: no config and no `--browser` is a usage error that says how to go on; an invalid config names the file and every key at fault, before a run folder exists; a config that throws, has no default export or is missing names itself; `--browser` beside a config is refused; a milestone 1 run still has one app named `page`, no variants and no `browsers`; `--base-url url` and `app=url` replace base URLs and are recorded; with no files every `.retest.ts` under the root runs, dot folders skipped; config budgets sit under `--timeouts`, and several apps with no `defaultApp` need `apps`. Every milestone 1 suite also still runs in `--browser` mode | `config-validate`, `config-load-file`, `config-define`, `cli-run-config`, `runner-run-config` |
| 2 | Types | Pass | Real compilers, no browser: `npm run test:types` checks every error of the plan page's "What tsc catches" (`tests/types/fixtures/plan-page`) and every M2-10 fixture on TypeScript 6 and 7, and `unregistered.ts` compiles `page` tests with no config. `m2-example`: the example project type-checks on both. `m2-package`: a registered consumer type-checks on both, and an unknown app and an unknown secret fail with their messages on both. `package-smoke`: an unregistered consumer compiles a `page` test against the installed declarations | `type-diagnostics` |
| 3 | Locators | Pass | `m2-locators`: one run of nine tests against `/locators`. Role matches the whole name Chrome computes, case and all, `exact: false` matches any part in any case, and whitespace is normalised; hidden, `aria-hidden`, `inert` and undisplayed elements are left out; label finds fields by `for`, a wrapping label, `aria-labelledby`, `aria-label`, `title` and placeholder, and never a button; text finds the innermost element and skips `script`, `style`, `template` and `noscript`; shadow roots and frames are not searched. An ambiguous role and an ambiguous label fail a click or fill in under a second, naming the count; text that matches nothing fails `not_found` after the 1500 ms action budget. `browser-locators` checks the same page at the browser level, 22 tests | `browser-locate`, `browser-accessibility`, `browser-text-match`, `locator` |
| 4 | Two apps in one test | Pass | `m2-apps`: an owner signs in and saves, and the member's page is still signed out with empty storage and a first page load; the two apps' `goto`s run at once without a clash; every action, navigation and check names its app in `session`; a failure takes one PNG of each app, named with the app. The example's `roles.retest.ts` passes in `m2-example` | `api-handles`, `api-child`, `runner-config-apps` |
| 5 | Matrix | Pass | `m2-matrix`, 3 tests. With a `chrome` target on Chrome 154 and a `testing` target on Chrome for Testing 153, a one-app test runs twice, and a page it opens tells a server which major version opened it: 154 once and 153 once. The human report labels each run and prints a line per target. `runs` gives exactly its two pairings for a two-app test, and no other. `--target web=testing` keeps only those runs and starts only the browsers they use; a pairing no `runs` entry has keeps nothing and exits 2; an unknown target is a usage error. A missing `runs` entry fails that file's collection with its message, and the other file still runs. `inspect --test --target` reads one variant | `runner-variants`, `runner-schedule`, `runner-browser-pool`, `reporters-variants`, `inspect-variants` |
| 6 | Emulation | Pass | `m2-emulation`: a Pixel 9 target reads width 412, pixel ratio 2.625, a touch screen, and the Pixel user agent with the running Chrome's major version, in the page and in the request header, and no client hints in the page; `tap()` gives `touchstart touchend click:touch`; `click()` on it is sent and recorded as `tap`; a custom screen on Chrome for Testing gets width 800, ratio 2 and touch; the desktop target has no touch and gets `click:mouse`. `browser.started` carries the emulation and device. The human report, the agent report, `inspect` and `inspect --json` all say emulated. `browser-emulation` checks the same at the browser level, 13 tests | `browser-emulation`, `config-devices` |
| 7 | Secrets | Pass, with the two bugs of section 11 | `m2-secrets`: a missing or short variable stops the run with exit 2 before a run folder exists, naming both; a secret signs in, and the page text that holds it reads `{{password}}` in the test; a failure quoting that text quotes the name; the test process has no secret variable and prints a secret as `{{password}}`; a function source is read on each fill, and a failing one fails that fill `setup_failed` with its redacted message; a secret on an origin it is not bound to fails `not_actionable`, naming the origin, and the field stays empty; `secretOrigins` allows another origin; a server that prints the secret has `{{password}}` in its log. Every file of the run folder, `.retest/last-run.json`, stdout and stderr are searched for each value as written, URL-encoded and form-encoded, and hold none. Two more tests fail and show the bugs. `m2-package` runs a function source through `runFiles`. `browser-secrets` checks fills at the browser level | `runner-secrets`, `runner-redactor`, `runner-config-secrets`, `api-secret` |
| 8 | Sign-in state | Pass | `m2-state`: a setup signs in through `/login` once on each of two targets; a test with `state` starts signed in on both, with its `localStorage`; a test without starts signed out; a setup that fails keeps its dependents `not_run`, with its failure in the reason; `state.saved` and `state.restored` name the state and hold nothing else; no file of the run folder holds the session cookie, and `states/` is empty. A file run on its own brings in the setup it needs from another file, marked `setupFor`. A state no file saves fails collection, naming it. `m2-guarantees`: saved state is removed on SIGINT, SIGTERM and a second SIGINT, and stays after SIGKILL. `browser-state` checks capture and restore at the browser level | `runner-config-state`, `runner-setup-search`, `store-states`, `browser-storage-state` |
| 9 | Hooks | Pass | `m2-hooks`: the child log and the `step.started` events show file, outer, outer, inner `beforeEach`, the body, then inner, outer, outer, file `afterEach`, each at its declared line; after a failed check the `afterEach` hooks run, the test keeps its own failure at its own line, and the hook's failure is in `details.also`; describe ids are `file > outer > inner > name` and `test.for` fills `$title` and `$count`, with the block's tags passed down; duplicate rows, blocks and test names each fail their file, and nothing starts | `api-hooks`, `api-registration`, `runner-plan` |
| 10 | Matchers | Pass | `m2-matchers`: `toBeHidden`, `toHaveCount`, `toHaveText([...])`, `toHaveValue`, `toEqual` with `Date`, `Set` and `Map` values, `toContain` and `toMatch` each pass once and fail once, `check_failed`, with the expected and received values recorded. `expect.poll` read three times before it passed, and one that never matched looked more than twice, yet the run saved once per poll test; an action inside `expect.poll` fails the test `usage` and is never sent. `expect.soft` records two failures, both `soft: true`, the test goes on to its next action, and fails at the end with both | `assertions-matchers`, `assertions-poll`, `assertions-soft`, `assertions-deep-equal`, `assertions-expect` |
| 11 | Selection | Pass | `m2-selection`, 6 tests: `--grep` text and `/pattern/i` on the full title; `--tag` with `and`, `not`, `or` and parentheses, and with `--grep`; an unknown tag is a usage error that points at it; `file:line` keeps a test, a `test.describe` block or a `test.for`, and `file:line:column` works; `file:line#2` keeps one row, and `list` shows it; `--last-failed` reads `.retest/last-run.json`, validated, and runs only the variant that failed, loading only its file; the failure card's rerun names `file:line` and `--target`; `--target` leaves out tests that do not use its app; after a clean run `--last-failed` has nothing to run; a selection that keeps nothing exits 2 with the reason and starts no browser | `runner-selection`, `runner-config-selection`, `cli-tag-expression`, `cli-arguments` |
| 12 | `init` | Pass | `m2-package`: in an empty folder, `init --yes` writes the config with its `Register` block, the example, the tsconfig, `package.json` with `type: module` and both scripts, and `.gitignore`. In a project with the tarball installed offline, `init --yes --ci github` also writes the workflow; a second `init` changes no byte and reports six files left as is; the project type-checks with `tsconfig.retest.json` on TypeScript 6 and 7; its example runs with its installed `retest` against the fixture and passes. `init` found Chrome and chose `chrome()` | `cli-init`, `cli-prompt` |
| 13 | `doctor` | Pass | `m2-doctor`: with Chrome, Chrome for Testing and an emulated target, a managed server and a set secret, `doctor` reports each browser's version and path, starts the server, says it answered and was stopped, and exits 0; its server and the child it started are gone, and no log folder is kept. With a missing executable, a program that is not a browser, an app that does not answer, a server that never answers and an unset secret, it reports five problems with their fixes and exits 2; the log it points to is under `.retest/doctor/` in the project, and nothing is left in `TMPDIR`. Without a config it says how to write one | `cli-doctor` |
| 14 | `start` | Pass | `m2-servers`, 5 tests: a server that listens after 700 ms is started, waited for and ready before the first test, its stdout and stderr are in `logs/app-web-*.log`, and the run stops its process group, child included; a server already answering is used, never started, and still running afterwards; a server that never answers is `setup_failed` for both tests that need it, named with its log, and stopped; one that exits first gives its exit code; one that ignores SIGTERM is killed with its group | `runner-app-server`, `runner-config-servers` |
| 15 | Package smoke test | Pass | `m2-package`, 6 tests, and `package-smoke`, 6 tests. Section 8 | |
| 16 | Milestone 1 guarantees | Pass | `m2-guarantees`, 7 tests, in runs from a config: a pass exits 0, a failed check 1, and a target with no browser 2 with that run `not_run`; no action is repeated; a test that runs out of time ends its file process, the rest of the file does not run, and the next file does; a browser killed during a click gives `outcome_unknown` on the click and the test, the click is not sent again, later tests on that browser do not run and a test on another browser does; SIGINT exits 130 and SIGTERM 143 with `result.json`, the browsers and the server stopped and state removed; a second SIGINT quits at once and its exit hooks still end the browser and the server and remove state; after SIGKILL, `inspect --json` rebuilds the run with each variant and marks it incomplete. JSONL stdout is checked in every run from a config. Every milestone 1 suite (`matrix-*`, `run-interrupt`, `cli-commands`, `browser-*`, `cdp`) still passes | `runner-lifecycle`, `runner-outcome`, `runner-running-test`, `runner-process`, `cli-interrupt` |

## 7. Evidence to open

Made from `examples/tasks` against the task-app fixture, with `--no-agent`, after the final run. Beside each run folder under `.retest/example-runs/`, a `.txt` file keeps the command and what the terminal printed. `.retest/` is ignored by Git. `m2-validation.txt` shows every event line and `result.json` of the five runs validated against the protocol schemas, and each `states/` folder gone.

| Run | Folder | Result |
| --- | --- | --- |
| Passing example | `.retest/example-runs/m2-passing` | `passed`, exit 0: 16 test runs across 8 targets, 42 checks |
| Failing example | `.retest/example-runs/m2-failing` | `failed`, exit 1, against the broken fixture: 5 failed and 11 passed, each failure a card with a code frame, a screenshot per app page and a rerun command. `tests-roles-*-web-*-failure.png` and `tests-roles-*-admin-*-failure.png` are the two apps of one test |
| Two targets | `.retest/example-runs/m2-two-targets` | `passed`, exit 0: `tests/devices.retest.ts:4` on `desktop=chrome`, Chrome 154, and on `desktop=chromium`, Chrome for Testing 153, with a summary line for each |
| Emulated | `.retest/example-runs/m2-emulated` | `passed`, exit 0: `--tag phone`, 4 runs on the Pixel 9 and iPhone 17 targets, each labelled "emulated" |
| Secrets | `.retest/example-runs/m2-secrets` | `passed`, exit 0: `tests/sign-in.retest.ts`, whose setup types `secret('password')`. `m2-secrets-search.txt` shows no file of the five runs holding the password in any form, and each secret fill recorded by name |

`m2-inspect.txt` shows `inspect --test` on a two-app test, with the app of each action, and on one variant with `--target`.

How the runs were made, with Chrome for Testing's path as `$CHROMIUM` and the addresses the fixtures printed as `$URL` and `$BROKEN`:

```sh
node fixtures/task-app/cli.ts                  # prints $URL
node fixtures/task-app/cli.ts --mode broken    # prints $BROKEN
cd examples/tasks
export TASK_APP_PASSWORD='correct horse battery staple' RETEST_CHROMIUM="$CHROMIUM"
retest() { node --conditions=retest-source ../../src/cli/main.ts "$@"; }
TASK_APP_URL=$URL retest run --no-agent --output ../../.retest/example-runs/m2-passing
TASK_APP_URL=$BROKEN retest run --no-agent --output ../../.retest/example-runs/m2-failing
TASK_APP_URL=$URL retest run tests/devices.retest.ts:4 --no-agent --output ../../.retest/example-runs/m2-two-targets
TASK_APP_URL=$URL retest run --tag phone --no-agent --output ../../.retest/example-runs/m2-emulated
TASK_APP_URL=$URL retest run tests/sign-in.retest.ts --no-agent --output ../../.retest/example-runs/m2-secrets
```

Milestone 1's four evidence runs are still in `.retest/example-runs/` beside these (Part 1, section 6).

## 8. Package smoke test

`tests/integration/m2-package.test.ts` builds, packs and installs the tarball offline into new projects under the system temporary folder, outside the repository, with an npm cache of its own. It links this checkout's `@types/node` where a project needs Node's types; nothing else is installed. All 6 checks passed:

- The package exports `.`, `./runner`, `./protocol` and `./package.json`, and each subpath has `retest-source`, `types` and `default`, in that order.
- `init --yes` in an empty folder, and `init --yes --ci github` in a project with the tarball, as in check 12. The project it writes type-checks on TypeScript 6 and 7 and runs its example.
- A consumer with a `retest.config.ts` that registers two apps, an `env` secret, a tag and a state type-checks on TypeScript 6.0.3 and 7.0.2 with `skipLibCheck: false`. A file that names an unknown app and misspells a secret fails with exactly two errors on both: TS2322 `Type '"desktop"' is not assignable to type '"admin" | "web"'` and TS2345 `Argument of type '"pasword"' is not assignable to parameter of type '"password"'`.
- The consumer's installed `retest` runs its setup, a test from its state and a two-app test against the fixture, all passing, with the password in no file of the run folder.
- A consumer script imports `runFiles` and `validateConfig` from `@rehearsal-labs/retest/runner`, and `parse`, the event and result schemas and both schema URLs from `@rehearsal-labs/retest/protocol`. It validates an in-memory config, runs a setup and a test with a secret that a function supplies, and collects the events with a reporter of its own. It reports: `passed`, exit 0, the function read once, every event valid against the event schema, the result valid, and both schema files present. The run folder is checked like any other, and holds no password.

`tests/integration/package-smoke.test.ts`, milestone 1's, still passes its 6 checks. It now packs and installs through the shared helpers in `cli-harness.ts`.

## 9. Cleanup

The milestone 1 checks still run after every command, and now cover more. `finishRun` and `runCli` in `tests/integration/cli-harness.ts` start each command as the leader of a new process group, with `TMPDIR` set to a folder of its own, and afterwards check that:

1. no process is left in the command's own process group, which holds the test file processes;
2. every browser group from a `browser.started` event, and every server group from an `app.started` event, is gone;
3. nothing Retest names `retest-*` is left in its `TMPDIR`: no browser profile, and no `doctor` log folder;
4. no running process mentions that `TMPDIR` in its command line;
5. no saved sign-in state is left in the run folder's `states/`.

The server tests also check with `ps` that no `fixtures/app-server` process, or the child it starts, is left on the server's port, and that nothing answers there. The SIGKILL check is the exception, and says what is left: the browsers end by themselves, the profile stays until the next launch, and the saved state and the server Retest started stay. The harness then stops that server itself. Should a check fail midway, the harness kills only the process groups it started and the browser and server groups those runs reported.

After the final run and the evidence runs, `ps` showed no fixture server, `retest` process, test file process, `fixtures/app-server` process or Chrome with a Retest profile, and the system temporary folder held no `retest-*` folder. The only Chrome running was the person's own.

## 10. Limitations

Most important first. Items marked *fixed after the review* were closed by the review in `docs/plans/milestone-2/review.md`, which names the test behind each; the rest still hold.

1. *Fixed after the review.* The two secret leaks in section 11.
2. Only macOS arm64 was exercised, with Google Chrome 154 and Chrome for Testing 153. `edge()`, Chrome's beta, dev and canary channels, Linux and CI runners never ran. Windows cannot work, because Retest signals POSIX process groups. `--headed` and `headless: false` never ran.
3. Screenshots are not redacted. A secret the page shows appears in its failure screenshot.
4. A function source's value is hidden only once a fill has read it. Page text the test read before that reached the test process as it was. *After the review*, every log is read again when the run ends, so a value printed before the first read is hidden from the run folder; the events and the terminal output written before it are not.
5. After SIGKILL, nothing stops a server Retest started, and the saved state, with its session cookies, stays in the run folder, readable only by its owner. The browser profile is removed by the next launch.
6. Emulation is desktop Chrome with a device's screen, touch and user agent. An emulated iPhone or iPad still runs Blink, not WebKit. The device sizes come from published specifications.
7. Locators search the top-level document only: no shadow DOM and no frames.
8. A test file is loaded once to collect its tests and again for each visit that runs them, so top-level code runs two or more times. A file whose setup runs before other files' tests is visited, and loaded, once more.
9. `--target app=name` leaves out every test that does not use that app, including tests on the default app when another app is named.
10. *Fixed after the review.* The human report printed each browser as a heading as it started. It now prints "started web=beta  Chrome ..." at the tests' indent.
11. *Fixed after the review.* A target written on its own with a wrong setting hid the checks of its `baseUrl` and `start`; every problem of an app is now reported in one pass.
12. *Fixed after the review* for the budgets: `defaultTimeouts`, `mergeTimeouts` and `Timeouts` come from both subpaths. Still true: `apps.secrets` must hold every config secret resolved, `{ value }` or `{ read }`; a secret left out fails its fill with "not one of the config's secrets", even when the config declares it. That point was read from the code, not run.
13. *Fixed after the review.* The rerun command repeats the budgets the command line gave (`run.started.options.commandLineTimeouts`), not the config's.
14. `list --json` has no published JSON Schema.
15. Milestone 1's limits still hold where Part 1, section 11 lists them: input already sent is never recalled, page console messages are not recorded, and the rest.

## 11. Bugs this phase found in `src/`

This phase changed nothing in `src/`. Each bug has a failing test in `tests/integration/m2-secrets.test.ts`, and the final integration run fails on exactly these two. Both were fixed by the review (`docs/plans/milestone-2/review.md`, M1 and M2), and both tests pass since.

1. **A secret written percent-encoded is not redacted.** The redactor replaces a value only as it was typed. A page that puts the value in its address, where a space becomes `%20`, or shows that address, gets the encoded value into the `navigation` event, the `pageUrl` of later actions and checks, the observed text sent to the test process, `result.json` and the terminal. By hand, with the password `correct horse battery staple`, the failure card read `Page http://127.0.0.1:51454/echo/correct%20horse%20battery%20staple`. A value made only of letters, digits and `-._~` is encoded as itself and is caught. Failing test: "a secret a page writes into its address, where it is percent-encoded, is hidden there too", which finds the value in `events.jsonl` and `result.json`. Teaching the redactor each value's URL-encoded and form-encoded forms, as the test's own search does, would close it.
2. **A function source's value that a server printed before a fill read it stays in the server's log.** The redactor learns a function source's value when a fill reads it. App server output is redacted as it streams, so a line printed earlier, such as a one-time code a dev server logs as it sends it, keeps the value. Browser logs are redacted again after the browser closes; app server logs are not. Failing test: "a one-time code a server printed before the fill read it is hidden in the server log too", which finds the code in `logs/app-web-*.log`. Redacting app server logs again when the run ends, as browser logs are, would close it.

This phase also noted, without a test, what section 10 lists as items 10 to 13.

## 12. Changes outside this phase's files

- `tsconfig.json`: `examples/tasks` is added to `exclude`. The example's `Register` block would otherwise apply to the whole root program, where it broke `tests/unit/api-secret.test.ts` (TS2345 on `secret('code')`). The example type-checks as a project of its own, in `m2-example`.
- `README.md` was restored to its staged milestone 1 version on the orchestrator's instruction, and this phase left it alone after that. The milestone 2 usage documentation is in `docs/guide.md`. It replaces the milestone 1 usage guide committed in `e087be2`, and keeps what that guide said that still holds.
- `package.json`'s `description` now reads "One test across web, mobile and desktop. Built for software engineers and coding agents." This phase did not write it. Mobile and desktop apps are not supported or verified, which `AGENTS.md` says must not be advertised.
