# Retest usage guide

How to set up, run and read Retest, in detail. The [README](../README.md) is the short tour.

Status: milestone 1. Retest runs TypeScript test files against one Chromium or Chrome browser, through its own runner and its own CDP client. It has no runtime dependencies. It is not published; the package is marked private.

The intended package name is `@rehearsal-labs/retest`. The public npm registry returned no package at that name on 29 September 2026. This does not reserve the name or confirm publishing permission. See [the naming check](naming.md).

Retest owns its test API, runner, assertions, browser client, agent protocol and reports. Vitest, Playwright and Bun are design references. Retest does not wrap their test runners or use Playwright, Puppeteer or Selenium to drive the browser.

Retest needs no Rehearsal account. Milestone 1 was tested on macOS arm64 with Chrome 154 only. It handles the SIGTERM a CI runner sends on cancel, but it has not run on a CI runner yet. The library and public protocol use Apache-2.0.

## Prerequisites

- Node.js 24.12 or later. Retest runs `.ts` test files with Node's built-in type stripping.
- An installed Chromium or Google Chrome. Retest downloads no browser. Pass the executable itself, not a macOS app bundle. On the machine milestone 1 was verified on, that is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (Chrome 154.0.8037.92 at the end of the session).
- macOS. Milestone 1 was verified there only. It relies on POSIX process groups, so Windows does not work.

## Install and build

```sh
npm install        # TypeScript 6, TypeScript 7 and @types/node, for building and checking only
npm run build      # empties dist/, then writes it, including dist/schemas/event-v1.schema.json and result-v1.schema.json
npm run typecheck  # tsc 6, then tsc 7
```

From a checkout, run the command line from source with `node --conditions=retest-source src/cli/main.ts`, or from the build with `node dist/cli/main.js`. The examples below write `retest` for either.

To use Retest in another project before it is published, pack it and install the tarball:

```sh
npm run build
npm pack --pack-destination /tmp
cd /path/to/your/project
npm install /tmp/rehearsal-labs-retest-0.0.0.tgz
npx retest --help
```

## Tests

```sh
npm run test:unit         # focused checks, no browser
npm run test:types        # compile-fail fixtures on TypeScript 6 and 7
npm run test:integration  # real processes and a real browser, one file at a time
npm test                  # all three, in that order
```

