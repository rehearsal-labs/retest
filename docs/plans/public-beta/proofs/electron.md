# Electron target on macOS

Phase 2 item 8 of [release-0.1.0.md](../release-0.1.0.md): Electron as a desktop target behind the session contract, driven by the Chromium driver over the debugging pipe. Recorded 3 October 2026.

## Result

An Electron app is a target, `electron({ executablePath, appPath, args?, userDataDir? })`, that Retest's Chromium driver runs over the debugging pipe of the app's own binary. Each test launches the app afresh in a process group of its own, with a data folder of Retest's in the temporary folder that goes when the app quits, or the folder the config names, which Retest leaves alone, and quits it when the test ends. The first window the app opens is the test's page. The fixture app in `fixtures/electron/` was driven through the CLI on the official Electron 44.5.1 build with the same locators, actions and checks a Chrome test uses. A deliberate failure failed at its check, and the refusals below were each named. The versions were recorded and checked against what the binary itself states. No process of the run was left afterwards. After the coordinator's fixes, `tests/integration/electron.test.ts` passed through the lock on its final version; before them, its earlier version passed in four runs, one inside the full integration suite. The flow that creates a task in Electron and checks it on the web ran on the cross-platform fixture's service, with a passing case, a broken-sync case that fails at the web's check and goes no further, and the secret rule on the Electron window; see below.

Host: macOS 27.0.1 (build 26A434), arm64, Node 24.12.0.

## The Electron build

