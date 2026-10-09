<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/retest-dark.svg">
    <img alt="retest" src="docs/assets/retest-light.svg" width="600">
  </picture>
  <br>
  by <a href="https://rehearsal.dev"><b>Rehearsal</b></a>
</p>

<p align="center">
  <b>One test across web, mobile and desktop.</b><br>
  <b>Built for software engineers and coding agents.</b>
</p>

<p align="center">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early-f4b63f">
  <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime%20dependencies-0-5b3fe6">
  <img alt="Node 24.12 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2024.12-17915a">
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0e1116">
</p>

Retest is a test runner and automation engine written from scratch, with its own drivers for Chromium, Firefox, WebKit, iOS simulator apps, macOS apps and Electron. One test can move between them, every action follows fixed rules, and AI only judges evidence when a test asks it to.

There is no Playwright, Puppeteer or Selenium underneath. Retest is early, and this page says plainly what runs today.

## Quick start

You need Node.js 24.12 or later, on macOS or Linux.

```sh
npm install --save-dev @rehearsal-labs/retest typescript @types/node
npx retest init
```

TypeScript is only for type checks. Retest runs `.ts` test files without it.

`retest init` writes `retest.config.ts`, an example test and a `tsconfig.json` for your tests. It asks for your app's address and browser, or takes them as flags: `npx retest init --app web=http://localhost:3000 --browser chrome`. It never overwrites a file.

Write your first test in `tests/task.retest.ts`:

```ts
import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
```

Run every `.retest.ts` file under the folder:

```sh
npx retest run
```

If a browser, a server or a secret is not ready, `doctor` says what is wrong and how to fix it:

```sh
npx retest doctor
```

### Browsers

`chrome()` runs the Google Chrome installed on your machine. `chromium()` runs the Chromium build you point it to.

Retest downloads nothing unless you ask. `retest install` fetches a pinned build and checks its SHA-256 before it unpacks anything:

```sh
npx retest install --list     # what is pinned for this machine; downloads nothing
npx retest install firefox    # also chromium, webkit and electron
```

On macOS on Apple silicon, Retest pins Chrome for Testing, Firefox 133, Playwright's WebKit build 2359 and Electron 44.5.1. On Linux x64 it pins Chrome for Testing only. A Firefox target finds the installed build by itself. Give a Chromium, WebKit or Electron target the path that `retest install` prints.

## What runs today

