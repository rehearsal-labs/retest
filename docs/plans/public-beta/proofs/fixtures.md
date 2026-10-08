# Cross-platform fixture apps: one service, a web front end, TaskDesk and TaskPhone

Item 4 of the Phase 2 section of [release-0.1.0.md](../release-0.1.0.md), recorded 3 October 2026, revised the same day after review, and extended with TaskDesk's `-windowFrame` argument. It builds the original fixture the reference flow runs against: a local service, a web front end it serves, a native macOS app and a native iOS app, all sharing the service. How to start and build each part, the accounts, the identifiers and what clean state means are in [fixtures/cross-platform/README.md](../../../../fixtures/cross-platform/README.md). Nothing is copied from Rehearsal or any other product.

## Result

| Part | Status | Evidence |
| --- | --- | --- |
| Service: sign-in, tasks by server-assigned id, sync delay, broken sync for every client or one, merged changes, reset, state file, both request logs, loopback and client-header guards | Passed: 13 tests that start it as its own process | `tests/integration/cross-platform-service.test.ts` |
| The Swift the apps compile | Passed: 38 checks of the settings, the client and the window frame, built with `xcrun swiftc` and run against the service and a redirecting server | The same file |
| Web front end, driven by Retest on real Chrome | Passed: 2 tests of create, read and change by id, and 1 of a save made during a slow refresh | The last two tests in the same file |
| TaskDesk (macOS): build, launch with the service address, place its window, quit | Built ad hoc with no team; launched sixteen times; its health request reaches the service as `client=macos` and appears on its own stdout; `-windowFrame 20,60,700,480` put the window at exactly that frame, as the window server reports it; quits on SIGTERM; nothing left running | "TaskDesk" and "Window frame" below |
| TaskPhone (iOS simulator): build, install, launch, terminate | Built for the simulator; installed and launched on simulators created for the purpose, which were then shut down and deleted; its health request reaches the service as `client=ios` and appears in the `--stdout` file | "TaskPhone" below |

No app was driven: no executor, no automation, no typing. The apps were launched, observed through their own log lines, the service's logs, `ps`, the window list and `simctl`, and quit.

## Machine

macOS 27.0.1 (26A434) on Apple silicon, Xcode 26.5 (17F42) at the default path, Swift 6.3.2, SDKs macOS 26.5 and iOS Simulator 26.5, Node 24.12.0, TypeScript 6.0.3 and 7.0.2, Google Chrome 154.0.8037.93. When this lane started, `xcrun simctl list runtimes` listed no runtime. By the first iOS build it listed iOS 26.5 (23F77), Ready, 7.9 GB, installed by the founder's download.

## What was built

- `fixtures/cross-platform/service/`: `server.ts` is the command; `task-service.ts` holds the routes, the guards and the read delay, and serves `web/`; `store.ts` keeps each task's history of changes and writes the state file before memory takes a change; `accounts.ts` holds the two seeded accounts and the sessions, each tied to the client that signed in; `clients.ts` the client names; `request-log.ts` types both logs, turns a request target into a logged path and reads a network log line back (`parseRequestRecord`).
- `fixtures/cross-platform/web/`: `index.html`, `app.js` and `styles.css`, no framework. Rows are updated in place by id; the open task is the page's address, `/tasks/<id>`; a refresh that overlapped a create or a save is dropped.
- `fixtures/cross-platform/shared/`: `ServiceSettings.swift` and `TaskServiceClient.swift`, which both Xcode projects compile; `WindowFrame.swift`, which only TaskDesk compiles; and `checks/main.swift`, which the integration test builds with all three.
- `fixtures/cross-platform/macos/TaskDesk/`: the SwiftUI app, `TaskDesk.xcodeproj` with a shared scheme, `Info.plist` holding only `NSAllowsLocalNetworking`.
- `fixtures/cross-platform/ios/TaskPhone/`: the SwiftUI app, `TaskPhone.xcodeproj` with a shared scheme, the same `Info.plist` key. No asset catalog, no icon.
- `fixtures/cross-platform/tests/`: `web-tasks.retest.ts`, `web-save-race.retest.ts` and the unregistered `retest.config.ts` they run with. The password is the secret `password`, read from `RETEST_CROSS_PLATFORM_PASSWORD`.
- `tests/integration/cross-platform-service.test.ts`: 16 tests, each with its own time limit, and every wait inside bounded with a message that names what did not happen.

