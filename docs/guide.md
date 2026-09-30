# Retest usage guide

How to set up, run and read Retest at milestone 2, in detail: the config, the test API, the command line and what Retest does not do yet. The [README](../README.md) is the short tour, and the [handoff](implementation-handoff.md) records what was verified and how.

Retest runs TypeScript test files against Chromium-family browsers, through its own runner and its own CDP client. A project has a config with named apps, several browser targets, emulated devices, secrets, tags and sign-in state. Retest has no runtime dependencies, and it downloads no browser.

Everything here was checked on macOS arm64 only, with Google Chrome 154 and Chrome for Testing 153. Retest handles the SIGTERM a CI runner sends on cancel, but it has not run on a CI runner yet.

The package is not published and is marked private. Its intended name is `@rehearsal-labs/retest`; see [the naming check](naming.md). The library and public protocol use Apache-2.0.

## Prerequisites

- Node.js 24.12 or later. Retest runs `.ts` files with Node's built-in type stripping.
- An installed Chromium, Google Chrome or Microsoft Edge. Retest downloads no browser. Where a path is asked for, give the executable itself, not a macOS app bundle.
- macOS or Linux. Only macOS was verified. Retest relies on POSIX process groups, so Windows does not work.

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
npm run test:integration  # real processes and real browsers, one file at a time
npm test                  # all three, in that order
```

The integration tests need two browsers. They never skip.

- The first is `RETEST_TEST_BROWSER`, or `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` when that exists. Config runs find Google Chrome by themselves, through `chrome()`.
- The second is `RETEST_TEST_SECOND_BROWSER`, or Chrome for Testing where Playwright unpacks it on macOS: `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. It is a plain browser build. No Playwright code runs.

The tests start their own fixture servers and browsers with temporary profiles, and stop only those.

## Start a project

```sh
npm install -D /tmp/rehearsal-labs-retest-0.0.0.tgz typescript @types/node
npx retest init
npx retest doctor
npx retest run
```

`retest init` writes four things and changes two:

- `retest.config.ts`, with the block that registers its types;
- `tests/example.retest.ts`;
- `tsconfig.retest.json`, with the flags that make `tsc` reject what Node's type stripping cannot run;
- `.github/workflows/retest.yml`, only with `--ci github`;
- the `test:e2e` and `typecheck:e2e` scripts in `package.json`, which it creates when there is none;
- `.retest/` in `.gitignore`.

It never overwrites a file. A file that is already there is reported as "left as is", so running `init` twice changes nothing. It installs nothing; it prints the install command.

It asks questions only at a terminal where no coding agent is detected. Each question has a flag: `--app name=url`, `--start "command"` and `--browser chromium|chrome|edge`. `--yes` takes the default for every question without a flag. The default browser is the first one installed where Retest looks: Chrome, then Edge, then Chromium from `RETEST_CHROMIUM`.

A project that does not say `"type": "module"` in `package.json` gets a note: add it, or the type check reads the tests as CommonJS.

## The config

A project's config is `retest.config.ts` in the folder Retest runs from, or the file `--config <path>` names. Retest imports it with Node's type stripping, in its own process only. The test files never load it.

```ts
import { app, chrome, chromium, defineConfig, env } from '@rehearsal-labs/retest'

const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

const config = defineConfig({
  apps: {
    web: chrome({ baseUrl }),
    admin: chrome({ baseUrl }),
    desktop: app({ baseUrl, targets: { chrome: chrome(), chromium: chromium() } }),
    phone: app({ baseUrl, targets: { pixel: chrome({ emulate: 'Pixel 9' }), iphone: chrome({ emulate: 'iPhone 17' }) } }),
  },
  defaultApp: 'web',
  runs: [
    { desktop: 'chrome', phone: 'pixel' },
    { desktop: 'chromium', phone: 'iphone' },
  ],
  secrets: { password: env('TASK_APP_PASSWORD') },
  tags: ['smoke', 'roles', 'browsers', 'phone'],
  states: ['signed-in'],
  timeouts: { action: 5000, assertion: 5000, test: 30_000 },
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
```

