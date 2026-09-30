# Retest developer experience: design for review

30 September 2026, second version, after the independent review in [review.md](review.md). The founder settled the seven open questions the same day; they are at the end. Nothing here exists as code yet. Every API, command and output is what we intend to build. Output samples are illustrative: timings, versions and prices are made up.

Research behind it:

- [Test runners](research/test-runners.md): Vitest 5.0.2, Playwright 1.63.0, Jest 30.5.2, Bun 1.4.2 and Node's runner
- [Browsers and devices](research/browsers-and-devices.md): Playwright, WebdriverIO, Appium, Maestro, Detox and the mobile browser drivers
- [AI evals](research/ai-evals.md): promptfoo, DeepEval, Inspect, Braintrust, autoevals, evalite, vitest-evals, LangSmith, Langfuse, Phoenix, Opik, Midscene, Stagehand and others
- [TypeScript](research/typescript.md): the type design, prototyped on TypeScript 6.0.3

Each section is labelled with the milestone that brings it:

- **M1** is the brief in `docs/implementation-brief.md`: runner, Chromium, `getByTestId`, JSONL and `inspect`.
- **M2** adds role and label locators, named apps, secrets, hooks, sign-in reuse and the matrix.
- **Later** is everything after that.

Platform prerequisites below come from vendor documentation and the browser research. None has been exercised yet.

## Decisions

Numbered so build sessions can cite them. None is approved yet.

### Setup and config

1. **One package, one command.** The package is `@rehearsal-labs/retest` and the command is `retest`. Subpaths exist only when they have code: `/scorers`, `/judges` and `/protocol`.
2. **Setup takes two commands.** Run `npm i -D @rehearsal-labs/retest typescript @types/node`, then `npx retest init`. `init` and `doctor` arrive in M2. Milestone 1 is configured with flags, as in the brief.
   - Retest collects only files ending in `.retest.ts`, setup tests included, so it never picks up unit tests.
   - Retest supports TypeScript 6.0 and later, and its types are tested on 6 and 7.
   - `init` asks questions only on an interactive terminal with no coding agent detected.
   - Every answer also has a flag, and running `init` twice changes nothing.
   - `init --ci github` also writes a GitHub Actions workflow.
3. **Missing targets are caught before any test.** `retest doctor` checks every target and app address, and names the fix for anything missing. `retest run` does the same checks first and stops before any test if a target it needs is missing.
4. **The config has one map, `apps`.**
   - An app is `app({ baseUrl, start, targets })`, where `targets` is a map of names to targets.
   - An app with one target can be written as that target, carrying the app's settings: `web: chromium({ baseUrl })`.
   - Settings such as `baseUrl` and `start` belong to the app, never to a target inside a map.
5. **Each product has its own target constructor.**
   - Web: `chromium()`, `chrome()`, `edge()`, `firefox()`, `webkit()`, `safari()`.
   - Android: `android.chrome()`, `android.firefox()`, `android.app()`.
   - iOS: `ios.safari()`, `ios.app()`.
   - Desktop: `macos.app()` and `electron()`. Electron sits at the top level because it runs on macOS, Windows and Linux.
   - HTTP: `http()`.

   Devices use the platforms' own words: `avd` and `serial` on Android, `simulator` and `udid` on iOS.
6. **Emulation is always labelled.** Emulation is an option on a desktop target only, `chromium({ emulate: 'Pixel 9' })`, and every report prints it as emulated. Nothing calls desktop WebKit "Safari", an emulated phone a phone, or a simulator a device.
7. **`start` runs your app server.** `start: { command, ready }` starts it and waits until `ready` answers. If something already answers at `ready`, Retest uses it and leaves it running.
8. **Types are registered once.** The config registers them through `interface Register` in `retest.config.ts`, and `init` writes that block.
   - A test that declares no apps needs no registration and gets `page`, which is milestone 1's shape.
   - `page` is the app named by `defaultApp`. That defaults to the config's only web app; a config with several web apps must name one.
   - Declaring apps without a registered config is a compile error whose message explains how to register.
9. **Test ids can be checked by the type check.** This is opt-in: pass `testIds` to the config, for example a constant your app exports, and `getByTestId` accepts only those ids. Without it, ids are plain strings.

### Writing tests

10. **`test` has one signature:** `test(name, options?, fn)`. `apps`, `tags`, `state` and `timeout` are all optional in `options`. A single signature gives one clear error instead of TypeScript's "No overload matches" list.
11. **A test declares the apps it uses in `apps`.**
    - Destructuring an app the test did not declare is a compile error.
    - The runner takes all of a test's apps at once, or waits and takes none.
    - Leases are taken in one global order, with a timeout, so two tests can't deadlock.
12. **An app's handle has only the methods all its targets support.**
    - `click` works on every web target. On a touch target it is sent as a touch tap and recorded as such.
    - `tap` exists only when every target in the app has touch.
    - Native app handles have `tap`, and `click` on them is a compile error that says to use `tap`.