Both Xcode projects were written by hand in the Xcode 16 format (`objectVersion = 77`) with explicit file references, Swift 6 language mode, `CODE_SIGN_IDENTITY = "-"`, `CODE_SIGN_STYLE = Manual` and an empty `DEVELOPMENT_TEAM`.

## Decisions

- A session is a client for sync, and belongs to the client its sign-in named in `x-task-client`. A second sign-in of the same account waits for the delay like any other client. Each change carries the session that made it, the time from which others see it, and which clients it never reaches; the state file records the session's id, never its token.
- `--broken-sync=<client>` hides every change made while it is on from that client's sessions, as the review asked: under `--broken-sync=macos` the macOS app sees neither the phone's task nor the web's change, so the reference flow fails at its macOS check on a missing task rather than on a stale state.
- A change applies only the fields it sends, to the newest state of the task, so its answer can carry another client's change the writer had not seen yet. `revision` numbers the change a client sees among all the changes accepted for the task.
- Tasks belong to an account, and another account's task answers 404, as one that does not exist or has not synced yet does.
- Ids are random, `task-` and twelve hex digits, so a second run never finds an earlier run's task under a new id. Seeded ids are fixed (`seed-ada-1` and so on), and three seeded tasks share a title.
- The clients ask for the task list once a second while signed in. A change from another client then shows without the test pressing anything, so a test waits with assertions and never repeats an action.
- Retest has no read of an element's text, so the web test takes the new task's id from the page's address, which the page sets to `/tasks/<id>`, and checks that both places on the page show that id.
- No default service address in the apps, and only a loopback one: without one they say so.
- Entitlements: none. No App Sandbox, which would need the network client entitlement and protects nothing in a fixture; no hardened runtime; no capability. Debug builds carry `com.apple.security.get-task-allow`, which Xcode adds. Plain HTTP to the given address is allowed by `NSAllowsLocalNetworking`.
- The service answers only a loopback `Host`, takes a write to the API only with a known `x-task-client`, and sends no CORS headers, so another site's page in a browser on the same machine cannot change the fixture.
- The client name in both logs comes from a fixed list (`web`, `ios`, `macos`, `electron`, `test`), and the path is the route's template, so neither a header nor a path a client chose is ever written as sent. `electron` is there for the Electron fixture on the same service.

## The review and its fixes

Each fix came with a test. To show each test fails without its fix, the new test file was run once against the code as it was reviewed (service, page and shared Swift copied back from a snapshot in `/tmp`, then restored and compared byte for byte): 7 passed, 9 failed (`fixtures-review-before-full.log`). The save race was shown on the new service with the page not yet sequenced, three runs out of three (`fixtures-review-before-race-1.log` to `-3.log`).

