# Test runner developer experience: research for Retest

Research date: 30 September 2026. Scope: how Vitest, Playwright Test, Jest, Bun and `node:test` handle the parts of a test runner that decide developer experience, and what Retest should copy, adapt or avoid.

Method. I read the current documentation from each project's source repository (the markdown the websites are built from), release notes, selected source files and GitHub issues. Versions come from the npm registry and GitHub releases on 30 September 2026. Reaction counts are the GitHub search API's `reactions.total_count` on the same day; they move. Snippets are copied from the linked page unless marked **Retest proposal**, which means it is my design suggestion and nothing ships it yet. Anything I could not confirm is marked *unverified* and listed at the end.

## Versions checked

| Tool | Latest | Released | Source |
| --- | --- | --- | --- |
| Vitest | 5.0.2 (5.0.0 on 2026-09-03) | 2026-09-25 | [npm](https://registry.npmjs.org/vitest), [blog](https://vitest.dev/blog/vitest-5) |
| Playwright Test | 1.63.0 (`next` is 1.64.0-alpha-2026-09-29) | 2026-09-04 | [npm](https://registry.npmjs.org/@playwright/test), [release notes](https://playwright.dev/docs/release-notes) |
| Jest | 30.5.2 | 2026-09-18 | [npm](https://registry.npmjs.org/jest) |
| Bun | 1.4.2 (1.4.0 on 2026-08-20) | 2026-09-05 | [GitHub releases](https://github.com/oven-sh/bun/releases) |
| Node.js | 26.10.0 current, 24.21.0 LTS | 2026-09-21, 2026-09-07 | [dist index](https://nodejs.org/dist/index.json) |
| `@playwright/cli` | 0.1.22 | 2026-09-28 | [npm](https://registry.npmjs.org/@playwright/cli) |
| `@playwright/mcp` | 0.0.83 | 2026-09-28 | [npm](https://registry.npmjs.org/@playwright/mcp) |
| `eslint-plugin-playwright` | 2.12.0 | 2026-09-14 | [npm](https://registry.npmjs.org/eslint-plugin-playwright) |
| `@vitest/eslint-plugin` | 1.6.27 | 2026-08-10 | [npm](https://registry.npmjs.org/@vitest/eslint-plugin) |

Release dates for features cited below: Playwright 1.56 on 2025-10-06, 1.57 on 2025-11-25, 1.58 on 2026-01-23, 1.59 on 2026-04-01, 1.60 on 2026-05-11, 1.61 on 2026-06-15, 1.62 on 2026-07-24, 1.63 on 2026-09-04; Vitest 4.0 on 2025-10-22, 4.1 on 2026-03-12, 5.0 on 2026-09-03 ([Playwright releases](https://github.com/microsoft/playwright/releases), [Vitest releases](https://github.com/vitest-dev/vitest/releases)).

## Ranked lessons for Retest

The reasoning and evidence for each item are in the numbered sections that follow.

1. **A false pass is the worst outcome, so make un-awaited work a runtime failure.** Vitest does this for its async assertions and browser locators. Playwright does not and says it will not. Retest can go further because it owns the command channel (section 1).
2. **Detect coding agents and print only failures, from the same event model.** Vitest 4.1, Jest 30.5 and Bun all ship this now. Never prompt, open a browser tab, serve a report or enter watch mode on your own (section 2).
3. **One failure card per failure.** Expected and received with a diff, the call log of what the runner waited for, a code frame at the test's own call site, the page's ARIA tree when a locator misses, artifact paths, and the exact next command (section 3).
4. **The subject decides whether an assertion retries.** `expect(locator)` retries and `expect(value)` does not. Playwright gets this right; Vitest's separate `expect.element` is a trap. Never retry a block that contains actions (section 4).
5. **Fixtures with a builder that infers types** (Vitest 4.1), reverse cleanup, separate setup timing, and a loud error when a test reads a fixture it did not request (section 5).
6. **Stable test IDs and a selection CLI that agents can drive**: `list --json`, `file:line`, `--grep`, boolean tag filters over declared tags, `--last-failed`, `--test-list`, `-x` (section 8).
7. **A stateless `inspect`** modelled on Playwright 1.59's trace CLI, with big payloads written to files and referenced from output (section 9).
8. **Distinct exit codes.** Playwright's request for them has 56 reactions and has been open since 2022 (sections 8 and 17).
9. **Flat config with declared named apps and resource locks.** Avoid Playwright's `use` versus top-level split and the "per-test options need an anonymous describe" workaround (section 10).
10. **Type stripping with translated errors.** Node's type stripping is fast and keeps positions exact, but enums, parameter properties, decorators and value-imported types fail. Playwright's own page-object examples use two of those (section 11).
11. **Steps, annotations and attachments are events**, with Playwright's `box` and step params and Vitest's helper boxing (section 6).
12. **Non-interactive, idempotent `init`** that also writes the agent-facing facts (section 12).
13. **Do not ship APIs that a lint rule later has to forbid.** `eslint-plugin-playwright` has about 65 rules, and a dozen of them fence off Playwright's own API (section 16).
14. **Automatic repair never skips or weakens a test.** Playwright's healer agent may mark a test skipped (section 12).
15. **Show where time went and make flakiness measurable**: phase durations, `--repeat-each`, a flaky status and `--fail-on-flaky` (section 15).

## 1. Un-awaited async work and other false passes

### What each tool does

**Vitest fails the test and points at the line.** Since Vitest 3, an un-awaited `expect.poll(...)` or `expect.element(...)` fails the test, and the pending assertion never runs ([PR #6877](https://github.com/vitest-dev/vitest/pull/6877)): "The callback to `.poll` will never be called to avoid unhandled rejections." The same PR fails a test when an async browser `locator.*` call is not awaited, and "the RPC will never be called". Vitest 5 extends this to `resolves`, `rejects` and `toMatchFileSnapshot`, which used to print only a warning while the test passed ([Vitest 5 blog](https://vitest.dev/blog/vitest-5), [PR #10868](https://github.com/vitest-dev/vitest/pull/10868)). The message, from [issue #9724](https://github.com/vitest-dev/vitest/issues/9724):

```
 FAIL  test/repro.test.ts > repro
Error: expect.poll(assertion).toBe() was not awaited. This assertion is asynchronous and must be awaited; otherwise, it is not executed to avoid unhandled rejections:

await expect.poll(assertion).toBe()

 ❯ test/repro.test.ts:6:6
```

That issue is also the cautionary tale. `await expect.poll(() => 0).toBe(0).finally(...)` was reported as not awaited, because the detector watched one path and the chained `.finally` took another. Vitest also has an opt-in `detectAsyncLeaks` that uses `async_hooks` to report timers and handles that outlive a file, with a code frame, at a cost in speed ([config](https://vitest.dev/config/detectasyncleaks)).

**Playwright relies on lint and does not detect it at runtime.** Its best-practices page says to use `@typescript-eslint/no-floating-promises` "to make sure there are no missing awaits" ([best practices](https://playwright.dev/docs/best-practices#lint-your-tests)). A request to warn at runtime was closed as not planned in September 2025. A maintainer wrote: "This is not as trivial to detect at runtime as you might think... We have explored it and decided it wasn't worth it" ([issue #37595](https://github.com/microsoft/playwright/issues/37595)). When the test ends, the `page` fixture closes its context with the reason `'Test ended.'` ([source](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright/src/index.ts)), so a still-pending call fails with an error such as `page.waitForTimeout: Test ended.`. A commenter on #37595 called that message unhelpful because it does not say an `await` is missing. The community lint rule covers matchers, `expect.poll`, `test.step` and `waitFor*`, but page and locator actions such as `page.click()` only behind an option ([rule docs](https://github.com/playwright-community/eslint-plugin-playwright/blob/main/docs/rules/missing-playwright-await.md)):

```json
{
  "playwright/missing-playwright-await": ["error", { "includePageLocatorMethods": true }]
}
```

**Jest reports late work but the test still passes.** From Jest's own e2e snapshot ([source](https://github.com/jestjs/jest/blob/main/e2e/__tests__/__snapshots__/consoleAfterTeardown.test.ts.snap)):

```
PASS __tests__/console.test.js

  ●  Cannot log after tests are done. Did you forget to wait for something async in your test?
    Attempted to log "hello!".
```

and at the end of a run: "Jest did not exit one second after the test run has completed... Consider running Jest with `--detectOpenHandles`" ([source](https://github.com/jestjs/jest/blob/main/e2e/__tests__/__snapshots__/detectOpenHandles.ts.snap)).

**Bun fails the run on stray errors.** "bun test tracks unhandled promise rejections and errors that occur between tests. If any occur, bun test exits with a non-zero code even when no test failed" ([runtime behavior](https://bun.com/docs/test/runtime-behavior)).

**`node:test` cancels outstanding subtests and marks late errors as failures.** "Any subtests that are still outstanding when their parent finishes are cancelled and treated as failures", and `uncaughtException` or `unhandledRejection` events from a completed test "are marked as failed... and reported as diagnostic warnings" ([Node test docs](https://nodejs.org/api/test.html#extraneous-asynchronous-activity)). One design mistake is worth noting: `test()` itself returns a promise, so `no-floating-promises` flags every top-level `test(...)` call ([nodejs/node #51292](https://github.com/nodejs/node/issues/51292)).

### Tests that assert nothing

- Vitest has `expect.hasAssertions()`, `expect.assertions(n)` and a global `expect.requireAssertions`, which is off by default and only counts Vitest's `expect` ([config](https://vitest.dev/config/expect)).
- `node:test` has `t.plan(count, { wait })` ([docs](https://nodejs.org/api/test.html#contextplancount-options)).
- Playwright has no runtime check. The lint rule `expect-expect` covers it.
- "No tests found" fails by default in both Vitest (`--passWithNoTests` opts out) and Playwright (`--pass-with-no-tests`) ([Vitest CLI](https://vitest.dev/guide/cli), [Playwright CLI](https://playwright.dev/docs/test-cli)).
- Vitest fails a run on unhandled errors and names the escape hatch `dangerouslyIgnoreUnhandledErrors` ([config](https://vitest.dev/config/dangerouslyignoreunhandlederrors)). The `dangerously` prefix is a good naming convention for unsafe opt-outs.

### For Retest

**Copy** Vitest's "was not awaited" error with a code frame at the call site, and treat `.then`, `.catch`, `.finally`, `await` and `Promise.all` as all counting as awaited (the #9724 bug).

**Go further than Vitest.** Retest owns the command channel to every target, so it can detect the dangerous case the moment it happens instead of at test end. **Retest proposal:**

- Commands to one target (a page, a device) are serialized. If a test issues a second action while an earlier action on the same target is still pending, fail at once and name both call sites. Two awaited actions never overlap, so this has no false positives. Different targets may run concurrently, which a phone-plus-web test needs.
- Do not rely on detecting when `then` is called. `await` on a non-native thenable calls `then` one microtask later, so a synchronous check would misfire. The "pending on the same target" rule avoids this.
- Observers such as a future `waitForResponse` start eagerly and are exempt from the overlap rule, because the `const p = waitFor...; await click; await p` pattern is legitimate ([Playwright rule docs](https://github.com/playwright-community/eslint-plugin-playwright/blob/main/docs/rules/missing-playwright-await.md) show it as correct code).
- Assertions can stay lazy, as Vitest's are. An un-awaited assertion never observes, and the test fails at the end naming it.
- When the callback returns, any operation still pending or never observed is a test error, as the implementation brief already requires.
- `test()` and `test.step()` registration at module level returns `void`, so projects can turn on `no-floating-promises` without noise.

```
FAIL tests/task.retest.ts > saves a task
OverlappingCommandError: locator.fill() started while locator.click() on the same page was still running.
The click was not awaited, so the two commands would race.

  6 |   page.getByTestId('save-task').click()
    |                                 ^ not awaited
  7 |   await page.getByTestId('task-title').fill('Next')
    |                                        ^ started here
```

(Retest proposal; this output format does not exist anywhere yet.)

**Adopt** zero assertions as a failure by default, which is already in the brief and stricter than every tool above. If an opt-out ever exists, give it a `dangerously` name.

## 2. Output for agents and humans

### Agent detection is now standard

- **Vitest 4.1** added an `agent` reporter. In Vitest 5 it is the `minimal` reporter with the alias `agent`: "Outputs a minimal report containing only failed tests and their error messages. Console logs from passing tests and the summary section are also suppressed." It is used by default "when Vitest detects an AI coding agent" ([reporters](https://vitest.dev/guide/reporters#minimal-reporter)). Detection comes from `std-env`, and the blog shows `AI_AGENT=copilot vitest` ([4.1 blog](https://vitest.dev/blog/vitest-4-1)). `std-env`'s list covers `CLAUDECODE`, `CLAUDE_CODE`, `REPL_ID`, `GEMINI_CLI`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `OPENCODE`, `AUGMENT_AGENT`, `GOOSE_PROVIDER`, `JUNIE_DATA`, `COPILOT_AGENT`, `COPILOT_CLI`, `CURSOR_AGENT`, a Devin `EDITOR` match and Kiro's `TERM_PROGRAM` only without a TTY ([source](https://github.com/unjs/std-env/blob/main/src/agents.ts)). The PR's rationale was that test output is "token inefficient" ([PR #9779](https://github.com/vitest-dev/vitest/pull/9779), 19 reactions).
- **The Vitest gap.** "If you configure custom reporters, the automatic detection is skipped" ([4.1 blog](https://vitest.dev/blog/vitest-4-1)). A user asked for `reporters: ['junit', 'auto']` because a JUnit reporter switched agent mode off ([issue #10217](https://github.com/vitest-dev/vitest/issues/10217)).
- **Jest 30.5.2** ships an `AgentReporter` in `@jest/reporters` that prints only failing files and the summary, activated from a hard-coded list of variables including `AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT` and `GEMINI_CLI` ([source](https://github.com/jestjs/jest/blob/main/packages/jest-core/src/TestScheduler.ts); the published type declaration is on [unpkg](https://unpkg.com/@jest/reporters@30.5.2/build/index.d.ts)). I did not find a changelog entry for it.
- **Bun**: set `CLAUDECODE=1`, `REPL_ID=1` or `AGENT=1` and "Only test failures are displayed in detail. Passing, skipped, and todo test indicators are hidden. Summary statistics remain intact" ([Bun test docs](https://bun.com/docs/test)).
- **Playwright 1.63** does not have an agent reporter. It does stop the HTML reporter from opening a browser tab when it sees an agent or no TTY: `const shouldOpen = !isCodingAgent() && !!process.stdin.isTTY && (...)`, where `isCodingAgent()` checks only `CLAUDECODE` and `COPILOT_CLI` ([html.ts at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright/src/reporters/html.ts), [env.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/utils/env.ts)). The scaffolded config uses `reporter: 'html'` locally ([create-playwright template](https://github.com/microsoft/create-playwright/blob/main/assets/playwright.config.ts)), and the report is "opened automatically if some of the tests failed" ([reporters](https://playwright.dev/docs/test-reporters#html-reporter)). When a report is served, the process prints `Serving HTML report at ... Press Ctrl+C to quit.` and waits forever.
- A proposal for a standard `AGENT` variable, like `CI`, is open ([agentsmd/agents.md #136](https://github.com/agentsmd/agents.md/issues/136)).

A measured example from outside the projects: at Buffer, a 215-suite Jest run printed about 3,500 tokens, "almost all 'PASS' lines", and switching reporters cut about 250 lines to about 10 ([magarcia.io](https://magarcia.io/your-test-output-is-burning-tokens/), third-party).

### Machine output

- Vitest warns that JSON printed to stdout can be interleaved with other writes and become unparsable, and recommends file output ([reporters](https://vitest.dev/guide/reporters)). Playwright's JSON reporter prints to stdout unless `PLAYWRIGHT_JSON_OUTPUT_NAME` or `outputFile` is set ([reporters](https://playwright.dev/docs/test-reporters#json-reporter)).
- `node:test` pairs reporters with destinations by position, which is easy to get wrong ([docs](https://nodejs.org/api/test.html#test-reporters)):

```bash
node --test-reporter=spec --test-reporter=dot --test-reporter-destination=stdout --test-reporter-destination=file.txt
```

- `node:test`'s event stream is typed and small: `test:enqueue`, `test:dequeue`, `test:start`, `test:pass`, `test:fail`, `test:plan`, `test:diagnostic`, `test:stdout`, `test:stderr`, `test:coverage`, `test:complete`, `test:interrupted`, `test:summary` and watch events ([docs](https://nodejs.org/api/test.html)). This is the closest existing design to Retest's JSONL events.
- Playwright 1.63 added `--add-reporter`, which appends to the configured reporters instead of replacing them ([release notes](https://playwright.dev/docs/release-notes#version-163)).

### For Retest

**Copy** agent detection, the failures-only output and the kept summary. Detect from a built-in list (no `std-env` dependency, per the zero-dependency rule) that includes at least `AGENT`, `AI_AGENT` and the `std-env` variables, plus explicit `--agent` and `--no-agent` flags.

**Avoid** Vitest's rule that a configured reporter turns agent mode off, and Playwright's pattern of adding "don't do this for agents" checks one feature at a time. In Retest, no command prompts, opens a browser tab, serves a report or starts watching in any mode.

**Adapt** reporters as "format plus destination" in one token. **Retest proposal:**

```sh
retest run tests/ --reporter human --reporter jsonl=.retest/runs/latest/events.jsonl
retest run tests/ --reporter jsonl            # stdout carries only event lines
```

The agent-mode summary should end with the exact next command. **Retest proposal:**

```
1 failed, 11 passed, 0 skipped, 0 not run (12 tests in 3 files) in 14.2s
run: .retest/runs/2026-09-30T10-12-03Z
next: retest inspect .retest/runs/2026-09-30T10-12-03Z --test "tests/task.retest.ts > saves a task"
```

## 3. Failure output

### Best examples

Vitest, value assertion ([debugging guide](https://vitest.dev/guide/learn/debugging-tests), colours removed):

```
 FAIL src/user.test.js > createUser > sets the default role
AssertionError: expected { name: 'Alice', role: 'viewer' } to deeply equal { name: 'Alice', role: 'member' }

- Expected
+ Received

  {
    "name": "Alice",
-   "role": "member",
+   "role": "viewer",
  }

 ❯ src/user.test.js:8:22
      6|   test('sets the default role', () => {
      7|     const user = createUser('Alice')
      8|     expect(user).toEqual({ name: 'Alice', role: 'member' })
                          ^
```

Playwright, retrying assertion. The call log shows what the runner waited for ([timeouts](https://playwright.dev/docs/test-timeouts#expect-timeout)):

```txt
Error: expect(received).toHaveText(expected)

Expected string: "my text"
Received string: ""
Call log:
  - expect.toHaveText with timeout 5000ms
  - waiting for "locator('button')"
```

Vitest 5, locator that matched nothing. The ARIA tree is shorter than the HTML and shows the roles and names that role locators match ([config](https://vitest.dev/config/browser/locators#browser-locators-errorformat)):

```html
VitestBrowserElementError: Cannot find element with locator: getByRole('button', { name: 'Save' })

ARIA tree:
- main:
  - heading "Settings" [level=1]
  - button "Cancel"

HTML:
<body>
  <main>
    <h1>
      Settings
    </h1>
    <button>
      Cancel
    </button>
  </main>
</body>
```

Other good details:

- A custom message as the second argument to `expect`, shown on pass and fail: `await expect(page.getByText('Name'), 'should be logged in').toBeVisible();` ([assertions](https://playwright.dev/docs/test-assertions#custom-expect-message)).
- Boxing so the frame points at the helper's call site instead of its insides: `test.step('login', fn, { box: true })` in Playwright ([test.step](https://playwright.dev/docs/api/class-test#test-step)), and `vi.defineHelper(fn)` in Vitest ([4.1 blog](https://vitest.dev/blog/vitest-4-1)).
- Annotations printed under a failure with their source line, in Vitest ([annotations](https://vitest.dev/guide/test-annotations)).
- Jest now renders nested `cause` and `AggregateError` with code frames in retry logs ([changelog, 30.5](https://github.com/jestjs/jest/blob/main/CHANGELOG.md)).
- Playwright's "Copy prompt" button on errors in the HTML report, trace viewer and UI mode copies "a pre-filled LLM prompt that contains the error message and useful context for fixing the error" ([release notes](https://playwright.dev/docs/release-notes)).

### For Retest

**Copy** the diff header (`- Expected` / `+ Received`), code frames with a caret, custom messages, boxing and the call log. **Copy** Vitest 5's ARIA tree on a locator miss, but also report the match count, because Retest rejects ambiguous matches: zero matches and three matches need different fixes.

**Adapt** into one failure card with fixed fields, rendered the same way in the terminal, JSONL and `inspect`. **Retest proposal:** test ID; failure class (assertion failed, not found, ambiguous, not actionable, timeout, session lost, unknown action outcome, the classes in the brief); expected and received with the exact comparison rule ("exact string, whitespace preserved"); call log with the attempts made and the timeout; code frame at the test call site; ARIA subtree or match list; screenshot path relative to the run; the command to rerun only this test. Playwright's "Copy prompt" is redundant for Retest if the card is already the prompt.

**Avoid** vague timeouts. Playwright's `Timeout of 30000ms exceeded.` names the budget but not the operation ([timeouts](https://playwright.dev/docs/test-timeouts)). A Retest timeout should always name the budget that ran out and the operation that was waiting.

## 4. Assertions: retrying, polling, soft

### Playwright gets the split right

The subject decides the behaviour. Locator and page matchers retry and must be awaited; value matchers run once ([assertions](https://playwright.dev/docs/test-assertions)):

```js
expect(success).toBeTruthy();
await expect(page.getByTestId('status')).toHaveText('Submitted');
```

"Non-retrying assertions... can lead to a flaky test." Default assertion timeout is 5 s. `expect.poll` polls a function with default intervals `[100, 250, 500, 1000]`, and `expect.configure({ timeout, soft })` builds a preset `expect`.

`expect(async () => { ... }).toPass()` reruns a whole block, actions included, and "by default `toPass` has timeout 0 and does not respect custom expect timeout". Both halves of that sentence are traps: it re-executes side effects, and it has a different timeout rule from everything else.

### Vitest splits one idea into two APIs

In Browser Mode `expect.element(locator)` retries, while `expect(locator)` with the same matcher "will fail immediately" ([browser assertions](https://vitest.dev/api/browser/assertions)). `expect.poll` defaults are 50 ms interval and 1000 ms timeout ([config](https://vitest.dev/config/expect)). Its callback receives an `AbortSignal`, and since Vitest 5 it rejects on timeout ([Vitest 5 blog](https://vitest.dev/blog/vitest-5)):

```ts
await expect.poll(async ({ signal }) => {
  const response = await fetch('/api/status', { signal })
  return response.status
}, { timeout: 1000 }).toBe(200)
```

`expect.soft` in Vitest "can only be used inside the test function" ([expect](https://vitest.dev/api/expect#soft)). Playwright's `expect.soft` works with retrying matchers and with `poll`, and `test.info().errors` shows soft failures so far ([assertions](https://playwright.dev/docs/test-assertions#soft-assertions)). `expect.schemaMatching` accepts any Standard Schema v1 object (Zod, Valibot, ArkType) ([expect](https://vitest.dev/api/expect)).

### For Retest

**Copy** Playwright's rule that the subject type decides retrying, with one `expect`. **Avoid** Vitest's `expect.element`.

**Copy** `expect.poll(fn, { timeout, intervals, message })` with an `AbortSignal`, for observations that are not locators (an API status, an inbox). **Avoid** `toPass` entirely. It retries actions, which Retest's architecture forbids ("Assertions retry observations, not actions").

**Adapt** timeouts into one model: every retrying assertion has a budget, the failure prints it, and no helper silently uses a different default.

**Copy** `expect.soft` with Playwright's semantics. It fits `toMeet(criteria)` later, where a single AI verdict should not end a flow that has more checks to run. An AI-judged check will also need an `inconclusive` outcome, as the architecture document already notes.

## 5. Fixtures and test context

### Vitest 4.1 has the best typing

The builder infers each fixture's type from its return value ([test context](https://vitest.dev/guide/test-context), [4.1 blog](https://vitest.dev/blog/vitest-4-1)):

```ts
import { test as baseTest } from 'vitest'

export const test = baseTest
  .extend('config', { port: 3000, host: 'localhost' })
  .extend('server', async ({ config }) => {
    return `http://${config.host}:${config.port}`
  })
```

Scopes are `test`, `file` and `worker`: `.extend('database', { scope: 'file' }, async ({}, { onCleanup }) => ...)`. Worker fixtures can only depend on worker fixtures. There are also `auto`, `injected` (overridable per project through `provide`) and `test.override` inside a `describe`. `onCleanup` "can only be called **once per fixture**". The test context carries `signal`, which is aborted on timeout, Ctrl+C or bail. Vitest 4.1 added `aroundEach` and `aroundAll` for wrapping a test in a transaction or trace span.

### Playwright has the best semantics but verbose types

Fixtures are lazy ("Playwright Test will setup only the ones needed by your test"), composable and boxable, with a custom `title` ([fixtures](https://playwright.dev/docs/test-fixtures)). The worker-scope typing is the verbose part:

```js
// Note that we pass worker fixture types as a second template parameter.
export const test = base.extend<{}, { account: Account }>({
  account: [async ({ browser }, use, workerInfo) => {
    // ...
    await use({ username, password });
  }, { scope: 'worker' }],
```

Option fixtures (`{ option: true }`) make config values typed and overridable per project.

### Pitfalls both share

Both find out which fixtures a test needs by reading the destructuring pattern of its first parameter. Vitest warns: "you should always use the object destructuring pattern `{ database }`" ([test context](https://vitest.dev/guide/test-context)). `(context) => context.database` does not work.

Vitest issue [#9303](https://github.com/vitest-dev/vitest/issues/9303) (open): a worker fixture's startup time is charged to the first test that asks for it. For a fixture that boots a database or a device, the report blames the wrong test.

### For Retest

**Copy** the builder shape and inference, the three scopes, `onCleanup` and the `signal`. **Adapt** cleanup to allow `await using` as well. Node 24+ supports explicit resource management natively, and Vitest already documents `using` for spies ([recipe](https://vitest.dev/guide/recipes/explicit-resources)). The brief defers public fixtures, so this is the shape for later. **Retest proposal:**

```ts
export const test = base
  .extend('account', { scope: 'worker' }, async ({}, { onCleanup }) => {
    const account = await createAccount()
    onCleanup(() => account.remove())
    return account
  })
```

**Avoid** silent failure when fixtures are not destructured. Make the context a proxy that throws `fixture "page" was not requested; destructure it in the test signature` on access. Report fixture setup and teardown as their own timed events so #9303 cannot happen.

## 6. Steps, annotations and attachments

Playwright's `test.step` returns the callback's value, nests, can be boxed, and since 1.63 takes `subtitle` and `params` that reporters receive ([release notes](https://playwright.dev/docs/release-notes#version-163), [test.step](https://playwright.dev/docs/api/class-test#test-step)):

```js
await test.step('Login', async () => {
  // ...
}, { subtitle: 'as admin', params: { user: 'admin' } });
```

Built-in API steps now report their locator as the subtitle, for example `Click` with `getByRole('button')`. Playwright's most-wanted closed runner request was "Add annotations for test.step similar to test" (130 reactions, [#10033](https://github.com/microsoft/playwright/issues/10033)).

Vitest has no `test.step`. I found none in its docs. Browser Mode has `page.mark(name, fn?)`, which adds trace entries, and grouping is "not currently supported" ([trace view](https://vitest.dev/guide/browser/trace-view)). Vitest's `annotate(message, type | attachment)` goes to every reporter, including GitHub Actions notices and JUnit properties ([annotations](https://vitest.dev/guide/test-annotations)). Playwright 1.60 added `test.abort(message)` to fail a test from a fixture, hook or route handler ([release notes](https://playwright.dev/docs/release-notes#version-160)).

**For Retest. Copy** `test.step(name, fn, { box, params })` returning the value, and emit each step as a start and end event with its source location. **Adapt** `params` through the redaction path, because a step param is exactly where a password will end up. **Copy** a single `annotate` or `attach` that flows into events and every reporter.

## 7. Parameterized tests and datasets

Vitest's `test.for` passes the row without spreading arrays and gives each row the test context. `test.each` exists for Jest compatibility. Titles take `%s`, `%i`, `$name` and `%#` formatting ([test API](https://vitest.dev/api/test#test-for)):

```ts
test.for([
  [1, 1, 2],
  [1, 2, 3],
])('add(%i, %i) -> %i', ([a, b, expected]) => {
  expect(a + b).toBe(expected)
})
```

Playwright recommends a plain `forEach` around `test()` ([parameterize](https://playwright.dev/docs/test-parameterize)). `test.each` was requested with 83 reactions ([#7036](https://github.com/microsoft/playwright/issues/7036)). Vitest 5's `vitest list` collects tests by static parsing, and rows from `for`, `each` or a dynamic title get `dynamic: true` and an ID suffix, and "cannot be used to filter tests" ([advanced API](https://vitest.dev/api/advanced/vitest#parsespecification), [CLI](https://vitest.dev/guide/cli#vitest-list)).

**For Retest. Copy** `test.for(rows)(title, fn)`. **Adapt** row identity so each row has a stable ID from an explicit `key` or its index, and `retest list` shows every row because collection really runs (the brief already requires executed collection). `test.eval(dataset, ...)` should reuse the same row machinery, so one dataset row can be listed, selected with `--grep` and rerun alone. Prior art built on Vitest exists (`vitest-evals` 0.17.0, `evalite` 0.19.0 on npm). I did not study their APIs for this track.

## 8. Selecting and running tests from the command line

| Capability | Best current example |
| --- | --- |
| Run one test by position | `vitest basic/foo.test.ts:10`, `npx playwright test my-spec.ts:42` ([Vitest](https://vitest.dev/guide/filtering), [Playwright](https://playwright.dev/docs/test-cli)) |
| List without running | `vitest list --json`, `--filesOnly`; `npx playwright test --list` |
| Rerun last failures | `npx playwright test --last-failed`, state in `<outputDir>/.last-run.json`; `jest -f`; `node --test-rerun-failures <state file>` ([Node](https://nodejs.org/api/test.html#rerunning-failed-tests)). I found no Vitest CLI flag for this |
| Run an explicit list | Playwright `--test-list <file>` and `--test-list-invert`, one test per line in `--list` format |
| Changed files | `vitest --changed [ref]`, `npx playwright test --only-changed [ref]`, `jest -o`, `bun test --changed` |
| Tags | Vitest 4.1 declared tags with boolean filters; Playwright `@tag` matched by `--grep` regex |
| Stop early | `-x` or `--max-failures N` (Playwright), `--bail N` (Vitest, Bun) |
| Guard `.only` in CI | Vitest `allowOnly` defaults to `!process.env.CI`; Playwright `forbidOnly` |

Vitest's tag design is the best I found ([test tags](https://vitest.dev/guide/test-tags)). Tags are declared in config with a description and optional timeout, retry and priority. An undeclared tag fails the test before it starts unless `strictTags` is off. The filter is a real expression:

```shell
vitest --tags-filter="(unit || e2e) && !slow"
```

```ts
test('renders homepage', { tags: ['frontend'] }, () => {})
```

Playwright's test-list format, which also works as a stable text ID ([CLI](https://playwright.dev/docs/test-cli#test-list)):

```txt
[chromium] › path/to/example.spec.ts:3:9 › suite › nested suite › example test
```

Exit codes. Playwright uses 1 for almost everything. The request for 0 = passed, 1 = tests failed, 2 = something else went wrong has 56 reactions and is open since May 2022 ([#14109](https://github.com/microsoft/playwright/issues/14109)). Vitest and Jest also use 1 for both.

**For Retest. Copy** `file:line`, `--grep`, `list --json`, `--last-failed`, `--test-list`, `-x`, forbid-`.only` in CI, and Vitest's declared tags with boolean filters. **Keep** the brief's exit codes (0, 1, 2, 130). They are rarer than they should be, and agents branch on them. **Retest proposal:**

```sh
retest list tests/ --json
retest run "tests/task.retest.ts:12"
retest run tests/ --grep "saves" --tag "smoke and not slow"
retest run --last-failed
retest run --test-list .retest/runs/latest/failed.txt
```

`--changed` matters less for tests of a running application than for unit tests, because application tests rarely import the source they check. It can wait.

## 9. Inspecting a finished run

### Playwright's trace CLI for agents (1.59)

This is the closest existing thing to `retest inspect` ([release notes](https://playwright.dev/docs/release-notes#version-159)):

```bash
$ npx playwright trace open test-results/example-has-title-chromium/trace.zip
  Title:        example.spec.ts:3 › has title

$ npx playwright trace actions --grep="expect"
     # Time       Action                                                  Duration
  ──── ─────────  ─────────────────────────────────────────────────────── ────────
    9. 0:00.859  Expect "toHaveTitle"                                        5.1s  ✗

$ npx playwright trace action 9
  Expect "toHaveTitle"
  Error: expect(page).toHaveTitle(expected) failed
    Expected pattern: /Wrong Title/
    Received string:  "Fast and reliable end-to-end testing for modern web apps | Playwright"
    Timeout: 5000ms
  Snapshots
    available: before, after
    usage:     npx playwright trace snapshot 9 --name <before|after>
```

Its tests also exercise `requests`, `request <n>`, `console --errors-only`, `errors` and `snapshot <n>` ([trace-cli.spec.ts](https://github.com/microsoft/playwright/blob/main/tests/mcp/trace-cli.spec.ts)). It is stateful: `open` selects a trace and later commands use it until `close`. The same release added `npx playwright test --debug=cli`, which pauses a test for an agent to step through over `playwright-cli`.

`playwright-cli` writes a large accessibility snapshot to a file and prints a link rather than the tree ([coding agents guide](https://playwright.dev/docs/getting-started-cli)):

```txt
### Page
- Page URL: https://demo.playwright.dev/todomvc/#/
- Page Title: React • TodoMVC
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

### Visual tools

- Playwright's UI mode and trace viewer have time travel with before and after DOM snapshots, a locator picker, and network and console per action ([UI mode](https://playwright.dev/docs/test-ui-mode)). 1.63 can record aria and screen snapshots on every action in traces, and 1.59 added the trace mode `retain-on-failure-and-retries` for comparing a passing and a failing attempt.
- Vitest 5 added a built-in Trace View for Browser Mode, available in the browser UI, Vitest UI and the HTML reporter, without a separate viewer ([trace view](https://vitest.dev/guide/browser/trace-view)).
- Vitest UI requires a token printed in the terminal ([UI](https://vitest.dev/guide/ui)), a sensible default for a local server.
- Vitest 5 writes the HTML, JSON and JUnit reports, attachments, screenshots and traces under one `.vitest` directory, and the HTML report has a `singleFile` option ([Vitest 5 blog](https://vitest.dev/blog/vitest-5)).

**For Retest. Copy** the command set of Playwright's trace CLI. **Avoid** its hidden open and close state, which breaks when two agents or two runs share a machine. Every `inspect` call names the run directory. **Copy** the "big payload to a file, path in the output" pattern for ARIA trees, DOM and screenshots. **Copy** Vitest's single output directory: `.retest/` with one folder per run and relative artifact paths. **Retest proposal:**

```sh
retest inspect .retest/runs/<run> --json                          # run summary and failures
retest inspect .retest/runs/<run> --test "<id>" --json            # steps, failure card, artifacts
retest inspect .retest/runs/<run> --test "<id>" --step 7 --json   # one step, before and after
```

A UI can come later and read the same run directory.

## 10. Configuration, projects and apps

### Where config goes wrong

- Playwright has two levels that people mix up: "test runner options are **top-level**, do not put them into the `use` section" ([configuration](https://playwright.dev/docs/test-configuration)).
- Setting an option for one test needs a workaround from the maintainers ([#27138](https://github.com/microsoft/playwright/issues/27138), 55 reactions, open):

```js
test.describe(() => {
  test.use({ ... });
  test('example test', async ({ page }) => {
    // ...
  });
});
```

- `webServer` per project is open with 63 reactions ([#22496](https://github.com/microsoft/playwright/issues/22496)). Custom CLI arguments (115, [#10337](https://github.com/microsoft/playwright/issues/10337)) and global hooks (113, [#9468](https://github.com/microsoft/playwright/issues/9468)) were long-standing requests.
- Vitest's config lives under `test:` inside a Vite config. Vitest 5 changed inline projects to inherit the root config by default ([Vitest 5 blog](https://vitest.dev/blog/vitest-5)), and there is a `DEBUG=vitest:projects` log because project resolution is hard to predict ([projects](https://vitest.dev/guide/projects#debugging-project-resolution)).

### Good ideas

- Playwright project dependencies run a `setup` project before the browsers that need it, with the setup visible in reports and traces ([projects](https://playwright.dev/docs/test-projects#dependencies)).
- Playwright 1.57 `webServer.wait.stdout` waits for a log line and passes a named capture group to tests through the environment ([release notes](https://playwright.dev/docs/release-notes#version-157)).
- Playwright 1.63 test locks. Tests that share a lock never run at the same time, across files, workers and projects ([release notes](https://playwright.dev/docs/release-notes#version-163)):

```js
test('update user settings', { lock: 'user-settings' }, async ({ page }) => {
  // never runs at the same time as other tests holding 'user-settings'
});
```

- Vitest accepts options as an object in the second argument everywhere: `test('x', { skip: true, timeout: 10_000, tags: ['db'] }, fn)` ([test API](https://vitest.dev/api/test)).
- Playwright's `globalTimeout` limits the whole run "so that it fails with a report instead of hanging".

**For Retest. Adapt** into one flat `defineConfig` with validated keys, where an unknown key is a usage error (exit 2). Per-test options are always an object in the second argument, with the same keys the config has. **Adapt** projects into named apps, because a Retest test can span a phone, a web app and a desktop app. **Copy** locks for shared devices and accounts. Add `retest config --json` to print the resolved config, which answers what `DEBUG=vitest:projects` answers. **Retest proposal:**

```ts
export default defineConfig({
  apps: {
    web: { target: 'chromium', baseUrl: 'http://127.0.0.1:4000' },
    phone: { target: 'android', device: 'Pixel 9' },
  },
})

test('checkout hands off to the phone', { apps: ['web', 'phone'], lock: 'pixel-9' }, async ({ web, phone }) => {
  // ...
})
```

## 11. TypeScript handling and speed

- Playwright transpiles TypeScript itself and "does not check the types and will run tests even if there are non-critical TypeScript compilation errors". It recommends running `tsc --noEmit` alongside and reads only a few `tsconfig` options ([TypeScript](https://playwright.dev/docs/test-typescript)).
- Vitest transforms through Vite, and 5.0 now prints where the time went ([Vitest 5 blog](https://vitest.dev/blog/vitest-5)): `Duration 3.76s (environment 79%, import 13%, transform 6%, tests 1%, setup 1%)`. `vitest doctor` reruns the suite under candidate settings and recommends the fastest ([CLI](https://vitest.dev/guide/cli#vitest-doctor)). Type tests (`expectTypeOf` in `*.test-d.ts`) run `tsc` only with `--typecheck` ([testing types](https://vitest.dev/guide/testing-types)), and turning that on by default is an open request ([#7773](https://github.com/vitest-dev/vitest/issues/7773)).
- Jest 30 claims 37% faster runs and 77% less memory on tested TypeScript apps ([Jest blog](https://jestjs.io/blog)). ESM is still experimental and needs `--experimental-vm-modules` ([ESM docs](https://jestjs.io/docs/ecmascript-modules)). The ESM issue is Jest's most-reacted, at 817 ([#9430](https://github.com/jestjs/jest/issues/9430)).
- Bun runs TypeScript and JSX natively.
- Node type stripping has been stable since 24.12.0 and 25.2.0. It replaces types with whitespace, needs no source maps, ignores `tsconfig.json`, and errors on `enum`, `namespace` with runtime code, parameter properties, import aliases and decorators; `.tsx` is unsupported ([Node TypeScript](https://nodejs.org/api/typescript.html)). Jest's main-branch docs (not in the 30.5 docs) add Node type stripping as an option and list two more traps: "A type imported as a value (`import {SomeType} from 'pkg'`) survives the erasure and fails at link time. Write `import type`" ([GettingStarted.md on main](https://github.com/jestjs/jest/blob/main/docs/GettingStarted.md)).

The trap for Retest is that Playwright's own page-object examples use parameter properties (`constructor(readonly page: Page) {}`) and a `@step` decorator ([test.step](https://playwright.dev/docs/api/class-test#test-step)). Agents trained on those examples will write code that Node's type stripping rejects.

**For Retest. Copy** type stripping and its exact line and column numbers, as already planned. **Adapt** the errors. Catch `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` and module-link errors and translate them into a usage failure that names the construct and the fix ("parameter property on line 4: declare the field and assign it in the constructor"; "`SomeType` is imported as a value: use `import type`"). Say plainly that types are not checked, and have `init` add a `typecheck` script. **Copy** Vitest 5's duration breakdown, split into Retest's phases: collect, launch, navigate, act, assert, clean up.

## 12. Setup, init and agent scaffolding

- `npm init playwright@latest` prompts for language, folder, a GitHub Actions workflow and browser installation. It "does not overwrite existing tests" when run again ([installation](https://playwright.dev/docs/intro)). It also runs without prompts: `--quiet`, `--lang`, `--browser`, `--no-browsers`, `--no-examples`, `--gha`, `--install-deps`, `--test-dir` ([create-playwright source](https://github.com/microsoft/create-playwright/blob/main/src/cli.ts)). Its assets now include a `playwright-skill.md` agent skill ([assets](https://github.com/microsoft/create-playwright/tree/main/assets)).
- `vitest init browser` is the only Vitest init target, and its source uses interactive `prompts` for language, provider, browser and framework ([docs](https://vitest.dev/guide/browser/), [creator.ts](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/create/browser/creator.ts)). I found no non-interactive flags.
- `npx playwright init-agents --loop=claude|codex|opencode|vscode` writes planner, generator and healer agent definitions, which "should be regenerated whenever Playwright is updated" ([agents](https://playwright.dev/docs/test-agents)). The healer's output is "A passing test, or a skipped test if the healer believes that functionality is broken."
- `playwright-cli install --skills` installs skills into `.claude/skills` or `.agents/skills`. The docs position the CLI for coding agents because "CLI commands avoid loading large tool schemas and verbose accessibility trees into the model context", and MCP for long exploratory loops ([coding agents guide](https://playwright.dev/docs/getting-started-cli)). Since 1.62 both are bundled: `npx playwright cli` and `npx playwright mcp` ([release notes](https://playwright.dev/docs/release-notes#version-162)). A headless `playwright-cli` session shuts down after an hour without commands.
- Vitest's docs tell people to run agents with `vitest run`, because watch-mode detection "can be fragile" ([writing tests with AI](https://vitest.dev/guide/learn/writing-tests-with-ai)). An MCP server for Vitest results is an open request ([#8411](https://github.com/vitest-dev/vitest/issues/8411)).

**For Retest. Copy** a non-interactive, idempotent `init`: prompts only when stdin is a TTY and no agent is detected, flags for everything, and existing tests are never overwritten. **Adapt** `init-agents` and skills into one generated file of CLI facts (commands, exit codes, where runs are written, how to read a failure) that `retest init` writes and `retest --help --agent` prints. **Keep** the architecture's order: finite CLI and JSONL first, MCP later as a thin adapter. Playwright's own guidance supports that order.

**Avoid** the healer's skip. Retest's rules already say an automatic repair cannot remove or weaken an assertion. A repair that cannot keep the test honest should stop and report, and the test stays failed.

## 13. Editors

- Playwright's VS Code extension runs single tests from the gutter, runs across projects, shows the live browser, highlights a locator in the browser when the cursor is on it, records a new test or at the cursor, picks locators, opens the trace viewer, and offers "Fix with AI" through Copilot ([VS Code guide](https://playwright.dev/docs/getting-started-vscode)).
- Vitest's extension no longer keeps a background process unless continuous run is on, adds "Run Related Tests", shows module load time next to imports ([4.1 blog](https://vitest.dev/blog/vitest-4-1)), and adds "Open Trace View" when the HTML reporter is on ([trace view](https://vitest.dev/guide/browser/trace-view)).

**For Retest.** An extension is later work. If `list --json` gives stable IDs with file, line and column, and runs go to a known directory, an extension can stay thin.

## 14. Watch mode

Vitest starts in watch mode by default and falls back to a single run in CI or without a TTY ([CLI](https://vitest.dev/guide/cli)). Its own docs call the detection fragile (section 12). Playwright has watch only inside UI mode. A headless watch mode is its fifth most-reacted open issue at 98 ([#21960](https://github.com/microsoft/playwright/issues/21960)). Bun and Node have `--watch` flags.

**For Retest.** No watch mode, as the brief says. If it ever exists it is a separate `retest watch` command and never the default.

## 15. Timing, flakiness, retries and sharding

- Repeat to find flaky tests: `--repeat-each N` (Playwright), `--repeats` (Vitest 5), `--rerun-each N` (Bun).
- Playwright marks a test that passes on retry as flaky and can fail the run on it with `--fail-on-flaky-tests`. 1.62 added `retryStrategy: 'isolated'`, which runs all retries at the end, one by one ([release notes](https://playwright.dev/docs/release-notes#version-162)).
- Vitest 4.1 retry takes `{ count, delay, condition }`, where `condition` is a regex or function on the error ([test API](https://vitest.dev/api/test#retry)).
- Timing views: Playwright's HTML report "Speedboard" sorts tests by slowness (1.57). Its `perfetto` reporter draws one lane per worker (1.63).
- Sharding: `--shard=i/n` plus blob reports and `--merge-reports` in both Vitest and Playwright. Bun 1.4 balances shards and parallel workers by recorded duration with `--timings` and `--update-timings` ([Bun 1.4](https://bun.com/1.4)). Playwright's request to split shards by timing data was closed as completed on 2026-08-03 ([#17969](https://github.com/microsoft/playwright/issues/17969)), but the sharding docs do not describe it yet.

**For Retest. Copy** `--repeat-each` and the flaky status. **Adapt** retries so they are off by default (the brief), and when enabled they apply only to infrastructure failure classes (session lost, runner crash). An assertion failure is not retried unless the user asks, and every attempt keeps its own ID and evidence. **Copy** duration-based balancing when parallel runs arrive, since device time is the scarce resource.

## 16. APIs that needed lint rules to fence them off

`eslint-plugin-playwright` 2.12.0 has about 65 rules ([README](https://github.com/playwright-community/eslint-plugin-playwright)). Many exist because Playwright ships an API that tests should not use: `no-wait-for-timeout`, `no-force-option`, `no-networkidle`, `no-element-handle`, `no-wait-for-selector`, `no-wait-for-navigation`, `no-page-pause`, `no-nth-methods`, `no-eval`, `no-raw-locators`, `no-useless-await`, `prefer-web-first-assertions`. The last one targets the most common flaky pattern:

```javascript
expect(await page.locator('.tweet').isVisible()).toBe(true)   // incorrect
await expect(page.locator('.tweet')).toBeVisible()             // correct
```

([rule docs](https://github.com/playwright-community/eslint-plugin-playwright/blob/main/docs/rules/prefer-web-first-assertions.md))

Auto-waiting also has limits. Waiting for CSS transitions (144 reactions, [#15660](https://github.com/microsoft/playwright/issues/15660)) and for event listeners after hydration ([#2902](https://github.com/microsoft/playwright/issues/2902)) were long-standing requests, and making locators match only visible elements by default is open ([#35294](https://github.com/microsoft/playwright/issues/35294)). Playwright 1.63 added `locator.visible()`.

**For Retest.** Do not add fixed sleeps, `force`, network-idle waits, element handles or index picking in v1. If boolean state reads such as `isVisible()` exist, name them as one-time reads, and make the docs and the failure card steer toward retrying assertions. Every API left out now is a lint rule nobody has to write later.

## 17. What developers complain about most

Counts are total reactions on 30 September 2026.

| Tool | Issue | Reactions | State | What it says about DX |
| --- | --- | --- | --- | --- |
| Playwright | [#1122](https://github.com/microsoft/playwright/issues/1122) real mobile device browsers | 664 | open | Biggest unmet demand is real devices, which Retest plans |
| Playwright | [#11975](https://github.com/microsoft/playwright/issues/11975) BDD in the runner | 632 | closed | People want plain-language specs next to code |
| Playwright | [#14572](https://github.com/microsoft/playwright/issues/14572) module mocking for non-E2E tests | 441 | closed | Pressure to become a unit-test runner too |
| Playwright | [#7035](https://github.com/microsoft/playwright/issues/7035) watch mode | 158 | closed | Fast feedback loop |
| Playwright | [#15660](https://github.com/microsoft/playwright/issues/15660) wait for transitions | 144 | closed | Auto-wait gaps cause flakiness |
| Playwright | [#10033](https://github.com/microsoft/playwright/issues/10033) annotations on steps | 130 | closed | Steps need structured data |
| Playwright | [#10337](https://github.com/microsoft/playwright/issues/10337) custom CLI arguments | 115 | closed | Config and CLI rigidity |
| Playwright | [#9468](https://github.com/microsoft/playwright/issues/9468) global hooks | 113 | closed | Setup ergonomics |
| Playwright | [#10437](https://github.com/microsoft/playwright/issues/10437) sharding with the HTML report | 111 | closed | Merged results |
| Playwright | [#21960](https://github.com/microsoft/playwright/issues/21960) headless watch mode | 98 | open | Terminal-only loop |
| Playwright | [#23662](https://github.com/microsoft/playwright/issues/23662) CJS and ESM module hell | 92 | closed | Module loading friction |
| Playwright | [#7275](https://github.com/microsoft/playwright/issues/7275) expose runner API | 75 | open | Programmatic control |
| Playwright | [#19992](https://github.com/microsoft/playwright/issues/19992) hide secrets from the trace viewer | 70 | closed | Evidence leaks secrets |
| Playwright | [#8208](https://github.com/microsoft/playwright/issues/8208) `@playwright/test` in Electron | 69 | open | Desktop apps |
| Playwright | [#22496](https://github.com/microsoft/playwright/issues/22496) web server per project | 63 | open | Config granularity |
| Playwright | [#14109](https://github.com/microsoft/playwright/issues/14109) distinct exit codes | 56 | open | CI and agents cannot tell failure kinds apart |
| Playwright | [#27138](https://github.com/microsoft/playwright/issues/27138) `test.use` per test | 55 | open | Per-test options |
| Vitest | [#579](https://github.com/vitest-dev/vitest/issues/579) 3x slower than Jest (2022) | 69 | closed | Transform and isolation cost |
| Vitest | [#2008](https://github.com/vitest-dev/vitest/issues/2008) hangs, "close timed out after 1000ms" | 51 | closed | Runs that do not end |
| Vitest | [#3119](https://github.com/vitest-dev/vitest/issues/3119) detect hanging async operations | 29 | closed | Led to `detectAsyncLeaks` |
| Vitest | [#5883](https://github.com/vitest-dev/vitest/issues/5883) Electron in Browser Mode | 27 | open | Top open request is a non-browser target |
| Vitest | [#3077](https://github.com/vitest-dev/vitest/issues/3077) timeout abort leaves processes running | 19 | closed | Cancellation that does not cancel |
| Vitest | [#7773](https://github.com/vitest-dev/vitest/issues/7773) typecheck by default | 11 | open | Types not checked unless asked |
| Vitest | [#9303](https://github.com/vitest-dev/vitest/issues/9303) fixture startup charged to the first test | 8 | open | Misleading timing |
| Jest | [#9430](https://github.com/jestjs/jest/issues/9430) native ESM | 817 | open | Module system friction, six years on |
| Jest | [#2441](https://github.com/jestjs/jest/issues/2441) `console.log` not shown | 228 | closed | Lost output |
| Jest | [#7963](https://github.com/jestjs/jest/issues/7963) very poor performance | 213 | open | Speed |
| Bun | [#7823](https://github.com/oven-sh/bun/issues/7823) `mock.restore` does not restore `mock.module` | 92 | open | Leaking mocks, single process |
| Bun | [#2984](https://github.com/oven-sh/bun/issues/2984) custom reporters | 55 | open | No reporter API |
| Node | [#51384](https://github.com/nodejs/node/issues/51384) `--test-name-pattern` must come before files | 27 | open | Argument order traps |
| Node | [#51292](https://github.com/nodejs/node/issues/51292) `test()` returns a promise, clashes with lint | 17 | closed | Registration should return void |
| Node | [#52717](https://github.com/nodejs/node/issues/52717) bail on first failure | 15 | open | Stop early |

Patterns across them:

- Runs that hang or keep processes alive (Vitest #2008, #3077; Jest's open-handles warnings). Retest's brief already bounds collection, execution and cleanup and owns process termination. That is a real differentiator, and the docs should say so with numbers once measured.
- Module-system and transform friction (Jest #9430, Playwright #23662, Vitest #579). Retest avoids most of it by running ESM on Node with type stripping and no bundler. The cost is the syntax limits in section 11.
- Config granularity (Playwright #27138, #22496, #10337).
- Non-browser targets (Playwright #1122 and #8208, Vitest #5883). This supports Retest's plan. The brief is right not to advertise them before they work.
- Secrets in evidence (Playwright #19992). Retest's rules already cover this.

## 18. Jest, Bun and node:test in brief

**Jest.** Better: `--onlyChanged`, `--findRelatedTests`, `--onlyFailures`, `--listTests` ([CLI](https://jestjs.io/docs/cli)), the diff format everyone copied, an agent reporter in 30.5. Worse: experimental ESM, TypeScript through Babel without type checks or through `ts-jest` with more config ([getting started](https://jestjs.io/docs/getting-started)), a test that leaks async work still shows `PASS`.

**Bun.** Better: no setup for TypeScript and JSX; agent-quiet output; 1.4 added `--parallel` (which implies `--isolate`), `--isolate`, `--shard`, `--timings` and `--changed` ([Bun 1.4](https://bun.com/1.4), [parallel docs](https://github.com/oven-sh/bun/blob/main/docs/test/parallel.mdx)); stray errors between tests fail the run. Worse: by default all files share one process and global state ("One test crash can affect others", [runtime behavior](https://bun.com/docs/test/runtime-behavior)); no custom reporter API; module mocks leak.

**node:test.** Better: nothing to install; process isolation per file by default; a typed event stream; `t.plan(count, { wait })`; `--test-rerun-failures <state file>`; `expectFailure` with a matcher; stable type stripping ([test docs](https://nodejs.org/api/test.html)). Worse: `test()` returns a promise; experimental watch; argument order traps; no bail.

## Could not verify

Most important first.

1. **Whether an un-awaited Playwright action that rejects after the test ends turns a passing test into a failure.** I confirmed that pending calls get `Test ended.` when the context closes, and that Playwright has no dedicated detection (#37595). I did not run Playwright, since installing it was out of scope.
2. **The exact output of Vitest's agent (`minimal`) reporter.** The docs describe it but show no sample. The PR description is text only.
3. **The detection rules for "pending on the same target" in section 1.** This is my proposal. No tool implements it, and the microtask timing argument needs a prototype.
4. **Jest's `AgentReporter` release.** It is in the published `@jest/reporters@30.5.2` type declarations and on `main`, but I found no changelog entry or docs page for it.
5. **Playwright shard balancing by timing data.** The issue closed as completed on 2026-08-03, but neither the 1.63 release notes nor the sharding docs describe it. It may ship in 1.64.
6. **`printOnlyFailures` in the create-playwright template** (commit on 2026-09-18). I could not find that option in Playwright's list reporter source or docs.
7. **Whether Vitest has a CLI flag for rerunning only the last failures.** None appears in the current CLI reference.
8. **Token cost of MCP against the CLI.** Playwright's docs say only that the CLI uses fewer tokens. A third-party article claims about 114K tokens per test with MCP against 27K with CLI skills ([testquality.com](https://testquality.com/playwright-test-agents-mcp-architecture-2026/)). I did not reproduce it.
9. **The Buffer token figures** in section 2 come from one third-party blog post.
10. **The eval tools' APIs** (`vitest-evals`, `evalite`). I checked only their versions; their API shapes belong to another research track.
11. **Reaction counts** change daily. The table is a snapshot from 30 September 2026 via the GitHub search API.