13. **There is one `expect`, and what you pass decides its matchers.**
    - A value gets immediate matchers.
    - A locator gets awaited matchers that retry by looking again.
    - Passing a promise, an `any` or a `Secret` is a compile error. For `any`, the message says to give the value a type, such as `expect<number>(count)`. There is no unchecked escape.
    - `toBe` requires the same type as the value.
    - Matchers that take a list, such as `toHaveCount` and `toHaveText([...])`, read every match. Actions need exactly one match.
14. **Some familiar APIs are kept and some are left out on purpose.**
    - Kept: `expect.poll(fn, { timeout })` and `expect.soft`.
    - Left out: `waitForTimeout`, `force`, `networkidle`, element handles, and `first()` or `nth()` as a way out of an ambiguous match. Other tools add lint rules later to ban these.
    - Also left out: `toPass`, because it repeats actions.
15. **Steps, hooks and fixtures.**
    - `test.step(name, fn)` returns the callback's value, and every step is an event.
    - `test.describe`, `test.beforeEach` and `test.afterEach` exist in M2.
    - `test.for(rows)` gives each row a stable id taken from its content.
    - Custom fixtures come later, in Vitest's builder shape: `test.extend('account', async (context, { onCleanup }) => account)`.
16. **Sign in once and reuse it.**
    - `test.setup('signed-in', fn)` runs once per target in each run. When it passes, it saves the browser's cookies and storage.
    - A test with `state: 'signed-in'` starts from a copy of that saved state. Without `state`, every test starts signed out.
    - Saved states stay in the run folder and never enter a report.
17. **Retest sends one command at a time to each app.**
    - A second command sent while the first is still running fails at once. The error names both lines and covers both causes: a missing `await`, or two commands sent together, for example through `Promise.all`.
    - Waits that listen for an event, such as a download or a new tab, may overlap one action.
    - Assertions start only when awaited.
    - Work still pending when the test returns fails the test, and so does a test with no assertion.
    - `test()` returns `void`, so the `no-floating-promises` lint rule works as well.
18. **Default timeouts:**
    - action: 10 s
    - navigation: 30 s
    - assertion: 5 s
    - test: 60 s
    - setup: 60 s
    - cleanup: 10 s

    A failure always prints the timeout it hit, and `timeout` in `options` changes it for one test.

### Running and reading results

19. **A failure prints as one card.** The card holds:
    - the failure class
    - the locator, with its matches or the nearby accessibility tree
    - expected and received values, with a diff and the exact comparison rule
    - what the runner waited for, and how long
    - a code frame at the test's own line
    - the screenshot path
    - a rerun command for that test and target, and an `inspect` command
20. **Output is short when a coding agent runs Retest.** It prints failures, the summary and a `next:` line.
    - Agents are detected from a built-in list of environment variables, including `CLAUDECODE`, `CODEX_THREAD_ID`, `AGENT` and `AI_AGENT`.
    - `--agent` and `--no-agent` override detection, and choosing your own reporters does not turn it off.
    - Retest never opens a browser tab, a report server or watch mode on its own.
21. **Exit codes:**

    | Code | When |
    | --- | --- |
    | 0 | Everything passed. Inconclusive verdicts inside an eval, within its limit, don't change this. |
    | 1 | A test or an eval failed. |
    | 2 | Setup, collection, infrastructure or reporting failed; a test's judge could not decide; or an eval went over its inconclusive limit or its budget. |
    | 130 | Interrupted. |

    When both 1 and 2 apply, the order is:
    - 130 comes first.
    - Then 2, when nothing trustworthy came out: a usage error, a collection or setup failure before any test ran, or results that could not be written.
    - Then 1, once tests ran and at least one failed its checks, even if other tests hit infrastructure problems. A confirmed failure stays true whatever else happened, and a retry would bury it. The summary and the JSON result still mark the run incomplete and list the tests that couldn't run.
22. **Choosing which tests run.**
    - Each test has a stable id: its file and name, plus the target when the app has several.
    - You can select by `file:line`, `--grep`, a tag expression such as `--tag "smoke and not slow"`, `--last-failed`, or `--target web=firefox`.
    - Test ids in commands use plain ASCII: `"tests/tasks.retest.ts > saves a task"`.
    - `--headed` shows the browser.
23. **Parallel runs.**
    - M1 runs files one at a time.
    - Later, `--workers` sets how many files run at once. The default is half the CPU cores, and leases limit it further: one Safari per Mac, one device per test.
    - `lock: 'name'` in a test's options keeps tests that share outside state, such as one staging account, from running together.
24. **Retries.**
    - There are no retries by default.
    - Later, retries cover only our own failures, such as a lost browser or device, and each retry gets a new attempt id.
    - A test that passes on retry is reported as flaky. `--repeat-each` and `--fail-on-flaky` measure flakiness.
25. **`inspect` keeps no session open.** Every call takes the run folder. Large trees go to a file, and the command prints the path.
26. **Where runs are stored.**
    - Runs go to `.retest/runs/<timestamp>/`, and paths inside a run are relative to its folder.
    - A run never overwrites another, and a run cut off halfway is still readable.
    - In M1 the run folder and `inspect` are the report. Later, `retest report <run>` writes one HTML file into the run folder and prints its path.
