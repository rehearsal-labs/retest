# Retest usage guide

How to set up, run and read Retest, in detail: the config, the test API, the command line, running Retest from a program of your own, and what Retest does not do yet. The [README](../README.md) is the short tour.

Retest runs TypeScript test files against Chromium-family browsers, through its own runner and its own CDP client, and against Playwright's WebKit build on macOS, through a client of its own for WebKit's inspector. A project has a config with named apps, several browser targets, emulated devices, secrets, tags and sign-in state. Retest has no runtime dependencies, and it downloads a browser only when `retest install` is asked to.

Everything here was checked on macOS arm64, with Google Chrome 154 and Chrome for Testing 153, and on Linux arm64 inside Docker, with Google Chrome 154, Debian's Chromium 154 and Chrome for Testing 153. Milestone 3's first part adds `press`, host checks, observations, a proxy per target and a test environment. All of its checks ran on macOS. On Linux, its own integration checks ran in Docker with Google Chrome 154 and Debian's Chromium 154. Retest handles the SIGTERM a CI runner sends on cancel, but it has not run on a CI runner yet.

Some rules on this page were checked only in unit tests with the fake browser, not on Chrome: a finder after a step that keeps several elements; `first().nth()` refusing; the modifier rules of `press` beyond the shortcuts the Chrome checks press, `Shift+Tab` among them; the macOS editing commands other than `Meta+A`, and several of them, `Alt+Delete`, `Meta+ArrowUp` and `Meta+ArrowDown` among them, appear in no test at all; `check` on a `switch`, `menuitemcheckbox`, `menuitemradio` or `aria-checked="mixed"`; a wheel another element takes; `getByLabel` on a `slider`, `spinbutton` or `switch`; `toContainText` with a `RegExp`; `.not.toBeChecked()` on an element that cannot be checked; `.not.toHaveText()` on no match; and the 65,536-character limit and the "could not judge" negation, which are checked as functions alone.

The package is published on npm as `@rehearsal-labs/retest`; see [the naming check](naming.md). The library and public protocol use Apache-2.0.

## Prerequisites

- Node.js 24.12 or later. Retest loads `.ts` files with Node's own TypeScript transformer, so TypeScript is needed only to check types; see [TypeScript and imports](#typescript-and-imports).
- An installed Chromium, Google Chrome or Microsoft Edge, or a pinned build that `retest install` put in Retest's cache; see [Pinned browser builds](#pinned-browser-builds). Nothing is downloaded unless you ask. Where a path is asked for, give the executable itself, not a macOS app bundle.
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

### Media recording prerequisites and installation

Recording needs `retest-media` and a host-installed ffmpeg. Retest ships no ffmpeg. The source build path is exercised on macOS arm64. Linux x64 with the GNU Rust host target is a planned path and remains unverified. No media build path is provided for Windows, macOS x64 or Linux arm64.

The crate uses Rust edition 2024, which requires Rust 1.85 or later. Its pinned image dependency and the crate itself require Rust 1.88 or later. Put both `cargo` and `rustc` from a matching host toolchain on `PATH`. Install ffmpeg with the host's package manager, such as `brew install ffmpeg` on macOS or `sudo apt-get install ffmpeg` on Debian. ffmpeg must provide the rawvideo demuxer and either libx264 with the MP4 muxer or libvpx with the WebM muxer. The optional encoded input route also needs image2pipe and the PNG or MJPEG decoder. The media process's own probe decides which route is available.

```sh
npx retest install media
npx retest install --list --verify --json
npx retest doctor
# With the pinned crates already cached, prohibit Cargo network access:
npx retest install media --offline
```

`install media` explicitly builds the source carried in the package. No install script runs it automatically. It checks the shipped crate, lock and notices against their source pin, builds with `cargo build --release --locked` in fresh staging and target folders, refuses a changed lock, checks the release binary's version and protocol, and records its source digest, target triple, rustc version and binary SHA-256. Cargo may fetch only the dependencies selected by the pinned lock. Offline mode needs those crates cached already. The package does not vendor crates.

The binary goes under `~/Library/Caches/retest/media` on macOS or `$XDG_CACHE_HOME/retest/media` or `~/.cache/retest/media` on Linux. It uses the same generation lock as the browser installer. A damaged or unverifiable folder is named and left alone; remove that named folder only after its install has ended, then install again. `--list` checks the binary and licence hashes without launching anything; `--verify` also refuses unrecorded entries.

The media discovery function checks the caller's explicit executable setting first, then `RETEST_MEDIA_BINARY`, then the checked cache record. `RETEST_FFMPEG` names ffmpeg when the caller gives none; otherwise `PATH` is searched. An explicit but unusable name refuses setup. No Cargo target folder is searched. To use a developer build, set `RETEST_MEDIA_BINARY` to its release binary. A run that requests no recording needs neither tool. When the config asks for recording, doctor reports the binary, protocol and checksum, Rust build tools when needed, ffmpeg's version and licence line, and the input, encoder and muxer requirements with fixes.

`install media --media-binary <path>` and `install media --media-mirror <url>` accept only an exact prebuilt build with a checksum already pinned by Retest. No published media artifact has such a pin yet, so both commands refuse before reading or downloading a binary. A user-provided checksum cannot make an unverified build trusted. Shipping platform binaries in the package remains a separate release choice.

ffmpeg's licence depends on its build. The Homebrew build exercised here reports GNU GPL version 3 or later and includes libx264 and libvpx. Retest runs it as a separate program and distributes no ffmpeg build. The crate's third-party notices and licence texts, generated from Cargo.lock, ship with the package and are copied beside the installed media binary.

### Pinned browser builds

Retest pins the builds it was tested with: Chrome for Testing 153.0.8010.12 for macOS arm64 and Linux x64, and for macOS arm64 also Firefox 133.0.3, Playwright's WebKit build 2359 (WebKit 26.6), Electron 44.5.1 and the two native executors, WebDriverAgent 16.13.6 and the macOS runner of appium-mac2-driver 4.3.6. `retest install` puts a pinned build into Retest's cache, and only the ones you name:

```sh
retest install --list             # what is pinned for this machine and what the cache holds; downloads nothing
retest install --list --verify    # also reads every file of each installed build again and holds the whole against the pin
retest install electron           # downloads, checks and records the pinned Electron
```

- The cache is `~/Library/Caches/retest` on macOS, and `$XDG_CACHE_HOME/retest` or `~/.cache/retest` on Linux. Each build has a folder of its own, named after its engine, version and platform, with the unpacked build in `build/` and its record in `build.json`: where it came from, the archive's size and SHA-256, the checksums of its executable, its pinned files and its licence notices, and one checksum of the whole build.
- Retest downloads the archive beside the builds and keeps it under a temporary name until its size and SHA-256 match the pin. It deletes one that does not match without unpacking it. Then it unpacks the build into a staging folder and checks it: the executable is there and can run, the pinned files and licence notices are there with their checksums, no link leads outside the build, and the build holds nothing but folders, files and links, with no file that would run as its owner or group. Only then does it write the record, move the build into place and delete the archive. If unpacking fails, it keeps the verified archive, and the next install uses it.
- One install of a build runs at a time on one machine. Another process holding that build's install lock makes the install stop with the lock's path and that process named; the lock goes when its holder ends, however it ends. Retest does not coordinate installs between machines or containers that share a cache, through a network home or a mounted folder: while one of them holds the lock, an install from another is refused. Give each its own cache.
- `--list` and `doctor` report a build as installed only when it is one `retest install` installs and it reads as its pin says. A folder in the cache for a build that `retest install` refuses is listed as not installed by Retest, with the folder to remove; nothing in it is read, and no run launches it.
- An install prints a short notice message, WebKit names the folder keeping its notices, and `install --list` gives one line of licence names per pin. `retest licences` lists the pins carrying notices, `retest licences webkit` prints locally available texts with source and patches pointers, `--list --json` retains every notice file, identifier and checksum, and `doctor` still verifies notices and names missing files.
- `retest install` builds the native executors on this Mac from their pinned commits with the pinned Xcode, from the source checkouts a native run builds from. It clones nothing, and leaves a build already recorded as it is.
- `retest run`, `retest doctor` and `retest install --list` never download or install anything.
- A target's own `executablePath` always wins. `retest install` prints the installed binary's path, which stays the same while the build is installed: give it to `chromium({ executablePath })`, or set `RETEST_CHROMIUM` to it, or to `electron({ executablePath })`.
- `RETEST_DOWNLOAD_MIRROR` fetches from a mirror instead of each publisher. The pinned address's host becomes the first folder under the mirror, as in `https://mirror.example.com/github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip`, and the checksums still apply. Downloads go over https, or over http only from this machine. Retest refuses a mirror address with a user name, password, query or fragment in it, and prints and records only the origin and path of any address.
- `--list --json` prints one document with each pin, its state, where it is installed, and the install command or why it is refused.
- Exit codes: 0 when every engine named is installed; 2 when one is not, or when `--list` finds a build that no longer matches its record or a folder for a build Retest does not install; 130 and 143 when stopped.

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
- `tests/tsconfig.json`, which extends the project's own `tsconfig.json` when there is one and lets `tsc` pass what Retest loads and refuse what it does not; see [TypeScript and imports](#typescript-and-imports);
- `.github/workflows/retest.yml`, only with `--ci github`;
- the `test:e2e` and `typecheck:e2e` scripts in `package.json`, which it creates when there is none;
- `.retest/` in `.gitignore`.

It never overwrites a file. A file that is already there is reported as "left as is", so running `init` twice changes nothing. It installs nothing; it prints the install command.

It asks questions only at a terminal where no coding agent is detected. Each question has a flag: `--app name=url`, `--start "command"` and `--browser chromium|chrome|edge`. `--yes` takes the default for every question without a flag. The default browser is the first one installed where Retest looks: Chrome, then Edge, then Chromium from `RETEST_CHROMIUM`.

A project that does not say `"type": "module"` in `package.json` gets a note: add it, or Node guesses each test file's module format and warns that it did.

## The config