| Fact | Value |
| --- | --- |
| Release | 44.5.1, `dist-tags.latest` of the `electron` package on the npm registry on 3 October 2026 (registry modified 1 October 2026) |
| Downloaded from | `https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip`, with `curl -fsSL`, and the release's `SHASUMS256.txt` beside it |
| Archive | 130,259,261 bytes, sha256 `1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c`, the same as the release's `SHASUMS256.txt` line for that file |
| Unpacked | `~/Library/Caches/retest-proofs/electron/44.5.1/dist/` with `ditto -x -k`, 314,588 KiB in 259 files. No quarantine attribute |
| Binary | `dist/Electron.app/Contents/MacOS/Electron`, sha256 `ca7e3290800255f5018160cff99cf6ecc58eae299c66148de1374a70e2715c83`, ad hoc signed (linker-signed), arm64 |
| Embedded | Chromium 152.0.7977.130, Node 24.21.0, V8 15.2.124.28-electron.0, from `process.versions` with the binary run as Node and from `Browser.getVersion` |
| Licence | MIT, `dist/LICENSE`, sha256 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` ("Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.") |
| Chromium's licences | `dist/LICENSES.chromium.html`, 20,111,209 bytes, sha256 `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` |

Electron is a binary in a cache outside the repository, as the WebKit build is. It is not a dependency in `package.json`, and nothing of Electron's source, Playwright's or Puppeteer's was read, copied or adapted for this lane. The fixture app is original.

## What the binary showed before the driver was written

Probes outside the repository, in `/tmp/retest-electron-probe/`, each speaking CDP over fds 3 and 4.

1. `--remote-debugging-pipe` works. `Browser.getVersion` answers `product` `Chrome/152.0.7977.130`, and the user agent carries `Electron/44.5.1` and the app's own name.
2. `--user-data-dir` is honoured: the profile went to the named folder, and nothing to `~/Library/Application Support/<app name>`.
3. `Target.createBrowserContext` answers `-32000 Failed to create browser context.`, and `Target.createTarget` answers `Not supported`. Retest cannot open a page or a context of its own in an Electron app.
4. Each `BrowserWindow` is a `page` target, all in one browser context.
5. The shell this session runs in has `ELECTRON_RUN_AS_NODE` set. With it, the binary ran as plain Node and printed `bad option: --remote-debugging-pipe`. The driver withholds the variable.
6. Electron reads its pipe at about the time the app is ready. In three of three runs, a browser-level `Target.setAutoAttach` with `waitForDebuggerOnStart` reached Electron after the app's ready handler had created its window, so the first window was never paused (`waitingForDebugger: false`); a later window was paused. The driver therefore discovers windows and attaches, and starts Retest's change observer in the first window's current document as well as in later ones.
7. Closing the pipe quits Electron: the main process exited with code 0 130 to 210 ms later and its process group was gone, in six runs, three of them with an app that stays open when its windows close. `Browser.close` did the same in three runs.
8. With `--use-mock-keychain`, `safeStorage` encrypted and decrypted, and the login keychain held no `retest-keychain-probe Safe Storage` or `Electron Safe Storage` item afterwards. Only the run with the switch was made, so no keychain prompt could appear.
9. A launched window here was visible, focused, and fired `requestAnimationFrame`, with and without `--disable-backgrounding-occluded-windows`. No switch was added for covered windows.

## The Electron and web flow on the shared service

`tests/integration/electron-web-flow.test.ts` starts the fixtures lane's service (`fixtures/cross-platform/service/server.ts --port 0 --sync-delay-ms 1000 --network-log <file>`) and runs Retest through the CLI with two apps: `desktop`, the Electron fixture with `--service=<url>`, and `web`, `chrome({ baseUrl: <url> })`. One `.retest.ts` uses the named-app API: `{ apps: ['desktop', 'web'] }`.

1. In the Electron window it signs in as ada, typing the password as `secret('password')`, and creates a task titled `Release checklist <random>`. Seeded tasks share that title, so the task is followed by its id from then on. It reads the id from the window's address, `/electron/tasks/<id>`, through `desktop.url()`, and checks the window's `created-task-id` and `task-state-<id>`, `Open`.
2. On the web it signs in as ada and waits for `task-title-<id>` to show the title, once the service has passed the task on. It then opens `/tasks/<id>` and checks `selected-task-id`, `selected-task-title` and `selected-task-state` by id. Then it ticks `edit-done`, saves, and checks `Done`.
3. Back in the Electron window it waits for `task-state-<id>` to read `Done`, once the service has passed the change on.

What the passing run showed: exit 0. One `browser.started` for `desktop` with `product` `Electron`, `version` `44.5.1` and `target.electron`, and one for `web` with `product` `Chrome` and no `electron`. The service's network log has exactly one `POST /api/tasks` from client `electron` (201) and exactly one `PATCH /api/tasks/<id>` from client `web` (200), the id the window showed. The password is in no file of the run folder.

With `--broken-sync=web` the same test fails at the web's `task-title-<id>` check, naming the id: status `failed`, class `not_found`, since the web never gets a row for the task, and exit 1. The failure is the attempt's only failed check, on the `web` session. No action or check of the attempt follows it, and the service saw no `PATCH`.

The secret rule on the Electron window: a test with only the `desktop` app signed in when `secretOrigins` named the service's origin. Without it the fill failed `not_actionable`: "Retest did not type the secret "password": the page is on http://127.0.0.1:<port>, and it may be typed only on no origin, since no app it uses has a base URL. Add the origin to secretOrigins if it belongs there." The service saw no sign-in from that run. In the two-app flow no `secretOrigins` is needed, since the web app's base URL already names the service's origin.

The fixture's service mode, in `fixtures/electron/service-mode.mjs`, `renderer/service.html` and `renderer/service.js`, keeps the in-memory mode as the default.

- `--service=<url>` takes a plain http address on a loopback name; any other makes the app print why and exit 2. `--account=<name>` fills in the account. The password is never an argument or a variable: the test types it into the window, and the main process sends it to the service and keeps only the session token.
- Every request to the service is the main process's, with `x-task-client: electron`. Reads included, the network log names `electron` for each.
- The window's page is the app's own, shown under the service's origin at `/electron/…` through Electron's `protocol.handle('http', …)`. Every other request goes on unchanged through `net.fetch` with `bypassCustomProtocolHandlers`. This is what puts the window on the service's origin, so a secret bound to that origin may be typed into it. A secret is bound to http and https origins, so a `file://` window could never take one.
- The window asks for the list once a second while signed in, as the fixture's other clients do.
- `electron` was already a known client in `fixtures/cross-platform/service/clients.ts` and the README's `--broken-sync` row, so nothing in `fixtures/cross-platform/` was edited.