27. **Three checks, none of which opens a browser:**
    - `tsc --noEmit -p tsconfig.retest.json`
    - `retest list`, which collects tests and datasets
    - `retest run --dry-run`, which also checks targets
28. **`init` writes a tsconfig.** It sets `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `noUncheckedIndexedAccess`, `module: nodenext` and `types: ["node"]`. With these, `tsc` rejects the syntax Node's type stripping can't run.
29. **Retest tests its own types with compile-fail fixtures.**
    - They run through the `tsc` command line and read its `file(line,col): error TSnnnn` output, because TypeScript 7 has no stable compiler API yet.
    - Each expected error is marked on its line with `// type-error TSnnnn fragment`. Every error must match a marker, and every marker must be used.
    - They run on TypeScript 6 and 7.
    - They cover `test.eval` written with `scores` above `run` (decision 36).
30. **Secrets.**
    - Secrets are declared in the config and read with `secret('name')`.
    - The value is an object whose `toString`, `toJSON` and inspection all give `{{name}}`.
    - `fill` accepts it, and events record the placeholder.
    - Screenshots are not redacted: a secret typed into a visible field can appear in `failure.png`.

### AI checks and evals

31. **`toMeet(criteria)` judges one answer.**
    - It waits for the answer to finish, captures it once, and judges it once.
    - A positive criterion that is met, and any criterion that is not met, needs a quote found word for word in the answer.
    - A criterion written as `{ absent: '...' }` passes when the judge finds no matching text.
    - The outcome is passed, failed or inconclusive.
32. **The judge treats the answer as data.**
    - The answer goes to the judge between clear delimiters, with an instruction that it may contain text trying to steer the judge.
    - Secrets are removed from the answer before it leaves the machine.
    - The judge's raw reply is kept in the run folder.
33. **Judges are providers.**
    - `anthropic()`, `openai()` and `openaiCompatible()` call the model with plain `fetch`, or you pass any function.
    - Every verdict records the model, prompt version, latency and cost.
    - Costs come from a dated price table shipped with Retest, and the report prints its date.
    - `--judge-cache` reuses verdicts on your machine only. The cache key is the answer, criteria, model, prompt version and sampling settings.
    - Inconclusive verdicts are never cached. The summary prints how many verdicts were reused, and the cache is off whenever `CI` is set.
34. **`test.eval(name, options)` measures a feature over a dataset.**
    - Rows are `{ id, input, expected, metadata }`, typed by any Standard Schema.
    - Cases are paired by `id`, or by a hash of `input` when there is none.
    - `run` receives `input` and `metadata`, never `expected`.
    - `trials` runs each case several times, and `concurrency` sets how many run at once.
    - `scores` names each score and `gates` sets its threshold.
    - `critical` picks cases that must pass every score in every trial.
    - `budget` caps judge spending.
35. **Scores accept the shapes other tools return.**
    - A score function takes `{ input, output, expected, metadata }` and returns a `boolean`, a `number`, or one of these common shapes, normalised by their keys:
      - autoevals `{ name, score }`
      - promptfoo `{ pass, score, reason }`
      - Langfuse and Opik `{ name, value, comment }`
      - LangSmith `{ key, score, comment }`
      - Phoenix `{ label, score, explanation }`
    - `score: null` means "not applicable". It is left out, and is not counted as inconclusive.
    - `meets({ answer, criteria })` is the judged score, with the same rules as `toMeet`.
    - autoevals scorers such as `Factuality` call their own model with their own key. That call falls outside Retest's budget, cache and cost lines.
36. **TypeScript infers `test.eval` from top to bottom.** Write `run` above `scores`, or annotate `run`'s parameters. Otherwise the output type becomes `RetestTypeError<'Write run above scores, or annotate the parameters of run'>`. `gates` keys use `NoInfer`, so a typo there suggests the score's name.
37. **Eval statistics.**
    - With trials, each case scores the mean of its trials, and the overall rate is the mean over cases, so every case counts once.
    - Intervals are 95%: Wilson for a rate with one trial per case, and a case-level bootstrap for means.
    - The report shows consistency (cases that changed answer between trials) and the all-trials rate (cases right in every trial).
    - Comparison with a baseline pairs the same cases: McNemar's exact test for pass/fail, and a paired bootstrap for means. "Worse" means a case's mean fell.
38. **Gates.**
    - `gates: { label: 0.9 }` checks the measured value. When the interval crosses the gate, the report says so and estimates how many cases would settle it.
    - `gates: { label: { lowerBound: 0.9 } }` passes only when the whole interval clears the gate. It fails when the whole interval is below, and is inconclusive otherwise.
    - The default is the measured value. Release checks on the metrics that matter most should write `lowerBound` explicitly.
