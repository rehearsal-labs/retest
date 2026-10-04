# Retest implementation handoff

This file has three parts. Part 1 is milestone 1's handoff, as that phase left it. Part 2 is milestone 2's, written by its verification phase on 30 September 2026. Part 3 is milestone 3's first part, the short list of wave 1, written by its verification phase on 1 October 2026. How to use Retest now is in [the guide](guide.md).

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
- Profiles are named `retest-profile-<pid>-*` in the system temporary folder. Each launch removes only its own temporary profile after its processes are confirmed gone. Earlier launch leftovers are retained; a dead creator and a marker cannot prove a folder is still disposable.
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

SIGKILL is the exception, checked on its own. The test file process and the browser end by themselves within the bound and the profile stays. The earlier next-launch removal has since been disabled: an old temporary profile may have become persistent app storage. Fixture servers run inside the test process and close after each test. Should a check fail midway, the harness ends only processes whose launch and current identity it recorded.

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
13. Earlier launch profiles are retained. Neither the folder's name nor an ownership marker and a dead creator proves that a later app is not using it as persistent storage.
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
5. After SIGKILL, nothing stops a server Retest started, and the saved state, with its session cookies, stays in the run folder, readable only by its owner. The browser profile is retained by later launches.
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

# Part 3: Milestone 3, wave 1

Wave 1 came in two parts, each with its own three phases. Sections 1 to 12 are the short list's verification, as it wrote them; where the rest of wave 1 has changed what they say, a note in italics says so. Sections 13 to 23 are the rest's verification.

1 October 2026. The short list's verification phase wrote this part from checks it ran itself, against the contract in `docs/plans/milestone-3/build-plan.md`. Phases 1 and 2 had finished. This phase changed two things in `src/`, which the orchestrator decided (section 8), and nothing else there. How to use what is described here is in [the guide](guide.md), under "Pressing keys", "Proxy" and "Use Retest from code".

## 1. What works

Verified through the real command line and the real `/runner` subpath, as subprocesses, against real Chrome and the task-app fixture on ephemeral loopback ports:

- `locator.press(key)` and `page.keyboard.press(key)`. Enter submits a form once, from a field or from the keyboard, and the answer is recorded as a navigation. Tab and Shift+Tab move the focus. A key whose element lost the focus to another element is stopped before any listener of the page hears it. A browser killed while a key is down leaves `outcome_unknown`, and the key went down once.
- Host checks, given by a host's own program through `runFiles`. They run after the body, keyed by test and by file, in order and all of them, and they decide the test with it. A wrong final page fails with `host_check_failed`, exit 1, with a screenshot taken after the checks. A bad key or an unused app stops the run with exit 2 before any browser starts.
- `observation` events and the parent's judgement. Every passed locator assertion names a look the parent wrote earlier, for the same app and locator, on which its matcher passes, and says `judgedBy: 'parent'`. Value passes say `judgedBy: 'child'`. A test file that speaks the protocol itself and claims `toBeVisible` on a look that matched nothing ends `test_error`, its process is killed, and no pass is written.
- A proxy per target. Every request of the page goes through it, a service worker's and a frame of another site's included; a host in the bypass list goes around it; a proxy that refuses the connection is `setup_failed`, naming it; a proxy that asks for credentials reads as a page that would not open. `browser.started`, the replayed report and `doctor` show each target's proxy.
- A host-style run from a project outside the repository, with the packed tarball installed offline: an in-memory config under a label with no file, every secret a function, a test file the program wrote, Chrome for Testing through the fixture proxy, host checks keyed by the file, a test environment of the host's choosing, and a reporter of its own. It passes, and fails with `host_check_failed` against an app that ends on the wrong page.
- The tarball exports the short list's new names, a registered consumer that presses keys type-checks on TypeScript 6 and 7, and the keys `press` refuses fail with their messages on both.
- Every milestone 1 and milestone 2 integration test still passes, and now also checks `judgedBy` on every pass (section 9).

## 2. Environment

| Item | Version |
| --- | --- |
| Operating system | macOS 27.0 (build 26A428), Darwin 27.0.0, arm64 |
| Node.js | 24.12.0, with npm 11.6.2 |
| Browsers | Google Chrome 154.0.8037.92 at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and Chrome for Testing 153.0.8010.12 at `~/Library/Caches/ms-playwright/chromium-1243/…`. No Playwright code ran |
| TypeScript | 6.0.3 and 7.0.2 |
| Linux | Docker 29.8.1, linux/arm64, in Docker Desktop. Debian 13, Node.js 24.21.0, Google Chrome 154.0.8037.92 and Debian's Chromium 154.0.8037.57, as the user `node`, with Chrome's sandbox on |

Every browser ran headless.

## 3. Files

This phase added:

| Path | Purpose |
| --- | --- |
| `tests/integration/m3-press.test.ts` | Acceptance check 1, the short list's part |
| `tests/integration/m3-host-checks.test.ts` | Acceptance check 2, through a host script that calls `runFiles` |
| `tests/integration/m3-observations.test.ts` | Acceptance check 3 |
| `tests/integration/m3-proxy.test.ts` | Acceptance check 5, and `doctor` naming a proxy |
| `tests/integration/m3-host-run.test.ts` | Acceptance check 6, the short list's form |
| `tests/integration/m3-package.test.ts` | Acceptance check 8, the short list's part |
| `examples/host/host.ts`, `examples/host/checkout.retest.ts` | The host-style example `m3-host-run` runs: a program that builds its config in memory and copies the test file beside it into a new folder of the project. Both are in the root type check |
| `fixtures/task-app/keys-page.ts` | `/keys`: a field whose focus a notice takes, and a field whose key down reaches the server and then freezes the page. The server counts those key downs (`keyDowns()`) |
| `fixtures/task-app/code-sign-in.ts` | `/code/sign-in`: a user name and password that send a one-time code, written to an outbox file when the app has one, and a code page that Enter submits. The server lists the codes it sent (`sentCodes()`) |
| `fixtures/tests/press.retest.ts`, `press-browser-lost.retest.ts`, `observations.retest.ts`, `forged-visible.retest.ts` | The scenario files the checks run. `forged-visible` speaks the IPC protocol itself |

This phase changed:

| Path | Change |
| --- | --- |
| `src/runner/redactor.ts` | A text host check's text is free text (section 8) |
| `src/reporters/commands.ts`, `src/reporters/failure-card.ts` | `canRerun`: no rerun command for a run the command line cannot reproduce (section 8) |
| `tests/unit/runner-redactor.test.ts`, `runner-host-checks.test.ts` | The tests of the first change; one existing redactor test now expects the check's text redacted |
| `tests/unit/reporters-host-checks.test.ts`, `reporters-variants.test.ts`, `reporters-variant-fixtures.ts` | The tests of the second change. The variant fixture project now holds the config file its run.started names |
| `tests/integration/cli-harness.ts` | `assertJudged` on every run, `runHost` and `hostScript` for host programs, and scratch folders from `tests/support/temp-folder.ts` |
| `fixtures/task-app/server.ts`, `cli.ts`, `modes.ts`, `sign-in.ts`, `html.ts` | The routes above, the `outbox` option and `--outbox` flag, the `wrong-page` mode (a save moves the address to `/drafts` and the page still shows the task), `Sessions.open`, and `htmlPage` for the two new pages |
| `docs/guide.md` | Pressing keys, the proxy, host checks, observations and `judgedBy`, the test environment, what a host can trust, the host-style run, the new report and `inspect` lines, and the new limits |

