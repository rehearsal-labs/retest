<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/retest-dark.svg">
    <img alt="retest" src="docs/assets/retest-light.svg" width="600">
  </picture>
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

Retest is a test runner and browser driver written from scratch. It has its own runner, its own assertions and its own Chromium client over the DevTools pipe. There is no Playwright, Puppeteer or Selenium underneath, and nothing to install at runtime.

It is early. Chromium works today. The rest of this page says plainly what exists and what is coming.

## Write a test

```ts
import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
```

## See exactly what went wrong

A failure is one card: the check, the element, what was expected, what the page showed, how long Retest looked, the line in your test, a screenshot, and the commands to rerun and inspect it.

```text
  ✗ examples/task.retest.ts › saves a task  5.2s

    Check failed     toHaveText
    Locator          getByTestId('saved-task')
    - Expected       "Release checklist"
    + Received       "Release checklis"
    Compared         whole text, ends trimmed, each run of spaces or line breaks read as one space
    Waited           5s for toHaveText, looked 14 times, limit 5s

    examples/task.retest.ts:7:48
      6 │   await page.getByTestId('save-task').click()
    › 7 │   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')

    Screenshot       .retest/runs/…/artifacts/…-failure.png
    Inspect          npx retest inspect .retest/runs/… --test "examples/task.retest.ts > saves a task"

  Tests   1 failed
  Exit    1
```

## Give your coding agent the same facts

When Claude Code, Codex or another agent runs Retest, the output gets short on its own, and ends with the next command to run.

```text
retest: 1 failed (1) in 6.4s, exit 1
fail examples/task.retest.ts:7 saves a task
  check_failed toHaveText getByTestId('saved-task')
  expected "Release checklist" received "Release checklis" waited 5004ms
  screenshot .retest/runs/…/artifacts/…-failure.png
next: npx retest inspect .retest/runs/… --test "examples/task.retest.ts > saves a task" --json
```

Every run also writes versioned events, one JSON object per line, with a published JSON Schema. Here is one, shortened:

```json
{"schemaVersion":1,"type":"assertion.failed","matcher":"toHaveText","locator":{"by":"testId","value":"saved-task"},"expected":{"text":"Release checklist"},"actual":{"text":"Release checklis"},"attempts":14,"timeoutMs":5000}
```

`retest inspect` reads a run folder without running anything again. A run that was cut off can never read as a pass.

## What makes it different

- **It says what happened, not what it hopes happened.** A test with no assertions fails. A forgotten `await` fails and names both lines. If the browser dies after a click was sent, the result is "outcome unknown", never a guess.
- **Real input.** Clicks go through the mouse at the element's centre, after checking it is visible, still, enabled and not covered. A covered button is refused. Nothing is force-clicked, and no value is set from script.
- **Checks look again. Actions never repeat.** An assertion keeps reading the page until its deadline. A click is sent once.
- **Made for agents from the start.** Finite commands, stable test ids, exit codes that mean something (`0`, `1`, `2`, `130`, `143`), and output an agent can act on.
- **Nothing hidden.** No account, no download, no telemetry. You choose the browser binary. Screenshots stay on your machine.
- **Zero runtime dependencies.** Node 24.12 or later, and a Chrome or Chromium you already have.

## Where it is going

| | Status |
| --- | --- |
| Chromium, test ids, real input, JSONL events, `inspect`, `list` | works today |
| A config file with named apps, several browsers per run, role, label and text locators, secrets that never reach the test process, sign-in reuse, `init` and `doctor` | landing now |
| Types that catch a wrong app, tag, secret or test id before a browser opens | landing now |
| Firefox | planned |
| Android, iOS, macOS and Electron apps | planned |
| One test that starts on a phone, checks the web and finishes on desktop | planned |
| AI checks for answers that change every time, and evals over datasets | planned |

The last rows are the point of the project. This is the kind of test Retest is being built to run:

```ts
// Planned. Not built yet.
test('a task made on the phone shows up everywhere',
  { apps: ['android', 'web', 'desktop'] },
  async ({ android, web, desktop }) => {
    await android.getByTestId('new-task').tap()
    await android.getByLabel('Title').fill('Release checklist')
    await android.getByRole('button', { name: 'Save' }).tap()

    await web.goto('/tasks')
    await web.getByRole('checkbox', { name: 'Completed' }).check()

    await expect(desktop.getByTestId('task-status')).toHaveText('Completed')
  })
```

## Try it from source

Retest is not on npm yet. You need Node 24.12 or later and an installed Chrome or Chromium.

```sh
git clone https://github.com/rehearsal-labs/retest
cd retest
npm install
npm run build

# In one terminal: a small app to test. It prints its address.
node fixtures/task-app/cli.ts --mode ok

# In another: run the example against that address.
node dist/cli/main.js run examples/task.retest.ts \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --base-url http://127.0.0.1:<port>
```

Start the app with `--mode broken` to watch the same test fail.

## Read more

- [Architecture](docs/architecture.md)
- [Developer experience plan](docs/plans/developer-experience/design.md)
- [Usage guide](docs/guide.md)
- [Milestone 1 handoff](docs/implementation-handoff.md), with every check and its evidence
- [Contribution rules](AGENTS.md)

## From the team behind Rehearsal

Retest is built by [Rehearsal](https://rehearsal.dev), where an agent writes your tests, keeps them working and reports on every pull request. You never need Rehearsal to use Retest.

## License

[Apache-2.0](LICENSE)