## Capabilities on an Electron target

| Capability | On an Electron target | Proven by |
| --- | --- | --- |
| Launch the app's own binary, own process group | Works. One launch per test; each further launch is a `browser.started` with `instance` | `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` (arguments and environment through a real spawned stand-in) |
| A data folder of Retest's | Made in the temporary folder, named as a browser profile is, and removed with what the app wrote in it after the app's processes are confirmed gone. Earlier launch leftovers are retained because a later app may use one as persistent storage. The record says the app started fresh | `integ/electron.test.ts` (8 folders, each gone, none in the run folder), `unit/runner-electron-target.test.ts` (removed after a failed launch too); retaining earlier leftovers is a later safety change, not a real-target claim from this proof |
| A data folder the config names | Used by every launch, one after another, each starting only once every process of the launch before it has gone, not when its pipe closed; left with what the tester put in it and what the app wrote; each attempt's `execution.startingState` says `browserStorage: 'reused'`. Two Electron targets naming one folder are refused by the config reader, naming both | `integ/electron.test.ts` (two launches and a second run), `unit/runner-electron-target.test.ts` (whole run on fakes, a failed launch, and the turn waiting for the process to go), `unit/config-electron.test.ts` |
| What "fresh" isolates | The Chromium data folder only. The `com.github.Electron` user defaults, shared by every unpacked app run on Electron's own binary, persist: they held four keys on this machine, whose writer was not established. So do the binary's cache folders under the user cache folder (`com.github.Electron`, `com.github.Electron.helper`, present here), `~/Library/Logs/<app name>` when the app writes logs (the fixture writes none), and whatever the app writes outside its data folder | Looked at by hand after the runs (`defaults read com.github.Electron`, `getconf DARWIN_USER_CACHE_DIR`) |
| `args` in the configuration fingerprint | Recorded as `{ count, sha256 }` of the list as canonical JSON, never the values; an added or changed argument changes the fingerprint; the binary's, the app's and the data folder's paths do not. A short secret could still be guessed from the hash, so the guide says secrets go through `secrets` | `unit/runner-fingerprint.test.ts` (a token in an argument is in no record), `unit/runner-electron-target.test.ts` |
| The app's output in its log | Each line goes through `redact` when the launch is given one, the app's own lines and Retest's notes alike; Electron's logging variables (`ELECTRON_ENABLE_LOGGING`, `ELECTRON_LOG_FILE`, `ELECTRON_DEBUG_NOTIFICATIONS`, `ELECTRON_LOG_ASAR_READS`, `ELECTRON_ENABLE_STACK_DUMPING`) are withheld. On the real binary, the fixture printed the typed value and the log held `{{password}}`; with `ELECTRON_ENABLE_LOGGING=1` in the environment no console line reached the log, and a probe showed that variable does print a window's console lines when the app sees it. A run passes `redact` once `run-session.ts` hands the pool the run's redactor, which the reservations lane does | `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` (both outputs of a spawned stand-in, and the variables withheld) |
| The first window as the test's page | Works | `integ/electron.test.ts` |
| Locators: test id, role and name, label, text, `first()`, `nth()` | Works | `integ/electron.test.ts` |
| Actions: fill, click, press, check | Works, through real input, with the input guard set up by the first action in a document that loaded before Retest attached; when the change observer cannot start there, the window's record and the log note it | `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` (the note) |
| Checks: `toHaveText`, `toHaveCount`, `toBeChecked`, `.not.toBeChecked`, `toBeVisible`, `toHaveTitle`, `toHaveURL` | Works, judged by the parent. No other matcher, action or locator was run on Electron | `integ/electron.test.ts` (`assertJudged`) |
| `reload`, `goBack`, `goForward` | Works | `integ/electron.test.ts` |
| Failure screenshot | Works: the window's page, without the window's frame | `integ/electron.test.ts` (PNG signature), kept run below |
| Console and network diagnostics | Collected from the first window from the moment capture starts: two console lines and the window's `file://` loads were captured. Both kinds are `partial`, with the reason "the app's window was already showing its page when capture began, so what the page logged or loaded before then was not captured", since the app shows its page before any test starts; a window that cannot say gets a reason that says so. The scope names `main_process` and `other_windows` in `notCovered` with a reason, in the summary and the artifact's first line: in `--service` mode every request is the main process's, and none is captured | `integ/electron.test.ts` (status, reason, scope in the artifact), `unit/runner-electron-target.test.ts`, kept run below |
| `goto` | A type error on an Electron app's page (`ElectronPage`), and refused as `unsupported` at run time, naming app and target; nothing reaches the window | `types/electron-targets/register.ts`, `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` |
| Later windows | Unavailable to a test: the contract has no surface for several pages of one app. Each launch writes `windows.json`: each window numbered in the order Retest learned of it, opened, closed, reachable, and `existing` for a window already open when Retest began to watch, whose order is the browser's and whose `openedMs` is when Retest learned of it. The browser log notes each new window | `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` (the marking) |
| The first window closed while the app runs | The next command fails `session_lost`, saying no other window is reachable | `integ/electron.test.ts` |
| Main process, native menus, native dialogs | Unavailable: a test reaches only what the first window shows | No driver surface exists |
| Sign-in state, save or restore | Refused as `unsupported`, through `openPage` and `saveState` as well; a `test.setup` runs its body before its state is refused, since refusing it earlier needs `run-session.ts`; `userDataDir` keeps the app's data instead | `unit/runner-electron-target.test.ts` (both refusals keep `unsupported`, and fail on the old `test-pages.ts`) |
| `baseUrl`, `headless`, `emulate`, `viewport`, `proxy` | Refused by the config reader, and by the page if one reaches it | `unit/config-electron.test.ts`, `unit/runner-electron-target.test.ts`, `types/electron-config.ts` |
| The window's first address | Known from the start: the page reads the frame tree again once its events are on, so a document that committed before then is held without a navigation. `toHaveURL` records it as `pageUrl` on the first check, with no navigation before it, for a `file://` window and an http one | `integ/electron.test.ts`, `unit/browser-page-open.test.ts` (fails on the old order) |
| A secret on a `file://` window | Refused `not_actionable`: a secret is bound to http and https origins, and a `file://` window has none; the value reached no file of the run | `integ/electron.test.ts` |
| A secret on a window served over http | Typed, once `secretOrigins` names the window's origin; the fixture serves its pages from `http://127.0.0.1:<port>` with `--serve=<port>` for that test; the value reached no file of the run | `integ/electron.test.ts` |
| What an origin means on Electron | Whatever the app says: an app can show its own page under any address, as the fixture's service mode does through `protocol.handle`. Allowing an origin for a secret means trusting the app with it, and in the two-app flow the web app's `baseUrl` alone let the password into the Electron window. A safer rule, a secret into an Electron window only when the Electron target is named for it, needs the fill's app in the secret check, which `run-session.ts` and `running-test.ts` hold | The two-app flow in `integ/electron-web-flow.test.ts` |
| Hidden variables and `ELECTRON_RUN_AS_NODE` | Withheld: the window showed `absent` for both with each set in the run's environment, and `present` for a variable that was not hidden | `integ/electron.test.ts` |
| Versions in results | `browser.started` (every launch), `result.json` `browsers`, and each attempt's `execution.sessions` (`engine` `chromium`, `product` `Electron`, `version` `44.5.1`), checked against `process.versions` of the binary. The release comes from the binary's files, the framework's bundle on macOS or the `version` file of Electron's own build, and from the user agent only when the files name none | `integ/electron.test.ts`, `unit/runner-electron-target.test.ts` (each source) |
| Nothing left running | No process names any launch's data folder after each run, every launch's pid is gone, and the harness's process-group checks pass | `integ/electron.test.ts` |
| A missing binary | `setup_failed` naming the path; nothing launched in its place | `integ/electron.test.ts` |
| `doctor` | Checks that the binary is a file it may execute and the app is there, names the Electron release when the binary's files state one, and says so when they do not; does not start the app | Run by hand on the kept project, passing and with a missing binary: `doctor.txt` and `doctor-missing.txt` below |
| Launches sharing a `userDataDir` at once | Take turns; a folder still held after the setup budget is refused by name | `unit/runner-electron-target.test.ts` only |
| Type errors | A typo, a `baseUrl`, a browser setting, a missing `appPath`, `args` that is not a list, `goto()`, `tap()`, an app that mixes Electron with a browser; the handle is `ElectronPage`, and `expect(page)` still offers the page matchers | `types/electron-config.ts`, `types/electron-targets/register.ts` |
| One test across an Electron app and a browser, on a shared service | A task made in Electron is found by its id on the web, changed there, and seen changed in Electron after the sync delay; under broken sync to the web the test fails at the web's check by id and runs nothing after it | `integ/electron-web-flow.test.ts` |
| Off macOS | The real-binary tests skip by name, `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on <platform>`, until the Linux route is built; on macOS a missing binary fails them | `integ/electron.test.ts` (the macOS path was run; the skip was not) |

