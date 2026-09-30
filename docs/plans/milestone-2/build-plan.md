# Milestone 2 build plan

30 September 2026. Every milestone 2 build agent works from this contract. Milestone 1 is complete and staged as the baseline: its contract is `docs/plans/milestone-1/build-plan.md` and its handoff is `docs/implementation-handoff.md`. Everything there still holds unless this file changes it.

The product decisions come from `docs/plans/developer-experience/design.md`. That document's numbered decisions are cited here as [D1] through [D42]. When this file and the design disagree, this file wins for milestone 2. If something here conflicts with the brief or with `AGENTS.md`, stop and report it rather than choosing.

## Scope

Milestone 2 makes Retest usable on a real project that runs on Chromium-family browsers:

1. **A config file.** `retest.config.ts` has named apps, the start command for your app server, secrets, test ids and tags. Its types are registered once, so the type check sees your names [D4, D7, D8, D9].
2. **Several named apps in one test.** Each app is a role, such as `owner` and `member`, with its own browser context and page [D10, D11].
3. **A matrix of Chromium-family targets.** The targets are `chromium()`, `chrome({ channel })` and `edge({ channel })`, plus device emulation labelled as emulated. `runs` lists the combinations explicitly [D4, D5, D6, D12].
4. **More locators.** `getByRole`, `getByLabel` and `getByText` join `getByTestId`, and list-aware matchers come with them [D13].
5. **Structure.** `test.describe`, `test.beforeEach`, `test.afterEach`, `test.for` and `test.setup`, with sign-in state reused through `state` [D15, D16].
6. **Secrets.** Secret values are resolved in the parent process only and never reach the test process, events, logs or results [D30].
7. **Choosing tests.** By tags, `--grep`, `file:line`, `--last-failed` and `--target` [D22].
8. **Setup commands.** `retest init` (with `--ci github`) and `retest doctor` [D2, D3].
9. **More matchers.** `toBeHidden`, `toHaveCount`, `toHaveText([...])`, `toHaveValue`, `toEqual`, `toContain` and `toMatch`, plus `expect.poll` and `expect.soft` [D13, D14].

Out of scope for milestone 2:
- Firefox, WebKit and Safari.
- Real mobile browsers and native apps.
- Parallel workers and `lock`.
- Retries.
- `toMeet`, `test.eval` and judges.
- The agent session API (observe and act by ref).
- Custom fixtures (`test.extend`).
- `retest install`.
- HTML reports.

Never advertise any of these. When a user asks for one, reject it clearly.

## Code quality bar

Unchanged from milestone 1, and it applies to every agent:
- Vite, Vitest and VoidZero style.
- Small modules with named exports.
- Minimal comments: only a reason the code cannot show.
- Don't repeat yourself.
- Keep separation of concerns: `protocol` is pure, `browser` knows nothing of tests, `runner` knows nothing of CDP, and `reporters` only consume events.
- Handle edge cases and test them.
- No `any`, no unchecked `as` casts, no `!`, no `@ts-ignore`, `@ts-expect-error` or `eslint-disable`.
- Explicit export types, because `isolatedDeclarations` is on.
- `kebab-case.ts` file names, and `.ts` extensions in relative imports.
- Shared Node-level helpers go in `src/shared/`.

## Decisions

Numbered M2-1 onwards, so agents can cite them.

### Config

- **M2-1. Where the config comes from.**
  - The parent loads the config from `--config <path>`, or from `retest.config.ts` in the root directory. It imports the file with Node's type stripping, then validates the default export with a schema.
  - The child process never loads the config.
  - A missing file is fine only when `--browser` is given. That is milestone 1's mode, and it keeps working unchanged.
  - An invalid config is a usage error, exit 2. The message names the config path and the key that is wrong.