This is [examples/tasks/retest.config.ts](../examples/tasks/retest.config.ts), without its comments.

### Register

The `declare module` block registers the config's type once, for every file in the same TypeScript program. The type check then knows your names:

- `apps` in a test takes only the config's app names, and a test can only use the apps it declares.
- `tags`, `state`, `secret()` and `getByTestId()` take only the config's tags, states, secrets and test ids. A config that lists no `tags`, `states` or `testIds` accepts any string for them. One that declares no `secrets` accepts none.
- `tap()` exists only on an app whose every target emulates a touch screen.

Without a registered config, a test may not declare `apps` or `state`: the type error says how to register. `page` still works, and so do any tag, secret name and test id.

A registration applies to its whole program. Keep a registered project in its own `tsconfig`. This repository's example has its own, and the root `tsconfig.json` leaves it out.

The type check helps TypeScript callers only. Retest checks the same things again when it loads the config and the tests, because JavaScript callers have no types.

### Keys

| Key | What it holds |
| --- | --- |
| `apps` | Each app: `app({ baseUrl?, start?, targets })`, or a target on its own, which may carry `baseUrl` and `start` |
| `defaultApp` | The app `page` is. Defaults to the only app. With several apps and none named, a test without `apps` fails collection |
| `runs` | App name to target name, one entry per pairing, for tests that use two or more apps with several targets each |
| `secrets` | Each secret's source: `env(name)`, or a function |
| `secretOrigins` | For a secret, more origins where it may be typed |
| `testIds` | The test ids `getByTestId` accepts, as a list or an object of constants. Only the type check reads it |
| `tags` | The tags tests may use. `--tag` refuses any other |
| `states` | The names `test.setup` may save |
| `timeouts` | Budgets that replace the defaults. `--timeouts` replaces these in turn |

Names of apps, targets, secrets, tags and states hold letters, digits, `_` and `-`, and start with a letter. A tag cannot be `and`, `or` or `not`. `executablePath` and `start.cwd` are relative to the config's folder. `baseUrl` and `start.ready` are http or https addresses. A key set to `undefined` counts as absent. An unknown key is an error.

An invalid config is a usage error, exit 2, before anything runs. The message names the file and each key at fault, such as `apps.web.baseUrl: expected an http or https URL, received "ftp://tasks.example"`. Within one app, only the first problem is named until it is fixed.

### Targets

A target is a browser to run in:

- `chromium({ executablePath?, headless?, emulate? })` runs the Chromium at `executablePath`, or at the path in `RETEST_CHROMIUM`.
- `chrome({ channel?, headless?, emulate? })` runs Google Chrome. `channel` is `stable`, the default, or `beta`, `dev` or `canary`.
- `edge({ channel?, headless?, emulate? })` runs Microsoft Edge the same way.

Retest finds Chrome and Edge where they install: on macOS in `/Applications` and `~/Applications`, and on Linux in the standard paths. A browser that is not there is a setup failure that lists the paths it tried, before any test that needs it. Only `chrome()` stable and `chromium({ executablePath })` were run. Edge and the other Chrome channels were not installed on the machine Retest was checked on.

`headless` defaults to true. `--headed` shows every browser. Nobody has run a browser with a window yet.

Targets on the same executable, with the same headless setting and emulation, share one browser process. Each distinct target launches once, the first time a test needs it, and closes when the run ends. Every test gets a new browser context and page for each of its apps.

### Apps and runs

Each app a test declares gets its own browser context and page, so two apps start with separate cookies and storage. Two apps are how a test plays two people, such as an owner and a member. Each app takes one command at a time, and two apps may act at once.

How many times a test runs depends on the targets of its apps:

- Each app has one target: once.
- One app has several targets: once per target.
- Two or more apps have several targets each: once for each entry in `runs` that names all of them. With no such entry, the test's file fails collection.

Each run of a test is a variant, such as `desktop=chromium`. Its key is its `app=target` pairs, sorted and joined with commas. A result is unique by its test id and its variant key.

