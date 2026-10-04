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

## Phase 2: native sessions and the app lifecycle

Phase 2 item 1 of [release-0.1.0.md](../release-0.1.0.md), 3 and 4 October 2026, revised after three reviews. It builds the lifecycle half of native sessions in `src/native/` on the route above, which the founder accepted: the two XCTest executors as components Retest builds from pinned commits, behind its own HTTP client, with exact routes only. Locators, input, checks, the keyboard and alerts are the next lane's; nothing here is wired into `src/runner/target-drivers.ts` yet.

### What exists now

| File | What it does |
| --- | --- |
| `src/native/executors.ts` | The tested set as data, and the build step `ensureExecutorBuild` |
| `src/native/processes.ts` | Every command in a process group of its own, with a deadline, a stop, an exit hook, hidden variables and no inherited `TEST_RUNNER_` variable; a process read by pid as present, absent or unreadable; a recorded process ended only while its command line is the recorded one |
| `src/native/executor-process.ts` | Starts an executor from its `.xctestrun` on a port that is not an executor's default, notes the runner app's pid as it appears, ends it on every failed path, holds a port, watches the runner |
| `src/native/desktop-lock.ts` | One macOS runner per desktop across processes, held by a kernel lock, with a record that names the holder and its runner's processes, and recovery of a gone holder's runner |
| `src/native/webdriver-client.ts` | Retest's HTTP client, 16 routes and no `/value` or `/clear` |
| `src/native/source-scope.ts`, `png.ts` | The tree cut to what the session owns; the macOS window area cut from the display capture |
| `src/native/ios-simulator.ts` | `simctl` lifecycle and the iOS simulator runtime |
| `src/native/macos-app.ts` | The desktop's one macOS runner, macOS app runtimes, and the check of what lies over a window |
| `src/native/session.ts` | The native session on the contract's `AppLifecycleCapability` |
| `src/native/identity.ts` | What a native result names |
| `src/native/reset-policy.ts` | Clean state per platform, in code and in words |

### The pinned set

| | Value |
| --- | --- |
| Xcode | 26.5 (17F42) |
| iOS simulator runtime | 26.5 (23F77) |
| Architecture | arm64 |
| WebDriverAgent | 16.13.6, `9d1d17ddb59e6097ddc3324b23ca9f4174507b12`, BSD-3-Clause, `LICENSE` SHA-256 `d9910c6b…b4` |
| appium-mac2-driver | 4.3.6, `f38257191fa9f273a684f6a9c8c2b16d1272bd09`, Apache-2.0, `LICENSE` SHA-256 `c71d239d…b4` |

`ensureExecutorBuild` refuses before it builds anything when Xcode is another build, a checkout is missing (naming the repository, the commit and the `git clone` to run), is at another commit, has changed tracked files or untracked files git reports, or has a user scheme of the runner's name under `xcuserdata`, which would replace the shared scheme even where git ignores it; and when a licence text is not the pinned one. Other git-ignored files are not seen. A build lives in `~/Library/Caches/retest/native-executors/<executor>-<version>-<key>/`, where the key hashes the commit, the Xcode build, the SDK, the architecture and, for WebDriverAgent, the runtime set. Its `build.json` holds the products' checksum (a SHA-256 over every path, kind and byte), the `.xctestrun`'s SHA-256 and the runner app's code directory hash. A second call checks the products against the recorded checksum and builds nothing; a build that changed is refused rather than built again.

Licence files beside each build: WebDriverAgent's BSD-3-Clause text, Apache-2.0's text, and the header of `FBHTTPStatusCodes.h` (Copyright 2013 Neo Visionaries Inc., Apache-2.0), which is compiled into both executors; for the macOS runner also its own Apache-2.0 licence and a notice quoting the Facebook BSD header 91 of its files keep. Records written before the pin named the `FBHTTPStatusCodes.h` notice were given it on their next reuse, products untouched.

Results on this Mac:

- WebDriverAgent: built in 50.2 s with `xcodebuild build-for-testing -destination 'generic/platform=iOS Simulator'`. Products `0ddb9244e806b6a5…`, code directory hash `6536ddf3398ac1008b61fa1762121bb7e432d7b8`. The Phase 1 folder `derived/wda-ios` held no test run file, so it was not taken over.
- macOS runner: taken over in place from `derived/mac2`, whose test bundle names Xcode build 17F42 and SDK `macosx26.5`. The runner app's own Info.plist names 17F41 and `macosx26.4.internal`: it is Apple's XCTRunner template, so the test bundle inside it is what is checked. Code directory hash `06e22851aab6c648f81dcfa546eaeeffab753404`, the same as Phase 1's: not rebuilt. Which commit those products were compiled from is not recorded in them, so a result names this build with `commitVerified: false`; the checkout is at the pinned commit now.
- Second run: both reused in 0.1 s.

