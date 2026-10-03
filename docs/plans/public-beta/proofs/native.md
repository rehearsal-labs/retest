# Native proofs: one iOS simulator screen and one macOS window

Phase 1 item 7 of [release-0.1.0.md](../release-0.1.0.md), 3 October 2026, revised the same day after review. It establishes how the two XCTest executors named in [plan.md](../plan.md) section 6 launch an app, observe it, send input and capture pixels, with Retest talking to them over HTTP and nothing else acting as the runner.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| Native macOS window: TextEdit through WebDriverAgentMac | Passed, 24 of 24 steps, in one run on the revised proof (`2026-10-02T22-48-16Z`). That run was unattended: the system log shows Automation Mode enabled without a dialog | "What the macOS proof showed" below |
| iOS simulator screen: Settings through WebDriverAgent | Blocked. No iOS simulator runtime is installed, and downloading one needs the founder's word. The executor compiles and links for the simulator SDK; only its asset catalog step needs a runtime. The proof is written and stops at the runtime check | Builds and run `2026-10-02T22-49-13Z` below |

Neither proof uses an Appium server, a Node package or a mock. Node's `fetch` talks to the runner that `xcodebuild` hosts.

Earlier passing runs, `22-00-01Z`, `22-00-59Z`, `22-03-07Z` and `22-07-28Z`, ran on code that has since changed. They typed and cleared through the executor's `/value` and `/clear` routes, took the first of several matches, checked captures only for colour count, and saved whole-app trees, which the orchestrator has deleted. They show the executor works, but not the rules below.

## Executors

Both are cloned and built in `~/Library/Caches/retest-proofs`, outside the repository. No code from either is copied into Retest.