39. **Inconclusive verdicts and budgets.**
    - Inconclusive verdicts within an eval's limit (1% by default) are left out of the rate and counted in the report. Over the limit, the eval ends "could not decide". In a regular test, one inconclusive `toMeet` is enough to stop it passing.
    - A provider error on a judge call is retried twice. That resends a request that got no answer; it never asks again after a "no". A malformed verdict, or a quote not found in the answer, stays inconclusive with no second try.
    - When the budget runs out, judging stops, the remaining verdicts are inconclusive, and the eval ends "could not decide". The partial record stays readable.
    - Calls already in flight can overshoot the budget by up to `concurrency` times the largest call.
40. **Baselines.** `retest run --save-baseline main` writes `.retest/baselines/main/<eval>.jsonl`, and `baseline: 'main'` reads it. In CI, restore that folder from the main branch's artifact.
41. **Works with the tools teams already have.**
    - autoevals scorers work directly.
    - promptfoo's deterministic assertion objects work through `fromPromptfoo([...])`, including the `not-` prefix.
    - Zod, Valibot and ArkType schemas work through Standard Schema.
    - Datasets can be JSONL, JSON or CSV. Common field aliases are mapped: `expected_output`, `expectedOutput`, `target`, `reference`, and OpenAI's `{ item }` wrapper.
    - Reporters write JSONL events, JUnit, and OpenTelemetry `gen_ai.evaluation.result`. In JUnit, an inconclusive result becomes skipped, with the reason.
    - The OpenTelemetry convention is still at Development status, so the report records the version it used.

42. **`retest install`, later and only when asked.**
    - `retest install chromium` fetches a pinned Chrome for Testing build, and `retest install firefox` fetches from Mozilla's releases.
    - Every run records the browser version and file hash.
    - `run` never downloads anything, and `doctor` suggests the command when a browser is missing.
    - Milestone 1 downloads nothing.

### Later, one line each

`-x` stops after the first failure. `--test-list <file>` runs a saved list. `retest config --json` prints the resolved config. `test.step` takes `box` and `params`. `test.info().annotate()` and `attach()` feed every reporter. A promptfoo YAML importer helps teams leaving OpenAI's hosted Evals, which shuts down on 30 November 2026.

## 1. Set up (M1 install, M2 `init`, `doctor` and CI)

```sh
npm i -D @rehearsal-labs/retest typescript @types/node
npx retest init
```

With pnpm, yarn or bun, use `pnpm add -D`, `yarn add -D` or `bun add -d`, then `pnpm exec retest init`, `yarn retest init` or `bunx retest init`.

```text
$ npx retest init

  Retest 0.1.0

  What should the tests open?   › http://localhost:3000
  How do you start the app?     › npm run dev
  Which browser?                › Chromium (found Google Chrome 153 on this Mac)

  created  retest.config.ts
  created  tests/example.retest.ts
  created  tsconfig.retest.json
  updated  package.json   scripts: "test:e2e", "typecheck:e2e"
  updated  .gitignore     .retest/

  Next
    npx retest doctor        check the browser and the app
    npx retest run           run tests/example.retest.ts
```

For a coding agent or CI: `npx retest init --app web=http://localhost:3000 --start "npm run dev" --browser chromium --yes`.

```text
$ npx retest doctor

  web      chromium()               ✓ Google Chrome 153.0.7195.41   /Applications/Google Chrome.app
           npm run dev              ✓ started, http://localhost:3000 answered 200 after 2.1s

  Ready. 1 app, 1 target.
```

CI, written by `npx retest init --ci github`:

```yaml
# .github/workflows/retest.yml
name: Retest
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - run: npm run typecheck:e2e
      - run: npx retest run --reporter github --reporter junit=.retest/junit.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: retest-runs, path: .retest/runs }
```

## 2. The config (M2)

```ts
// retest.config.ts
import { defineConfig, chromium, env } from '@rehearsal-labs/retest'
import { testIds } from './src/test-ids.ts'

const config = defineConfig({
  apps: {
    web: chromium({
      baseUrl: 'http://localhost:3000',
      start: { command: 'npm run dev', ready: 'http://localhost:3000' },
    }),
  },
  secrets: { password: env('TEST_PASSWORD') },
  testIds,                  // optional: your app's own list of test ids
  tags: ['smoke', 'slow'],
})

export default config

// Lets every test file see your app names, secrets, test ids and tags.
declare module '@rehearsal-labs/retest' {
  interface Register { config: typeof config }
}
```

## 3. A regular test (M1 for the first, M2 for the second)

```ts
// tests/tasks.retest.ts
import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('shows the count', { tags: ['smoke'] }, async ({ page }) => {
  await page.goto('/')
  const added = await test.step('Add two tasks', async () => {
    for (const title of ['One', 'Two']) {
      await page.getByLabel('Title').fill(title)
      await page.getByRole('button', { name: 'Save' }).click()
    }
    return 2
  })
  await expect(page.getByRole('listitem')).toHaveCount(added)
})
```

