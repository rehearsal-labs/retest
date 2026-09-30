# Milestone 1 build plan

30 September 2026. This is the contract every build agent works from. The requirements are in `docs/implementation-brief.md`, including its section 13, and in `AGENTS.md`. This file decides how the code is shaped. If something here conflicts with the brief, stop and report it rather than choosing.

## Code quality bar

The founder asked for code that reads like Vite, Vitest and the other VoidZero projects.

- **Small modules.** Each file does one thing. Use named exports only, no default exports. Use functions where a function is enough, and classes only for stateful handles such as a connection or a page.
- **Minimal comments.** A comment explains a reason the code cannot show. Never narrate what the code does. Public API functions get a one-line JSDoc with a short example, because editors and agents read it.
- **Don't repeat yourself.** Each of these lives in exactly one module: truncation, slugs, test ids, source locations, deadline arithmetic, text normalisation, locator descriptions and exit codes.
- **Separation of concerns.**
  - `protocol` is pure: types, schemas, pure helpers, and no Node imports.
  - `browser` knows nothing about tests.
  - `runner` knows nothing about CDP.
  - `reporters` only consume events and never decide an outcome.
  - `cli` only parses arguments, wires the pieces together and maps results to exit codes.
  - No import cycles, and no all-purpose runtime singleton.
- **Types.**
  - No `any`, `@ts-ignore`, `@ts-expect-error` or `eslint-disable`.
  - No `as` casts on data from outside the process. Pipe input, IPC messages and JSON files are validated with `src/protocol/schema.ts`.
  - Avoid non-null `!`.
  - Every export has an explicit type, because `isolatedDeclarations` is on.
- **Errors.** Every expected failure becomes a `Failure` with a class. Never swallow an error, and never replace an original failure with a later one: keep both.
- **Edge cases.** Each module lists its edge cases in a test, not in a comment.
- **Names.** File names are `kebab-case.ts`. Use full words, and no numbered names.

## Process model

```
retest (parent process)                           child process, one per test file
  cli ─► runner/parent ──── IPC (validated) ───►  runner/child
         │  owns: run folder, event sequence,       imports the test file, registers tests,
         │  reporters, deadlines, the child,        runs callbacks, runs assertions.
         │  the browser and each test's context.    page and locator are proxies that
         ▼                                          send commands; the child has no browser.
       browser ─► cdp ─► Chromium (pipe, temp profile, own process group)
```

- The parent is the only writer of events, and it assigns every sequence number.
- The child sends its events up over IPC. The parent stamps each one with `sequence`, `time` and `elapsedMs`, writes it to `events.jsonl`, then passes it to the reporters.
- The parent forwards each command from the child to the test's browser page. When a test runs out of time, the parent revokes the test: it stops forwarding commands, answers every later command with a `timeout` failure, aborts the signal of the command in flight so the page stops it, and asks the child to abort. The child's process then ends whether it answered or not, because code from the timed-out test may still be running: it is asked to close once it has reported, and killed with SIGKILL if it is still there 1000 ms after the abort. The parent disposes the test's browser context and records the result. Any other revocation (an interrupt, a protocol violation, a lost browser) stops the command in flight the same way, with its own reason.
- The remaining tests of a file whose process was killed, or whose test timed out, become `not_run`, with a failure naming that test. They are never retried in a fresh process.
- The browser is launched once per run. Each test gets a new browser context and one page. If the browser is lost, the parent waits up to 1000 ms (the abort grace) for the command in flight to answer, and the page's answer decides the test's failure: `session_lost` when the command's input was never sent, `outcome_unknown` when it was. A command that has not answered by then is `outcome_unknown`. The action's event and the test's result carry the same failure. Every later test becomes `not_run`. Milestone 1 does not relaunch.
- An error a file's process reports while no test is running, or an ending of that process no test explains, fails the file itself. The child sends a `process-error` message before it exits; the parent closes the process after its last test, reads its exit, puts a `test_error` failure on the file's result and emits it as `file.failed`. Collection stays `ok`, the run is `complete: false`, and it exits 2 unless a test failed its checks. `collectFiles` does the same for `list`.
- A test whose file's process has ended before its body starts is `not_run`, and so is every test after it. The parent checks before it starts the test, again once the test's page is open, and `RunningTest.run()` checks once more before it sends the body. The failure is `test_error` and gives the process's exit. No screenshot is taken, because the body never ran, and the page is closed.
- SIGINT and SIGTERM stop a run the same way: the running test is revoked with `interrupted`, the browser is closed and `result.json` is written. The exit code is 130 for SIGINT and 143 for SIGTERM. A second signal of either kind exits at once, and the exit hooks kill the browser and the test file process.

