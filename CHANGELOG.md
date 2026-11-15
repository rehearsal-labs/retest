# Changelog

Retest publishes releases from `main` through the Promote workflow. Each entry names what a test can do that it could not before, and on which engines it was checked.

## Unreleased

### Changed

- **A headless `chromium()` target runs Chrome's headless shell.** Google builds `chrome-headless-shell` from each Chrome for Testing release: the same web engine, without the browser around it. Run `npx retest install chromium` once, which now installs the shell of the pinned release beside Chrome for Testing, each checked against its SHA-256. Without it, a run fails at setup and names that command; Retest never starts Chrome for Testing in its place. `browser.started`, `result.json`, the reports and `doctor` name the program that ran: `HeadlessChrome` for the shell, `Chrome` for Chrome for Testing.
- To run Chrome for Testing as before, give the target `headlessShell: false`. A shown run, with `--headed` or `headless: false`, runs Chrome for Testing, since the shell cannot show a window. A target's `executablePath` runs the program it names, and `chrome()` and `edge()` are unchanged. `RETEST_HEADLESS_SHELL` names a shell to run instead of the installed one.
- Retest gives the shell what Chrome's browser layer gives a page, so a page reads the same on both. A window a page opens with no click behind it is closed before it runs, as Chrome blocks it, and a test waiting for it with `page.popup()` fails at once on both. The languages are Chrome's, and so are the user agent and client hints on Linux and macOS. The generic fonts are Chrome's defaults, and three permissions Chrome grants without asking read as granted. A frame of another site runs in a process of its own. On Chrome for Testing and the shell of the pinned release, a headless page that sets no viewport reads the viewport, window, screen and place Retest 0.4.2 gave it, on Linux and macOS.
- Measured on an Azure `Standard_D8s_v4` (8 CPUs, 32 GB, Ubuntu 24.04) with Node 24.12, against the same code on Chrome for Testing 153.0.8010.12 given by its path: 1,000 tests in 50 files on the default 4 workers, each a `goto`, a fill, a click and a text check on a page that answers at once, three runs of each, taking turns, medians. A test took 180 ms, against 474 ms. The run took 50.2 s, against 125.0 s. CPU per test fell from 414 ms to 138 ms, and memory in use peaked at 815 MB, against 1,265 MB. On one worker, 200 tests in 10 files: a test took 150 ms, against 249 ms, and the run 32.5 s, against 51.1 s. One row got worse: the first test started after 2,994 ms, against 2,533 ms, and after 1,428 ms, against 944 ms, on one worker. Before its first browser starts, a run reads the cached shell's 197 MB executable to check it against its pin. Playwright 1.65.1 ran the same 1,000 tests in 54.4 s on the shell and 137.6 s on Chrome for Testing, one run each.
- Checked on Linux x64 (Ubuntu 24.04, sandbox on) and macOS 27.2 arm64, against Chrome for Testing 153.0.8010.12. On Linux nine pictures, phone and popup included, were the same bytes on both programs. On macOS a picture of form controls differed in 215 of 312,228 pixels, which `toHaveScreenshot()` passes at its default threshold. The Windows shell is pinned and has not run. [Chrome's headless shell](docs/guide.md#chromes-headless-shell) lists what still differs, such as a page another page covers staying visible, Chrome's own error pages, a PDF viewer and `window.chrome`.

## 0.4.2

Each entry says where it was measured.

### Changed

- **Web tests on Chrome cost the machine less, and each worker has a browser of its own.** Retest starts Chrome without the experiments of Chromium's testing config, as Playwright does, and without a spare renderer process, which each test's new browser context started and closed unused. A test now starts two renderer processes, where it started four. `--browsers` now defaults to one browser for each worker, not one for every three: one browser opens and closes contexts from a single process, and two workers kept it busy enough to slow each other. `--browsers` still sets the number. Every test still starts in a new browser context, the sandbox stays on, and the events, results, diagnostics and evidence are the same, apart from the browsers themselves: `run.started` names how many, and each has its `browser.started` event and its log.
- Measured on an Azure `Standard_D8s_v4` (8 CPUs, Xeon Platinum 8272CL, 32 GB, Ubuntu 24.04) with Chrome for Testing 153 and Node 24.12: 1,000 tests in 50 files on the default 4 workers, each a `goto`, a fill, a click and a text check on a page that answers at once, five runs of each, taking turns, medians. A test took 497 ms, against 703 ms. The run took 134.4 s, against 184.2 s. The two switches alone, on two browsers, gave 549 ms and 147 s in two further runs. Two rows got worse: the first test started after 2,568 ms, against 2,516 ms, and closing after the last test took 475 ms, against 442 ms, as four browsers close instead of two. Reading the 50 files took 1,855 ms, against 1,859 ms.
- On a page whose search waits 300 ms and then calls a 150 ms API, three runs of each: a test took 682 ms, against 916 ms, and the run 183.2 s, against 244.2 s. The first test started after 2,553 ms, against 2,509 ms, closing took 478 ms, against 431 ms, and the parent process peaked at 382 MB, against 374 MB.
- **Android tests share one agent-device for the run.** Each Android test used to start agent-device, find the device, open a session, set up agent-device's keyboard, and close all of it again. Now the tests of one target on one device share agent-device's daemon and session until the run ends. Each test still removes the app and installs the APK afresh, so it starts with no data of an earlier test or run. A test leaves its app open, and the next test's removal ends it. A runtime that lost agent-device, or whose call went unanswered, serves no later test.
- Measured on an 8-CPU Linux machine with the Android 15 emulator, each test one fill, one tap and one text check. 1,000 tests took 65.7 min, down from 109.5 min, and every test passed. 100 tests took 388 s and 398 s in two rounds, against 633 s and 643 s. On the Android 17 emulator there, 300 tests passed.
- Measured on an Apple silicon Mac with the Android 15 emulator, three runs each of 100 tests, medians. The time around each test fell from 2.96 s to 1.36 s. Two parts got slower. The test's own fill, tap and check rose from 0.85 s to 0.99 s: agent-device's tap mostly took about 0.2 s in a session kept from earlier tests, and about 0.07 s in a new one. Closing agent-device at the end of the run takes 0.85 s, once.

### Fixed

- **A run whose tests all passed no longer fails because Node ended a test file's process badly as it exited.** Seen on GitHub's `windows-2025` runner with Node 24.12: after every test of a file had passed, Node ended its process with exit code 3221226505, and the run failed the file and exited 2. Now, once Retest asks a file's process to close, the process says its work is done before it exits, and how it ends after that fails nothing. The file's log in `logs/` says how it ended. A process that ends before it says so still fails its file, and so does an error it reports. Checked on GitHub's `windows-2025` runner with Node 24.12: in three runs of the lock tests, Node ended a finished process this way three times, printing `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`, and every run passed. Also checked on macOS on Apple silicon, with a test file that kills its own process as it exits.

## 0.4.1

Each entry says where it was checked.

### Fixed

- **A check no longer reads the page an action is leaving, on Chrome.** From the moment the page asks for another document until that document is there, a look reads nothing, and the check reads the new document once it is there. Before, `click(save)` then `expect(heading).toBeVisible()` could pass on the form when the server answered with an error page, and so could `toBeHidden()`, `toHaveURL()` and `toHaveTitle()`. A check whose time runs out first fails `timeout`, naming the address the page was opening. Layout and screenshot checks, `page.url()`, `page.title()`, host checks and looks in a frame wait the same way. Checked on macOS on Apple silicon, with Google Chrome 157.
- **A long run no longer piles up memory reading its own processes.** A reading of the process table that began while another was under way took a 64 MiB buffer of its own, and a spent one stayed until garbage collection. In 1,000-test runs on Linux they reached 12 GiB, up to 6.9 GiB of it in one mapping, while the whole process held about 350 MB. Linux charges a fork for that memory, and a host that refuses the charge lets no reading start. A run whose tests all passed then ended `cleanup_failed`, since it could not confirm that its browsers had ended. A buffer now grows only as far as its reading prints, and spent ones are used again. Measured on Linux in Docker.
- A reading the system refuses to start names the system's reason, as in "The metadata process could not start (ENOMEM)."
- **On Ubuntu 23.10 and later, outside a container, a browser whose sandbox AppArmor refuses now stops with two commands to paste.** They write and load a profile that lets the browser's own file create user namespaces, with its real path filled in. The sandbox stays on. The commands follow the profile Chromium documents. Checked on GitHub's `ubuntu-24.04` runner, Ubuntu 24.04.5, with Chrome for Testing 153: [`.github/workflows/ubuntu-sandbox.yml`](.github/workflows/ubuntu-sandbox.yml) runs them there when started by hand. [Run on Ubuntu](docs/guide.md#run-on-ubuntu) has the steps.
- **Android: a test's app installs on a device that does not have it yet.** Set-up failed there with `adb uninstall failed`. Retest installed through agent-device's reinstall, which runs adb's uninstall first, and Android 15 fails an uninstall of an app the device does not have. Retest now asks agent-device to remove the app, which it does only when the device has it, then installs the APK. Either way the app starts with no data of an earlier run. Checked on the Android 15 emulator.
- **Android: a failed text check says when the text may be a content description.** agent-device reports a view's text and its content description as one label, so a view with no text reads as its content description. `toHaveText('')` cannot pass on such a view, and `toHaveText('saved_task')` passes on an empty view whose content description is `saved_task`. A text check that fails on such a label now says the label may be the view's content description. Checked on the Android 15 emulator.
- **Android: a view with neither text nor a content description reads as empty text.** Its text checks failed before, saying the text was not reported. Unit-tested on nodes the Android 15 emulator gave, not run as a check there.
- A text check on an element whose text the tree did not report no longer says the element has the text `""`. It says Retest could read no text.
- The README and the guide said Retest refuses a covered element on every target. On a phone driven through agent-device, Retest checks only for the software keyboard itself. Any other cover is agent-device's reading, which can miss a bar an app draws over its own button, and the tap then counts as sent. The docs now say so.

### Changed

- **The first test starts sooner.** A run loads its test files to collect their tests several at once, as many as `--workers`, or one for each core when `--workers` is not given. It used to load them one at a time. The tests, their order and ids, and what a file that fails to load prints, are the same. `retest list` loads one file for each core at once.
- Measured on Linux arm64 in Docker on a Mac, with 8 CPUs given to the container, Node 24.22.3 and Chrome 157.0.8103.78: 1,000 tests in 50 files, on the default 4 workers and 2 browsers, five runs of each, taking turns. The first test started after 1,106 ms, against 3,982 ms before. Collecting the 50 files took 746 ms, against 3,601 ms. The whole run took 70.7 s, against 77.6 s, and a test took 263 ms, against 268 ms; both ranges overlap. `retest list` of the 50 files took 1,100 ms, against 4,499 ms. These numbers come from one shared machine and are not the benchmark machine's.

### Added

- **Checks that pass on nothing say so.** `toBeHidden()`, `.not.toBeVisible()` and `toHaveCount(0)` still pass on a locator that matches nothing, as a misspelt test id does. When no look of the test's attempt had found that locator, the `assertion.passed` event says `neverMatched: true`, `result.json` counts such checks in `neverMatchedChecks`, and the human report prints one line for them. Both are additive fields of schema version 1.

### Not in this release

- A submit that a click listener defers with a timer. Until the page asks for the navigation, a check on the next line reads the page the click left.
- Checks on Firefox and WebKit still read the document a page holds while another is on its way.

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