| | |
| --- | --- |
| Browsers | Chrome and Chromium. Firefox 133 and WebKit build 2359 on macOS on Apple silicon |
| iOS simulator apps | Find, tap, fill and check elements through WebDriverAgent, built on your Mac from a pinned commit |
| macOS apps | Find, click, fill and check elements through the macOS runner of appium-mac2-driver |
| Electron apps | The app's first window, driven like a Chrome page. Checked with Electron 44.5.1 on macOS |
| One test across platforms | An iOS simulator app, a macOS app and web apps in the same test |
| AI checks | `test.evaluate` asks a judge you choose whether a screenshot, text or recorded frames meet a requirement |
| Playwright test files | `retest run --playwright` runs `.spec.ts` files unchanged, for the methods [the guide](docs/guide.md#run-playwright-test-files) lists |
| Linux | Chrome and Chromium only, checked inside Docker |

Not yet: Android apps, Windows, Safari, and real phones or tablets.

## One test across platforms

This test creates a task on an iPhone simulator, marks it done in Chrome, and sees it done in a macOS app. It is shortened from [reference-flow.retest.ts](fixtures/cross-platform/tests/reference-flow.retest.ts), which runs against the fixture apps in that folder.

```ts
// retest.config.ts
import { chrome, defineConfig, env } from '@rehearsal-labs/retest'

const config = defineConfig({
  apps: {
    phone: { platform: 'ios-simulator', appPath: './TaskPhone.app', device: 'iPhone 17', runtime: '26.5' },
    web: chrome({ baseUrl: 'http://127.0.0.1:4310' }),
    desk: { platform: 'macos', appPath: './TaskDesk.app' },
  },
  secrets: { password: env('TASKS_PASSWORD') },
  secretOrigins: { password: ['dev.retest.fixtures.taskphone', 'dev.retest.fixtures.taskdesk'] },
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
```

```ts
// tests/sync.retest.ts
import { expect, secret, test } from '@rehearsal-labs/retest'

test('a task made on the phone shows up done on the desk', { apps: ['phone', 'web', 'desk'] }, async ({ phone, web, desk }) => {
  await phone.getByTestId('account-field').fill('ada')
  await phone.getByTestId('password-field').fill(secret('password'))
  await phone.getByTestId('sign-in-button').tap()
  await phone.getByTestId('new-task-title-field').fill('Release checklist')
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-state')).toHaveText('Open')

  await web.goto('/')
  await web.getByTestId('account').fill('ada')
  await web.getByTestId('password').fill(secret('password'))
  await web.getByTestId('sign-in').click()
  await web.locator('[data-testid^="open-task-task-"]').click()
  await expect(web).toHaveURL(/\/tasks\/task-[0-9a-f]{12}$/)
  const id = /\/tasks\/(task-[0-9a-f]{12})$/.exec(await web.url())?.[1]
  if (id === undefined) throw new Error(`The address names no task: ${await web.url()}`)
  await web.getByTestId('edit-done').check()
  await web.getByTestId('save-task').click()

  await desk.getByTestId('account-field').fill('ada')
  await desk.getByTestId('password-field').fill(secret('password'))
  await desk.getByTestId('sign-in-button').click()
  await desk.getByTestId('task-id-field').fill(id)
  await desk.getByTestId('show-task-button').click()
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Done')
})
```

The password reaches each app through `secret()`, never through the test's source. The test has no sleeps. Each check keeps looking until the change from the other app arrives.

## See exactly what went wrong

A failure is one card: the check, the element, what was expected, what the page showed, how long Retest looked, the line in your test, a screenshot, and the commands to rerun and inspect it. This is `examples/task.retest.ts`, the test above, run against an app that drops the last letter of every title. Paths are shortened.

```text
  ✗ examples/task.retest.ts › saves a task  5.4s

    Check failed     toHaveText
    Locator          getByTestId('saved-task')
    Page             "Tasks" at http://127.0.0.1:50535/
    - Expected       "Release checklist"
    + Received       "Release checklis"
    Compared         whole text, ends trimmed, each run of spaces or line breaks read as one space
    Waited           5s for toHaveText, looked 14 times, limit 5s

    examples/task.retest.ts:7:48
      5 │   await page.getByTestId('task-title').fill('Release checklist')
      6 │   await page.getByTestId('save-task').click()
    › 7 │   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
      8 │ })

    Screenshot       .retest/runs/…/artifacts/…-failure.png
    Diagnostics      console empty · network 2 requests · .retest/runs/…/diagnostics/….jsonl
    Scope            console covers top level document, same process frames, dedicated workers; network covers top level document, same process frames
    Rerun            npx retest run examples/task.retest.ts:3 --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --base-url http://127.0.0.1:50535
    Inspect          npx retest inspect .retest/runs/… --test "examples/task.retest.ts > saves a task"

  Tests   1 failed
  Checks  1 failed
  Time    7.4s
  Output  .retest/runs/…
  Exit    1
```

## Give your coding agent the same facts

When a coding agent runs Retest, Retest notices. The output gets short, and ends with the next command to run.

```text
retest: 1 failed (1) in 6.1s, exit 1
fail examples/task.retest.ts:7 saves a task
  check_failed toHaveText getByTestId('saved-task')
  expected "Release checklist" received "Release checklis" waited 5002ms for toHaveText, looked 14 times, limit 5000ms
  compared whole text, ends trimmed, each run of spaces or line breaks read as one space
  screenshot .retest/runs/…/artifacts/…-failure.png
  diagnostics console empty · network 2 requests · .retest/runs/…/diagnostics/….jsonl
  scope console covers top level document, same process frames, dedicated workers; network covers top level document, same process frames
next: npx retest inspect .retest/runs/… --test "examples/task.retest.ts > saves a task" --json
```

Every run also writes versioned events, one JSON object per line, with a published JSON Schema. Here is one, shortened:

```json
{"schemaVersion":1,"type":"assertion.failed","matcher":"toHaveText","locator":{"by":"testId","value":"saved-task"},"expected":{"text":"Release checklist"},"actual":{"text":"Release checklis"},"attempts":14,"timeoutMs":5000}
```

`retest inspect` reads a run folder without running anything again. A run that was cut off can never read as a pass.

## What makes it different

- **It says what happened, not what it hopes happened.** A test with no assertions fails. A forgotten `await` fails and names its line. If the browser dies after a click was sent, the result is "outcome unknown", never a guess.
- **Real input.** A click goes through the mouse at the element's centre, after checking it is visible, still, enabled and not covered. A covered button is refused. Nothing is force-clicked.
- **Checks look again. Actions never repeat.** An assertion keeps reading the page until its deadline. A click is sent once.
- **Made for agents from the start.** Finite commands, stable test ids, exit codes that mean something (`0`, `1`, `2`, `130`, `143`), and output an agent can act on.
- **Nothing hidden.** No account and no telemetry. Nothing downloads unless you run `retest install`. Screenshots stay on your machine unless an AI check sends one to the judge you chose.
- **Zero runtime dependencies.** The AI SDK packages are optional peers, loaded only by a judge that uses them.

## Documentation

- [The guide](docs/guide.md): the config, the test API, the command line and their limits, in detail.
- [Architecture](docs/architecture.md): the design Retest was built from.
- [Playwright compatibility](docs/compatibility/playwright.md): the same test files run by Playwright and by Retest, case by case.
- [Conformance](docs/compatibility/conformance.md): fixed cases on Chrome, Firefox and WebKit, and where each engine differs.
- [rehearsal.dev/retest](https://rehearsal.dev/retest): the documentation site.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## From the team behind Rehearsal

Retest is built by [Rehearsal](https://rehearsal.dev), where an agent writes your tests, keeps them working and reports on every pull request. You never need Rehearsal to use Retest.

## License

[Apache-2.0](LICENSE)