| | appium-mac2-driver (WebDriverAgentMac) | WebDriverAgent |
| --- | --- | --- |
| Source | https://github.com/appium/appium-mac2-driver | https://github.com/appium/WebDriverAgent |
| Version, commit | 4.3.6, `f38257191fa9f273a684f6a9c8c2b16d1272bd09`, committed 2026-10-02T03:12:13Z | 16.13.6, `9d1d17ddb59e6097ddc3324b23ca9f4174507b12`, committed 2026-09-30T14:27:17Z |
| Cache path | `~/Library/Caches/retest-proofs/appium-mac2-driver` | `~/Library/Caches/retest-proofs/WebDriverAgent` |
| License | Apache-2.0 (`LICENSE`, SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`). No `NOTICE` file. The `FB*` files it took from WebDriverAgent keep Facebook's BSD header, which still points at a `PATENTS` file the repository does not contain | BSD 3-clause, "Copyright (c) 2015-present, Facebook, Inc." (`LICENSE`, SHA-256 `d9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4`). No `PATENTS` file in this revision |
| What it is | An XCTest UI test bundle whose one test runs an HTTP server on port 10100 | The same design for iOS, tvOS and watchOS, default port 8100, plus an MJPEG stream on 9100 |
| Private API | Uses XCTest internals through categories | Ships 139 private XCTest headers in `PrivateHeaders/XCTest` |

Both depend on XCTest internals, so a new Xcode can break them. Pin an Xcode build and executor commit as one tested set. If Retest ever ships a built runner, the distribution must carry both licenses' notices.

## Dependency decision needed

`AGENTS.md` forbids a required dependency on "another test/automation framework without a new user decision". Making WebDriverAgentMac and WebDriverAgent the required native backends is such a decision; it is the founder's to make, and these proofs do not make it. If they are adopted, `README.md` line 22 ("There is no Playwright, Puppeteer or Selenium underneath, and nothing to install at runtime") must change for native targets: XCTest executors would be underneath, and Xcode, an executor build and an iOS runtime would have to be installed.

## Machine

Xcode 26.5 (17F42) at the default path, Swift 6.3.2, macOS 27.0 (26A428) on Apple silicon (arm64), Node 24.12.0. SDKs: macOS 26.5 and iOS Simulator 26.5. `xcrun simctl list runtimes` is empty. System Integrity Protection is on. One display: 1728x1117 points at scale 2.

## Commands, results and logs

Logs are in `~/Library/Caches/retest-proofs/logs/`; artifacts are in `~/Library/Caches/retest-proofs/artifacts/<platform>/<run>/`.

1. `git clone https://github.com/appium/appium-mac2-driver ~/Library/Caches/retest-proofs/appium-mac2-driver` and `git clone https://github.com/appium/WebDriverAgent ~/Library/Caches/retest-proofs/WebDriverAgent`. Both exited 0.
2. From `appium-mac2-driver/WebDriverAgentMac`: `xcodebuild build-for-testing -project WebDriverAgentMac.xcodeproj -scheme WebDriverAgentRunner -derivedDataPath ~/Library/Caches/retest-proofs/derived/mac2 COMPILER_INDEX_STORE_ENABLE=NO`. It printed `** TEST BUILD SUCCEEDED **` after 76 compile steps in 4.8 s, ad hoc signed as "Sign to Run Locally" with no team, and wrote `WebDriverAgentRunner_macosx26.5-arm64.xctestrun`. Log: `mac2-build-for-testing.log`.
3. First runner start, by hand: `USE_PORT=10100 USE_HOST=127.0.0.1 xcodebuild test-without-building -project WebDriverAgentMac.xcodeproj -scheme WebDriverAgentRunner -derivedDataPath ~/Library/Caches/retest-proofs/derived/mac2`. After 60 s it logged `Timed out while enabling automation mode` and then `** TEST EXECUTE FAILED **`. Log: `mac2-runner-manual-1.log`.
4. `node --conditions=retest-source proofs/native/macos/run.ts`, nine runs. Each run writes `mac2-runner-<run>.log` and `macos-proof-console-<run>.log`.
   - `21-51-38Z` failed at "find by label": the pop-up is labelled `style` on macOS 27, while Mac2's tests use `type face`.
   - `21-53-29Z`, `21-55-00Z` and `21-57-08Z` failed at "close the document". The first two clicked Delete while the sheet was still sliding in. The third waited for `hittable` to be the boolean `true`, but the executor sends the string `"true"`. Each left an autosaved TextEdit document (see "Side effects").
   - `22-00-01Z`, `22-00-59Z`, `22-03-07Z` and `22-07-28Z` passed on the earlier code.
   - `22-48-16Z` passed 24 of 24, exit 0, on the revised code, in 25.6 s wall time.
5. iOS simulator builds, from `WebDriverAgent`:
   - `xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/Library/Caches/retest-proofs/derived/wda-ios COMPILER_INDEX_STORE_ENABLE=NO` exited 70: `Unable to find a destination matching … { generic:1, platform:iOS Simulator }`, because "iOS 26.5 is not installed". Log: `wda-ios-build-for-testing-generic.log`.
   - The same without `-destination` exited 65. Everything else compiled; the build stopped at `CompileAssetCatalogVariant thinned`, where `actool` said `No available simulator runtimes for platform iphonesimulator. SimServiceContext supportedRuntimes=[]`. Log: `wda-ios-build-for-testing-sdk-only.log`.
   - Adding `ENABLE_ONLY_ACTIVE_RESOURCES=NO` changed nothing, exit 65. Log: `wda-ios-build-for-testing-no-thinning.log`.
   - Adding `-IDEBuildingContinueBuildingAfterErrors=YES` exited 65 with the same single failure, after 232 compile steps. It linked `WebDriverAgentLib` and `WebDriverAgentRunner` for arm64 and x86_64; `vtool` reads platform `IOSSIMULATOR`, minimum 15.0, SDK 26.5. No `.xctestrun` was written. Log: `wda-ios-build-for-testing-continue.log`.
   - `xcodebuild build -project WebDriverAgent.xcodeproj -scheme WebDriverAgentLib -sdk iphonesimulator -derivedDataPath ~/Library/Caches/retest-proofs/derived/wda-ios-lib COMPILER_INDEX_STORE_ENABLE=NO` printed `** BUILD SUCCEEDED **` after 230 compile steps. Log: `wda-ios-lib-build.log`.
6. `node --conditions=retest-source proofs/native/ios/run.ts` exited 2: `blocked … No iOS simulator runtime is installed. Install one with xcodebuild -downloadPlatform iOS (several gigabytes)`. `--udid` is now refused as an unknown option (exit 2). Console: `ios-proof-console-2026-10-02T22-49-13Z.log`.
7. `node --conditions=retest-source proofs/native/macos/clean-textedit-leftovers.ts` with no `--title` refuses to start (exit 2). With titles it was not run in this revision; see "Side effects".
8. Typecheck of the proof files: `node_modules/.bin/tsc -p proofs/native/tsconfig.json` (TypeScript 6.0.3) and `node_modules/typescript-7/bin/tsc -p proofs/native/tsconfig.json` (7.0.2) both exited 0. Logs: `proofs-native-tsc6.log`, `proofs-native-tsc7.log`.
9. Checks of the new helpers on real inputs, run from a scratch script in `/tmp` that is not kept:
   - `readAutomationModeStart` on four past log windows matched the system log: 01:36 attended, answered after 92.8 s; 01:51 unattended; 02:07 attended, 16.1 s; 02:14 attended, 13.7 s.
   - `capture` on `sleep 30` with a 500 ms deadline ended it with SIGTERM in 507 ms. A shell that ignores SIGTERM was ended with SIGKILL in 10.5 s, and the script exited at 10.6 s.
   - `observe` with a read that takes 5 s and a 1 s deadline returned at 1000 ms.
   - `countChangedPixels` on two earlier window captures of the same content: 11,269 changed pixels from two runs about ten minutes apart, all under the tooltip and in the rounded corners (largest channel difference 33); 0 changed pixels from two runs a minute apart.

## What the macOS proof showed

Run `2026-10-02T22-48-16Z`, with routes relative to `http://127.0.0.1:10100`. The console log and `report.json` hold the same lines.

| Step | Routes | Observed |
| --- | --- | --- |
| Start the runner | `xcodebuild test-without-building`, then `GET /status` until `ready`; then `log show` over the same seconds | Answered after 3.0 s. The log shows one event, `02:48:19.279 Executing request to ENABLE automation mode`, with no dialog: `unattended: true` in the report |
| Launch | `pgrep -x TextEdit` (none) right before `POST /session` with `alwaysMatch: { bundleId: 'com.apple.TextEdit', arguments: [...], environment: {}, noReset: false, skipAppKill: false }`, then `pgrep` again | TextEdit pid 86467, the only TextEdit afterwards |
| Activate and state | `POST /session/:id/wda/apps/activate`, `/wda/apps/state` | State 4, running in the foreground |
| Document dialog | `POST /elements` with a New Document predicate | None. The launch arguments `-NSShowAppCentricOpenPanelInsteadOfUntitledFile NO -ApplePersistenceIgnoreState YES` opened one untitled document; exactly 1 window |
| Window tree | `GET /source`, cut to the window | 46 elements, with the menu bar not kept. Saved as `window-before.xml` |
| Role, scoped | `POST /elements` `class name` window (exactly 1); `POST /element/:window/elements` for text views and buttons | Window `Untitled 2`; inside it 1 text view and 6 buttons |
| Identifier | `POST /element/:window/elements` with `accessibility id` `First Text View`, then `attribute/identifier` | Exactly 1 match, elementType 52, identifier read back |
| Label | `POST /element/:window/elements` with `label ==[c] 'bold' AND (elementType == 12 OR elementType == 9)` and the `style` pop-up predicate | Exactly 1 of each |
| Click | `POST /element/:id/click` on the text view, then on Bold | Bold `"0"` then `"1"`; style `Regular` then `Bold` |
| Display capture and scale | `GET /screenshot`, `GET /session/:id/window/rect` (the main screen in points) | 3456x2234 PNG for a 1728x1117-point screen, scale 2. Checked in memory and not written |
| Focus | `POST /element/:id/click` on the text view, once | |
| Window before typing | `GET /element/:window/screenshot`, `GET /element/:window/rect` | 1172x976 PNG for a 586x488-point window: the exact size at scale 2 |
| Type | `POST /wda/keys` with 22 key presses, capitals as the lower-case key plus Shift, sent once | Text reads `Retest native proof 42` on the first look |
| Window after typing | Same routes, then a pixel comparison of the text view's first 30 points | Exact size again. 3,032 pixels changed on the first line and 875 elsewhere in the window: the title gained "Edited", the insertion point moved |
| Tree after input | `GET /source`, cut to the window | Exactly 1 text view holds the typed text (`window-after.xml`) |
| Clear | `POST /wda/keys` `[Command-A, XCUIKeyboardKeyDelete]`, sent once | Reads `""` |
| Close without saving | `POST /wda/keys` Command-W; `POST /elements` `accessibility id` `DontSaveButton` (exactly 1); `rect` and `attribute/hittable` until steady; `POST /element/:id/click` | The keep-this-document sheet appeared. Delete was clicked once it settled; 0 windows left |
| Menu items naming the document | `POST /elements` with `elementType == 54 AND title == "Untitled 2"`, so only that title can come back | 1 menu item still carries the discarded document's title |
| Terminate | `pgrep` (only pid 86467), `POST /wda/apps/terminate`, `/wda/apps/state` | `true`; state 1; pid 86467 gone |
| End and shut down | `DELETE /session/:id`; `DELETE /`, which answers plain text `Shutting down` | xcodebuild exited with code 0 without a signal |
| Nothing left | `pgrep -f WebDriverAgentRunner-Runner`, pid 86467, a TCP connect to 10100 | 0 runner processes, pid gone, port closed |

Both captures of this run were opened and checked by eye. Before typing: an empty document, the insertion point, Bold on. After: the typed text in bold and the title showing "Edited". Captures of earlier runs were checked by eye for runs `21-53-29Z` and `22-03-07Z`. Every window capture contains the desktop pixels behind the rounded corners and a system tooltip ("grinning face with sweat"), which floats above all windows. That tooltip is why the comparison covers only the first line.

## Automation Mode

`automationmodetool` reports "Automation Mode is disabled. This device requires user authentication to enable Automation Mode." The authorization to enable it lives in the running `automationmode-writer` daemon. The state file `/var/db/com.apple.dt.automationmode/automation-enabled` exists only while Automation Mode is on: `testmanagerd` turns it off after each session ("Total clients: 0") and the folder is empty between runs. The unified log (`/usr/bin/log show`, processes `testmanagerd`, `automationmode-writer` and `launchd`) shows:

| Time | Event |
| --- | --- |
| 01:32:55 | launchd starts writer 76663 "because ipc (mach)". This is the minute this lane first ran `automationmodetool` |
| 01:36:02 | First runner: "requires authentication to enable automation mode", and macOS shows the Enable UI Automation dialog |
| 01:37:02 | XCTest gives up after 60 s |
| 01:37:35 | Someone at the machine authenticates ("serialized authorization"); enabled |
| 01:51:41 to 02:03:24 | Nine sessions enable it without a dialog, through writer 76663, which kept the authorization across a 14-minute gap (01:37:35 to 01:51:41) |
| 02:04:43 | launchd marks the writer inactive, 79 s after the last session ended |
| 02:07:28 | New writer 11875; 02:07:30 the dialog again (reference run `22-07-28Z`), answered after 16.1 s |
| 02:12:13 | Inactive, 136 s after the last session ended |
| 02:14:26 | New writer 24646; 02:14:29 the dialog again (the orchestrator's rerun `22-14-26Z`), answered after 13.7 s |
| 02:15:00 to 02:23:00 | Writer 24646 stays through an 8-minute gap; 02:23:00 enables without a dialog |
| 02:48:19 | This revision's run: enabled without a dialog through writer 24646, which was still alive |

Someone at the machine was shown the dialog at least three times. Each new writer process asked again; the same writer did not. What keeps a writer alive is not established: it went inactive 79 s and 136 s after a session, yet stayed through gaps of 14 and 8 minutes and was still alive 25 minutes after 02:23. An unattended run therefore cannot count on an earlier authentication. The proof now reads the log around each runner start and reports `prompted`, `answeredAfterMs`, `newWriterDaemon` and `unattended` in `report.json`. Apple's tool offers `sudo automationmodetool enable-automationmode-without-authentication` for machines nobody watches; it needs an administrator password and was not run here.

## Accessibility

No Accessibility prompt appeared, and no step failed for want of it; lookups go through XCTest snapshots via `testmanagerd`. Mac2's documentation says Xcode Helper needs Accessibility, at `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Xcode/Agents/Xcode Helper.app` (System Settings, Privacy and Security, Accessibility). Its CI also grants it to the integration test runner it builds. Whether this Mac already holds that grant could not be read, because `TCC.db` is protected with SIP on. One Mac2 attribute, a web view's `AXDOMIdentifier`, needs the grant directly and was not exercised.

## iOS: no simulator runtime

Everything that runs code on a simulator needs one. `xcodebuild -downloadPlatform iOS` installs it (several gigabytes) and waits for the founder's word. With a runtime present, `proofs/native/ios/run.ts` creates its own simulator and acts on no other, builds and starts WebDriverAgent, drives Settings, captures through WebDriverAgent and `simctl io`, then shuts the simulator down and deletes it.

## How each executor does each job

Both serve W3C WebDriver JSON plus their own `/wda/*` routes. Element references come back under `element-6066-11e4-a52e-4f735466cecf` and the legacy `ELEMENT` key. The macOS column is exercised where marked; the iOS column comes from the WebDriverAgent source at the commit above and is written into `ios/run.ts`, but has not run.

| Job | WebDriverAgentMac (macOS) | WebDriverAgent (iOS simulator) |
| --- | --- | --- |
| Start | `xcodebuild test-without-building -scheme WebDriverAgentRunner`, port in `USE_PORT`, interface in `USE_HOST` (exercised) | Same scheme, `-destination 'platform=iOS Simulator,id=<udid>'`, port in `USE_PORT`, interface in `USE_IP` |
| Install | No route. The app must be on disk; the `appPath` capability launches a bundle at a path (not exercised) | No route. `xcrun simctl install <udid> <app>` |
| Launch | `POST /session` with `bundleId` or `appPath`, `arguments`, `environment`, `noReset`, `skipAppKill` (exercised); `POST /wda/apps/launch` | `POST /session` with `bundleId`, `arguments`, `environment`, `shouldWaitForQuiescence`, `forceAppLaunch`, `shouldTerminateApp` |
| Activate, state, terminate | `/wda/apps/activate`, `/wda/apps/state`, `/wda/apps/terminate` (exercised) | The same routes |
| Observe | `GET /source` of the whole app, `attribute/:name`, `/text`, `/rect` (exercised); `/displayed`, `/enabled`, `/selected` | The same, plus `json` source, `/wda/accessibleSource`, `/alert/text` |
| Find | `POST /elements`, `POST /element/:id/elements` with `accessibility id`, `class name`, `predicate string` (exercised); `class chain`, `xpath` | The same strategies |
| Input that sends exactly what it is given | `POST /element/:id/click`, one XCTest click (exercised). `POST /wda/keys`: each item one `typeKey` with modifier flags (exercised). W3C `POST /actions` (not exercised) | `POST /element/:id/click`, one XCTest tap. `POST /wda/keys` with `{ value: [text] }`, one synthesized typing event. `POST /actions` |
| Input that repeats on its own | `POST /element/:id/value` clicks the field when it lacks focus, then clears: it types one backspace-and-delete pair per character, reads the value back, and when text remains double-clicks and types the pair again. It then reports success without reading again, and types (`XCUIElement+AMEditable.m`, two attempts). `POST /element/:id/clear` is the same loop. No longer used | `POST /element/:id/clear` makes up to three attempts: the first may be a HID Clear key press, the last a triple tap and a delete. It then reports success without reading again (`XCUIElement+FBTyping.m`). `POST /element/:id/value` taps the field when it lacks focus, then types |
| Capture | `GET /screenshot` (main display), `GET /element/:id/screenshot` (element crop), `GET /window/rect` (main screen in points) (exercised); `POST /wda/screenshots`, `/wda/video/*` | `GET /screenshot`, `GET /element/:id/screenshot`, MJPEG on 9100. `xcrun simctl io <udid> screenshot` is a different capture source, reading the simulator's display rather than the app through XCTest. It is recorded as its own capture, never as a silent fallback |
| End | `DELETE /session/:id`, then `DELETE /`, which stops the server (exercised) | `DELETE /session/:id`, then `GET /wda/shutdown` |

A client timeout during one of the repeating routes leaves the executor finishing a sequence it chose itself, which can include input after the last read. That breaks Retest's rule that input which may have landed is never sent again. The proofs therefore use only the exact routes and do their own clear: Command-A and Delete, sent once and read back, with no retry.

## Element identity and strict matching

- Every lookup that a proof acts on or checks now requires exactly one match and fails with the count otherwise, as Retest's own locators do.
- Roles are `XCUIElementType…` names in the tree and `elementType` numbers in attributes: 4 window, 9 button, 12 checkbox, 14 pop-up button, 52 text view, 54 menu item. Lookups by role use `class name`.
- On macOS, `accessibility id` becomes XCTest's predicate `"<value>" IN identifiers`, per the runner log. XCTest builds that set itself and Apple does not document its members, so the proof reads `identifier` back from the match. A Retest test id mapping must do the same.
- On iOS, `accessibility id` matches `identifier`, or `label` when the identifier is empty (`XCUIElement+FBFind.m`). One locator name cannot promise one meaning on both platforms.
- AppKit supplies some stable identifiers (`First Text View`, `DontSaveButton`, `saveAsNameTextField`) and some generated ones (`_NS:31`) that are not stable; the proof skips `_NS:` identifiers.
- Labels change between macOS releases: the weight pop-up says `type face` in Mac2's tests and `style` on macOS 27.
- TextEdit's save sheet holds two sets of Delete, Cancel and Save buttons: the identified set inside the sheet, and an unidentified set at y = -1. A title lookup for Delete matches two; strict matching refuses it, and the identifier selects one.
- Boolean attributes are the strings `"true"` and `"false"` on macOS; checkbox values are `"0"` and `"1"`.
- A click sent while a sheet is moving lands in the wrong place, so actionability needs a steady frame as well as `hittable`. The proof waits for two equal frames 250 ms apart.

## Observations and the user's data

A native tree carries the user's own data. Every whole-app `/source` from TextEdit included the Apple menu's Recent Items and TextEdit's Open Recent: file names, recent apps and the user's name. The trees saved before this revision held them, and the orchestrator deleted them. The proofs now keep only the subtree of the app's own window, never the menu bar, and hash the text of any menu inside the window before writing (`ownedWindowSource` in `shared/source.ts`). A lookup outside the window asks the executor for one exact title, so no other item comes back.

Rule for Phase 2: observations and agent `/source` reads are scoped to the owned window and redacted before any report, artifact or model input.

## What relaunch does and does not clear

Observed with TextEdit:

- Launching through a session starts a new process.
- Terminating with an edited document open does not discard it: TextEdit keeps an autosave. One such document reopened on a later launch holding the proof's text.
- Launch arguments such as `-ApplePersistenceIgnoreState YES` changed that launch: no earlier windows were restored and no open panel appeared. Whether anything was written to TextEdit's defaults was not checked; its sandboxed defaults are not readable from outside its container.

Not observed: whether keychain items, the app's container and its defaults survive termination and relaunch. macOS offers no per-app reset command, so a test-owned fixture app needs its own reset, for example a launch argument that points it at a fresh data folder, and keychain service names it deletes itself.

TextEdit runs one instance per user. A document the user opens during a run joins the proof's process, and XCTest's launch terminates a running copy. The proof checks again right before the launch and touches only the pid it launched. Both facts are reasons for Phase 2 to drive a test-owned fixture app rather than a system app.

iOS simulator, from `simctl` and not exercised: relaunch keeps the app container, defaults and keychain. `simctl uninstall` then `install` replaces the container. `simctl keychain <udid> reset`, `simctl privacy <udid> reset all <bundle id>` and `simctl erase <udid>` reset the keychain, permissions and the whole device. `ios/run.ts` creates a new simulator for each run.

## Side effects of this lane on the Mac

- **Automation Mode dialogs.** The person at the machine was shown the dialog at 01:36:02, 02:07:30 and 02:14:29 (the last from the orchestrator's rerun). This revision's run did not prompt.
- **Whole-app trees with private data** were written as `source-*.xml` in earlier runs' artifact folders. The orchestrator deleted them; the proofs no longer write such trees.
- **Recent Items and Open Recent.** The review found `Untitled 2` to `Untitled 5` in the Apple menu's Recent Items, and `Untitled 2`, `3` and `4` in TextEdit's Open Recent, in those saved trees. After this revision's run discarded its document, 1 menu item titled `Untitled 2` remained; earlier runs used the same name, so which run added it is not known. These entries were not removed: the menus offer only Clear Menu, which would also erase the user's own items.
- **Autosaved documents.** The failed runs `21-53-29Z`, `21-55-00Z` and `21-57-08Z` left `Untitled 2`, `3` and `4`, holding empty text or `Retest native proof 42`. `Untitled 2` reopened when TextEdit was launched without `-ApplePersistenceIgnoreState`, and was discarded with Delete by a script in `/tmp` (runner log `mac2-clean-textedit-leftovers.log`). `Untitled 3` and `4` did not reopen. A second `/tmp` script opened three empty documents and got `Untitled 2`, `5` and `6`, so both names are still taken (`mac2-probe-untitled-names-console.log`). Neither script was kept. They are most likely in `~/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information/`, which was not listed because reading another app's container can raise a permission prompt.
- **Cleanup script.** `proofs/native/macos/clean-textedit-leftovers.ts` is the rerunnable form of the first script: it discards windows with the named titles whose text is the proof's or empty, and reads nothing else. This version was not run. It cannot reach `Untitled 3` and `4`, which TextEdit does not reopen.

## Recommended route for Phase 2

1. Keep both executors as separate XCTest runner processes behind Retest's session contract, subject to the dependency decision above. Retest owns the HTTP client, deadlines, locator semantics, actionability, checks and evidence. Treat a request with no answer as an unknown outcome.
2. Send input only through the exact routes: one `/click`, `/wda/keys`, W3C `/actions`. Retest owns clear-and-type and never calls `/value` or `/clear`, which repeat input on their own. If an executor offers no exact route for something, document the gap rather than use a repeating one.
3. Require exactly one match for every action and check. Map test ids to identifiers verified on the match. Actionability means hittable plus a steady frame.
4. Scope observations to the owned window and redact menus before any report, artifact or model input. Default visual evidence to window crops, check their size against the window and the screen scale, and remember that a crop includes whatever floats above the window.
5. Pin the tested set: Xcode build, macOS or iOS runtime version, executor commit. Build once per machine and record checksums. Do not rebuild the macOS runner without need: each ad hoc signed build gets a new code hash, and macOS ties Accessibility grants to the old one.
6. On macOS, use one runner per interactive desktop lease and serialize native work: the proof takes focus, the pointer and the keyboard. Drive a test-owned fixture app.
7. On iOS, use `simctl` for the device lifecycle and WebDriverAgent inside the app, with one new or erased simulator per isolation boundary. WebDriverAgent screenshots and `simctl io` screenshots are two named sources. MJPEG on 9100 is the candidate live frame source for Phase 4.
8. Prerequisites, stated honestly:
   - Full Xcode, its license accepted and selected with `xcode-select`.
   - An iOS simulator runtime, installed with `xcodebuild -downloadPlatform iOS` (several gigabytes).
   - A logged-in GUI session on the Mac; macOS UI testing has no headless mode.
   - Automation Mode: either an administrator answers the dialog whenever a new writer daemon starts, which happened three times in about forty minutes here, or `sudo automationmodetool enable-automationmode-without-authentication` is run (untested here) on machines nobody watches.
   - Possibly Accessibility for Xcode Helper, as Mac2's documentation says; nothing exercised here needed it.
   - Signing: ad hoc for the macOS runner and the simulator build. Physical iPhones need a team and are outside the 0.1.0 promise.

## Not verified

1. Any iOS step that needs a simulator. `ios/run.ts` has only reached its runtime check.
2. That a full WebDriverAgent `build-for-testing` succeeds once a runtime exists.
3. What keeps an `automationmode-writer` alive, and whether `enable-automationmode-without-authentication` removes the dialog.
4. The revised macOS proof ran once; it has not been repeated.
5. Whether Xcode Helper or the runner holds an Accessibility grant, and which routes would fail without one.
6. The autosaves `Untitled 3` and `4`, and the Recent Items and Open Recent entries: not removed, and the autosaves' location not confirmed.
7. The cleanup script with titles, `--keep-display-screenshot`, `appPath`, `/wda/apps/launch`, W3C `/actions`, video, scroll and swipe.
8. Whether launch arguments wrote anything to TextEdit's defaults; whether keychain, container and defaults survive relaunch.
9. Behaviour on an Intel Mac, another macOS or Xcode version, or a second display.