The integration tests launch the browser named by `RETEST_TEST_BROWSER`. Without it they use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` if it exists, and fail otherwise. They never skip. They start their own fixture servers and browsers with temporary profiles, and stop only those.

## Write a test

A test file ends in `.retest.ts`:

```ts
import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
```

This is [examples/task.retest.ts](../examples/task.retest.ts). The API is small:

- `test(name, fn)` and `test(name, { timeout }, fn)`. `timeout` is the test's budget in milliseconds. Any other option fails collection. Names must be unique in a file.
- `test.step(name, fn)` runs part of a test as a reported step and returns what `fn` returns.
- `page.goto(url)` opens a URL and waits for the `load` event. A relative URL resolves against `--base-url`. If the page replaces itself before `load`, as a client-side redirect does, Retest waits for the new page's `load`. A move within the same document, such as a new fragment, is done once the browser reports it.
- `page.getByTestId(id)` finds the one element whose `data-testid` equals `id` exactly. It finds the element again for every action and every look.
- `locator.fill(text)` focuses a text-like `input` or a `textarea`, selects its value and types the new one. A disabled, read-only or covered field fails, and keeps its value. If the keyboard focus moves to another element before the text arrives, Retest stops the typing before the page hears it, and the fill fails `not_actionable`.
- `locator.click()` presses the mouse at the element's centre once it is visible, stable, enabled and not covered. More than one match fails at once. None waits until the action budget runs out.
- `expect(value).toBe(expected)` compares with `Object.is`, at once.
- `expect(locator).toBeVisible()` and `expect(locator).toHaveText(expected)` look again until they pass or the assertion budget runs out. They never repeat an action. `toHaveText` compares the whole text after trimming both ends and reading each run of spaces or line breaks as one space. Nothing else is loosened.

Retest checks the element just before it acts, and a guard in the page watches the input itself. If the press, the release or the click lands on another element, Retest stops that event before any listener of the page hears it. The click then fails `not_actionable` and names the element that took it. Two cases end as `outcome_unknown` instead, because Retest cannot see where the input went:

- the press never reaches the element's document, as when a same-origin frame covers the element;
- the page moves to a new document before the guard reports.

The guard covers press, release, click and typing events. Hover events, such as `pointerover` when the mouse arrives, still reach the page, so a page can react to the hover before the press.

Await every action and assertion. A page takes one command at a time. A test fails when it makes no assertion, when work it started is still running as it returns, or when an assertion it did not await failed.

Each file runs in its own process, and each test gets a new browser context and page. Module state is shared by the tests in one file. The child process is not a sandbox for hostile test code.

Because the process is shared, code one test leaves behind can fail another. An error from a timer or callback an earlier test started fails whichever test is running when it throws. Its message says that an earlier test may be the cause, and gives the `file:line` that threw. An error thrown while no test runs, between two tests or after the last one, fails the file itself. The tests left in the file do not run, and the run is incomplete: it exits 2 unless a test failed its checks.

A test that runs out of time ends its file's process, because its code may still be running there. The command it was waiting on is stopped in the page: input not yet sent is never sent, and input already sent is not taken back. The action's event says which. The file's remaining tests do not run; their result names the test that timed out. The next file runs in a new process. Retest never reruns a test.

If the browser is lost, the page reports what happened to the command it was running. It is `session_lost` when the command's input was never sent, and `outcome_unknown` when it was. A command that gives no answer within 1 s is `outcome_unknown` too. Later tests do not run.

### Syntax limits

Node strips the types from test files and does not check them. Run `tsc` for that.

- Erasable TypeScript only: no `enum`, no namespaces with values, no parameter properties.
- No JSX, no path aliases, no `tsconfig.json` reading.
- Relative imports name their extension, as in `import { helper } from './helper.ts'`.

## Run the example

Start the fixture app in one terminal. It prints its address, such as `http://127.0.0.1:53124`:

```sh
node fixtures/task-app/cli.ts              # a working app
node fixtures/task-app/cli.ts --mode broken  # saves the title without its last character
```

The other modes are `delayed` (with `--delay-ms`), `duplicate`, `overlay`, `disabled`, `readonly`, `replaced`, `frozen` and `noisy`. The integration tests use them.

Run the example in another terminal:

```sh
retest run examples/task.retest.ts \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --base-url http://127.0.0.1:53124 \
  --output .retest/example-run
```

Against the working app it exits 0. Against the broken app it exits 1 and prints a failure card with the expected and received text, the comparison rule, a code frame, a screenshot path, a rerun command and an `inspect` command.

Other `run` options:

- `--reporter human|jsonl|agent`. With `jsonl`, stdout holds only event lines.
- `--timeouts action=500,test=3000` replaces some budgets. The defaults are collection 10000, setup 60000, action 10000, navigation 30000, assertion 5000, test 60000 and cleanup 10000 milliseconds.
- `--headed` shows the browser window. Nobody has run it yet; every check so far ran headless.
- `--agent` and `--no-agent`. Retest prints the short agent report when `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI`, `AGENT` or `AI_AGENT` is set, unless you pick `--reporter` or `--no-agent`.

### Budgets

Every wait answers to one of these budgets:

- `collection`: loading each test file.
- `setup`: launching the browser, and opening each test's page.
- `action`, `navigation` and `assertion`: one command each, and never more than the test has left.
- `test`: one test.
- `cleanup`: commands a test left running, the failure screenshot, closing each test's page, and closing the browser at the end.

Three fixed graces of 1 s sit on top:

- A test file's process has 1 s to stop once Retest asks it to. Then Retest kills it.
- A page has 1 s to say what happened to its command once its browser is lost.
- The close grace. If the browser has not closed within the cleanup budget, Retest kills its process group and waits up to 1 s more for it to go. This holds however small the cleanup budget is, so a kill is always confirmed.

## List and inspect

```sh
retest list examples/task.retest.ts --json
retest inspect .retest/example-run
retest inspect .retest/example-run --json
retest inspect .retest/example-run --test "examples/task.retest.ts > saves a task"
```

`list` loads each file in its own process and prints the tests it declares, with their source lines. It opens no browser. A file that throws, or whose process ends badly, after its tests were collected still lists them, fails, and makes `list` exit 2, as it would fail a run. `inspect` reads a run folder and never runs anything. A run that stopped before writing `result.json` is rebuilt from `events.jsonl` and marked incomplete, so it never reads as a pass.

## The run folder

Without `--output`, a run goes to `.retest/runs/<time>`. Retest refuses a folder that already holds files.

```text
<run>/events.jsonl        one version 1 event per line, written as it happens
<run>/result.json         written once, at the end; missing means the run did not finish
<run>/logs/<file>.log     the test file's stdout and stderr, together
<run>/logs/browser.log    the browser's own output
<run>/artifacts/*.png     <test>-<attempt>-failure.png, one for each failed test the browser could still capture
```

A problem no single test explains, such as a browser that did not start, is the run's own `failure` in `run.finished` and `result.json`, and the terminal prints it. A file whose process failed outside its tests, as on an error after its last test, has a `failure` of its own in `result.json`, beside its tests. A `file.failed` event records it too, so `inspect` keeps it for a run that stopped before it finished.

Action and assertion events carry `pageUrl`, the page's origin and path. It is absent when no page applies: on value assertions such as `toBe`, and on actions and locator assertions made before the first navigation.

Paths inside the folder are relative, so the folder can be moved. The JSON Schemas for events and results are in `dist/schemas` after a build. Screenshots and page text can hold whatever the page showed. Retest keeps them local and does not redact images.

## Exit codes

- 0: every selected test passed and cleaned up.
- 1: tests ran and at least one failed its checks, even if others hit problems.
- 2: nothing trustworthy came out, or a test could not be checked. This covers usage errors, missing files, collection and setup failures, a lost browser, tests that did not run, cleanup failures and results that could not be written or printed.
- 130: interrupted with Ctrl+C.
- 143: stopped by SIGTERM, as a CI runner does on cancel.

SIGINT and SIGTERM take the same path: the running test stops, the run records `interrupted`, writes `result.json` and closes the browser. A second signal of either kind quits at once and still closes the browser.

130 and 143 win over 2, and 2 for an untrustworthy run wins over 1.

## What milestone 1 does not do

- No browser other than Chromium or Chrome, and no mobile, desktop or native apps.
- No browser download.
- No parallel runs, retries, watch mode, `skip`, `only`, custom fixtures or `test.extend`.
- No folders or patterns on the command line. Name each file.
- Locators by test id only: no roles, text, `first()` or `nth()`. No `force`, no sleep and no element handles.
- The top-level document only: no frames, shadow DOM, popups, dialogs, uploads, downloads, network mocking, video or visual comparison. A JavaScript dialog fails the command as unsupported. A dialog or a crashed page makes the waiting command, and every later command on that page, fail at once.
- Page console messages are not recorded anywhere.
- SIGKILL stops Retest without a result. The run folder then has no `result.json`, and `inspect` reads it as incomplete. The browser profile a killed run leaves in the temporary folder is removed when the next run starts.

## Project documents

- [Architecture and implementation sequence](architecture.md)
- [First implementation brief](implementation-brief.md)
- [Milestone 1 handoff](implementation-handoff.md)
- [Package, scope and account checks](naming.md)
- [Contribution rules](../AGENTS.md)