## Module map and owners

| Path | Owner phase | Purpose |
| --- | --- | --- |
| `package.json`, `tsconfig*.json`, `package-lock.json` | Foundation | Tooling; see Tooling below |
| `src/protocol/schema.ts` | Foundation | Schema builder: runtime parse, JSON Schema and TypeScript inference from one definition |
| `src/protocol/locator.ts` | Foundation | `LocatorRecipe` schema and `describeLocator()` |
| `src/protocol/failures.ts` | Foundation | `FailureClass`, `Failure`, `SourceLocation`, `TruncatedText`, `truncateText()` |
| `src/protocol/commands.ts` | Foundation | Page commands from child to parent, and their results |
| `src/protocol/messages.ts` | Foundation | IPC message unions in both directions |
| `src/protocol/events.ts` | Foundation | The version 1 event union |
| `src/protocol/result.ts` | Foundation | Schema of the stored `result.json` |
| `src/protocol/run-folder.ts` | Foundation | File names, `testId()`, `slug()` |
| `src/protocol/timeouts.ts` | Foundation | The `Timeouts` type, defaults and `parseTimeouts()` |
| `src/protocol/deadline.ts` | Integration fixes | `Deadline`, `smallestBudget()` and `elapsedMs()`: all deadline arithmetic, for the browser and the runner. A `Deadline` may carry an `AbortSignal` that stops the work sooner |
| `src/shared/` | Review fixes | Small Node-level helpers that both the browser and the runner need: `posix-path.ts` (`relativePosixPath`), `process-exit.ts` (`ProcessExit`, `describeExit`) and `error-code.ts` (`errorCode`). Pure helpers with no Node dependency stay in `src/protocol/`, such as `errorMessage` in `failures.ts` |
| `src/reporters/reporter.ts` | Foundation | The `Reporter` interface |
| `src/runner/contract.ts` | Foundation | `RunOptions`, `CollectOptions`, `CollectResult` |
| `src/browser/contract.ts` | Foundation | The `OwnedBrowser` and `OwnedPage` interfaces |
| `scripts/write-schemas.ts` | Foundation | Writes `dist/schemas/*.schema.json` |
| `tests/types/**` | Foundation (harness), then Runner (API fixtures) | Compile-fail fixtures |
| `src/browser/cdp/**` | CDP | Pipe transport and connection |
| `fixtures/task-app/**` | CDP | The controlled HTTP fixture app |
| `src/browser/**` except `cdp/` | Browser | Launch, contexts, pages, locators, input, screenshots |
| `src/api/**`, `src/assertions/**`, `src/index.ts` | Runner | The public authoring API, running in the child |
| `src/runner/**` except `contract.ts` | Runner | Child entry, parent orchestration, deadlines, outcomes |
| `src/store/**` | Runner | Writes the run folder |
| `src/cli/**`, `src/reporters/**` except `reporter.ts` | CLI | Commands, arguments, reporters, and `inspect`, which reads the run folder |
| `examples/**`, `tests/integration/**`, `fixtures/tests/**`, `docs/implementation-handoff.md`, `README.md` | Integration | Wiring, the verification matrix, the package smoke test and the handoff |