- **M2-2. The shape of the config.**
  ```ts
  defineConfig({
    apps: Record<string, AppConfig | TargetConfig>,   // a target on its own may carry baseUrl and start
    defaultApp?: string,
    runs?: Array<Record<string, string>>,             // app name to target name
    secrets?: Record<string, SecretSource>,
    secretOrigins?: Record<SecretName, string[]>,     // M2-23
    testIds?: Record<string, string> | readonly string[],
    tags?: readonly string[],
    states?: readonly string[],                       // the names test.setup may save, for StateName (M2-7)
    timeouts?: Partial<Timeouts>,
  })
  app({ baseUrl?, start?: { command, ready, cwd?, timeoutMs? }, targets: Record<string, TargetConfig> })
  chromium({ executablePath?, headless?, emulate? })   // executablePath falls back to the RETEST_CHROMIUM environment variable
  chrome({ channel?: 'stable' | 'beta' | 'dev' | 'canary', headless?, emulate? })
  edge({ channel?: 'stable' | 'beta' | 'dev' | 'canary', headless?, emulate? })
  env(name)    // a SecretSource that reads process.env in the parent at run start
  ```
  - A `SecretSource` is `env(name)`, or a function returning `string | Promise<string>`. The function form is how a hosted service such as Rehearsal supplies secrets.
  - An app written as a bare target has one target, named after its constructor: `chromium`, `chrome` or `edge`.
  - `defaultApp` defaults to the only app. With several apps and none named, a test with no `apps` option is a collection error.
  - Made concrete by the Foundation phase:
    - App, target, secret, tag and state names hold letters, digits, `_` and `-`, and start with a letter, because they go into file names, `--target app=name` and `{{name}}`. A tag cannot be `and`, `or` or `not`.
    - `executablePath` and `start.cwd` are relative to the config's folder, which is also the default `cwd`. `baseUrl` and `start.ready` are http or https URLs.
    - A key set to `undefined` counts as absent. An unknown key is an error, in the types and at load time.
    - `validateConfig(value, path)` returns the `LoadedConfig` in `src/config/loaded.ts`: defaults filled in, paths absolute, apps, targets and secrets in `Map`s, and `testIds` dropped, since only the types read it.
- **M2-3. `defineConfig`, `app`, the target constructors and `env` are generic identity functions** with `const` type parameters, so every name stays a literal type. The config schema and these functions live in `src/config/`. Loading the file lives in `src/config/load.ts`.
- **M2-4. Finding executables.**
  - `chrome({ channel })` and `edge({ channel })` find the installed browser from the standard install locations on macOS and Linux.
  - `chromium()` needs `executablePath`, or `RETEST_CHROMIUM`.
  - A missing executable is a setup failure naming the paths that were tried. It is reported before any test that needs it, and by `doctor`.
  - Windows is not supported, so say so.
  - Resolution is a pure function of the platform and the file system, in `src/browser/executables.ts`.
- **M2-5. Device emulation.** `emulate` takes a device name from a small built-in table: `'Pixel 9'`, `'Galaxy S24'`, `'iPhone 17'` and `'iPad Pro 11'`. Each entry gives a viewport, a device scale factor, `isMobile`, `touch` and a user agent. Every event, result and report labels an emulated target as emulated. An unknown device name is a config error that lists the known names.
  - `emulate` also takes an object: `{ viewport: { width, height }, deviceScaleFactor, touch, isMobile?, userAgent? }`. `isMobile` defaults to false, and without `userAgent` the browser keeps its own. Both forms are labelled emulated, and `touch: true` written as a literal counts as touch for M2-9.
  - A named Android device's user agent carries the running browser's own major version (`emulationFor(emulate, browserVersion)` in `src/config/devices.ts`). The table's sizes come from published specifications and are not measured on the devices.
- **M2-6. Command-line flags alongside a config.**
  - `--base-url <url>` overrides the default app's base URL; `--base-url app=url` overrides a named app. This is how CI tests a preview deployment.
  - `--browser` is milestone 1's single-app mode, and is a usage error when a config exists.
  - `--timeouts` overrides `config.timeouts`.

### Types