## 4. Facts established in real Chrome

The Browser agent of phase 2 established these on Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12, headless, with Retest's own CDP client, each probe in its own profile. The probes and their output are in `/tmp/retest-m3-browser/probes/` on the machine that ran them, outside the repository: `probe-f1.ts`, `probe-f1-extra.ts`, `probe-f5.ts`, `probe-innertext.ts`, `support.ts` and one `*-output.txt` for each. This phase read the output and relied on the facts; it did not rerun the probes.

- **F1 holds.** `Target.createBrowserContext` with `proxyServer` and `proxyBypassList: '<-loopback>'` sends every request of that context through the proxy: the page, its fetch, a cross-site frame and that frame's fetch, the service worker's script and the worker's own fetch. Without `<-loopback>`, loopback addresses go direct. With `<-loopback>;localhost`, `localhost` goes direct and `127.0.0.1` through the proxy. The proxy belongs to the context. An https address uses `CONNECT`. A refusing proxy gives `net::ERR_PROXY_CONNECTION_FAILED`, and a tunnel that fails `net::ERR_TUNNEL_CONNECTION_FAILED`. A 407 that nothing answers gives `net::ERR_INVALID_AUTH_CREDENTIALS`, the same as a site's own 401, so Retest keeps it `not_actionable`. Chrome's own traffic, such as `CONNECT www.google.com:443`, also goes through the context's proxy. Output: `f1-output.txt` and `f1-extra-output.txt`.
- **F5 holds.** `Input.dispatchKeyEvent` `keyDown` with `text: '\r'` on a focused field of a form submits it once: `keydown`, `keypress`, `beforeinput`, `submit` and `keyup` reach the same document before the next one commits, and the server counts one POST, also through a 303 redirect. Output: `f5-output.txt`.
- **Visible text.** `document.body.innerText` leaves out shadow roots, frames and hidden elements, on both browsers. Output: `innertext-output.txt`.

This phase found one more fact while writing the host-style run, in the code and in a real run: a function secret is read when its `fill` begins, before Retest looks for the field (`SecretFiller.resolve` in `src/runner/secrets.ts`). The first version of the example test typed a one-time code right after the click that sent it, and its fill failed `setup_failed` with `ENOENT` for the outbox, because the app had not yet written the code. The example now waits for the code field first, and the guide says so.

## 5. Dependencies

Unchanged. No runtime dependency, no new development dependency, `package-lock.json` untouched. The package checks install only the packed tarball, offline, and link this checkout's `@types/node` where a project needs Node's types.

## 6. Commands and results

From the repository root, one after another, on 1 October 2026 from 00:22 to 00:27 local time, each captured to a file under `/tmp/retest-m3-verify/` and read after it ended. No file in `src/`, `tests/`, `fixtures/`, `examples/` or `scripts/` changed after this run; only this handoff and the guide did.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | `dist/` rewritten. `dist/schemas/event-v1.schema.json` holds `observation`, `host_check.passed`, `host_check.failed`, `judgedBy`, `observationId`, `hostChecks`, `proxy`, `press`, `key` and `host_check_failed`; `result-v1.schema.json` holds `hostChecks` |
| `npm run typecheck` | 0 | TypeScript 6.0.3 and 7.0.2 on the root project, which includes `examples/host`, then 6.0.3 on `examples/tasks`. No errors, no `FATAL` |
| `npm run test:unit` | 0 | 1315 tests in 243 suites: 1315 passed, 18.2 s. Phase 2 left 1310; this phase added 5 |
| `npm run test:types` | 0 | "124 expected errors matched 124 markers in 4 projects" on TypeScript 6.0.3 and on 7.0.2 |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/browser-*.test.ts" tests/integration/cdp.test.ts` | 0 | 159 tests: 159 passed, 52.8 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/matrix-*.test.ts" tests/integration/run-interrupt.test.ts tests/integration/cli-commands.test.ts tests/integration/package-smoke.test.ts` | 0 | 51 tests: 51 passed, 60.9 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m2-*.test.ts"` | 0 | 54 tests: 54 passed, 106.8 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 14 tests in 6 files: 14 passed, 28.5 s |

No group took five minutes, so none was split.

On Linux, the milestone 3 group ran at 00:29, and passed:

| Command | Exit | Result |
| --- | --- | --- |
| `docker run --rm --init --cap-drop ALL --security-opt seccomp=docker/linux/chromium-seccomp.json --network none retest-linux:m3-verify node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 14 tests: 14 passed, 24.3 s |

It did not run through `docker/linux/run.sh` as written. That script rebuilds the image first, and the working tree's `package.json` differs from the one in `retest-linux:dev` (the uncommitted publishing fields of another session), so its `npm ci` layer would have run again and needed the network. `package-lock.json` is identical in both. So this phase built a throwaway image offline, `docker build --network=none`, from a Dockerfile of two steps outside the repository: `FROM retest-linux:dev`, then remove everything under `/home/node/retest` but `node_modules`, then copy the working tree with `docker/linux/Dockerfile.dockerignore`. It ran with the flags `run.sh` passes, plus `--network none`. The first attempt kept files the tree has since deleted, such as `src/assertions/locator-checks.ts`, because a copy only adds; `npm run build` then failed inside the package checks, and the remove step fixes it. The Chrome for Testing the macOS checks use is not in that image. There the second browser is Debian's Chromium 154.

## 7. Acceptance checks

After every run the harness validates `events.jsonl` and `result.json` against the regenerated schemas, checks that JSONL stdout is exactly those events (for a host program, that its reporter's JSON lines are, and that the result it printed is `result.json`), checks that every `assertion.passed` carries `judgedBy` and rests on an earlier look when it has a locator, and checks cleanup as section 9 describes. The last column names the unit tests that check the same logic with fakes.

| # | Check | Real proof, in `tests/integration/` | Fails if | Mocked only, in `tests/unit/` |
| --- | --- | --- | --- | --- |
| 1 | `press`, short list | `m3-press`, 2 tests. Enter on a field and Enter on the keyboard each submit once: the app counts 2 searches for the two tests, each of which shows its own query, and each test records `/actions` then `/actions/submit` as navigations. Tab then Shift+Tab move the focus from First to Second and back, and the page heard `Tab Tab:shift`. Each press event records its key, and its locator only when it has one. A press on a field whose focus a notice takes fails `not_actionable` with `{ check: 'focused', focus: '<div data-testid="notice">', event: 'keydown' }`, and the `afterEach` hooks then read the focus on the notice and an empty list of heard keys. A browser killed while the frozen field's key is down, once the app counted it, gives `outcome_unknown` on the press and the test, no completed press, the next test `not_run` with `session_lost`, and still one key down | a key sent twice or not at all, a stopped key a page listener heard, a missing `key` or a locator on a keyboard press, a lost key reported as `session_lost`, or a key sent again | `protocol-keys`, `browser-keys`, `browser-page-scripts`, `browser-input-guard`, `api-actions`, `runner-actions`, `reporters-press` |
| 2 | Host checks | `m3-host-checks`, 3 tests, each a host program run with `--conditions=retest-source` from a project outside the repository. Passing checks pass `saves a task`, as `host_check.passed` events with `origin: 'parent'` and in the result. A file key covers the file's setup and its test, before the test's own check, and the setup saves its state. A test whose own two assertions pass but which ends on `/account` fails `host_check_failed` with exit 1: all six checks ran, four failed, the address check leads and three are in `details.also`, and the PNG screenshot comes after the checks. `absent`, `ignoreCase` and a `RegExp` path each pass once and fail once. A body that failed lists its check `not_run`. A key naming no selected test and a misspelt file key, and a check on an app the test does not use, each exit 2 with the usage message, no `browser.started` and no request to the app. `inspect` replays the host check card, the `Not run` line and the summary row `Host checks  4 failed · 10 passed · 1 not run`, with no rerun command, and `inspect --test` shows the checks after the body's last look | a check that does not run, runs after a failed body, stops at the first failure, reads the wrong page, is ignored in the verdict, or a bad key that starts a browser | `protocol-host-check`, `runner-host-checks`, `reporters-host-checks`, `reporters-host-check-lines`, `inspect-timeline` |
| 3 | Observations | `m3-observations`, 3 tests. With the save answering after 1500 ms, all seven passed locator assertions, `toHaveValue`, both `toHaveText` forms, `toBeVisible`, `toBeHidden`, `toHaveCount` and an `expect.soft`, say `judgedBy: 'parent'` and name a look written before them on which their matcher passes, read independently from the look's own record; each carries its look's page address. `toMatch` and `expect.poll` say `judgedBy: 'child'`. Ids run `o1` onwards in order; the saved-task check wrote one event per look, its first saw "Saving…", and it rested on its last. `inspect --test` prints "looked N times, passed on oN: 1 match, text "Release checklist"" and marks `toMatch` "reported by the test file". A page showing a secret reads `Signed in as {{password}}` in the look, and no file of the run folder holds the value. `forged-visible` sends `goto` and `observe` itself and then `assertion.passed` for `toBeVisible` naming `o1`, a look with count 0: the test ends `test_error` with the exact message, no `assertion.passed` is written, the look is the parent's, the process it printed is gone, and the next test is `not_run` | a pass with no look, a look missing or written after the pass, a look on which the matcher fails, a forged pass written or its process left running, or a value pass marked `parent` | `runner-observations`, `protocol-locator-checks`, `protocol-observation-record`, `assertions-observation-id`, `inspect-looks` |
| 5 | Proxy | `m3-proxy`, 2 tests, from a config with four apps on `chrome()` that differ only by proxy. The app refuses any request without the header the fixture proxy adds; with `bypass: ['<-loopback>']` the proxy check page loaded, and its fetch, its service worker's fetch and its frame of another site answered, and the proxy log holds each of those requests (the test never claims the log holds only them, since Chrome's own requests are there too). With `['<-loopback>', 'localhost']`, `http://localhost:<port>/actions` showed the app's refusal, so the request came without the proxy, and the proxy never saw it. A closed port as the proxy gives `setup_failed` "Could not open … through the proxy http://127.0.0.1:<port>: net::ERR_PROXY_CONNECTION_FAILED. The proxy failed, not the app." A proxy that answers 407 gives `not_actionable` `net::ERR_INVALID_AUTH_CREDENTIALS`. `browser.started` records each app's server and bypass, all four share one browser, and the replayed report prints `· proxy … · bypass <-loopback>, localhost`. `doctor` names a refusing proxy and exits 0, since it does not check the proxy | a page request that went around the proxy, a bypassed host that went through it, a proxy failure blamed on the app, or a missing `proxy` on `browser.started` | `config-validate`, `runner-proxy`, `browser-proxy`, `browser-navigation`, `cli-doctor`; real Chrome at the browser level in `browser-proxy` |
| 6 | Host-style run, short list | `m3-host-run`, 2 tests. The tarball, installed offline in a project outside the repository, runs `examples/host/host.ts` with no source condition: the config under the label `host.config.ts`, with no file there; the password and the one-time code as functions and `resolveSecrets(config, {})`; the test written into `checkout-*/checkout.retest.ts` and keyed by that path; Chrome for Testing through the fixture proxy with `<-loopback>`; an address, a present text and an absent text check; `testEnvironment: { CANARY: 'visible' }` while the host's environment holds `HOST_TOKEN` and `HOST_PASSWORD`; its own run folder and a reporter that prints each event. It passes with exit 0; the app refused nothing and the proxy carried the sign-in, the code and the save; the three checks are parent events and in the result; the three locator assertions are `judgedBy: 'parent'`; the fills name `password` and `code` and the press names Enter; the test printed `CANARY is set`, `HOST_TOKEN is not set` and `HOST_PASSWORD is not set`; the password, the code the app sent and the host's token are in no file of the run folder, in stdout, which is the collected events, or in stderr. Against the `wrong-page` app the same run exits 1 with `host_check_failed`, the page on `/drafts`, and the two text checks passed | a request that skipped the proxy, a check that is not the parent's, a host variable in the test process, a secret in any output, or a wrong page that passes | `runner-test-environment`, `runner-secrets` |
| 8 | Package, short list | `m3-package`, 2 tests. A consumer of the tarball, installed offline, uses every name the short list added: `KeyArgument`, `Keyboard`, `HostCheck`, `PageReading`, `ProxyOptions`, `ResolvedSecrets`, `TextQuery`, `resolveSecrets`, `HostCheckActual`, `HostCheckRecord`, `HostCheckResult`, `HostCheckStatus`, `ObservedRecord`, `testId` and `testTitle`. With its registered config and a test that presses keys, it type-checks on TypeScript 6.0.3 and 7.0.2 with `skipLibCheck: false`, and running it gives the expected id and a function secret. `press('Entr')` and `keyboard.press('Control+a')` fail with exactly two TS2345 errors carrying their `RetestTypeError` messages on both compilers. Its installed `retest` runs the presses against the fixture, with one search and the keys Enter, Tab and Shift+Tab | a name missing from the tarball's declarations or entries, a consumer error, a refused key that compiles, or a press that fails from the installed build | `protocol-entry`, `type-diagnostics`; `npm run test:types` for the repository's own fixtures |
| 9 | Milestones 1 and 2 hold | Every existing integration test passes: 159 browser-level, 51 of milestone 1 and 54 of milestone 2, now with the `judgedBy` check and the new scratch folders | any of them failing | |

The negative controls are part of the checks: the wrong page, the forged claim, the refusing and challenging proxies, the bypassed host the app refuses, the covered field and the killed browser each have to come out as the check says, or the test fails.

## 8. The two source changes