An agent edits only the files its phase owns. If it needs a change in a file it doesn't own, it stops and reports that.

## Contracts

The Foundation phase writes these as code, and everyone else imports them. Names and shapes below are binding. The details of how each is written are the implementer's choice.

### Schema builder (`src/protocol/schema.ts`)

`s.string()`, `s.number({ integer, min })`, `s.boolean()`, `s.literal(value)`, `s.enum([...])`, `s.array(item)`, `s.object(shape)`, `s.optional(inner)`, `s.nullable(inner)`, `s.union([...])`, `s.discriminatedUnion(key, [...])`, `s.record(value)`.

- Objects are strict and reject unknown keys.
- `parse(schema, value)` returns `{ ok: true, value } | { ok: false, issues: { path: string; message: string }[] }`.
- `toJsonSchema(schema)` returns a draft 2020-12 JSON Schema object.
- `Infer<typeof schema>` gives the TypeScript type.
- Nothing more is needed for milestone 1.

### Locators (`src/protocol/locator.ts`)

```ts
type LocatorRecipe = { by: 'testId'; value: string }   // a discriminated union on "by", one member in M1
describeLocator(recipe): string                         // getByTestId('save-task'), with the value escaped as a JS string
```

### Failures (`src/protocol/failures.ts`)

```ts
type FailureClass =
  | 'check_failed' | 'not_found' | 'ambiguous' | 'not_actionable' | 'timeout'
  | 'session_lost' | 'outcome_unknown' | 'setup_failed' | 'cleanup_failed'
  | 'collection_failed' | 'test_error' | 'no_assertions' | 'not_awaited'
  | 'concurrent_commands' | 'unsupported' | 'usage' | 'interrupted' | 'reporting_failed'
type SourceLocation = { file: string; line: number; column: number }   // file is POSIX, relative to rootDir
type TruncatedText = { text: string; truncated: boolean; length: number }
type Failure = { class: FailureClass; message: string; location?: SourceLocation; details?: Record<string, string | number | boolean | null | TruncatedText> }
truncateText(value: string, limit = 4096): TruncatedText
```

### Commands (`src/protocol/commands.ts`)

```ts
type PageCommand =
  | { kind: 'goto'; url: string }                                   // exactly what the test passed; the parent resolves it against baseUrl
  | { kind: 'fill'; locator: LocatorRecipe; value: string }
  | { kind: 'click'; locator: LocatorRecipe }
  | { kind: 'observe'; locator: LocatorRecipe }                     // read-only, used by assertions
type Observation = { count: number; visible: boolean | null; text: string | null }   // visible and text are null unless count === 1
type CommandResult =
  | { ok: true; kind: 'goto'; url: string }                         // final page URL, origin plus path
  | { ok: true; kind: 'fill' | 'click' }
  | { ok: true; kind: 'observe'; observation: Observation }
  | { ok: false; failure: Failure }
```

The `fill` value never appears in an event or a log; events record `valueLength`. `observe` never waits and never retries. The child decides when to look again.

### IPC messages (`src/protocol/messages.ts`)

Parent to child:
- `{ type: 'collect'; file: string; rootDir: string }`
- `{ type: 'run'; testId: string; attemptId: string; timeouts: Timeouts }`
- `{ type: 'command-result'; id: number; result: CommandResult }`
- `{ type: 'abort'; reason: string }`
- `{ type: 'close' }`

