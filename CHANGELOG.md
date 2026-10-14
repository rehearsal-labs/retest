# Changelog

Retest publishes releases from `main` through the Promote workflow. Each entry names what a test can do that it could not before, and on which engines it was checked.

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