**A host check's text is redacted.** A host could write a secret into a check's `text`. `Redactor.redactFields` in `src/runner/redactor.ts` now treats the `text` of a record whose `kind` is `text` and which parses as a host check record as free text (`isHostCheckText`). The walk already reaches every place a record is written: the `host_check.*` events, `TestResult.hostChecks` and `run.started.options.hostChecks`; messages and `details` were free text already. A locator's `text` stays an identifier. The page is still asked for the text as written.

- Tests: `runner-redactor` "redacts a text host check's text wherever it is recorded: its events, run.started and the result", which also keeps a locator's text as it is, and the existing "redacts what a look observed and a host check saw and looked for, and leaves their locator and counts alone", which used to expect the check's text kept and now expects it redacted; `runner-host-checks` "a host check whose text holds a secret", two tests: the page is asked for the text as written, the text reads `{{password}}` in `run.started`, the events and `result.json`, and no line of `events.jsonl` and nothing in `result.json` holds the value.
- Before and after: with the new line of `#redactFields` removed, 4 of the 41 tests in those two files fail (`/tmp/retest-m3-verify/before-redaction-2.txt`: the value in `run.started` and both `host_check.*` events); with it, 41 pass (`after-redaction.txt`).

**No rerun command for a run the command line cannot reproduce.** `canRerun(run)` in `src/reporters/commands.ts` is false when `run.started.options.hostChecks` is present, or when the run's config names a file that is not there under `rootDir`. `testCard` and `fileCard` in `src/reporters/failure-card.ts` then leave `rerun` out, so the human report, its replay by `inspect` and `inspect --test` print only the `Inspect` line. The agent report's `next:` line already points to `retest inspect`.

- Tests: `reporters-host-checks` "a run with host checks prints no rerun command, and its card points to inspect", and the exact card of "each failed check is a block of its own", which used to hold `Rerun  npx retest run tests/checkout.retest.ts:3 --config host.config.ts`; `reporters-variants` "a config with no file behind it gets no rerun command, and the card and the next line point to inspect", beside "repeat a config at another path", which now writes that config file so its rerun line stays. Integration: `m3-host-checks` finds no `Rerun` in the replayed report.
- Before and after: without the change, 3 of the 31 tests in `reporters-host-checks`, `reporters-variants` and `inspect-variants` fail (`before-rerun.txt`); with it, 31 pass (`after-rerun.txt`).

## 9. Cleanup

Unchanged from part 2, section 9, and checked after every command, host programs included: nothing left in the command's process group, every browser and server group it reported gone, no `retest-*` entry in its `TMPDIR`, no process using that folder, and no saved state in the run folder. The harness's scratch folders now come from `tests/support/temp-folder.ts`, under one `retest-tests-*` root per test process, and each is still removed after its test. The fixture proxies close after each test. The press check kills only the browser group its run reported.

After the gates, the system temporary folder held no `retest-*` folder, and `ps` showed no fixture server, `retest` process, test file process or Chrome with a Retest profile. The only Chrome processes left were the person's own and six-day-old Playwright ones this phase did not start. The throwaway image `retest-linux:m3-verify` was removed after the Linux run.

## 10. Not verified

Most important first.

1. On Linux, only the milestone 3 group ran, and not through `docker/linux/run.sh` as written (section 6). Unit, types, the browser group and milestones 1 and 2 were not rerun on Linux in this phase. Chrome for Testing 153 did not run on Linux.
2. Apart from `m3-host-run` on Chrome for Testing 153, the `m3-*` checks ran on Google Chrome 154 only on macOS. F1 and F5 were shown on both browsers by their probes.
3. Only an http proxy ran. SOCKS and https proxies, `ERR_PROXY_AUTH_UNSUPPORTED`, `ERR_PROXY_CERTIFICATE_INVALID` and `ERR_NO_SUPPORTED_PROXIES`, a proxy that closes the connection mid-page, and one proxy on two apps of the same test were not run.
4. *Changed by the wave 1 review (`docs/plans/milestone-3/review.md`, m2): `name` and `path` are redacted as `text` is.* A host check's `name` and an address check's `path` are written as given; only a text check's text is redacted. The guide tells hosts to keep secrets out of them.
5. These are checked only with fakes: a host check on a page still redirecting when the body ends, a run interrupted during host checks, a lost browser during a check, the `observation` event being written before the answer, and a look answered after its test was revoked.
6. `press` on an emulated touch screen, with a window, or with the macOS editing commands a headed browser needs, did not run.
7. That the failure screenshot shows the page the checks read is shown only by order: `evidence.captured` comes after the last `host_check.failed`. Nobody looked at the image.
8. Two runs at once in one process, `lastRunFile`, the stop reason and the resolve hook belong to the rest of wave 1 and were not tried. *Tried by the rest's verification: section 19, checks 6 and 7.*

## 11. Defects found in phase 2's work, not fixed

1. *Fixed before the short list was committed: the card counts `expected` and `received` as shown, and the replayed card in `m3-host-checks` has no repeated lines.* **A leading host check's card repeats its values.** `unshownDetails` in `src/reporters/failure-card.ts` counts `attempts`, `timeoutMs` and `also` as shown for a host check, but not `expected` and `received`, which the runner puts in `details` (`checkFailure` in `src/runner/run-host-checks.ts`). A real address check's card therefore ends with `expected "http://127.0.0.1:…/"` and `received "http://127.0.0.1:…/account"` under the `Expected` and `Page` lines, and a text check's with `expected "…"`; the agent report prints the same lines. The unit fixtures in `tests/unit/reporters-host-check-fixtures.ts` give their failures no such details, so the reporter tests do not see it. Seen in the replayed report of `m3-host-checks`.
2. *Fixed before the short list was committed: `src/index.ts` exports `ProxySettings`.* **`ProxySettings` is not exported** from the root entry, beside `TargetConfig`, `ChromiumOptions` and the other config types in `src/index.ts`. A host that types its proxy settings apart from a target cannot name the type.
3. *Changed by the wave 1 review (m4): `judgedBy` is required.* **`judgedBy` is optional in the event schema**, while M3-3 says every `assertion.passed` carries it. It keeps milestone 2 event files valid, and the parent always writes it; the harness now checks it on every run.

## 12. Changes outside the usual

- The harness's `scratchFolder` now makes its folders with `tempFolder` from `tests/support/temp-folder.ts`, as the rules for tests ask, and `readFinishedRun` checks `judgedBy` on every run. Both apply to every milestone 1 and 2 check that goes through `cli-harness.ts`, and all of them passed.
- To remove the first throwaway image this phase built, it ran `docker image prune -f --filter dangling=true`. That removes every untagged image no container uses, on the whole machine, not only this phase's.

## 13. The rest of wave 1: what works

1 October 2026. The rest's verification phase wrote sections 13 to 23 from checks it ran itself, against the same contract. Phases 1 and 2 of the rest had finished. This phase made three changes in `src/`, which the orchestrator decided (section 17), and nothing else there. How to use what is described here is in [the guide](guide.md), under "Choosing, ticking and scrolling", "Titles and what opened each page" and "Use Retest from code".

