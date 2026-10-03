# Firefox over WebDriver BiDi: proof record

3 October 2026, revised after review the same day. Release 0.1.0, Phase 1 item 6, the Firefox half ([release-0.1.0.md](../release-0.1.0.md)), and the Firefox row of section 6 in [plan.md](../plan.md): stock Firefox through WebDriver BiDi, not its retired CDP path.

## Result

Stock Firefox 133.0.3 on macOS 27.0 arm64 was driven over WebDriver BiDi by original Retest code, with Node's global `WebSocket` and no third-party package. Launch, an isolated user context, navigation, role/name and test id lookup, real pointer and keyboard input, a screenshot, storage isolation, navigation and console events, a clean close, a lost connection and a runner killed outright all worked against the real browser and the real task-app fixture. Every fact below names the command that showed it; probe observations are marked as such.

The normal launch route was not exercised on this machine. Retest starts Firefox the way it starts Chromium, as a child process (`spawn`, the default). Here the app hosting the coding session (T3 Code) may not read `~/Library/Application Support/Firefox`: macOS answers "Operation not permitted", with the tool sandbox on or off. That is a privacy restriction of the session's host app, not a property of Firefox or of Retest. A Firefox spawned from this session never starts. Every Firefox run in this proof was started through LaunchServices instead (`--route launch-services`), a workaround whose costs were not tested ([The macOS launch finding](#the-macos-launch-finding)). On this machine the spawn route fails within its budget, and the test for it asserts that outcome. A normal terminal is expected to spawn Firefox; that was not verified.

## How to run it

From the Retest root, with Node 24.12 or later and Firefox installed:

```sh
node --conditions=retest-source proofs/firefox/run.ts [--route spawn|launch-services] [--out <folder>]
node --conditions=retest-source --test "proofs/firefox/**/*.test.ts"
node_modules/.bin/tsc -p proofs/firefox/tsconfig.json
node_modules/typescript-7/bin/tsc -p proofs/firefox/tsconfig.json
```

The route is `spawn` unless `--route` or `RETEST_FIREFOX_ROUTE` says otherwise. On this machine the runs used `--route launch-services` and `RETEST_FIREFOX_ROUTE=launch-services`, set on the command line; `proofs/firefox/harness.ts` explains why in a comment. `RETEST_FIREFOX` names another Firefox executable. The root `tsconfig.json` does not include `proofs/`, so `npm run typecheck` does not cover these files; the folder's own `tsconfig.json` extends the root settings unchanged.

## Files

| File | What it is |
| --- | --- |
| `proofs/firefox/run.ts` | The proof: twelve steps, each printing what it saw; a failed step names the command, a step that cannot run is reported as skipped, and the next step runs |
| `proofs/firefox/bidi-client.ts` | BiDi client: command ids, response matching, bounded waits, abort, events, disconnect, result validation, protocol errors that leave out the browser's text unless a command asks for it |
| `proofs/firefox/bidi-message.ts`, `bidi-errors.ts` | Reading BiDi messages without quoting page text; one error class per outcome, each saying whether the command was written |
| `proofs/firefox/launch-firefox.ts` | Launcher: the sweep for Firefoxes of runs that are gone, temporary profile with `user.js`, both routes, address from stderr, the session and its `moz:processID` check, process group ownership, bounded stop and failure cleanup |
| `proofs/firefox/firefox-page.ts` | User contexts, tabs, navigation, locators, Retest's sandbox, real input, screenshots, cookies, and an event recorder whose waits look at what already arrived |
| `proofs/firefox/firefox-session.ts`, `process-table.ts`, `png.ts` | `session.new` facts and the route choice, the process table, a PNG reader that checks every chunk, decodes rows, counts colours and refuses types it does not decode |
| `proofs/firefox/launch-and-hold.ts` | A runner that launches Firefox and waits to be killed, for the orphan test and step 8c |
| `proofs/firefox/*.test.ts`, `harness.ts` | 28 tests: 20 against real Firefox, 1 against a closed local port, 7 protocol units (message parsing, PNG) |

The code reuses Retest's own `Listeners`, schema builder, `Deadline`, `signalGroup`, `errorMessage`, `errorCode` and the task-app fixture. It edits nothing under `src/`.