`--base-url url` replaces the default app's base URL, and `--base-url app=url` a named app's. That is how CI points the tests at a preview deployment. `--browser` is milestone 1's mode, and is a usage error beside a config.

### Emulation

`emulate` makes a desktop browser pretend to be a device. It is never the device itself.

- A name from the built-in table: `'Pixel 9'`, `'Galaxy S24'`, `'iPhone 17'` or `'iPad Pro 11'`. Each gives a viewport, a pixel ratio, `isMobile`, a touch screen and a user agent. An Android device's user agent names the running browser's own major version. The sizes come from published specifications and were not measured on the devices.
- An object: `{ viewport: { width, height }, deviceScaleFactor, touch, isMobile?, userAgent? }`. `isMobile` defaults to false. Without `userAgent`, the browser keeps its own.

An emulated target is marked "emulated" in every event, result and report. A named device sends no user-agent client hints, so the page sees only the device's user agent.

On a touch screen, `click()` is sent as a tap and recorded as a tap.

### Starting the app server

An app with `start: { command, ready, cwd?, timeoutMs? }` gets its server started when a test first needs it:

1. Retest asks `ready` with an HTTP GET. Any HTTP answer counts, whatever its status.
2. If something answers, Retest uses that server and never stops it.
3. Otherwise it runs `command` in a shell, as a process group of its own, with its output in `logs/app-<name>.log`. It waits for `ready` within `timeoutMs`, or the setup budget.
4. When the run ends, it sends the group SIGTERM, then SIGKILL after one second.

A server that exits early, or never answers, is a setup failure for every test that needs it: they do not run. The server's output is in its log, and the failure says where. If Retest itself is killed with SIGKILL, nothing is left to stop a server it started.

## Write a test

A test file ends in `.retest.ts`:

```ts
import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', { tags: ['smoke'] }, async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
```

`test(name, options?, fn)` takes these options:

- `apps`: the apps the test uses. Its function then receives one page per app, by name, instead of `page`.
- `tags`: tags that `--tag` selects it by.
- `state`: a saved sign-in state to start from. With several apps, give one per app: `state: { web: 'signed-in' }`.
- `timeout`: its own budget in milliseconds.

Names are unique in a file. [examples/tasks/tests](../examples/tasks/tests) uses every part of the API.

### Structure

- `test.describe(name, options?, fn)` groups tests. Its name joins their ids, as in `tests/tasks.retest.ts > tasks > saves a task`. Its `apps`, `tags` and `state` pass down to every test inside. Its function receives `test`, which knows the block's apps. Blocks nest. Two blocks with one name under the same parent fail collection.
- `test.beforeEach(fn)` and `test.afterEach(fn)` run around each test in their file or block.
  - `beforeEach` hooks run outermost first, and `afterEach` hooks innermost first. Within a block, hooks run in the order they were declared.
  - A `beforeEach` that fails skips the rest of the `beforeEach` hooks and the test body.
  - Every `afterEach` runs, even after a failure. A hook's failure sits beside the test's first failure, in `failure.details.also`, and never replaces it.
  - Each hook is reported as a step marked `beforeEach` or `afterEach`.
- `test.for(rows)(name, options?, fn)` declares one test per row. Each `$key` in the name takes the row's `key`. The function gets the row after the context. Two rows that make the same name fail collection.
- `test.step(name, fn)` runs part of a test as a reported step and returns what `fn` returns.

### Sign-in state

`test.setup(state, options?, fn)` declares a setup at the top level of a file. It uses exactly one app. It signs in the way a person would, and when it passes, Retest saves that browser context's cookies, and the `localStorage` of the origins it visited, under the state's name.

```ts
test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test('shows the account', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByText('Signed in as alice')).toBeVisible()
})
```