A project's config is `retest.config.ts` in the folder Retest runs from, or the file `--config <path>` names. Retest imports it in its own process only, as it loads test files; see [TypeScript and imports](#typescript-and-imports). The test files never load it.

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
  locks: ['saves'],
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
- `locks` in a test takes only the config's locks. A config that lists no `locks` accepts none.
- `tap()` exists only on an app whose every target emulates a touch screen.
- An iOS simulator or macOS app's page has no `goto`, `select`, `check` or `uncheck`. Its elements take `tap()` on iOS and `click()` on macOS. A wrong method is a type error that says what to use.

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
| `locks` | The shared state tests may hold with `locks`. A run refuses any other |
| `timeouts` | Budgets that replace the defaults. `--timeouts` replaces these in turn |
| `evaluation` | The AI judges, the default judge, their time and limits; see [AI checks](#ai-checks) |
| `diagnostics` | Console and network capture, its strict and required policies and its limits; see [Console and network diagnostics](#console-and-network-diagnostics) |

Names of apps, targets, secrets, tags, states and locks hold letters, digits, `_` and `-`, and start with a letter. A tag cannot be `and`, `or` or `not`. `executablePath`, `appPath` and `start.cwd` are relative to the config's folder. `baseUrl` and `start.ready` are http or https addresses. A key set to `undefined` counts as absent. An unknown key is an error.

An invalid config is a usage error, exit 2, before anything runs. The message names the file and each key at fault, such as `apps.web.baseUrl: expected an http or https URL, received "ftp://tasks.example"`. Every problem is named at once, except that a target whose shape cannot be read stops at that.

### Targets

A target is a browser to run in:

- `chromium({ executablePath?, headless?, emulate? })` runs the Chromium at `executablePath`, or at the path in `RETEST_CHROMIUM`.
- `chrome({ channel?, headless?, emulate? })` runs Google Chrome. `channel` is `stable`, the default, or `beta`, `dev` or `canary`.
- `edge({ channel?, headless?, emulate? })` runs Microsoft Edge the same way.

Each of them also takes `proxy`, described [below](#proxy).

The config accepts Firefox and WebKit targets with `{ browser: 'firefox' }` or `{ browser: 'webkit' }`. WebKit runs on Retest's WebKit driver, described [next](#webkit), and Firefox on Retest's Firefox driver, described [after it](#firefox). Native targets use the runner described below.

### WebKit

A WebKit target runs Playwright's WebKit build 2359 on macOS, over the build's inspector pipe, through Retest's own client. Playwright itself is never loaded.

```ts
export default defineConfig({
  apps: { web: { browser: 'webkit', executablePath: '/Users/me/Library/Caches/ms-playwright/webkit-2359', baseUrl: 'http://127.0.0.1:3000' } },
})
```

- `executablePath` names the unpacked build's folder or the executable inside it. Without it, Retest reads `RETEST_WEBKIT_BUILD`. It looks nowhere else and downloads nothing. `retest install webkit` ships WebKit's licence notices with the build and refuses only while the archive's checksum is unpinned.
- Retest checks the build's `protocol.json` against the one its driver speaks, and fails the test's setup for any other build. `doctor` reads the build without starting it: "WebKit 626.1.6+, build 2359 found; a run starts it".
- Each test gets a browser context of its own. The browser runs with a temporary home, which Retest removes when it closes. Its helper processes, for networking, graphics and web content, run outside its process group: Retest records each one while the browser runs and ends only those. A home that a Retest process killed outright left behind is removed at the next launch.
- `browser.started` names the engine `webkit`, product `WebKit`, version `626.1.6+, build 2359` and build `2359`: WebKit's own version and the exact build revision.
- A WebKit target takes a viewport, a pixel ratio and a user agent. A mobile layout, a touch screen, `tap` or a proxy fails by name.

Where WebKit differs from Chrome, Retest reports what WebKit does, or refuses by name:

- A failed navigation is told in WebKit's words, such as "Could not connect to the server.", not Chrome's `net::ERR_` names.
- A title keeps the control characters WebKit's `document.title` keeps. For example, the raw title `\x9BBell tab \x1B[2J` keeps ESC, while Chrome reads `\x9BBell tab [2J`. Assert the engine's raw title when checking `toHaveTitle`; the record cleans controls for display.
- After WebKit gives up a move through the history, such as back onto a response with no content, the page keeps its document but WebKit's history stays at the entry it gave up. The next `goto` drops the entries after that one, and a later `goBack` goes to the entry WebKit gave up, not to the page that stayed. After such a move, open the page you want with `goto`.
- `getByRole` with a name is refused for a cell, a column or row header, a grid cell or a tooltip whose name comes from its text. An explicit `aria-label` or `aria-labelledby` remains usable. An unnamed native option lookup is refused; a named lookup is refused when a native option could answer it. Use `getByText()`, `getByTestId()` or a role lookup by position with `nth()`, and `select()` to choose an option.
- `select()` chooses several options of a `<select multiple>` only when the requested set is contiguous and reaches the first or last reachable option, or starts beside the first or last reachable option that the list already holds alone. A set with a gap, or an interior set that requires passing an unrequested option, is refused before any key is sent. An unchanged selection sends no input.
- Console and network diagnostics cover the document and its frames on build 2359, including frames of another site. Workers are named as not covered in the capture status.

### Firefox

A Firefox target runs Firefox 133 on macOS on Apple silicon, over WebDriver BiDi, through Retest's own client. No WebDriver server or Playwright is involved.

```ts
export default defineConfig({
  apps: { web: { browser: 'firefox', baseUrl: 'http://127.0.0.1:3000', viewport: { width: 1280, height: 720 } } },
})
```

- `executablePath` names the Firefox binary explicitly; its reported version and build are recorded even when they differ from the tested build. Without it, Retest uses an intact pinned cache build, or the system app only when its version and build match Firefox 133.0.3 build 20241209150345. A damaged cache or a different system build fails setup by name, without falling back. Retest downloads nothing. On any other platform a Firefox target fails setup by name.
- `doctor` reads the binary's version and build from the app's own files without starting it: "Firefox 133.0.3 build 20241209150345 found; a run starts it".
- The default route starts Firefox as a child process. This route has never started a real Firefox in the recorded checks; its process lifecycle is exercised with a stand-in executable that speaks BiDi. All real Firefox checks use Launch Services. A host app that may not read `~/Library/Application Support/Firefox` cannot start a child Firefox. Set `RETEST_FIREFOX_ROUTE=launch-services` on such a machine.
- Each launch gets a fresh profile in a temporary folder, which Retest removes when the browser closes. Firefox allows one WebDriver BiDi session per browser, so every test's page opens in a user context of its own, with its own cookies and storage, inside that one session.
- Firefox keeps running when the Retest process that started it is killed outright. The launch records the Firefox it started, and the next launch ends a recorded Firefox whose launcher is gone, with its folder, and nothing else.
- `browser.started` names the engine `firefox`, the product `Firefox`, its version and its reported build.
- A Firefox target takes a viewport and pixel ratio. A mobile layout, a touch screen, a user agent, `tap` or a proxy fails by name.

Where Firefox differs from Chrome, Retest reports what Firefox does, or refuses by name:

- `fill` types its text key by key, and the input guard counts each key. Text holding a code point WebDriver reserves for a named key, U+E000 to U+E05D, is refused before any key is sent. When the page moves the focus away as the fill starts, the failure names `keydown` as the event Retest stopped, where Chrome names `beforeinput`.
- `select()` on a `<select multiple>` that needs keyboard input is refused before any key is sent, also for a single option. An unchanged selection sends no input and succeeds. Firefox does not expose its native focused option, so Retest cannot verify a move before Space toggles that option. Run a test that changes options of a multiple select on Chrome or WebKit.
- An uppercase letter or a shifted symbol is typed with Shift held, so the page also hears the Shift key go down and up. On macOS, Home follows the system's key bindings and leaves the caret where it was: typing `abcd`, then Home, then X gives `abcdX`. Shift+Home still selects to the start of the field.
- A scroll is one trusted wheel event carrying the whole delta, as on Chrome, and Firefox moves at most one page for it. A delta larger than a page scrolls less on Firefox than on Chrome, so a scroll meant to reach the end of a long text stops short. To reach the end, scroll several times, each by no more than the box's height.
- A refused connection is `not_actionable` with a message ending `connectionFailure.` and `errorText: 'connectionFailure'`, rather than Chrome's `net::ERR_CONNECTION_REFUSED`. Assert Firefox's own error text. A raw title keeps ESC, for example `\x9BBell tab \x1B[2J`; Chrome reads `\x9BBell tab [2J`. Assert that exact raw title when checking `toHaveTitle`.
- A page's own script cannot use the Navigation API, which Firefox 133 lacks. Check for that API before listening for `navigateerror`; that event cannot confirm a cancellation here. In the shared fixture, a page that starts a fetch and immediately leaves for another document loses the request on Firefox. Await a required request before navigating, and verify delivery at the server.
- `getByRole` confirms Firefox's names against Retest's whitespace normalization. Every lookup carries its own requested names. Loose and pattern names require Firefox to confirm the candidate names; a source it cannot confirm is refused by name. Password fields use their labelling markup, with hidden, nested or generated label content refused. Roles whose membership differs from Chrome, and known differing native markup, are refused by name rather than returning another set silently. These include generic, caption, presentation, rowgroup and gridcell lookups; named cells and figures; failed images; and the differing date, datalist and editable controls. Native tables with a visible caption or header of their own, or an explicit table, grid or treegrid role, permit row, unnamed-cell and header lookups. A visible native table without those cues still refuses table roles because the engines may disagree about layout tables. A cell looked up by name remains refused: Firefox's accessibility locator does not name it from its text. Use `getByText()`, `getByTestId()` or an unnamed cell's position with `nth()`. An `img` lookup is refused when an image that did not load could answer it.
- `frame()` returns one PNG of the page. There is no live frame source.
- Diagnostics record the network only. On Firefox 133.0.3, the console subscription runs enumerable getters in logged objects, including nested objects, before Retest receives the entry. The tested strings, numbers, plain data object and DOM node ran no getter. Subscription serialization options do not prevent object getters, and filtering received entries for primitive arguments is too late. Retest therefore keeps console `unavailable`; a strict console or runtime-error rule fails as "could not judge". Requests of the page and its frames, of its own site or another, are recorded with their responses, redirects, failures and pending ends, as on Chrome. A request a dedicated worker makes is recorded as its page's, since Firefox names only the browsing context, and only a navigation's request has a resource type, `Document`.

### Native apps

Retest drives iOS simulator apps and native macOS apps through its runner. The reference flow ran on real targets: one test signed in on TaskPhone on iOS Simulator 26.5 with `secret()`, created a task there, changed it in Chrome and saw the change on TaskDesk on macOS. The public swipe, keyboard and alert helpers are built, but they ran only against a stand-in executor, never on a real simulator or desktop. `doctor` still reports native targets as having no driver; that diagnostic has not been connected.

Configure the app bundle and the platform's launch settings:

```ts
const config = defineConfig({
  apps: {
    phone: {
      platform: 'ios-simulator',
      appPath: './TaskPhone.app',
      device: 'iPhone 17',
      runtime: '26.5',
      arguments: ['-reset', '-serviceURL', 'http://127.0.0.1:4310'],
    },
    desk: {
      platform: 'macos',
      appPath: './TaskDesk.app',
      arguments: ['-reset', '-windowFrame', '20,60,700,480'],
      environment: { TASK_MODE: 'test' },
    },
  },
})
```

`appPath` is relative to the config. iOS needs a simulator build, an installed device type and runtime, the pinned Xcode and the pinned executor sources or builds. macOS needs the native executor and Automation Mode already enabled without a prompt, and its window capture needs Screen Recording for the terminal or agent that runs Retest, which `retest doctor` checks. A prompt is a refusal; Retest does not accept it. A native target takes no `baseUrl`, viewport, browser emulation, proxy or saved browser state. An app's targets must share one kind.

`arguments` and `environment` are optional. Retest refuses its own debugging and data-folder switches by name, executor environment names and malformed settings. Argument and environment values are excluded from execution settings: those settings retain their counts and SHA-256 hashes. Variables that supply secrets or host credentials are withheld from native tools and the launched app, including an attempted explicit environment override.

After registering the config's type, a test gets native handles under the app names:

```ts
test('shows the account field', { apps: ['phone', 'desk'] }, async ({ phone, desk }) => {
  await phone.getByTestId('account-field').fill('ada')
  await expect(phone.getByTestId('account-field')).toHaveValue('ada')
  await desk.getByTestId('sign-in-button').click()
})
```

A test may use one macOS app and one iOS app beside web apps, as the reference flow does with the phone, Chrome and the desk. The desktop's executor and each simulator serve one app session at a time, so a test with two macOS apps, or two apps on one simulator device type and runtime, is not run: the run refuses it by name before anything starts for it.

Native locators use accessibility identifiers through `getByTestId`, supported roles through `getByRole`, labels through `getByLabel` and text through `getByText`. These finders can be chained to scope a lookup, with `first`, `last` and `nth` picking a match. CSS, placeholder lookup and web navigation are refused even when a test forges a command. Each action needs exactly one match. iOS takes `tap`; macOS takes `click`. Both expose `fill`, `press` and `scroll`, and `locator(step)` takes a step written as data. An iOS page also has `swipe`, `keyboard.wait()`, `keyboard.dismiss()` and `keyboard.dismissFirstRunCard()`; a macOS page has none of them, as a type error, and the runner refuses them as `unsupported` if a test reaches them anyway. `alert.accept('Allow')` and `alert.dismiss('Not Now')` press the one button with that label on either platform.

The native assertion types expose `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toHaveText`, `toHaveValue`, `toBeSelected` and `toHaveCount`, with `.not`. The parent judges them from its scoped native tree, and a verdict supplied by the test process cannot soften a failure. A property the platform does not expose is unsupported, including selected state on an element without one. Text checks on editable fields are refused; use a value check. The native layer refuses stale references, records input whose outcome is unknown and never resends it.

An iOS test starts a fresh simulator after it acquires all its resources, and shutdown deletes that simulator. A macOS app's data and keychain are kept. `-reset` requests the app's own reset when it offers one; this is recorded as an app request and does not claim OS isolation. Backend state remains external unless the host declares a preparation. A desktop or device lease comes free only after its native session and runtime end; an uncertain shutdown retains the lease. Retest never adopts or ends an app copy it did not launch.

A native secret destination is the exact bundle identifier in `secretOrigins`, such as `dev.retest.fixtures.taskphone`. It is not a web origin. A `fill` with `secret()` types into a native app only once `secretOrigins` names the bundle identifier Retest read from the installed app; the executor's output is redacted a whole line at a time before it is written. Text redaction does not protect image pixels.

`native.started` records the app bundle, build, checksum, OS, executor pin and Xcode beside the session id. `native.ended` keeps unresolved action outcomes. Result files and `inspect --test` retain native sessions and named capture sources. iOS executor-screen capture was exercised through the runner. A macOS app's window capture takes the app's own window by its window number, so another app's window over it is neither in the image nor a reason to refuse it, and it needs Screen Recording for the terminal or agent that runs Retest. Capture writers use the run's clock; older store callers retain the clock inferred from events as a fallback. Events remain at `schemaVersion: 1`; old strict readers refuse the new event types and fields.

Retest finds Chrome and Edge where they install: on macOS in `/Applications` and `~/Applications`, and on Linux in the standard paths. A browser that is not there is a setup failure that lists the paths it tried, before any test that needs it. Only `chrome()` stable and `chromium({ executablePath })` were run. Edge and the other Chrome channels were not installed on the machine Retest was checked on.

`headless` defaults to true. `--headed` shows every browser. Nobody has run a browser with a window yet.

Targets on the same executable, with the same headless setting and emulation, share one browser process. Each distinct target launches once, the first time a test needs it, and closes when the run ends. Every test gets a new browser context and page for each of its apps.

### Electron apps

`electron({ executablePath, appPath, args?, userDataDir? })` is a desktop app built on Electron. Retest drives it with its Chromium driver, over the app's own debugging pipe.

```ts
import { defineConfig, electron } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    desktop: electron({ executablePath: 'electron/dist/Electron.app/Contents/MacOS/Electron', appPath: 'desktop' }),
  },
})
```

- `executablePath` is the Electron binary. On macOS it is the file inside `Electron.app/Contents/MacOS`. `appPath` is the app's folder, which holds its `package.json`, or its entry file. Both are relative to the config's folder.
- `args` reach the app after its path. Retest sets the debugging pipe and the data folder itself, so an argument that starts with `--remote-debugging-` or names `--user-data-dir` is refused. A secret never goes in `args`: give it through `secrets`. Each attempt's record keeps the arguments as their count and the SHA-256 of their list, never their text, so a change to them changes the configuration fingerprint. A short secret could still be guessed from that hash.
- An Electron app has no address. It takes no `baseUrl`, and no `headless`, `emulate`, `viewport` or `proxy`. An app's targets are all Electron apps or none. It may carry `start`, for a server the app talks to.
- No two Electron targets may name the same `userDataDir`. The config is refused, naming both, since each target's launches would wait on the other's.

How a test runs:

- Each test launches the app afresh, in a process group of its own, and quits it when the test ends. Retest closes the app's debugging pipe, which Electron quits on, waits up to one second for the app's processes to end, and kills any that are left.
- The first window the app opens is the test's page. What Retest's own checks ran there: `getByTestId`, `getByRole`, `getByLabel` and `getByText` with `first()` and `nth()`; `fill`, `click`, `press` and `check`; `toHaveText`, `toHaveCount`, `toBeChecked`, `.not.toBeChecked()`, `toBeVisible`, `toHaveTitle` and `toHaveURL`; `page.url()`, `reload()`, `goBack()` and `goForward()`. The rest of the page API goes to the window as it goes to a Chrome page, and was not run on Electron.
- Without `userDataDir`, each launch gets a new data folder in the temporary folder, as a browser's profile does. Retest removes it, with whatever the app stored in it, after confirming the app's processes have ended. A folder left by a run that was killed outright is retained: a later run cannot prove it is still disposable.
- With `userDataDir`, every launch uses that folder, so the app keeps its data from one test to the next. Retest leaves the folder as the app left it, and each attempt's record says the app's storage was reused, not fresh. Launches of the target take turns on the folder, each starting once every process of the one before it has gone.
- Fresh means a new Chromium data folder and nothing more. What the app keeps elsewhere carries over from one launch to the next. This includes the user defaults of the binary's bundle (`com.github.Electron`, shared by every unpacked app run on Electron's own binary), the binary's cache under the user cache folder, `~/Library/Logs/<app name>` when the app writes logs there, and any file the app writes outside its data folder.
- The app never sees the environment variables that judges' credentials come from. It never sees `ELECTRON_RUN_AS_NODE`, which would make the binary run as plain Node. Nor does it see Electron's logging variables, such as `ELECTRON_ENABLE_LOGGING`, which would print its windows' console lines into its output.
- The app's output goes to its browser log. A run that passes its redactor to the launch writes each line redacted, so a secret the app prints shows as its placeholder.
- On macOS the app gets Chromium's fake keychain, so its safe storage stays out of your login keychain.
- The app's windows open on your screen. Electron has no headless mode.

What Retest refuses, by name:

- `page.goto()` on an Electron app is a type error: "An Electron app has no address. Its page is the first window the app opens." If it runs anyway, it fails as `unsupported`.
- A test cannot reach any window after the first. Each launch writes `electron/<app and target>/<launch>/windows.json` in the run folder. It lists every window in the order Retest learned of it, with when it opened and closed and whether a test could reach it. A window already open when Retest began to watch is marked `existing`, and its opening time is when Retest learned of it. The browser log notes each new window. When the app closes its first window, the next command fails with `session_lost`, and the message says no other window is reachable.
- The main process, native menus and native dialogs: a test reaches only what the first window shows.
- Sign-in state: a test cannot restore one into an Electron app, and a `test.setup` on one runs its body, then fails as `unsupported` when Retest cannot save its state. Use `userDataDir` to keep the app's data.
- In an Electron window a secret is typed only on an http or https origin that `secretOrigins` lists for it. The base URLs of the test's other apps do not count there. A window on a `file://` address has no such origin, so the fill is refused. A window the app serves from `http://127.0.0.1:<port>` takes the secret once `secretOrigins` names that origin.

On Electron, a page's origin is whatever the app says it is: an app can show its own page under any address, as Retest's fixture shows its page under its service's. Naming an origin in `secretOrigins` therefore means trusting the app with the secret. A web app's `baseUrl` never lets a secret into an Electron window, even when the window shows that origin.

The app opens its first window as it starts, and Electron answers on its pipe only once the app is ready, so the window's page has usually loaded before Retest reaches it. Retest reads the page's address from the window itself, so `page.url()`, `toHaveURL` and the secret rule know it from the start. When Retest reaches the window before its first document has arrived, a secret fill waits for that document within the fill's time. Retest's own scripts start in that page after the app's scripts have run. If Retest cannot start its change observer there, `windows.json` and the browser log note it, and checks in that page wait out their timers instead of waking on a change.

Console and network diagnostics come from the first window, and they are always `partial` there, with the reason: "the app's window was already showing its page when capture began, so what the page logged or loaded before then was not captured". Today, a diagnostics policy with `requireComplete` fails every Electron test for that reason: Retest cannot reach the window before the app's own page has run, so the start of every capture is missing. Each capture also says it does not cover the app's main process or its other windows, and why. An app's requests made from its main process are not captured.

`browser.started` comes for each launch. Its `product` is `Electron`, and its `version` is the Electron release. Retest reads the release from the binary's files: the Electron framework's bundle on macOS, or the `version` file beside Electron's own build. When the files name none, as a packaged app's may not, it reads the release from the user agent the app reports. `target.electron` holds that release and the Chromium it embeds, as the app reported it. Launches after the first carry `instance`. The human report prints `started desktop=electron  Electron 44.5.1 · Chromium 152.0.7977.130` and marks the target `(Electron)` on every test line and failure card.

`doctor` checks that the binary is a file it may run and that the app is there. It names the Electron release when the binary's files state one, and says so when they do not. It does not start the app.

An Electron app can be one of several apps in a test, as a browser can. Retest's own check names two apps, an Electron target and a Chrome target, in one test. The test creates a task in the Electron window and reads its id from the window's address. It then opens that task by its id on the web, marks it done there, and waits until the Electron window shows it done. When the service never passes changes on to the web, the same test fails at the web's check, which names the task's id, and nothing after that check runs.

Checked with Electron 44.5.1 on macOS arm64, from the official release. Linux, Windows and packaged apps were not run.

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

`viewport: { width, height }` on a target sizes its pages and nothing else, as in `chromium({ viewport: { width: 1280, height: 720 } })`. It is the same as `emulate: { viewport: { width, height }, deviceScaleFactor: 1, touch: false }`: no touch screen, a pixel ratio of 1, and the browser's own user agent. A target takes `viewport` or `emulate`, not both; a config with both is refused before anything runs. A native app takes neither.

An emulated target is marked "emulated" in every event, result and report, a target with a viewport included. A named device sends no user-agent client hints, so the page sees only the device's user agent.

On a touch screen, `click()` is sent as a tap and recorded as a tap.

### Starting the app server

An app with `start: { command, ready, cwd?, timeoutMs? }` gets its server started when a test first needs it:

1. Retest asks `ready` with an HTTP GET. Any HTTP answer counts, whatever its status.
2. If something answers, Retest uses that server and never stops it.
3. Otherwise it runs `command` in a shell, as a process group of its own, with its output in `logs/app-<name>.log`. It waits for `ready` within `timeoutMs`, or the setup budget.
4. When the run ends, it sends the group SIGTERM, then SIGKILL after one second.

A server that exits early, or never answers, is a setup failure for every test that needs it: they do not run. The server's output is in its log, and the failure says where. If Retest itself is killed with SIGKILL, nothing is left to stop a server it started.

### Locks

Tests in different files run at the same time, so two that share something outside the page, such as one inbox, one staging account or one counter on a server, can disturb each other. A lock keeps them apart:

```ts
// retest.config.ts
locks: ['inbox'],

// a test file
test('reads the code from the inbox', { locks: ['inbox'] }, async ({ page }) => {})
```

- Two tests that hold a common lock never run at the same time, across workers and browsers. Tests that hold different locks, or none, run beside them as before.
- A test takes all of its locks at once, or waits and takes none, so two tests cannot each hold what the other waits for. `test.describe` passes its `locks` down, and a test's own add to them.
- When a lock frees, the waiting tests are served in the run's order, the one planned first going first. A test that waits for two locks keeps both from every test planned after it, so it is never overtaken for ever.
- A test waits for its locks before anything is launched for it and before its budget starts. The wait counts against none of its budgets, and its `durationMs` leaves it out.
- `lock.acquired` records, before `test.started`, the locks an attempt holds, how long it waited for them in `waitedMs`, and in `heldBy` the tests that held one of them when it asked. The human report adds `holds lock inbox, after waiting 2.1s` under the test, then `held by` and those tests when it had to wait. `inspect --test` shows the first line in the timeline.
- A lock name must be in the config's `locks`. Any other, or any lock when the config lists none, fails its file with a usage error that names the declared ones. Without a config, as with `--browser`, any name holds.
- A lock belongs to one run and lasts one run. Two runs at once, even two in one process, do not see each other's locks, so a named lock never keeps two runs apart. The Mac's desktop, a simulator and an Electron data folder are different: one table holds them for every run in the process (see Resources and leases).

The example's count of every save holds the lock `saves`, as does every test that saves; [examples/tasks](../examples/tasks) shows it.

### Resources and leases

A test holds everything it needs before it acts on any app. Retest works out what that is from the test's apps and locks:

- each lock the test holds
- the Mac's interactive desktop, for a macOS app
- its simulator, for an iOS app
- the data folder, for an Electron app whose target names `userDataDir`
- one session for each app, when the host gave `sessions`

A browser target needs nothing of its own. Each test gets a new browser context, so tests on one browser run side by side. An Electron app without `userDataDir` gets a new folder for each launch, so it needs nothing either. Two apps on one data folder take it once. A test with two apps on the desktop, or on one simulator device type and runtime, is not run at all: the run refuses it by name before it acquires anything, since one app session runs on each.

A data folder is held under its real path: a link and the folder it points to are one folder, and on a volume that ignores case, so are `.data/Desk` and `.data/desk`. Retest reads a volume's case rule by writing a small file in a temporary folder beside the data folder, looking for it with its name's case turned over, and removing it. When it cannot write or read that file, the test does not run, with `setup_failed`, rather than guess.

How a test gets them:

- Every test acquires in one order, in three steps. Its locks come first, from the run's own table: a named lock keeps the tests of one run apart, never two runs. The desktop, simulators and data folders come next, from one table that every run in the process shares, since a Mac has one desktop and a folder is one folder whichever run names it. Sessions come last, from the host's budget. Within a step everything is taken at once or not at all, and within a kind it goes by name.
- A test holds each step while it waits for the next, and never waits for anything earlier in the order than what it holds. So no two tests can each hold what the other waits for.
- Nothing starts for a test until it holds all of it. No browser context opens, no Electron app launches and no host preparation runs before then. The run does not start any Electron app early, so with one session and four workers, one Electron app runs at a time.
- A test waits for a lock for as long as the test holding it runs, as before; that test is bound by its own budgets.
- A test waits for the desktop, a simulator or a data folder for as long as the test holding it is inside its lease. Once that lease has expired, it waits at most the setup budget more.
- Sessions wait at most `waitMs` from the moment the test asks, as before.
- A test that does not get everything it needs does not run. It ends with `setup_failed`, the failure names what it waited for and who held it, and it gives back whatever it held. Only tests of the same run are named. Another run's holders are counted, never named: `heldElsewhere` for the desktop, simulators and data folders, and `heldByOthers`, the sessions every other run holds, whatever its owner.
- Waits count against none of the test's budgets. Its `durationMs` leaves them out.

How a test gives them back:

- In the reverse order, however the test ended. That includes a launch that failed, a host preparation that failed, a browser lost while the pages opened and a stopped run.
- Sessions come back once the test's browser contexts close, as before.
- A data folder comes back once every Electron app the run launched on it has gone, including a launch the run gave up waiting for, whose app may still come up. A desktop or a simulator comes back once whatever made its app ready says its native session has ended. The runner supplies that signal from native shutdown. A free signal that fails says nothing, so the part stays held.
- What a test holds while it runs is its lease. Once the test lets go, a desktop, simulator or data folder has the cleanup budget to come free. One that does not expires the lease and stays held until it is free, so no other test gets it while it may still be in use. The locks after it in the order come back.
- An Electron app launched for a test is quit before the test's result is written: by closing its page, or, when its page never opened, by the runner. An app that is not gone within the cleanup budget is a `cleanup_failed` beside the test's outcome. A test that passed then ends `error`, and a test that already failed keeps its failure.
- A stopped run withdraws every test still waiting, and none of them runs. When the run ends, it waits up to the cleanup budget for what is still coming free. A desktop, simulator or data folder whose app is still there then stays held, past the run's end, and its lease is recorded as expired, so no later run in the process is handed it.

What the run folder records:

- `lock.acquired` comes when the locks are granted, with the same fields as before.
- `resource.acquired` comes when the desktop, simulators and data folders are granted. It lists them in `resources`, with `waitedMs`, the tests of this run that held one in `heldBy`, and in `heldElsewhere` how many another run held.
- `session.reserved` comes when the sessions are granted, with the same fields as before.
- `lease.taken` comes once the test holds everything, before `test.started`. Its `lease` lists what it covers in the acquisition order, when it was taken in `takenAt`, and `releaseWithinMs`, the cleanup budget.
- `lease.expired` names what did not come free in time in `held`, and in `released` what had really come back by then; sessions whose browser contexts could not close are not among them. It comes after the test's `test.finished`, or as the run ends.
- Each session in an attempt's execution record names its `resource`: `browser-context`, `app-launch`, `data-folder`, `desktop` or `device`.
- The human report prints `holds the data folder /work/.data/desk of desk=electron, after waiting 1.2s` under the test. When a test waited for a lock or a resource, a line under it now says who held it: `held by tests/a.retest.ts > a holds the folder`, or `held by another run in this process`. The failure card of a test that did not get what it needed lists `Waited for`, `Held by`, `Other runs held` or `Others held`, and what it `Gave back`.
- A reader built before this release refuses a run folder in which any test held a lock, a resource or sessions. `lease.taken`, `resource.acquired` and `lease.expired` are event types it does not know. Every attempt's execution record also carries `resource` now, so it refuses every run folder with an attempt in it.

Limits:

- Locks last one run, as before, and never keep two runs apart. The desktop, simulators and data folders last as long as the process. Two processes on one Mac do not see each other's leases; the desktop's lock, and the lock on a native app's declared network file, are held across processes.
- Native runtimes start only after the test has acquired its complete lease. The native sign-in flows remain blocked as described above.
- Commands to one app go one at a time. The test file's process refuses a second while one runs, with `concurrent_commands`, and the parent refuses one that reaches it anyway, as the parent's own failure.

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
- `locks`: the shared state it holds while it runs, described under [Locks](#locks).
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
- `test.skip(name, options?, fn)` declares a test that does not run, and `test.describe.skip` a block whose tests do not. Each is reported as `skipped`, its own status and never a pass: no `test.started`, no pages, no setup run for it, and `skipped` in `counts`. `test.finished` records it. A skipped test inside a block marked only is still skipped. A check a host requires of a skipped test, a host check or an AI check, is not made, and test code cannot waive it, so the run cannot pass; see [Host checks](#host-checks).
- `test.only(name, options?, fn)` and `test.describe.only` single out tests: a run keeps only those, in every file it loads, and leaves the rest out. Inside a block marked only, every test runs unless a test or block within it is marked only too. Setups the kept tests need still run. [Choosing tests](#choosing-tests) says what a run with `only` prints, and why CI refuses it.

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
| `getByPlaceholder(text, { exact? })` | Elements whose `placeholder` attribute matches |
| `locator(selector)` | Elements a CSS selector matches, as `querySelectorAll` matches it |

How names and text match:

- Both sides are trimmed, and each run of spaces or line breaks reads as one space.
- `exact` defaults to true: the whole string, case and all. `name: 'Save'` never matches "Save draft" or "save".
- `exact: false` matches any part, in any case. `name: 'save', exact: false` matches "Save", "save" and "Save draft".
- A `RegExp` in place of the text, or as `name`, is searched for anywhere in the trimmed text, with its own flags: `getByText(/^Saved \d+ tasks$/)` or `getByRole('button', { name: /save/i })`. A `RegExp` takes no `exact`, and giving both fails `usage`.

Finding inside a locator:

- Every finder above is also a method of a locator. It finds elements inside the elements that locator keeps, never those elements themselves: `page.getByTestId('inbox').getByRole('button', { name: 'Delete' })`.
- A step looks inside every element the step before it kept, so `page.locator('li').getByRole('button')` finds the buttons of every list item.
- `first()`, `last()` and `nth(index)` keep one of a locator's matches, by its place in the document. `nth` counts from 0, and from the end when negative, so `nth(-1)` is the last. An index past the matches keeps none, and an action waits as it does for no match. A locator chooses once: `first().nth(1)` fails `usage`. Choose, then find inside: `getByRole('listitem').nth(1).getByRole('button')`.
- An action or a matcher that finds nothing names the step that kept nothing, as in "getByTestId('trash') matched no element" or "getByRole('listitem') matched 4 elements, and nth(9) keeps none of them."
- Reports, events and failures write a chain as the test wrote it. An event's `locator` holds the last step, with the steps before it in `within`.

CSS:

- `locator(selector)` takes CSS only. XPath, such as `//button`, and Playwright's selector engines, such as `text=Save` or `div >> span`, fail `usage` before anything is sent.
- A selector the browser cannot read, such as one with `:has-text()`, fails at once as `usage`, with the browser's reason.
- Inside a locator, a selector matches as that element's own `querySelectorAll` does: the elements below it that match, and a combinator may reach above it.

Where the name comes from:

- `getByRole` and `getByLabel` use the accessibility tree Chrome computes. So the name comes from `aria-label`, `aria-labelledby`, `<label for>`, a wrapping `<label>`, `title`, a placeholder or the content, as Chrome decides. Retest does not compute names itself.
- Chrome gives a table row or a list item a name only from `aria-label` or `aria-labelledby`, not from its text, as Retest reads its tree. So `getByRole('row', { name: 'Ada 36' })` is expected to find no row of a plain table; no check asks for a row or a list item by name. Retest's checks find a row by its place, as in `getByRole('row').nth(1)`, and a cell by its name. Find the row by its place or by a test id.
- They leave out elements Chrome leaves out of that tree: `aria-hidden`, `display: none`, `hidden`, `visibility: hidden` and `inert`.
- `getByText` reads the text in the page. It skips `script`, `style`, `template` and `noscript`. It finds hidden elements too, and reports them as not visible.
- `getByPlaceholder` reads the attribute as the page wrote it.

All of them search only the top-level document. They do not look into shadow roots or frames. A Playwright test file run with `--playwright` finds by Playwright's rules where Retest can; see [Run Playwright test files](#run-playwright-test-files).

### Actions

- `page.goto(url)` opens a URL and waits for the `load` event. A relative URL resolves against the app's base URL. A page that replaces itself before `load` is followed to its own `load`.
- `page.reload()` reloads the page and waits for its `load`.
- `page.goBack()` and `page.goForward()` move one entry through the page's history, as the browser's buttons do, and wait for that page, or for a move within the document. A page with no entry that way fails `not_actionable`, and nothing is sent.
- When the browser gives up the navigation of a `reload`, `goBack` or `goForward` without opening a document, as it does for a response with no content (204), which was run, or a download, which was not, the action fails `not_actionable` at once, naming the address it gave up, with `details.inputSent: true`. The page stays where it was.
- `locator.fill(value)` focuses a text-like `input` or a `textarea`, selects its value and types the new one. `value` is text or a `secret()`.
- `locator.click()` presses the mouse at the element's centre once it is visible, stable, enabled and not covered. On a touch screen it taps.
- `locator.hover()` moves the mouse to the element's centre once it is visible, stable and not covered. A disabled element can be hovered.
- `locator.tap()` taps the element's centre. It exists only on an app whose every target emulates a touch screen.
- `locator.press(key)` focuses the element and presses one key, or one shortcut, on it. The element must be attached, visible and enabled, and keep the keyboard focus once Retest focuses it. There is no check at a point, since a key does not go through one.
- `page.keyboard.press(key)` presses one key, or one shortcut, on whatever holds the keyboard focus, with no checks.
- `locator.select(choice)` chooses options of a `<select>` with the keyboard: by label, by `{ value }`, or a list of them.
- `locator.check()` and `locator.uncheck()` tick and untick a checkbox, a radio button or an element with a checkable role.
- `locator.scroll({ x, y })` turns the mouse wheel at the element's centre. `page.scroll({ x, y })` turns it at the centre of the viewport.

A navigation that `reload`, `goBack` or `goForward` started is recorded with the cause `goto`, as a goto's is.

Two reads tell a test about the page. `await page.url()` is the page's address as Retest records it: its origin and path, with no query or fragment. `await page.title()` is its title, cut to 300 code units and trimmed at its end, or empty for a page with none; while another document is on its way, it waits for that document. To wait for an address or a title, use `toHaveURL` or `toHaveTitle`, below.

Retest checks the element just before it acts, and a guard in the page watches the input itself. If the press, the release or the click lands on another element, Retest stops that event before any listener of the page hears it. The action then fails `not_actionable` and names the element that took it. While the browser is opening another document in the frame, no action starts: Retest waits for that document and looks for the element there, and an action whose time runs out meanwhile fails `not_actionable`, naming the address the page was opening. Typing that arrives in a document that replaced the one Retest checked is stopped by that document's own guard, and the fill fails `not_actionable`, naming the document. Two cases end as `outcome_unknown` instead, because Retest cannot see where the input went:

- the press never reaches the element's document, as when a same-origin frame covers the element;
- the page moves to a new document before the guard reports, and that document received no typing.

The guard covers press, release, click, touch and typing events, the wheel while a scroll is on its way, and the mouse's arrival while a hover is. A hover's `pointerover` or `pointermove` must reach the element. If another element takes it, Retest stops the event before the page's listeners hear it, and the hover fails `not_actionable`, naming that element; the browser's own `:hover` style may already show on it. The mouse's move before a click is not guarded, so hover events such as `pointerover` still reach the page then, and so do the `input` and `change` events a checkbox fires after a click. Downloads are refused: Retest asks the browser to deny them in every context it opens.

### Pressing keys

`press` takes one key, with modifiers when the test names them:

- A named key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp` or `PageDown`.
- One character, such as `a`, `7`, `?` or `é`. Retest presses the key that types it on a US keyboard, with Shift for an uppercase letter or a symbol such as `!`. A character no US key types, such as `é`, is sent as its text alone.
- Modifiers and a key, joined by `+`: `Shift+Tab`, `Control+A`, `Meta+Shift+Z`, `Control+Alt+Delete`, or `Control++` for the plus key. The modifiers are `Shift`, `Control`, `Alt`, `Meta` and `ControlOrMeta`, which is Meta on macOS and Control elsewhere.

How a shortcut is pressed:

- Each modifier goes down in the order written, stays down for the key, and comes up in reverse, so the page hears a `keydown` and a `keyup` for each, as from a person's keyboard. The key's own events carry every modifier held.
- A letter in a shortcut names its key, whatever its case: `Control+A` is `Control+a`. Shift is pressed only when it is written, as in `Control+Shift+T`.
- A shortcut with Control, Alt or Meta types nothing into a field.
- `Shift+` with a character and no other modifier fails `usage`: press the uppercase letter itself. A modifier written twice, or one `press` does not know, such as `Ctrl` or `Cmd`, fails `usage` too.

What the browser does with a shortcut:

- The page's own listeners hear it, so an app's shortcut, such as `ControlOrMeta+K` for a palette, works.
- On macOS, Chrome edits a field only by commands the window system would give it. Retest sends macOS's own command with these shortcuts: `Meta+A` (select all), `Meta+Z` and `Meta+Shift+Z` (undo and redo), `Meta+Backspace`, `Meta` with an arrow key, `Alt+ArrowLeft` and `Alt+ArrowRight`, `Alt+Backspace` and `Alt+Delete`, each arrow also with Shift to extend the selection. Any other shortcut edits nothing on macOS. Of these, `Meta+A` was run.
- On Linux, Chrome applies its own editing shortcuts, such as `Control+A`. Retest has not run a shortcut on Linux.

The type check refuses a misspelt key, such as `press('Entr')`, and a modifier it does not know, such as `press('Ctrl+a')`. A key it cannot read, such as a `string`, is checked when the test runs; an unknown one fails `usage`, and the message lists what `press` takes. `KeyArgument<K>` lets a helper take a key the way `press` does.

What a press does:

- The key goes down and comes back up as real keyboard input, so the page hears the same events a person's key gives it.
- Enter in a form field submits the form once. The press passed once its `keydown` reached the field. The page that answers the form is the page's own navigation, and is recorded as one.
- A `keydown` the page cancels with `preventDefault` still reached its element, and the press passes.
- The first `keydown` decides, which for a shortcut is its first modifier's. It must reach the element or something inside it. If the keyboard focus moved to another element before the key arrived, as when a dialog takes the focus, Retest stops the key before any listener of the page hears it, and the press fails `not_actionable`, naming that element. Once the `keydown` has reached the element, the rest of the keystroke belongs to the page, so a key that makes the page move the focus or submit a form is never stopped halfway.
- A key for the page's keyboard while the focus is inside a frame never reaches the page's document. Retest cannot see where it went, so the press ends `outcome_unknown`, naming the frame.
- While the browser is opening another document in the frame, no press starts, as for every action.
- A browser lost after the key went down leaves the outcome unknown: `outcome_unknown`, and the key is never sent again.

Action events record the key in `key`, as the test wrote it. Reports write a press as the test wrote it: `getByLabel('Search').press('Enter')` or `page.keyboard.press('Control+A')`.

### Choosing, ticking and scrolling

`select(choice)` takes one option or a list:

- A string names an option by its label, as a person reads it: the whole label, case and all, with each run of spaces read as one. `{ value }` names it by its `value` attribute, exactly.
- A list chooses exactly those options of a `<select multiple>` and clears the others. A list for a select that takes one option, and an empty list, fail `usage`.
- Each choice must match exactly one option. An option that is not there yet is waited for until the action budget runs out, and then the select fails `not_found`, naming it. Two options that match fail at once as `ambiguous`. A disabled option, or one in a disabled group, is waited for, and then fails `not_actionable`.
- The `<select>` must pass the checks a click does: visible, stable, enabled and not covered.
- An element that is not a `<select>` fails at once as `unsupported`. Choose from a list the page draws itself with `click()`.
- When the selection already is the one asked for, nothing is sent, and the event says `changed: false`.

`select` chooses with the keyboard, as a person can, because Chrome draws a select's list outside the page, where input cannot reach it:

- For a select that takes one option, Retest focuses it and types the shortest start of the option's label that lands on it, as Chrome jumps to the next option whose label starts with what was typed. It waits first until a second has passed since a key last went to that select, so no earlier key joins the typing. An option whose label another option shares is reached by typing its first letter again.
- For a `<select multiple>`, Retest moves the focus to the first option with Meta held, Control off macOS, steps down the list, and toggles each option whose state is not the one asked for with that modifier and Space. Disabled and hidden options are skipped, as Chrome skips them.
- Each key must reach the select, as a press's key must, or the select fails as a press would, naming its choice.
- The page hears the keys and the browser's own `input` and `change` events, trusted, once for each option the select lands on or toggles. An option whose label starts like an earlier option's may be landed on first, and the page hears that option chosen on the way.
- Then Retest reads the selection until it is the one asked for, or the action budget runs out. It never types again: a select left holding other options fails `not_actionable`, with `details: { check: 'selection', inputSent: true }`.
- A select whose own `change` takes it off the page, or opens another page, cannot be read afterwards. Retest reads what it holds as its `input` or `change` event arrives, before the page's listeners run, and it passes if that was the selection asked for. A select still on the page is read as it stands, so one whose listener puts another option back fails.
- Every key of a select goes to the select in the document Retest planned it in. Once a key has made the page set off for another document, Retest types no more, even into a select of the same locator on the next page. The select then passes if it held the options asked for when the last key arrived, and otherwise fails `not_actionable`, saying how many of its keys went and what the select held, with `details.inputSent: true`.
- An option no key reaches, such as one with no label to type, or a hidden option a list must change, fails `unsupported` at once, and nothing is typed.
- Only macOS was run. The modifier a list takes on Linux, Control, was never run.

`check()` and `uncheck()`:

- The element is a native checkbox or radio button, or has the role `checkbox`, `radio`, `switch`, `menuitemcheckbox` or `menuitemradio`. Anything else fails `unsupported`. A native control reads its `checked` state, and any other its `aria-checked`. `aria-checked="mixed"` counts as not checked.
- A control already as asked gets nothing, and the event says `changed: false`.
- Otherwise Retest clicks it once, with every check a click makes. On a touch screen it taps, and the event says `touch: true`.
- A native control that is not visible, with exactly one visible label of its own, is clicked through that label. This is how a person ticks a styled checkbox. The event says `via: 'label'`, and reports say "clicked its label".
- After the click, Retest reads the control until it is as asked or the action budget runs out. It never clicks again. A control that took the click and stayed as it was fails `not_actionable`, with `details: { check: 'state', inputSent: true }`.
- `uncheck()` on a radio button fails `unsupported`. A person unchecks one by choosing another.

`scroll({ x, y })`:

- `x` and `y` are CSS pixels, positive right and down. Both missing or 0, or either not a finite number, fails `usage`.
- `locator.scroll` needs the checks a click does, and its `wheel` event must reach the element or something inside it. A `wheel` another element takes is stopped before it reaches that element, and the scroll fails `not_actionable`, naming that element. A wheel listener the page puts on the window in the capture phase hears it first, since Retest listens for the wheel only while a scroll is on its way. `page.scroll` has no checks.
- One wheel event carries the whole distance. The scroll passes once that event reached its element. It says nothing about how far the page moved, since smooth scrolling may still be going. The next action waits for its element to stand still.
- The distance is the CSS pixels the page scrolls, also on an emulated phone whose page is zoomed out to fit. What the page's own `WheelEvent.deltaY` reads on a page with an emulated device pixel ratio was not checked.
- On a touch screen, `scroll` still turns the wheel. It does not swipe.
- Retest listens for `wheel` only while a scroll is on its way, so the page scrolls as it always does.
- Every action already brings its element into view. Scroll only for what the page does on scroll, such as loading more items, or enabling a button once a text has been read to its end.

Reports write each of these as the test wrote it, with what the call leaves out: `getByLabel('Toppings').select(['Basil', { value: 'olives' }])`, `getByLabel('Newsletter').check(), clicked its label`, `getByTestId('agree').check(), already checked, sent nothing`, or `page.scroll({ y: 600 })`. A run recorded before select used the keyboard says `input: 'script'` on its selects, and reports say "set by script".

### Matchers

Locator matchers look again until they pass or the assertion budget runs out. They never repeat an action. Await them. The page tells Retest when its document changes, so a look follows a change as soon as 50 ms have passed since the previous look; without a change, looks come 50, 100 and 250 ms apart, then every 500 ms.

- `toBeVisible()`: exactly one match, and it is visible.
- `toBeHidden()`: nothing matches, or nothing that matches is visible.
- `toBeChecked()`: exactly one match, a checkbox, a radio button or an element with a checkable role, and it is checked, as `check()` reads it. `aria-checked="mixed"` is not checked.
- `toBeEnabled()` and `toBeDisabled()`: exactly one match, and it is enabled, or disabled. Disabled is a native control that is disabled, on its own or in a disabled `<fieldset>`, or an element whose nearest `aria-disabled`, on itself or an ancestor, is `true`. Actions check only the native disabled state, so a click still goes to an element that `aria-disabled` alone marks.
- `toHaveText(text)`: exactly one match, whose whole text equals `text`, or matches a `RegExp` anywhere.
- `toHaveText([...texts])`: the matches, hidden ones included, have exactly these texts, in document order. The list may hold strings and `RegExp`s.
- `toContainText(text)`: exactly one match, whose text holds `text`, case and all, or matches a `RegExp` anywhere.
- `toHaveCount(n)`: exactly `n` matches, visible or not.
- `toHaveValue(value)`: exactly one field matches, and its whole value is exactly `value`, or matches a `RegExp` anywhere.

`toHaveText` and `toContainText` trim both ends and read each run of spaces or line breaks as one space, and a `RegExp` reads the text the same way. Nothing else is loosened, and `toHaveValue` loosens nothing. An observation lists at most 100 matches, so `toHaveText([...])` and `toBeHidden()` cannot pass when more match.

The page has two matchers of its own, which look again in the same way:

- `expect(page).toHaveURL(url)`: the page's whole address, query and fragment included, equals `url`, as Playwright compares it. A relative URL resolves against the app's base URL. A `RegExp` is searched for anywhere in the whole address.
- `expect(page).toHaveTitle(title)`: the page's whole title equals `title`, with both ends trimmed and each run of spaces read as one, or matches a `RegExp` anywhere. A look while another document is on its way has no title, and passes neither way.

Both read the address and the title as the page has them, up to 65,536 characters each, with every secret value replaced by its placeholder. A page that holds more than that passes neither way. A negation also fails when the part it compares holds a placeholder, since Retest cannot tell what the page showed there; the failure says it could not judge.

The parent judges each passed page matcher on the look it names, as it judges a locator matcher. A look at the page has no `observation` event of its own: the assertion names it in `observationId` and records the page it read in `pageUrl`, the whole redacted address, and `pageTitle`, cut to 300 code units. Navigation events and `page.url()` keep the origin and path only.

`.not` before a locator or page matcher passes only on a look that shows the opposite, as in `await expect(page.getByRole('dialog')).not.toBeVisible()`:

- No element is the opposite only where the matcher says so. `.not.toBeVisible()` passes when nothing matches, as Playwright documents, and so do `.not.toHaveCount(n)` and `.not.toHaveText([...])`, since no match is another count and other texts. Every other negation needs exactly one element: `.not.toHaveText('Draft')` on none fails `not_found`, and on several fails `ambiguous`.
- `.not.toBeHidden()` passes once exactly one element matches and it is visible. No match fails `not_found`, and several fail `ambiguous`.
- An element that cannot have the state passes neither way: `.not.toBeChecked()` on a paragraph fails, as `toBeChecked()` does.
- Events and reports write a negated matcher as `not.toBeVisible`. Value matchers have no `.not`.

Every locator and page matcher takes `{ timeout }` in milliseconds, as in `toBeVisible({ timeout: 2000 })`. It shortens the assertion budget for that call and never lengthens it: a longer one is cut to the budget. The event records the time the assertion had in `timeoutMs`.

Value matchers check at once:

- `toBe(expected)` compares with `Object.is`.
- `toEqual(expected)` compares deeply: primitives by `Object.is`, plain objects by their own keys, arrays item by item, `Date` by its time, `Map` by key then value, and `Set` by member. Any other object must be the same object.
- `toContain(item)` looks in a string or an array.
- `toMatch(pattern)` tests a string against a `RegExp`.

Two more ways to check:

- `expect.poll(fn, { timeout?, intervals? })` calls `fn` again until its value passes a value matcher or its time runs out. Its time is `timeout`, or the assertion budget. `intervals` are the waits between looks, the last one repeating. `fn` may only read. An action inside it fails the test, because it would run again on every look.
- `expect.soft(x)` records a failure and lets the test go on. The test fails at the end, with its first failure leading and the others in `failure.details.also`. Every soft failure has its own event, marked `soft: true`.

The type check rejects a value matcher on a locator, a locator matcher on a value or a page, a page matcher on a locator, `.not` written twice, and any matcher on a secret.

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
- A secret is bound to origins: those of the base URLs of the test's apps, and any `secretOrigins` lists for it. On any other page, the fill fails `not_actionable` at once, naming the page's origin, and nothing is typed. A page that has opened no address yet, as an Electron window can be before its first document arrives, is waited for within the fill's time, as its field would be; the fill fails `not_actionable` only if that time runs out first.
- Retest checks the origin twice: before it reads the value, and again in the page, just before it types. From the moment the field takes focus until the text is in, it stops the page from leaving for another document; the check that ran shows a page that sets off as the field takes focus kept where it is, with nothing typed, and a page that sets off while the text is on its way was not run. While the browser is already opening another document, the fill waits for it and checks that document instead. A document that still arrives while the text is on its way stops the text itself, since nothing was armed there: the fill fails `not_actionable`, naming the document, and the text reaches no document Retest did not check.
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

### TypeScript and imports

Retest loads test files and the config with the TypeScript transformer Node ships, through Node's `module.stripTypeScriptTypes`. It removes types and turns TypeScript-only syntax into JavaScript. It does not check types: run `tsc` for that, as `npm run typecheck:e2e` does after `init`. Node calls the function experimental and says it might change at any time; its documentation lists it as a release candidate. Retest has run it on Node 24.12.0 only, and `engines` asks for 24.12 or later on that one version's evidence.

Types are stripped first, which keeps every line and column where it is. A file that has an enum, a namespace with values or a parameter property is transformed instead, with a source map, so a failure in it, and the stack of an error thrown there, still name its TypeScript line and column.

What loads:

- ES modules in `.ts`, `.mts`, `.js` and `.mjs` files. A CommonJS JavaScript helper, such as a `.cjs` file, loads into them as Node loads it.
- Enums, namespaces with values and parameter properties.
- A relative import with or without its extension. `./helper` finds `./helper.ts`, then `./helper.js`, `./helper.mts` and `./helper.mjs`, then the folder's `index.ts` or `index.js`. `./helper.js` loads `./helper.ts` when that file exists, as `tsc` reads it, and `./helper.js` otherwise; `./helper.mjs` and `./helper.mts` work the same way. `.`, `..` and a path ending in `/` load the folder's `index.ts` or `index.js`.
- The `paths` of the `tsconfig.json` nearest the importing file, at or above its folder, the same rule for test files, helpers and the config. Retest follows `extends`, to a file or a package, allows comments and trailing commas, and reads `paths` from `baseUrl` when one is set, otherwise from the file that declares them. TypeScript 7 removed `baseUrl`, and `paths` work the same without it.
- An alias tries its targets in order, each with the extensions above. An import none of them finds resolves as Node resolves it, such as a package of that name. An import that cannot be found names the `tsconfig.json` that governed it.

An empty `tsconfig.json`, or one that holds only comments, reads as `{}`, as `tsc` reads it. One that is not JSON with comments, extends a file that is not there or extends itself, or holds `paths` that is not an object of patterns and lists of paths, or that has more than one `*` in a pattern or a target, fails with a message that names the file; nothing else `tsc` would refuse in `paths` is checked. The failure comes before anything loads for the config and for each test file, and for any other file as it imports.

These fail as their file loads, with a message that names the construct and the file:

- CommonJS test files, configs and TypeScript. A `.cts` file does not load, and neither does a test file, a config or a `.ts` file that Node reads as CommonJS and that uses `require()`, `module.exports`, `exports.`, `__dirname` or `__filename`. Write `import` and `export`, and set `"type": "module"`.
- JSX, in `.tsx` and `.jsx` files or in a `.ts` file. For a `.ts` file, the message names the line.
- Decorators. Node's transformer leaves them in place, and Node cannot run them. When the project `.ts` file Retest last handed to Node, which is the one that failed to compile when Node compiles each module as it loads, holds an `@` decorator, the message names its line as what may be the cause.
- A type imported without `type`, because Node keeps every import. Write `import type { Title } from './titles.ts'`. When the TypeScript file imported declares the name as a type or an interface, the message says it declares the name only as a type.

Retest does not read project references, does not look up bare imports from `baseUrl` alone, and ignores every other `tsconfig.json` setting, such as `jsx`, `experimentalDecorators` or `target`.

The `tests/tsconfig.json` that `init` writes extends the project's own when there is one, and its options follow the rules above: `tsc -p tests/tsconfig.json` accepts enums, parameter properties, imports without extensions and aliases, and refuses JSX: the consumer check runs TypeScript 6 and 7 on those. Its options are meant to refuse `import x = require()` and a type imported without `type` as well, and to accept a decorator and a `require()` call, which Retest refuses; none of those four was run through `tsc`.

A test file's process runs Node with `--enable-source-maps` as its only added flag; the `--conditions` of the process that started it pass through. Before any test file loads, the process registers a resolve hook that points Retest's own specifiers at the copy of Retest that runs the file, and then the project's resolve and load hooks above. A process started with `--experimental-transform-types`, such as through `NODE_OPTIONS`, which a test file's process inherits, transforms every TypeScript file itself, erasable ones included, each with a source map, and Retest's load hook leaves it to Node. Node prints a warning the first time the transformer runs; Retest holds back that one warning, matched by its text. Every other warning, including one test code causes, is meant to print as usual; no test causes one to check.

## AI checks

An AI check asks a judge, a model you choose, whether evidence meets a requirement you wrote before it looks. Use one where the requirement needs reading, such as whether an error message says how to continue. Check facts with `expect`: a total, a title, a checked box. A screenshot check cannot tell whether a task was saved to the server, only what the page shows.

```ts
test('explains the saved task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  await test.evaluate({
    requirement: 'The message says the task was saved and names it.',
    evidence: { capture: 'screenshot' },
  })
})
```

Retest's own process captures the evidence, calls the judge, checks the answer and records the verdict. The test file's process only names what to judge. It never holds the judge's credentials and never loads its code. When a required check does not pass, it receives the same failure the record holds, and nothing else of the judge's answer.

### Judges

A config declares its judges under `evaluation`:

```ts
evaluation: {
  judges: {
    visual: {
      adapter: '@rehearsal-labs/retest/evaluation/ai-sdk',
      credentials: { apiKey: env('ANTHROPIC_API_KEY') },
      options: { provider: 'anthropic', model: 'claude-sonnet-5' },
      accepts: ['text', 'images'],
    },
    house: { adapter: './judges/house.ts', credentials: { token: () => vault.read('judge-token') }, accepts: ['text'] },
  },
  defaultJudge: 'visual',
  timeoutMs: 30_000,
  limits: { callsPerTest: 5, callsPerRun: 100 },
}
```

- `adapter` makes the judge: a module path relative to the config, a package, or a function. A module's default export is the factory. Retest's process imports it the first time a check names the judge, and calls it once per run with the judge's credentials, its `options` and a signal aborted when the run ends. An adapter that does not load, or a factory that does not finish, within `timeoutMs` fails the judge's setup, naming the adapter, and the run still ends. A factory never receives a file path.
- `credentials` are read as secrets are: `env('NAME')`, read when the judge is first used, or a function, called once with `{ signal }` and given `timeoutMs` to answer. A credential written as its value is refused, and the message never quotes it. Retest leaves the variables out of the environment it gives each test file's process, app server and browser, in a run and in `retest doctor` and `retest list`. On real Chrome runs, the test file's process and an app server Retest started were shown to see the variable absent; the browser's own environment was not read, only the launch's list of hidden variables. A start command that loads them again, from a shell profile or a `.env` file, brings them back, and Retest cannot prevent that. An app that needs the same key reads it under another name. Each value an environment variable holds is taught to the redactor as the run starts, whether or not a check uses its judge, and a function's value as soon as it is read. Retest writes each value as `{{visual.apiKey}}` in all text it records, so a page or a provider error that quotes the key leaves it nowhere in the run folder.
- `options` hold JSON values only.
- `accepts` lists what the judge takes: `text`, `images` or `frames`. A judge gets only what it lists. A text judge never receives a screenshot read out as text: the check is an error instead.
- `defaultJudge` is the judge a check without `judge` uses. With one judge, it is that one.
- `timeoutMs` is how long a check may take, 30 seconds by default. Setting the judge up counts against it.
- `limits` bound every run: `callsPerTest` 5, `callsPerRun` 100, `concurrentCalls` 2, `maxOutputTokens` 1000, `maxInputBytes` 8000000, `maxImages` 4, `maxImageWidth` and `maxImageHeight` 4096, `maxFrames` 16 frames of recordings a check, and `maxDiagnosticRecords` 200. The media process sends at most 64 frames for one interval, whatever `maxFrames` says. These defaults are bounds, not tuned numbers. Retest's process holds the counters for every worker and takes a call before it sends it, so two workers can never both take the last one. A call taken is never given back. Nothing estimates a price.

The config refuses an unknown key, a `defaultJudge` it does not declare, a judge with no `accepts`, and options that are not JSON. A run of ordinary tests loads no adapter and reads no credential, so it needs neither the AI packages nor the keys.

### The check

`test.evaluate({ judge?, requirement, evidence, context?, mode?, timeoutMs? })`:

- `requirement` is a sentence, or criteria by id, such as `{ saved: 'The task shows as saved.', titled: 'It shows its title.' }`. Every criterion must pass. A sentence is one criterion, with the id `requirement`. For frames, name each criterion's kind with `{ kind: 'state' | 'seen' | 'never', requirement: '...' }`. The kind decides what claim the check makes; Retest never guesses it from the sentence. Existing sentences use the state question. The older `{ requirement, absence: true }` keeps its conservative rule over samples; use explicit kinds for new frame checks.
- `evidence` is one item or a list of them, each with an id the judge cites: `e1`, `e2` and so on.
  - `{ capture: 'screenshot', app? }`: Retest's process takes a screenshot of that app's page as the check runs, and saves it in the run folder. `app` defaults to the test's first app.
  - `{ text, label? }`: text the test supplies, such as a reply it read from the page. It is redacted before the judge sees it.
  - `{ recording: { step }, app? }` or `{ recording: { lastMs }, app? }`: the frames that app's recording kept over the latest step of the test with that name, or over the `lastMs` milliseconds before the check. The judge must accept `frames`. A run that does not record the app refuses it by name; see [frames of a recording](#frames-of-a-recording).
  - `{ diagnostics: 'console' | 'network' | ['console', 'network'], app? }`: the console or network records the attempt has kept of that app so far, as [console and network diagnostics](#console-and-network-diagnostics) describes them, cleaned and redacted again as the check takes them. The newest `maxDiagnosticRecords` are sent as text with each part's capture state, and the exact text is saved in the run folder. Nothing of an app's diagnostics reaches a judge unless a check names it here. The judge must accept `text`.
- `context` is reference text the judge may read, such as a policy an answer must follow.
- `mode` is `required`, the default, or `advisory`.
- `timeoutMs` may shorten the check's time. It never lengthens the config's `timeoutMs` or the time its test has left.

Await it. The type check knows the config's judges, what each accepts and its apps, so a judge name with a typo, a screenshot for a text judge, or an app the config lacks fails to compile. A config with no judges makes every `test.evaluate` a type error.

### Verdicts

A check passes only when every criterion passed. A failed criterion fails it. Otherwise one the judge could not decide leaves it inconclusive: nothing turns an undecided criterion into a pass.

Once a required check has not passed, a failure comes first, then an undecided check, then an error, whatever order they happened in. A failure the test reports, such as a failed `expect` or a check it never awaited, counts as a failure. What the test file's process reports that is not a failure, such as a lost browser, is listed after Retest's own records and never decides the status. So test code cannot turn a failed check into an error, an undecided result or a pass.

| The check ends | Required | Advisory |
| --- | --- | --- |
| pass | Counts as the test's assertion | Nothing more |
| fail | The test fails with `evaluation_failed`, exit 1, and the check counts as an assertion | A warning |
| inconclusive | The test is `inconclusive`, with `evaluation_inconclusive`, exit 2 | A warning |
| error | The test is `error`, with `evaluation_error`, exit 2 | A warning |
| cancelled | An interruption stays the test's failure. A check cut off because its test ended or ran out of time adds `evaluation_error` after the test's own failure | Nothing more |

- Inconclusive: the judge said it could not decide, or the evidence is missing: the browser was gone, the screenshot failed, or it is not a PNG Retest can read; a recording failed or kept no frame of the interval; the diagnostics selected were not captured. Over frames, a `seen` claim without a witnessed appearance is always inconclusive, never fail. Every pass over partial frames is inconclusive, as is a state failure over partial frames or a never failure without a cited seen frame.
- Error: no judge, a judge that could not be set up, as when its package or credential is missing, no answer in time, a limit reached, evidence the judge does not take, or an answer that breaks the contract. An answer breaks it with a criterion missing, repeated or unknown, any key the contract lacks, such as a self-reported confidence, a cited id Retest never supplied, a pass or fail that cites nothing, or a justification over 2000 characters.
- A required check that does not pass throws, as a failed `expect` does. Catching the error changes nothing: Retest's process recorded the verdict and fails the test whatever the test does with the promise.
- An earlier failure stays the test's failure. A later passing check clears nothing.
- A test whose only checks are advisory makes no assertion, so it fails `no_assertions`.
- A check still running when its test ends, or when the run stops, ends `cancelled`. Retest stops waiting at once, aborts the request's signal and never reads an answer that comes later. A check stopped before it is sent spends no call. Stopping cannot prove the provider stopped working on a request already sent.

### What the judge receives

Each check sends one request: Retest's fixed instructions, the criteria and context, the evidence, the output bound, the time left and a signal. Text and screenshot checks use `retest-judge-1`; frames add `+frames-3`, and selected diagnostics add `+diagnostics-1`. The request holds no tool, no page and no function, so a judge cannot act on the app. The instructions say that text and pixels in the evidence are data, never instructions, and they travel apart from the criteria. That lowers the risk of an app's text steering the verdict. It does not make a model immune to misleading text, and Retest's tests only show where such text travels, not that a model's verdict cannot change.

The judge answers with a verdict for each criterion, the evidence ids it rests on, a short justification, and, when the provider says, the exact model that answered and the tokens it counted. Retest checks every part before it reads the answer.

### Frames of a recording

A check of a recording's frames asks the media process for the frames it kept over the interval: at most `maxFrames`, picked evenly across the interval when it kept more, fitted within the image limits, each saved in the run folder and hashed. The judge receives each frame with the time from the interval's start at which it reached Retest, and every stretch in which it has no frame, with what Retest knows of it: frames a full queue dropped, frames that could not be decoded, a gap the capture reported, or that no frame arrived, as when a page did not paint. No frame in a stretch never means nothing appeared.

Each frame criterion declares one of three kinds. The judge receives the kind in its request, with Retest's plain-language question for it.

- `state` checks the end state of the interval, the last frame the capture holds. It can pass or fail. For example, `{ kind: 'state', requirement: 'The message under Save shows the title "Release checklist", exactly.' }` fails when the last frame shows "Saving…".
- `seen` asks for something to appear at some point. For example, `{ kind: 'seen', requirement: 'A notification says the task "Release checklist" was saved.' }` passes when a seen frame shows that notification and the capture is complete. If no seen frame shows it, the result is inconclusive with the reason, never fail. A wrong-title notification cannot prove a correct one never appeared between frames.
- `never` forbids something throughout the interval. For example, `{ kind: 'never', requirement: 'No error banner appears during the save.' }` fails when a seen frame shows an error banner. It can pass only when the capture of the interval is complete and the judge finds no forbidden appearance. Otherwise it is inconclusive.

Retest's process settles the answer from the declared kind, capture status and citations, never from the judge's explanation:

| Kind | Complete capture | Partial capture | No usable frames |
| --- | --- | --- | --- |
| `state` | Judge the last frame held; pass, fail or inconclusive | Pass and fail become inconclusive | Inconclusive; no judge call |
| `seen` | Pass with a specific seen-frame citation; otherwise inconclusive, never fail | Inconclusive, including a witnessed pass | Inconclusive; no judge call |
| `never` | Fail with a specific seen-frame citation; pass only on complete capture; otherwise inconclusive | Fail with a specific seen-frame citation; otherwise inconclusive | Inconclusive; no judge call |

Frames are missing when one reached the media process and was not kept, the capture reported a gap, the bounds left kept frames out, a kept frame could not be read, frames were not stored yet, or the recording had not placed a frame. Every pass over those partial frames stays inconclusive. The record keeps each declared kind, the judge's verdict and citations, and the parent's effective verdict and rule. A sequence or diagnostics citation alone cannot witness a required or forbidden appearance.

Complete means the capture accounts for its interval without a known gap or missing frame. It does not mean every instant of the screen was observed. Frames are samples, and a stretch with no frame never proves a fleeting event was absent. The older `absence: true` marker therefore still leaves a pass inconclusive even over complete samples, with `absence_over_frames`. Use an assertion or a recorded event when the outcome needs proof beyond what the capture holds.

A frame the recording has not placed is never sent: one `pending` in a recording still running, which may still end unwritten, or one `unprocessed`, which the recording ended without writing. The record names each with its capture time, and its time is a stretch the judge has no picture of. The newest frame returned from a running recording may be pending until the next frame arrives. An interval that includes it cannot count a pass; an older interval need not include that frame. Check the interval's evidence status, or select a step that is over.

A run that does not record the app, and frames the pixel capture policy withholds from judges, make the check an error; a recording that failed leaves it inconclusive. None of them lets a required check pass.

`retest run` records apps when recording is requested and gives evaluation checks their recording and step intervals. Browser diagnostics checks receive a read-only snapshot of the selected app's bounded records and capture states, with the attempt and session identity preserved. Taking a snapshot leaves collection running. A part that is disabled or unavailable stays so; a check with no usable selected part is inconclusive. Live native diagnostics do not yet supply this view and are reported unavailable for evaluation. The real-Chrome frame integration also exercises the gathering and settlement path directly against the media process.

### Records

A check that ran, was cancelled or, for a host's check, never ran writes an `evaluation.finished` event, always the parent's, so a result rebuilt from the events lists the same checks as `result.json`. A check refused before the parent took it, as when no test was running, writes none. Each test's result lists its checks in `evaluations`: the test's own in the order they ended, then the host's. A test's own checks are numbered `evaluation-1`, `evaluation-2` and so on in each attempt. A record holds the check's id, its source, mode, judge and verdict, each criterion with its verdict and citations, a SHA-256 of the criteria and context as the judge received them, the evidence, the justification, a reason when there is no judged verdict, a failure or a warning, and the evaluator: provider, model, model revision, evaluator version, instruction version, the sampling the call sent, any setting it did not send as given with the provider's reason, latency and token usage when given. A piece of evidence names its kind, its SHA-256 and size, and for a screenshot the app, session, attempt, capture time, pixel size and file. A frames record names the interval on the run's clock and the step, each frame sent with its capture time, file, hash and what the recording made of it, the stretches with no frame, how many frames reached the media process and how many it kept, the frames the bounds left out and those not placed, and its status: `complete`, or `partial` or `unavailable` with the reason. A diagnostics record names the parts selected, each part's capture state, the ids of the records sent, how many the bound left out, and the file holding the text the judge received. The bytes stay in the run folder and the text stays out of the record.

The judge's words, every reason, and every string an evaluator or its provider returns, model names included, pass through the redactor before Retest keeps them. Screenshots are not image-redacted. A check consults the pixel policy before capture and again over the capture span before saving or sending pixels. A refused capture saves and sends no image. The policy cannot infer secrets an app displays outside a declared withholding stretch; text redaction does not hide them in an allowed image.

A check that did not pass adds its lines to its test's failure card, under the card's other lines: the check, each criterion, what the judge said and the evidence, then one line for each check that passed. For a failed check the card reads:

```text
    AI check failed
    The AI check evaluation-1 failed: the judge found "saved" not met. It said: "The banner reads 'Could not save'."

    AI check         evaluation-1 failed, required, judge visual (anthropic claude-sonnet-5-20260901)
    Criterion        saved: fail, cites e1
    Judge said       "The banner reads 'Could not save'."
    Evidence         e1 screenshot of web 1280x720 .retest/runs/…/artifacts/…-evaluation-1-….png
```

A warning prints under its test, even a passing one, with a `!`. The summary gains a row counting the required checks by verdict, then advisory passes and warnings, such as `AI checks  1 failed · 3 passed · 1 warning`. The agent report puts the same lines under each failure, and a `warn` line under each passing test that has a warning. `retest inspect --test` shows each check in the timeline.

### The AI SDK adapter

`@rehearsal-labs/retest/evaluation/ai-sdk` is a judge over the Vercel AI SDK for Anthropic, OpenAI and Azure OpenAI deployments. Retest does not install the SDK: install `ai@^7.0.127` with `@ai-sdk/anthropic@^4.0.71`, `@ai-sdk/openai@^4.0.83` or `@ai-sdk/azure@^4.0.90` yourself. They are optional peers of Retest. Without them, a check that names the judge fails its setup with `evaluation_error`, naming the missing package, and every other test runs.

Options: `provider`, `anthropic`, `openai` or `azure`, and `model`, the model id, both required; `temperature` and `topP` when you want them; and `baseURL`, an endpoint you name, by default the provider's public API. `baseURL` must be https, or http only to this machine (`localhost`, `127.0.0.1` or `::1`), so the key and the evidence never cross a network in clear text. Credential: `apiKey`. The adapter makes its own provider instance with your key and an endpoint, so it uses no gateway and no environment variable of the SDK's own. It ignores `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`: to send judge requests through a gateway or to a data-residency endpoint, set `baseURL`. Before this change, a judge without `baseURL` left the endpoint to the SDK, which read those variables and sent your key wherever they pointed.

The provider decides which sampling settings it sends. OpenAI and Azure drop `temperature` and `topP` for a model the SDK takes to be a reasoning model, judging by its id, or on Azure by the deployment's name. Anthropic drops them for some models, and caps `temperature` at 1. Each record keeps under `sampling` only what the call sent, and names a dropped or changed setting in `samplingNotSent` with the provider's reason. None of the three provider packages sends a seed, so the adapter refuses `seed`.

The adapter asks for structured output with retries off and no tools: Anthropic's native output format, and OpenAI's strict JSON schema. It asks OpenAI and Azure not to keep the request, with `store: false`. Anthropic's API has no such setting, so Retest claims nothing about what Anthropic keeps. It writes app text into the request as a JSON string, so nothing in it can end an evidence item. It checks the answer before Retest checks it again. A host that bundles the SDK can call `createAiSdkEvaluatorWith(setup, load)` from the same export, and the adapter loads `ai` and the provider's package through `load` instead of `import`.

For a model deployed on an Azure OpenAI resource, install `@ai-sdk/azure` and set `provider: 'azure'`. `model` is the name of your deployment, not a model id. Name the endpoint with `resourceName`, the resource's name, or with `baseURL`, such as `https://<resource>.openai.azure.com/openai`. Give exactly one of them. A judge with both or neither fails its setup, and the message names both options. Retest's stand-in tests exercised two shapes, `<resource>.openai.azure.com` by name or by that base URL. One live run used a third against a real deployment: a base URL on `<name>.services.ai.azure.com/openai/v1`, with no `apiVersion`. Foundry project addresses (`<name>.services.ai.azure.com/api/projects/...`) and `.cognitiveservices.azure.com` addresses are untested. Leave `apiVersion` out unless your endpoint needs one: the SDK then sends `api-version=v1`, and Microsoft's v1 API does not need a dated version. The adapter refuses `apiVersion` where the SDK would send none: a base URL whose path ends in `/openai/v1`, a Foundry project address, or a host outside Azure's own. Read the key from a variable of your own. The usual name is `RETEST_EVALUATION_AZURE_KEY`, which Retest's live check also reads. The adapter gives the SDK the key and the endpoint itself, so the SDK never reads `AZURE_API_KEY` or `AZURE_RESOURCE_NAME`. Each check sends one request to the Responses API at that endpoint, naming the deployment as its model, with the key in the `api-key` header, a strict JSON schema, `store: false`, retries off and no tools.

```ts
azure: {
  adapter: '@rehearsal-labs/retest/evaluation/ai-sdk',
  credentials: { apiKey: env('RETEST_EVALUATION_AZURE_KEY') },
  options: { provider: 'azure', resourceName: 'my-resource', model: 'my-deployment' },
  accepts: ['text', 'images'],
},
```

Its tests ran ai 7.0.127, @ai-sdk/anthropic 4.0.71, @ai-sdk/openai 4.0.83 and @ai-sdk/azure 4.0.90 against a local stand-in for each provider's API, from the packed package. The stand-in answered at Azure addresses, and at `api.anthropic.com` and `api.openai.com` for judges with no `baseURL`, while `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AZURE_RESOURCE_NAME` and the providers' key variables named other values. They prove the request the SDK sends and how the adapter reads the reply. One live run has called a provider: an Azure AI Foundry deployment judged one text check and one screenshot check through the adapter, and both passed. Anthropic and OpenAI have not been called, so their model ids on this page are untested. The live checks skip by name when their keys are not supplied.

### A judge of your own

An adapter module's default export takes the setup and returns an evaluator. `EvaluatorFactory` and the types around it come from the root export.

```ts
import type { EvaluationRequest, EvaluatorFactory, JudgeAnswer } from '@rehearsal-labs/retest'

// Your own call to the model: it sends the request and reads the reply. Retest does not supply it.
declare function askHouseModel(token: string | undefined, request: EvaluationRequest): Promise<{ criteria: JudgeAnswer['criteria']; summary: string }>

const judge: EvaluatorFactory = ({ credentials, options }) => ({
  identity: { provider: 'house', model: String(options['model']), version: 'house-judge/1' },
  async evaluate(request) {
    const reply = await askHouseModel(credentials['token'], request)
    return { criteria: reply.criteria, justification: reply.summary }
  },
})

export default judge
```

`evaluate` receives the request described above and returns the answer. Use `request.instructions` as the system prompt, keep the evidence apart from it, stop when `request.signal` aborts, and never send a tool. Retest checks whatever comes back.

## Console and network diagnostics

On Chrome and WebKit, each test's pages have their console, their uncaught errors and their requests recorded, in passing and failing runs alike. On Firefox, their requests are recorded. Nothing in them fails a test unless the config asks: a test may well exercise a 404 or an error message on purpose. What follows describes Chrome's records; [Per engine](#per-engine) says what WebKit records and leaves out, and why Firefox records requests only.

```text
<run>/diagnostics/<test>-<attempt>.jsonl         one file for each test's page, named with the app in a run from a config
```

### What is captured

- Console messages: each type as Chrome names it (`log`, `debug`, `info`, `warning`, `error`, `table`, `assert`, `count`, `trace`, `dir` and the rest), its level, its text, the address, line and column it came from, and whether it came from the page's main frame or an embedded one. The text is the arguments as the console shows them: strings as written, other values as Chrome describes them, an error with its stack, a function by the first line of its source, and an object's properties one level deep as Chrome previewed them, strings in quotes. Chrome cuts a value of 100 characters or more in a preview, keeping its start and its end; Retest keeps none of such a value and writes `(cut)`, since a secret cut in two is one the redactor can no longer find. Retest never reads a page object itself, so no getter of the page runs, and it keeps no handle to one. `%s` and the other format directives are left as written.
- Chrome's own entries, such as `Failed to load resource`, with `origin: 'browser'` and the request each is about.
- Runtime errors: an error the page threw and did not catch, and a promise rejected with no handler, each with Chrome's own line, such as `Uncaught Error: boom`, and the first frames of its stack. A rejection the page handled later is marked `handledLater`, and counted apart from the errors it never handled.
- Requests: each hop's method, address, resource type and frame; its response's status and content type, whether a cache or a service worker answered, when Chrome says, and the protocol; when it finished, how long it took by Chrome's own clock and how many bytes Chrome counted; or why it failed. A 404 or a 500 is a response with that status. A refused connection, a name that does not resolve or a cancelled request is a failure, with Chrome's reason and no status. Chrome ends an error answer with no body with a failure after the response; it counts once, as the HTTP error, and the requests of the error page Chrome shows instead are marked `out_of_scope`. Each hop of a redirect is a request of its own, and its response names the next. A request still open when the test ends is marked pending, with how far it got and why.
- A duration or a size Chrome did not give is left out, never written as zero.

### What is left out

- No header and no body, of a request or of a response. Cookie, Set-Cookie and Authorization never reach a file.
- Every address field, and every address with a scheme in a text, such as the frames of a stack, loses its user name and password, its query, written `?…`, and its fragment, written `#…`. A path segment that looks like a token is written `…`: a JSON Web Token, or, unless it is a file name, a version or a date, a segment of 12 digits or more or of 16 letters and digits or more. A long slug is hidden too, once it holds 16 letters and digits; `buy-milk` is kept. A `data:` address keeps its media type only. An address without a scheme inside a text, such as `/api?token=…` in a message, is kept as the page wrote it, after the redactor has read it.
- Every text from the page passes through the redactor before its addresses are cleaned and before it is cut, so a secret the page logs, throws or puts in an address reads `{{name}}`. A text longer than four times the message limit is first cut to that length, and the redactor reads that much, holding back a tail that may be the start of a secret; what lay beyond the cut is never read and never kept. The files are redacted again when the run ends, as logs are.

### Scope

Capture starts on each test's page before it opens anything, and ends once the test body and the parent's checks are over, before a failure screenshot and before the page closes. Each result and each artifact names its engine and what it covers. On Chrome:

- Covered: the page's document; the frames Chrome renders in the page's own process, frames of the page's origin among them; a dedicated worker's console messages, which Chrome forwards with their level only.
- Not covered: a frame of another site, which Chrome runs in a process of its own; a dedicated worker's requests; a service worker's own messages and requests; shared workers. A request Chrome hands to one of these, such as a worker's own script or the document of another site's frame, is marked `out_of_scope` rather than pending. A response a service worker answered for the page is recorded, with `serviceWorker: true`.

### Per engine

Each capture names its engine in `scope.engine`, and what it covers:

| Engine | Console covers | Network covers |
| --- | --- | --- |
| Chrome | the page's document, frames in the page's process, a dedicated worker's messages | the page's document, frames in the page's process |
| WebKit | the page's document and its frames, of its own site and of others | the page's document and its frames, of its own site and of others |
| Firefox | nothing: the console is `unavailable` | the page's document and its frames, of its own site and of others |

The same diagnostics pages ran on each engine on macOS, in thirteen cases with the same assertions. Chrome and WebKit passed all of them:

- each console level and the other console types, every argument of a message, and the frame or worker each record came from, with the scope matching what arrived;
- uncaught errors and unhandled rejections, each as its own kind;
- a 404 and a 500 apart from a refused connection, each hop of a redirect, durations by the engine's own clock, and a request left pending;
- capture into another site and back, and across a reload;
- two pages at once, a browser shared by two files, and a stopped run;
- the entry and request limits, with `requireComplete`;
- secrets in messages, errors, addresses and stacks;
- the `strict` policy, on runtime errors and on HTTP errors with an allow list;
- a test that fails its own check, a quiet page, capture turned off, a closed page, and a browser lost mid-capture.

The byte limit, the cut of an oversized message, a renderer crash, the reports and `inspect` ran on Chrome only.

WebKit's records differ from Chrome's as follows. A field WebKit does not give is left out.

- A response names no protocol, and a redirect's hop no size.
- A message names its frame when WebKit names the script it came from. A message the browser logs names none, unless it is about a request.
- A dedicated worker's messages are not captured. Its own requests are left out, and its script counts as the page's request.
- `console.count` is recorded at the debug level, as WebKit reports it.
- A message or a repeat that comes without WebKit's own time is counted as unread, so the console capture is partial. Retest never stamps it with its own clock.

On Firefox, Retest records no console message and no runtime error. Firefox 133.0.3 runs enumerable getters while serializing logged objects before delivery. Its log subscription ignores `serializationOptions: { maxObjectDepth: 0 }`, although that option works on script results. A primitive-only filter after delivery cannot prevent those side effects, so Retest does not subscribe. Each page's console is `unavailable`, with that reason. A probe on the real browser found getters run in nested objects too, while strings, numbers, a plain data object and a DOM node ran none. Playwright's Firefox console uses its patched build's own protocol, not WebDriver BiDi, so its console capture does not establish a safe route for this Firefox build. Firefox requests are recorded, with these differences from Chrome:

- A request a dedicated worker makes is recorded as the page's, since Firefox names it by the page.
- A request has a resource type only when it is a navigation's document.

The thirteen cases ran on Firefox and passed for its requests: the frames, the 404, the 500 and the refused connection, the redirect, the pending request, capture across sites, two pages at once, the shared browser, the stopped run, the limits, a secret in an address, and a lost browser. Network rules of the `strict` policy judge as on Chrome. With its console unavailable, `requireComplete` and a `strict` rule on runtime or console errors end each Firefox test as `reporting_failed`.

### Capture status

A test's result lists each page's capture in `diagnostics`, with a state for its console and one for its network:

- `complete`: everything in scope from start to end. Zero records means the page produced none.
- `partial`, with a reason and the counts: records were dropped at a limit, the browser sent an event Retest could not read, or the page crashed or its connection ended. What came before stays.
- `unavailable`, with the reason: capture never started, or its file could not be saved. No file claims a capture.
- `disabled`: the run turned capture off.

### Limits

Each test attempt, all its apps together, keeps at most 1000 console messages and runtime errors in 1 MiB, and 1000 request hops in 2 MiB. Each message is cut at 4096 characters, and each stack at 20 frames. A cut message or error text keeps its full length beside it; a cut address is marked `urlTruncated`, with no length; and the short fields, such as a method, a status text, a failure reason, a function name, a content type or a protocol, are cut to their own limits with no mark. A record past a limit is dropped and counted. A request is kept only while the attempt can also hold its response and its end, so a kept request never loses them. These are bounds, not tuned numbers.

### The config

```ts
diagnostics: {
  strict: { runtimeErrors: true, httpErrors: true, allow: ['/favicon.ico'] },
  requireComplete: false,
  limits: { consoleEntries: 1000, consoleBytes: 1048576, requests: 1000, networkBytes: 2097152, textLength: 4096, stackFrames: 20 },
}
```

- `capture: false` records nothing, and every result says `disabled`.
- `strict` fails a test that otherwise passed when its pages had any of what it names: `runtimeErrors`, leaving out a rejection the page handled later; `consoleErrors`, written by the page's own code or its workers; `transportFailures`, leaving out a cancelled request and the failure that ends an error answer; and `httpErrors`, a status of 400 or more. A record whose text or address holds an `allow` entry is not counted. Retest's own process decides from the records it kept, whatever the test code does. The test fails with `host_check_failed`, naming the counts and each record by its session and id, such as `Records: k3v9q0x2mb:web e1, n4 in diagnostics/….jsonl`, and the run exits 1. A message's text never enters the failure. A failure the test already had stays first, with the policy's after it in `details.also`.
- A strict rule never passes on capture that was not all there. When a kind a rule reads, the console for `runtimeErrors` and `consoleErrors` and the network for the others, is not `complete`, as when debug lines used up the limit before the error, the test is `error`, with `reporting_failed` saying the policy could not judge it, and the run exits 2. When a strict rule also matched, the match comes first: the test is `failed` with `host_check_failed`, the run exits 1, and `reporting_failed` follows in `details.also`.
- `requireComplete: true` keeps a test from passing when any of its capture is not `complete`: the test is `error`, with `reporting_failed`, and the run exits 2. Capture that was lost never replaces a failure the test already had.
- A program passes the same block as `RunOptions.diagnostics`, which replaces the config's whole block. A block that cannot be read refuses the run before any test runs.

### Reports

The terminal shows counts, never what a message says. A failed test's card has a line for each page, naming a partial or unavailable capture with its reason, and, beside its artifact, what the capture covers:

```text
    Diagnostics      web: console 18 entries, 2 errors, 1 warning, 2 runtime errors · network 14 requests, 2 HTTP errors, 1 failed, 1 pending, 2 out of scope · .retest/runs/…/diagnostics/….jsonl
    Scope            web: console covers top level document, same process frames, dedicated workers; network covers top level document, same process frames
```

The summary gains a row when the pages did something worth a look, a capture was partial or unavailable, or a record was cut, counting in this order runtime errors, console errors, HTTP errors, failed requests, partial captures, unavailable captures and records cut, such as `Diagnostics  2 runtime errors · 1 console error · 1 HTTP error · 1 failed request · 1 partial capture · 3 unavailable captures · .retest/runs/…/diagnostics`. So a run on a driver that collects nothing never prints what a complete, quiet capture prints, which is nothing. The agent report has the same, as a `diagnostics:` line and lines under each failure.

`retest inspect --test` shows each page's capture under the timeline: its counts, what it covers, its first 50 console entries and a table of its first 100 requests with method, address, status, duration and failure; the artifact and `--json` keep them all. Each row is at its time since the test started, on the timeline's clock, with the action that was running then. A time says when something happened, never that an action caused it. With `--json`, each page's lines are under `diagnostics`.

### Records

`diagnostics.started` is written as capture starts, with its scope, its limits and the policy, and `diagnostics.finished` as it ends, with the page's summary and its artifact. A capture whose run was cut off before its end is `unavailable` in the rebuilt result. A run stopped while a page is still starting its capture waits for no page: the test is interrupted, and that capture is `unavailable`.

An artifact is JSON lines: `capture.started`, the records in the order they came, and `capture.finished`. The records are `console`, `runtime_error`, `network.request`, `network.response`, `network.finished`, `network.failed` and `network.pending`. Each carries its test, attempt, app and session, and its target in a run with variants. Console messages and errors are numbered `c1`, `e1` and on, and request hops `n1` and on; a hop's later records carry its id. AI checks receive no diagnostics.

## Native diagnostics and screenshot checks

The internal native collectors use an owned app's stdout and an explicitly declared network metadata file. They do not subscribe to the machine's logs. TaskPhone's stdout comes through the launch proxy's pipe in `simctl launch --console`; TaskDesk's stdout comes through the pipe its launcher opened. A line names its test, attempt, app, session, owned pid and source (`simctl-stdout` or `macos-stdout`). Text is redacted and bounded before persistence. Native lines retain `consoleType: 'stdout'` and `origin: 'native'`; they supply no JavaScript exception or console-error classification.

The fixture service's `--network-log <file>` supplies versioned JSON lines with method, route, status, measured request time, client and completion status. The collector opens that declared file before app launch, then reads appended records for `ios` or `macos` only. Request, response and completion records retain the app's identity and `app-network-file` provenance. No header or body is accepted. Routes pass through redaction and URL sanitization. The launch owner must keep each file/client interval exclusive to its attempt: the service's client name cannot distinguish two simultaneous copies of the same app.

Both sources report `complete`, `partial` with a reason, `unavailable` with a reason, or `disabled`. A native source with no records never claims `complete`. An app with no declared network source says `unavailable: the app provides no network source`. A declared file that is missing or unreadable says so. Overflow, an invalid record or an interrupted line preserves the records already kept and reports `partial`. The same diagnostics limits and parent policy apply; a strict JavaScript error rule cannot pass on native stdout.

Native screenshot evidence uses the session's actual PNG and named capture source: `executor-screen`, `simulator-display` or `window-crop`. Each saved image retains its test, attempt, app, session, capture reference, capture time, run-clock time and PNG hash. A check selecting several apps keeps those values for each image; their timestamps do not claim simultaneous capture. The parent freezes the pixels and judges the answer under the existing required-check rules. A later pass cannot clear an earlier required failure. Exact task identity and synchronization still need deterministic assertions.

Screenshots are pixels. Text redaction does not hide a secret displayed in an image. These proofs use screens with no secrets; no pixel masking capability was added. The native proof uses the local fake evaluator's decoded pixel-hash mode, which requires no model credential and measures the evidence path, not a live model's accuracy.

A native target names its sources under `diagnostics`, such as `diagnostics: { network: { path: './service/network.jsonl', client: 'ios' } }`. `logs` is `'stdout'` unless you set `'none'`. With `'stdout'`, Retest launches the app itself and reads its standard output from a pipe. On the simulator it uses `simctl launch --console`. On macOS it starts the app's executable and then activates the app, because the macOS runner drives only an app it launched or activated. With `'none'`, or in a run with `capture: false`, the executor launches the app, a log Retest did not keep says `unavailable: the app provides no log source`, and the capture's scope lists the app's process as not covered. `network` names the metadata file, relative to the config, and the client name its records give this app. An app without it says `unavailable: the app provides no network source`. The config refuses two apps that declare one file and client, and two targets of one app on different simulators, naming both keys. While an app with a network file runs, it holds a lock for that file, which the system lets go if Retest's process dies, so a second run on the same Mac, in this process or another, that would read the same file fails that app's setup by name instead of mixing the two runs' records. Both sources start before the app launches and finish once the body, its dispatched commands and the parent's checks are over, before anything closes. The result, the events, the artifact and `inspect --test` show them as they show a browser page's capture. It ran with the fixture apps on an iOS 26.5 simulator and on macOS. The network file cannot tell two copies of one client apart.

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

Against the working app all 15 tests pass, and the `signed-in` setup with them. Against the broken app five fail with a failure card. The example's `tsconfig.json` resolves the package to its source in this repository; a project that installs it leaves `customConditions` out.

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

`test.only` narrows a run before the filters do. A run with `only` checks less than its files hold, so it says so: `run.narrowed` names every `test.only` and `test.describe.only` with how many tests they kept, `result.json` keeps the same in `narrowed`, and the reports print a warning such as `test.only at tests/a.retest.ts:3 keeps 2 of 14 tests, so the run checks less than the suite.` The exit line adds `narrowed by test.only`.

When the `CI` environment variable is set to anything but nothing, `0` or `false`, a run whose files hold any `test.only` or `test.describe.only` is a usage error before any test runs, exit 2, naming each file and line. No browser starts. `--allow-only` runs it anyway. A program that calls `runFiles` asks for the same with `forbidOnly`, whose text ends the error's message.

A test declared with `test.skip` counts as chosen but does not run. A run whose every chosen test is skipped checked nothing, and exits 2 saying so.

### Other options

- `--config <path>` loads another config.
- `--reporter human|jsonl|agent`. With `jsonl`, stdout holds only event lines.
- `--timeouts action=500,test=3000` replaces some budgets.
- `--output <dir>` names a new run folder. Retest refuses one that holds files.
- `--workers <n>` sets how many test files run at once, each in a process of its own, sharing each target's browser. The default is half the machine's cores, at least one. Setups run first, one after another, so every saved state exists before a test starts from it. `--workers 1` runs the files one after another. Tests in different files run at the same time, so two that share something outside the page, such as one account or one counter on a server, can disturb each other: give each its own, or hold a [lock](#locks), as the example's count of saves does.
- `--browsers <n>` sets how many browsers a target's tests are spread over, each worker keeping to one. The default is one browser for every three workers that have a file to run. A target that runs a share of the run's tests, as each target of a matrix does, gets that share of the browsers, at least one, and never more than the files that use it. One browser serves all its pages from a single process, which many workers saturate; the human report says how many a target has, as in `started web=chromium  Chrome 154 · 3 browsers`, each further browser is a `browser.started` event with its `instance`, and its log is `logs/browser-…-2.log` and so on.
- `--allow-only` runs the tests marked only when `CI` is set, which otherwise refuses them.
- `--headed` shows every browser window. Nobody has run it yet.
- `--agent` and `--no-agent`. Retest prints the short agent report when `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI`, `AGENT` or `AI_AGENT` is set, unless you pick `--reporter` or `--no-agent`.

The human report labels each variant, as in `phone=pixel (emulated)`, and ends with a line for each target when there is more than one. A failure card's rerun command names the test by `file:line` and its variant by `--target`.

### Budgets

Every wait answers to one of these budgets. The defaults are collection 10000, setup 60000, action 10000, navigation 30000, assertion 5000, test 60000 and cleanup 10000 milliseconds.

- `collection`: loading each test file.
- `setup`: launching a browser, opening each test's pages, and starting an app server without its own `timeoutMs`.
- `action`, `navigation` and `assertion`: one command each, and never more than the test has left. `goto` and every action take `{ timeout }` in milliseconds, as in `click({ timeout: 2000 })`, which shortens that call's budget and never lengthens it: a longer one is cut to the budget. The parent keeps that time, whatever the test file's process claims. The call's `action.completed` or `action.failed` records what it asked for in `callTimeoutMs`, and in `timeoutMs` the time it was given, which is shorter when the budget or the test's time left was. A failure card names the call as the limit only when its timeout was the one applied.
- `test`: one test.
- `cleanup`: commands a test left running, the failure screenshots, closing each test's pages, and closing the browsers at the end.

Two fixed graces of one second sit on top:

- A test file's process has one second to stop once asked. Then Retest kills it.
- A browser that has not closed within the cleanup budget, or an app server still running one second after SIGTERM, is killed with its process group. Retest then waits one second more for it to go.

## Run Playwright test files

`retest run --playwright` runs test files written for Playwright, unchanged, as far as Retest's compatibility goes. It is early, and the lists below are all of it. [The compatibility table](compatibility/playwright.md) runs a fixed corpus of Playwright tests under a pinned Playwright and under Retest, case by case, and says where they agree and which cases are declared gaps, counted out of all of them. A case agrees only when both runs end it alike, an intended failure at the same check on the same values, and only when both runs as wholes exit alike.

```sh
retest run --playwright --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --base-url http://127.0.0.1:3000
retest run --playwright tests/checkout.spec.ts --browser /usr/bin/chromium --base-url http://127.0.0.1:3000
```

- Files end in `.spec.ts`, `.spec.js`, `.spec.mts` or `.spec.mjs`, or the same with `.test.`. With none named, Retest takes every `.spec.` file under the folder and leaves `.test.` files out, since a project's unit tests end the same way.
- `@playwright/test` and `playwright/test` resolve to Retest's own `@rehearsal-labs/retest/playwright`, wherever the file is. Neither package has to be installed in the project.
- Imports resolve as in Retest's own test files: `./helper` finds `./helper.ts`, then `./helper.js`, `./helper.mts` and `./helper.mjs`, then the folder's `index.ts` or `index.js`; `./helper.js` loads `./helper.ts` when that file exists; and the `paths` of the nearest `tsconfig.json` apply, as under "TypeScript and imports".
- What runs: `test`, `test.describe`, `test.beforeEach`, `test.afterEach` and `test.step`; the `page` fixture; `page.goto`, `reload`, `goBack`, `goForward` and `title`; `getByRole`, `getByLabel`, `getByText`, `getByTestId`, `getByPlaceholder` and `locator`, on a page and on a locator; a locator's `first`, `last` and `nth`; `page.keyboard.press`; a locator's `fill`, `click`, `hover`, `press`, `check`, `uncheck` and `selectOption`; `expect` with `toBeVisible`, `toBeHidden`, `toBeChecked`, `toBeEnabled`, `toBeDisabled`, `toHaveText`, `toContainText`, `toHaveCount`, `toHaveValue`, `toHaveURL` and `toHaveTitle`, each also after `.not`, and `toBe`, `toEqual`, `toContain` and `toMatch`; `expect.soft` and `expect.poll`.
- `selectOption` takes one option, named by its label, `{ label: 'High' }`, or by its value, `{ value: 'high' }`, and chooses it with Retest's `select`. A bare string is refused by name, since Playwright matches it against each option's value and its label at once and Retest has to know which; so are a list, `{ index }`, `null` and an option named both ways.
- `{ timeout }` on `goto`, `reload`, `goBack`, `goForward`, those actions and those locator and page matchers goes to Retest's own, which shortens the budget and never lengthens it.
- Everything else fails where it is used, as `unsupported`, naming the member: "page.getByAltText is not supported yet by Retest's Playwright compatibility." Nothing is skipped or dropped. Any other option is refused by name, such as `page.goto(url, { waitUntil })`, `locator.click({ force })`, `locator.fill(value, { noWaitAfter })`, `locator.press(key, { delay })`, `locator.selectOption(values, { force })`, `page.getByRole(role, { level })` or `expect().toHaveText(…, { ignoreCase })`, and so is `test.step`'s third argument. `.not` on a value, `toContainText` with a list, `page.url`, which Playwright reads at once where Retest has to ask the page, `getByRole('row', { name })`, `test.skip`, `test.only`, `test.use`, test details, a titled hook and a fixture other than `page` are each refused by name too. A test that meets one ends as an error at that line, and the run exits 2, or 1 when another test failed its checks.
- Playwright's `goto`, `reload`, `goBack` and `goForward` answer a response, and `selectOption` the values it chose. Retest's answer nothing, so under `--playwright` each answers a value that fails by name, as `unsupported`, the moment the test reads anything from it: "The response page.goto() returns is not supported yet by Retest's Playwright compatibility." Awaiting the call and leaving its answer alone is fine, and a call nothing awaited is still reported as not awaited.
- The rules are Retest's. A test with no assertion fails, a locator that matches several elements is ambiguous, an action is sent once, and `toHaveText` compares whole text.
- Finders follow Playwright's rules where Retest can. `getByText`, `getByLabel`, `getByPlaceholder` and a role's `name` match any part of the text in any case, unless `exact: true`; both trim the text and read each run of spaces as one. `exact` beside a `RegExp`, or on a role with no name, is left out, as Playwright ignores it. `getByLabel` also finds any element that an `aria-label`, or the text an `aria-labelledby` points at, names. Reports write these locators as the file wrote them. Retest's own test files keep Retest's defaults.
- A page that holds an open shadow root is refused. Playwright looks inside shadow roots and Retest does not, so any locator on such a page fails at once as `unsupported`, naming the shadow root's host, rather than pass on what it could not see.
- A table row by name is refused. Names come from Chrome's accessibility tree, which gives a row no name from its cells, where Playwright names a row from them; `getByRole('row', { name })` would find no row that Playwright finds, so it fails at once by name, and the types of `@rehearsal-labs/retest/playwright` refuse it before the file runs. Take the row by position with `nth()`, or find a cell by name.
- What still differs from Playwright:
  - Names come from Chrome's accessibility tree, not from Playwright's own reckoning, for the roles that are not refused too. The comparison's corpus finds buttons, links, tabs, cells, column headers, headings, alerts, status lines and unnamed rows by role, and Playwright and Retest agreed on every one of those lookups.
  - `getByLabel` finds a form control that Chrome names by its `placeholder` or `title`, which Playwright's does not, and leaves out a form control Chrome leaves out of its tree, such as a hidden one, which Playwright's finds.
  - `toBeEnabled` and `toBeDisabled` take `aria-disabled` from the element or the nearest ancestor that has it, whatever the element's role. Playwright reads it only for an element whose role takes `aria-disabled`, such as a button, so a plain element inside an `aria-disabled` container is disabled to Retest and enabled to Playwright.
  - `selectOption` chooses with the keyboard, so the page hears the keys as well as `input` and `change`, where Playwright sets the choice from a script. It waits for the select to be visible, stable, enabled and not covered, where Playwright needs it visible and enabled. It refuses an option that several options name, where Playwright takes the first. It sends nothing when the select already holds the option, where Playwright sets it again and fires `input` and `change`. It works on the select itself, where Playwright also follows a `<label>` to its control. Both compare a label trimmed with each run of spaces read as one; Playwright also drops zero-width spaces and soft hyphens first.
  - Budgets are Retest's: a test has 60 seconds and an action 10, where Playwright gives a test 30 seconds and an action no limit of its own. Both give a check 5 seconds.
  - A `{ timeout }` longer than Retest's budget is cut to it.
  - `goBack` and `goForward` with no entry that way fail instead of answering `null`.
- `playwright.config.ts` is not read. The browser, the base URL, the workers and the budgets come from the command line, or from `retest.config.ts`.
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
- For a target of an engine Retest pins a build of, it adds a `builds` row: the installed build the target runs, with its version and checksum, or what in it no longer matches its record; a target's own path, when it wins over an installed build; for a target that names no path, the installed build, which a Firefox target then runs and a Chromium or WebKit target runs once its path or variable names it; and for a Chromium or WebKit target that names no build, with none installed, the install command or the reason `retest install` refuses it. A folder in the cache for a build `retest install` refuses is never called installed: the row says Retest did not install or check it. Chrome and Edge run the browser the machine has and get no row. Only the cache is read; nothing is downloaded or installed.
- For a config with a macOS app, it reads whether the terminal or agent that runs Retest has Screen Recording, which the app's window capture needs. It asks macOS without a prompt and takes no picture; an iOS simulator app or a browser needs no such permission.
- For an iOS simulator or macOS target, it reads the executor its run drives, WebDriverAgent or the macOS runner, from Retest's cache: built, with its checksum, not built yet, with the command that builds it, or what in it no longer matches its record. Then it checks that the app bundle is at `appPath`. It starts nothing, and leaves what the app holds, the simulator, Xcode and Automation Mode to a run.
- It checks that Node is 24.12 or later, and starts Node with a test file process's flags, in the environment a run gives, to transform a snippet with an enum and a parameter property through Retest's own transform module and run it from a data URL; the project hooks take no part in that probe. Node gets a line only when one of the two fails.

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

`list` loads each file the way a run does and prints its tests with their source lines, tags, locks, apps and variants. A test declared with `test.skip` shows `(skip)`, and one that `test.only` or a block marked only singles out shows `(only)`; `list` itself lists every test either way. It takes the same selection flags as `run`, and opens no browser.

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

## The HTML report

```sh
retest run --reporter html
retest report .retest/runs/<time>
```

Both write `report.html` into the run folder. `--reporter html` prints the human report as well, and writes the file once the run ends. `report` builds it from a folder that already exists, finished or not, and replaces an earlier one. Either way the report is made from `events.jsonl` and `result.json` alone; a folder without `result.json` is rebuilt from its events and the report says the run did not finish.

The report is one file. It needs no server, loads no font, script or style sheet from anywhere, and opens from its file address. Screenshots are linked by their paths inside the run folder, so the folder can be moved or zipped and the report still shows them. Page addresses are shown as text, never as links.

What it shows:

- How the run ended and its exit code, with the same Tests and Exit lines the terminal prints, then the run's own failure and whether it stopped, did not check everything, or was narrowed by `test.only`.
- Each failure first: the check, the locator, the page, both values or their diff, the wait, the screenshot, and the lines of the test around the failing call.
- For every test, its outcome and, as a separate fact, how much of its evidence is here: complete, partial or unavailable, each loss with its reason. A screenshot the run could not save, a file that is not where its record says, or a file the safe read refused (missing, a link, outside the folder, and so on) is named in a dashed frame where the picture would have been.
- The steps of each app in time order, as `inspect --test` shows them; the console and network records of each session, read from its diagnostics artifact, with what the capture covers and whether it is partial or unavailable; each AI check with every criterion's verdict, the evidence it cites, the judge's words, the provider, model, versions and token usage; the targets with each browser's engine and build; and the replay facts: the bundle and its modules' hashes, the configuration's hash, the requirement and its checks, where each app started, and the host's preparation and cleanup.
- In a run that records, each recording of a test: whether it is complete, partial or unavailable, each gap the run named, the video from the run folder, what became of the frames, and how long the pixel policy withheld capture. A recording with no video says so where the video would have been and names any partial file kept; one removed after its test passed, because the config keeps recordings of failures only, says that. Click a timeline step to seek that test's recording to the step's run-clock moment. A row for a named app moves that app's video; a test-wide step moves each recording of the test. The report subtracts shortened gaps and clamps to the recording and playable video intervals. An incomplete clock mapping gives a plain refusal note and leaves the video alone.
- Files in the run folder that no record names, such as a recording left unfinished.

The file also holds the outcome as JSON, for a program that keeps only the report, in `<script type="application/json" id="retest-outcome">`: `version` (1), the run's `runId`, `status`, `exitCode`, `complete`, `counts` and `source` (`result.json`, `events.jsonl` or `run`, where its result was read from), and in `tests`, in run order, each test's `testId`, `name`, `variantKey`, `status`, `failureClass` and `evidence` (`complete`, `partial`, `unavailable` or `none`). A key without a value is left out. The browser never runs it.

The report has exactly two passive JSON blocks. `retest-recording-clocks`, version 1, holds each test's generated element id, test identity and title, and each recording's identity, app, session, path and clock. Both blocks escape every string for JSON inside HTML, including `</script>`. Exactly one constant inline script reads the clocks and assigns the video's time; it contains no run data and fetches nothing. The Content-Security-Policy meta tag authorizes only that script's SHA-256 hash and the report's style hash, with event-handler attributes and other executable sources refused. Everything a test, a page, a browser or a model wrote stays text. Control characters and characters that reorder visible text are written as their escapes. Images and videos load from the report's own place; on a file address Chrome reads that as any file, so the report itself links only to paths inside the run folder.

The report built by `--reporter html` reads the result the run hands its reporters, a moment before the run writes `result.json`. When something after that changes the outcome, such as a reporter that fails or a `result.json` that cannot be written, run `retest report` on the folder for a report of the final state.

## The run folder

Without `--output`, a run goes to `.retest/runs/<time>`.

```text
<run>/events.jsonl                 one version 1 event per line, written as it happens
<run>/result.json                  written once, at the end; missing means the run did not finish
<run>/logs/<file>.log              a test file's stdout and stderr, together
<run>/logs/browser-<target>.log    each browser's own output; logs/browser.log without a config
<run>/logs/app-<name>.log          the output of a server Retest started
<run>/artifacts/*.png              one failure screenshot for each app page of a failed test
<run>/diagnostics/*.jsonl          each test page's console, runtime errors and requests
<run>/states/                      saved sign-in state, only while the run goes on
.retest/last-run.json              the tests the last run did not pass, for --last-failed
```

A program that calls `runFiles` can move `.retest/last-run.json` with `lastRunFile: '<path>'`, or write none with `lastRunFile: false`.

Every event says who reported it: `origin: 'parent'` for what Retest's own process saw, and `origin: 'child'` for what the test file's process claimed. Every event of a test's run carries its `variant` and `variantKey`, and every event about an app names it in `session`. Milestone 1's mode has one app, named `page`, and no variants.

`browser.started` comes once for each app target, with the app and the target, and whether it is emulated. Its `engine` names the web engine that ran it, `chromium`, `firefox` or `webkit`, an Electron app's being `chromium`. Its `build` is the browser's own build as its driver read it from the running browser: Chromium's source revision from `Browser.getVersion`, Firefox's `moz:buildID` from its `session.new`, and the WebKit build's revision from its folder's name, as Playwright names it (`webkit-2359`). A driver that read none writes no `build`; none is taken from a pinned table. `app.started`, `app.reused` and `app.failed` tell what became of each server. `state.saved` and `state.restored` name a state, never its contents. `result.json` lists every app target's browser in `browsers`, and each screenshot names its app.

A session is one app's page in one attempt. Its id is the attempt's id and the app's name, such as `k3v9q0x2mb:web`. `observation`, `evidence.captured` and `evidence.failed` name it in `sessionId`. A screenshot's event and its entry in `result.json` also give its `attemptId`, and when it was taken in `capturedAt`. Runs recorded before sessions had ids have none of these.

`observation` is a look the parent served the test file's process, and `host_check.passed` and `host_check.failed` are host checks. [Use Retest from code](#use-retest-from-code) explains both, and `judgedBy` on `assertion.passed`.

### Titles and what opened each page

A `navigation` event names the page's title in `title`, what opened it in `cause`, and in `document` whether it opened a new document (`new`) or moved to a new path within the one the page had (`same`). Actions, looks and assertions name the title of the page they went to in `pageTitle`, beside `pageUrl`, and a host check's `actual` has `title`. Reports show the title before the address, as in `"Account" at http://127.0.0.1:4173/account`.

- A title is the page's `document.title`, trimmed, with its control characters removed, and cut to 300 code units. A page with no title has none. Titles are page text: a secret in one reads `{{name}}`. The browser hands Retest the title as the page has it, up to 65,536 code units. Retest hides each secret in it before it removes control characters, trims and cuts it, and again after, so no value is left half-written, and none is joined back together by the cleaning.
- An action or a look reads the title in the same call that checks or reads the element. `goto` reads it after `load`. An action that failed names the page as Retest last saw it commit when the failure came, since the page may have opened another document while the action waited for it, and its event comes after that document's `navigation`.
- A new document's `navigation` is written once its title is known: when its content has loaded, when the test's next command to that page begins, or one second after it opened, whichever comes first. It is always written before the events of any command that began after it. A page that sends the browser on at once can leave its navigation with no title.
- A new path within the document, through the history API, is written at once, with the title as it stands. A title the page sets later is not a navigation. The next action or look reads it.

`cause` is one of three:

- `goto`: the navigation a `goto`, `reload`, `goBack` or `goForward` started.
- `action`: a navigation the page asked for while an action's input was on its way. For a click, a key or a scroll, that runs from the input until Retest's next call into the page has answered, since Chrome can report a link's navigation after the click itself has answered. For `select`, it runs from each key it types, as for a key.
- `page`: anything else, such as a redirect the page makes on its own after it loads, a timer, or the browser. A navigation a `setTimeout` in a click listener starts is the page's.

A navigation that a `goto` or an action started names that command's step in `stepId`, and where the command is in the test file in `location`. That holds however late it commits, as when Chrome reports a link's navigation after the next command has begun. Any other navigation names the step the test was in when it committed, and has no `location`.

A problem no single test explains, such as a browser that did not start, is the run's own `failure` in `run.finished` and `result.json`. A file whose process failed outside its tests has a `failure` of its own, and a `file.failed` event.

Paths inside the folder are relative, so the folder can be moved. The JSON Schemas for events and results are in `dist/schemas` after a build.

`schemaVersion` is still 1, and every field this release added is optional, so a reader built from this release reads run folders written before it. The other way round does not hold: every object in the schema refuses a key it does not know, so a reader built before this release, `readRunFolder` and `inspect` included, refuses a run folder written by it. Every attempt now writes `execution` in `test.started` and `ending` in `test.finished`, so that is every folder with an attempt in it, not only one with an AI check, a diagnostics artifact or a RegExp locator. Keep the reader as new as the writer.

## Records and the session they came from

Every record that comes from a session carries the same keys: `testId`, `attemptId`, `app`, `sessionId` and, when the record rests on a look, `observationId`. A session is one app's page in one attempt, and its id is the attempt's id and the app's name, such as `k3v9q0x2mb:web`. Events name the app in `session`, as they always have; every other record calls it `app`. A key is there only when the writer knew it.

| Record | Keys it carries |
| --- | --- |
| `action.completed`, `action.failed`, `navigation` | `testId`, `attemptId`, `session`, `sessionId` |
| `observation` | the same, and `observationId` |
| `assertion.passed`, `assertion.failed` on a locator or the page | the same; `observationId` when it names a look, and `sessionId` is the session that served that look |
| `host_check.passed`, `host_check.failed`, `state.saved` | `testId`, `attemptId`, the app, `sessionId` |
| `evidence.captured` and a screenshot in `result.json` | `attemptId`, the app, `sessionId`, `source`, `capturedAt`, `capturedElapsedMs` |
| each line of a diagnostics artifact | `testId`, `attemptId`, `app`, `sessionId` |
| each screenshot an AI check sent its judge | `testId`, `attemptId`, `app`, `sessionId`, `source`, `capturedAt`, `capturedElapsedMs` |

`source` says what took a screenshot: `chromium` for a Chromium page or an Electron window, `firefox` or `webkit` for a page of those engines, each taken through the engine's own protocol, or a native session's own source, `executor-screen`, `simulator-display` or `window-crop`. `capturedAt` is the wall-clock time the capture came back. `capturedElapsedMs` is the same moment on the run's clock, in whole milliseconds since the run started, the clock every event's `elapsedMs` counts on, so a screenshot falls between the events around it.

To find everything one session produced, read `events.jsonl`, `result.json` and the diagnostics artifacts, and keep what has its `sessionId`. `inspect --test` shows the source and the session on each screenshot's line:

```text
     5.3s  screenshot .retest/runs/<time>/artifacts/tests-tasks-retest-ts-saves-a-task-<hash>-k3v9q0x2mb-web-<hash>-failure.png  chromium, session k3v9q0x2mb:web
```

A screenshot is pixels. Text redaction never reaches it: a secret the page shows is in the picture. Keep run folders where secrets may be kept.

A recording of a Chromium page uses Chrome's screencast of that page. Chrome sends frames when it chooses to, as the page paints, and waits for each to be acknowledged before the next, so some paints never arrive as a frame. Retest keeps each frame as the JPEG or PNG Chrome encoded and stamps it with the run's clock and the page's identity. A page that stands still sends no frames, and the video shows its last frame for as long as it stood still. No frame between two moments never means nothing appeared on the page in between. Retest's own tests feed those frames to its media process and check what it wrote.

`schemaVersion` is still 1 and these keys are optional, so a reader built from this release reads older run folders. A reader built before them refuses a folder that has them, which is every folder with an action, a navigation or a screenshot in it.

## Recording a run

Recording is off by default. Ask for it in `retest.config.ts`; no recording CLI flag is implemented:

```ts
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
  recording: {
    record: true,
    apps: { web: true },
    required: false,
    keep: 'all',
    fps: 10,
    size: { width: 1280, height: 720 },
  },
  pixels: { web: { screenshots: 'allowed', recordings: 'allowed' } },
})
```

`record` asks for every configured app. An `apps` entry overrides it for that app: `false` excludes an app, and `true` records only that app when `record` is false. `pixels.<app>.recordings: 'never'` forbids its recording. Naming that app as `true` is a configuration error. `required: true` with no recorded app is also an error. Frame rate is an integer from 1 to 30; width and height are even integers from 16 to 4096. Defaults are 10 fps, 1280 by 720, and `keep: 'all'`. `keep: 'failures'` removes a passed attempt's recording under [the retention rules](#what-is-kept). `RunOptions.recording` replaces the whole config block for a programmatic run.

The runner currently accepts `RunOptions.media: { executable, ffmpeg? }`, or `RETEST_MEDIA_BINARY` and `RETEST_FFMPEG`. It starts no media process or discovery when recording is off. Automatic use of the install cache is awaiting the media discovery interface; an installed binary can be named explicitly. ffmpeg is a host prerequisite. No tool is downloaded by a run.

Each recorded app session has one recording for its attempt. Another attempt has another id and path. Capture starts before the first action and ends after the last assertion and host check. The runner then saves the recording before closing its pages, media process and browsers. An interruption, timeout or lost browser follows the same bounded finalization path. A lost media worker is restarted once for a later recording; losing that replacement refuses further recordings.

Evidence is separate from the test's observed outcome. The result and JSONL carry `evidenceStatus`, with `state: 'complete'`, `'partial'`, `'unavailable'` or `'not_requested'`. A partial or unavailable state names its gaps. When recording was not requested the optional field is absent. Human and agent reports show evidence separately. A recording failure does not turn a passed test into a failed test. If `required` is true, incomplete evidence makes the run end with `evidence_incomplete`, exit 2; an already failed test still leads with exit 1. Every test keeps its observed outcome.

`recording.started` names the run, test, attempt, app session, capture mode, output, dimensions and rate. `recording.finished` adds the frame tallies, media counts, status, reasons and video facts. A recording that could not begin has only a finish event saying why. A usable video has a portable `path`; an unchecked leftover has only `partialPath` and never claims to be playable. A killed run's leftovers are removed only after its recorded owner is confirmed gone; active or unreadable owners are left alone.

The recording's `clock.videoZeroUs` is the first frame's time on the run's clock. For an event, subtract it from `elapsedMs * 1000` to find the video's microsecond position. When `clock.shortened` lists shortened gaps, subtract their elapsed shortening before seeking. A screenshot keeps its own capture time and source. Sampling, still-page holds and withheld stretches never prove that nothing appeared between frames.

Secret fills are withheld conservatively: the runner has no driver masking fact yet, so even a password input is treated as unread. Frames and failure screenshots of that session stay withheld until a new document or session end. An unknown action outcome keeps the stretch open. The recording reports `pixels_withheld` separately from dropped frames. AI screenshot evidence checks the same policy before capture and again before saving or sending returned pixels. The policy is active when recording is requested, an app declares `pixels`, or the config declares secrets. A screenshot check in a run with recording off still refuses pixels during a secret withholding stretch. Text redaction never protects pixels.

## Artifacts

Screenshots, recordings, frames, diagnostics and the report live in the run folder and nowhere else. Each has one place:

```text
<run>/artifacts/<attempt>/<app>/screenshot-failure-1.png     a screenshot, named by why it was taken and a number
<run>/artifacts/<attempt>/<app>/screenshot-evaluation-2.png  a screenshot an AI check sent its judge
<run>/artifacts/<attempt>/<app>/thumbnail-recording-1.jpg    a small picture made from a recording or a screenshot
<run>/artifacts/<attempt>/<app>/recording-1.mp4              a recording; recording-1.mp4.partial while it is written
<run>/artifacts/<attempt>/<app>/frames-1/000000.jpg          frames kept for an AI check of a stretch of time
<run>/diagnostics/<attempt>.<app>.jsonl                      one session's console and network records
<run>/report.html                                            the run's HTML report
```

`<attempt>` is the attempt's id. `<app>` is the app's name cut to a few letters, with a hash of the whole name, so two apps whose names differ only in case never share a folder. A name holds nothing else: no test title, no page text, no secret. A screenshot is `png` or `jpg`, as the target encoded it; a recording is `mp4` or `webm`, as the media process chose.

Records name each file by its path relative to the run folder, with forward slashes, so a run folder can be moved and still read. Such a reference is made of letters, digits, `.`, `_` and `-`, in parts split by `/`, none empty and none starting with `.`. A path with `..`, an absolute path, a backslash, a scheme or any other character is not a reference, and Retest refuses it without looking at the disk.

Retest reads an artifact only when all of this holds, and otherwise refuses it, naming why:

- `invalid_reference`: the record's path is not a reference.
- `missing`: nothing is there.
- `symbolic_link` and `outside_run_folder`: some part of the path is a symbolic link. Retest follows no link in a run folder; `outside_run_folder` says the link leads out of it.
- `hard_link`: the file has more than one name. The other name could be anywhere, so Retest reads only a file with one name.
- `not_regular_file`: a folder, a pipe, a socket or a device.
- `too_large`: over the size the reader stated. Every read states one.
- `changed`: the file, or a folder above it, was swapped between the check and the open, as for a link, or the file grew or shrank while it was read.

Retest checks every part of the path without following links, opens the file without following a link and without waiting on a pipe, then checks that the open file is the one it checked, that every folder above it, the run folder included, is still the folder it checked, and that the file's name still leads to it. A program that flips a folder between a link and the real folder several times, each flip landing between two of those steps, could still get a file read through the link. Node has no way to open a file relative to an open folder, and macOS no way to ask an open file for its path, so nothing closes that gap entirely. Such a program already runs as you; the checks stop a link or a second name left in a run folder, and any single swap.

Retest can also list what a run folder holds against what its events and `result.json` name: each named file that is there, each named file that is not, with why, each file nothing names, and every link or special file it did not follow. The run's own files, `events.jsonl`, `result.json`, `report.html`, `logs/` and `states/`, are left out.

### What is kept

Everything is kept, except in two cases:

- When the config keeps recordings of failures only, an attempt that passed loses its recordings, and the thumbnails made from them, once the attempt has finished and its recordings have ended. A recording an AI check judged is kept, and so is every recording of an attempt that did not pass: failed, error, inconclusive or never run.
- When the run finishes and the media process has closed, a `.partial` file a lost recording left under `artifacts/` is removed, unless a record names it as what was left of that recording.

Screenshots, frames, diagnostics, the report and logs are never removed. Nothing outside `artifacts/` is removed, a file whose path has a link in it or that has a second name is kept, and nothing is removed at any other moment. Each removal is recorded before the file goes, so no record ever names as present a file that is gone. If the file then cannot be removed, that is recorded too, and the file counts as present.

A run without recording keeps its existing screenshot and diagnostics behavior. Recording runs use these artifact paths and retention rules.

## What may be captured as pixels

Text redaction hides a secret's value in every text Retest writes. It never reaches pixels: a screenshot or a frame shows whatever the screen showed. So Retest decides what it captures by a separate policy.

### What each app allows

Each app has two rules, `screenshots` and `recordings`, each `allowed` or `never`. Both are allowed unless the config says otherwise.

- `screenshots` covers every single capture: the screenshot taken when a test fails, the screenshots an AI check sends its judge, and an agent session's frames.
- `recordings` covers frames that run: saved recordings and live frames sent to a viewer. Allowing them does not turn recording on; a run records only when asked.

A capture the rules forbid is not taken. The run says so where the capture would have been. An AI check whose evidence was not taken cannot pass: a required check without its evidence is never a pass.

### Around a browser secret

While a browser secret is typed into a field that shows its text, Retest stops requesting new captures of that app's session and pauses its screencast. A Mac window capture also stops while any session is withheld, a rule kept from when it was cut from the shared display. A capture already dispatched when the stretch opens cannot be undone; its image is discarded on arrival if its read window overlaps the stretch, and the missing interval is recorded as withheld. Capture resumes after the stretch closes and the old screencast has confirmed its stop. The stretch begins just before the first key is sent. It ends when Retest sees one of these:

- the field is gone from the page or the screen, or no longer shown;
- the field reads back empty;
- the field now masks its text;
- the page opens another document;
- the session ends.

A fill that sent no key ends its stretch at once. A fill whose keys may or may not have gone keeps it. A page that moves to another path within the same document has not left, so the stretch goes on until the field is seen gone.

A capture is withheld when the time it could have been taken touches the stretch: from the moment it was asked for until it reached Retest. A screenshot taken just before the field was seen empty, and back just after, is withheld. A screencast frame is not asked for, so its time starts when the screencast last started: once a stretch has begun, the screencast must start again after it ends before its frames are kept.

The withheld stretch is recorded as withheld by policy, with the app, the session, the secret's name and when it began and ended. It is never counted as dropped frames, and a gap in a recording that it explains never means nothing happened on the screen. A failure screenshot that falls in the stretch is withheld, and the run says why.

A macOS app's window capture is withheld while any session of the run has a stretch open; the window's own image holds no other window, but the rule is kept from when the capture was cut from the Mac's display.

### Browser fields that mask what is typed

The policy can keep capturing a field that masks every character as it is typed, when the driver supplies its field facts before the first key and again after the last key. It recognizes these facts:

- In Chromium, Firefox and WebKit, an `<input>` whose `type` property is `password` masks. The property reads `text` for a type the browser does not know, so a made-up type never counts.
- A text input, a textarea, an element edited through `contenteditable`, or any other field shows its text. A style that hides the text, such as `-webkit-text-security`, does not count: a script can take it away, and not every engine draws it.
- A field the driver could not read is treated as showing its text.

If the field masked when the first key went and no longer masks after the last, capture is withheld from then on, and the record says captures since the first key may show the secret.

### What the policy cannot protect

- A secret the app shows on its own: echoed on the next page, in a message, or in a field a "show password" button reveals, whether the app or the test presses it.
- An app that unmasks a field while the keys are being typed, before the read after the last key.
- Text the app showed before Retest was told it is a secret, such as a one-time code a function source returns after the page already showed it.
- Frames already sent live to a viewer before the field was read as unmasked.

Keep run folders, and anything a run sends elsewhere, where the secrets they may hold can be kept.

### Native secret entry

Native secret entry keeps pixels by default: secure fields rely on the platform's dots and required masked read-back, while plain fields may show characters in screenshots or video. Set `recording: { nativeWithholding: true }` or the overriding environment variable `RETEST_NATIVE_WITHHOLDING=true` to enable the earlier plain-field withholding and guarded resume; secure fields never withhold in either mode.

`RETEST_NATIVE_WITHHOLD_RESUME` has been removed. Withholding resumes only after the guarded rule verifies an unfocused masked or empty field, the verified filled field's disappearance, or its owned window's disappearance, with no software keyboard on iOS. Failed or uncertain reads keep an enabled stretch open. `RETEST_NATIVE_WITHHOLDING=false` restores the default. The setting applies to recording frames, failure screenshots and evaluation screenshots even when recording is off. Only the literal environment values `true` and `false` are accepted. Browser withholding is unchanged.

`capture.native_entry` records the branch "typed into a secure field", "typed into a plain field, pixels kept", "typed into a plain field, pixels withheld", or the corresponding unreadable-field branch, without secret characters. A secure fill's `capture.masked_entry` records `readBack: length_matched` only after successful masked verification. Failed read-back or unknown input keeps its failure and sends no second input. The resume event keeps its earlier reason and identity requirements, and every capture whose read span overlaps an enabled stretch remains discarded after resume. These are additive version 1 events and fields; current readers accept older folders, while older strict readers refuse folders carrying the additions. Text redaction does not protect pixels or an app's later password echoes.

## Use Retest from code

A program can run tests itself, with no command line. This guide calls such a program a host. A host runs Retest on its own machines, often for apps it did not write. The root export stays the authoring API, and a host uses two subpaths:

- `@rehearsal-labs/retest/runner` exports `runFiles`, `collectFiles`, `validateConfig`, `resolveSecrets`, `readRunFolder`, `defaultTimeouts`, `mergeTimeouts`, `RunFolderError`, `RunFolderReadError` and `LaunchError`, and the types a caller needs: `RunOptions`, `StopReason`, `HostCheck`, `RunFolder`, `CollectOptions`, `CollectResult`, `LoadedConfig`, `ResolvedSecret`, `ResolvedSecrets`, `Reporter`, `ChildOutput`, `LaunchBrowser` and the browser contract a custom launcher implements, `PageNavigation` included. It also exports the session contract's types, which a driver implements. A `WebRuntime` names what it runs on in `identity`, and a `WebSession` answers `dispatch(command, timeoutMs, signal?, token?)` with the result `execute` gives and how far the command's input got: `not_sent`, `sent` or `unknown`. A launcher a host passes still returns an `OwnedBrowser`, and a run does not record how far an input got yet. `SessionBudget` counts browser sessions across runs, and `HostPreparation`, `PreparationAnswer`, `PreparationContext`, `CleanupContext`, `SessionOptions` and `Requirement` type the options below.
- `@rehearsal-labs/retest/protocol` exports the event, result, command and failure types, their schemas, `parse`, `testId` and `testTitle`, `defaultTimeouts` and `mergeTimeouts`, `eventSchemaUrl` and `resultSchemaUrl`, the file URLs of the JSON Schema files, and `eventsFile`, `resultFile` and `logsFolder`, the names of a run folder's files, and `formatSessionId`, which writes a session's id. `PageFacts`, `NavigationCause`, `OptionChoiceRecord` and `EvidenceReference` are among its types, and so are `ExecutionRecord`, `PreparationRecord`, `CleanupRecord` and `Ending`, with their schemas.

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

A test declared with `test.skip` never runs, so a check keyed to it, by its id or by its file, is never made. The test stays `skipped` and the check `not_run`, and the run cannot pass: it ends with `host_check_failed`, exit 2, naming the test and the check, in `run.finished`, `result.json` and every report. The same holds for an AI check a host keys to a skipped test.

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

The parent writes `host_check.passed` or `host_check.failed` for each check, with the check, the app, what the page showed on the last look, how many times it looked and for how long. `run.started` records every check the run was asked for, so a reader can tell a check that was never asked for from one that is missing. Each test's result lists its checks in `hostChecks`, in order, with `passed`, `failed` or `not_run`. A check that never ran is listed in its test's `test.finished`, under `hostChecksNotRun` with its app, and a host AI check that never ran has an `evaluation.finished` with the verdict `not_run`, so a result rebuilt from the events lists every check `result.json` lists. A check's `text`, `name` and `path` are redacted as page text is, since a host holds the run's secrets and writes every field of a check; the page is still asked for the text, and the path still matched, as written.

Reports show a failed check as a card of its own:

```text
    Host check failed  address on web
    Expected         http://127.0.0.1:4173/
    Page             "Account" at http://127.0.0.1:4173/account
    Waited           303 ms, looked 4 times, limit 300 ms
```

A check that did not run is a `Not run` line on the test's card. The summary gains a row such as `Host checks  4 failed · 10 passed · 1 not run`. Passing checks add nothing else. The agent report writes a line such as `host_check_failed address on web expected http://127.0.0.1:4173/thanks, page "Your cart" at http://127.0.0.1:4173/cart`.

The command line cannot give host checks, so a report of a run that had them prints no command to run a test again. Each card points to `retest inspect` instead. The same goes for a run whose config has no file behind it.

### Host AI checks

`RunOptions.hostEvaluations` holds AI checks the host requires, keyed as host checks are, by test id or file. The parent runs them itself, on that attempt's pages, and test code cannot skip, weaken or answer them. `/runner` exports their types, `HostEvaluation` and `HostEvidence`, and `/protocol` exports `EvaluationRecord` and the types inside it.

```ts
hostEvaluations: {
  [file]: [
    {
      id: 'saved-message',
      criteria: { saved: 'The message says the task was saved.', named: 'It names the task.' },
      evidence: { capture: 'screenshot', app: 'web' },
    },
  ],
}
```

- `id` names the check and never changes. `criteria` maps each criterion's id to its requirement. `evidence` is `{ capture: 'screenshot', app? }` or `{ text, label? }`, one or a list. `judge`, `context` and `timeoutMs` work as in `test.evaluate`, and the config's `defaultJudge` applies.
- Every host AI check is required. A test passes only if its body, its host checks and its host AI checks pass. Its own `timeoutMs` may shorten the config's, never lengthen it.
- They run after the host checks, and only when the body, the test's own AI checks and the host checks all passed. Otherwise each is listed as `not_run` and adds nothing to the failure the test already has.
- A run interrupted before or while they run ends the check in flight `cancelled` and lists the rest as `not_run`, and the interruption is the test's failure, as with host checks: a test whose required check never ran never passes.
- The parent captures their screenshots from that attempt's sessions, and each record names the attempt and the session. A test that asks for the same requirement as advisory, or catches an error, changes nothing about the host's check.
- Before any test runs, the run refuses each of these as a usage error, exit 2, and starts no browser: a key that names no selected test and no selected file, host checks in a run with no judges, a judge the config lacks, evidence the judge does not take, an app a test does not use, an id a test gets twice from its file and its own key, an unknown key, a criterion that is empty or has an id that is not a name, and a `timeoutMs` that is not a whole number from 1.
- `run.started.options.hostEvaluations` records every check the run was asked for, with every value hidden in its criteria, context, evidence text and labels, as a host check's text is. Each record in a result has `source: 'host'`.
- A host whose judge reads a key from its own secret store gives the credential as a function. The parent calls it once, and the key never reaches the test file's process, the run folder, an event or a report.

### Participants with their own accounts

A test that names several apps gets a browser context and a page for each, and the apps of one config may share a base URL. That is how one flow holds several participants, such as an owner and a member, each signed in as a different test account: give each app its own `test.setup` and name the states in the test's `state`.

```ts
test.setup('owner-account', { apps: ['owner'] }, async ({ owner }) => { /* sign in as owner-a */ })
test.setup('member-account', { apps: ['member'] }, async ({ member }) => { /* sign in as member-b */ })

test('the member reads the record the owner made', { apps: ['owner', 'member'], state: { owner: 'owner-account', member: 'member-account' } }, async ({ owner, member }) => {
  const reference = 'record-' + randomUUID()
  // the owner makes the record under `reference`; the member opens it by `reference`
})
```

Each participant keeps its own cookies and local storage. Each look and each screenshot names its session, the attempt's id and the app, so the parent can tell whose page it was. On Chrome this is tested with two and with four participants on one origin, each signed in as its own account. Find a shared record by a value the test made, not by a title another attempt may also have used.

Participants are the apps a test declares before it runs. A test cannot open another context, a popup or a second tab.

### Session limits

`RunOptions.sessions` holds back a run's browser sessions. A session is one browser context and its page, not a browser process.

```ts
const budget = new SessionBudget({ perOwner: 4, host: 8 })
await Promise.all([
  runFiles({ ...options, outputDir: first, sessions: { owner: 'worker-1', budget } }, []),
  runFiles({ ...options, outputDir: second, sessions: { owner: 'worker-2', budget } }, []),
])
```

- `owner` is whoever the sessions count against, such as one of the host's workers. The host vouches for it; Retest takes it as given.
- `budget` is shared by every run given the same one, in one process. It never lets one owner hold more than `perOwner` sessions, or all owners together more than `host`.
- An attempt asks for a session for each of its apps, all at once. It never holds some while it waits for the rest. It asks after its locks, and the wait counts against none of its budgets.
- Requests are served in the order they came. One held back by its own owner's limit keeps no other owner waiting. The first one held back by the host's limit keeps the sessions that free up, so a test with four apps is never passed over forever by tests with one.
- An attempt waits at most `waitMs`, the setup budget by default. One that gets nothing in that time does not run, with `setup_failed`. So does one that needs more sessions than either limit allows, at once.
- An attempt gives its sessions back once it has closed its browser contexts and its host cleanups have run, a stopped run's too, within the cleanup budget. A context that could not be closed keeps its sessions until its browser closes, which may be the end of the run.
- A stopped run withdraws every request it was waiting on.
- `session.reserved` records, before `test.started`, the owner, how many sessions the attempt took, how long it waited and what was active once it had them. `session.released` records when it gave them back: `after: 'contexts_closed'`, `'browser_closed'` when its contexts could not be closed, or `'run_ended'` when not even their browser or native app could be confirmed closed, given back once every runtime of the run had been asked to close. `run.started` records the owner and the limits.

Without `sessions`, nothing is counted, and runs work as before.

### Agent sessions

An agent, such as a model exploring an app, can drive a browser without a test file, through the same drivers, page commands, looks and session budget a test uses. The API is `AgentHost` and `AgentSession`, imported from `@rehearsal-labs/retest/agent`.

```ts
import { AgentHost } from '@rehearsal-labs/retest/agent'

const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath } }, budget, logFolder, secrets: { values: { password: { value } } } })
const opened = await host.open({ owner: 'worker-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'chromium', baseUrl })
if (!opened.ok) throw new Error(opened.failure.message)
const { session } = opened
await session.act({ kind: 'goto', url: '/login' })
const field = await session.observe({ by: 'testId', value: 'user' })
const [first] = field.ok ? field.look.elements : []
if (first !== undefined) await session.act({ kind: 'fill', ref: first.ref, value: 'owner-a' })
const saved = await session.saveState()
await session.end()
await host.close()
```

- A target names its engine, and an open names the target and the engine. A target on another engine is refused by name, and so is a browser that says it is another engine than its target's, which the host then closes. No engine runs in another's place. Each target's browser starts once, with that engine's own driver, and every session opens in a new browser context of it. A browser that is lost is closed two seconds later through its own driver's close, which removes its profile, and started again for the next session that asks. The host closes every browser it started when it closes.
- `open` never throws, whatever a launcher does, and gives back everything it was granted when it fails. A failed launch is forgotten, so the next open tries again. `close` waits for a browser still starting, within the setup and cleanup budgets, closes it as it arrives, and reports a close that failed instead of answering `ok`.
- `open` waits for one session from `budget`, the same `SessionBudget` that `runFiles` takes in `sessions`, and for the named `locks`, all at once. One that gets nothing within `waitMs`, the setup budget by default, is refused with the words a test gets, holding nothing. The refusal names only the asking owner's own sessions, in `details.heldBy`, and counts every other session in `details.heldByOthers`. The session holds a lease through the same resources table a test attempt uses. Agent sessions and test runs given one budget never hold more sessions together than it allows. A lock keeps the sessions of one host apart; it is not a test run's lock.
- Every call has a budget, and the session's `holdMs` bounds them all. It is at most the host's `timeouts.hold`, ten minutes by default, and a request for more is refused by name. A call never throws for a page problem: the answer carries the failure. A session that held its browser for its whole hold is ended. So is every session of a host that is stopped (`host.stop(reason)`), and every session of a browser that is lost. Ending stops what runs: input not yet sent is never sent, and input already sent is not taken back. Then the context is closed within the cleanup budget and the session goes back to the budget. A context that would not close keeps its session counted until its browser closes. `session.ended` settles with why it ended: `ended`, `held_too_long`, `caller_silent`, `stopped` or `lost`.
- The caller holds its session through a lease. Every call renews it, and so does `session.renew()`, which sends nothing to the page. A session that hears nothing for its whole lease, the host's `timeouts.lease`, one minute by default, while no call is running, is ended as `caller_silent`, and its context and session are given back. A caller that waits for a person between calls renews the lease while it waits.
- `act` sends one of the commands a test's page takes: `goto`, `reload`, `goBack`, `goForward`, `click`, `hover`, `fill`, `press`, `select`, `check`, `uncheck` and `scroll`. An element is a `locator`, or a `ref` from a look. The answer is the page's result, redacted; `input`, how far the input got (`not_sent`, `sent` or `unknown`); and the recipe it went to. A session takes one action at a time. Looks, checks and saving state may run beside each other, but never beside an action, and a call that would overlap is refused before the page is asked. Frames are taken beside anything.
- `observe(locator)` reads a locator's matches once and lists up to 100 of them, each with a reference: `{ sessionId, observationId, element }`. A reference is good only in the session that served its look, while that look is among the session's last 32, on the document the look read, and while a fresh read of the look's locator still lists the same matches with the same text and visibility. Otherwise it is refused, `details.refused` says why (`other-session`, `unknown-look`, `expired`, `new-document`, `changed`, `no-element` or `unpinned`), and nothing is sent. `observePage()` reads the address and the title.
- A reference acts only on the element it names, never on another element that shows the same text. `session.pinsElements` says whether the session's driver can hold one element from a look to the action. Chrome's and Firefox's can: a reference acts on the very element its look listed, wherever the look listed it, twins that show the same included. It is refused with `changed` when that element is no longer at its place, and when the page puts another element in its place while the action waits for it, the page answers `not_actionable` with `details.refused` `moved`. Either way nothing is sent. WebKit's driver cannot hold an element yet. There a reference acts only when its look listed that one element, through the look's own locator: should the page add a second match before the input goes, the action is refused instead of going to another element. Refused there, with `unpinned` and nothing sent: a reference into a look that lists more than one element, and one into a look whose locator keeps a match by its place (`first()`, `last()` or `nth()`). To act on one element of a list there, look with a locator that finds only it, or act with a durable locator.
- A saved test keeps a recipe, never a reference. `recipe(ref, locator)` turns a reference into one only when a read proves the recipe finds that very element. Finding an element that shows the same text proves nothing, since another element can show it too. The recipe keeps no match by its place. On Chrome one read finds the look's element at its place and the recipe's element at once, and accepts the recipe only when both are one node; a recipe that finds another element is refused with `other-element`. Firefox's and WebKit's drivers cannot compare two elements yet, so there the only recipe a read proves is the look's own locator, when that read finds exactly one element, and every other recipe is refused with `unproven`. There, look with the locator you want to keep, and ask for the recipe of the one element that look lists.
- `saveState()` saves the context's cookies and `localStorage`, with the session it came from, that session's owner and app, and when. It holds session cookies, so it is the host's to keep. `open({ state })` restores it into a new context before the page loads anything, and only for a session of the same owner and app; another is refused by name (`other-owner` or `other-app`). A session opened without it starts empty. Nothing else passes between sessions: what one does after its state was saved never reaches another.
- `frame()` is one PNG of the page, as the driver encoded it. `frameSource()` is the driver's own live frame source for the media process, its frames carrying the session's identity and kept encoded. Chrome's is its screencast. Firefox's and WebKit's drivers give none through the session contract, so it is refused by name there.
- `check(hostCheck, requirement)` runs a host's required check against the session's page with the runner's own host check, looking again until it passes or its time runs out, so it decides and words its result as a test's would. Its identity, the requirement's version, the check's id and the SHA-256 of its content, is the one a test held to the same requirement records for the same check, in every session and attempt. A frozen requirement refuses a changed check by name. A check that fails is a result with `details.checkId`, not a refusal.
- The host holds the secrets. A `fill` of `{ secret: 'password' }` types only on the session's base URL origin and the origins the host lists for it. An open may name the secrets its session may type, as `secrets: ['password']`; a fill of any other is refused and that secret is not read. Every text an answer holds, looks, failures and addresses included, is redacted.
- An agent session writes no events and no run folder.

Run on macOS arm64 with Google Chrome 154, Firefox 133 and Playwright's WebKit build 2359. Everything above passed on Chrome, Firefox and WebKit, with a live frame source on Chrome only and element identity on Chrome and Firefox. Four sessions typing at once on Firefox once answered as sent while text did not reach every field; that was a defect of the Firefox driver, now fixed. Firefox 133 runs a preload script twice in a new window's first document, and the copy without an input guard stopped the keys.

### Preparing an attempt's state

`RunOptions.prepare` holds the host's own preparation and cleanup, keyed as host checks are, by test id or file. A file's preparation runs before a test's own.

```ts
prepare: {
  [file]: {
    prepare: async ({ attemptId, signal }) => {
      const receipt = await fixtures.seed({ recipe: 'shared-records@1', signal })
      return { status: 'prepared', recipe: 'shared-records@1', seed: 1, receipt, metadata: { records: 1 } }
    },
    cleanup: async ({ prepared, failed }) => fixtures.remove(prepared?.receipt),
  },
}
```

- `prepare` runs once the attempt has its browsers, locks and sessions, after `test.started` and before the attempt opens a page. It has `timeoutMs`, the setup budget by default, and a `signal` aborted when that runs out or the run stops.
- It answers `{ status: 'prepared', recipe, seed?, receipt?, metadata? }`, or `{ status: 'failed' | 'uncertain', reason }` when it knows it did not prepare the state or cannot tell. A `recipe`, `seed` or `receipt` longer than 500 characters, or a `metadata` value that long, is refused, which makes the preparation `uncertain`; a `reason`, and the text of anything thrown, is cut to 500. `metadata` is up to 32 flat values. The record redacts every string; the cleanup gets the answer as it was given. A receipt names an operation; it does not prove the data is the same.
- A preparation that fails, throws, does not answer in time or answers anything else ends the attempt before any app action, with `setup_failed`, status `error`. The body never runs, and the preparations after it are not called. Giving up on a preparation does not undo what it started.
- A preparation that was never called, because an earlier one did not succeed or the run had stopped, is recorded as `not_run`, and its cleanup does not run. One the run stopped while it ran is `cancelled`, and its cleanup runs.
- `cleanup` runs once the attempt is over, whenever its preparation was called: after a pass, after a failure, after a failed preparation and after the run was stopped. A declaration with nothing to prepare runs its cleanup when every preparation before it was called; once one failed or the run stopped, the declarations after it, with or without a `prepare`, are left alone. After a stop without session limits, it runs before the run closes its browsers, so the attempt's pages may still be open; with session limits, it runs once the attempt has closed them. It has `cleanupTimeoutMs`, the cleanup budget by default. A cleanup that fails or runs out of time is a `cleanup_failed` in the test's `cleanupFailures`, beside its own failure and never in its place. Alone, it makes a passing test an error.
- Cleanup is the parent's work. A parent that is killed outright, such as by SIGKILL, runs no cleanup at all.
- `backendData: 'reused'` or `'external'` declares a backend that is not prepared: kept on purpose, or managed elsewhere. `apps` names the apps a preparation covers, all the test's apps by default.
- `preparation.finished` and `cleanup.finished` record each one, and the test's result lists them in `preparations` and `cleanups`.

Retest does not look inside the app's data, and it does not reset it. A fresh browser context is not a fresh database: a test can find what an earlier run left on the server.

### What an attempt ran

`test.started` carries `execution`, and the test's result keeps it:

- `bundle`: the modules of the project this attempt ran, by path from the root and the SHA-256 the parent read from disk, and a fingerprint of the list. That is the modules the test file's process loaded with the file, and the ones this attempt loaded for the first time, which `test.finished` adds in `bundle`. A module an earlier test in the same process imported first is that test's, so a test's bundle is the same in a full run and in a run of it alone, unless it imports that same module late itself. Modules under `node_modules` and Retest's own are left out.
- `configuration`: what changes how this test runs, and its fingerprint. That is its own apps' targets, browsers, channels, headless settings, emulated screens and proxies without credentials, its budgets, the locks it holds, the names of the variables the host gave its process in `testEnvironment`, never their values, the diagnostics policy, and the judges its host AI checks use: each one's adapter code (the SHA-256 of a file adapter, the installed version of a package adapter, or `codeUnavailable` for a factory), its options as a fingerprint, its time and limits, and the version of Retest's instructions to judges. The base URL and the browser's path are left out, since they say where things are, not how the test runs. A judge the test names only in its own `test.evaluate` is not known before it runs: each such check's record names its judge and the version that judge reported.
- `secretReferences`: the config's secrets by name and source, beside the fingerprint and not in it, since which of them a test types is not known before it runs.
- `runtime` (Retest, Node and the platform), `sessions` (each app's session id and the browser as it reported itself), `owner`, and `appBuilds`, which the host gives in `RunOptions.appBuilds` by app.
- `startingState`: for each app, whether its browser storage was `fresh` or `saved`, restored from a saved state, and its backend data as the host declared it: `prepared`, `reused`, `external` or `unavailable` when nothing was said.
- `unavailable` names what Retest could not record, such as `app-build:web` or `judge-code:<judge>`.

Every string is redacted before it is hashed or written, so a rotated secret changes no fingerprint. On Chrome, a changed helper, budget, target or judge adapter changes the matching fingerprint, and a file the test never loaded, or a judge it never uses, changes nothing.

### Requirements and check ids

`RunOptions.requirement` holds the version the host's checks belong to: `{ version: 'saves-v1' }`. With it, every host check needs an `id`. Host AI checks have one already. An id is bound to the SHA-256 of its check's content: kind, app, text or address, options and time, but not its `name`; for an AI check, its criteria, evidence and judge, the judge's adapter code and options included. The version and every string of a check are redacted before they are recorded or hashed.

`run.started.options.requirement` lists every check with its fingerprint. To freeze a requirement, pass them back:

```ts
requirement: { version: 'saves-v1', checks: { 'saved-title': '3f1c…', 'saved-reads-well': '9a07…' } }
```

Before any test runs, a frozen requirement refuses a check whose content changed under its id, a check it does not hold and one it holds that the run does not have, each by name, as a usage error. Any requirement also refuses a check with no id, one id for two different checks, a check that holds the value of a secret read from the environment, since a fingerprint is public, and an id such as `evaluation-1`, which belongs to a test's own AI checks. A changed check needs a new version.

A check's id is in its result, its events, and its failure's `details.checkId`. Each result has `ending`, which says what ended the attempt: `passed`, `assertion_failed` for the test's own checks, `required_check_failed` with `checkId` for the host's, `check_error` for a required check the parent could not complete, such as one whose page did not answer in time, `action_failed`, `setup_failed`, `timed_out`, `crashed`, `cancelled`, `outcome_unknown`, `inconclusive`, `evaluation_error`, `test_error`, `cleanup_failed`, `not_run` or `skipped`. `notRun` names each required check that never ran. An earlier action failure or a failed setup never reads as the intended check failing.

An ending rests on the parent's own records. A kind that names a required check, a crash or an unknown outcome needs the parent to have seen it: its host check failed, its browser was gone or the test file's process ended on its own, an action it dispatched never answered. A failure the test file's process only reports is the test's own, `assertion_failed` for a failed value check or an `expect.poll` that ran out of time, and `test_error` for anything else, whatever class it gives.

A test that reproduces a defect fails like any other, and exits 1. On Chrome, a fixed test passes against a correct app, fails at its intended check against a broken one and passes again once the app is repaired, with the same bundle, configuration and requirement fingerprints and only the app build changed.

### What a pass rests on

Every time the parent answers the test file's process with what the page showed, it writes an `observation` event first. Each look has an id, `o1`, `o2` and so on, counted within the attempt. A look at the page itself, for `url()`, `title()`, `toHaveURL` and `toHaveTitle`, takes an id from the same count and writes no event, so the ids of the `observation` events can skip one. An assertion at a locator that looked 13 times writes 13 events. `observed` holds what the process received, redacted, so page text that holds a secret reads `{{name}}` there.

A locator assertion names the look its verdict rested on, its last, in `observationId`, and sends back the session that served it. Ids start again at `o1` in every attempt, so the parent refuses an assertion whose session is not the one that served its look, as when a process names a look from an earlier attempt. The parent then judges each passed locator assertion again, on that look, with the same rule. It writes the matcher, the expected value, the comparison, the actual value and the page address from its own records, never from what the test file's process sent.

`assertion.passed` says who judged it, in `judgedBy`:

- `parent`: a locator assertion the parent judged on the look it names, or `toHaveURL` and `toHaveTitle`, judged on the look at the page the assertion names.
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
- The list of modules in an attempt's `bundle` comes from the test file's process, which says what it loaded; the hash of each is the parent's own reading of the file from disk when the list arrived. A process could leave a module out of its list.
- An attempt's `ending` rests on the parent's own records, never on the class of a failure the test file's process reports.
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

- 0: every selected test passed and cleaned up. Tests declared with `test.skip` do not count against it, and a run narrowed by `test.only` says so beside its exit code.
- 1: tests ran and at least one failed its checks, a host check, a required AI check or a strict diagnostics policy included, even if others hit problems.
- 2: nothing trustworthy came out, or a test could not be checked. This covers a required AI check that was inconclusive or could not run, a required diagnostics capture that was not complete, usage errors, an invalid config, a missing secret, missing files, collection and setup failures, a lost browser, tests that did not run, cleanup failures, results that could not be written, a selection that kept nothing or only skipped tests, a check a host required of a skipped test, and `test.only` when `CI` is set without `--allow-only`.
- 130: interrupted with Ctrl+C, or stopped by a program with a `Failure` as the reason.
- 143: stopped by SIGTERM, as a CI runner does on cancel.

SIGINT and SIGTERM take the same path: the running test stops, the run records `interrupted`, writes `result.json`, closes the browsers, stops the servers it started and deletes saved state. A second signal of either kind quits at once, and its exit hooks still end the browsers and servers and delete saved state.

130 and 143 win over everything. 2 for a run that cannot be trusted as a whole, one no test ran in, one whose output or a file's process failed, or one with a host check it could not run, wins over 1. Otherwise a failed test gives 1 before anything else: a test that errored, was not run or was left undecided beside a failed test still exits 1, and 2 only when no test failed.

## What Retest does not do yet

- Browsers: Chromium, Chrome and Edge, and Playwright's WebKit build 2359 and Firefox 133 on macOS. Firefox has no phone, touch or pixel ratio emulation and no proxy, and no AI check has judged a Firefox screenshot yet. WebKit has no phone or touch emulation and no proxy, its recorded frames cannot be AI evidence yet, and no AI check has judged a WebKit screenshot yet. iOS simulator and macOS apps run through the runner, one macOS app and one app per simulator in a test, with their swipe, keyboard and alert helpers run only against a stand-in executor. No Safari, real phones or tablets are claimed. Browser emulation is a desktop browser pretending.
- Checked on macOS arm64 with Google Chrome 154 and Chrome for Testing 153, and on Linux arm64 inside Docker with Google Chrome 154, Debian's Chromium 154 and Chrome for Testing 153. Milestone 3 ran on Linux only in its own integration checks, with Google Chrome 154 and Debian's Chromium 154. Linux on x86-64, Linux outside a container, Edge, Chrome beta, dev and canary, and CI runners were never run. Windows cannot work.
- The keyboard presses one key or one shortcut at a time: no key held down across actions, and no text typed key by key. `fill` types text. On macOS, only the shortcuts in Retest's table edit a field, and no shortcut was run on Linux.
- `select` chooses with the keyboard, and was run on macOS only. `scroll` is one wheel event, also on a touch screen: no swipe.
- Host checks are given only by a program, through `runFiles`. They read the final page, not the steps to it, and not frames or shadow roots. A navigation's `cause` says what opened that page, and nothing about the steps before.
- Retest does not sign in to a proxy. Only an `http` proxy was run.
- `--headed`, and `headless: false` in a config, were never run.
- Locators search the top-level document only: no shadow DOM, no frames. No `filter()`, `and()`, `or()`, `getByAltText()` or `getByTitle()`, and no XPath.
- No popups, dialogs, uploads, downloads, network mocking or visual comparison. A JavaScript dialog fails the command as unsupported.
- No retries, watch mode, custom fixtures or `test.extend`, and no `test.skip()` called inside a test with a condition. Files run on workers; the tests of one file do not. A lock lasts one run and is not shared with another process.
- `retest install` installs the pinned Chrome for Testing, Firefox, WebKit and Electron on macOS arm64, and builds the native executors and the media process. On Linux x64 it pins Chrome for Testing only, and installing it there was not run.
- No `toMeet` or `test.eval`. The agent session API has no package subpath and writes no events. AI checks judge text, screenshots and recorded frames: a screenshot cannot be cropped to a region or masked, and no live judge's accuracy has been measured on the labelled corpus; only the fake judges have run it. No provider has been called through the AI SDK adapter yet.
- Test files are loaded more than once: once to plan the run, and again for each visit that runs them. Top-level code runs each time.
- Screenshots are not redacted. A secret the page shows appears in its screenshot.
- A function source's value is hidden only from the moment its source gives it; page text read before that reached the test's process as it was.
- Locators match the page's text as it shows it, not redacted. Retest refuses a locator that holds a whole secret value, but a locator that holds part of one, with the text beside it, can still match it.
- A page that moves the keyboard focus into a frame of another site as the text arrives can receive the text there. Retest reports `outcome_unknown` and names the frame; it cannot stop typing inside a frame it is not attached to.
- Diagnostics come from Chromium pages only, within the scope above: no request or response body or header, no WebSocket message, and nothing from a frame of another site, a service worker or a shared worker. Network observation does not mock, wait on or replay a request.
- SIGKILL stops Retest without a result. `inspect` reads the folder as incomplete. On Linux, the last line of `events.jsonl` can be cut off; `inspect` leaves it out and says so. The browser profile it left is retained, since a later run cannot prove it is still disposable. Nothing stops a server it started, and saved state, with its session cookies, stays in its run folder.
- `list --json` has no published JSON Schema. Events and results do.

## Project documents

- [README](../README.md)
- [Architecture](architecture.md)
- [Playwright compatibility](compatibility/playwright.md) and [conformance on Chrome, Firefox and WebKit](compatibility/conformance.md)
- Where [Firefox](compatibility/firefox.md) and [WebKit](compatibility/webkit.md) differ from Chrome
- [The basic workflow cases](compatibility/workflow-cases.md)
- [Contributing](../CONTRIBUTING.md)