| Item | Fix | Test, and how it failed on the reviewed code |
| --- | --- | --- |
| 1 Broken sync for one client | `--broken-sync=<client>`, repeatable; the bare flag still breaks every other client; an unknown name or a name after a space is exit 2 | "breaks sync for one client only": the service refused `--broken-sync=macos` |
| 2 The list route | The sync-delay and broken-sync tests read `GET /api/tasks` as well as `GET /api/tasks/<id>`, before, during and after the delay | Both passed on the reviewed code: the list and the read agreed there |
| 3 A partial change wrote back stale fields | Only the fields sent, applied to the newest state | "applies only the fields a change holds": the phone's rename set `done` back to false |
| 4 Unbounded waits | Every start, stop, answer and child exit has a limit and a message; every test has a time limit | Not a behaviour; checked by reading the file |
| 5 Reset and the state file | A test that changes a seeded task, resets, restarts with `--state` and sees the seeded tasks; the reset test now checks its change was accepted | Passed on the reviewed code: reset already wrote the file |
| 6 The Swift settings and client | Loopback hosts only; `-serviceURL` with no value refused; `-reset NO` honoured; redirects not followed | "the Swift both apps compile…": 10 of 23 checks failed, among them `-reset NO` resetting, five non-loopback addresses taken, and both redirects followed with the sign-in sent on |
| 7 The web test's id | The test reads the id from the address and checks `created-task-id`, `selected-task-id` and the row against it; the integration test checks the parent's looks at both places are equal; the README says to start fresh or reset before the hand-run command | The Retest test failed: the reviewed page did not put the id in its address |
| 8 Service errors | The state file is written before memory takes a change, and a failure is 500 with a line on stderr; a network log that cannot be written is said once on stderr and dropped | "a change the state file cannot keep": the reviewed service answered 500 and kept the change. "keeps answering when the network log cannot be written": the reviewed service crashed on the next request |
| 9 The page's save race | A refresh that overlapped a write is dropped | "a save made while the list refreshes": `selected-task-state` read "Open" after the save, three runs out of three |
| 10 Credentials in paths | Logged paths are route templates; a task route keeps a segment only of a task id's shape; anything else is `unknown` | The log test: the reviewed service logged a password sent in a path |
| 11 Other sites | Loopback `Host` only; a known `x-task-client` on every API write; no CORS headers | "takes a write only from a named client…": the reviewed service took a reset with no header |
| 12 `LabeledContent` | Plain text views with their own identifiers, in containers marked `.accessibilityElement(children: .contain)` | No test: no executor read either app's tree in this lane. Not confirmed |
| 13 The record | Breaks repeated on the final test file, line references dropped, the unlocked `tsc` run noted, claims narrowed to what the logs show | This document |

Also from the review: both apps write one plain line per request to standard output (method, route, status, time). Seen on TaskDesk's stdout through `open --stdout` and on TaskPhone's through `simctl launch --stdout`, and checked line by line by the Swift checks.

### Deliberate breaks on the final test file

Sixteen one-line breaks, each applied alone, run against the test it should trip, undone and compared byte for byte (`fixtures-review-breaks-summary.log`, `fixtures-review-break-01.log` to `-16.log`). Every one made its test fail:

| Break | Failed at |
| --- | --- |
| No sync delay | "another session does not see it yet" |
| Broken sync ignored | "the created task never reaches the other session" |
| Broken sync for one client ignored | "the desktop never sees the task" |
| A change merged onto the writer's stale view | "the phone's rename keeps the web's done, which it never sent" |
| Every new task given the same id | "two tasks with one title get two ids" |
| A task read without checking its account | "ada cannot read ben's task" |
| Reset does nothing | both reset tests, at the seeded list |
| Memory changed before the state file | "the change did not happen" |
| The path logged as sent | the log test's list of records |
| A write taken without the client header | "POST /admin/reset with no client header" |
| Any `Host` taken | "the page for Host evil.example" |
| A network log failure thrown | the next request got no answer |
| The page never shows Done | `selected-task-state` at `web-tasks.retest.ts` line 29, "Open" for "Done" |
| An older list put over a save | `selected-task-state` at `web-save-race.retest.ts` line 24, "Open" for "Done" |
| Redirects followed by the Swift client | the redirected health check answered 200 |
| Any host taken by the Swift settings | the non-loopback address checks |

The first version of this lane ran four breaks on an earlier test file (sync delay, broken sync, query kept in logged paths, the page never showing Done); those were superseded by these.

## Commands, results and logs

Logs are in `~/Library/Caches/retest-proofs/logs/`, screenshots in `~/Library/Caches/retest-proofs/artifacts/fixtures/`.