Child to parent:
- `{ type: 'collected'; tests: { name: string; location: SourceLocation; timeout?: number }[] }`
- `{ type: 'collection-failed'; failure: Failure }`
- `{ type: 'command'; id: number; command: PageCommand; location?: SourceLocation; stepId?: string; timeoutMs: number }`. `stepId` is the step the test code was in when it sent the command; the parent puts it on the action's event.
- `{ type: 'event'; event: ChildEvent }`. `ChildEvent` is one of the step or assertion events below, without `schemaVersion`, `runId`, `sequence`, `time` and `elapsedMs`.
- `{ type: 'test-finished'; testId: string; attemptId: string; status: 'passed' | 'failed'; failure?: Failure; assertionCount: number; durationMs: number }`
- `{ type: 'process-error'; failure: Failure }`: an error thrown while no test was running, after the file loaded. The child sends it just before it exits. An error from code an earlier test left behind that throws while another test runs is not this message: it fails the running test, and its message names the earlier test and the `file:line` that threw.

Both sides validate every message they receive. A message about another test or attempt is a protocol violation: the running test fails with `test_error` and its process is killed.

### Events (`src/protocol/events.ts`)

Every event carries `{ schemaVersion: 1; type; runId; sequence; time; elapsedMs }`:
- `time` is an ISO wall-clock time.
- `elapsedMs` is monotonic time since the run started.
- `testId`, `attemptId`, `stepId` and `session` are added where they apply. `session` is always `'page'` in milestone 1.
- An action event's `stepId` comes from its IPC command. A `navigation` event carries the step of the latest command the child sent.

Event types:
- `run.started`: `{ retestVersion, node, platform, rootDir, files: string[], options: { baseUrl?: string, browserPath: string, timeouts: Timeouts, reporter: string } }`
- `browser.started`: `{ product: string; version: string; userAgent: string; pid: number; executablePath: string }`. `pid` is the browser's process id and also its process group, so a test can prove the browser is gone; `executablePath` is the absolute path that was launched.
- `collection.completed`: `{ file, tests: { testId, name, location }[] }`
- `collection.failed`: `{ file, failure }`
- `file.failed`: `{ file, failure }`. A collected file whose process failed outside its tests. The parent emits it once it has closed the process, before `run.finished`, and `failure` is the file's `failure` in `result.json`, so a run that stops before it finishes still keeps it.
- `test.started`: `{ testId, attemptId, name, file, location }`
- `step.started`: `{ stepId, parentStepId?, name, location? }`
- `step.finished`: `{ stepId, status: 'passed' | 'failed', durationMs, failure? }`
- `action.completed`: `{ command: 'goto' | 'fill' | 'click', locator?, pageUrl?, durationMs, location?, valueLength? }`
- `action.failed`: `{ command: 'goto' | 'fill' | 'click', locator?, pageUrl?, durationMs, location?, valueLength?, failure }`
- `navigation`: `{ url }`. This is the main frame only, and `url` is origin plus path, with no query or fragment.
- `assertion.passed` and `assertion.failed`: `{ matcher, locator?, expected: TruncatedText | null, actual: TruncatedText | null, comparison?: string, attempts: number, timeoutMs?: number, durationMs, location?, pageUrl?, failure? }`. `failure` is present on `assertion.failed` only.
- `evidence.captured`: `{ kind: 'screenshot', path, reason: 'failure' }`. `path` is relative to the run folder.
- `evidence.failed`: `{ kind: 'screenshot', reason: 'failure', message }`
- `test.finished`: `{ testId, attemptId, status: 'passed' | 'failed' | 'error' | 'not_run' | 'inconclusive', durationMs, assertionCount, failure?, cleanupFailures?: Failure[] }`. Milestone 1 never produces `inconclusive`.
- `run.finished`: `{ status: 'passed' | 'failed' | 'error' | 'interrupted', exitCode: 0 | 1 | 2 | 130 | 143, complete: boolean, counts: { passed, failed, error, notRun, inconclusive }, durationMs, failure? }`. `failure` is the run's own failure, one no single test explains: output that could not be kept (`reporting_failed`, every such failure kept, the first leading), or, when no test ran and the run was not interrupted, the first reason in run order (a file that could not be collected, a browser that did not start, and so on; `usage` when no file was selected). Tests it kept from running carry it too. An interrupted run says so in its status instead. A file's own failure (see `result.json`) is also a run failure, since no test explains it.

