# Retest usage guide

How to set up, run and read Retest at milestone 2 and the first part of milestone 3, in detail: the config, the test API, the command line, running Retest from a program of your own, and what Retest does not do yet. The [README](../README.md) is the short tour, and the [handoff](implementation-handoff.md) records what was verified and how.

Retest runs TypeScript test files against Chromium-family browsers, through its own runner and its own CDP client. A project has a config with named apps, several browser targets, emulated devices, secrets, tags and sign-in state. Retest has no runtime dependencies, and it downloads no browser.

Everything here was checked on macOS arm64, with Google Chrome 154 and Chrome for Testing 153, and on Linux arm64 inside Docker, with Google Chrome 154, Debian's Chromium 154 and Chrome for Testing 153. Milestone 3's first part adds `press`, host checks, observations, a proxy per target and a test environment. All of its checks ran on macOS. On Linux, its own integration checks ran in Docker with Google Chrome 154 and Debian's Chromium 154. Retest handles the SIGTERM a CI runner sends on cancel, but it has not run on a CI runner yet.

The package is not published and is marked private. Its intended name is `@rehearsal-labs/retest`; see [the naming check](naming.md). The library and public protocol use Apache-2.0.

## Prerequisites

- Node.js 24.12 or later. Retest runs `.ts` files with Node's built-in type stripping.
- An installed Chromium, Google Chrome or Microsoft Edge. Retest downloads no browser. Where a path is asked for, give the executable itself, not a macOS app bundle.
- macOS or Linux. Linux was verified only inside Docker, on arm64; see [Run in a container](#run-in-a-container). Retest relies on POSIX process groups, so Windows does not work.

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
- The two must be different builds. The matrix checks read each one's version with `--version` and tell them apart by it.

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

Each of them also takes `proxy`, described [below](#proxy).

Retest finds Chrome and Edge where they install: on macOS in `/Applications` and `~/Applications`, and on Linux in the standard paths. A browser that is not there is a setup failure that lists the paths it tried, before any test that needs it. Only `chrome()` stable and `chromium({ executablePath })` were run. Edge and the other Chrome channels were not installed on the machine Retest was checked on.

`headless` defaults to true. `--headed` shows every browser. Nobody has run a browser with a window yet.

Targets on the same executable, with the same headless setting and emulation, share one browser process. Each distinct target launches once, the first time a test needs it, and closes when the run ends. Every test gets a new browser context and page for each of its apps.

### Proxy

`proxy: { server, bypass? }` on a target sends the requests of its pages through a proxy:

```ts
web: chromium({ baseUrl, proxy: { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>'] } }),
```

- `server` is an `http`, `https`, `socks4` or `socks5` address with a host. Retest keeps its scheme, host and port. Only an `http` proxy was run.
- `bypass` holds Chrome's bypass rules, such as `localhost`, `*.internal` or `<-loopback>`. An entry may not be empty or hold `;`.
- Chrome sends loopback addresses, such as `127.0.0.1` and `localhost`, around a proxy unless `bypass` holds `<-loopback>`. Retest does what Chrome does. To test an app on your own machine through a proxy, add `<-loopback>`.
- The proxy belongs to each test's browser context, so every request of the page goes through it: the page, its fetches, its service worker's requests and a frame from another site. An `https` address goes through a `CONNECT` tunnel.
- The browser's own requests go through it too, such as a `CONNECT` to a search engine. The proxy sees requests your test did not make.
- Targets that differ only by their proxy share one browser.

Retest does not sign in to a proxy. It refuses a `server` with a user name or password in it, and says why. A host that needs credentials runs a proxy of its own, on loopback, that adds them.

When the proxy fails, the page cannot open, and the test ends in an error with `setup_failed` that names the proxy: "Could not open http://127.0.0.1:4173/ through the proxy http://127.0.0.1:9999: net::ERR_PROXY_CONNECTION_FAILED. The proxy failed, not the app." Retest reads five of Chrome's errors this way: `ERR_PROXY_CONNECTION_FAILED`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_AUTH_UNSUPPORTED`, `ERR_PROXY_CERTIFICATE_INVALID` and `ERR_NO_SUPPORTED_PROXIES`. Real Chrome gave the first two in Retest's checks: a proxy that refused the connection, and a tunnel the proxy could not open.

A proxy that asks for credentials, with a 407, gets no answer. Chrome then gives `net::ERR_INVALID_AUTH_CREDENTIALS`, the same error it gives when a site's own page asks for a password and gets none. Retest cannot tell the two apart, so the test fails as for a page that would not open: `not_actionable` "Could not open http://127.0.0.1:4173/: net::ERR_INVALID_AUTH_CREDENTIALS."

Retest never tells Chrome to ignore certificate errors. A proxy that shows its own certificate for the sites it carries fails as Chrome fails it.

`browser.started` records each target's `proxy`, its server and bypass rules. The human report prints them where the browser started, as in `started web=chrome  Chrome 154.0.8037.92 · proxy http://127.0.0.1:8080 · bypass <-loopback>`. No report shows a user name or password.

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
- `locator.press(key)` focuses the element and presses one key on it. The element must be attached, visible and enabled, and keep the keyboard focus once Retest focuses it. There is no check at a point, since a key does not go through one.
- `page.keyboard.press(key)` presses one key on whatever holds the keyboard focus, with no checks.
- `locator.select(choice)` chooses options of a `<select>`: by label, by `{ value }`, or a list of them.
- `locator.check()` and `locator.uncheck()` tick and untick a checkbox, a radio button or an element with a checkable role.
- `locator.scroll({ x, y })` turns the mouse wheel at the element's centre. `page.scroll({ x, y })` turns it at the centre of the viewport.

Retest checks the element just before it acts, and a guard in the page watches the input itself. If the press, the release or the click lands on another element, Retest stops that event before any listener of the page hears it. The action then fails `not_actionable` and names the element that took it. While the browser is opening another document in the frame, no action starts: Retest waits for that document and looks for the element there, and an action whose time runs out meanwhile fails `not_actionable`, naming the address the page was opening. Typing that arrives in a document that replaced the one Retest checked is stopped by that document's own guard, and the fill fails `not_actionable`, naming the document. Two cases end as `outcome_unknown` instead, because Retest cannot see where the input went:

- the press never reaches the element's document, as when a same-origin frame covers the element;
- the page moves to a new document before the guard reports, and that document received no typing.

The guard covers press, release, click, touch and typing events, and the wheel while a scroll is on its way. Hover events, such as `pointerover` when the mouse arrives, still reach the page, and so do the `input` and `change` events a checkbox fires after a click. Downloads are refused: Retest asks the browser to deny them in every context it opens.

### Pressing keys

`press` takes one key at a time:

- A named key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp` or `PageDown`.
- `Shift+` and a named key, such as `Shift+Tab`. Shift goes with named keys only.
- One character, such as `a`, `7`, `?` or `é`. Retest presses the key that types it on a US keyboard, with Shift for an uppercase letter or a symbol such as `!`. A character no US key types, such as `é`, is sent as its text alone.

Control, Alt and Meta are refused, in the type check and when the test runs, as `unsupported`. An editing shortcut needs each platform's own command, and the platforms differ. The type check also refuses a misspelt key, such as `press('Entr')`. A key it cannot read, such as a `string`, is checked when the test runs; an unknown one fails `usage`, and the message lists what `press` takes. `KeyArgument<K>` lets a helper take a key the way `press` does.

What a press does:

- The key goes down and comes back up as real keyboard input, so the page hears the same events a person's key gives it.
- Enter in a form field submits the form once. The press passed once its `keydown` reached the field. The page that answers the form is the page's own navigation, and is recorded as one.
- A `keydown` the page cancels with `preventDefault` still reached its element, and the press passes.
- The `keydown` decides. It must reach the element or something inside it. If the keyboard focus moved to another element before the key arrived, as when a dialog takes the focus, Retest stops the key before any listener of the page hears it, and the press fails `not_actionable`, naming that element. Once the `keydown` has reached the element, the rest of the keystroke belongs to the page, so a key that makes the page move the focus or submit a form is never stopped halfway.
- A key for the page's keyboard while the focus is inside a frame never reaches the page's document. Retest cannot see where it went, so the press ends `outcome_unknown`, naming the frame.
- While the browser is opening another document in the frame, no press starts, as for every action.
- A browser lost after the key went down leaves the outcome unknown: `outcome_unknown`, and the key is never sent again.

Action events record the key in `key`, as the test wrote it. Reports write a press as the test wrote it: `getByLabel('Search').press('Enter')` or `page.keyboard.press('Enter')`.

### Choosing, ticking and scrolling

`select(choice)` takes one option or a list:

- A string names an option by its label, as a person reads it: the whole label, case and all, with each run of spaces read as one. `{ value }` names it by its `value` attribute, exactly.
- A list chooses exactly those options of a `<select multiple>` and clears the others. A list for a select that takes one option, and an empty list, fail `usage`.
- Each choice must match exactly one option. An option that is not there yet is waited for until the action budget runs out, and then the select fails `not_found`, naming it. Two options that match fail at once as `ambiguous`. A disabled option, or one in a disabled group, is waited for, and then fails `not_actionable`.
- The `<select>` must pass the checks a click does: visible, stable, enabled and not covered.
- An element that is not a `<select>` fails at once as `unsupported`. Choose from a list the page draws itself with `click()`.
- When the selection already is the one asked for, nothing is sent, and the event says `changed: false`.

`select` is the one action that is not real input. Chrome draws a select's list outside the page, where Retest's input cannot reach it. So Retest sets the selection from its own script, then dispatches `input` and `change`, as the browser does after a person picks. Those two events have `isTrusted` set to false, so a page that ignores untrusted events ignores this select too. The event says `input: 'script'`, and reports say "set by script".

`check()` and `uncheck()`:

- The element is a native checkbox or radio button, or has the role `checkbox`, `radio`, `switch`, `menuitemcheckbox` or `menuitemradio`. Anything else fails `unsupported`. A native control reads its `checked` state, and any other its `aria-checked`. `aria-checked="mixed"` counts as not checked.
- A control already as asked gets nothing, and the event says `changed: false`.
- Otherwise Retest clicks it once, with every check a click makes. On a touch screen it taps, and the event says `touch: true`.
- A native control that is not visible, with exactly one visible label of its own, is clicked through that label. This is how a person ticks a styled checkbox. The event says `via: 'label'`, and reports say "clicked its label".
- After the click, Retest reads the control until it is as asked or the action budget runs out. It never clicks again. A control that took the click and stayed as it was fails `not_actionable`, with `details: { check: 'state', inputSent: true }`.
- `uncheck()` on a radio button fails `unsupported`. A person unchecks one by choosing another.

`scroll({ x, y })`:

- `x` and `y` are CSS pixels, positive right and down. Both missing or 0, or either not a finite number, fails `usage`.
- `locator.scroll` needs the checks a click does, and its `wheel` event must reach the element or something inside it. A `wheel` another element takes is stopped before the page hears it, and the scroll fails `not_actionable`, naming that element. `page.scroll` has no checks.
- One wheel event carries the whole distance. The scroll passes once that event reached its element. It says nothing about how far the page moved, since smooth scrolling may still be going. The next action waits for its element to stand still.
- The distance is the CSS pixels the page scrolls, also on an emulated phone whose page is zoomed out to fit. On a page with an emulated device pixel ratio, the page's own `WheelEvent.deltaY` reads the distance divided by that ratio.
- On a touch screen, `scroll` still turns the wheel. It does not swipe.
- Retest listens for `wheel` only while a scroll is on its way, so the page scrolls as it always does.
- Every action already brings its element into view. Scroll only for what the page does on scroll, such as loading more items, or enabling a button once a text has been read to its end.

Reports write each of these as the test wrote it, with what the call leaves out: `getByLabel('Toppings').select(['Basil', { value: 'olives' }]), set by script`, `getByLabel('Newsletter').check(), clicked its label`, `getByTestId('agree').check(), already checked, sent nothing`, or `page.scroll({ y: 600 })`.

### Matchers

Locator matchers look again until they pass or the assertion budget runs out. They never repeat an action. Await them. The page tells Retest when its document changes, so a look follows a change within about 50 ms; without a change, looks come 50, 100 and 250 ms apart, then every 500 ms.

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
- The function is called with `{ signal }`. Retest aborts that `AbortSignal` once it stops waiting for the value: when the fill runs out of time, or when the test or the run is stopped. Pass it on, as to `fetch`, so the work stops too. `SecretContext` is its type.
- The function is called as the fill begins, before Retest looks for the field. A test that types a one-time code waits for the page that asks for it first, as with `await expect(page.getByLabel('Code')).toBeVisible()`, so the code has been sent by then.
- A secret is bound to origins: those of the base URLs of the test's apps, and any `secretOrigins` lists for it. On any other page, the fill fails `not_actionable`, naming the page's origin, and nothing is typed.
- Retest checks the origin twice: before it reads the value, and again in the page, just before it types. While it types, it stops the page from leaving for another document. While the browser is already opening another document, the fill waits for it and checks that document instead. A document that still arrives while the text is on its way stops the text itself, since nothing was armed there: the fill fails `not_actionable`, naming the document, and the text reaches no document Retest did not check.
- Retest writes `{{name}}` in place of every value in all text it records or reports: events, results, logs, app server output, browser logs, the terminal, and every address it records, in every form a URL gives a value, percent-encoded or form-encoded. Page text the test reads is redacted before it reaches the test's process, so a check against it compares `{{password}}`. Each value is hidden in the whole text before Retest quotes, escapes or cuts it.
- Locators are not redacted. The page matches a locator's text and name against its own text, as it shows it. So a locator that holds part of a value, with the text the page shows beside it, can match it, and a test that tries can learn what the page shows in place of `{{name}}`. Retest refuses, as `usage`, a command whose locator text or name holds a whole value it has read, and never sends it to the page. The refusal does not repeat the text. A locator's text and name are recorded with every value hidden.
- A fill of a secret records `secret: name` in its event, instead of the length of the text.
- A function source's value is known, and so hidden, only once the source has given it. A value that arrives after its fill stopped waiting for it is hidden too, from the moment it arrives. Every log is read again when the run ends, so a value a server or a test file printed before that is hidden there too. What the terminal and the events already carried before the value arrived stays as it was, and so does page text the test read before it.

Screenshots are not redacted. A failure screenshot shows whatever the page showed, including a secret the page displays. Text redaction is not image redaction.

### Rules every test follows

Await every action and assertion. An app takes one command at a time. A test fails when it makes no assertion, when work it started is still running as it returns, or when an assertion it did not await failed.

Each test file runs in a process of its own, and each test gets new browser contexts and pages. Files run at the same time, up to `--workers` of them, in a few browsers for each target; the tests of one file run one after another. Module state is shared by the tests of one process. The process is not a sandbox for hostile test code.

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
- `--workers <n>` sets how many test files run at once, each in a process of its own, sharing each target's browser. The default is half the machine's cores, at least one. Setups run first, one after another, so every saved state exists before a test starts from it. `--workers 1` runs the files one after another. Tests in different files run at the same time, so two that share something outside the page, such as one account or one counter on a server, can disturb each other: give each its own, as the example's count of saves does with a title of its own, or run with `--workers 1`.
- `--browsers <n>` sets how many browsers a target's tests are spread over, each worker keeping to one. The default is one browser for every three workers that have a file to run. A target that runs a share of the run's tests, as each target of a matrix does, gets that share of the browsers, at least one, and never more than the files that use it. One browser serves all its pages from a single process, which many workers saturate; the human report says how many a target has, as in `started web=chromium  Chrome 154 · 3 browsers`, each further browser is a `browser.started` event with its `instance`, and its log is `logs/browser-…-2.log` and so on.
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

## Run Playwright test files

`retest run --playwright` runs test files written for Playwright, unchanged, as far as Retest's compatibility goes. It is early, and the lists below are all of it.

```sh
retest run --playwright --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --base-url http://127.0.0.1:3000
retest run --playwright tests/checkout.spec.ts --browser /usr/bin/chromium --base-url http://127.0.0.1:3000
```

- Files end in `.spec.ts`, `.spec.js`, `.spec.mts` or `.spec.mjs`, or the same with `.test.`. With none named, Retest takes every `.spec.` file under the folder and leaves `.test.` files out, since a project's unit tests end the same way.
- `@playwright/test` and `playwright/test` resolve to Retest's own `@rehearsal-labs/retest/playwright`, wherever the file is. Neither package has to be installed in the project.
- A relative import may leave out its extension, as Playwright suites write them: `./helper` finds `./helper.ts`, then `./helper.js`, then the folder's index.
- What runs: `test`, `test.describe`, `test.beforeEach`, `test.afterEach` and `test.step`; the `page` fixture; `page.goto`, `getByRole`, `getByLabel`, `getByText`, `getByTestId` and `page.keyboard.press`; a locator's `fill`, `click`, `press`, `check` and `uncheck`; `expect` with `toBeVisible`, `toBeHidden`, `toHaveText`, `toHaveCount`, `toHaveValue`, `toBe`, `toEqual`, `toContain` and `toMatch`, and `expect.soft` and `expect.poll`.
- Everything else fails where it is used, as `unsupported`, naming the member: "page.getByPlaceholder is not supported yet by Retest's Playwright compatibility." Nothing is skipped or dropped. An options argument such as `{ timeout }`, `.not`, `test.skip`, test details, a titled hook and a fixture other than `page` are each refused by name. A test that meets one ends as an error at that line, and the run exits 2.
- The rules are Retest's. A test with no assertion fails, a locator that matches several elements is ambiguous, an action is sent once, and `toHaveText` compares whole text.
- `playwright.config.ts` is not read. The browser and the base URL come from the command line, or from `retest.config.ts`.
- The human report's first line says `playwright compatibility`, and `run.started.options.playwright` is true, so no reader takes the run for Playwright's own.

## Check the setup

```sh
retest doctor
```

`doctor` loads the config and checks everything a run needs, without running a test:

- For each target, it launches the browser once, reports its product, version and path, and closes it. A target with a proxy shows the proxy's address and bypass rules. `doctor` does not check the proxy itself, since each page's context uses it, not the launch.
- For each app with `start`, it starts the server, waits for `ready` and stops it. A server already running is left alone.
- For each app with only a `baseUrl`, it checks that the address answers.
- It checks that each secret's environment variable is set.

Each problem comes with its fix. `doctor` exits 0 when everything is ready and 2 otherwise. When a browser or a server fails, the message points to its log, which is kept under `.retest/doctor/<time>/`. Otherwise `doctor` removes its logs.

## Run in a container

Retest never turns Chrome's sandbox off. On Linux the sandbox creates user namespaces, which Docker's default seccomp profile refuses. A container that runs Retest needs three things, and no capability:

- A user other than root. Chrome does not start its sandbox as root.
- A seccomp profile that allows the namespaces. [`docker/linux/chromium-seccomp.json`](../docker/linux/chromium-seccomp.json) is Docker's own default profile with five rules added, for the calls Google Chrome 154 and Chromium 154 were traced making: `clone` with `CLONE_NEWUSER`, with `CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET` and with `CLONE_NEWPID`, `unshare(CLONE_NEWUSER)`, and `chroot`, which the sandbox calls inside its own user namespace. Docker's default allows `chroot` only while the container keeps `CAP_SYS_CHROOT`; the added rule lets a container drop every capability. Chrome for Testing 153 runs with the profile too. Everything else stays as Docker has it.
- An init, `docker run --init`, to reap the processes a browser leaves as it ends. Without one they stay behind as zombies, and Retest reports the browser as still there after it closed.

```sh
docker run --rm --init --cap-drop ALL --security-opt seccomp=docker/linux/chromium-seccomp.json --user node <image> npx retest run
```

Without the profile, Chrome stops before it answers and the run exits 2 with the cause: "Chrome's sandbox could not start, because this system does not let the browser create user namespaces." The setuid helpers Debian (`chromium-sandbox`) and Google Chrome (`chrome-sandbox`) ship do not help in Docker. They create namespaces too, and Docker refuses those to a container without `CAP_SYS_ADMIN`.

Docker gives a container 64 MB of `/dev/shm`, which was enough for Retest's own tests. Debian's `chromium` command adds `--disable-dev-shm-usage` by itself when there is less. For Google Chrome and large pages, give the container more with `--shm-size`.

Outside a container, Ubuntu 23.10 and later restrict user namespaces with AppArmor, and the browser needs an AppArmor profile that allows them. That was not tried.

Retest's own checks run on Linux with [`docker/linux/run.sh`](../docker/linux/run.sh). It builds [`docker/linux/Dockerfile`](../docker/linux/Dockerfile), Node.js 24 on Debian 13 with Google Chrome and Debian's Chromium, and runs it as the user `node` with the settings above. With no arguments it runs every gate; `docker/linux/run.sh npm run test:unit` runs one.

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

For one test, `inspect --test` shows every step in time order. Under a locator check it shows the looks the check took and the one its verdict rested on, and it says when a pass is only the test file's own word:

```text
     20 ms  navigated to "Tasks" at http://127.0.0.1:4173/, by goto
    209 ms  click getByRole('button', { name: 'Save' })  45 ms
    263 ms  ✓ toHaveText getByTestId('saved-task')  54 ms
              looked 2 times, passed on o2: 1 match, text "Release checklist"
    272 ms  ✓ toMatch  1 ms, 1 look, reported by the test file
    575 ms  web  ✗ host check address: http://127.0.0.1:4173/  303 ms, 4 looks  host_check_failed
                   page "Account" at http://127.0.0.1:4173/account
```

Each navigation shows the page's title and what opened it. Looks that no check claimed, such as those of a check the run stopped, collapse into one line. Host checks come after the body, each with what the page showed when it failed.

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

A program that calls `runFiles` can move `.retest/last-run.json` with `lastRunFile: '<path>'`, or write none with `lastRunFile: false`.

Every event says who reported it: `origin: 'parent'` for what Retest's own process saw, and `origin: 'child'` for what the test file's process claimed. Every event of a test's run carries its `variant` and `variantKey`, and every event about an app names it in `session`. Milestone 1's mode has one app, named `page`, and no variants.

`browser.started` comes once for each app target, with the app and the target, and whether it is emulated. `app.started`, `app.reused` and `app.failed` tell what became of each server. `state.saved` and `state.restored` name a state, never its contents. `result.json` lists every app target's browser in `browsers`, and each screenshot names its app.

`observation` is a look the parent served the test file's process, and `host_check.passed` and `host_check.failed` are host checks. [Use Retest from code](#use-retest-from-code) explains both, and `judgedBy` on `assertion.passed`.

### Titles and what opened each page

A `navigation` event names the page's title in `title`, what opened it in `cause`, and in `document` whether it opened a new document (`new`) or moved to a new path within the one the page had (`same`). Actions, looks and assertions name the title of the page they went to in `pageTitle`, beside `pageUrl`, and a host check's `actual` has `title`. Reports show the title before the address, as in `"Account" at http://127.0.0.1:4173/account`.

- A title is the page's `document.title`, trimmed, with its control characters removed, and cut to 300 code units. A page with no title has none. Titles are page text: a secret in one reads `{{name}}`. The browser hands Retest the title as the page has it, up to 65,536 code units. Retest hides each secret in it before it removes control characters, trims and cuts it, and again after, so no value is left half-written, and none is joined back together by the cleaning.
- An action or a look reads the title in the same call that checks or reads the element. `goto` reads it after `load`. An action that failed names the page as Retest last saw it commit when the failure came, since the page may have opened another document while the action waited for it, and its event comes after that document's `navigation`.
- A new document's `navigation` is written once its title is known: when its content has loaded, when the test's next command to that page begins, or one second after it opened, whichever comes first. It is always written before the events of any command that began after it. A page that sends the browser on at once can leave its navigation with no title.
- A new path within the document, through the history API, is written at once, with the title as it stands. A title the page sets later is not a navigation. The next action or look reads it.

`cause` is one of three:

- `goto`: the navigation a `goto` started.
- `action`: a navigation the page asked for while an action's input was on its way. For a click, a key or a scroll, that runs from the input until Retest's next call into the page has answered, since Chrome can report a link's navigation after the click itself has answered. For `select`, it runs until the call that sets the selection has answered.
- `page`: anything else, such as a redirect the page makes on its own after it loads, a timer, or the browser. A navigation a `setTimeout` in a click listener starts is the page's.

A navigation that a `goto` or an action started names that command's step in `stepId`, and where the command is in the test file in `location`. That holds however late it commits, as when Chrome reports a link's navigation after the next command has begun. Any other navigation names the step the test was in when it committed, and has no `location`.

A problem no single test explains, such as a browser that did not start, is the run's own `failure` in `run.finished` and `result.json`. A file whose process failed outside its tests has a `failure` of its own, and a `file.failed` event.

Paths inside the folder are relative, so the folder can be moved. The JSON Schemas for events and results are in `dist/schemas` after a build.

## Use Retest from code

A program can run tests itself, with no command line. This guide calls such a program a host. A host runs Retest on its own machines, often for apps it did not write. The root export stays the authoring API, and a host uses two subpaths:

- `@rehearsal-labs/retest/runner` exports `runFiles`, `collectFiles`, `validateConfig`, `resolveSecrets`, `readRunFolder`, `defaultTimeouts`, `mergeTimeouts`, `RunFolderError`, `RunFolderReadError` and `LaunchError`, and the types a caller needs: `RunOptions`, `StopReason`, `HostCheck`, `RunFolder`, `CollectOptions`, `CollectResult`, `LoadedConfig`, `ResolvedSecret`, `ResolvedSecrets`, `Reporter`, `ChildOutput`, `LaunchBrowser` and the browser contract a custom launcher implements, `PageNavigation` included.
- `@rehearsal-labs/retest/protocol` exports the event, result, command and failure types, their schemas, `parse`, `testId` and `testTitle`, `defaultTimeouts` and `mergeTimeouts`, `eventSchemaUrl` and `resultSchemaUrl`, the file URLs of the JSON Schema files, and `eventsFile`, `resultFile` and `logsFolder`, the names of a run folder's files. `PageFacts`, `NavigationCause` and `OptionChoiceRecord` are among its types.

The root export adds `OptionChoice`, `ScrollDelta` and `SecretContext` for code that passes options, distances or a secret's context on.

### The config in memory

`defineConfig` and `validateConfig(value, path)` work in memory. `path` is a label. Relative paths in the config start from its folder, and `run.started` records it, relative to the root, as the run's config. No file has to be behind it.

`resolveSecrets(config, env)` gives the map `runFiles` takes in `apps.secrets`. It reads each `env` source from `env` once, and keeps each function source to call on every use. A missing, empty or short value is a failure that names it. A host that gives every secret as a function passes `{}`.

```ts
import { chromium, defineConfig } from '@rehearsal-labs/retest'
import { defaultTimeouts, resolveSecrets, runFiles, validateConfig, type Reporter } from '@rehearsal-labs/retest/runner'

const loaded = validateConfig(
  defineConfig({
    apps: { web: chromium({ baseUrl, proxy: { server: proxyUrl, bypass: ['<-loopback>'] } }) },
    secrets: { password: () => vault.read('password'), code: () => inbox.latestCode() },
  }),
  join(root, 'host.config.ts'),
)
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)

const result = await runFiles(
  {
    files: [file],
    rootDir: root,
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: defaultTimeouts,
    outputDir,
    headless: true,
    signal: stop.signal,
    hostChecks: { [file]: [{ kind: 'address', origin: baseUrl, path: '/' }, { kind: 'text', text: 'Release checklist' }] },
    testEnvironment: { CANARY: 'visible' },
  },
  [reporter],
)
```

This is the heart of [examples/host/host.ts](../examples/host/host.ts). A test file can live anywhere, in a folder with no `node_modules` too. Its process loads `@rehearsal-labs/retest` and its subpaths from the copy of Retest that runs it, whatever copy sits beside the file.

### Host checks

`RunOptions.hostChecks` holds checks the parent process runs itself, after a test's body, on the page the test left. A test passes only if its body and its checks pass. They are the part of a verdict test code cannot write. There is no config key or command line flag for them.

Keys name what the checks apply to:

- A test id, `file > describe path > name`. `testId(file, testTitle(name, describePath))` from `/protocol` builds one. The checks apply to every variant of the test.
- A file, POSIX and relative to the root, as `run.started.files` lists it. Its checks apply to every test collected from that file, setups included, and come before a test's own checks.

Two kinds of check:

- `{ kind: 'address', origin, path? }`: the page's origin must equal `origin`. With `path`, a string must equal the page's path, and a `RegExp` must match it. The query and the fragment are never read.
- `{ kind: 'text', text, ignoreCase?, absent? }`: the page's visible text must hold `text`. The visible text is `document.body.innerText` of the top-level document, with whitespace read as locators read it. Frames, shadow roots and hidden elements are not in it. The check is case-sensitive unless `ignoreCase`. With `absent`, the text must not be there. A document with no body, such as an XML or SVG page, has no visible text, so a text check on it fails, with `absent` too, and its `actual` says `body: false`.

Every check also takes `app`, the app whose page it reads, which defaults to the test's first app, and `name`, which reports show. `timeoutMs` is how long it may look, the assertion budget by default.

Before any test runs, the run refuses each of these as a usage error, exit 2, and starts no browser: a key that names no selected test and no selected file, a check whose `app` the test does not use, an `origin` that is not an http or https origin, a `RegExp` with the `g` or `y` flag, empty `text`, a `timeoutMs` that is not a whole number from 1, and any key a check does not have. A typo never gives a green run.

How the checks run:

- After the body and its `afterEach` hooks, and before the failure screenshot, before a setup's state is saved and before the pages close.
- Only when the body passed. When the body failed, or the test did not run, every check is listed as `not_run`.
- In the order given, and all of them: a failed check does not stop the next.
- Each looks at once, then again after waiting 50, 100, 250 and 500 ms in turn, then every 500 ms, until it passes or its time runs out. It only reads the page, so nothing repeats. While the browser is opening another document, a check waits for it. A document that commits while the checks run is written as a `navigation` like any other. It has no step, since the body is over, unless an action of the body started it.

The verdict:

- A failed check fails the test with `host_check_failed`, exit 1, like any failed check. The first check that failed is the test's failure, and the others are in `failure.details.also`.
- The failure screenshot is taken after the checks, so it shows the page they read.
- A check that could not read the page makes the test an error with `session_lost`, and the checks after it do not run. That is a page or browser that was gone, or a page that answered no read in the check's whole time.
- A failure of ours, such as a lost browser, is the test's failure even after a check that failed. The test is then an error, and the failed checks before it are in `failure.details.also`, in order.
- An interrupted run stops the checks, and the test ends `interrupted`.

An `absent` check passes at once on a blank page. Pair it with an `address` check.

A check sees the final page, not the steps to it. It cannot tell whether the test reached that page by the flow you meant. It can require that no `goto` opened that page: of the app's navigations before the checks, the last one whose `cause` is not `page` must say `cause: 'action'`. Leave out the navigations the page made on its own, such as an app that tidies its address as it loads, or a script that sends it on. They come after the navigation that brought the test there, and do not say who opened the page. That says nothing about the steps before that navigation.

The parent writes `host_check.passed` or `host_check.failed` for each check, with the check, the app, what the page showed on the last look, how many times it looked and for how long. `run.started` records every check the run was asked for, so a reader can tell a check that was never asked for from one that is missing. Each test's result lists its checks in `hostChecks`, in order, with `passed`, `failed` or `not_run`. A check's `text`, `name` and `path` are redacted as page text is, since a host holds the run's secrets and writes every field of a check; the page is still asked for the text, and the path still matched, as written.

Reports show a failed check as a card of its own:

```text
    Host check failed  address on web
    Expected         http://127.0.0.1:4173/
    Page             "Account" at http://127.0.0.1:4173/account
    Waited           303 ms, looked 4 times, limit 300 ms
```

A check that did not run is a `Not run` line on the test's card. The summary gains a row such as `Host checks  4 failed · 10 passed · 1 not run`. Passing checks add nothing else. The agent report writes a line such as `host_check_failed address on web expected http://127.0.0.1:4173/thanks, page "Your cart" at http://127.0.0.1:4173/cart`.

The command line cannot give host checks, so a report of a run that had them prints no command to run a test again. Each card points to `retest inspect` instead. The same goes for a run whose config has no file behind it.

### What a pass rests on

Every time the parent answers the test file's process with what the page showed, it writes an `observation` event first. Each look has an id, `o1`, `o2` and so on, counted within the attempt. Nothing is skipped: an assertion that looked 13 times writes 13 events. `observed` holds what the process received, redacted, so page text that holds a secret reads `{{name}}` there.

A locator assertion names the look its verdict rested on, its last, in `observationId`. The parent then judges each passed locator assertion again, on that look, with the same rule. It writes the matcher, the expected value, the comparison, the actual value and the page address from its own records, never from what the test file's process sent.

`assertion.passed` says who judged it, in `judgedBy`:

- `parent`: a locator assertion the parent judged on the look it names.
- `child`: a value assertion, such as `toBe` or `expect.poll`. The values live only in the test file's process, so the pass is that process's own word. `inspect` marks such a pass "reported by the test file".

A test file that sends a pass the look does not support, such as `toBeVisible` on a look that matched nothing, has broken the protocol. The test ends `test_error`, its process is killed, and no `assertion.passed` is written for the claim. A failed assertion carries no mark: a test may always fail itself.

### Stop a run, and say why

`RunOptions.signal` stops a run when it is aborted. Its `reason` may be `'SIGINT'`, `'SIGTERM'` or a `Failure`, such as `{ class: 'interrupted', message: 'The host is shutting down, so it stopped the run.' }`. Any other reason counts as `'SIGINT'`.

A `Failure` is recorded as the run's `failure`, in `run.finished` and `result.json`, and as the failure of each test the run stopped or kept from running. The run's status is `interrupted`, and its exit code is 130. The human and agent reports print it at the end, under "Run failed", also when the run stopped while it was loading a file.

### The test process's environment

`RunOptions.testEnvironment` is the whole environment of each test file's process. Without it, the process gets the parent's environment. Either way, the variables `env` secrets read are removed. A host passes its own credentials in its own environment and gives the tests only what they need. The command line does not set it. On macOS the system adds `__CF_USER_TEXT_ENCODING` to every process.

### Read a run folder

`readRunFolder(folder)` reads a run folder back and checks it against the schemas. It returns `{ source, result, events, warnings }`. A run that stopped before it wrote `result.json` is rebuilt from `events.jsonl` and marked incomplete, and `warnings` says so. A folder that is missing, unreadable or not a run folder throws `RunFolderReadError`. This is how `retest inspect` reads one.

### Two runs at once

One process may call `runFiles` again before the first call ends, with another root and another run folder. Each run starts its own browsers, keeps its own secrets and writes only its own folder and its own `lastRunFile`.

### What a host can trust

- The parent writes every event and stamps its `origin`. Only `step.*` and `assertion.*` events come from the test file's process, and the parent checks their shape and judges every passed locator assertion.
- Actions, navigations, observations, host checks and every outcome are the parent's own facts.
- The `RunResult` that `runFiles` returns, and the events a reporter receives, come from the parent's memory. `result.json` and `events.jsonl` are copies, in a folder the test file's process can write. A host that must trust a run takes the result from `runFiles` and the events from its own reporter, and reads the run folder only for screenshots and logs.
- Each navigation's `cause`, `document`, step and `location` are the parent's facts. A host can require that no `goto` opened the page its checks read.
- The test file's process is not a sandbox. It runs as the same user, can read and write what that user can, and can reach the network. A host that runs code it did not write runs all of Retest inside isolation it controls, such as one container per run.
- Screenshots are not redacted.

### A host-style run

[examples/host](../examples/host) is a host. `host.ts` builds its config in memory and gives the password and a one-time code as functions. It writes [checkout.retest.ts](../examples/host/checkout.retest.ts) into a new folder of its own under the system's temporary folder, with no `node_modules`, and makes that folder the run's root. It sends Chrome for Testing through a proxy, adds three host checks keyed by the file, gives the test process only `CANARY`, and writes no `last-run.json`. Its reporter prints each event as a JSON line as it arrives. At the end it reads its run folder back with `readRunFolder`, and says whether the folder holds the same result and events it got from memory. SIGTERM makes it stop the run with a `Failure` that says the host is shutting down.

The test signs in with a code, follows the account page's link to its tasks, saves a task, and prints which of `CANARY`, `HOST_TOKEN` and `HOST_PASSWORD` it can see. The page the host checks was opened by that link, so its last navigation says `cause: 'action'`.

To run it against the fixtures, from a project that installed the packed tarball, with `host.ts` and `checkout.retest.ts` copied into it:

```sh
node fixtures/task-app/cli.ts --require-header x-retest-proxy --outbox /tmp/outbox.txt   # prints $APP
node fixtures/proxy/cli.ts                                                                  # prints $PROXY
export RETEST_CHROMIUM=/path/to/chrome-for-testing HOST_PASSWORD='correct horse battery staple' HOST_TOKEN=host-only
node host.ts "$APP" "$PROXY" /tmp/outbox.txt /tmp/host-run
```

The first two commands run from this repository. The app refuses every request without the header the proxy adds, so a page that loads came through the proxy. `host.ts` prints the folder it wrote the test into, as `root <folder>`, and leaves it there, since `inspect` shows the test's code from it. Against `--mode wrong-page`, where a save leaves the page on `/drafts`, the same run fails with `host_check_failed` and exit 1.

## Exit codes

- 0: every selected test passed and cleaned up.
- 1: tests ran and at least one failed its checks, a host check included, even if others hit problems.
- 2: nothing trustworthy came out, or a test could not be checked. This covers usage errors, an invalid config, a missing secret, missing files, collection and setup failures, a lost browser, tests that did not run, cleanup failures, results that could not be written, and a selection that kept nothing.
- 130: interrupted with Ctrl+C, or stopped by a program with a `Failure` as the reason.
- 143: stopped by SIGTERM, as a CI runner does on cancel.

SIGINT and SIGTERM take the same path: the running test stops, the run records `interrupted`, writes `result.json`, closes the browsers, stops the servers it started and deletes saved state. A second signal of either kind quits at once, and its exit hooks still end the browsers and servers and delete saved state.

130 and 143 win over 2, and 2 for an untrustworthy run wins over 1.

## What Retest does not do yet

- Browsers: Chromium, Chrome and Edge only. No Firefox, WebKit or Safari, and no real phones, tablets, native or desktop apps. Emulation is a desktop browser pretending.
- Checked on macOS arm64 with Google Chrome 154 and Chrome for Testing 153, and on Linux arm64 inside Docker with Google Chrome 154, Debian's Chromium 154 and Chrome for Testing 153. Milestone 3 ran on Linux only in its own integration checks, with Google Chrome 154 and Debian's Chromium 154. Linux on x86-64, Linux outside a container, Edge, Chrome beta, dev and canary, and CI runners were never run. Windows cannot work.
- The keyboard only presses one key at a time: no Control, Alt or Meta, no key held down across actions, and no text typed key by key. `fill` types text.
- `select` sets the selection by script, so the page's `input` and `change` events for it are not trusted. `scroll` is one wheel event, also on a touch screen: no swipe.
- Host checks are given only by a program, through `runFiles`. They read the final page, not the steps to it, and not frames or shadow roots. A navigation's `cause` says what opened that page, and nothing about the steps before.
- Retest does not sign in to a proxy. Only an `http` proxy was run.
- `--headed`, and `headless: false` in a config, were never run.
- Locators search the top-level document only: no shadow DOM, no frames. No `first()`, `nth()`, `filter()` or chained locators.
- No popups, dialogs, uploads, downloads, network mocking, video or visual comparison. A JavaScript dialog fails the command as unsupported.
- No `lock`, retries, watch mode, `skip`, `only`, custom fixtures or `test.extend`. Files run on workers; the tests of one file do not.
- No `retest install` and no browser download. No HTML report.
- No `toMeet`, `test.eval`, judges or agent session API.
- Test files are loaded more than once: once to plan the run, and again for each visit that runs them. Top-level code runs each time.
- Screenshots are not redacted. A secret the page shows appears in its screenshot.
- A function source's value is hidden only from the moment its source gives it; page text read before that reached the test's process as it was.
- Locators match the page's text as it shows it, not redacted. Retest refuses a locator that holds a whole secret value, but a locator that holds part of one, with the text beside it, can still match it.
- A page that moves the keyboard focus into a frame of another site as the text arrives can receive the text there. Retest reports `outcome_unknown` and names the frame; it cannot stop typing inside a frame it is not attached to.
- Page console messages are not recorded.
- SIGKILL stops Retest without a result. `inspect` reads the folder as incomplete. On Linux, the last line of `events.jsonl` can be cut off; `inspect` leaves it out and says so. The browser profile it left is removed when the next run starts. Nothing stops a server it started, and saved state, with its session cookies, stays in its run folder.
- `list --json` has no published JSON Schema. Events and results do.

## Project documents

- [README](../README.md)
- [Architecture and implementation sequence](architecture.md)
- [First implementation brief](implementation-brief.md)
- [Milestone 1 plan](plans/milestone-1/build-plan.md), [milestone 2 plan](plans/milestone-2/build-plan.md) and [milestone 3 plan](plans/milestone-3/build-plan.md)
- [Implementation handoff](implementation-handoff.md)
- [Contribution rules](../AGENTS.md)
