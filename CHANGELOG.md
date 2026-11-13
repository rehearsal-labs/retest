# Changelog

Retest publishes releases from `main` through the Promote workflow. Each entry names what a test can do that it could not before, and on which engines it was checked.

## Unreleased

### Fixed

- The README and the guide said Retest refuses a covered element on every target. On a phone driven through agent-device, Retest checks only for the software keyboard itself. Any other cover is agent-device's reading, which can miss a bar an app draws over its own button, and the tap then counts as sent. The docs now say so.

## 0.4.0

Checked on macOS on Apple silicon. The release gates also ran the Firefox and Electron entries on Windows x64. Linux skips them by name, and Windows refuses every phone target before it starts.

### Added

- **Files and popups on Firefox.** `setInputFiles()`, `page.fileChooser()`, `page.download()`, `page.popup()` and a popup's `close()` work on Firefox 158.0.1. Firefox closes every file picker as it opens, so the page hears `cancel` before the files arrive. It says nothing of the bytes of a download it stopped. Each popup opens in a window of its own, and a popup whose `beforeunload` handler asks cannot be closed by `close()`. Items 12 to 16 of [docs/compatibility/firefox.md](docs/compatibility/firefox.md) list the differences.
- **Files and popups on WebKit.** The same five run on WebKit build 2359. A dialog still holds a WebKit page, so a popup's `beforeunload` dialog fails its `close()` by name. Items 11 and 13 to 15 of [docs/compatibility/webkit.md](docs/compatibility/webkit.md) list the differences.
- **Downloads in an Electron window.** `page.download()` works in an Electron app's first window as on a Chrome page. The app's `will-download` handler still runs, but Retest decides where each download goes, so `setSavePath()` and a save dialog have no effect. A download the handler cancels or pauses fails, saying the app can do that. A first window in a partition is refused by name. Checked with Electron 44.5.1.
- **Second windows in an Electron app.** `page.popup(action)` gives a test the window the action makes the app open, named like `desk/popup-1`: one the window's document opens, by `window.open` or a link with a target, and a `BrowserWindow` the app's main process makes. Nothing ties a main-process window to the action, so it is given by when it opened: after the wait began, and after the test's action reached the app. One window of an app waits at a time. `windows.json` names the window that opened each window and the page a test reached it as. Checked with Electron 44.5.1.
- **Phones through agent-device.** An iOS simulator target with `driver: 'agent-device'` runs through agent-device 0.21.36, an optional peer you install with `npm install --save-dev agent-device@0.21.36`. Finders, chains and picks, `tap`, `fill` with secrets, `press`, `scroll`, six matchers and a failure screenshot were checked on the iOS 26.5 simulator with Xcode 27.0. WebDriverAgent stays the default.
- **Android targets, not yet run.** `{ platform: 'android', appPath, package, device | serial }` runs through agent-device. It has run only against a stand-in, never on an emulator or a device. It refuses secrets, since agent-device types Android text through adb's arguments.

### Changed

- A download a browser stopped without saying how much had arrived is recorded without `receivedBytes` and `totalBytes`, and the report says it stopped, with no count. When the browser gives its own reason, as WebKit does, the failure quotes it.
- `native.started` can name `executor: { name: 'agent-device', … }` and the `android` platform, and has no `xcode` for Android. These are additive fields of schema version 1.

### Fixed

- During a run, an Electron app's downloads no longer go the app's own way: Electron refuses them from the launch until a test's page gives them a folder. Before, a download with no handler opened Electron's save dialog, which waits for a person, and could save a file into your Downloads folder.
- A download a test waited for is recorded as `awaited` even when it ends at once.
- WebKit: a popup opened in its opener's web process no longer stays paused and freezes its opener.
- Typing, clicks and keys in a popup that `window.open` opened on its opener's origin no longer fail `outcome_unknown` when a script ran in its empty first document, as an Electron preload does.

### Not in this release

- Android on an emulator or a device, real iPhones, and Safari.
- Dialogs on Firefox and WebKit.
- Popups are not recorded, and their console and network are not captured, on any engine.
- Retest's WebDriverAgent and macOS executors are pinned to Xcode 26.5, and were not run with Xcode 27.0.

## 0.3.0

Retest runs on Windows x64. The Windows entries were checked on Windows Server 2025, on GitHub's `windows-2025` runner. Firefox 158.0.1 was checked on macOS and on Windows.

### Added

- **Windows x64.** Chrome, Chromium builds such as Chrome for Testing, Firefox 158.0.1 and Electron 44.5.1 run there. `retest install` pins Chrome for Testing 153.0.8010.12, Firefox 158.0.1 and Electron 44.5.1 for it, into `%LOCALAPPDATA%\retest`. `chrome()` and `edge()` look under Program Files and the user's local app data. No check has run `edge()` yet.
- **The process supervisor.** `npx retest install supervisor` builds `retest-supervisor.exe` from the source in the package, with Rust 1.88 and the Visual Studio Build Tools. Only Windows needs it. Retest holds every process a run starts in a Job Object through it, so nothing a run starts outlives Retest, even when Retest is killed outright.
- **Recordings on Windows.** `npx retest install media` builds `retest-media.exe` there too. With ffmpeg on `PATH`, a Windows run records its Chrome tests, and the HTML report plays the videos.
- **Stopping a run on Windows.** Ctrl+C stops a run with exit 130, and Ctrl+Break with exit 143. Retest asks an app server to stop with Ctrl+C, and one second later ends everything the server started.
- **Windows details.** Retest quotes the commands it prints for PowerShell and Git Bash. Git Bash misreads one kind of value: one that holds a single quote beside a backslash, `$`, `"`, a backtick or `!`. A saved sign-in state is readable by this user only. Retest removes a secret's variable from a test's environment whatever the case of its name. In a Windows console where none of `WT_SESSION`, `TERM_PROGRAM` and `TERM` is set, the report shows √ and × in place of ✓ and ✗.