### Result (`src/protocol/result.ts`)

`result.json` is written once, at the end of the run, to a temporary file that is then renamed into place:

```ts
{ schemaVersion: 1, runId, retestVersion, startedAt, finishedAt, complete, status, exitCode, durationMs,
  browser: { product, version, executablePath } | null,
  counts, failure?, files: { file, collection: 'ok' | 'failed', failure?, tests: TestResult[] }[] }
TestResult = { testId, name, file, location, attemptId, status, durationMs, assertionCount, failure?, cleanupFailures?, evidence: { kind: 'screenshot', path }[] }
```

A file whose collection is `ok` has a `failure` only when its process failed outside its tests: an error after its last test, or an ending no test explains. Its tests keep their own results. Such a file makes the run `complete: false`.

`failure` is the run failure of `run.finished`, plus any that came after it: a reporter that failed at the end of the run is recorded here. When `result.json` itself cannot be written, the returned result carries that failure, and the CLI prints any run failure its reporter never received to stderr. `inspect` rebuilds a result without `result.json` with a failure that says whether the run stopped early or finished without writing it. A file keeps the failure its `file.failed` event recorded.

### Run folder (`src/protocol/run-folder.ts`)

```
<run>/events.jsonl            one event per line, each line flushed as written
<run>/result.json             written only at the end, so its absence means the run did not finish
<run>/logs/<file-slug>.log    the child's stdout and stderr for that test file
<run>/logs/browser.log        the browser's stderr
<run>/artifacts/<test-slug>-<attemptId>-failure.png   test slug at most 40 characters
```

- `testId(file, name)` is `"<file> > <name>"`, where `file` is POSIX and relative to `rootDir`.
- `slug(text, maxLength = 60)` keeps only `[a-z0-9-]`, is at most `maxLength` characters (13 at least, for the hash), and ends with a short hash, so two different inputs never share a slug.
- An attempt id is 10 random lowercase base-36 characters from `node:crypto`, safe in a file name as it is. A screenshot name uses it unchanged; any other attempt id would be reduced to a slug.
- If `--output` is not given, the run goes to `.retest/runs/<ISO time with - instead of :>`. An existing non-empty folder is a usage error.

### Timeouts (`src/protocol/timeouts.ts`)

`{ collection: 10000, setup: 60000, action: 10000, navigation: 30000, assertion: 5000, test: 60000, cleanup: 10000 }`, all in milliseconds. `parseTimeouts('action=500,test=3000')` returns an override, or a usage failure that names the unknown key or the bad value.

A command's deadline is the smaller of its own budget and the time the test has left. All deadline arithmetic lives in `src/protocol/deadline.ts`, which has no Node imports: a `Deadline` is made from a budget, a start time and a monotonic clock; its remaining time is a whole number of milliseconds rounded down and never negative; it is expired when none remains; `smallestBudget()` takes the minimum of several budgets. A `Deadline` may carry an `AbortSignal`; work that listens to it (CDP commands, pauses between looks, waits for `load`) stops when it aborts.

Every wait answers to one of the seven budgets, except two fixed graces of 1000 ms each:

- `abortGraceMs` (`src/runner/running-test.ts`): how long a test file's process has to stop once asked, and how long a page has to answer once its browser is lost. The runner also allows it on top of a browser call's own budget before it stops waiting for that call.
- `closeGraceMs` (`src/browser/contract.ts`): how long `close` waits for the browser's process group once it has killed it. It is the one floor no budget sets, because a killed process still takes a moment to be reaped, and it holds with a cleanup budget of 1 ms. A launch that failed because the program closed its pipe also waits at most this long for the program's own exit, to report it.

The runner gives `newPage` the setup budget, and `close` the cleanup budget. It waits for `close` at most the cleanup budget plus both graces. The CDP connection's default command timeout is the launch budget, and every command Retest sends names its own.