Refusals and unavailable capabilities, for the inventory:

| What | How it is refused |
| --- | --- |
| `page.goto()` | Type error: "An Electron app has no address. Its page is the first window the app opens." At run time, `unsupported`: "goto() is not available on the Electron app desktop (target electron): the app has no address, and the test's page is the first window the app opened." |
| Any window after the first | Unavailable; recorded in `electron/<app and target>/<launch>/windows.json` and the browser log |
| Main process, native menus, native dialogs | Unavailable; no command reaches them |
| `test.setup` state from an Electron app | `unsupported`, after the setup's body ran: "Retest could not save the state "<state>": Retest cannot save a sign-in state from the Electron app desktop: the app keeps its own storage. Set userDataDir to keep the app's data from one launch to the next." |
| A saved state, base URL, emulation or proxy given to an Electron page | `unsupported`, naming the app: "Retest could not open a page: The Electron app desktop …" |
| Two Electron targets naming one `userDataDir` | Config error on the second: "is also the data folder of apps.<first>: give each Electron target a folder of its own" |
| `baseUrl` on an Electron app | Config error: "an Electron app has no address: the first window it opens is the page, so it takes no baseUrl" |
| `--user-data-dir` or `--remote-debugging-*` in `args` | Config error naming the switch, never its value |
| A secret on a window with no allowed origin | `not_actionable`, as on a browser |

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/config-electron.test.ts tests/unit/runner-electron-target.test.ts tests/unit/runner-fingerprint.test.ts tests/unit/browser-page-open.test.ts tests/unit/diagnostics-capture.test.ts tests/unit/diagnostics-policy.test.ts` | 95 pass | `/tmp/retest-electron-unit-files-review.log` |
| Three of the review's new unit tests in a copy of the tree with the old `test-pages.ts` (from `HEAD`) and the old folder turn | all three fail, as they should | `/tmp/retest-electron-unit-before.log` |
| `node --test tests/unit/browser-page-open.test.ts` in a copy of the tree with `src/browser/page.ts` from `HEAD` | 3 of 4 fail on the old order, as they should; the blank page passes on both | `/tmp/retest-electron-unit-page-open-old.log` |
| `npm run test:unit` on the final files | 2271 of 2277 pass. The 6 failures are other lanes' work in progress: `native-ios-simulator.test.ts`, the `lease.expired` event without a sample in `protocol.test.ts`, and `runner-resources.test.ts`. The run before the review was 2219 of 2220, the one failure being the Azure lane's mid-edit | `/tmp/retest-electron-unit-review.log`, `/tmp/retest-electron-unit-page.log` |
| `npm run test:types` | 208 expected errors matched 208 markers in 10 projects, on TypeScript 6.0.3 and 7.0.2 | `/tmp/retest-electron-types-review.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | clean after the review's code changes. The last run stopped only on other lanes' files then being edited: `src/native/ios-simulator.ts`, `src/native/macos-app.ts`, `tests/unit/runner-resources.test.ts` | `/tmp/retest-electron-typecheck-review.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/electron.test.ts tests/integration/electron-web-flow.test.ts` | 8 pass, 0 fail, 0 skipped. The run before it failed only on my own over-strict check of a named folder's files, which counted a database journal the app removes itself | `/tmp/retest-electron-integration-review.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/browser-navigation.test.ts tests/integration/lookup.test.ts`, on the final `page.ts` | 27 pass, 0 fail | `/tmp/retest-electron-navigation-review.log` |
| `node scripts/write-schemas.ts` | wrote both schemas, with `electron` on the target, `args` as `{ count, sha256 }`, `reused` browser storage, and `main_process`, `other_windows` and `reason` in a diagnostics scope; `schemaVersion` stays 1 | `/tmp/retest-electron-write-schemas.log` |