### How an executor starts and ends

`xcodebuild test-without-building -xctestrun <pinned .xctestrun> -destination <…> -resultBundlePath <temporary folder>`, in a process group of its own, with the environment of the Retest process minus the hidden variables and any inherited `TEST_RUNNER_` variable. The build leaves `USE_PORT`, `USE_IP` and `USE_HOST` empty in the test run file; xcodebuild's `TEST_RUNNER_` prefix sets them in the runner's environment (`man xcodebuild`). Each runtime takes a free port, never the defaults 8100 and 10100, and binds the HTTP server to 127.0.0.1.

WebDriverAgent also starts a screen stream (MJPEG) on every interface, whatever `USE_IP` says: `FBTCPSocket` is started without an interface (`FBWebServer.m`). The iOS runtime holds the stream's port on every interface from Retest while WebDriverAgent starts, refusing each connection, so WebDriverAgent's listener fails, it logs "Cannot init screenshots broadcaster service", and it serves on without the stream; the hold ends once WebDriverAgent answers, and a start whose log lacks that line fails. lsof shows WebDriverAgent's runner app listening on `127.0.0.1:<port>` and nothing else, in the integration test and in the lifecycle proof. The hold itself listens on every interface for the length of the start, about 30 s here, serving nothing. A fork of WebDriverAgent is not needed for this.

The runner app runs outside xcodebuild's group, launched by macOS or the simulator: its parent is launchd itself on macOS and the simulator's `launchd_sim` on iOS (read with `ps` on both, scratch run below), so no parent chain leads to xcodebuild. Only a runner app that appears during the start can be the start's own, and more than one refuses the start by name. On macOS the runner app is tied to the start by listening on the start's port, as any other start of the same build runs the same executable; on iOS by its command line, which lies under the start's own simulator. The tied runner app is recorded with its exact command line, written to the desktop record on macOS, and ended when a start fails, is stopped or runs out of time; one that appeared and could not be tied is named in the failure and not ended, and a runner app the start has already tied is never reported as untied. On macOS a runner app that appeared and is not tied yet is written to the desktop record as untied, so a start killed outright before its runner answered leaves that pid named; the next start names it in its refusal, never ends it, and keeps the record until it is gone. A start that could not end what it recorded keeps the desktop lock, whose record names it. SIGTERM to the macOS runner's xcodebuild group ended its runner app within 0.5 s (scratch run below). A start refuses ports 8100 and 10100, the executors' defaults, which another tool driving the same executor would use; `freePort` never gives either.

Every kill of the native driver is of a process Retest recorded, by pid and exact command line, and `ps -o args= -p` is read right before the SIGTERM and again right before the SIGKILL that follows the grace period: a pid freed and given to another process meanwhile is left alone. A reading is present, absent (exit 1 and nothing printed, not even to stderr) or unreadable, and an unreadable one is a failure on every path, never taken for a process that is gone. The processes left in a deleted simulator's folder are ended the same way, each as `ps` listed it. One kill is not tied to a command line, and is the accepted class: xcodebuild's process group, which Retest leads, signalled by its group id, at a stop and in the exit hook. A group id stays the leader's while any member lives; the exit hook is taken away when the group is found empty, at a stop and when xcodebuild exits, and it stays installed only while members may remain.

When the Retest process exits by its end or `process.exit`, exit hooks kill the recorded runner app, after `ps`, run with the hidden variables stripped, shows its command line is still the recorded one, and for iOS shut the simulator down and delete it, with an environment stripped of hidden, `TEST_RUNNER_` and `SIMCTL_CHILD_` variables. A SIGKILL of the Retest process runs no hook: the simulator and its runner stay until the next start's sweep, and a macOS runner until the next start reads the record. A failed process reading is a failure on every path, never an empty list.

The runner app's pid is checked every 500 ms once the runtime runs. The integration tests measure the time from killing the runner app to the runtime reporting it: 38 ms on iOS and 371 ms on macOS in the last runs, printed by the tests as diagnostics. In the first iOS integration run, before the pid was watched, the runtime learned of the loss only when xcodebuild exited, 41 s after the kill; why xcodebuild takes that long was not looked into.