```text
$ npx retest run

  RETEST 0.1.0   web: Chromium 153 · macOS 27

  ✓ tests/tasks.retest.ts  2 tests  1.9s
      ✓ saves a task         812 ms
      ✓ shows the count      904 ms

  Tests   2 passed
  Checks  2 passed
  Time    1.9s   browser start 0.4s · tests 1.5s
```

A failure:

```text
  ✗ tests/tasks.retest.ts › saves a task   5.6s

    Check failed   toHaveText
    Locator        getByTestId('saved-task')
    - Expected     "Release checklist"
    + Received     "Saving…"
    Compared       whole text, ends trimmed, each run of spaces or line breaks read as one space
    Waited         5s, looked 14 times. The text last changed at 0.4s.

       6 │   await page.getByTestId('save-task').click()
    ›  7 │   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')

    Screenshot     .retest/runs/2026-09-30T14-02-11/saves-a-task/failure.png
    Rerun          npx retest run tests/tasks.retest.ts:7
    Inspect        npx retest inspect .retest/runs/2026-09-30T14-02-11 --test "tests/tasks.retest.ts > saves a task"

  Tests   1 failed · 1 passed
  Exit    1
```

Two commands at once:

```text
  ✗ tests/tasks.retest.ts › saves a task

    Two commands at once   page, lines 6 and 7
    Line 6 was still running when line 7 sent the next command to page.
    Retest sends one command at a time to each app. Add await on line 6.
```

What a coding agent sees:

```text
retest: 1 failed, 1 passed (2) in 6.1s, exit 1
FAIL tests/tasks.retest.ts:7 saves a task
  check_failed toHaveText getByTestId('saved-task')
  expected "Release checklist" received "Saving…" waited 5000ms
  screenshot .retest/runs/2026-09-30T14-02-11/saves-a-task/failure.png
next: npx retest inspect .retest/runs/2026-09-30T14-02-11 --test "tests/tasks.retest.ts > saves a task" --json
```

## 4. Hooks, data and signing in once (M2)

```ts
// tests/sign-in.retest.ts
test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('qa@tasks.example')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
})
```

```ts
// tests/archive.retest.ts
test.describe('archive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks')
  })

  test('archives a task', { state: 'signed-in' }, async ({ page }) => {
    await page.getByRole('button', { name: 'Archive Release checklist' }).click()
    await expect(page.getByRole('status')).toHaveText('Archived')
  })

  test.for([
    { title: 'Release checklist' },
    { title: 'Ünïcode and emoji ✓' },
  ])('archives "$title"', { state: 'signed-in' }, async ({ page }, { title }) => {
    await page.getByRole('button', { name: `Archive ${title}` }).click()
    await expect(page.getByRole('status')).toHaveText('Archived')
  })
})
```

## 5. What the type check catches (M2)

```ts
test('task syncs', { apps: ['phone', 'web'] }, async ({ phone, web, desktop }) => {
  await phone.getByTestId('save-task').click()
  await web.getByTestId('sav-task').click()
  await web.getByRole('buton', { name: 'Save' }).click()
  await web.getByLabel('Password').fill(secret('pasword'))
  await expect(web.getByTestId('task-count')).toBe(3)
})
```

Here `phone` is a native Android app.

```text
$ npx tsc --noEmit -p tsconfig.retest.json

tests/sync.retest.ts(1,79): error TS2339: Property 'desktop' does not exist on type 'Apps<"phone" | "web">'.
tests/sync.retest.ts(2,41): error TS2349: This expression is not callable. Type 'RetestTypeError<"Phones use tap(), not click()">' has no call signatures.
tests/sync.retest.ts(3,28): error TS2345: Argument of type '"sav-task"' is not assignable to parameter of type '"new-task" | "task-title" | "save-task" | "task-count"'.
tests/sync.retest.ts(4,26): error TS2345: Argument of type '"buton"' is not assignable to parameter of type 'AriaRole'.
tests/sync.retest.ts(5,48): error TS2345: Argument of type '"pasword"' is not assignable to parameter of type '"password"'.
tests/sync.retest.ts(6,48): error TS2349: This expression is not callable. Type 'RetestTypeError<"toBe is for values. Use toHaveText on a locator">' has no call signatures.
```

`retest list` then catches what types can't see:

```text
$ npx retest list

  ✗ tests/sync.retest.ts:14      two tests are named "task syncs"
  ✗ tests/archive.retest.ts:9    state "signed-in" has no setup test in this run
  ✗ evals/tickets.jsonl:57       "refund" is not one of billing, bug, feature, spam

  14 tests and 1 eval in 6 files, 3 problems. Nothing ran.
```

## 6. Every browser and engine (M1 Chromium, later the rest)

```ts
import { defineConfig, app, chromium, chrome, edge, firefox, webkit, safari } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    web: app({
      baseUrl: 'http://localhost:3000',
      targets: {
        chromium: chromium(),              // open-source Chromium, or Chrome for Testing
        beta: chrome({ channel: 'beta' }), // branded Chrome: stable, beta, dev, canary
        edge: edge(),
        firefox: firefox(),                // stock Firefox over WebDriver BiDi
        webkit: webkit(),                  // the WebKit engine on Linux, not Safari
        safari: safari(),                  // real Safari: macOS only, one session per Mac
      },
    }),
  },
})
```