- **M2-7. Registering the config.**
  - `interface Register {}` is exported. A project registers with `declare module '@rehearsal-labs/retest' { interface Register { config: typeof config } }`.
  - From the registered config, the types derive `AppName`, `TagName`, `SecretName`, `TestIdValue` and `StateName`, and what each app supports (touch).
  - With no config registered, a test may not declare `apps` or `state`. That is a branded `RetestTypeError` naming the fix. `page` still works, `tags` accepts any string, `secret` accepts any string, and `getByTestId` accepts any string.
  - The prototype is in `docs/plans/developer-experience/research/typescript.md`; follow its lessons. Use one signature, never overloads. Missing registration must fail loudly. `defineConfig` needs `const` type parameters.
  - `src/config/register.ts` exports `Register`, `RetestTypeError`, `RegisteredConfig`, `IsRegistered`, `RequiresConfig<T>` (the loud error before registering), `AppName`, `DefaultAppName`, `TagName`, `SecretName`, `TestIdValue`, `StateName` and `AppHasTouch<Name>`. A registered config that lists no `tags`, `states` or `testIds` accepts any string for them; one that declares no `secrets` accepts none.
  - `Apps<Names>` names the API's handle types, so the API defines it from `AppName` and `AppHasTouch`, in `src/api/apps.ts`. The `state` option in `src/api/test-options.ts` avoids two traps: it must use `NoInfer<Names>`, or a string state infers the app names from the string's own keys; and without apps, `Partial<Record<never, StateName>>` is `{}`, which takes any string.
  - Each registered config is its own type-check project under `tests/types/fixtures/`, because a registration applies to its whole program.
- **M2-8. The `test` signature.**
  - There is one signature: `test(name, options?, fn)`.
  - The context is `{ page }` when no apps are declared, and `Apps<Names>` otherwise. Destructuring an app the test didn't declare is a compile error.
  - Options are `apps`, `tags`, `state` and `timeout`.
  - `state` is a `StateName`, or `Partial<Record<AppName, StateName>>` for a test with several apps.
- **M2-9. What an app handle offers.**
  - Every app handle in milestone 2 is a web page.
  - `tap()` exists only when every target of that app emulates a touch device. Anything else is a compile error saying that one of the app's targets has no touch screen.
  - `click()` works everywhere. On a touch-emulated target it is sent as a tap and recorded as a tap.
- **M2-10. Compile-fail fixtures.** Every compile error on the plan page's "What tsc catches" section reproduces. Add fixtures for:
  - an unknown app, tag, secret, test id or state;
  - `tap` on a non-touch app;
  - `apps` without registration;
  - `expect(secret)`;
  - `toBe` on a locator;
  - the list matchers' argument types.

  The fixtures run on TypeScript 6 and 7.

### Apps, targets and runs

- **M2-11. One context per app.** Each declared app in a test gets its own browser context and page, so it starts with fresh storage. Apps on the same target share one browser process. Each distinct target, meaning its executable plus headless and emulation, launches once per run, the first time it is needed, and closes at the end of the run.
- **M2-12. Commands name their app.** IPC commands carry `app`, and the parent routes each command to that app's page. Events carry `session: <app name>`. "One command at a time" [D17] applies to each app separately, so two apps may act at once.
  - The `run` message lists the apps the test's handles use, in declaration order; a test that declares none gets its default app. Milestone 1's mode has one app named `page` (`singleAppName`), so its events keep `session: 'page'`.
- **M2-13. Variants.**
  - A test whose apps have one target each runs once.
  - A test that uses one app with several targets runs once per target.
  - A test that uses two or more apps with several targets each runs once for each entry in `runs` that names all of those apps. Collection fails when no entry does.
  - Each run of a test is a variant. `variant` maps app names to target names, and its key is sorted `app=target` pairs joined with commas, such as `web=beta` (`variantKey` in `src/protocol/variant.ts`, sorted by code unit). Milestone 1's mode has no variant.
  - The `testId` stays `file > describe path > name`. A result is unique by its `testId` and variant key.
  - `--target web=beta` keeps only variants that match. It can be repeated for different apps.
- **M2-14. Failure screenshots.** When a test fails, each app page that is still reachable gets a screenshot, named with the app.

### Locators and matchers

- **M2-15. Locator recipes form a discriminated union:**
  ```ts
  { by: 'testId'; value: string }
  { by: 'role'; role: AriaRole; name?: string; exact?: boolean }
  { by: 'label'; text: string; exact?: boolean }
  { by: 'text'; text: string; exact?: boolean }
  ```
  - `describeLocator` writes each kind as the call that creates it, and writes `exact` only when it is false.
  - Name and text matching normalise whitespace: trim the ends and collapse runs of whitespace to one space.
  - `exact` defaults to `true`, a case-sensitive match on the whole string. `exact: false` is a case-insensitive substring match. The design is strict by default, so `name: 'Save'` never also matches "Save draft".
  - `AriaRole` is the union of WAI-ARIA 1.2 roles, as the compile-fail fixtures require.