Verified through the real command line and the real `/runner` subpath, as subprocesses, against real Chrome and the task-app fixture on ephemeral loopback ports:

- `select` by label, by `{ value }`, and a list for a `<select multiple>`, a list of one included, all as script: the page hears `input` then `change`, both untrusted. An option that arrives late is waited for; one that never does fails `not_found` when the action budget runs out; two options with one label fail `ambiguous` at once.
- `check` and `uncheck` on a native checkbox, an element whose role is checkbox and a hidden checkbox through its styled label. One already checked sends nothing. A setting that cancels its click fails `not_actionable` after one click, which the server counted once. `uncheck` on a radio button is `unsupported`. A covered checkbox is not clicked, and a checkbox a cover takes as the pointer arrives has its press stopped before the page hears it.
- `page.scroll` makes the feed load more items once, and `locator.scroll` on the terms enables Accept. A covered list is not scrolled and the page hears no wheel.
- Titles on `navigation`, action, look and assertion events, and on host checks' `actual`. A redirect chain gives each document its own title. A secret the page makes its title reads `{{password}}` everywhere, and no report carries a control character from a title.
- Each navigation's cause: `goto` for a goto, `action` for a link, Enter in a form and `pushState` in a click listener, and `page` for a redirect the page makes on its own after it loads.
- The host-style run of acceptance check 6, extended: its test file in a new folder with no `node_modules`, no last-run file, the run folder read back with `readRunFolder`, the page the checks read opened by an action, and a stop with a `Failure` recorded as the reason, exit 130.
- Two `runFiles` calls at once in one process, both passing, each folder holding only its own run.
- The tarball exports every name wave 1 added, a registered consumer that chooses, ticks and scrolls type-checks on TypeScript 6 and 7, and the calls the types refuse fail on both.
- Every milestone 1 and 2 integration test, the browser-level tests and the short list's milestone 3 checks still pass.

## 14. Environment

The same as section 2: macOS 27.0 arm64, Node.js 24.12.0, Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12 on macOS, TypeScript 6.0.3 and 7.0.2. Linux: Docker 29.8.1 on linux/arm64 in Docker Desktop, Debian 13.7, Node.js 24.21.0, Google Chrome 154.0.8037.92 and Debian's Chromium 154.0.8037.57, as the user `node`, with Chrome's sandbox on. Every browser ran headless.

## 15. Files

This phase added:

| Path | Purpose |
| --- | --- |
| `tests/integration/m3-actions.test.ts` | Acceptance check 1, the rest's part |
| `tests/integration/m3-titles.test.ts` | Acceptance check 4 |
| `tests/integration/m3-concurrent-runs.test.ts` | Acceptance check 7 |
| `fixtures/tests/choices.retest.ts`, `scroll.retest.ts` | The scenario files `m3-actions` runs |

This phase changed:

| Path | Change |
| --- | --- |
| `src/protocol/page-facts.ts` | `readPageTitle` cuts at `readTitleLimit`, 4096 code units; `recordedTitle` cuts to 300. `pageTitle` is gone (section 17) |
| `src/browser/document-facts.ts`, `page.ts`, `contract.ts` | The browser reads titles with `readPageTitle` |
| `src/runner/redactor.ts` | Titles are redacted, then cut, even while no secret is known; the heuristic is gone; a value with nothing to change comes back as it is |
| `src/reporters/actions.ts` | A select's `multiple` reaches `describeCommand` |
| `src/reporters/failure-card.ts` | `runFailureToShow` always shows a stopped run's failure |
| `tests/unit/protocol-page-facts.test.ts`, `browser-document-facts.test.ts`, `runner-redactor.test.ts`, `runner-titles.test.ts`, `reporters-actions.test.ts`, `runner-stop-reason.test.ts` | The tests of those changes |
| `tests/support/fake-browser.ts` | Reads titles as the browser now does |
| `tests/integration/browser-navigation.test.ts` | The title test expects a long title whole up to 4096 code units, as fix 1 changes it |
| `tests/integration/m3-host-run.test.ts` | Check 6 extended, and a third test: the stop with a `Failure` |
| `tests/integration/m3-host-checks.test.ts` | Host check `actual` carries `title`, and the replayed card and timeline show it |
| `tests/integration/m3-package.test.ts` | Check 8, the rest's part: the new names, a consumer that chooses, ticks and scrolls, and `select(1)` and `scroll()` refused |
| `tests/integration/cli-harness.ts` | `startHost` and `finishHost`, so a check can signal a host program mid-run |
| `examples/host/host.ts`, `checkout.retest.ts` | The host writes its test into a new folder under the system temporary folder and runs there, with `lastRunFile: false`; reads its run folder back; stops with a `Failure` on SIGTERM. The test follows the account page's link to its tasks instead of a `goto` |
| `fixtures/task-app/sign-in.ts` | The account page links to the tasks, as "Your tasks" |
| `fixtures/task-app/titles-page.ts`, `server.ts` | `/titles/greeting`, a form that sends a name to `/titles/echo`, which makes it the title |
| `docs/guide.md` | The four actions and their notes, titles and causes, the stop reason, `lastRunFile`, secret functions' signal, test files anywhere, `readRunFolder`, two runs at once, and the limits |
| `docs/plans/milestone-3/build-plan.md` | Two decisions in M3-4: where the `action` window ends (fact F12), and redacting a title before it is cut |

## 16. Facts established in real Chrome

The Browser agent of phase 2 established these on Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12, headless, with Retest's own CDP client, each probe in its own profile. The probes and their output are in `/tmp/retest-m3r-browser/probes/` on the machine that ran them, outside the repository: `probe-f3.ts`, `probe-f3-typeahead.ts`, `probe-f4.ts`, `probe-f6.ts`, `probe-f6-scale.ts`, `probe-f7.ts`, `probe-f7-order.ts`, `probe-f12.ts`, `probe-f12-fence.ts`, `support.ts`, and one `*-output.txt` for each. This phase read the output and relied on it; it did not rerun the probes.