One runner per desktop, across processes, held by a kernel lock: `/usr/bin/lockf -k -s -t 0 ~/Library/Caches/retest/macos-desktop.lock` runs `cat` on a pipe from the Retest process, and holds the lock as long as that pipe is open. When the Retest process ends in any way, SIGKILL included, the pipe closes, `cat` and `lockf` exit and the kernel lets the lock go, so no taker judges whether a holder is alive and two can never both hold it. The holder does not keep the Retest process alive. Beside the lock, `macos-desktop.json` records the holder (pid, when it took the desktop, and its program and entry script, never later arguments) and the runner's processes as they appear, xcodebuild and the runner apps, each with its exact command line, plus runner apps not yet tied. Only the holder writes it, beside it and renamed into place, and only while the record on disk is still its own and its `lockf` still runs.

A start finding the desktop held is refused naming the holder by pid, program and start time, or saying it is this very process when it is. One that takes the lock and finds a record left by a gone holder ends the processes it names whose command lines are still exactly the recorded ones, xcodebuild with its process group, names any untied runner app still running, and takes the desktop only once nothing it names is left; otherwise, or when `ps` cannot be read, it keeps the record, lets the lock go and is refused by name, and a later start tries again. A record that cannot be read is never overwritten: the start is refused naming the file. Four processes taking the desktop at once left exactly one holder in each of 6 rounds, and three taking over a gone holder's record at once left one, which went on writing its record; with real processes and the real `lockf`. A runner running without a record that names it is refused by name and never stopped.

### Lifecycle routes exercised

| Job | iOS simulator | macOS |
| --- | --- | --- |
| Device | `simctl list runtimes/devicetypes/devices -j`, `create`, `boot`, `bootstatus -b`, `shutdown`, `delete` | `automationmodetool` |
| Session | `POST /session` with no app, `DELETE /session/:id` | `POST /session` with `skipAppKill`, `DELETE /session/:id` |
| Install | `simctl install`, then `simctl get_app_container … app`; the result, and every later session of the runtime, names the copy installed on the simulator, read from there | none: refused as unsupported, the app runs where it is |
| Launch | `POST /wda/apps/launch` `{ bundleId, arguments, environment }` | `POST /wda/apps/launch` `{ path, arguments, environment }`, after Launch Services lists no app with the bundle id |
| Activate, state, terminate | `/wda/apps/activate`, `/state`, `/terminate` by bundle id | the same by path |
| Process | `simctl spawn <udid> launchctl list`, then `ps -o args= -p` for each pid's command line | `lsappinfo find bundleid=`, `lsappinfo info -only pid,bundleid` for each app it lists, then `ps -o args= -p`: by bundle id, wherever macOS runs the copy from |
| Capture | `GET /screenshot`; `simctl io screenshot` as a separate source | `GET /screenshot`, `GET /window/rect`, the window's frame from `GET /source`, and the window server's window list, then cut in Retest |
| Tree | `GET /source`, root checked by its `bundleId` | `GET /source`, cut to the first window |
| Stop | `GET /wda/shutdown` | `DELETE /` |

Ran only against the fakes in the unit tests, not on the real system: the sweep of simulators whose maker is gone, the refusal when Automation Mode would ask an administrator (this Mac needs none), the refusal of a runner already on the desktop, a live holder of the desktop lock, the recovery of a gone holder's runner, an untied runner app left by a start killed before its runner answered, a desktop record that could not be written mid-start, and two runner apps appearing during one start. The lock races ran with real processes and the real `lockf`, without runners. The fake `ps` answers `-p` and `-o args=` as the real one does, and fake runner apps note each SIGTERM they get, so the unit tests show Retest's own kill of a runner app that neither its shutdown, nor xcodebuild's end, nor the simulator's shutdown ended. The client also exposes `/element/:id/screenshot`, `/element/:id/click`, `/wda/keys` and `/actions` for the next lane; the lifecycle uses none of them.

Behaviour both executors share, and what the session does about it:

- `/wda/apps/launch` on a running app only brings it to the front, with none of the new arguments. A launch is refused while the app runs.
- `/wda/apps/activate` launches an app that is not running. An activate is refused when the app is not running, and a launched app found not running is reported as ended without being terminated (`session_lost`, `appEnded`). Such ends are kept by launch (`unexpectedEnds`) across later launches.
- `POST /session` replaces the active session. The old id answers `invalid session id`, which loses that session.
- `/wda/apps/terminate` acts by bundle id or path, so it is used only while every running copy is one the session's own launch started.
- WebDriverAgent's tree root carries `bundleId` and `processId`, and the root is checked by its bundle id. A root that carries none is checked by the app's name. A tree of another app is refused whole.

### What a session owns