### Browser contract (`src/browser/contract.ts`)

```ts
type LaunchOptions = { executablePath: string; logFile: string; headless: boolean }
interface OwnedBrowser {
  readonly product: string; readonly version: string; readonly userAgent: string
  readonly pid: number              // also the browser's process group
  readonly executablePath: string   // the absolute path that was launched
  readonly connected: boolean
  newPage(options: { baseUrl?: string }, timeoutMs: number): Promise<OwnedPage>   // within timeoutMs, the runner's setup budget
  onDisconnect(listener: (reason: string) => void): () => void
  close(timeoutMs: number): Promise<void>   // closes within timeoutMs, then kills what is left of the process group and waits up to closeGraceMs; removes the temp profile; resolves only when all of that is done
}
const closeGraceMs = 1000
interface OwnedPage {
  execute(command: PageCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>   // never throws for page or app problems; returns a Failure instead
  screenshot(timeoutMs: number): Promise<Uint8Array>
  onNavigation(listener: (url: string) => void): () => void                    // url is origin plus path
  dispose(timeoutMs: number): Promise<void>                                     // disposes the browser context
}
launchBrowser(options: LaunchOptions): Promise<OwnedBrowser>   // a failure throws LaunchError, whose failure.class is setup_failed and whose message names the problem
```

- The temporary profile is named `retest-profile-<pid>-<random>` after the process that owns it. Before each launch, Retest removes the profiles in the temp folder whose owner no longer exists (`kill(pid, 0)` answers ESRCH), and never one whose owner is alive or may be. Profiles it cannot remove are noted in the browser log.
- The last-resort exit hook kills the browser's process group and removes its profile when the Retest process exits without closing the browser, as on a second Ctrl+C.
- Aborting `execute`'s `signal` stops the command: a command still queued for the pipe (a press, a text insertion) is withdrawn and never written, input not yet sent is skipped, and input already sent is never recalled. The result is a failure whose class and first sentence come from `signal.reason`, a `Failure` (anything else reads as a timeout), with `details.inputSent` saying whether input went. The runner aborts with the revocation's reason, so a test that ran out of time gives `timeout` saying so. `CdpAbortedError` carries `written`, as the other CDP errors do.
- `CdpSession.block(reason)` fails every command waiting on the session at once with a `CdpBlockedError` naming the reason, and every command sent before `unblock()`; `onBlock` tells work that waits on events, such as a navigation waiting for `load`. The page blocks its session when the target crashes (for good) and while a JavaScript dialog is open, since Chrome answers neither a crashed page nor one a dialog holds.

### Runner contract (`src/runner/contract.ts`)

```ts
type RunOptions = { files: string[]; rootDir: string; browserPath: string; baseUrl?: string; timeouts: Timeouts; outputDir: string; headless: boolean; signal: AbortSignal }
runFiles(options: RunOptions, reporters: Reporter[]): Promise<RunResult>
type CollectOptions = { files: string[]; rootDir: string; timeouts: Pick<Timeouts, 'collection'> }
collectFiles(options: CollectOptions): Promise<CollectResult>   // tests plus failures for every file; never launches a browser
```

`signal` is aborted with the `StopSignal` that stopped the run, `'SIGINT'` or `'SIGTERM'`, as its reason. `collectFiles` closes each file's process and reads what it reported: a file that failed after its tests were collected keeps its tests, with a failure, and `list` exits 2.

### Reporter (`src/reporters/reporter.ts`)

```ts
interface Reporter { readonly name: string; onEvent(event: RetestEvent): void | Promise<void>; onRunEnd(result: RunResult): void | Promise<void> }
```

The runner records the reporters' names in `run.started.options.reporter`, joined with commas, or `none`. If a reporter throws, the run finishes, is not called again, and the run fails with `reporting_failed` naming it and exit code 2.