- **F3 holds.** A `Runtime.callFunctionOn` that sets a select's selection and dispatches `input` then `change` reaches the page's listeners in every phase, window capture, target, the `onchange` property and document bubble, as the browser's own events do, with `isTrusted: false`, `bubbles: true`, and `composed` true for `input` and false for `change`. A select multiple keeps exactly the chosen options. For the record, type-ahead on a focused, closed select changes it with trusted events on both platforms without opening its list: `c` chose the first option starting with c, `c` and `o` at once chose the one starting with "co", and `c` again after a pause cycled. ArrowDown changed nothing on macOS and chose the next option on Linux. Output: `f3-output.txt`, `f3-typeahead-macos-output.txt`, and `f3-typeahead-linux-output.txt` from the Linux harness.
- **F4 holds.** A trusted click on a `<label>` makes the browser click its control, with `isTrusted: true`, after the label's own `click` has finished dispatching: for a `display: none` checkbox by `for`, a zero-size checkbox inside the label, and a `visibility: hidden` radio. The control's `input` and `change` follow, trusted. A control whose click is cancelled gets the click and no `input` or `change`. Output: `f4-output.txt`.
- **F6 holds.** A `wheel` listener with `passive: false` added on the window only while a scroll is armed, and removed after, leaves the page's own scrolling as it was: the box scrolled 300 pixels armed and disarmed alike. `Input.dispatchMouseEvent` `mouseWheel` scrolls the scroll container under the point. Armed, the listener had seen the wheel by the time the call answered in 20 of 20 rounds, so the guard knows where the wheel went when the input's call returns; a passive page listener alone had in 19 of 20. Stopped by the guard, nothing scrolls and the page hears nothing. On an emulated touch screen the wheel still scrolls. Distances: with a device pixel ratio of 2 on a desktop viewport, 300 sent scrolled 300 CSS pixels and the page's `deltaY` read 150; on an emulated phone page with no viewport meta, zoomed to 0.42, 300 sent scrolled 714, so Retest multiplies the delta by the visual viewport's scale; with `width=device-width` it scrolled 300 and `deltaY` read 114, the delta over the ratio of 2.625. Output: `f6-output.txt`, `f6-scale-output.txt`.
- **F7 holds.** `Page.lifecycleEvent` `DOMContentLoaded` for a committed loader comes after a `<title>` in the head has set `document.title`, for a server page and for each document of a redirect chain; a page with no title, and one whose script sets it after load, read as empty then. A document that sends the browser on at once can have moved on by its `DOMContentLoaded`, so its title is read from the next document or not at all; Retest settles it with none. A call into a document the frame is leaving gets no answer until the next commit. A read sent after `DOMContentLoaded` into a page that refreshed itself as it loaded failed with "Cannot find context with specified id" in 3 of 5 rounds, and answered with the next document's title in the other 2. So Retest drops a read that answers after a newer commit, and settles the title with none; `browser-navigation` checks that in real Chrome. Output: `f7-output.txt`, `f7-order-output.txt`.
- **F12, and the decision it made.** A navigation the page requests while it handles an action's input can reach Retest after the call that delivered the input has answered: a link's `Page.frameRequestedNavigation` came after the `mouseReleased` answer in 5 of 20 fence rounds (4 of 10 on Chrome 154, 1 of 10 on Chrome for Testing 153), and in 3 of 6 rounds of the first probe; a `location` change in a click listener did so once in 6. A `history.pushState` or `replaceState` in a click listener reported `Page.navigatedWithinDocument` after the input's answer in every round. Every one of them reached Retest before the answer to the next call into the page: 100 of 100 fence rounds, a link, a `location` change, `pushState`, `replaceState` and Enter in a form, 10 of each on each browser. A `change` listener run by the select call requested its navigation before that call answered, 6 of 6. A navigation a `setTimeout(0)` in a click listener starts came after the next call's answer, 20 of 20. So the orchestrator decided that the `action` window ends at the answer of the guard's disarm call after the input, and for `select` at the answer of the call that applies the selection, rather than at the last input call's answer; M3-4 now says so. `Page.navigate` raises no request and answers with its loader. Output: `f12-output.txt`, `f12-fence-output.txt`. The brief for this phase gave the fence count as 120 of 120; the output holds 120 fence rounds, of which the 100 above are input-driven and the other 20 are the timer's.

This phase found one more fact while writing `m3-titles`: Chrome itself turns C0 control characters in a `<title>` into white space and collapses them, so an escape and a bell between two words read as one space. It keeps C1 characters such as U+009B, and Retest removes those. `m3-titles` fails when Retest's removal is taken out: the title then holds `\x9B` twice.

## 17. The three source changes

The orchestrator decided all three after phase 2. Each has tests that fail before it, run from a copy of the tree with phase 2's files for the change put back, `/tmp/retest-m3r-verify/before-tree/`, since this repository keeps its work uncommitted and nothing may be stashed.

**1. A title is redacted before it is cut.** The browser used to cut a title to 300 code units, and the runner redacted it afterwards, dropping a tail of a title of 284 units or more that could be the start of a secret. Now `readPageTitle` in the browser removes control characters, trims, and cuts only at 4096 code units, never inside a surrogate pair. The parent redacts every title it records or sends to the test process, events, results and command answers alike, and only then cuts it to 300 with `recordedTitle`. It cuts even while it knows no secret, so `redactFields` now walks every value; a value with nothing to change comes back as the same object and is not parsed again. The heuristic is gone.

**Changed after the final review, 1 October 2026:** the browser now hands the parent the raw title, bounded only at 65,536 code units (`titleReadLimit`), and the parent redacts it, cleans it (`cleanTitle`), redacts it again and only then cuts it to 300. `readPageTitle` and the 4096 cut are gone, because cleaning or cutting before redaction could leave part of a secret the redactor no longer recognised.

- Tests: `runner-redactor` "redacts a title before it cuts it, so a value that runs across the cut is hidden whole", "a value that starts after the cut is gone with the rest, and a title is never longer than the limit, even once a placeholder is longer than its value", and "cuts a long title even while it knows no secret, and leaves a value with nothing to change as it was"; `runner-titles` "long titles in a run", which runs a test file through the fake browser with a title whose secret runs across the 300th unit and one whose secret starts after it; `browser-document-facts` "a title longer than Retest records reaches the parent whole, up to 4096 code units"; `protocol-page-facts`, rewritten for the two functions; and the real-Chrome title test in `browser-navigation`, which now expects a title of 305 code units whole and one of 4101 cut at 4095, before a surrogate pair.
- Before and after: in the before tree, 5 of the 38 tests in `runner-titles`, `runner-redactor` and `browser-document-facts` fail (`/tmp/retest-m3r-verify/fix1-before.txt`): the runner recorded `aaa…a` where the secret had been, and `redactTitle` returned titles longer than 300. After, those files and `protocol-page-facts` pass, 47 of 47 (`fix1-after.txt`).
- What a reader sees: a secret that starts before the cut leaves the start of its placeholder, as in `…{{pas`, and never the start of the value. A secret longer than 3796 code units that starts before the cut would run past 4096 and is not handled.
- How it differs in practice: this phase could not build a title on which the old heuristic leaked. The only case it found needs a secret with 17 or more spaces in a row, of a kind JavaScript trims but `document.title` does not collapse, such as U+00A0. The change makes the rule simple, and keeps a title with a placeholder longer than its value within 300 units, which the old order did not.

**2. Reports write a list as the test wrote it.** `writtenCommand` in `src/reporters/actions.ts` passes the event's `multiple` to `describeCommand`, so `select(['Garlic'])` prints with its brackets, in the human card, the agent line and `inspect --test`.

- Test: `reporters-actions` "a select the test gave a list is written with its brackets, even a list of one". Integration: `m3-actions` finds `getByLabel('Toppings').select(['Garlic']), set by script` in `inspect --test`.
- Before and after: 1 of 11 fails before (`fix2-before.txt`: the card read `select('Canada')`), 11 of 11 pass after (`fix2-after.txt`).