- **M2-16. How locators are resolved.**
  - `role` uses Chrome's own accessibility tree over CDP (the `Accessibility` domain), and never reimplements accessible-name rules.
  - `label` matches form controls (roles `textbox`, `searchbox`, `combobox`, `listbox`, `checkbox`, `radio`, `switch`, `slider` and `spinbutton`) whose accessible name matches the text.
  - `text` finds the innermost elements whose whole normalised text matches (exact), or contains the text (not exact), inside the isolated world. It skips `script`, `style`, `template` and `noscript`.
  - All three cover the top-level document only.
  - The same rules from milestone 1 still hold: values are passed as arguments, resolution happens fresh on every command, and ambiguity fails an action at once.
  - A conformance fixture page proves each rule in real Chrome: `aria-label`, `aria-labelledby`, `label for`, a wrapping `label`, hidden elements, `aria-hidden`, `display: none`, and names that differ only by case or whitespace.
- **M2-17. Observations.** `observe` returns:
  ```ts
  { count, visible, text, value, items, itemsTruncated }
  ```
  - `items` lists `{ text, visible }` for up to 100 matches (`observedItemLimit`), in document order, and `itemsTruncated` says when more matched.
  - `value` is the field's value when exactly one field matches.
  - List matchers read `items`.
- **M2-18. Locator matchers.**
  - `toBeVisible`, and `toBeHidden`, which passes when nothing matches or nothing that matches is visible.
  - `toHaveText(string | string[])`, where the array form compares every match, in order.
  - `toHaveCount(n)`.
  - `toHaveValue(string)`.
- **M2-19. Value matchers.**
  - `toBe`, typed to the value.
  - `toEqual`, a deep structural equality that is documented: plain objects, arrays, primitives, `Date`, `Map` and `Set`.
  - `toContain`, for a string or an array.
  - `toMatch(RegExp)`.
- **M2-20. `expect.poll` and `expect.soft`.**
  - `expect.poll(fn, { timeout?, intervals? })` retries `fn` and then applies a value matcher. It never retries actions: `fn` may only read.
  - `expect.soft(x)` records the failure and lets the test go on. The test fails at the end with every soft failure, and each one is kept in the events.

### Structure and state

- **M2-21. Test structure.**
  - `test.describe(name, fn)` and `test.describe(name, options, fn)` nest. They add their name to test ids, and pass their `tags`, `apps` and `state` down to the tests inside.
  - `test.beforeEach` and `test.afterEach` hooks run in the order they were declared, outermost `beforeEach` first and innermost `afterEach` first.
  - `afterEach` hooks always run, and their failures sit beside the test's original failure without replacing it.
  - `test.for(rows)(nameTemplate, options?, fn)` fills `$key` in the name from each row. Two rows that produce the same name are a collection error.
- **M2-22. Sign-in state.**
  - `test.setup(name, options?, fn)` declares a setup that uses exactly one app.
  - A setup runs before any test that needs its state, once per target in each run. When it passes, the parent saves that browser context's cookies, plus `localStorage` for the origins the page visited, to `<run>/states/`, in a file named from the state and the target together (`stateFile`), so no two pairs share one.
  - A test with `state` gets a new context with that state restored before its body runs: `OwnedPage.captureState()` saves it, and `newPage({ storageState })` restores it.
  - A setup that fails makes every test that depends on it `not_run`, with the setup's failure as the reason.
  - Saved state is deleted when the run ends, because it holds session cookies, and it never enters a report.
  - With a config, a state whose setup is in no file the run was given is looked for among the other `.retest.ts` files under the root, in path order (`src/runner/setup-search.ts`, with discovery shared with the CLI in `src/shared/test-files.ts`). The run takes only the setups it needs from that file, runs them only for the tests that need them, and marks each collected setup with `setupFor`, the files it serves. The human reporter prints "ran setup X from Y for Z".
  - A test that names a state no file provides is a collection error that names the state, and any file Retest could not load to look in.