Before the coordinator's fixes, on the earlier version: `npm run typecheck:proofs` clean (`/tmp/retest-electron-typecheck-proofs.log`), and `npm run test:integration` 404 tests, 394 pass, 0 fail, 2 skipped (the live provider gates), 8 cancelled in `consumer-loading.test.ts`, whose build stopped on another lane's `src/native/` files then being written (`/tmp/retest-electron-integration.log`).

## Artifacts

A run of the same project kept outside the repository, through the CLI with the human reporter:

- `~/Library/Caches/retest-proofs/artifacts/electron/run-human.txt`: the report, with `started desktop=electron  Electron 44.5.1 · Chromium 152.0.7977.130`, each test line marked `desktop=electron (Electron)`, and the four failure cards.
- `~/Library/Caches/retest-proofs/artifacts/electron/run-human/`: the run folder, made again after the fixes, with `events.jsonl`, `result.json`, three failure screenshots in `artifacts/`, the diagnostics in `diagnostics/`, and `electron/<app and target>/1` to `8`, each holding only `windows.json`.
- `~/Library/Caches/retest-proofs/artifacts/electron/doctor.txt`: `doctor` on that project, after the review: "Electron 44.5.1 and the app found; a run starts the app".
- `~/Library/Caches/retest-proofs/artifacts/electron/doctor-missing.txt`: `doctor` with the binary's path changed to one that is not there: "No Electron binary at …/Missing. Give the Electron binary, inside Electron.app on macOS: Electron.app/Contents/MacOS/Electron.", exit 2.