Every test that uses `web` runs once per target, and `--target web=firefox` picks one. A test that declares two apps, each with several targets, runs only the combinations listed in `runs`, never every pairing:

```ts
runs: [
  { web: 'chromium', mobileWeb: 'pixel' },
  { web: 'safari', mobileWeb: 'iphone' },
],
```

| Target | What it is | Needs |
| --- | --- | --- |
| `chromium()` | Real Blink, unbranded | Any OS; a Chromium or Chrome for Testing binary |
| `chrome({ channel })` | Real Chrome | Chrome installed; pin the version for repeatable runs |
| `edge()` | Real Edge | Edge installed |
| `firefox()` | Real Gecko, stock build | Firefox installed; WebDriver BiDi |
| `webkit()` | Real WebKit engine, not Safari | Linux with WebKitGTK or WPE WebDriver. No macOS route found yet |
| `safari()` | Real Safari | macOS; `safaridriver --enable` once; no headless; one session per Mac |

```text
$ npx retest run tests/checkout.retest.ts

  web=chromium   Chromium 153 · macOS 27        ✓ 4 passed    3.1s
  web=beta       Chrome Beta 154 · macOS 27     ✓ 4 passed    3.3s
  web=edge       Edge 153 · macOS 27            ✓ 4 passed    3.4s
  web=firefox    Firefox 156 · macOS 27         ✗ 1 failed · 3 passed   4.0s
  web=webkit     WebKit 2.52 · Linux (docker)   ✓ 4 passed    3.8s
  web=safari     Safari 27.0 · macOS 27         ✓ 4 passed    5.2s   ran alone: one Safari session per Mac

  Tests   1 failed · 23 passed across 6 targets
  Rerun   npx retest run tests/checkout.retest.ts:18 --target web=firefox
  Exit    1
```

## 7. Mobile browsers (later)

```ts
export default defineConfig({
  apps: {
    mobileWeb: app({
      baseUrl: 'https://staging.tasks.example',
      targets: {
        pixel: chromium({ emulate: 'Pixel 9' }),                              // emulated
        android: android.chrome({ avd: 'Pixel_9_API_36' }),                  // Chrome on an Android emulator
        galaxy: android.chrome({ serial: 'R58M123ABC' }),                    // Chrome on a USB phone
        firefox: android.firefox({ avd: 'Pixel_9_API_36' }),                 // Firefox for Android
        iphone: ios.safari({ simulator: 'iPhone 17', runtime: 'iOS 27.0' }), // Mobile Safari on the simulator
      },
    }),
  },
})
```

```ts
test('menu opens with a tap', { apps: ['mobileWeb'] }, async ({ mobileWeb }) => {
  await mobileWeb.goto('/')
  await mobileWeb.getByRole('button', { name: 'Menu' }).tap()
  await expect(mobileWeb.getByRole('navigation')).toBeVisible()
})
```

Every target in `mobileWeb` has touch, so `tap` exists. `click` works too, which lets `web` and `mobileWeb` share tests and helpers.

| Target | What it is | Needs |
| --- | --- | --- |
| `chromium({ emulate })` | Emulated: desktop Chromium with a phone's screen, user agent and touch | Any OS |
| `android.chrome()` | Real Chrome on Android | Android SDK; an emulator with hardware virtualisation (not inside another VM) or a USB phone with debugging on. On an unrooted device, Chrome's "command line on non-rooted devices" flag. A clean browser profile per test is not verified yet |
| `android.firefox()` | Real Firefox for Android | As above, Firefox on the device, and geckodriver. Versions 153 and later need extra launch settings. BiDi coverage on Android is not verified yet |
| `ios.safari()` | Real Mobile Safari on a simulated iPhone | macOS with Xcode and an iOS runtime. One session at a time; several simulators at once is not verified yet |
| `ios.safari({ udid })` | Real Mobile Safari on an iPhone | A Mac, a trusted cable, Remote Automation turned on |

```text
  mobileWeb=pixel     Chromium 153 as Pixel 9 · emulated              ✓ 6 passed
  mobileWeb=android   Chrome 153 · Pixel 9 emulator · Android 16      ✓ 6 passed
  mobileWeb=galaxy    Chrome 153 · Galaxy S24 · Android 16 (USB)      ✓ 6 passed
  mobileWeb=firefox   Firefox 156 · Pixel 9 emulator · Android 16     ✓ 6 passed
  mobileWeb=iphone    Mobile Safari · iPhone 17 simulator · iOS 27.0  ✗ 1 failed · 5 passed
```

## 8. Native and desktop apps (later)