## Target and environment

| Fact | Value | Shown by |
| --- | --- | --- |
| Browser | Firefox 133.0.3, build 20241209150345, `/Applications/Firefox.app/Contents/MacOS/firefox` | `firefox --version`; `session.new` capabilities |
| Host | macOS 27.0 (26A428), arm64; `session.new` reports `platformName` `mac`, `moz:platformVersion` `27.0.0` | `sw_vers`; `session.new` |
| User agent | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0`. Firefox freezes the OS part, so the version comes from `session.new`, never the user agent | `session.new` |
| Node | 24.12.0, global `WebSocket` | `node --version` |
| Session host | T3 Code (Nightly), then `claude`, then `zsh` | `ps -o pid,ppid,comm` up the tree |

## Launch

Flags: `--headless --no-remote --profile <folder>/profile --remote-debugging-port=0 about:blank`. The folder is `$TMPDIR/retest-firefox-<pid>-XXXXXX`, named after the launching process, made by the launcher and removed when it stops. The environment adds `MOZ_CRASHREPORTER_DISABLE=1`, so a crash never opens Mozilla's crash reporter on the person's screen.

With port 0, Firefox picks a free port and prints `WebDriver BiDi listening on ws://127.0.0.1:<port>` on stderr once the Remote Agent listens. It also writes `WebDriverBiDiServer.json`, `{"ws_host": "127.0.0.1", "ws_port": <port>}`, into the profile; a test checks both name the same port. A BiDi-only session starts at `/session`. Firefox's documentation does not state the stderr line or the port-0 behaviour; both were observed.

Preferences in `user.js`:

| Preference | Value | Why |
| --- | --- | --- |
| `remote.active-protocols` | `1` | WebDriver BiDi only; Firefox 133 still offers its deprecated CDP endpoint under other values. Firefox 141 removes the preference |
| `app.update.disabledForTesting` | `true` | No update download, apply or restart during a run |
| `browser.shell.checkDefaultBrowser` | `false` | No default-browser prompt |
| `browser.startup.homepage_override.mstone` | `"ignore"` | No "what's new" page instead of the first page |
| `datareporting.policy.dataSubmissionEnabled` | `false` | No data policy notice or upload |
| `network.captive-portal-service.enabled`, `network.connectivity-service.enabled` | `false` | No background requests to Mozilla to probe the network |