**3. A stopped run says why.** `run.finished` and `result.json` already carried the `Failure` a host stopped the run with, and the human and agent reports already printed it under "Run failed" when the run stopped in or between tests. They left it out in one case: a run stopped while a file was being collected gives that file the same failure, and `runFailureToShow` hid the run's failure behind the file's card, so the reports said only that files "could not be collected". `runFailureToShow` now always returns a stopped run's failure.

- Tests: `runner-stop-reason` "the file it stopped carries the reason, and the reports still say that the run was stopped and why", which stops a run while `top-level-loop.retest.ts` is being collected, and "the human and agent reports say why the run stopped, on the test it stopped and for the run", which pins the case that already worked. Integration: `m3-host-run` finds the reason in the report `inspect` replays.
- Before and after: 1 of 6 fails before (`fix3-before.txt`: no "Run failed" in the human report), 6 of 6 pass after (`fix3-after.txt`). The second test passes before and after.
- In the collection case, the reason now shows twice: on the file's card and under "Run failed".

## 18. Commands and results

From the repository root, one after another, on 1 October 2026 from 03:00 to 03:07 local time (UTC+4), each captured to a file under `/tmp/retest-m3r-verify/final/` and read after it ended. Only this handoff and the guide changed after this run. An earlier full pass at 02:46 to 02:55 gave the same counts (`/tmp/retest-m3r-verify/*.txt`).

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | `dist/` rewritten. `dist/schemas/event-v1.schema.json` holds `cause`, `pageTitle`, `choices`, `multiple`, `changed`, `via`, `touch`, `scroll`, `input` and the four new action kinds |
| `npm run typecheck` | 0 | TypeScript 6.0.3 and 7.0.2 on the root project, which includes `examples/host`, then 6.0.3 on `examples/tasks`. No errors, no `FATAL` |
| `npm run test:unit` | 0 | 1533 tests in 278 suites: 1533 passed, 19.1 s. This phase added 9 of them |
| `npm run test:types` | 0 | "141 expected errors matched 141 markers in 4 projects" on TypeScript 6.0.3 and on 7.0.2 |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/browser-*.test.ts" tests/integration/cdp.test.ts` | 0 | 184 tests: 184 passed, 65.8 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/matrix-*.test.ts" tests/integration/run-interrupt.test.ts tests/integration/cli-commands.test.ts tests/integration/package-smoke.test.ts` | 0 | 51 tests: 51 passed, 65.1 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m2-*.test.ts"` | 0 | 54 tests: 54 passed, 112.1 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 19 tests in 8 files: 19 passed, 60.1 s |

No group took five minutes, so none was split.

On Linux, the milestone 3 group ran through the harness as written, at 03:06, and passed:

| Command | Exit | Result |
| --- | --- | --- |
| `RETEST_LINUX_IMAGE=retest-linux:m3r-verify sh docker/linux/run.sh node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 19 tests: 19 passed, 50.7 s |

`RETEST_LINUX_IMAGE` gave the image a tag of this phase's own, so `retest-linux:dev`, built two hours earlier by someone else, was not retagged. The image built from the cache with no network: `package.json` and `package-lock.json` match that image's, and its `npm ci` layer was reused. `run.sh` passes `--init`, `--cap-drop ALL` and the seccomp profile, and no `--network none`; the checks install the tarball with `--offline` and reach only loopback. The second browser there is Debian's Chromium 154, so `m3-host-run` ran on it rather than Chrome for Testing. This phase removed the two images it built, `retest-linux:m3r-verify` and its earlier build, by name and id; it pruned nothing.

## 19. Acceptance checks

After every run the harness validates `events.jsonl` and `result.json` against the schemas `npm run build` writes, checks that JSONL stdout is exactly those events (for a host program, its reporter's lines; for two runs at once, each run's events in its own order and nothing else), checks `judgedBy` on every `assertion.passed` and that a locator pass rests on an earlier look, and checks cleanup as section 20 describes. The last column names the unit tests that check the same logic with fakes.

| # | Check | Real proof, in `tests/integration/` | Fails if | Mocked only, in `tests/unit/` |
| --- | --- | --- | --- | --- |
| 1 | Actions, the rest | `m3-actions`, 2 tests, through the command line. Choices: six selects record their choices, `input: 'script'`, `changed` (false for the option already chosen) and `multiple` for both lists; Peru, added 300 ms after a click, is waited for; the page heard `input` and `change` untrusted for each change, five times. Six checks and unchecks record their locators and `changed`, and the hidden newsletter box `via: 'label'`; the page counted `agree=2 remember=2 newsletter-label=1 newsletter=1` clicks. Atlantis fails `not_found` after the 2000 ms budget with `{ choice, waitedMs }`; Paris fails `ambiguous` in under a second with `{ choice: "'Paris'", count: 2 }`; `uncheck` on Small fails `unsupported` with its message; the covered box fails `not_actionable` with `covering`, and the box a cover takes on hover with `interceptedBy` and `event: 'pointerdown'`; after each of these four, the `afterEach` hooks read no change and no pointer event heard. The locked setting fails `not_actionable` with `{ check: 'state', inputSent: true }` and the server counted one click. `inspect --test` writes each select, list brackets included, and the label and already-checked notes. Scroll: the page scroll records `{ x: 0, y: 5000 }` and the feed asked once; the terms scroll records its locator and Accept is then clicked; the covered list fails `not_actionable` with `covering`, and the page heard no wheel | a select sent as input or as a trusted event, a missing option that does not wait, an ambiguity that waits, a second click on a control that ignored the first, a covered control or list that receives input, a wheel that loads twice, or a list printed without its brackets | `browser-select`, `browser-check`, `browser-scroll`, `browser-page-scripts`, `protocol-option-choices`, `protocol-scroll-delta`, `api-actions`, `runner-actions`, `reporters-actions` |
| 4 | Titles and causes | `m3-titles`, 1 test, a project with an `env` secret, run three times: JSONL, human, agent. The eight navigations of one test are, in order, `/titles` goto "Titles", `/titles/next` action "Next" (a link), `/titles` goto, `/titles/next` action (Enter in a form), `/titles` goto, `/titles/pushed` action "Pushed" (`pushState` in a click listener), `/titles/redirect` goto "Redirecting" (the server's 302 from `/titles/chain`), and `/titles/next` page "Next" (the page's own redirect 100 ms after load). Each action names the page it acted on, every look names the page it read, and each look that found the arrival read "Next". A name typed as `secret('password')` into a form that makes it the next page's title reads `{{password}}` in the navigation and the check, and the value is in no file of the run folder and no output. A title of ESC, `[2J`, U+009B, `31mAlarm`, BEL, U+009B and `0m` is recorded as `[2J31mAlarm 0m`, and the live human report, the agent report, the replayed report and three `inspect --test` timelines hold no control character; the human reports print `Page "[2J31mAlarm 0m" at …/titles/echo`, and the timelines print each navigation with its title and cause | a navigation with no title or the wrong cause, a document given another's title, a secret in a title, or a control character in any report | `protocol-page-facts`, `browser-titles`, `browser-navigation-cause`, `browser-document-facts`, `runner-titles`, `runner-redactor`, `inspect-titles`; real Chrome at the browser level in `browser-navigation` |
| 6 | Host-style run, extended | `m3-host-run`, 3 tests, the tarball installed offline outside the repository, on Chrome for Testing 153 through the fixture proxy. On top of section 7's checks: the test file is in a folder under the host's temporary folder that holds that file and nothing else, no `node_modules` and no `.retest`, and it is the run's `rootDir`; the project has no `.retest` either; the checks are keyed by `checkout.retest.ts`; the host read its folder back from `result.json` with the same result and the same events, deeply equal to what it held in memory; the four navigations are `/code/sign-in` goto, `/code/verify` action, `/account` action and `/` action, each with its title, and the last before the first host check is `/` by an action; the checks' `actual` names "Tasks". Against `wrong-page`, the last navigation is `/drafts` by an action and the address check fails. Stopped by SIGTERM once the Save click completed, against an app that holds the save for 60 s, the run exits 130 with status `interrupted`, `run.finished.failure` and the result's `failure` are the host's `Failure`, the test is `error` with it, its three checks are `not_run`, and the replayed report prints its message | a test file that cannot load without `node_modules` beside it (shown by taking out the resolve hook: collection fails with "Cannot find package '@rehearsal-labs/retest'"), a last-run file written, a folder that differs from memory, a last page opened by `goto`, or a stop reason lost | `runner-resolve-hook`, `runner-last-run-file`, `runner-stop-reason`, `store-read-run-folder`, `runner-secrets` |
| 7 | Two runs at once | `m3-concurrent-runs`, 1 test. A host program calls `runFiles` twice without waiting, with roots `alpha` and `bravo`, two task apps, a function secret each and two run folders. Both pass; each folder's events carry its own run id and root, and navigate only to its own app, and name the other app nowhere; each app saved once; each look read `{{note}}`, and neither value is in either folder or the output; each root has its own `last-run.json` naming its own run; the runs overlapped in time, in two browsers; stdout holds each run's events in order and nothing else; nothing either run started is left | a run that writes into the other's folder, uses the other's secret or browser, or leaves anything behind | none |
| 8 | Package, the rest | `m3-package`, 2 tests. A consumer of the tarball uses `OptionChoice`, `ScrollDelta`, `SecretContext`, `OptionChoiceRecord`, `NavigationCause`, `PageFacts`, `eventsFile`, `resultFile`, `logsFolder`, `PageNavigation`, `StopReason`, `RunFolder`, `readRunFolder` and `RunFolderReadError` beside the short list's names, and type-checks on TypeScript 6.0.3 and 7.0.2 with `skipLibCheck: false`; running it prints the three file names and "No run folder at <project>/no-run-here." from a `RunFolderReadError`. `select(1)` fails with TS2345 and `scroll()` with TS2554 on both compilers, beside the two refused keys. Its installed `retest` runs presses, two selects, four checks and unchecks, one through a label, and two scrolls against the fixture | a name missing from the tarball, a consumer error, a refused call that compiles, or an action that fails from the installed build | `protocol-entry`, `runner-entry`, `type-diagnostics`; `npm run test:types` for the repository's own fixtures |
| 9 | Milestones 1 and 2 hold | Every existing integration test passes: 184 browser-level, 51 of milestone 1 and 54 of milestone 2, and the short list's milestone 3 checks, with `m3-host-checks` now expecting titles | any of them failing | |

## 20. Cleanup

Unchanged from part 2, section 9, and checked after every command, host programs included; `m3-concurrent-runs` checks both runs' browser groups and both run folders. A host's temporary folder is inside the harness's scratch folder for that test, so the `checkout-*` folder the example leaves is removed with it.

After the gates, the system temporary folder held no `retest-*` folder, and `ps` showed no fixture server, `retest` process, test file process or Chrome with a Retest profile. The only Chrome processes left were the person's own and days-old Playwright ones this phase did not start. One fixture server this phase started by hand, to read the scenario files' output before writing the checks, outlived its run; this phase found it with `ps` and stopped it.

## 21. Not verified

Most important first.

1. On Linux, only the milestone 3 group ran. Unit, types, the browser group and milestones 1 and 2 were not rerun there by this phase, and Chrome for Testing 153 did not run on Linux.
2. The `m3-*` checks ran on Google Chrome 154 only, apart from `m3-host-run` on Chrome for Testing 153 on macOS and Debian's Chromium 154 on Linux.
3. Through the command line, no action ran on an emulated touch screen: a check that taps, and a scroll on a phone, ran only at the browser level (`browser-actions`) and with fakes.
4. `check` and `uncheck` on the roles `switch`, `menuitemcheckbox` and `menuitemradio`, and on `aria-checked="mixed"`, ran only with fakes. A disabled option ran at the browser level only.
5. `lastRunFile` as a path, a secret function's signal, and a file beside another copy of Retest were checked only with fakes and unit tests. Through the tarball, only `lastRunFile: false`, a folder with no `node_modules`, and a stop with a `Failure` ran.
6. That the guard lets the `input` event a radio button or a select fires after a click reach the page ran only for a checkbox.
7. The title rule's one-second timer, and a title settled by the next command, ran with fakes; in real Chrome every document here had its title by `DOMContentLoaded`.
8. Two runs at once shared no root. Two runs that share a root, and so a last-run file, were not tried.
9. The F12 fence probe ran 10 rounds per case on each browser. A link whose navigation reaches Retest after the disarm answer was never seen, which is not proof that it cannot happen.

## 22. Defects found in phase 2's work, not fixed

1. *Fixed by the wave 1 review (m1): `input: 'script'` only on `action.completed`.* **A failed select says "set by script" when nothing was set.** Its `action.failed` event carries `input: 'script'` whatever the failure, so the card of a select that failed `not_found` or `ambiguous` reads `Not found  getByLabel('Country').select('Atlantis'), set by script`. Seen in `m3-actions`.
2. *Settled by the wave 1 review (m5): the two calls go in one synchronous turn, so nothing can arrive between them; the plan now says what the code does.* **The action window starts a call early.** The window that makes a navigation `action` opens around the guard's verdict call, sent just before the input, rather than at the first input call as M3-4 says. A navigation the page starts on its own in that moment is counted as the action's. Read from the code (`guardInput` inside `NavigationCauses.delivering`); not seen in a run.

## 23. Changes outside the usual

- `tests/support/fake-browser.ts` is not in this phase's list; fix 1 needed it, since it stands in for the browser's reading of titles.
- The account page of the task app has a new link, "Your tasks". Every existing check that reads that page still passes.
- To show that the three fixes' tests fail before them, this phase ran them in a copy of the tree under `/tmp/retest-m3r-verify/before-tree/`, with phase 2's versions of the changed files, and linked this checkout's `node_modules`. Nothing in the repository was stashed or reset.
- To show that checks fail without what they check, this phase changed two files for one run each and put them back byte for byte: `src/protocol/page-facts.ts` without the removal of control characters (`m3-titles` failed), and `src/runner/child.ts` without the resolve hook (`m3-host-run` failed). `dist/` was rebuilt afterwards, and the final gates ran after both.