```ts
export default defineConfig({
  apps: {
    android: android.app({
      apk: './android/app/build/outputs/apk/debug/app-debug.apk',
      avd: 'Pixel_9_API_36',
    }),
    iphone: ios.app({
      app: './ios/build/Debug-iphonesimulator/Tasks.app',
      simulator: 'iPhone 17',
      permissions: { location: 'allow', photos: 'deny' },
    }),
    mac: macos.app({ app: './build/Tasks.app' }),
    desktop: electron({ app: './dist/mac-arm64/Tasks.app' }),
  },
})
```

```ts
test('adds a task on Android', { apps: ['android'] }, async ({ android }) => {
  await android.getByTestId('new-task').tap()
  await android.getByLabel('Title').fill('Release checklist')
  await android.getByRole('button', { name: 'Save' }).tap()
  await expect(android.getByText('Release checklist')).toBeVisible()

  await android.back()
  await expect(android.getByTestId('task-list')).toBeVisible()
})
```

`getByTestId` reads each platform's own id: `data-testid` on the web, the resource id or Compose test tag on Android, and `accessibilityIdentifier` on iOS and macOS.

| Target | Starts clean with | Needs |
| --- | --- | --- |
| `android.app()` | Cleared app data | Android SDK; an emulator or USB phone. Retest installs its helper app on the device |
| `ios.app()` | A fresh install on the simulator | macOS and Xcode. A real iPhone also needs signing, Developer Mode and UI Automation turned on. Which permissions can be preset is not verified yet |
| `macos.app()` | A relaunch | Xcode and Accessibility permission for the runner. Granting it needs a signed-in session, which most CI machines don't have. Clean data per test for sandboxed apps is not verified yet |
| `electron()` | A new user data folder | A build that allows a DevTools port; hardened builds may block it |

## 9. One test across apps (later)

```ts
test('a task made on the phone shows up everywhere',
  { apps: ['android', 'web', 'desktop'] },
  async ({ android, web, desktop }) => {
    const title = `Checklist ${test.info().attemptId}`

    await test.step('Create it on the phone', async () => {
      await android.getByTestId('new-task').tap()
      await android.getByLabel('Title').fill(title)
      await android.getByRole('button', { name: 'Save' }).tap()
    })

    await test.step('Complete it on the web', async () => {
      await web.goto('/tasks')
      await web.getByRole('link', { name: title }).click()
      await web.getByRole('checkbox', { name: 'Completed' }).check()
    })

    await test.step('See it completed on desktop and on the phone', async () => {
      await expect(desktop.getByTestId('task-status')).toHaveText('Completed', { timeout: 30_000 })
      await expect(android.getByTestId('task-status')).toHaveText('Completed', { timeout: 30_000 })
    })
  })
```

```text
  ✓ a task made on the phone shows up everywhere   14.2s

    android   Pixel 9 emulator · Android 16
    web       Chromium 153 · macOS 27
    desktop   Tasks 2.4.0 · Electron 38 · macOS 27

    0.0s   android   tap new-task · fill Title · tap Save
    3.1s   web       goto /tasks · click "Checklist a81f" · check Completed
    6.8s   desktop   toHaveText "Completed"   arrived after 2.3s
    9.2s   android   toHaveText "Completed"   arrived after 4.9s
```

## 10. AI checks inside a test (later)

```ts
test('support bot explains the return window', async ({ page }) => {
  await page.goto('/support')
  await page.getByLabel('Message').fill('Can I return shoes after 40 days?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden()

  await expect(page.getByTestId('latest-answer')).toMeet([
    'Says returns are accepted for 30 days',
    { absent: 'A promise of an exception' },
  ])
})
```

```ts
import { anthropic } from '@rehearsal-labs/retest/judges'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://localhost:3000' }) },
  judge: anthropic({ model: 'claude-sonnet-5', apiKey: env('ANTHROPIC_API_KEY') }),
})
```

```text
  ✓ support bot explains the return window   6.8s
      toMeet   2 of 2 met · judged once by claude-sonnet-5 · 2.7s · $0.011
        ✓ Says returns are accepted for 30 days
            "You can return shoes within 30 days of delivery."
        ✓ No promise of an exception
            no matching text in the answer

  ✗ support bot explains the return window   7.1s
      toMeet   1 of 2 met
        ✓ Says returns are accepted for 30 days
            "Returns are accepted for 30 days."
        ✗ No promise of an exception
            "but I've approved an exception for your order."

  ? support bot explains the return window   6.9s
      toMeet   inconclusive: the judge quoted text that is not in the answer
      Not passed. Exit 2. The answer and the judge's reply are in the run folder.
```

## 11. Evals (later)