The Remote Agent also applies its own recommended preferences, since `remote.prefs.recommended` defaults to true ([Firefox remote preferences](https://firefox-source-docs.mozilla.org/remote/Prefs.html)). The table names what the proof relies on rather than leaving it to that list.

Every launch then connects, starts the session and checks that `session.new` names the launched pid (`moz:processID`) and profile (`moz:profile`); a mismatch fails the launch. So the process the launcher will later kill is the browser it drives. The launch hands back the client and the session, since Firefox allows only one.

Ownership, from `run.ts` steps 1 and 8a and `launch-firefox.test.ts`: the main process leads its own process group (pgid equals pid). Before closing, all 5 child processes (each started with `-parentPid <pid>`) were in that group; after `browser.close`, none was left, the group was gone, and the profile folder was removed. Neither route records Firefox's exit status: `spawnInGroup` does not keep it, and on the LaunchServices route Firefox is not this process's child. The launcher watches the group end instead.

Observed in single runs, not measured as a benchmark: the address printed 379 to 3,205 ms after launch (416 ms in the latest proof run); the group was gone 276 to 2,258 ms after `browser.close`.

### The macOS launch finding

The cause: the app hosting this coding session may not read `~/Library/Application Support/Firefox`. `ls` and Node's `readdir` both fail with `Operation not permitted` (EPERM), with the tool sandbox on and off. Firefox reads its profile list in that folder even when given `--profile`, so a Firefox spawned from this session cannot start. The orchestrator confirmed the cause independently.

Evidence from committed code, every run:

- `launch-firefox.test.ts`, the spawn-route test, checks the folder first. Here it is refused, so the test expects, and gets, a `FirefoxLaunchError` after 8,060 ms against an 8,000 ms budget. The message names the spawn route, the refused folder and a profile dialog as the likely cause. No process and no profile folder of that launch is left. Where the folder can be read, the same test requires the spawn route to start Firefox and give a session.
- `run.ts` with no route (`/tmp/retest-firefox-run-spawn.log`) fails step 1 after 20 s with the same message, and leaves no Firefox and no folder.
- Firefox's own source names the path: on macOS, `GetUserDataDirectoryHome` finds the folder with `FSFindFolder(kUserDomain, kApplicationSupportFolderType)`, with no flag or environment override (`toolkit/xre/nsXREDirProvider.cpp`). When the profile service cannot start or select a profile, Firefox calls `ProfileMissingDialog`, a modal window (`toolkit/xre/nsAppRunner.cpp`); both at tag `FIREFOX_133_0_3_RELEASE`.

Probe observations, from inline scripts run during the investigation and not committed:

- A directly spawned Firefox stayed silent for 30 s, and its profile folder stayed empty, with no `.parentlock`.
- `sample` of that process showed the main thread spinning a nested native event loop while the HTML parser, five style threads, WebRender and the compositor ran: a window being drawn.
- A minimal environment (`HOME`, `PATH`, `TMPDIR`, `USER`, `LANG`) hung the same way, so inherited environment is not the cause.
- A temporary `HOME` was ignored: Firefox created nothing in it.
- `MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1` removed the socket process's sandbox warning but not the hang.
- The same arguments through `/usr/bin/open` printed the address. LaunchServices starts Firefox as its own responsible process, so macOS judges its file access by Firefox's own grants.

Which dialog the spawned Firefox shows was inferred from the source, the stack and the untouched profile. It was not seen, because showing it would put a window on the founder's desktop.

The workaround and what it costs. `launch-services` runs `open -n -g -j -a /Applications/Firefox.app --stdout <log> --stderr <log> --env MOZ_CRASHREPORTER_DISABLE=1 --args <same flags>`, finds the process by its unique profile folder, checks it leads its own group, and cross-checks `moz:processID`. Compared with `spawn`, it gives up:

- the child relationship: no exit status, and a group to poll instead;
- the inherited environment: only the variables passed with `--env` reach Firefox;
- this process's privacy grants: macOS judges every file Firefox opens by Firefox's own, so a log in `~/Documents`, for example, may be refused;
- probably a logged-in GUI session, which LaunchServices may need.

None of these costs was tested. The route exists to run this proof on this host; it is not the design. Phase 3 should start Firefox as a child, as the Chromium driver does, and verify that from an ordinary terminal.

## Protocol used

Commands, all answered by Firefox 133.0.3:

| Command | Used for |
| --- | --- |
| `session.new` | Starting the session; browser name, version, platform, `moz:processID`, `moz:profile`, `moz:headless`. One session at a time: see below |
| `session.subscribe`, `session.unsubscribe` | Events, globally and scoped to one tab with `contexts` |
| `session.end` | Ending the session, which frees the browser for another; Firefox then closes the connection with code 1000 |
| `session.status` | A cheap command to show the connection still works, or is refused once lost |
| `browser.getUserContexts`, `browser.createUserContext`, `browser.removeUserContext` | Isolation. A fresh profile already lists four user contexts besides `default`: Firefox's built-in containers |
| `browser.close` | Closing; answered in 2 to 40 ms, then the WebSocket closes with code 1000 |
| `browsingContext.create` (`type: tab`, `userContext`), `getTree`, `close` | Tabs in a user context |
| `browsingContext.setViewport` (`devicePixelRatio: 1`) | A 1280 × 720 viewport; the page reads `innerWidth` 1280, `innerHeight` 720, `devicePixelRatio` 1 |
| `browsingContext.navigate` (`wait: complete`) | Navigation; returns a navigation id and the URL |
| `browsingContext.locateNodes` | `accessibility` (role and name) and `css` (test id) locators, with `maxNodeCount: 2` to tell one match from several. The `innerText` locator answers `unsupported operation` (`firefox-page.test.ts`) |
| `browsingContext.captureScreenshot` (`origin: viewport`, `image/png`) | The screenshot |
| `script.callFunction` | Retest's code in sandbox `retest`, and standing in for the page in its own realm |
| `script.evaluate` | A never-settling promise, to test timeouts and aborts |
| `script.getRealms` | Telling the page realm from the sandbox realm |
| `input.performActions` | Pointer move, down and up; key down and up per character |
| `storage.getCookies` (partition `storageKey` with `userContext`) | Each user context's cookies, `HttpOnly` ones included |

Events: `browsingContext.navigationStarted`, `domContentLoaded`, `load`, `contextCreated` and `log.entryAdded` arrived. `browsingContext.fragmentNavigated` and `navigationFailed` were subscribed but not exercised, so none arrived. `browsingContext.navigationCommitted` is refused: `invalid argument: browsingContext.navigationCommitted is not a valid event name` (`run.ts` step 7a). An unknown command answers `unknown command`.

Sessions, from `launch-firefox.test.ts` ("one session at a time") and `run.ts` step 8c:

- A second `session.new` on the same connection is refused: `session not created`, with Firefox's message `Maximum number of active sessions`.
- A second connection opens, but its `session.new` is refused the same way. So no second consumer, such as an agent session API or a host that wants to attach, can open a session of its own on a Firefox the runner holds.
- A session outlives its connection. A connection closed without `session.end` still holds it, and so does one whose process was killed with SIGKILL: no later `session.new` succeeds. Only `session.end` on the same connection, or ending the browser, frees it.

## What each step showed

All from `node --conditions=retest-source proofs/firefox/run.ts --route launch-services --out /tmp/retest-firefox-proof`, log `/tmp/retest-firefox-run.log`, exit 0, unless a test is named. Five more runs, logs `/tmp/retest-firefox-run-repeat-1.log` to `-5.log`, also exited 0.

1. **Launch.** The sweep found nothing to end. LaunchServices route; address printed after 416 ms; Firefox and four child processes in its process group; the launcher's check passed: `session.new` named the launched pid and profile, headless true.
2. **Isolated context.** `browser.createUserContext`, then a tab in it; `browsingContext.getTree` shows the tab in that user context, beside the default one's tab.
3. **Navigation.** `browsingContext.navigate` to the noisy task app with `wait: complete`; a `load` event names the same navigation id; the viewport is the size set.
4. **Locators and input.** The `accessibility` locator `{role: button, name: Save}` finds one node, whose text reads `Save`; the `css` locator for `task-title` finds one node. A pointer click at the field's centre (200, 190), keys for "Release checklist" (the field then holds it), and a pointer click on Save at (200, 224). Reading again: `saved-task` shows "Release checklist", and the server counted exactly one save. Tests add: two buttons named Save, or two elements with test id `save-task`, are refused as ambiguous; "Delete", "Sav", "save", " Save " and role "BUTTON" find nothing; a full-page overlay makes the click fail before any input and the server counts no save; the field's name "Title" comes from its `<label>`.
5. **Screenshot.** `browsingContext.captureScreenshot` written to `/tmp/retest-firefox-proof/viewport.png`, 34,245 bytes. Reopened from disk: PNG signature, every chunk CRC valid, IHDR 1280 × 720, 8-bit RGBA, image data exactly 720 filtered rows, 288 distinct colours. The reader refuses palette, greyscale, 16-bit and interlaced files (`png.test.ts`), so these checks cannot pass a type it does not decode. The size and colour count do not prove what the image shows: that was confirmed by eye, and it is the task page with "Release checklist" in the field and saved below it.
6. **Storage isolation.** User context A signs in through the sign-in page with real input, and its account page reads "Signed in as ada". User context B opens the same page: "Signed out". A's page sees `task-app-remember=ada; retest-probe=a`, localStorage probe `a`; B's sees `retest-probe=b`, probe `b`, and no stored user. `storage.getCookies`: A holds `task-app-session` (HttpOnly), `task-app-remember` and `retest-probe=a`; B holds only `retest-probe=b`; the default user context holds none. Control: a second tab in A is signed in and reads probe `a`, so state is shared within a user context, which makes the separation meaningful. B was then removed and is no longer listed.
7. **Events.** Every navigation produced `navigationStarted`, `domContentLoaded` and `load` with one navigation id, in that order, scoped to its tab. The page's `console.log` and `console.warn` at load and its `console.error` from the Save click arrived as `log.entryAdded` (type `console`, levels `info`, `warn`, `error`, with `method`, text and the tab's context). An uncaught error thrown from a timer arrived as type `javascript`, level `error`, with a stack trace. The sign-in page's `location.assign('/account')`, started by a click, raised `navigationStarted` with its own navigation id. `script.getRealms` lists the page realm and a separate realm for sandbox `retest`, yet a `console.log` from the sandbox arrived naming the page's own realm.
8. **Ordering (7c).** For 40 calls each, the proof noted whether the log event a `script.callFunction` caused arrived while that command still waited for its response. A `console.log` made while the function ran arrived first in 40 of 40 calls, in each of the six runs (240 of 240). An error thrown from a timer the function set arrived first in 0 of 40, in each of the six runs. The reviewer saw it arrive first in 3 of 40 calls on this machine, which once failed the earlier version of step 7b. All events are in `/tmp/retest-firefox-proof/events.json`.
9. **Close and loss (8a, 8b).** `browser.close` answered after 2 ms, the WebSocket closed with code 1000 after 209 ms, the group was gone after 276 ms, no child was left and the profile was removed. A second Firefox was killed with SIGKILL while `browsingContext.navigate` waited on a page that never finishes (the server had the request): the command rejected 13 ms later with `BidiDisconnectedError`, written, so its outcome is unknown; `onDisconnect` reported `the WebSocket connection was lost (code 1006)`; a later command was refused at once with `BidiClosedError`; the group was gone and the profile removed.
10. **A runner killed outright (8c).** `proofs/firefox/launch-and-hold.ts` launched Firefox 76516 with a session, and was killed with SIGKILL. 500 ms later Firefox was still running, its profile was still there, and `session.new` on a new connection was refused with `Maximum number of active sessions`. The next launch's sweep ended Firefox 76516 and removed its folder. `launch-firefox.test.ts` shows the same with assertions.

Client behaviour shown by `bidi-client.test.ts` against real Firefox: an unknown command is a `BidiProtocolError` with `error` `unknown command`, and the connection goes on. A command unanswered within 300 ms is a `BidiTimeoutError` marked written, and the connection goes on. A command stopped before it is sent is marked unwritten, and one stopped while waiting is marked written. A result missing what Retest relies on fails naming only the path (`$.ready expected string`). A listener that throws becomes a diagnostic, and the other listeners still hear the event. A WebSocket that cannot open fails with `BidiConnectError`. A protocol error's text is `browsingContext.navigate failed: no such frame`, without the argument Firefox quoted, unless the command asked for Firefox's message.

## Where BiDi differs from what the Chromium driver relies on

**Browser lifetime.** The Chromium driver talks to Chrome over `--remote-debugging-pipe`, and Chrome exits when the process that started it dies, since its pipe closes. Firefox's BiDi server is a WebSocket. When a runner is killed with SIGKILL, `process.on('exit')` does not run, Firefox keeps running with BiDi listening, its profile stays in place, and its one session stays taken, so nothing can drive it again (step 8c and the orphan test). The Firefox driver must own what the Chromium driver gets for free. The proof's launcher does it with a sweep at the start of every launch, modelled on `removeStaleProfiles`. It finds Firefox processes whose `--profile` lies under `$TMPDIR/retest-firefox-<pid>-…` and whose owning process is gone, kills each one's process group (or the process and the children naming it with `-parentPid`, if it has no group), waits for them to go, and removes such folders. It keeps anything whose owner is alive, or may be, and the folder of a Firefox it could not end. The sweep runs only when the next launch happens; between a crash and that launch the orphan keeps running.

**Isolated world.** The Chromium driver makes its world with `Page.createIsolatedWorld` and `Page.addScriptToEvaluateOnNewDocument`, addresses it by execution context id, and makes it again for each document. In BiDi, a call naming `target: {context, sandbox: "retest"}` gets that sandbox's realm in the current document, made on first use. The proof showed globals kept apart both ways and one shared DOM (`firefox-page.test.ts`). Two differences matter. Elements are `sharedId` strings that work from either realm and need no object group to release. And a `console.log` from the sandbox arrives naming the page's own realm, so diagnostics cannot separate Retest's output from the page's by realm; Retest's page code must not log. Running Retest's code before the page's scripts (`script.addPreloadScript` with `sandbox`) and the error for a reference from a replaced document were not exercised.

**Input guarding and actionability.** The Chromium driver checks visible, stable, enabled and not covered, then sends input with `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.dispatchTouchEvent` and `Input.insertText`. A guard armed in the page records which element each event reached and, for a secret fill, cancels a navigation to another document. BiDi sends a whole action sequence in one `input.performActions`, which answers once it is dispatched, with no per-event acknowledgement. The proof's check is smaller than Retest's: connected, enabled, sized, scrolled to the middle, and the topmost element at the rounded centre. It refused a covered button with no input sent. Stability, intercept detection, the event guard and the origin guard for secret fills are not built for Firefox. BiDi's `network.addIntercept` looks like a route to stop a navigation during a fill; it was not tried. Key names such as Enter, text outside the Basic Multilingual Plane and IME input were not tried.

**Navigation commits, event order and `commandToken`.** The Chromium driver reports each navigation when it commits, with its URL, a title that settles later, its cause and the `commandToken` of the command whose input or `goto` started it. Firefox 133 has no commit event: `navigationCommitted` is refused, so the first sign of the new document is `domContentLoaded`. Navigation ids join `browsingContext.navigate`'s answer to its events, and a navigation a click started gets its own id, but nothing links it to the `input.performActions` command that caused it. An event can also arrive before the response of the command that caused it. A log event raised while `script.callFunction` ran came first in 240 of 240 calls (step 7c), and the reviewer saw an event raised just after a command came first in 3 of 40. Any `commandToken` attribution must survive both orders. A listener added once a command has answered can miss the event that command caused, which is why the proof's waits look at a recorder's buffer first. Redirects and `navigationFailed` were not exercised.

**Accessibility names.** The Chromium driver queries Chrome's accessibility tree, maps a few role names, and applies its own exact or loose text matching. Firefox's `accessibility` locator takes a role and a name and matches both exactly as Firefox computes them: case-sensitive, whole string, no trimming ("Sav", "save", " Save " and role "BUTTON" find nothing; `firefox-page.test.ts`). Firefox computes names from labels ("Title" from `<label for>`). BiDi offers no command to read an element's accessible name, and the `innerText` locator is unsupported, so Retest's loose matching (`exact: false`), regex names, and label, text and placeholder locators need code of Retest's own in the sandbox. Only `button` and `textbox` were tried.

**Screenshot of a context or the viewport.** The Chromium driver captures the target's viewport with `Page.captureScreenshot`. BiDi's `captureScreenshot` takes `origin: viewport` or `document` and an optional clip; with `viewport` and a 1280 × 720 viewport at ratio 1 it returned exactly 1280 × 720. The `document` origin, clips and other device pixel ratios were not tried.

**Storage state.** The Chromium driver reads cookies with `Storage.getCookies` for a browser context and `localStorage` per origin from its world. BiDi reads a user context's cookies with `storage.getCookies` and a `storageKey` partition, `HttpOnly` included, each value wrapped as `{type: "string", value}`. BiDi has no command for `localStorage`; the sandbox reads the page's own storage (shown). Restoring state (`storage.setCookie`, and `localStorage` before the page's scripts) was not tried.

**Errors quote arguments.** Firefox puts command arguments in its error messages: `no such frame: Browsing Context with id hunter2-secret not found`, and `invalid argument: Expected "context" to be a string, got [object Number] 42` (`bidi-client.test.ts` for the first; the second is a probe observation). A `fill` that sent a secret and failed would carry the secret in the error. The proof's client keeps only the error name and the command name, unless a command opts in with `keepErrorMessage`, which no command carrying text to type may do.

**Transport and sessions.** CDP runs over a private pipe. Firefox's BiDi server is a WebSocket on a loopback port that accepts connections with no `Origin` header and a loopback `Host` ([Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html)), so any local process can connect while it is open. The documentation read for this proof names no pipe transport. Firefox allows one session per browser, and the session outlives its connection, as above. A pooled browser shares one session across its user contexts, and a second consumer cannot attach.

## What is missing for the contract

Against `OwnedBrowser` and `OwnedPage` in `src/browser/contract.ts`:

- Process lifetime: the orphan sweep belongs in the Firefox driver itself, run before every launch. A runner that ends normally should also send `session.end` or `browser.close` rather than only closing the socket, which leaves the session taken.
- Secrets in errors: every command that can carry a secret, `fill` first, must keep Firefox's error text out of failures, events and logs. The text a page function throws is passed through as-is (`PageScriptError`); whether it can quote an argument was not tested.
- `newPage` options: base URL resolution, user agent and other emulation beyond the viewport, restored storage state, and a proxy per context. None was tried on 133; some may need a newer Firefox.
- `execute`: `goto`, a minimal `click` and typing exist. Missing: `fill` (clearing, secret values, the origin guard), `press` with key names, `select`, `check`, `uncheck`, `scroll`, `tap`, hover, `observe` and the full actionability rules.
- Locators: test id and exact role/name only. Label, text, placeholder, CSS, scoping, nth, loose and regex matching are missing.
- `onNavigation`: commit facts and `commandToken` attribution that survive either event order.
- `readPage` and `captureState`: partial; `localStorage` capture across origins and every restore path are missing.
- Stale references: the error for a `sharedId` from a replaced document was not exercised.
- Diagnostics: console and runtime errors work. Network events (`network.beforeRequestSent`, `responseStarted`, `responseCompleted`, `fetchError`) were not exercised.
- Process: no exit status on either route. The BiDi client has no limit on waiting commands (the CDP client has one).
- Platforms: the spawn route on an ordinary terminal, Linux and headed mode were not exercised.
- Version: 133.0.3 is from December 2024. The release must pin a tested Firefox; later versions add events and commands this record says are missing, and remove `remote.active-protocols`.

## Licenses and sources

- Firefox is MPL-2.0. The proof runs the installed application and redistributes nothing.
- Read, not copied: Firefox 133.0.3 source (`toolkit/xre/nsAppRunner.cpp`, `toolkit/xre/nsXREDirProvider.cpp` at tag `FIREFOX_133_0_3_RELEASE`, github.com/mozilla-firefox/firefox, MPL-2.0); Mozilla's Remote Agent documentation; the [W3C WebDriver BiDi specification](https://w3c.github.io/webdriver-bidi/).
- No code was copied from anything. No npm package was added. No geckodriver, Selenium, Playwright, Puppeteer or `ws` was used or read for this proof.

## Artifacts

| Path | What |
| --- | --- |
| `/tmp/retest-firefox-proof/viewport.png` | The screenshot, 1280 × 720 |
| `/tmp/retest-firefox-proof/events.json` | Every event the proof received |
| `/tmp/retest-firefox-proof/firefox.log`, `firefox-killed.log`, `firefox-orphan.log`, `firefox-after-orphan.log` | Firefox's stdout and stderr for each launch, with the sweep's lines |
| `/tmp/retest-firefox-run.log`, `/tmp/retest-firefox-run-repeat-1.log` to `-5.log` | The proof on the LaunchServices route, six runs, exit 0 |
| `/tmp/retest-firefox-run-spawn.log`, `/tmp/retest-firefox-proof-spawn/firefox.log` | The proof on the default spawn route, exit 1, and Firefox's output there |
| `/tmp/retest-firefox-tests.log` | The 28 tests, exit 0 |

These live in the temporary folder and do not survive a restart.

## Not verified

1. The spawn route, the default, from an ordinary terminal; this session's host app may not read Firefox's data folder.
2. What the LaunchServices route costs: environment, file access under Firefox's own grants, the need for a GUI session.
3. Which dialog the spawned Firefox shows; inferred from source, stack and the untouched profile, not seen.
4. Linux, headed mode and any Firefox other than 133.0.3.
5. Retest's input guard, stability check, secret fills and key names on Firefox.
6. Whether a page function's exception text can quote its arguments.
7. Running code before the page's scripts, stale-reference errors, redirects, `navigationFailed` and fragment navigation.
8. Network events, storage restore, a `document`-origin screenshot and device pixel ratios other than 1.
9. An event raised after a command arriving before its response; seen by the reviewer (3 of 40), not in this lane's 240 calls.