## Readers built before this lane

Event and result objects reject keys they do not know. So a reader built at `30dda4a`, the commit this lane started from, refuses any run folder with an Electron target in it. Such a folder holds `target.electron` on `browser.started` and in `result.json`, and `args` as `{ count, sha256 }` in an attempt's settings. It may hold `browserStorage: 'reused'`, and `main_process` and `other_windows` with `reason` in a diagnostics scope. Earlier changes, as the inventory and the evaluation record say of theirs, went the same way. `schemaVersion` stays 1, and a reader built from this tree reads folders written before it.

## How the gates were run

Every heavy gate went through `lockf -t 0 /tmp/retest-heavy-gate.lock`, except one. Early in the lane, a bare `node_modules/typescript/bin/tsc -p tsconfig.json` ran without the lock, while another session's integration suite was running. It was clean, and every typecheck after it went through the lock.

## What was not verified

1. The flow ran twice on its final version through the lock, alone and beside `electron.test.ts`, with a one-second sync delay. It was not run with other delays or with `--read-delay-ms`.
2. A window another app covers whole: Chromium may stop drawing it, and the readiness look waits on an animation frame. Not reproduced here.
3. Linux and Windows, and packaged apps. Reading the release from a packaged macOS app's framework and from the user agent is unit tested only.
4. An app that crashes during a test on the real binary: the pool's path is unit tested with a fake; a test that closed its own first window was run.
5. Two launches sharing a `userDataDir` at the same time on the real binary; one after another was run.
6. A run interrupted by a signal while an Electron app runs. When the smoke script crashed, its exit hook killed the app, but no integration test interrupts a run.
7. JavaScript dialogs in an Electron window. The Chromium page's handling applies; it was not run on Electron.
8. The non-macOS skip of the real-binary tests was not run, since only macOS was at hand.
9. The first document of an Electron window gets no `navigation` event: nobody saw it commit, so none is invented. Its address reaches results through the checks and actions that read the page.