The human and agent reports print the run failure once, and leave it off the tests it kept from running. A failure card prints each fact once: a failure's details are printed only when the failing call's own fields do not already show the same value. The agent report uses lowercase status words: `fail`, `error`, `not run`.

### Exit codes

`src/runner/outcome.ts` computes the exit code, in this order:
1. 130 if the run was interrupted by SIGINT, 143 if by SIGTERM.
2. 2 if nothing trustworthy came out: a usage error, a browser that failed to launch, no tests selected, every file failing collection, or results that could not be written.
3. 1 if any test ran and failed its checks. Every class except the ones below counts, including `timeout`.
4. 2 if any test ended as `error` or `not_run`, any cleanup failed, or a file failed outside its tests.
5. 0 otherwise.

Failure classes that make a test `error` rather than `failed`: `session_lost`, `outcome_unknown`, `setup_failed`, `cleanup_failed` (when it is the only failure), `unsupported`, `interrupted` and `reporting_failed`.

## Behaviour details the phases must agree on

- **`goto`.**
  - The URL is resolved with `new URL(url, baseUrl)`. A relative URL with no `baseUrl` is a `usage` failure.
  - The parent subscribes to lifecycle events before calling `Page.navigate`.
  - The page is complete when the `load` lifecycle event arrives for the returned `loaderId`. A document that replaced it before `load`, as a client-side redirect does, is followed to its own `load`. A same-document navigation is complete when `Page.navigatedWithinDocument` arrives for the main frame.
  - A navigation `errorText` becomes a `not_actionable` failure carrying the error text. Running out of time becomes `timeout`.
- **Resolving a locator.** Every action and observation resolves it again: `[data-testid]` elements whose attribute equals the value exactly, found through `Runtime.callFunctionOn` with the value passed as an argument and never pasted into source. Only the top-level document is searched.
- **Actions.**
  - An action with zero matches waits and resolves again until its deadline, then fails `not_found`.
  - More than one match fails `ambiguous` at once.
  - Before any input, the element must be:
    - connected
    - visible: a non-empty box, and not `visibility: hidden` or `display: none` on it or an ancestor
    - stable, with the same box in two animation frames
    - scrolled into view
    - enabled, for `click`
    - enabled, not read-only and a supported field, for `fill`
    - the element that receives a hit test at its centre point, or a descendant of it
  - A check that fails waits and tries again until the deadline, then fails `not_actionable` and names the check.
  - Once input has been dispatched it is never dispatched again.
  - If the connection drops after input has been dispatched and before it is confirmed, the result is `outcome_unknown`.
  - Input guards. Every document the page opens installs a guard in the `retest` isolated world before its own scripts run, and each action arms it for its element. A press, release or click event that lands on another element is stopped before any listener of the page hears it, and the click fails `not_actionable` with `check: 'hit-target'` naming the element that took it. A `fill` whose keyboard focus moved is stopped the same way and fails `not_actionable` with `check: 'focused'`. The result is `outcome_unknown` when the input never reached the element's document (as under a covering same-origin frame) or when the page moved to a new document before the guard reported. Hover events are not guarded and reach the page.
- **`fill`.**
  - Supported fields are `textarea`, and `input` of type `text`, `search`, `email`, `url`, `tel`, `password` or `number`, or with no type. Any other element or type fails `unsupported`, and the field is left unchanged.
  - A value containing `\n` or `\r` for an `input` fails `unsupported`.
  - The steps are: focus the field, select its whole value, then `Input.insertText` with the new value, or `Delete` when the new value is empty.
  - Retest never assigns `value` from script.
- **`click`.** Mouse moved, pressed and released at the centre point, through `Input.dispatchMouseEvent`. Retest never calls `element.click()`.
- **Assertions.** They run in the child and poll `observe` until they pass or reach their deadline. They never repeat an action.
  - `toBeVisible` passes when `count === 1 && visible`.
  - `toHaveText(expected)` compares the whole text. Both sides are trimmed, and each run of whitespace becomes one space.
  - On the deadline the class is `not_found` if the last observation had `count === 0`, `ambiguous` if `count > 1`, and otherwise `check_failed`.
