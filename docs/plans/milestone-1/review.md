# Milestone 1 review

30 September 2026. Independent review of the milestone 1 implementation against `docs/implementation-brief.md` (section 13 first), `docs/plans/milestone-1/build-plan.md` and `AGENTS.md`. The handoff's claims were checked, not trusted. Every file in `src/` was read; the reproductions below were run against Chrome 154.0.8037.92 on macOS arm64 with Node 24.12.0, from scratch files under `/tmp/retest-review-2/` (deleted afterwards). No repository file other than this one was changed.

## Verdict

Not ready to accept as it stands, but close. The architecture does what the plan asked: the parent is the only writer of events, the child has no browser, commands are validated on both sides of the IPC, input is dispatched once and tracked with `Dispatch`, navigation listens before it navigates, `inspect` never reads a torn or unfinished run as a pass, a closed stdout ends the run with exit 2 and a stored `reporting_failed`, exit codes follow the plan, and the source has no `any`, `as` cast, non-null `!` or suppression. One blocker stands: an error thrown by test code after a file's last test has reported is logged by the child and then dropped, and the run reports `passed` with exit 0, even though the same error one test earlier gives exit 2. Three majors follow: `outcome_unknown` is decided in the parent from "a command is in flight" rather than from whether input was sent, so one run records `session_lost` on the action and `outcome_unknown` on the test; SIGTERM, which CI sends on cancel, leaves no result and an orphaned browser for a while; and the hit-test-then-press race is neither closed nor documented while the README promises a click "once it is not covered". The blocker and the first two majors are small fixes; the third needs a documentation change now and an interceptor later. Fix those, then re-review the diff.

## Blockers

### B1. An error thrown after a file's last test is dropped, and the run passes

