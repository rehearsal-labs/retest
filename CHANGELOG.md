# Changelog

Retest publishes releases from `main` through the Promote workflow. Each entry names what a test can do that it could not before, and on which engines it was checked.

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
- Two of Firefox's differences from Chrome are gone, checked on macOS. One wheel event now scrolls a box to its end, and a page's script has the Navigation API.
- Firefox 158 counts an option directly in a combobox, a tree item outside a tree and a list item outside a list, where Chrome counts none. A lookup of such a role is refused by name on a page that holds one.
- Firefox 158 names a cell from its text, and the refusal of a cell looked up by its name is kept in this release.
- Chrome, Chromium and Edge start with three more Chromium switches on every platform: `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`. A covered or background page keeps its renderer's priority and its timers.

### Fixed

- In 0.2.0, `retest licences electron` printed Electron's own licence, then "Notice texts unavailable:" and "LICENSES.chromium.html: notice exceeds the byte limit.", and exited 2. Electron's Chromium notice is larger than the old 16 MiB limit. It now prints each notice whole once its checksum matches the record.
- `setInputFiles` with a relative path no longer refuses a test file whose folder is on a drive, such as `C:\work`, or on a network share.

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