- A setup runs before any test that needs its state, once for each target those tests use.
- A test with `state` gets a new context with the state restored before its body runs. A test without it starts signed out.
- A setup that fails makes every test that needs it `not_run`, with the setup's failure as the reason.
- A state no setup saves is a collection error. When you run only some files, Retest looks for a missing setup in the other `.retest.ts` files under the root, in path order, and runs only the setups the chosen tests need. The report says so, as in "ran setup signed-in from tests/sign-in.retest.ts for tests/roles.retest.ts".
- The saved state is a file in `<run>/states/` while the run goes on. It holds session cookies, so Retest deletes it when the run ends, even after Ctrl+C. Only a run killed with SIGKILL leaves it behind. Events say a state was saved or restored, never what it holds.
- `sessionStorage` is not saved.

### Locators

A locator is a recipe, not an element. Retest finds the element again for every action and every look. An action needs exactly one match: none waits until the action budget runs out, and more than one fails at once as `ambiguous`.

| Locator | Finds |
| --- | --- |
| `getByTestId(id)` | Elements whose `data-testid` equals `id` exactly |
| `getByRole(role, { name?, exact? })` | Elements with this ARIA role and, when given, this accessible name |
| `getByLabel(text, { exact? })` | Form controls whose accessible name matches: roles `textbox`, `searchbox`, `combobox`, `listbox`, `checkbox`, `radio`, `switch`, `slider` and `spinbutton` |
| `getByText(text, { exact? })` | The innermost elements whose text matches |

How names and text match:

- Both sides are trimmed, and each run of spaces or line breaks reads as one space.
- `exact` defaults to true: the whole string, case and all. `name: 'Save'` never matches "Save draft" or "save".
- `exact: false` matches any part, in any case. `name: 'save', exact: false` matches "Save", "save" and "Save draft".

Where the name comes from:

- `getByRole` and `getByLabel` use the accessibility tree Chrome computes. So the name comes from `aria-label`, `aria-labelledby`, `<label for>`, a wrapping `<label>`, `title`, a placeholder or the content, as Chrome decides. Retest does not compute names itself.
- They leave out elements Chrome leaves out of that tree: `aria-hidden`, `display: none`, `hidden`, `visibility: hidden` and `inert`.
- `getByText` reads the text in the page. It skips `script`, `style`, `template` and `noscript`. It finds hidden elements too, and reports them as not visible.

All four search only the top-level document. They do not look into shadow roots or frames.

### Actions

- `page.goto(url)` opens a URL and waits for the `load` event. A relative URL resolves against the app's base URL. A page that replaces itself before `load` is followed to its own `load`.
- `locator.fill(value)` focuses a text-like `input` or a `textarea`, selects its value and types the new one. `value` is text or a `secret()`.
- `locator.click()` presses the mouse at the element's centre once it is visible, stable, enabled and not covered. On a touch screen it taps.
- `locator.tap()` taps the element's centre. It exists only on an app whose every target emulates a touch screen.

Retest checks the element just before it acts, and a guard in the page watches the input itself. If the press, the release or the click lands on another element, Retest stops that event before any listener of the page hears it. The action then fails `not_actionable` and names the element that took it. While the browser is opening another document in the frame, no action starts: Retest waits for that document and looks for the element there, and an action whose time runs out meanwhile fails `not_actionable`, naming the address the page was opening. Typing that arrives in a document that replaced the one Retest checked is stopped by that document's own guard, and the fill fails `not_actionable`, naming the document. Two cases end as `outcome_unknown` instead, because Retest cannot see where the input went:

- the press never reaches the element's document, as when a same-origin frame covers the element;
- the page moves to a new document before the guard reports, and that document received no typing.

The guard covers press, release, click, touch and typing events. Hover events, such as `pointerover` when the mouse arrives, still reach the page. Downloads are refused: Retest asks the browser to deny them in every context it opens.

### Matchers

Locator matchers look again until they pass or the assertion budget runs out. They never repeat an action. Await them.

- `toBeVisible()`: exactly one match, and it is visible.
- `toBeHidden()`: nothing matches, or nothing that matches is visible.
- `toHaveText(text)`: exactly one match, whose whole text equals `text`.
- `toHaveText([...texts])`: the matches, hidden ones included, have exactly these texts, in document order.
- `toHaveCount(n)`: exactly `n` matches, visible or not.
- `toHaveValue(value)`: exactly one field matches, and its whole value is exactly `value`.