- **M2-23. Secrets.**
  - `secret(name)` returns a `Secret` object whose `toString`, `toJSON` and `util.inspect` all give `{{name}}`.
  - `fill(secret)` sends `{ secret: name }` in the command, never the value. The parent resolves the value and types it.
  - An `env(name)` source is resolved once, at run start. A missing variable is a setup failure, exit 2, before any test runs, naming it.
  - A function source is called on each use, every time a `fill` uses that secret, because values such as one-time codes change between reads. Its error or rejection, or a result that is not non-empty text, fails that fill with `setup_failed`, naming the secret.
  - The value never reaches the child. The browser receives the plain value and its label, the secret's name (`ResolvedFill.secret`).
  - Secrets are bound to origins. A secret may be typed only into a page whose origin is one of the origins of the test's apps' `baseUrl`s, or one `secretOrigins` lists for it. Filling it on any other origin fails with `not_actionable` and a message naming the origin, and the value is never typed. `secretOrigins` is a top-level config key rather than a per-secret option, which keeps `env(name)` and the function form unchanged.
  - The check happens twice. The parent checks first, since it holds the value and knows the page URL from navigation events, and its message names the `secretOrigins` fix. A page can change origin by script after the last navigation the parent saw, so `ResolvedFill` carries `allowedOrigins` and the browser checks `location.origin` again inside the in-page call that focuses and selects the field. The input guard is armed from before the focus until the text reaches the field, and it cancels any navigation the page starts to another document in that time. The browser then refuses with `not_actionable`, naming the origin, and types nothing. Amended by the review: while the browser is on a navigation of the frame (`Page.frameStartedNavigating` until `Page.frameNavigated` or `Page.frameStoppedLoading`), no action starts; the fill waits for the document that arrives and checks that one. Should a document still arrive while the text is on its way, its own guard stops typing nothing was armed for, and the fill fails `not_actionable` naming that document.
  - The parent replaces every secret value with `{{name}}` in:
    - all text it records (events, logs, results, `inspect` output), addresses included, and in every form a URL gives a value (amended by the review);
    - all text it sends to the child (observations, and the address a `goto` returns).
  - Every log is read again when the run ends, with every value learned by then (amended by the review).
  - Screenshots are not redacted, and the docs must say so.
  - An action event for a secret fill records `secret: name` in place of `valueLength`.

### Running and choosing tests

- **M2-24. Choosing tests.**
  - `--grep <text>` matches a substring of the full title, or `/regex/flags`.
  - `--tag "<expression>"` takes `and`, `or`, `not` and parentheses. A tag missing from `config.tags` is a usage error.
  - `path/file.retest.ts:line` selects the test, `test.for` rows or describe block declared on that line. Every row of a `test.for` has the line of its call, so `path/file.retest.ts:line#row` selects one row, counted from 1. Each collected row records its number as `row`, and `list` and the rerun line show it.
  - `--last-failed` reads `.retest/last-run.json` (`lastRunSchema`). Every run writes that file with the test ids and variant keys of its `failed`, `error` and `not_run` tests; a test kept from running has not passed either.
  - The CLI parses the flags into `Selection` in `src/runner/contract.ts` before the run starts: `grep` is text or a `RegExp`, `tags` a parsed `TagExpression`, `locations` the `file:line` pairs, `lastFailed` the entries read from the file, and `targets` a partial variant.
  - `--target app=name` is described in M2-13.
  - A selection that matches nothing is exit 2, with the reason.
- **M2-25. Starting the app server.**
  - For each app that has `start`, the parent first checks `ready` with an HTTP GET. Any HTTP answer counts as ready.
  - If `ready` already answers, the parent uses that server and never stops it.
  - Otherwise it runs `command` in a shell, as its own process group, with output going to `logs/app-<name>.log`. It waits for `ready` within `start.timeoutMs`, or the setup budget. When the run ends it stops the group with SIGTERM, then SIGKILL after the close grace.
  - A server that never becomes ready is a setup failure for the tests that need it.
  - The parent's last-resort exit hook also covers these process groups.
- **M2-26. `retest init`.**
  - It writes `retest.config.ts` (with the Register block), `tests/example.retest.ts` and `tsconfig.retest.json` (the flags from [D28]).
  - It adds the `test:e2e` and `typecheck:e2e` scripts to `package.json`, and `.retest/` to `.gitignore`.
  - `--ci github` also writes `.github/workflows/retest.yml`.
  - It never overwrites a file. An existing file is reported as "left as is".
  - It asks questions only on a TTY where no coding agent is detected. Every question has a flag: `--app name=url`, `--start "command"`, `--browser chromium|chrome|edge` and `--yes`.
  - It installs nothing. It prints the install line.