```ts
// evals/labeler.retest.ts
import { test, dataset } from '@rehearsal-labs/retest'
import { meets } from '@rehearsal-labs/retest/scorers'
import { z } from 'zod'

const Ticket = z.object({
  id: z.string(),
  input: z.string(),
  expected: z.enum(['billing', 'bug', 'feature', 'spam']),
  metadata: z.object({ critical: z.boolean().default(false) }).default({}),
})

const Labeled = z.object({ label: z.string(), reason: z.string() })

test.eval('ticket labeler', {
  apps: ['api'],
  cases: dataset('./evals/tickets.jsonl', Ticket),
  trials: 3,
  concurrency: 8,

  // run sees the input and metadata, never the expected answer
  async run({ api }, { input }) {
    const response = await api.post('/labels', { json: { text: input } })
    return Labeled.parse(await response.json())
  },

  scores: {
    label: ({ output, expected }) => output.label === expected,
    reason: meets({
      answer: ({ output }) => output.reason,
      criteria: ['Explains the label using facts from the ticket'],
    }),
  },

  gates: { label: 0.9, reason: 0.8 },
  critical: ({ metadata }) => metadata.critical,
  baseline: 'main',
  budget: { usd: 10 },
})
```

`evals/tickets.jsonl`:

```json
{"id": "t001", "input": "I was charged twice this month", "expected": "billing", "metadata": {"critical": true}}
{"id": "t088", "input": "App crashes when I add a sixth label", "expected": "bug"}
{"id": "t141", "input": "Claim your refund now at bit.ly/…", "expected": "spam"}
```

Scorers from other tools:

```ts
import { Factuality } from 'autoevals'
import { fromPromptfoo } from '@rehearsal-labs/retest/scorers'

scores: {
  factual: Factuality,
  ...fromPromptfoo([
    { type: 'is-json' },
    { type: 'not-icontains', value: 'as an AI' },
  ]),
}
```

## 12. An eval run (later)

While it runs:

```text
$ npx retest run evals/labeler.retest.ts

  RETEST 0.1.0   api: http://localhost:3000   judge: claude-sonnet-5   8 at a time

  ticket labeler   ██████████████░░░░░░░░   118 of 200 cases · trial 3 of 3

    label    92.4%   so far, 95% interval 86.2–96.0%   gate 90%
    reason   96.6%   so far                            gate 80%
    judge    354 calls · $3.72 of $10.00 · median 2.8s

    now   t119  "Where do I change my card?"        billing ✓
          t120  "Export to CSV please"              feature ✓
          t121  "It logs me out every 5 minutes"    judging reason…
```

When it ends:

```text
  ticket labeler   200 cases × 3 trials   4m 12s

    label        90.7%   95% interval 85.9–94.0%   gate 90%   ✓ passed
                 The interval reaches below the gate. About 6,600 cases would settle it.
    all trials   88.0%   176 cases right in all 3 trials
    consistent   95.5%   9 cases changed label between trials
    critical     24 of 24 right in every trial                ✓ passed
    reason       97.0%   95% interval 93.6–98.6%   gate 80%   ✓ passed
    inconclusive 1 of 600 verdicts, left out of the rate (limit 1%)

    vs main      28 Sep · 93.0% → 90.7%   6 cases scored lower · 3 higher
                 Difference −2.3 points, 95% interval −5.6 to +1.0. Not a clear change.

    by label      cases   label     95% interval
    billing          61   96.2%     88.1–98.9%
    bug              58   90.8%     80.6–95.9%
    feature          47   86.5%     74.0–93.5%
    spam             34   86.3%     71.1–94.2%

    worst
    ✗ t088   expected bug, got feature in 3 of 3    "App crashes when I add a sixth label"
    ✗ t141   expected spam, got billing in 2 of 3   "Claim your refund now at bit.ly/…"
    ~ t017   changed between trials: billing, billing, bug

  Evals   1 passed
  Judge   600 calls · $6.31 · median 2.9s · prices from 15 Sep 2026
  Record  .retest/runs/2026-09-30T15-40-02/evals/ticket-labeler.jsonl
  Exit    0
```

Inspecting one case:

```text
$ npx retest inspect .retest/runs/2026-09-30T15-40-02 --case t088

  t088   evals/tickets.jsonl:88
  input      App crashes when I add a sixth label
  expected   bug

  trial 1    feature   "Asks for support for more labels"      reason ✓ met
  trial 2    feature   "Wants a higher label limit"            reason ✓ met
  trial 3    feature   "Requests more labels per ticket"       reason ✗ not met
             ✗ Explains the label using facts from the ticket
               "Requests more labels per ticket" leaves out the crash the ticket reports.

  judge      claude-sonnet-5 · prompt v1 · 3 calls · $0.031
```

## Decided on 30 September 2026

1. **File suffix: `.retest.ts`**, setup tests included. One glob finds everything Retest runs, and unit tests never collide.
2. **No escape from strict `expect`.** To escape `any`, give the value a type: `expect<number>(count)`.
3. **Inconclusive limit: 1% in evals, zero in regular tests.** Provider errors on judge calls are retried twice, and malformed verdicts get no second try (decision 39).
4. **Oldest TypeScript: 6.0.** Tested on 6 and 7.
5. **`retest install`: later, only when asked, pinned, with the version and hash recorded** (decision 42).
6. **Mixed failures: 1 wins once tests have run.** 2 is kept for runs where nothing trustworthy came out (decision 21).
7. **Default gate: the measured value,** with `lowerBound` for strict release checks (decision 38).