`toHaveText` trims both ends and reads each run of spaces or line breaks as one space. Nothing else is loosened, and `toHaveValue` loosens nothing. An observation lists at most 100 matches, so `toHaveText([...])` and `toBeHidden()` cannot pass when more match.

Value matchers check at once:

- `toBe(expected)` compares with `Object.is`.
- `toEqual(expected)` compares deeply: primitives by `Object.is`, plain objects by their own keys, arrays item by item, `Date` by its time, `Map` by key then value, and `Set` by member. Any other object must be the same object.
- `toContain(item)` looks in a string or an array.
- `toMatch(pattern)` tests a string against a `RegExp`.

Two more ways to check:

- `expect.poll(fn, { timeout?, intervals? })` calls `fn` again until its value passes a value matcher or its time runs out. Its time is `timeout`, or the assertion budget. `intervals` are the waits between looks, the last one repeating. `fn` may only read. An action inside it fails the test, because it would run again on every look.
- `expect.soft(x)` records a failure and lets the test go on. The test fails at the end, with its first failure leading and the others in `failure.details.also`. Every soft failure has its own event, marked `soft: true`.

The type check rejects a value matcher on a locator, a locator matcher on a value, and any matcher on a secret.

### Secrets

```ts
await page.getByLabel('Password').fill(secret('password'))
```

- `secret(name)` names a secret from the config. However it is printed, it reads `{{password}}`.
- The test file's process never holds the value. It sends the secret's name, and Retest's own process types the value. The environment variable an `env` source reads is removed from the test process's environment.
- An `env(name)` source is read once, when the run starts. A variable that is missing, empty or shorter than four characters stops the run with exit 2 before any test starts, naming it.
- A function source is called each time a `fill` uses the secret, since values such as one-time codes change. If it throws, rejects or gives no text, that fill fails `setup_failed`, naming the secret.
- A secret is bound to origins: those of the base URLs of the test's apps, and any `secretOrigins` lists for it. On any other page, the fill fails `not_actionable`, naming the page's origin, and nothing is typed.
- Retest checks the origin twice: before it reads the value, and again in the page, just before it types. While it types, it stops the page from leaving for another document. While the browser is already opening another document, the fill waits for it and checks that document instead. A document that still arrives while the text is on its way stops the text itself, since nothing was armed there: the fill fails `not_actionable`, naming the document, and the text reaches no document Retest did not check.
- Retest writes `{{name}}` in place of every value in all text it records or reports: events, results, logs, app server output, browser logs, the terminal, and every address it records, in every form a URL gives a value, percent-encoded or form-encoded. Page text the test reads is redacted before it reaches the test's process, so a check against it compares `{{password}}`.
- A fill of a secret records `secret: name` in its event, instead of the length of the text.
- A function source's value is known, and so hidden, only once a fill has read it. Every log is read again when the run ends, so a value a server or a test file printed before that is hidden there too. What the terminal and the events already carried before the first read stays as it was, and so does page text the test read before it.

Screenshots are not redacted. A failure screenshot shows whatever the page showed, including a secret the page displays. Text redaction is not image redaction.

### Rules every test follows

Await every action and assertion. An app takes one command at a time. A test fails when it makes no assertion, when work it started is still running as it returns, or when an assertion it did not await failed.

Each test file runs in a process of its own, and each test gets new browser contexts and pages. Module state is shared by the tests of one process. The process is not a sandbox for hostile test code.

A file is loaded once to collect its tests, and again each time the run visits it: usually twice, and more when its setups run in a visit of their own before its tests. Code at the top level of a file runs on every load.

Because tests in one process share it, code one test leaves behind can fail another. An error from a timer or callback an earlier test started fails whichever test is running when it throws. Its message says an earlier test may be the cause, and gives the `file:line` that threw. An error thrown while no test runs fails the file itself. The tests left in the file do not run, and the run is incomplete.