- The app's processes the operating system shows within a window right after a launch of the session that may have gone, each recorded with its command line: looked for every 100 ms for up to 5 s after an answered launch and 2 s after one whose outcome is unknown, without the stopped signal, and never past the request's own deadline. The launch blocker showed no copy running just before the launch, so what shows within the window is taken to come from it. A copy someone else starts between that check and the end of the window would be taken for the session's own; that race is a known limit. After the window nothing is claimed: a copy that shows later is refused by a terminate as one the session did not launch, and dispose names it in a `cleanup_failed` and ends nothing. A reading that fails within the window fails the launch (`outcome_unknown`, input sent), and the session owns nothing of it.
- A process the session recorded is its own only while its pid shows the recorded command line; a pid given to another process is never terminated or ended. Readings kept beside unknown outcomes hold pids only, not command lines, which can carry launch arguments.
- The session expects the app running only once it has seen its process, so a launch that timed out before the app started is not later reported as a crash.
- A terminate is refused, naming the pids, while a copy the session did not launch runs. Dispose ends only the session's own processes: by the executor while no other copy runs, otherwise by their pids. A session whose launch never showed a process ends nothing. A process reading that fails refuses a launch or a terminate by name, and makes dispose fail with `cleanup_failed`; it is never read as nothing running. An app running at dispose after a launch whose process the session never saw is named in a `cleanup_failed`, not ended.
- A stop during the readings before a launch or a terminate takes its class from the stop.
- A read before an action that gets no answer, such as the state read before a launch or an activate, is a failed read: nothing was sent, no launch is recorded, and dispose has nothing to end.
- Every reference carries the session id, a per-object `instance`, the launch generation and its own id. A session reopened for the same attempt and app shares the id but refuses the earlier object's references.

### macOS captures

The macOS runner captures the whole main display, so a cut of it holds whatever lies over the app's window. Reading the window's own pixels by window number needs Screen Recording permission for the process that asks; `CGPreflightScreenCaptureAccess` answered false here, and asking for it raises a prompt, so that route is not used. A capture is taken only while the app is in front (state 4) and no window of another process lies over its window, as the window server lists the windows on screen: owner, layer and frame, read through JavaScript for Automation with `CGWindowListCopyWindowInfo`, which needs no permission and showed no prompt. Otherwise the capture fails, naming how many windows lie over it and their layers. The Dock's surface over the whole screen is not counted; its icons can still show in a window that reaches into the Dock. The pointer's own window (layer 2147483630) is counted, so a pointer over the window refuses the capture.

The window list is read right before and right after the screenshot, and a capture between two different lists is refused, so a banner that comes in meanwhile is not kept; a second reading that fails refuses the capture, naming that reading. The app's own windows are those of the processes Launch Services lists under its bundle id. The cut is a rectangle: the window's rounded corners, and any translucent part of it, show what lies behind the window, which the check does not look at.

The earlier runs refused TaskDesk captures for windows at layer 1000, including one over the whole screen, and in the lifecycle proof the pointer too. The full-screen owner is macOS's own AutomationModeUI, the Automation Mode window present while XCTest drives the desktop. The coverage check recognises its pid only through the exact system executable `/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI`, and passes over only its full-screen window during an open runner session. A matching layer alone grants nothing. A smaller window of that owner, the pointer, and another app's overlapping window still count. The existing Dock surface rule remains.

TaskDesk now accepts `-windowFrame`. The integration and pixel comparison launched it with `-reset -serviceURL <running fixture service> -windowFrame 20,60,700,480` and confirmed that frame. The comparison kept the same TaskDesk process open after closing the runner and checked that no runner or Automation Mode window remained. A static background rectangle at window points `20,220,520,100`, scale 2, matched pixel for pixel: 0 differences among 208,000 RGB pixels, alpha 255 in both captures. The first image was the real runner's PNG display capture cut to TaskDesk; the independent baseline was the native computer tool's window JPEG, decoded to RGBA with the tool's existing JPEG decoder. The JPEG baseline limits this measurement to the compared pixels; it does not establish equality for all window pixels or lossless detail at text edges. A larger clear region at window points `20,40,520,300` also had 0 differences among 624,000 decoded pixels between that tool's captures with and without the runner.

Only clear TaskDesk regions were saved. The full runner display and full window crop stayed in memory, so the overlapping app's pixels reached no artifact. Captures and facts are in `/tmp/retest-native-overlay/`: `taskdesk-runner.png`, `region-native-tool-with-runner.png`, `region-native-tool-without-runner.png`, `pixel-comparison.json`, `native-tool-comparison.json`, and `comparison-final.log`. The fixture service was launched with `node --conditions=retest-source fixtures/cross-platform/service/server.ts --port 0`; its pid and command line and TaskDesk's are recorded beside the captures. Both were ended after the comparison, with their recorded commands checked. TaskDesk's existing build was reused. No permission prompt appeared.