### Service, Swift checks and web front end

1. `node --conditions=retest-source --test tests/integration/cross-platform-service.test.ts` on the final code: 16 of 16 passed, three runs in a row (`fixtures-review-after-full.log` is the third). The tests:
   - sign-in accepts each account's own password only, refuses malformed bodies with 400, and the task routes answer 401 without a session and after sign-out; SIGTERM stops the service with exit 0;
   - ids are assigned by the service and differ for two tasks with one title; a body naming an id is 400; reads and changes go by id; another account's task is 404 by id and missing from the list;
   - with `--sync-delay-ms 800`, another session did not see a new task at once or halfway through, by id or in its list, and first listed it at least 800 ms after it was sent; a change came back to the first session the same way;
   - with `--broken-sync`, a create and a change were acknowledged, their maker saw them, and the other session saw neither, by id or in its list, for 1.5 s, fifteen times the delay;
   - with `--broken-sync=macos`, the web saw the phone's task and the phone saw the web's change, while a macOS session saw neither for 1.5 s and saw its own task; `--broken-sync=nosuch` and `--broken-sync macos` are exit 2;
   - two sessions changing one task inside an 800 ms delay ended with both changes, revision 3, for both;
   - reset put back exactly the seeded tasks and ended every session, and after a reset with `--state` a restart starts from the seeded tasks;
   - `--state` kept a task across a restart without a token or password in the file; without `--state` it was gone; a file the service did not write is exit 2;
   - with the state folder made read-only, a change, a create and a reset each answered 500, none happened, sessions stayed, stderr named each failed request with `EACCES`, and the service worked again once the folder was writable;
   - thirteen requests gave thirteen network log records and stdout lines with the expected method, logged path, status and client; a password sent in three different paths was logged as `unknown`, `/api/tasks/unknown` and `/tasks/unknown`; neither log nor stderr held either password, a wrong password, either token, the title, a query value, `Bearer`, `authorization` or a header value outside the list;
   - with the network log made read-only, the service answered five more requests, said so once on stderr, kept the one line it had and printed every request on stdout;
   - writes with no or an unknown `x-task-client` were refused with 403 and changed nothing; `Host: evil.example` and two others were refused; loopback names were answered; a preflight got no `access-control-` header;
   - the Swift checks, built with `xcrun swiftc -swift-version 6`: 38 passed (24 before the window frame was added); the client wrote eight request lines in order; the redirecting server was asked twice and the service saw one sign-in, the direct one; the password was not in the output;
   - Retest on real Chrome, `web-tasks.retest.ts`: 2 passed; the parent's last looks at `created-task-id` and `selected-task-id` gave the same id, the page's address held `/tasks/<id>`, and the service then held that id done at revision 2; `seed-ada-1` changed and `seed-ada-2`, its namesake, did not; both fills recorded the secret by name, and the password is in no file of the run and in neither Retest's output nor the service's logs;
   - Retest on real Chrome, `web-save-race.retest.ts` against `--read-delay-ms 1500`: passed, and the service held the save.
2. The hand-run command from the README, in the first version of this lane, against a fresh service: 2 passed, 16 checks, exit 0 (`fixtures-web-retest-run.log`).

### TaskDesk

3. `xcodebuild build -project TaskDesk.xcodeproj -scheme TaskDesk -configuration Debug -destination 'platform=macOS' -derivedDataPath ~/Library/Caches/retest-proofs/derived/taskdesk COMPILER_INDEX_STORE_ENABLE=NO`: `** BUILD SUCCEEDED **`, exit 0, on each build, the last after the review (`fixtures-taskdesk-build.log`, `fixtures-taskdesk-build-2.log`), with no warning but App Intents metadata extraction being skipped. `codesign -dv`: `Signature=adhoc`, `TeamIdentifier=not set`, arm64. Entitlements: only `get-task-allow`.
4. Launches, each against a service started with `--port 0`, each quit with `kill -TERM <pid>` and checked with `ps` and `pgrep` afterwards. Every launch log ends with the app's own `SIGTERM received, quitting` and `terminating`, the process was gone within the ten seconds each script waited, and `pgrep -lf TaskDesk` found nothing afterwards. The exit status was seen only for launches 1 and 9, children of the shell: 0. The app's lines are in `fixtures-taskdesk-launch-<n>.log`; the service for launches 3 to 9 logged to `fixtures-taskdesk-launch-service.log` and `fixtures-taskdesk-launch-network.jsonl`, whose first record, `client=unknown`, is a check by hand with `curl`.