A test that runs out of time ends its file's process, because its code may still be running there. The command it was waiting on is stopped in the page: input not yet sent is never sent, and input already sent is not taken back. The file's remaining tests do not run. The next file runs in a new process. Retest never reruns a test.

If a browser is lost, the page reports what happened to its command: `session_lost` when the input was never sent, and `outcome_unknown` when it was. Later tests on that browser do not run. Tests on the run's other browsers still do.

### Syntax limits

Node strips the types from test files and does not check them. Run `tsc` for that, as `npm run typecheck:e2e` does after `init`.

- Erasable TypeScript only: no `enum`, no namespaces with values, no parameter properties.
- No JSX, no path aliases, no `tsconfig.json` reading.
- Relative imports name their extension, as in `import { helper } from './helper.ts'`.

## Run the example

The example project is in [examples/tasks](../examples/tasks). Start the fixture app in one terminal. It prints its address, such as `http://127.0.0.1:53124`:

```sh
node fixtures/task-app/cli.ts              # a working app
node fixtures/task-app/cli.ts --mode broken  # saves the title without its last character
```

Run the example from its folder in another:

```sh
cd examples/tasks
export TASK_APP_URL=http://127.0.0.1:53124
export TASK_APP_PASSWORD='correct horse battery staple'
export RETEST_CHROMIUM=/path/to/chromium   # the second desktop browser
node --conditions=retest-source ../../src/cli/main.ts run
node ../../node_modules/typescript/bin/tsc -p tsconfig.json
```

Against the working app all 16 test runs pass. Against the broken app five fail with a failure card. The example's `tsconfig.json` resolves the package to its source in this repository; a project that installs it leaves `customConditions` out.

Milestone 1's example still runs without a config: `retest run examples/task.retest.ts --browser <path> --base-url <url>`.

## Run tests

```sh
retest run                                   # every .retest.ts file under this folder
retest run tests/tasks.retest.ts:22          # the test, test.for or test.describe declared on line 22
retest run --tag "smoke and not slow"
retest run --grep "/^tasks > saves/i"
retest run --target desktop=chromium
retest run --last-failed
```

With a config and no files, `run` and `list` take every `.retest.ts` file under the folder. They skip `node_modules` and folders whose names start with a dot.

### Choosing tests

- `--grep text` keeps tests whose full title contains the text. The full title is the `test.describe` names and the test's name, joined by ` > `. `--grep /pattern/flags` matches a pattern instead; the `g` and `y` flags are refused.
- `--tag "expression"` keeps tests whose tags satisfy it. It reads `and`, `or`, `not` and parentheses. A tag the config does not list is a usage error that points at it.
- `file:line` keeps the test, `test.for` or `test.describe` declared on that line. Add `#row` to keep one row of a `test.for`, as in `tests/tasks.retest.ts:22#2`. The rows count from 1, and `list` and a failure card's rerun command show each row's number.
- `--last-failed` keeps the tests the last run did not pass: failed, ended in an error, or not run. Each is kept for the variant that did not pass. Every run writes them to `.retest/last-run.json`.
- `--target app=name` keeps the runs that use that target for that app. Repeat it for other apps. A test that does not use the app is left out.

The filters combine: a test runs when it passes all of them. The setups the chosen tests need run too. A selection that keeps nothing exits 2 and says why.

### Other options

- `--config <path>` loads another config.
- `--reporter human|jsonl|agent`. With `jsonl`, stdout holds only event lines.
- `--timeouts action=500,test=3000` replaces some budgets.
- `--output <dir>` names a new run folder. Retest refuses one that holds files.
- `--headed` shows every browser window. Nobody has run it yet.
- `--agent` and `--no-agent`. Retest prints the short agent report when `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI`, `AGENT` or `AI_AGENT` is set, unless you pick `--reporter` or `--no-agent`.

The human report labels each variant, as in `phone=pixel (emulated)`, and ends with a line for each target when there is more than one. A failure card's rerun command names the test by `file:line` and its variant by `--target`.

### Budgets