- **One command at a time.** This lives in the child, per page.
  - An action cannot start while anything is in flight on that page.
  - An observation cannot start while an action is in flight. Observations may overlap each other.
  - A clash fails at once with `concurrent_commands`, naming both source lines.
  - An assertion starts only when awaited.
  - When the callback returns, anything created and not settled fails the test with `not_awaited`, and so does any assertion or action that was created but never awaited.
  - A rejected promise the test never awaited still fails the test, with its original failure.
  - A test with zero assertions fails `no_assertions`.
- **Source locations.** A source location is the first stack frame outside Retest's own files. Its path is relative to `rootDir`.
- **Duplicate test names.** Two tests with the same name in one file make the file fail collection with `collection_failed`. Nothing in it runs.
- **Options.** In milestone 1, `test` options accept only `timeout`, a positive integer in milliseconds. Any other key fails collection with `usage`.
- **Output.**
  - The child's stdout and stderr always go to its log file.
  - With the human reporter they are also echoed to the terminal, dimmed and prefixed with the file name.
  - With the JSONL reporter, stdout holds only event lines.
  - Browser stderr goes to `logs/browser.log`.

## Tooling

- `package.json`:
  - `type: module`, `engines.node >=24.12`, `private: true`.
  - `bin.retest: ./dist/cli/main.js`.
  - `exports["."]`: `{ types: ./dist/index.d.ts, "retest-source": ./src/index.ts, default: ./dist/index.js }`, plus `./package.json`.
  - `files`: `["dist"]`.
- Development dependencies, pinned exactly with one `package-lock.json`: `typescript` 6.0.3, `typescript-7` (`npm:typescript@7.0.2`) and `@types/node` 24.19.0. Nothing else, and no runtime dependencies.
- `tsconfig.json` is used for type checking and has no emit. It sets:
  - `strict`, `noEmit`, `module: nodenext`, `target` and `lib` `es2024`, `types: ["node"]`
  - `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`
  - `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedDeclarations`
  - `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`
  - `noUnusedLocals`, `noUnusedParameters`, `skipLibCheck: false`

  It covers `src`, `tests`, `fixtures`, `examples` and `scripts`.
- `tsconfig.build.json` builds `src` into `dist`, with declarations, declaration maps and `rewriteRelativeImportExtensions`.
- Source imports use `.ts` extensions, so Node runs the source directly with the `retest-source` condition.
- Scripts:
  - `build`: empties `dist/`, then `tsc -p tsconfig.build.json && node scripts/write-schemas.ts`
  - `typecheck`: `tsc -p tsconfig.json`, plus the same with the TypeScript 7 binary at `node_modules/typescript-7/bin/tsc`
  - `test:unit`: `node --conditions=retest-source --test "tests/unit/**/*.test.ts"`
  - `test:types`: `node tests/types/run.ts`
  - `test:integration`: `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/**/*.test.ts"`
  - `test`: all of the above, in that order
- Integration tests read the browser path from `RETEST_TEST_BROWSER`. If it is unset they use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` when that exists. Otherwise they fail with that message; they never skip silently.

## Rules for every agent

- Work only in this repository, and only in the files your phase owns.
- Never commit, stage, reset or delete another agent's work. Never touch `x-series/`.
- Never start, stop or touch the user's own app servers or Chrome profile. Starting your own fixture servers and browsers with temporary profiles, and stopping them, is part of the work. Kill only process ids you started yourself, never by name or port.
- The only network access allowed is `npm install` of the three pinned development dependencies, in the Foundation phase.
- Run the checks your phase can run. Report exactly what ran, with exit codes, and list what you could not verify, most important first.