The full production capture still does not pass on this Mac: Wispr Flow's window at layer 1000, frame `608,445,512,614`, overlaps the requested TaskDesk frame. It was left alone and the capture correctly refused. The integration passed 7 of 7 and the macOS lifecycle proof passed 10 of 10, both by preserving that refusal. The proof uses TaskDesk's default centred frame. Logs are `/tmp/retest-native-overlay/macos-integration.log` and `/tmp/retest-native-overlay/macos-proof.log`; its report is `/Users/dragon/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-04T14-23-44Z/report.json`. The comparison's first two attempts stopped at the same covering-window check, logged in `comparison-run.log` and `comparison-retry.log`. A shell PNG capture could not create an image; the permission preflight was false, recorded in `shell-capture-with-runner.log` and `screen-capture-preflight.log`. No permission was requested.

The macOS unit file passed 27 of 27 and all native unit files passed 202 of 202, with no skips. The fake window list allowed the system overlay during an open session and refused a full-screen window at the same layer whose executable was another app's `AutomationModeUI`; the existing pointer and smaller-overlay-window assertions still passed. Logs are `/tmp/retest-native-overlay/unit-macos-app.log` and `/tmp/retest-native-overlay/native-unit.log`. The unit logs include an exit-listener warning. `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` exited 2 with 18 errors outside the files changed here, in the shared browser, doctor, protocol, runner and test support code. It stopped at the first compiler, so the second compiler and examples check did not run. Log: `/tmp/retest-native-overlay/typecheck.log`. Every integration test, proof and comparison held the heavy gate lock; `pgrep -f benchmarks/run.ts` was checked before each test or proof, with no benchmark runtime found. Three other command lines contained the path in their task instructions and were left alone. Before the comparison, selecting TaskDesk in the native screenshot tool unexpectedly launched it without arguments outside the lock. That launch was recorded by pid and command in `/tmp/retest-native-overlay-ui-launch.json` and ended before starting the comparison.

### Native secret output

The native runner pipes xcodebuild stdout and stderr through complete-line redaction before writing its log. A value split between chunks stays in memory until the line ends. XCTest typing and synthesized-input activity names become `{{native-input}}`, including the abbreviated text and individual keys that cannot match a complete secret. Native executor builds use the same line writer. Runtime options accept the run's redactor and hidden variable names.

Each executor writes its result bundle and execution derived data into a separate Retest-owned temporary folder. The folder is deleted when the output closes, after the owned runner apps end. Runtime close waits for that deletion and reports failure if it cannot confirm it. No result bundle is retained beneath the run folder or the executor caches. This does not redact image or video pixels, and the proofs save neither while a private value is visible.

Session source attributes are XML-decoded before redaction and escaped again for the saved tree. Alert fields and executor failure text are redacted too. Fill verification reads the original field value privately in the parent, preserving the exact read-back check while the returned tree contains placeholders. An outstanding input enters the ledger before awaiting the executor response. Reconcile sees it immediately; disposal waits for the input lane. Runtime `openSession` returns its existing client and executor session with the lifecycle session. The direct native integration uses that pair without a status attachment.

The real TaskPhone and TaskDesk proofs signed in, filled a fresh private value containing `&`, and observed `{{native-proof}}`. Grep checked the run folder, xcodebuild output, build derived data and executor caches for that value, its XML-escaped forms and its XCTest prefix. Both scans returned no matches; executor typing placeholders were present. Both temporary bundles and execution derived folders were absent after close. The isolated run passed in `/tmp/retest-native-secrets-real-final.log`; both proofs passed again in the full suite, including the sign-in credential grep against each retained run folder, in `/tmp/retest-native-secrets-integration.log`. The native unit suite passed all 237 tests in `/tmp/retest-native-secrets-unit-all-final.log`, and the six secret tests passed after making their failure output private in `/tmp/retest-native-secrets-unit-private-failures.log`. Artifact paths and the full-suite result are in [the native secret build report](../codex/build-native-secrets-report.md).

The public native API still refuses secret references in `src/runner/running-test.ts` and `src/runner/native-pool.ts`. Its resolver accepts web origins but has no native bundle destination check. The three unchanged API tests ran, failed at that refusal and skipped none. Log: `/tmp/retest-native-secrets-api.log`. These runner files are outside this work's ownership, so the direct native proof does not establish passing public sign-in flows. The required runner changes and retained artifacts are in the build report.