| Launch | How | Arguments | Result |
| --- | --- | --- | --- |
| 1 | binary as a child of the shell | `-reset -serviceURL <address>` | Ran 21 s with no window and no request |
| 2 | `open -n -g` | `-reset -serviceURL` with no address (a mistake in the script) | Window shown; "service not set" |
| 3 | `open -n -g` | `-reset -serviceURL <address>` | No window after 33 s. `sample`: main thread idle in the event loop. Window list: four 1728x33 menu-bar windows only |
| 4 | `open -n` | the same | No window after 33 s |
| 5 | `open -n -g` | `-serviceURL <address> -reset YES` | Window at once, `GET /api/health 200 client=macos` |
| 6 | `open -n -g` | `-NSTreatUnknownArgumentsAsOpen NO -reset -serviceURL <address>` | Window at once, health requested |
| 7 | `open -n -g`, rebuilt | `-reset -serviceURL <address>` | Window 822x562 points, health requested |
| 8 | `open -n -g --env RETEST_SERVICE_URL=<address>` | none | Window 822x560, health requested, "reset false" |
| 9 | binary as a child of the shell | `-serviceURL <address>` | Window 820x560, health requested; exit 0 |
| 10, 11 | `open -n -g` | `-serviceURL http://127.0.0.1:9`, then the same with `-reset` | The `UserDefaults` check below |
| 12 | `open -n`, in front | `-reset -serviceURL <address>` | Window 820x560, on screen, health requested |
| 13 | `open -n -g`, after the review, stdout and stderr in separate files | `-reset -serviceURL <address>` | Window 820x560, health requested; stdout held `GET /api/health 200 10ms` and nothing else (`fixtures-taskdesk-review-*.log`) |

Launches 1, 3 and 4 failed for one reason: AppKit reads launch arguments as `-key value` pairs, so `-reset` took `-serviceURL` as its value and the address was left on its own, which AppKit opens as a URL at launch, and SwiftUI then opened no window. Launches 5 and 6 confirmed it. The app now registers `NSTreatUnknownArgumentsAsOpen` as `NO` at launch, in memory only, and launches 7, 9, 12 and 13 show a lone `-reset` and a plain `-serviceURL` working. Launch 1 had looked like the shell's sandbox blocking the window server; launch 9 shows a child of the same shell opens its window.

Windows were read with a small Swift program in `/tmp` calling `CGWindowListCopyWindowInfo` for owner, layer, bounds and on-screen state, never titles or pixels. Launched behind other apps or not activated, the window list called the window not on screen; launch 12, in front, called it on screen.

5. `UserDefaults` and `-reset`, without typing into the app: `defaults write dev.retest.fixtures.taskdesk lastAccount ada`; launch 10 without `-reset` left `lastAccount = ada`; launch 11 with `-reset` left the domain empty (`defaults read` printed `{}`), with a 42-byte empty plist. The seeded domain and that file were then removed. After the review's runs an empty 42-byte plist was there again, dated before launch 13, so from an earlier `-reset` launch; the domain holds no keys and it was left in place.
6. After all launches, absent: `Saved Application State/dev.retest.fixtures.taskdesk.savedState`, and the `HTTPStorages`, `Caches`, `Application Support` and `Containers` entries for the bundle id. Present: the empty preferences plist above, and `$(getconf DARWIN_USER_CACHE_DIR)dev.retest.fixtures.taskdesk/com.apple.metalfe`, a shader cache macOS writes for an app that draws.