Every wait answers to one of these budgets. The defaults are collection 10000, setup 60000, action 10000, navigation 30000, assertion 5000, test 60000 and cleanup 10000 milliseconds.

- `collection`: loading each test file.
- `setup`: launching a browser, opening each test's pages, and starting an app server without its own `timeoutMs`.
- `action`, `navigation` and `assertion`: one command each, and never more than the test has left.
- `test`: one test.
- `cleanup`: commands a test left running, the failure screenshots, closing each test's pages, and closing the browsers at the end.

Two fixed graces of one second sit on top:

- A test file's process has one second to stop once asked. Then Retest kills it.
- A browser that has not closed within the cleanup budget, or an app server still running one second after SIGTERM, is killed with its process group. Retest then waits one second more for it to go.

## Check the setup

```sh
retest doctor
```

`doctor` loads the config and checks everything a run needs, without running a test:

- For each target, it launches the browser once, reports its product, version and path, and closes it.
- For each app with `start`, it starts the server, waits for `ready` and stops it. A server already running is left alone.
- For each app with only a `baseUrl`, it checks that the address answers.
- It checks that each secret's environment variable is set.

Each problem comes with its fix. `doctor` exits 0 when everything is ready and 2 otherwise. When a browser or a server fails, the message points to its log, which is kept under `.retest/doctor/<time>/`. Otherwise `doctor` removes its logs.

## List and inspect

```sh
retest list --json
retest list --tag smoke
retest inspect .retest/runs/<time>
retest inspect .retest/runs/<time> --json
retest inspect .retest/runs/<time> --test "tests/devices.retest.ts > saves a task in each desktop browser" --target desktop=chromium
```

`list` loads each file the way a run does and prints its tests with their source lines, tags, apps and variants. It takes the same selection flags as `run`, and opens no browser.

`inspect` reads a run folder and never runs anything. It shows each test's variant and, for one test, the app of each action. A run that stopped before writing `result.json` is rebuilt from `events.jsonl` and marked incomplete, so it never reads as a pass.

## The run folder

Without `--output`, a run goes to `.retest/runs/<time>`.

```text
<run>/events.jsonl                 one version 1 event per line, written as it happens
<run>/result.json                  written once, at the end; missing means the run did not finish
<run>/logs/<file>.log              a test file's stdout and stderr, together
<run>/logs/browser-<target>.log    each browser's own output; logs/browser.log without a config
<run>/logs/app-<name>.log          the output of a server Retest started
<run>/artifacts/*.png              one failure screenshot for each app page of a failed test
<run>/states/                      saved sign-in state, only while the run goes on
.retest/last-run.json              the tests the last run did not pass, for --last-failed
```

Every event says who reported it: `origin: 'parent'` for what Retest's own process saw, and `origin: 'child'` for what the test file's process claimed. Every event of a test's run carries its `variant` and `variantKey`, and every event about an app names it in `session`. Milestone 1's mode has one app, named `page`, and no variants.

`browser.started` comes once for each app target, with the app and the target, and whether it is emulated. `app.started`, `app.reused` and `app.failed` tell what became of each server. `state.saved` and `state.restored` name a state, never its contents. `result.json` lists every app target's browser in `browsers`, and each screenshot names its app.

A problem no single test explains, such as a browser that did not start, is the run's own `failure` in `run.finished` and `result.json`. A file whose process failed outside its tests has a `failure` of its own, and a `file.failed` event.

Paths inside the folder are relative, so the folder can be moved. The JSON Schemas for events and results are in `dist/schemas` after a build.

## Use Retest from code

A service that runs tests itself uses two subpaths. The root export stays the authoring API.

- `@rehearsal-labs/retest/runner` exports `runFiles`, `collectFiles`, `validateConfig`, `RunFolderError` and `LaunchError`, and the types a caller needs: `RunOptions`, `CollectOptions`, `CollectResult`, `LoadedConfig`, `Reporter`, `ChildOutput`, `LaunchBrowser` and the browser contract a custom launcher implements.
- `@rehearsal-labs/retest/protocol` exports the event, result, command and failure types, their schemas, `parse`, and `eventSchemaUrl` and `resultSchemaUrl`, the file URLs of the JSON Schema files.