The full integration run ended with 455 passes, seven failures and two live-provider skips. Besides the three secret refusals, the diagnostic builder's phone log test failed to reconcile its launched app PID, and two evaluation tests refused captures containing other windows. The first phone interaction case refused another app's tree during keyboard wait. Its focused rerun signed in and created a task, then returned `timeout` for the deliberate wrong-state check where the existing test requires `check_failed`. No assertion or ownership check was changed. The native lifecycle cases, all desktop interaction cases and both refreshed secret proofs passed. Logs: `/tmp/retest-native-secrets-integration.log`, `/tmp/retest-native-secrets-phone-interaction-retry.log`.

The final source/examples and proof typechecks passed under the lock. Logs: `/tmp/retest-native-secrets-typecheck-current.log`, `/tmp/retest-native-secrets-typecheck-proofs.log`.

### Clean state

`src/native/reset-policy.ts` holds each platform's policy as data and `describeResetPolicy` prints it in words.

- **iOS simulator.** The boundary is one runtime: it creates a simulator from the target's device type and runtime, and shuts it down and deletes it when it closes. The app's container, defaults, keychain items and privacy grants start empty; the contract says `appData: 'reset'`, `keychain: 'reset'`. Within one runtime a relaunch keeps everything the app wrote. Not isolated: the app's backend, the Mac itself and its shared simulator runtime, the WebDriverAgent build, and the simulator's pasteboard, which was not checked and which Simulator.app shares with the Mac's while it is open. Exercised: a file written into TaskPhone's data container (`simctl get_app_container … data`) survived a terminate and relaunch; after the runtime closed, that container was gone, and a second runtime's container did not hold it. No keychain item was written and looked for.
- **macOS.** The boundary is one launch: a new process at the app's path, refused while any copy with the bundle id runs, terminated when the session ends. Retest deletes none of an app's data, since it cannot tell a test-owned copy from the user's own; the contract says `appData: 'kept'`, `keychain: 'kept'`. Left to the app: its defaults domain, its files and its keychain items. Not isolated: Saved Application State, autosaves, recent documents and Recent Items, privacy grants, Launch Services, the pasteboard, other apps and the desktop itself, and the backend. Exercised with TaskDesk: a key written to its defaults domain survived a relaunch without arguments; a launch with TaskDesk's own `-reset` removed it.

The host preparation path, `prepareAttempt` in `src/runner/preparation.ts`, ran against the cross-platform fixture service on both platforms: a preparation that calls the service's reset route answered `prepared`, the native lifecycle ran, and the cleanup that resets again answered `done`. Pointed at a port nothing listens on, the same preparation ended `failed`, with the attempt's failure `setup_failed`. The service began to require its `x-task-client` header on writes during this lane; the preparation sends `test`.

### Commands and results

Every macOS run and every simulator run held `/tmp/retest-heavy-gate.lock`.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source proofs/native/build-executors.ts` | WebDriverAgent built in 50.2 s, macOS runner taken over in 0.3 s; a second run reused both in 0.1 s | `/tmp/retest-native-build-executors.log`, `/tmp/retest-native-build-executors-2.log` |
| `node --conditions=retest-source --test tests/integration/native-ios-lifecycle.test.ts` | 9 of 9 on the real simulator after the third review's fixes, in 136 s; 9 of 9 after the second review's. After the first review's fixes, one run passed 6: the crash test's launch named no process and the next two tests waited on the session it left open; that did not recur in any later run or in a scratch run of the same sequence, and its cause is not established. Tests now dispose every session they open, and the crash tests assert the launch's answer first | `/tmp/retest-native-integration-ios.log` |
| `node --conditions=retest-source --test tests/integration/native-macos-lifecycle.test.ts` | 7 of 7 on the real runner after the third review's fixes, with the app's processes read by bundle id; the capture refused by name, a window at layer 1000 over the whole screen. Before them, 7 of 7 with two such windows | `/tmp/retest-native-integration-macos.log` |
| `node --conditions=retest-source proofs/native/lifecycle.ts` | 19 of 19 steps after the third review's fixes, run `2026-10-03T23-49-12Z`, the TaskDesk capture refused by name. Before them: iOS half 9 of 9 steps (run `2026-10-03T22-25-13Z`); its macOS half stopped at the wait for TaskDesk's window, which did not appear in its tree within 5 s, without saying why; the step now says what the last look found. The macOS half alone then passed 10 of 10 with the window found at the first look (run `2026-10-03T22-27-50Z`), the capture refused by name | `/tmp/retest-native-lifecycle-proof.log`, `/tmp/retest-native-lifecycle-proof-macos.log` |
| `node --conditions=retest-source proofs/native/ios/run.ts` | 21 of 21 steps, run `2026-10-03T19-27-53Z`; the first rerun stopped at "find General by label", see below | `/tmp/retest-native-ios-proof.log` |
| `node --conditions=retest-source proofs/native/macos/run.ts` | 25 of 25 steps, unattended, run `2026-10-03T23-51-32Z`, with the teardown that signals only the runner app and the TextEdit it recorded, by pid and command line (both were gone); run `2026-10-03T22-26-19Z`, with the teardown that ends only the runner app it recorded (it found it gone); 24 of 24 in run `2026-10-03T19-28-57Z` before that change | `/tmp/retest-native-macos-proof.log` |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` | 198 of 198 in 74 s, the next lane's native files included. This lane's: 142 tests in 10 files, against a fake executor server, fake `simctl`, `xcodebuild`, `plutil`, `git`, `codesign`, `ps`, `lsappinfo`, `osascript` and `lsof`, and races of up to four processes on the real `lockf` | `/tmp/retest-native-unit-all.log` |
| `npm run test:unit` | 2471 pass, 1 fail: `tests/unit/assertions-matchers.test.ts`, "a list matcher that does not pass", whose message said "Looked 1 time in 80 ms" while its pattern wants "times". Not this lane's file; alone it passed 27 of 27 | `/tmp/retest-native-gate-unit.log`, `/tmp/retest-native-scratch/assertions-matchers-alone.log` |
| `npm run typecheck` | clean on both compilers and the examples project | `/tmp/retest-native-gate-typecheck.log` |
| `npm run typecheck:proofs` | clean on both compilers for all four proofs | `/tmp/retest-native-gate-typecheck-proofs.log` |