- Where: `src/runner/child.ts:74-85` (`report` falls through to `endAfterError`, which prints the error and exits 1, when no test is current and the file is no longer loading); `src/runner/run-session.ts:151-154` (`#runFile`'s `finally` calls `child.close(abortGraceMs)` and discards the exit it returns); `src/runner/test-file-process.ts:112-121`.
- Problem: the child process exits 1 with the error on its stderr, and the parent treats that as a normal close. The file's result stays `collection: 'ok'`, every test stays `passed`, `result.json` says `passed`, `complete: true`, exit 0. The same error thrown one test earlier produces `not_run` with `test_error` "the process for this file ended between tests" and exit 2 (`tests/unit/runner-lifecycle.test.ts:243-251`), so the outcome depends on which test the stray callback lands after.
- Scenario: a test forgets to await a request whose handler throws, or a `setTimeout` in a helper throws after the last test. CI is green. Vitest and `node --test` both fail a run on an error thrown after tests end; the brief asks that a run be successful "only when collection, all selected tests and required cleanup finish successfully" and that a "recorded assertion rejection cannot be lost".
- Reproduced: yes. A one-test file whose body passes and schedules `setTimeout(() => { throw new Error('thrown after the last test ended') }, 1)`. `retest run` printed `1 passed (1) ... exit 0`; `result.json` read `passed 0 true`; `logs/<file>.log` held the error and its stack. With a 20 ms timer the child had already been told to close, so nothing threw and the run was legitimately green: the window is the parent's dispose round trip after `test-finished`.
- Fix: in `child.ts`, when `report` finds no current test and no collection in progress, send `{ type: 'process-error', failure }` (a new child message, validated like the others) before exiting non-zero, and drop the "While the file loaded" prefix in that branch. In `run-session.ts`, read the exit that `child.close()` returns and, when it is non-zero or a signal, or a `process-error` arrived after the last test, attach a `test_error` failure to the file (`FileResult.failure`, collection stays `'ok'`) and make `runOutcome` count a file failure as unfinished work (exit 2, `complete: false`), or attach it to the last test with `withAlso`. Add a unit test beside the existing "dies between tests" one for "dies after the last test".

## Major

### M1. `outcome_unknown` versus `session_lost` is decided in the wrong layer, and the two records disagree

- Where: `src/runner/running-test.ts:107-116` (`browserLost` revokes with `outcome_unknown` whenever any non-observe command is in flight); `src/browser/page.ts:102-115` and `src/browser/command-failures.ts:19-32` (the page answers precisely from `Dispatch.sent`).
- Problem: the browser layer knows whether input was written to the pipe, and its `execute` returns promptly on disconnect because the connection rejects every pending command. The parent does not wait for that answer: it revokes at once with a guessed class, answers the child with it, and the test, `test.finished` and `result.json` carry `outcome_unknown`, while `#execute` later emits `action.failed` with the page's `session_lost`. The build plan says `outcome_unknown` is for "an action had been sent"; README line 82 says "when an action may already have reached the page". The code implements neither.
- Scenario: the browser dies while a click is still waiting for a missing element. Nothing was sent, the app was not touched, yet the run tells the agent the outcome is unknown, and the timeline for the same call says the page was lost before the click.
- Reproduced: yes. A test that clicks `getByTestId('never-there')` against the fixture app, browser group killed 700 ms into the wait. `action.failed` for the click: `session_lost` "Retest lost the page before it could click ..."; `test.finished` and `result.json`: `outcome_unknown` "whether it took effect is unknown". Exit 2 either way, so the exit code is right and only the classification is wrong.
- Fix: on browser loss, do not choose a class in `browserLost`. Let the in-flight `#execute` settle (bound it with `abortGraceMs`, as `settle` already does), revoke with the failure the page returned, and keep `outcome_unknown` only for a command that has not answered within the grace period. Then the event and the verdict come from the same answer. Add a lifecycle test that kills the browser during a `not_found` wait and asserts `session_lost` on both records; `tests/integration/browser-lifecycle.test.ts:105-115` already proves the page side.

### M2. SIGTERM is not handled

- Where: `src/cli/interrupt.ts:14-25` and `src/cli/main.ts:21` register SIGINT only. Known: handoff section 10 item 1 and README "What milestone 1 does not do".
- Problem: SIGTERM ends Retest with Node's default handler, so no `run.finished`, no `result.json`, no exit hook (the hook runs on `exit`, which a default signal death skips), the profile stays in the temporary folder, and the browser survives until it notices the closed pipe. README line 11 says Retest "runs locally and in CI"; CI runners cancel with SIGTERM.
- Scenario: a cancelled CI job leaves a run folder that `inspect` rebuilds as `interrupted` (honest), a profile on the runner's disk until the next launch, and a Chrome that keeps the runner's CPU for a while.
- Reproduced: yes. `slow.retest.ts` under a wrapper that sends SIGTERM 3 s in: exit `signal=SIGTERM`, folder held `events.jsonl` ending at `test.started` and no `result.json`, `retest-profile-<pid>-*` left in `TMPDIR`, and the Chrome main process was alive with parent pid 1 immediately afterwards; it was gone about a minute later.
- Fix: register SIGTERM beside SIGINT in `abortOnInterrupt` so the first one takes the same abort path and the second exits at once. Exit 130 keeps the `ExitCode` union as is; 143 is the convention and would extend the union, the schema and `runOutcome`. Cover it in `run-interrupt.test.ts`. The exit hook then runs on both paths.

### M3. The check-then-press race is neither closed nor documented, and the README promises more than the code does

- Where: `src/browser/page-scripts.ts:84-105` does visibility, stability, the hit test at the centre and, for `fill`, `focus()` and `select()`, then returns a point; `src/browser/input.ts:13-28` presses or inserts text in later CDP round trips. Nothing checks the target again at press time. README line 66 ("presses the mouse at the element's centre once it is visible, stable, enabled and not covered") and line 65 ("A disabled, read-only or covered field fails, and keeps its value") read as guarantees.
- Problem: between the hit test in the page and `Input.dispatchMouseEvent`, page script can put an overlay over the element, replace it, or move focus. The click then lands on the overlay, and `fill` types into whatever holds focus. Retest records `action.completed`.
- Scenario: a toast or a "Saving…" scrim appears on a timer after load. The click hits the scrim; the test later fails `check_failed` on the saved text with a screenshot that shows nothing pressed, and the failure card points the agent at the assertion, not the click. If the scrim forwards clicks, the test passes for the wrong reason.
- Reproduced: no; it needs a page change inside a few milliseconds and I did not build one. The gap is plain in the code order.
- Fix now: say so in README under `click` and `fill` ("checked just before the press; a page that changes in between can take the click"). Fix properly: before the press, install a capture-phase `pointerdown`/`mousedown`/`click` listener from the isolated world that records the event target, and after `mouseReleased` compare it with the resolved element; report `not_actionable` with `check: 'hit-target'` when it differs and nothing reached the element, or `outcome_unknown` when the press was delivered elsewhere. For `fill`, compare `document.activeElement` after `insertText`, or send `insertText` in the same task as `focus()` through `Runtime.callFunctionOn` returning a promise that the Node side resolves only once `Input.insertText` has been dispatched.

## Minor

### m1. A revoked test does not cancel the page command already running

`src/runner/running-test.ts:171-187` keeps awaiting `page.execute` after `revoke` answered the child; `src/browser/page.ts:142-163` continues. A click whose actionability check succeeds right at the deadline is still pressed after the test was declared timed out, and the app receives it; the event log records `action.completed` after the revocation. Honest, but the app was touched after "the test ended". The transport already has `withdraw()` (`src/browser/cdp/transport.ts:80-83`); pass an abort into `execute` so a revocation withdraws a press that has not been written and skips a press not yet sent.

### m2. The base URL is recorded verbatim, credentials included

`src/runner/run-session.ts:125` puts `--base-url` into `run.started.options.baseUrl` as typed, and `src/reporters/commands.ts:22-29` prints it in every rerun command, while page URLs are reduced to origin and path everywhere else. `http://user:secret@host` ends up in `events.jsonl`, `result.json` and the terminal. Strip userinfo (or store `originAndPath`) before recording.

### m3. A closed stderr turns a delivered passing report into exit 2 with no message

`src/cli/main.ts:28-31` and `47-54`: `watchFailure` sets `outputFailed` for stderr as well as stdout, and `exitCodeAfterOutput` (`src/cli/terminal.ts:24-26`) maps 0 to 2. With `2>&-` and the human reporter, a passing run that echoes any child stderr exits 2 although stdout carried the whole report. Only stdout's failure should flip the code.

### m4. Budgets outside the documented seven

`src/browser/browser.ts:26-28` hard-codes `pageSetupMs` 30 s, `closeRequestMs` and `exitGraceMs` 5 s; `src/browser/chromium-process.ts:25-26` adds `killWaitMs` 5 s. `newPage` ignores the setup budget the runner bounds it with (`run-session.ts:212-213`), and `browser.close()` can take about 20 s while `#closeBrowser` (`run-session.ts:337-346`) waits `cleanup + 1 s` and then lets `main.ts` exit, leaving the last-resort exit hook to SIGKILL the group and remove the profile. Give `newPage` and `close` the runner's budgets, and document the close grace.

### m5. `run.finished` and `result.json` are built three times and can disagree

`src/runner/run-session.ts:348-363` calls `#result()` for the event, again for `end()`, and again for the file, each with its own `finishedAt`, and a reporter that fails on `run.finished` or in `onRunEnd` makes `result.json` say exit 2 while the last event says 0. The plan allows the second part; the first is avoidable: build once, add late failures to a copy.

### m6. Stray errors are attributed to whichever test is running

`src/runner/child.ts:75-76`: an exception from a timer left by test A that fires during test B fails test B, with B's name on the card. The verdict is right (the file is not clean) but the blame is wrong. Say so in README beside "Module state is shared by the tests in one file", and consider naming the origin frame in the message.

### m7. Duplicated pieces

- `Listeners`: `src/browser/listeners.ts` and a private copy in `src/browser/cdp/channel.ts:3-28`.
- `ProcessExit` and `describeExit`: `src/runner/load-tests.ts:64-66` and `src/browser/chromium-process.ts:14,115-117`.
- `errorMessage` and `messageOf`: `src/api/failure.ts:20-22` and `src/browser/browser-error.ts:14-16`.
- `observationSchema`: `src/protocol/commands.ts:36-40` and `src/browser/element-queries.ts:24-28`.
- Error-code reading: `src/store/run-store.ts:129-131`, `src/cli/file-system.ts:24-26`, `src/browser/executable.ts:27`, `src/browser/profiles.ts:50`, `src/browser/chromium-process.ts:129`, `src/reporters/code-frame.ts:45`.
- `quoteText` with two meanings: `src/assertions/format.ts:7-10` and `src/reporters/format.ts:106-111`.

### m8. The parent depends on the child-side `api/` package for pure helpers

`src/runner/run-session.ts:12-13`, `running-test.ts:8-9`, `outcome.ts:4`, `load-tests.ts:5` and `src/cli/inspect/rebuild-result.ts:5` import `failure`, `withAlso`, `withLocation`, `errorMessage`, `relativePosixPath` and `describeCommand` from `src/api/`. Those are pure and belong in `src/protocol/failures.ts` and `src/protocol/locator.ts`; `api/` should stay the authoring surface that runs in the child.

### m9. Two isolated worlds can be created for one document

`src/browser/isolated-world.ts:47-49`: two observations arriving together after a navigation both see `#context` undefined and both call `#create`; the second promise overwrites the first. Harmless today (observations may overlap by design), but assign the promise before awaiting anything, which the code already does, and guard the branch with a single in-flight create.

### m10. Foreign child events are dropped silently

`src/runner/running-test.ts:215` returns on an event whose `testId` or `attemptId` is not the running test's, while a `test-finished` for the wrong test is a violation (`:224-226`). Treat both the same.

### m11. Tests that wait on the clock instead of a signal

`tests/integration/browser-actions.test.ts:72` and `:82` sleep 200 ms and then assert `submissions() === 0`; `:115` sleeps 1000 ms for the `replaced` fixture although the fixture exposes a `save-replaced` marker the test could observe; `tests/integration/browser-lifecycle.test.ts:96` and `:108` sleep before killing the browser. The absence checks need a bound, but the bound should be the fixture's own signal (a request the page makes after the click, or the marker), not a guess. `cli-harness.ts:waitFor` shows the pattern.

### m12. Documentation gaps and overclaims

- README line 82 describes a browser-loss rule the code does not implement (M1).
- README line 118 advertises `--headed`; the handoff (section 10 item 3) says it was never run. Mark it unverified in README, or run it once and say what happened.
- The brief's section 13.3 asks that passing a `Secret` be a compile error. No `Secret` type exists in `src/` or the public declarations, and the handoff's section 3 item 3 lists promises and `any` only. Say in the handoff that `Secret` is not in milestone 1.
- README line 11 "runs ... in CI" against M2.
- Brief 13.6 says every action and assertion event carries the page URL; `pageUrl` is optional in `src/protocol/events.ts:30,45`, absent on `toBe` events and on the first action before a navigation. The schema is right to make it optional; say when it is absent in README's run folder section.

## Nits

- `src/cli/main.ts:27` and `33-34`: the two comments narrate what the next lines do.
- `src/browser/launch.ts:23` exports `defaultLaunchTimeoutMs`, used only as its own default parameter.
- `src/reporters/agent.ts:44` exports `renderAgentReport` with no consumer outside the file. The other test-only exports (`slug`, `shellQuote`, `pollDelay`, `codeFrame`, `conditionArguments`, `signalGroup`, `agentVariables`, `DEFAULT_MAX_PENDING`) are fine as test seams.
- `src/runner/running-test.ts:159-163`: the recursive `#command` after `#runOutOfTime` works but reads as a trick; a `refusal` computed after the deadline check would be plainer.
- `src/browser/page.ts:216-220`: after a same-document navigation the returned `goto` URL can still be the previous one if `Page.navigatedWithinDocument` has not arrived when `Page.navigate` answers; low stakes.
- `src/browser/navigation.ts:51-57`: a navigation replaced by a client-side redirect before `load` waits out the navigation budget and reports `timeout` although a page did load; document it.
- The handoff calls the 502 unit tests "logic, not browser behaviour" and the matrix "real-browser"; that split matches what I read in `tests/integration/*` and `tests/support/fake-browser.ts`.

## What is good and should stay

- One schema builder (`src/protocol/schema.ts`) that validates pipe input, IPC, JSON files and CLI-facing results, prints JSON Schema, and infers the types; `project()` in `src/browser/cdp-results.ts` makes CDP results forward compatible without loosening the strict objects.
- The parent stamps every sequence number and writes each event as one synchronous line before any reporter sees it (`src/runner/event-log.ts`, `src/store/run-store.ts:55-57`); `result.json` is claimed with `wx` and renamed into place.
- `Dispatch` plus `OutgoingMessage.written` and `withdraw()` (`src/browser/dispatch.ts`, `src/browser/cdp/transport.ts:70-84`, `connection.ts:235-243`): the page can say whether input reached the browser, and a command taken by a timeout is never written afterwards.
- `LoadWatcher` is built before `Page.navigate` is sent and keeps the loader ids it saw (`src/browser/navigation.ts:97-140`).
- Locator values travel as `Runtime.callFunctionOn` arguments into an isolated world; the page scripts are static strings (`src/browser/page-scripts.ts`, `isolated-world.ts:74-81`).
- `Operation` (`src/api/operation.ts`) knows whether test code observed it, without triggering unhandled-rejection noise, and assertions start only when awaited.
- `runOutcome` (`src/runner/outcome.ts`) is one readable function that matches the plan's order; `rebuildResult` (`src/cli/inspect/rebuild-result.ts`) can never produce a pass; `readEvents` accepts only a torn last line.
- Stdout failure handling in `src/cli/main.ts` and the drained exit: reproduced exit 2 with `reporting_failed` in `result.json` and a stderr explanation.
- Process ownership: a browser in its own group with a profile named after the owner, stale profiles removed only on ESRCH, EPERM treated as alive (`src/browser/profiles.ts`, `chromium-process.ts:124-135`), last-resort exit hooks for both the browser and the child.
- No `any`, `as` cast, non-null `!`, `@ts-ignore`, `@ts-expect-error` or `eslint-disable` anywhere in `src/`; named exports only; kebab-case files; the failure card prints each fact once.

## What was not verified

Most important first.

1. The overlay race (M3) was reasoned from the code order, not reproduced.
2. How long an orphaned Chrome survives after SIGTERM: observed alive immediately after and gone about a minute later; the interval was not measured.
3. Linux, Windows, Chromium builds other than Chrome 154.0.8037.92, and `--headed`: not run, and the handoff says the same.
4. The full suites, the TypeScript 7 type fixtures and the package smoke test: taken from the orchestrator's run of the final code, not rerun here.
5. A browser that refuses to close a context (`cleanup_failed` from a real refusal rather than a 1 ms budget): only the fake covers it, as the handoff says.
6. Second Ctrl+C: covered by `tests/integration/run-interrupt.test.ts`, not rerun.
7. Whether `Page.createIsolatedWorld` with the same name twice returns one world or two (m9).

## Method

- Read every file in `src/`, the four documents, the example runs and their terminal output, the harness, the matrix tests named in the handoff, the fixtures for the two late fixes, and the unit test for a process dying between tests.
- Reproductions, each in its own `TMPDIR` under `/tmp/retest-review-2/tmp/*` and its own output folder, all with the source CLI (`node --conditions=retest-source src/cli/main.ts`):
  - B1: a passing test with a 1 ms timer that throws; also with 20 ms (no throw before close, so no finding).
  - M1: a driver script that started the fixture app, ran a test clicking a missing test id with `action=20000`, killed the browser process group named in `browser.started` 700 ms into the wait, and compared the `action.failed` and `test.finished` events with `result.json`.
  - M2: a wrapper that sent SIGTERM to `retest run` 3 s in, then listed the run folder, the profile folder and any process whose command line named that `TMPDIR`.
  - Stdout: `--reporter jsonl | head -c 1`, checking the pipe status, stderr and `result.json`.
  - `inspect --json` on a copy of the passing run with `result.json` removed and the last event line cut in half; with `result.json` removed only; with line 4 of `events.jsonl` corrupted and `result.json` present; and on a tampered `result.json` (trusted, as expected).
  - `list --json` on the example.
  - Every event line of the four example runs parsed with `retestEventSchema`, every `result.json` with `runResultSchema`; the typed value "Release checklist" appears only in assertion `expected`/`actual` fields, never in an action event; `run.started` carries `browserPath`, `rootDir` and `baseUrl` and nothing from the environment.
  - Greps for casts, `any`, non-null assertions, suppressions, default exports, `console`, `Secret`, and an export-usage scan.
- Killed only the processes the reproductions started (the fixture app and the browser group reported by the run it started); confirmed nothing from the review was left running; removed `/tmp/retest-review-2/`.

## Re-check

30 September 2026, after the two fix waves described in `docs/implementation-handoff.md` section 10. Same rules as the first pass: every reproduction was run against the final code with the source CLI, real Chrome 154.0.8037.92, its own `TMPDIR` and output folder under `/tmp/retest-review-3/` (deleted afterwards); no suite was rerun in full; only processes the reproductions started were killed. Beyond the reproductions, I ran five unit files on their own (`runner-lifecycle`, `browser-input-guard`, `runner-process`, `runner-outcome`, `cli-interrupt`: 74 passed) and the real-browser `browser-actions.test.ts` on its own (36 passed, including the covering-frame, focus-moved and label cases I had not exercised by hand).

### The four findings

| Finding | Status | Evidence |
| --- | --- | --- |
| B1. Error after the last test dropped | Fixed | Same file as before (a 1 ms timer that throws after a passing test): exit 2, `result.json` `error / 2 / complete: false`, the test still `passed`, `files[0].collection: 'ok'` with a `test_error` failure "threw an error while no test was running ... Code from the earlier test ... may be the cause; this was thrown at last-stray-fast.retest.ts:5", the same failure on the run, and the human report shows "failed outside its tests", the code frame at the throw, and "Files 1 file failed outside its tests". `inspect` reads it back from `result.json`. Code: `src/runner/child.ts:79-92` sends a validated `process-error` before exiting; `src/runner/test-file-process.ts:149-158` keeps it; `src/runner/run-session.ts:144-163` closes the process before deciding the file and calls `fileProcessFailure` (`src/runner/process-failures.ts:48-67`); `src/runner/outcome.ts:94-119` counts a file failure as unfinished work |
| M1. `outcome_unknown` decided in the parent | Fixed | Same driver as before (browser group killed while a click waits for a missing element): 53 ms after the kill the run exited 2 with `session_lost` on the `action.failed` event, on `test.finished` and in `result.json`, all with the page's own message "Retest lost the page before it could click ...". Code: `src/runner/running-test.ts:125-130` waits up to `abortGraceMs` for the commands in flight, `#execute` keeps the page's loss answer (`:203`), and `#lossFailure` (`:235-245`) uses it, falling back to `outcome_unknown` only for an action that never answered |
| M2. SIGTERM unhandled | Fixed | Same wrapper (SIGTERM 3 s into a run): stderr "Stopping on SIGTERM. A second signal quits at once.", the test ends `interrupted` "The run was stopped by SIGTERM.", `run.finished` and `result.json` say `interrupted / 143 / complete: false`, the process exits 143, and right afterwards no `retest-profile-*` folder and no Chrome process using that `TMPDIR` remain. Code: `src/cli/interrupt.ts:23-36`, `src/runner/outcome.ts:69-90` and `:121-133`, `src/protocol/events.ts:18,112`, `src/cli/cli.ts:95-97`, `src/cli/commands/run.ts:71`, `src/cli/commands/list.ts:33` |
| M3. Check-then-press race open and README overclaimed | Fixed | `examples/task.retest.ts` against the fixture in `covered-on-press` mode: exit 1, click `not_actionable` "it took the press, but another element, <div data-testid="cover">, took the release. Retest stopped the release and the click before the page received them", details `{ check: 'hit-target', interceptedBy, event: 'pointerup' }`, and the app counted 0 submissions. In `covered-on-hover` mode, where the page registers its own window capture listener at load and saves on any click that reaches the cover: exit 1, `not_actionable` on `pointerdown`, 0 submissions, so the guard's listener runs before the page's. In `ok` mode the same test still passes with exactly 1 submission. Code: `src/browser/page-scripts.ts:33-84` (window capture listener from the `retest` world, installed on every new document by `src/browser/page.ts:75` through `Page.addScriptToEvaluateOnNewDocument`), `src/browser/input-guard.ts`, `src/browser/page.ts:175-186`. README lines 71-81 now say what is guarded and name the two `outcome_unknown` cases |

### The minor findings marked resolved

- m1 (a revoked test's command kept running in the page): fixed. `OwnedPage.execute` takes a signal (`src/browser/contract.ts:41`), `RunningTest.revoke` aborts each command's controller (`running-test.ts:103-106`), the connection withdraws a queued frame and rejects a written one with `CdpAbortedError` carrying `written` (`src/browser/cdp/connection.ts:132-133,145,161,242-245`), `Dispatch` reads it (`src/browser/dispatch.ts:40-50`), sleeps take the signal (`actionability.ts:65`, `isolated-world.ts:134`), and `commandStopped` gives the failure the revocation's class with `details.inputSent` (`src/browser/command-failures.ts:41-48`). Read, not reproduced by hand; `runner-lifecycle` "running out of time stops the command still in the page" and the three `browser-lifecycle` tests the handoff names cover it.
- m2 (base URL with credentials): fixed. `withoutCredentials` (`src/protocol/url.ts`) is applied in `run.started` (`run-session.ts:134`); the rerun command reads the recorded value (`src/reporters/commands.ts:23-25`); the browser still gets the original.
- m3 (closed stderr flipped a pass to exit 2): fixed and reproduced. A passing test that writes to stderr, run with `2>&-` and the human reporter: exit 0, `result.json` `passed / 0 / complete: true`. A JSONL reader that leaves after one byte still gives exit 2, stderr "The jsonl reporter failed on browser.started: ... write EPIPE" and a stored `reporting_failed`. Code: `src/cli/terminal.ts:34-56`, `src/cli/main.ts:9-10,24`.
- m4 (budgets outside the seven): fixed. `newPage(options, timeoutMs)` and `close(timeoutMs)` (`src/browser/browser.ts:67,100-116`), `stop(graceMs)` with the one documented floor `closeGraceMs` (`src/browser/contract.ts:10`, `chromium-process.ts:86-108`), and `#closeBrowser` bounds at `cleanup + closeGraceMs + abortGraceMs` (`run-session.ts:361-371`). The connection's default timeout is the launch budget (`launch.ts:45-49`).
- m5 (result built three times): fixed. `#finish` fixes `finishedAt` and `durationMs` once and applies the outcome to that (`run-session.ts:375-411`).
- m6 (stray errors blamed on the running test): fixed as far as asked. The B1 output above carries "Code from the earlier test ... may be the cause; this was thrown at ...:5" (`src/api/failure.ts:39-43`, `src/api/test-run.ts:95-99`, `child.ts:79-86`); README line 87 says so.
- m7 (duplication): fixed. One `Listeners` (`src/browser/listeners.ts`); `src/shared/` holds `relativePosixPath`, `ProcessExit` with `describeExit`, and `errorCode`; `errorMessage` lives in `src/protocol/failures.ts` and `messageOf` is gone; `observationSchema` is imported from `src/protocol/commands.ts` by `element-queries.ts`; the reporters' quoting is `quoteRecorded`. Greps confirm each has one definition.
- m8 (parent importing `src/api/`): fixed. Outside `src/api/`, only `src/runner/child.ts`, `src/index.ts` and `src/assertions/*` (the child-side API itself) import it; `protocol` imports nothing outside itself and no Node module.
- m9 (two isolated worlds): fixed. One `Creation` per document, shared by every caller and bounded by each caller's own deadline (`isolated-world.ts:101-130`).
- m10 (foreign child events dropped): fixed. `#isOwn` makes both a foreign event and a foreign `test-finished` a violation (`running-test.ts:247-263`).
- m11 (tests waiting on the clock): fixed. No `delay(` remains in `browser-actions.test.ts` or `browser-lifecycle.test.ts`.
- m12 (documentation): fixed. README states the browser-loss rule (line 76-81), SIGTERM and 143 (181-185), the guard and its two unknown cases, that `--headed` has never run (127), that CI has not been tried (11), and when `pageUrl` is absent (171); the handoff's section 11 item 4 says `Secret` is not in milestone 1.
- Nits: `defaultLaunchTimeoutMs` and `renderAgentReport` are no longer exported; `#command` checks the deadline first and computes the refusal once (`running-test.ts:169-175`); a same-document `goto` waits for `Page.navigatedWithinDocument` (`navigation.ts:145-148`), and five `goto`s in a row (`/`, `/#a`, `/#a`, `/#b`, `/`) all completed, the fragment ones in 2 to 7 ms; a client-side redirect before `load` follows the replacing document (`navigation.ts:137-143,182-184`), read only.
- The `list` gap the handoff adds (an error after collection was ignored): `src/runner/run.ts:55-68` closes the process, reads its errors and fails the file the way a run does; read only.

### New findings

Ranked. None is a false pass; all three come from the between-tests probe.

**N1, minor. A test whose process died before its body started is reported `failed` with exit 1, not `not_run` with exit 2.** A two-test file whose first test leaves a 15 ms timer that throws: the timer fired after `#runTest` had checked `endedBetweenTests` (`run-session.ts:182`) and while `#openPage` ran, so `RunningTest.run()` found the process gone and finished the test with `test_error` "The process for this file had already ended." (`running-test.ts:88-91`). `testStatus` makes `test_error` a `failed` test, so the run says `failed / 1 / complete: false`, "1 failed, 1 passed", while no check failed and the second test never ran; the file failure records the stray error correctly. The unit test for this case (`runner-lifecycle.test.ts:413-422`) passes only because the fake browser's `disposeDelayMs: 200` lets the exit arrive before the check; with a real browser the order depends on the dispose round trip. Exit 1 tells CI a check failed. Fix: after `#openPage`, and in `RunningTest.run()` when the process is not alive, produce the `not_run` result `endedBetweenTests` would have (no `test.started`-to-`failed` transition, no screenshot), and make the unit test drive the exit between the check and the body instead of relying on the dispose delay.

**N2, nit. A screenshot is taken for that never-run test.** Same path: `report.failure` is set, so `#captureFailure` runs and stores an `about:blank` screenshot for a test whose body never ran. Goes away with N1.

**N3, nit. A file's process failure has no event of its own.** `inspect --json` on the B1 folder with `result.json` removed rebuilds `files[0]` with `collection: 'ok'` and no failure; only `run.finished.failure` carries the message, and a run killed after the file failed but before `run.finished` loses it. The rebuilt result is always `error / 2`, so nothing passes, but JSONL consumers see the file failure only inside `run.finished`. A `file.failed` event (or a `failure` field on `collection.completed` at close) would keep the durable path complete.

### Regression checks that found nothing

- Process-error path: `child.ts` sends the message before exiting only when no test is current and the file is no longer loading; the window between the parent's `run` and the child's `current = testRun` is synchronous, so no error can fall between the parent's running test and the child's file-level path. An error thrown after the child has taken `close` can still exit 0 first; the handoff's section 11 item 3 says so.
- M1 grace wait: new commands the child sends during the wait fail at once with the page's `session_lost`, and a test timer firing during the wait wins the revocation; `#lossAnswer` could carry a stale `outcome_unknown` from an earlier command the test caught, but that failure was recorded first anyway.
- SIGTERM: `stopSignalOf` reads the abort reason; both CLI commands and the run map it; a second signal of either kind exits at once through the same hooks that kill the browser group and the test file process.
- AbortSignal through `Deadline`: the guard's pending `verdict` call, `beforeDeadline`, the navigation watcher and both sleeps all listen to it; `Page.createIsolatedWorld` is shared and deliberately not bound to one caller's signal.
- Removed budgets: `Deadline(0)` is accepted and `commandTimeoutMs` stays at least 1, so a spent close budget still kills and waits `closeGraceMs`.
- `src/shared/`: three one-function modules with no imports beyond `node:path`; `protocol` does not import them.
- Guard semantics worth knowing, not defects: every event of the click sequence is checked against the element, so a page that replaces or hides the button on `mousedown` fails `not_actionable` "took the press, but another element took the release" (a real user's click would not have fired either); Playwright checks only the first event. A press that lands after the document changed still reaches the new document and is reported `outcome_unknown`, as README says.
- Greps: no `any`, `as` cast, non-null `!` or suppression; all three example modes and every event of the reproductions validated during the runs.