- **M2-27. `retest doctor`.**
  - It loads the config.
  - For each target, it launches the browser once and reports the product, version and path, then closes it.
  - For each app, it checks `ready`, starting and then stopping the server when `start` is set.
  - It reports each problem with its fix. It exits 0 when everything is ready, and 2 otherwise.
  - It writes the logs of the browsers and servers it starts under `.retest/doctor/<time>/`, and keeps them only when a problem or its fix points to one.

### Events, results and reporters

- **M2-28. Protocol changes are additive, and `schemaVersion` stays `1`.** Nothing has been released, so the published schema is simply regenerated.
  - `variant` and `variantKey` on the `test.*` events, on `action.*`, `assertion.*` and `step.*`, and on `TestResult`. The parent adds them to every event of an attempt, `navigation` and `evidence.*` included; the child never sends them.
  - `tags` and `apps` on collected tests, with `describePath`, `setup`, `variants`, `row` for a `test.for` row and `setupFor` for a setup taken from a file the run was not given. `describePath` is also on `test.started` and `TestResult`.
  - `app` and `target` on `browser.started`, which is now emitted once per app target, the first time it is used. `target` is `{ name, emulation?, device? }`; product and version stay top-level. App targets that share one browser share its `pid`.
  - New events `app.started`, `app.reused` and `app.failed` for managed servers, and `state.saved` and `state.restored`, with no contents.
  - `secret` on fill action events, `tap` as an action command, `hook` on the `step.started` of a `beforeEach` or `afterEach`, and `soft: true` on an `expect.soft` assertion.
  - A setup test's result is marked `setup: true`. `result.json` lists every app target's browser in `browsers`, and each screenshot names its `app`.
  - `run.started.options` gains `config` (its path relative to the root) and `baseUrls` (the command line's, by app). `browserPath` is present only in milestone 1's mode.
  - Every event carries `origin: 'parent' | 'child'`. The parent sets `child` on every event it relays from the child and `parent` on the ones it produces, so readers can tell facts the parent witnessed from claims the test process made.
- **M2-29. Reporters.**
  - They label variants, for example `web=beta` and "emulated".
  - They print a summary line for each target when there is more than one.
  - The failure card's rerun line uses `file:line` and `--target`.
  - `list` shows tags, apps and variants.
  - `inspect` shows the variant and the app for each action.

### Programmatic use

- **M2-30. Two package subpaths for a hosted service.**
  - `@rehearsal-labs/retest/runner` exports `runFiles` (with its `launch` parameter), `collectFiles`, `validateConfig`, `RunFolderError` and `LaunchError`, and the types `RunOptions` (whose `apps` holds the config as an object), `CollectOptions`, `CollectResult`, `LoadedConfig`, `Reporter`, `ChildOutput`, `LaunchBrowser` and the browser contract a custom launcher implements.
  - `@rehearsal-labs/retest/protocol` exports the event, result, command and failure types and their schemas, `parse`, and `eventSchemaUrl` and `resultSchemaUrl`, the file URLs of the JSON Schema files in `dist/schemas`.
  - Each subpath has `retest-source`, `types` and `default` entries, in the root export's order. `src/runner/index.ts` and `src/protocol/index.ts` only re-export; the CLI keeps using the internal modules. The root export stays the authoring API.

## Contracts: who owns what

| Path | Phase | Notes |
| --- | --- | --- |
| `src/protocol/**` | Foundation | Everything additive per M2-28: `locator.ts`, `commands.ts`, `messages.ts`, `events.ts`, `result.ts`, the `timeouts.ts` merge helper (`mergeTimeouts`), and new `variant.ts`, `aria-role.ts`, `secret.ts`, `emulation.ts`, `storage-state.ts`, `last-run.ts`, `json-schemas.ts` and the `index.ts` entry (M2-30) |
| `src/config/**` except `load.ts` | Foundation | Config types, schema, `defineConfig`, `app`, targets, `env`, devices, and the `Register` types in `register.ts` |
| `src/browser/contract.ts`, `src/runner/contract.ts`, `src/runner/index.ts` | Foundation | `newPage` options (emulation, storage state to restore), `OwnedPage.captureState`, `BrowserCommand` with resolved secrets, and in `RunOptions`: `apps` (a config or milestone 1's single app), resolved secrets and selection |
| `src/browser/**` | Browser | AX-based role and label, text resolution, multi-item observation, `tap`, emulation, state capture and restore, and `executables.ts` |
| `src/api/**`, `src/assertions/**`, `src/index.ts`, `tests/types/**` (the Foundation phase added the config and Register fixtures and a project per registered config) | API | `describe`, hooks, `for`, `setup`, `secret()`, handles with app routing, `tap`, the new matchers, `poll` and `soft`, the public types, and compile-fail fixtures |
| `src/runner/**`, `src/store/**`, `src/config/load.ts` | Runner | Config loading, variants and runs, per-app routing, setup scheduling and state, secret resolution and redaction, app servers, selection, and `last-run.json` |
| `src/cli/**`, `src/reporters/**` | CLI | `init`, `doctor`, the CI template, the new flags, and reporter, `list` and `inspect` changes |
| `examples/**`, `fixtures/**`, `tests/integration/**`, `README.md`, `docs/implementation-handoff.md` | Verification | The real-Chrome matrix, conformance fixtures, the package smoke test with a config, and the docs |

Each agent's unit tests live next to its area's existing tests in `tests/unit/`, named with the area prefix. An agent edits only what its phase owns. If a contract has to change, it stops and reports.

## Acceptance checks

The Verification phase proves each of these through the real CLI against real Chrome. It uses Google Chrome 154 stable and, as the second target, Chrome for Testing 153 at `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, passed as `chromium({ executablePath })`. That is a plain browser build on disk; no Playwright code is used.

1. **Config.**
   - No config and no `--browser` gives a clear usage error.
   - An invalid config names the key.
   - A milestone 1 style run still works.
2. **Types.** Every compile error from the plan page reproduces, and so does every M2-10 fixture. A project with no config registered still compiles `page` tests.
3. **Locators.** Role, label and text conformance holds in real Chrome, including ambiguity, `exact`, and hidden elements.
4. **Two apps in one test.** Their storage stays separate, commands are routed correctly, and a failure takes one screenshot per app.
5. **Matrix.**
   - Two targets run twice and are labelled.
   - `--target` picks one.
   - `runs` combinations work.
   - A missing `runs` entry is a collection error.
6. **Emulation.** The viewport, user agent and touch are applied, `tap` works, and every report labels the target as emulated.
7. **Secrets.**
   - A missing secret gives exit 2 before any test runs.
   - Searching the whole run folder and the child's log finds the value nowhere.
   - Page text that contains the value is redacted.
8. **Sign-in state.**
   - A setup logs in through a login page in the fixture app, and a dependent test starts signed in.
   - A test without `state` starts signed out.
   - A failed setup makes its dependents `not_run`.
   - No state file is left after the run.
9. **Hooks.** Hooks run in the right order. `afterEach` runs after a failure and keeps the original failure. `test.describe` ids and `test.for` names are right, and duplicates are errors.
10. **Matchers.** Every new matcher passes and fails correctly. `expect.poll` never repeats an action. `expect.soft` fails the test at the end, with every failure recorded.
11. **Selection.** `--grep`, tag expressions (and unknown tags), `file:line`, `--last-failed` and `--target` all work, and an empty selection gives exit 2.
12. **`init`.**
    - In an empty temporary project, `init --yes` writes the files.
    - Running it again changes nothing.
    - The generated project typechecks, and its example runs against the fixture.
    - `--ci github` writes the workflow.
13. **`doctor`.** It reports a missing browser and an unreachable app with their fixes, and starts and stops a managed server.
14. **`start`.** It starts the server, waits for `ready`, reuses a server that is already running, stops the one it started, and logs its output. A server that never becomes ready gives `setup_failed`.
15. **Package smoke test.** A consumer project outside the repository has a config and the `Register` block, typechecks on TypeScript 6 and 7, and runs.
16. **The milestone 1 guarantees still hold:**
    - honest outcomes and exit codes;
    - no repeated actions;
    - timeouts, disconnects and signals;
    - JSONL purity;
    - `inspect` on torn runs;
    - cleanup of every process, profile, server and state file.

## Rules for every agent

Unchanged from milestone 1:
- Work only in the Retest repository and only in your files. Never commit, stage or reset.
- Never touch `x-series/`, the user's own browsers, profiles or apps.
- Kill only process ids you started.
- No network and no installs.
- Keep the Chromium sandbox on.
- Keep every command under 10 minutes, and never wait idle on a background process.
- Report exactly what ran, with exit codes and counts, and what you could not verify, most important first.