### Changed

- **Firefox 158.0.1** replaces Firefox 133.0.3 on macOS, and is the Firefox Windows runs. Run `npx retest install firefox` to fetch it.
- Two of Firefox's differences from Chrome are gone. One wheel event now scrolls a box to its end, and a page's script has the Navigation API.
- On Windows, Home moves the caret to the start of a field, as on Chrome. Firefox's own Home stays a difference on macOS only.
- Firefox 158 counts an option directly in a combobox, a tree item outside a tree and a list item outside a list, where Chrome counts none. A lookup of such a role is refused by name on a page that holds one.
- Firefox 158 names a cell from its text, and the refusal of a cell looked up by its name is kept in this release.
- Chrome, Chromium and Edge start with three more Chromium switches on every platform: `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`. A covered or background page keeps its renderer's priority and its timers.

### Fixed

- In 0.2.0, `retest licences electron` printed Electron's own licence, then "Notice texts unavailable:" and "LICENSES.chromium.html: notice exceeds the byte limit.", and exited 2. Electron's Chromium notice is larger than the old 16 MiB limit. It now prints each notice whole once its checksum matches the record.
- `setInputFiles` with a relative path no longer refuses a test file whose folder is on a drive, such as `C:\work`, or on a network share.
- A server already listening at an app's `ready` address is used however slowly it answers. Before, a server that took longer than a second to answer was started a second time.

### Not in 0.3.0

- A WebKit target fails its setup on Windows, and `retest install webkit` refuses by name.
- Retest pins no browser for Windows on Arm and builds no supervisor for it.
- Retest has no driver for native Windows apps.
- A run on Windows refuses each iOS simulator or macOS target at its setup, naming its key.

### Continuous integration

- A Windows x64 lane runs the build, the types, the unit files and every integration file on GitHub's `windows-2025` runner. A release needs it to pass.
- Each Windows integration shard installs Rust 1.88.0, ffmpeg, the pinned browsers, the supervisor and the media process, and checks every installed file. Each test file runs with Ctrl+C turned on, as an interactive console has it.

## 0.2.0

Checked on Chrome on macOS unless an entry says otherwise. Firefox and WebKit refuse what they cannot do by name.

### Added

- **Files.** `locator.setInputFiles()` gives a file input files by path or by content, `page.fileChooser(action)` catches the picker a button opens, and `page.download(action)` saves a download into the run folder and lists it in the report. A download that holds a declared secret is withheld. Uploads and the picker also work in Electron.
- **Dialogs.** `page.dialog(action)` hands the test the alert, confirm, prompt or beforeunload an action opens, to accept or dismiss. A dialog nothing waited for is answered and named in the action's failure. Dialogs also work in Electron windows, including one shown as the app starts.
- **Popups.** `page.popup(action)` gives the page an app opens, with locators, actions, matchers and its own screenshots, named `web/popup-1` in events and the report.
- **Shadow DOM.** Every finder sees through open shadow roots, in the order the page shows them. Text, test id, CSS and placeholder lookups do so on Firefox and WebKit too.
- **Frames.** `page.frame(locator)` gives finders inside a frame, nested frames included, and inside a frame of another site running in its own process. Input, reads, layout matchers and the input guard work there.
- **Drag and drop.** `locator.dragTo(target)` drives both HTML drag and drop and mouse-driven lists, and fails by name when the drop lands elsewhere. Also in Electron.
- **Mocked responses.** `page.route(pattern, answer)` answers a request with a status, headers and body, or refuses it; `page.unroute(pattern)` removes it. A mocked request is marked in diagnostics and the route is named in the report.
- **Screenshot baselines.** `expect(page).toHaveScreenshot(name)` and the same on a locator compare a picture with a baseline beside the test, pixel by pixel, after the page settles. `retest run --update-screenshots` writes baselines and says how many. A failure leaves the expected, actual and difference pictures in the report. Page pictures also compare on Firefox and WebKit.
- **Layout checks.** `toOverlap`, `toOverflowViewport`, `toHaveClippedText` and `toScrollHorizontally`, each measured in pixels and meant to be negated.
- **Test inboxes.** `inbox(name).latest()` reads a one-time code or a sign-in link from a mailbox the config declares; the test types the code and opens the link without ever holding them.
- **Agent sessions** hear every dialog Retest answered and every file picker it closed.

### Fixed

- Closing a browser whose main process was killed from outside no longer fails on a loaded machine: one process reading is shared, each caller keeps its own deadline, and reading stops once the group is gone.
- Capturing storage state after leaving an origin with a service worker no longer counts Chrome's own worker update check as a page request.
- The first read of a freshly opened page no longer spends the action budget on Chrome's first paint.
- Electron: an `alert()` shown before the debugging pipe answered no longer hangs the launch.

### Continuous integration

- The conformance suite runs in one file per engine. Shards are planned by a time target from per-platform durations of passing runs, so every job stays under about ten minutes. A `fast` suite runs the checks, the unit files and the short integration files first. npm and the pinned browser archives are cached between shards.