### Window frame

Until 9 October 2026 the native lane refused a capture of TaskDesk's window while another process's window lay over it, and on this Mac an always-on-top window of another app covers the centre of the screen; the capture now takes the window's own image by its number, and a click still refuses over another window. TaskDesk now takes `-windowFrame x,y,width,height`: the whole window, title bar included, in screen points with the origin at the top left of the main display, the coordinate system `CGWindowListCopyWindowInfo` reports bounds in. `shared/WindowFrame.swift` reads it; a small `NSView` in `DeskView.swift` sets the window's frame once, when it first joins the window, converting to AppKit's bottom-left origin against the main display, and writes the frame the window then has. The minimum is 640x460, the content's 640x420 and a title bar. A malformed value is refused with a line on standard error and the window opens where it would without one; absent, nothing changes. No control was added.

1. `xcodebuild build … -derivedDataPath ~/Library/Caches/retest-proofs/derived/taskdesk …` as in "TaskDesk" above: `** BUILD SUCCEEDED **`, exit 0, no warning but the App Intents note (`fixtures-taskdesk-build-3.log`).
2. The Swift checks gained 14 cases: absent, a plain frame, decimals with spaces, no value, a flag in place of a value, and nine malformed values (three or five numbers, a letter, width 0, height 100, a negative x, `nan`, `inf`, empty). `node --conditions=retest-source --test --test-name-pattern "Swift the apps compile" tests/integration/cross-platform-service.test.ts`: passed, 38 checks (`fixtures-frame-swift-test.log`). With the size guard removed, the same test failed at `-windowFrame "20,60,0,480" is refused` and `-windowFrame "20,60,700,100" is refused`; the file was then restored and compared (`fixtures-frame-break.log`).
3. Three launches against one service on `--port 0`, each quit with `kill -TERM <pid>`, each followed by `SIGTERM received, quitting` and `terminating`, the process gone within the wait and `pgrep` empty afterwards. The window was read with the same `/tmp` program over `CGWindowListCopyWindowInfo`: owner, layer, bounds and on-screen state, no title, no pixels. No `osascript` was used, since asking System Events for a window's position needs an automation grant.

| Launch | How | Arguments | Window server | The app's line |
| --- | --- | --- | --- | --- |
| 14 | `open -n -g` | `-reset -serviceURL <address> -windowFrame 20,60,700,480` | 700x480 at 20,60, not on screen (launched behind) | `window frame asked 20,60,700,480, now 20,60,700,480` |
| 15 | `open -n`, in front | the same | 700x480 at 20,60, on screen | the same |
| 16 | `open -n -g` | `-reset -serviceURL <address> -windowFrame 20,60,700` | 820x560 at 454,266, the default | `window frame refused: -windowFrame takes four numbers, x,y,width,height, such as -windowFrame 20,60,700,480, not 20,60,700.` |

Logs: `fixtures-taskdesk-frame-stderr.log` and `-stdout.log` for launch 14, `fixtures-taskdesk-frame-front-*.log` and `fixtures-taskdesk-frame-malformed-*.log` for 15 and 16, the service in `fixtures-taskdesk-frame-service.log` (three `GET /api/health 200 client=macos`). Each launch's stdout held only its health request line. Afterwards the `UserDefaults` domain still held no keys.

Whether anything lies over 20,60 to 720,540 on this Mac was not read: listing other apps' windows is the native lane's check.

4. The whole test file again: 16 of 16 (`fixtures-frame-full.log`). This lane's files on TypeScript 6.0.3 and 7.0.2 under the lock: both exit 0 (`fixtures-frame-typecheck.log`). The full integration suite was not rerun after this addition; its last run is item 14 under "Gates".

### TaskPhone