The integration tests cover, on the real targets: create, boot, install, launch with arguments, state, iOS captures carrying the session id, instance and launch, the scoped tree, terminate, delete, and nothing left (no simulator listed, no process under its folder, no runner, no TaskDesk, no listening port). The deliberate cases: a reference from an earlier launch or another session refused; a stale executor session, made by a second client opening its own, answered `invalid session id` by the real executor and lost the session, which still ended the app its launch started by that app's pid; an app killed under the session reported as ended and not relaunched by activate; a cancel sent once the app's process existed, on both platforms, answered `input: 'unknown'`, and reconciliation read the app running; a runner app killed under an open session reported lost within 5 s on both platforms.

Artifacts after the third review's fixes: `~/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-03T23-49-12Z/` (both captures of TaskPhone, the TaskPhone tree, the TaskDesk window tree, `report.json` with the refusal) and `~/Library/Caches/retest-proofs/artifacts/macos/2026-10-03T23-51-32Z/`. Before them: `~/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-03T22-25-13Z/` (`proof-phone-launch1-o1-executor-screen.png` and `proof-phone-launch1-o2-simulator-display.png`, 1206x2622, TaskPhone connected to the fixture service; `taskphone-tree.xml`), `~/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-03T22-27-50Z/` (`taskdesk-window.xml`, `report.json` with the refusal), `~/Library/Caches/retest-proofs/artifacts/macos/2026-10-03T22-26-19Z/` (the Phase 1 proof), and from before the capture check `~/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-03T19-45-27Z/proof-desk-launch1-o1-window-crop.png`. Neither tree holds a menu bar.

### Scratch runs

Run from `/tmp/retest-native-scratch/`, not kept in the repository, each under the lock:

- `ios.ts`: the first real iOS runtime: started in 31.7 s on a free port through `TEST_RUNNER_USE_PORT`, installed, launched and captured TaskPhone from both sources, terminated, closed.
- `macos.ts`: the first real macOS runtime: runner in 1.8 s, TaskDesk launched by path, a window crop of 1640x1120 checked by eye, before the capture check existed.
- `prep.ts`: the host preparation against the service; it showed the reset route answering 403 once the service wanted its header.
- `windows.js`, `preflight.js`: the window list reads without a prompt and gives owner, layer and frame; other apps' sharing state reads 0, so it says nothing about what a capture holds; Screen Recording preflight answered false.
- `macos-frame.ts`: the two `-NSWindow Frame` launch arguments above; the window did not move.
- `sigterm.ts`: SIGTERM to the macOS runner's xcodebuild group; xcodebuild and its runner app were gone within 0.5 s. This script then also SIGKILLed pid 23988, a macOS runner process it found afterwards, which the desktop's start had not seen and which this lane cannot show it started. Its owner is not known.
- `ios-crash.ts`: a stale session's dispose followed by a new session's launch, the sequence of the failed integration run; the new launch named its process.
- `parents.ts`: the parent chains of both runner apps: launchd (pid 1) for the macOS runner, the simulator's `launchd_sim` for the iOS one.