```ts
import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { runFiles, validateConfig, type Reporter } from '@rehearsal-labs/retest/runner'

const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl }) }, secrets: { password: readPassword } }), '/work/in-memory.config.ts')
if (!loaded.ok) throw new Error(loaded.failure.message)
const result = await runFiles(
  {
    files: ['tests/sign-in.retest.ts'],
    rootDir: '/work',
    apps: { kind: 'config', config: loaded.config, secrets: new Map([['password', { read: readPassword }]]) },
    timeouts: { collection: 10_000, setup: 60_000, action: 10_000, navigation: 30_000, assertion: 5000, test: 60_000, cleanup: 10_000 },
    outputDir: '/work/.retest/runs/latest',
    headless: true,
    signal: new AbortController().signal,
  },
  [reporter],
)
```

The config's secrets must be given to `runFiles` resolved, in `apps.secrets`: `{ value }` for a value read once, or `{ read }` for a function called on each use. The seven budgets are given in full; neither subpath exports the defaults.

## Exit codes

- 0: every selected test passed and cleaned up.
- 1: tests ran and at least one failed its checks, even if others hit problems.
- 2: nothing trustworthy came out, or a test could not be checked. This covers usage errors, an invalid config, a missing secret, missing files, collection and setup failures, a lost browser, tests that did not run, cleanup failures, results that could not be written, and a selection that kept nothing.
- 130: interrupted with Ctrl+C.
- 143: stopped by SIGTERM, as a CI runner does on cancel.

SIGINT and SIGTERM take the same path: the running test stops, the run records `interrupted`, writes `result.json`, closes the browsers, stops the servers it started and deletes saved state. A second signal of either kind quits at once, and its exit hooks still end the browsers and servers and delete saved state.

130 and 143 win over 2, and 2 for an untrustworthy run wins over 1.

## What milestone 2 does not do

- Browsers: Chromium, Chrome and Edge only. No Firefox, WebKit or Safari, and no real phones, tablets, native or desktop apps. Emulation is a desktop browser pretending.
- Checked only on macOS arm64 with Google Chrome 154 and Chrome for Testing 153. Edge, Chrome beta, dev and canary, Linux and CI runners were never run. Windows cannot work.
- `--headed`, and `headless: false` in a config, were never run.
- Locators search the top-level document only: no shadow DOM, no frames. No `first()`, `nth()`, `filter()` or chained locators.
- No popups, dialogs, uploads, downloads, network mocking, video or visual comparison. A JavaScript dialog fails the command as unsupported.
- No parallel workers, `lock`, retries, watch mode, `skip`, `only`, custom fixtures or `test.extend`.
- No `retest install` and no browser download. No HTML report.
- No `toMeet`, `test.eval`, judges or agent session API.
- Test files are loaded more than once: once to plan the run, and again for each visit that runs them. Top-level code runs each time.
- Screenshots are not redacted. A secret the page shows appears in its screenshot.
- A function source's value is hidden only from the moment a fill first reads it; page text read before that reached the test's process as it was.
- A page that moves the keyboard focus into a frame of another site as the text arrives can receive the text there. Retest reports `outcome_unknown` and names the frame; it cannot stop typing inside a frame it is not attached to.
- Page console messages are not recorded.
- SIGKILL stops Retest without a result. `inspect` reads the folder as incomplete. The browser profile it left is removed when the next run starts. Nothing stops a server it started, and saved state, with its session cookies, stays in its run folder.
- `list --json` has no published JSON Schema. Events and results do.

## Project documents

- [README](../README.md)
- [Architecture and implementation sequence](architecture.md)
- [First implementation brief](implementation-brief.md)
- [Milestone 1 plan](plans/milestone-1/build-plan.md) and [milestone 2 plan](plans/milestone-2/build-plan.md)
- [Implementation handoff](implementation-handoff.md)
- [Contribution rules](../AGENTS.md)