7. `xcodebuild build -project TaskPhone.xcodeproj -scheme TaskPhone -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/Library/Caches/retest-proofs/derived/taskphone COMPILER_INDEX_STORE_ENABLE=NO`: `** BUILD SUCCEEDED **`, exit 0, before and after the review (`fixtures-taskphone-build-generic.log`, `fixtures-taskphone-build-2.log`). No asset catalog step appears in either log. The app is arm64 and x86_64, `vtool` reads platform `IOSSIMULATOR`, minos 17.0, SDK 26.5; `Signature=adhoc`, no team.
8. Whether leaving out the asset catalog was needed: in a scratch copy under `/tmp` with an empty `Assets.xcassets` and an `AppIcon` set added, the same build ran `CompileAssetCatalogVariant thinned`, the step that failed for WebDriverAgent in Phase 1, and succeeded (`fixtures-taskphone-build-with-asset-catalog.log`). With the runtime installed the catalog is not a problem. Whether leaving it out gets past a missing runtime was not tested: the runtime was installed before the first iOS build. The checked-in app keeps no catalog.
9. On a simulator of its own, before the review (`fixtures-taskphone-service.log`, `fixtures-taskphone-network.jsonl`, `fixtures-taskphone-boot.log`):
   - `xcrun simctl create retest-fixtures-taskphone "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5` printed `EBCF564B-CCBE-48D0-968E-4CB0FDABAB7D`; `xcrun simctl bootstatus <udid> -b` exit 0 after 26 s; `xcrun simctl install` exit 0, and `simctl listapps` lists `dev.retest.fixtures.taskphone` as a user app.
   - `SIMCTL_CHILD_RETEST_SERVICE_URL=<address> xcrun simctl launch <udid> dev.retest.fixtures.taskphone`: pid 64112, exit 0; `xcrun simctl spawn <udid> launchctl list` showed it as `UIKitApplication:dev.retest.fixtures.taskphone`; the service logged `GET /api/health 200 client=ios`; screenshot `taskphone-launched-env.png` (1206x2622) shows "Connected to http://127.0.0.1:65500" above the sign-in form.
   - `terminate` exit 0 and no longer listed; a second launch with `-serviceURL <address>`, pid 65052, health requested again, screenshot `taskphone-launched-argument.png`. Its data container then held `Library/Saved Application State/dev.retest.fixtures.taskphone.savedState` and `Library/SplashBoard/Snapshots`, written by iOS, and an empty `Library/Preferences`. Terminated, exit 0.
   - `shutdown` and `delete` exit 0; the device is gone from `simctl list devices` and from `~/Library/Developer/CoreSimulator/Devices/`.
10. After the review, the same cycle once more on a new simulator, `B8ABB808-3183-4EA3-8B30-7BF9D5A820BC`, with `xcrun simctl launch --stdout=<file>`: pid 56098, running per `launchctl list`, the service logged `client=ios`, and the file held `GET /api/health 200 14ms` and nothing else; screenshot `taskphone-review-launched.png`; terminate, shutdown and delete all exit 0 (`fixtures-taskphone-review-*.log`). No other simulator was touched.

### Gates