### What the proofs needed

- `macos/mac2.ts` ended, at teardown, every process matching `WebDriverAgentRunner-Runner`, which could be Retest's own runner or any iOS runner. It now records its own runner app, the one process listening on its port, and the TextEdit it launched, each with its command line, and signals either only after `ps` shows that command line right before the signal; `clean-textedit-leftovers.ts` and `macos/run.ts` pass the same records. Its check that nothing is left fails when the runner started and its runner app was never recorded, or when `ps` cannot be read, rather than passing.
- `tests/integration/native-harness.ts` turned a failure to read a prerequisite (the Xcode version, a path, the simulator runtimes, `automationmodetool`) into a named skip with a false reason. A prerequisite that is missing still skips by name; one that cannot be read now fails the file.
- `ios/run.ts` would have built WebDriverAgent a second time into its own folder. It now takes the pinned build from `ensureExecutorBuild` and starts it as Retest does, with `-xctestrun` and `TEST_RUNNER_USE_PORT` and `TEST_RUNNER_USE_IP`.
- WebDriverAgent's predicates name an element's type `type`, a string such as `XCUIElementTypeButton`, and its identifier `name`; the macOS runner's use XCTest's `elementType` number and `identifier`. The proof's iOS predicates used the macOS names and stopped at "find General by label" with WebDriverAgent listing the attributes it knows. On iOS 26.5, Settings' General row is a button with the identifier `com.apple.settings.general`, and the search field is at the bottom of the list.
- The software keyboard came up with a first-run card about sliding to type, below the field. Typing went in once and read back; the next lane's keyboard handling should expect that card on a new simulator.

### Review rounds

Three reviews of this lane asked for fixes; each fix came with a test that fails on the code before it and passes after. The second round's new tests were also run against a copy of the code before that round (`/tmp/retest-native-before2/`): all failed there except three. The screen stream test covered a check that already existed. The exit-hook kill test ran against a stub, as the old code had no such function. One companion test holds either way.

In the third round, the new session tests failed on the copy before the round (`/tmp/retest-native-before3/`, log `/tmp/retest-native-scratch/session-before.log`). Four existing session tests failed there only because the fake driver's reading now carries command lines. New tests of functions the round added, such as the reading by pid, fail there at import, since those functions did not exist.

A second-opinion review from another model lineage, run by the coordinator on the second round's code, found the same pid reuse window as the third review's finding on unchecked kills, and judged the desktop lock sound otherwise. That lock was the file lock which the kernel lock above replaced in the third round.

### Not verified

1. A clean Mac: the build step was run where the clones, Xcode 26.5 and the iOS runtime already were. Retest fetches no source; cloning the pinned commits is not implemented, and the failure says what to clone.
2. A full macOS window capture with the check in place: Wispr Flow still overlaps TaskDesk on this Mac. The Automation Mode comparison above verified a static region, with a JPEG baseline; the rest of the window and another Mac remain unverified.
3. The keychain on either platform.
4. A crash the app causes itself: both fixtures have no crash switch, so the crash cases end the app's process with SIGKILL from outside.
5. The sweep, the Automation Mode refusal, a live desktop lock holder and a gone holder's recovery on the real system; they ran against the fakes.
6. Cancel after dispatch depends on seeing the app's process before the executor answers the launch; it held in every run here, but it is a race by nature.
7. Two runtimes at once, two simulators of one test, and a second display.
8. Native output redaction is exercised for the known typed values described under Native secret output. Other applications and image or video pixels remain unverified.
9. The cause of the one failed crash-test launch above, and of the one lifecycle proof run where TaskDesk's window was missing from its tree for 5 s.
10. That a start which cannot end its recorded runner keeps the desktop lock: no test makes the end fail, since it ends with SIGKILL; the kept record was shown only for a `ps` that cannot be read.
11. A copy of the app someone starts between the launch blocker's check and the end of the claim window would be taken for the session's own.
12. Whether `/usr/bin/xcodebuild`, an `xcselect` shim, shows the same command line to `ps` once it hands over to the real tool, which the record of xcodebuild relies on. The real runs here recorded and ended it with no mismatch reported, but that was not checked on its own.
13. A runner app left untied by a start killed outright, and the record naming it, on the real runner: shown with the fakes only.
14. The pid reuse window itself: between the last `ps` reading and the signal a pid can still change hands. The check narrows the window to that gap; nothing closes it.