11. Typecheck of this lane's files on both compilers, with a configuration in `/tmp` that extends the root `tsconfig.json` and includes `fixtures/cross-platform/**/*.ts` and the test: TypeScript 6.0.3 exit 0 and 7.0.2 exit 0 under the lock, in the first version (`fixtures-typecheck-lane.log`) and after the review (`fixtures-review-typecheck.log`); on 6.0.3 after each change in between, without the lock, as it checks only these files.
12. One root `node_modules/typescript/bin/tsc -p tsconfig.json` was run early in the first version without the lock, against the rules for a heavy gate. Every later full gate went through the lock.
13. `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`: in the first version, exit 2 with 7 errors, all in `src/cli/doctor/checks.ts` and `src/runner/fingerprint.ts` (`LoadedElectronTarget` has no `channel` or `headless`), files of the Electron lane, none in this lane's files (`fixtures-typecheck.log`). After the review, exit 0: TypeScript 6.0.3, then 7.0.2, then the example project, on the tree as it stood with the other lanes' changes (`fixtures-review-typecheck.log`).
14. `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration`: in the first version, exit 0, 402 tests, 400 passed, 2 skipped (the live AI provider gates, no keys set) (`fixtures-test-integration.log`). After the review, on the tree as it stood with the other lanes' changes, after one wait for the lock: exit 0; 430 tests, 428 passed, 0 failed, 2 skipped (the same two provider gates), in 732 s. All sixteen tests of `cross-platform-service.test.ts` passed inside it, the Swift checks included (`fixtures-review-test-integration.log`).

### A test cleanup fault found on the way

Running the new file against the reviewed code left one service running: the state-write test failed while its folder was read-only, the scratch folder's removal then failed in a cleanup hook, and the hook that kills the service did not run. That service, started by the test, was killed by hand. The test now restores the folder's permissions inside its own body, in a `finally`, before any hook runs; the network log test does the same.

## After the Phase 2 review

Recorded on 5 October 2026 on the tree with Phase 3 uncommitted on top of `b59eed5`. The "16 of 16" above predates commit `9b38691`. Since that commit a destructive signal needs this process's own launch record, so each test that started the service failed in its after hook ("has no recorded launch ownership in this process") and left its service running.

- **Ending the service.** `tests/integration/service-teardown.ts` ends a service the test started on every path: one still running gets SIGKILL through its own `ChildProcess` handle, which Node never sends to a pid it has reaped, and the test waits for its exit. Any process of its group still there afterwards fails the test by name. `cross-platform-service.test.ts`, `electron-web-flow.test.ts` and `native-diagnostics-wired.test.ts` use it.
- **A hidden change no longer rides on a later one.** Under `--broken-sync=web:macos`, a phone change merged onto the web's `done` carried that `done` to TaskDesk, and the service's own test asserted it. Each stored change now also records the fields it set itself. A client reads each field from the newest change it may see that set it and is not hidden from it, so TaskDesk sees the phone's rename with the task still open while the web and the phone see it renamed and done. A change only waiting out its delay is not hidden, so the merge inside the delay that the README describes is unchanged. A task whose creation is hidden from a client is never seen by it. The state file keeps the new field; a file written before it reads as before. That test now asserts the closed form, and also that a task the web created never reaches the desktop after the phone changes it. The README says what the code does.

| Command | Result |
| --- | --- |
| `node --conditions=retest-source --test tests/unit/cross-platform-store.test.ts` (new) | 4 passed (`/tmp/retest-lane-c-t13-on.log`); with the store from `HEAD`, 3 failed and the delayed-merge case passed (`/tmp/retest-lane-c-t13-off.log`) |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/cross-platform-service.test.ts` | 17 of 17 passed, nothing left running (`/tmp/retest-lane-c-int-cross-platform-service-4.log`) |

## Not verified

1. That an executor sees the accessibility identifiers as written, the `LabeledContent` replacement included; no executor read either app's tree in this lane. Nor that a capture of the window placed with `-windowFrame` is clear of other windows on this Mac. On iOS, WebDriverAgent's `accessibility id` also matches a label when the identifier is empty (see [native.md](native.md)).
2. Signing in, listing, creating or showing a task in either native app. Nothing was typed into them, so those screens and the `lastAccount` write have not run. The Swift client's routes ran in the Swift checks, a command-line program built from the same files, not inside the apps.
3. The apps with the software keyboard, alerts or a slow service.
4. Whether leaving out the asset catalog gets past a missing iOS runtime; the runtime arrived first.
5. The screen itself: nothing the apps do needs a permission grant, but nobody watched for dialogs.
6. A Release build of either app, an Intel Mac, another macOS, Xcode or iOS version.
