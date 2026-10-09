# Cross-platform fixture

One local service and three clients that share it: a web front end, TaskDesk for macOS and TaskPhone for iOS. They exist so that one test can create a task on the phone, change that exact task on the web and check it on the desktop. Everything here is original; nothing is copied from another product.

Every object is named by its id. The service assigns each new task an id of the shape `task-` and twelve hex digits, and seeded tasks have fixed ids. Titles repeat on purpose: three seeded tasks are called "Release checklist", two of them in one account, so a test that looks a task up by its title finds the wrong one or several.

The commands below were run on macOS 27.0.1 (26A434) on Apple silicon, with Xcode 26.5 (17F42), Swift 6.3.2, the macOS 26.5 and iOS Simulator 26.5 SDKs, the iOS 26.5 simulator runtime (23F77), Node 24.12.0 and Google Chrome 154.0.8037.93.

| Path | What it is |
| --- | --- |
| `service/` | The service: a Node HTTP server with no dependencies. `server.ts` is the command, `task-service.ts` the routes and guards, `store.ts` the tasks and sync, `accounts.ts` the accounts and sessions, `clients.ts` the client names, `request-log.ts` both request logs |
| `web/` | The web front end the service serves: plain HTML, CSS and JavaScript |
| `shared/` | Swift the apps compile: the launch settings and the HTTP client, which both use, and the window frame, which TaskDesk uses. `shared/checks/main.swift` checks them; the integration test builds and runs it |
| `macos/TaskDesk/` | The macOS app and its Xcode project |
| `ios/TaskPhone/` | The iOS app and its Xcode project |
| `tests/` | Retest tests of the web front end, and the config they run with |

## The service

```sh
node --conditions=retest-source fixtures/cross-platform/service/server.ts [options]
```

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen on `127.0.0.1:<n>`. `0` takes a free port. Default `4310` |
| `--sync-delay-ms <n>` | How long a change takes to reach the other clients. Default `1000` |
| `--broken-sync` | Acknowledge every change and never pass it on to any other client |
| `--broken-sync=<client>` | The same, for sessions of that client only: `web`, `ios`, `macos`, `electron` or `test`. May be given more than once. The name must follow `=` |
| `--broken-sync=<from>:<to>` | Changes made by sessions of the client `<from>` never reach sessions of the client `<to>`; every other change reaches every client after the delay. `web:macos` lets TaskDesk see the phone's task but never the web's change to it. May be given more than once, and not together with the two forms above |
| `--read-delay-ms <n>` | Hold each task read (`GET /api/tasks` and `GET /api/tasks/<id>`) this long before answering, with the tasks as they stood when it arrived, as a slow network would. Default `0` |
| `--state <file>` | Keep the tasks in this JSON file across restarts. Without it the tasks live in memory |
| `--network-log <file>` | Write one JSON line per request to this file, replacing it at start |

The first line on stdout is the address, such as `http://127.0.0.1:4310`. Then comes one line per request. A failure the service survives, such as a file it could not write, is one line on stderr. SIGTERM or SIGINT stops the service with exit 0. A bad option or a state file the service did not write is exit 2, with the reason on stderr.

### Who it answers

- It listens on loopback only, and answers only a request whose `Host` is a loopback name (`127.x.x.x`, `localhost` or `[::1]`); any other gets 403. A page on another name that resolves to this machine cannot use it.
- Every write to `/api/` or `/admin/` (any method but `GET`) must carry `x-task-client` with a known client name, or it gets 403. Reads need no header.
- It sends no CORS headers. A page from another origin can send that header only after a preflight, and the preflight is refused, so another site cannot change the fixture during a run. A browser client must be served from the service's own address.

### Accounts and seeded tasks

These credentials are for this fixture only. The service never logs them.

| Account | Password | Name shown |
| --- | --- | --- |
| `ada` | `ada-fixture-password` | Ada Example |
| `ben` | `ben-fixture-password` | Ben Example |

| Id | Account | Title | State |
| --- | --- | --- | --- |
| `seed-ada-1` | ada | Release checklist | Open |
| `seed-ada-2` | ada | Release checklist | Done |
| `seed-ada-3` | ada | Write the changelog | Open |
| `seed-ben-1` | ben | Release checklist | Open |

An account sees only its own tasks. A task of another account answers 404, the same as one that does not exist.

### Routes

Every body is JSON. Task routes need `Authorization: Bearer <token>` from a sign-in; without it they answer 401.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /`, `/app.js`, `/styles.css` | | The web front end |
| `GET /tasks/<id>` | | The web front end, which opens that task once signed in |
| `GET /api/health` | | `{ status: "ok", syncDelayMs, brokenSync, readDelayMs }`; `brokenSync` is `{ kind: "off" }`, `{ kind: "every-other-client" }`, `{ kind: "clients", clients: [...] }` or `{ kind: "links", links: [{ from, to }, ...] }` |
| `POST /api/sign-in` | `{ account, password }` | 200 `{ token, account: { id, name } }`, or 401. The session belongs to the client its `x-task-client` names |
| `POST /api/sign-out` | | 200, and the token opens nothing afterwards |
| `GET /api/tasks` | | `{ account, tasks }`: the tasks this session can see, oldest first |
| `POST /api/tasks` | `{ title }` | 201 `{ task }` with the id the service assigned. A body with any other key, an id included, is 400 |
| `GET /api/tasks/<id>` | | `{ task }`, or 404 when this session cannot see that id |
| `PATCH /api/tasks/<id>` | `{ title?, done? }` | 200 `{ task }`, or 404 |
| `POST /admin/reset` | | 200 `{ reset: true }`: the seeded tasks and nothing else, and every session signed out |

A task is `{ id, title, done, revision, createdAt, updatedAt }`. A title is one line of 1 to 200 characters, trimmed.

A change is written to the state file before the service holds it. When the file cannot be written the answer is 500, the change did not happen, and stderr says which request failed and why.

### Sync

Each signed-in session is one client. A client sees its own changes at once. Another client sees a change once the sync delay has passed since it was made: before that, a new task answers 404 and is missing from its list, and a changed task shows its earlier revision. A second sign-in of the same account is another client.

Under `--broken-sync` every change is acknowledged with 201 or 200, its maker sees it, and no other client ever does. Under `--broken-sync=macos` the same holds for macOS sessions only: the web and the phone see each other's changes after the delay, and a macOS session sees none of them, not even a task the phone created. Under `--broken-sync=web:macos` only the web's changes miss the macOS sessions: TaskDesk sees the task the phone created after the delay, and keeps showing it as it stood before the web changed it. Which clients a change never reaches is decided when it is made, from the client that made it, and kept in the state file.

A change holds only the fields it sends, applied to the newest state of the task, whoever made it. So when the web marks a task done and the phone renames it before the web's change reached the phone, the task ends up renamed and done, and the phone's answer shows both. A field set by a change that never reaches a client stays hidden from that client under later changes too: under `--broken-sync=web:macos`, when the web marks the phone's task done and the phone then renames it, TaskDesk sees the new name and the task still open, while the web and the phone see it renamed and done. A task whose creation never reaches a client is never seen by it, whatever later changes the other clients make. `revision` is the number of the change a client sees, counting every change the service accepted for the task: 1 is the task as created. A client that has not seen another client's change yet sees a lower number.

The clients ask for the list once a second while signed in, so a change appears on screen up to a second after the delay.

### Request logs

Each request is logged when its answer has gone out, which can be just after the client has read it. Neither log holds a header, a body, a query string or a credential:

- The client comes from the `x-task-client` header, read against the fixed list. Any other value, or none, is written as `unknown`, never as sent.
- The path is the route's own path. A task route keeps its last segment only when it has a task id's shape (`/api/tasks/seed-ada-1`); otherwise it is written as `/api/tasks/unknown` or `/tasks/unknown`. Any path that is no route is written as `unknown`. Text a client puts in a path never reaches a log.
- A method outside `GET`, `HEAD`, `POST`, `PATCH`, `PUT`, `DELETE` and `OPTIONS` is written as `OTHER`.

stdout, one plain line per request:

```text
2026-10-03T18:24:59.337Z GET /api/health 200 1.8ms client=ios
```

The network log, one JSON line per request, as `RequestRecord` in `service/request-log.ts` types it and `parseRequestRecord` reads it back:

```json
{"schemaVersion":1,"type":"http.request","sequence":3,"startedAt":"2026-10-03T18:11:19.120Z","method":"POST","path":"/api/tasks","client":"ios","status":201,"durationMs":0.5,"completed":true}
```

`completed` is false when the connection closed before the whole response was sent. If the network log cannot be written, the service says so once on stderr, keeps answering, and writes no more to it.

### Clean state

A service started without `--state` starts from the seeded tasks with no sessions, and so does one after `POST /admin/reset`. With `--state`, the file keeps the tasks, never a session or a password; a reset reaches the file, so a restart after it starts from the seeded tasks too. Ids are random, so a task from an earlier run never has the id of a new one.

## The web front end

Open the service's address. Sign in, create a task, open a task by its id, change its title and whether it is done, and see every task with its id and state. The sign-in token is kept in the tab's `sessionStorage`, so a new browser context starts signed out. The open task is the page's address, `/tasks/<id>`, and opening that address opens the task once signed in; Retest's `page.url()` reads the id from it. A refresh that was on its way while a create or a save was being made is dropped, so an older list never covers a change just saved.

Test ids, where `<id>` is a task's id:

| Area | Test ids |
| --- | --- |
| Header | `service-status`, `session-bar`, `signed-in-account`, `signed-in-name`, `sign-out` |
| Sign-in | `sign-in-form`, `account`, `password`, `sign-in`, `sign-in-error` |
| New task | `create-form`, `new-task-title`, `create-task`, `create-error`, `created`, `created-task-id` |
| Open by id | `open-form`, `open-task-id`, `open-task`, `open-error` |
| The open task | `editor`, `selected-task-id`, `selected-task-title`, `selected-task-state`, `selected-task-revision`, `edit-form`, `edit-title`, `edit-done`, `save-task`, `close-task`, `save-status`, `save-error` |
| Task list | `task-count`, `list-status` (`Refreshing` while a refresh is on its way, then `Up to date`), `task-table`, `task-list`, `task-row-<id>`, `task-id-<id>`, `task-title-<id>`, `task-state-<id>`, `open-task-<id>` |

A state reads `Open` or `Done`. Creating a task opens it in the editor.

Run the Retest test of the front end against a service started fresh or just reset, since its second test renames a seeded task and a second run would find it renamed already:

```sh
curl -s -X POST -H 'x-task-client: test' http://127.0.0.1:4310/admin/reset
RETEST_CROSS_PLATFORM_PASSWORD=ada-fixture-password node --conditions=retest-source src/cli/main.ts run \
  fixtures/cross-platform/tests/web-tasks.retest.ts \
  --config fixtures/cross-platform/tests/retest.config.ts --base-url http://127.0.0.1:4310
```

`tests/web-save-race.retest.ts` needs a service started with `--read-delay-ms 1500 --sync-delay-ms 0`, and an assertion budget of a few seconds (`--timeouts assertion=5000,action=4000`).

## The apps' shared rules

Both apps read the service's address from the `-serviceURL <url>` launch argument, or else the `RETEST_SERVICE_URL` variable. There is no default.

- Only a loopback address is taken: `127.x.x.x`, `localhost` or `[::1]`. Any other is refused with a message on screen, so neither app reaches into the local network and the system never asks for local network access.
- `-serviceURL` with no address after it is refused; it never falls back to the variable.
- `-reset` alone, or before another flag, asks for a reset; `-reset NO`, `false` or `0` does not.
- A redirect from the service is never followed, so a sign-in is never sent on to another address; the app shows the redirect as an error.
- Requests use an ephemeral URL session with no cache and no cookies, and name the app in `x-task-client` (`macos` or `ios`).
- Each request writes one line to standard output, and nothing else: method, route, status and time, such as `GET /api/tasks/{id} 200 12ms`, or `no answer` in place of the status. A route holds `{id}`, never the id.

## TaskDesk, the macOS app

Bundle id `dev.retest.fixtures.taskdesk`. It signs in, lists the account's tasks with their ids and shows one task's state. It needs macOS 15 or later.

Build, unsigned by any team and signed ad hoc:

```sh
cd fixtures/cross-platform/macos/TaskDesk
xcodebuild build -project TaskDesk.xcodeproj -scheme TaskDesk -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath ~/Library/Caches/retest-proofs/derived/taskdesk COMPILER_INDEX_STORE_ENABLE=NO
```

The app is then `~/Library/Caches/retest-proofs/derived/taskdesk/Build/Products/Debug/TaskDesk.app`.

Its launch arguments:

| Argument | Meaning |
| --- | --- |
| `-serviceURL <url>` | The service's address; a loopback one only. Otherwise the `RETEST_SERVICE_URL` variable is read. See the shared rules above |
| `-reset` | Empty the app's `UserDefaults` domain before anything reads it. `-reset NO` does not |
| `-windowFrame x,y,width,height` | Put the window there at launch: the whole window, title bar included, in screen points with the origin at the top left of the main display, the coordinates the window server reports. At least 640 wide and 460 high, with x and y at least 0. A malformed frame is refused with a line on standard error, and the window opens where it would without one. Absent, nothing changes |

Launch it with the service's address. Either form works:

```sh
open -n --stdout /tmp/taskdesk-requests.log --stderr /tmp/taskdesk-events.log \
  ~/Library/Caches/retest-proofs/derived/taskdesk/Build/Products/Debug/TaskDesk.app \
  --args -reset -serviceURL http://127.0.0.1:4310

RETEST_SERVICE_URL=http://127.0.0.1:4310 \
  ~/Library/Caches/retest-proofs/derived/taskdesk/Build/Products/Debug/TaskDesk.app/Contents/MacOS/TaskDesk
```

`open --env RETEST_SERVICE_URL=…` also works, and `open -g` launches it behind the frontmost app. The scheme's Run action passes `-serviceURL http://127.0.0.1:4310`, for launching from Xcode.

Quit it with SIGTERM (`kill -TERM <pid>`), Command-Q or by closing its window. SIGTERM goes through the app's normal termination and exits with 0.

Its request lines go to standard output: the file `open --stdout` names, or the terminal that started the binary. On standard error it writes one line per lifecycle event and nothing a person typed: `started, service <url>, reset <true|false>`, `window frame refused: <why>`, `window shown`, `window frame asked <x,y,width,height>, now <x,y,width,height>` (the frame the window has once placed), `service answered` or `service did not answer`, `SIGTERM received, quitting`, `terminating`.

Retest's owned log launcher reads TaskDesk's stdout pipe and writes redacted lines to the attempt's `diagnostics/<test>-<attempt>-<app>.jsonl` artifact, naming `macos-stdout` and the owned pid.

To keep the window clear of another app's window, give it a frame, such as near the top left below the menu bar:

```sh
open -n --stdout /tmp/taskdesk-requests.log --stderr /tmp/taskdesk-events.log \
  ~/Library/Caches/retest-proofs/derived/taskdesk/Build/Products/Debug/TaskDesk.app \
  --args -reset -serviceURL http://127.0.0.1:4310 -windowFrame 20,60,700,480
```

Accessibility identifiers, where `<id>` is a task's id. Each value is a text view of its own, inside a container that keeps its children apart:

| Area | Identifiers |
| --- | --- |
| Always | `service-status` |
| Sign-in | `account-field`, `password-field`, `sign-in-button`, `sign-in-error` (only after a failure) |
| Signed in | `signed-in-account`, `sign-out-button`, `task-id-field`, `show-task-button`, `task-count`, `task-list` |
| One task shown by id | `selected-task`, `selected-task-id`, then `selected-task-title`, `selected-task-state`, `selected-task-revision` once the task is visible, or `selected-task-missing` while it is not |
| Each row | `task-row-<id>`, `task-id-<id>`, `task-title-<id>`, `task-state-<id>`, `show-task-<id>` |

A state reads `Open` or `Done`. The shown task follows the list, so it changes on screen when a change arrives from another client.

### Clean state for TaskDesk

Clean means the `UserDefaults` domain `dev.retest.fixtures.taskdesk` holds no keys: `defaults read dev.retest.fixtures.taskdesk` prints `{}` or says the domain does not exist. `-reset` empties the domain at launch, before the app reads it; macOS may then keep an empty 42-byte preferences file for it. The one key the app writes is `lastAccount`, the account last signed in to, offered again in the sign-in form; it is never a password or a token. AppKit may keep its own keys in the same domain, and `-reset` removes those too.

Nothing else the app does is kept. The token lives in memory, so every launch starts signed out. Window restoration is turned off. After repeated launches of the app, these were absent: `~/Library/Saved Application State/dev.retest.fixtures.taskdesk.savedState`, `~/Library/HTTPStorages/dev.retest.fixtures.taskdesk`, `~/Library/Caches/dev.retest.fixtures.taskdesk`, `~/Library/Application Support/dev.retest.fixtures.taskdesk` and `~/Library/Containers/dev.retest.fixtures.taskdesk`. macOS itself wrote a Metal shader cache under `$(getconf DARWIN_USER_CACHE_DIR)dev.retest.fixtures.taskdesk/com.apple.metalfe`; the app never reads it.

### Entitlements and prompts

None chosen. The app has no App Sandbox, no hardened runtime and no capability, so nothing asks for a grant. Its only connection is plain HTTP to the loopback address it is given, which `NSAllowsLocalNetworking` in `TaskDesk/Info.plist` allows. Debug builds carry `com.apple.security.get-task-allow`, which Xcode adds so a debugger can attach.

AppKit reads launch arguments as `-key value` pairs, so in `-reset -serviceURL http://…` the address would be left on its own and opened as a URL at launch, and SwiftUI would then open no window. The app registers `NSTreatUnknownArgumentsAsOpen` as `NO` at launch, in memory only, so `-reset` works anywhere among the arguments.

## TaskPhone, the iOS app

Bundle id `dev.retest.fixtures.taskphone`. It signs in, creates a task from a title and shows the created task's id, title and state. It needs iOS 17 or later and runs on iPhone. It has no asset catalog and no app icon.

Build for the simulator, with no team:

```sh
cd fixtures/cross-platform/ios/TaskPhone
xcodebuild build -project TaskPhone.xcodeproj -scheme TaskPhone -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ~/Library/Caches/retest-proofs/derived/taskphone COMPILER_INDEX_STORE_ENABLE=NO
```

The app is then `~/Library/Caches/retest-proofs/derived/taskphone/Build/Products/Debug-iphonesimulator/TaskPhone.app`, for arm64 and x86_64 simulators. This needs an iOS simulator runtime: `xcrun simctl list runtimes` must list one.

Run it on a simulator of its own, then remove the simulator:

```sh
UDID=$(xcrun simctl create retest-fixtures-taskphone "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" ~/Library/Caches/retest-proofs/derived/taskphone/Build/Products/Debug-iphonesimulator/TaskPhone.app
SIMCTL_CHILD_RETEST_SERVICE_URL=http://127.0.0.1:4310 \
  xcrun simctl launch --stdout=/tmp/taskphone-requests.log "$UDID" dev.retest.fixtures.taskphone
xcrun simctl spawn "$UDID" launchctl list | grep taskphone   # running: its pid and UIKitApplication:dev.retest.fixtures.taskphone
xcrun simctl terminate "$UDID" dev.retest.fixtures.taskphone
xcrun simctl shutdown "$UDID"
xcrun simctl delete "$UDID"
```

`xcrun simctl launch "$UDID" dev.retest.fixtures.taskphone -serviceURL http://127.0.0.1:4310` passes the address as an argument instead. The simulator shares the Mac's loopback, so `127.0.0.1` is the Mac's service. Its request lines go to the file `simctl launch --stdout` names; without it they are not kept.

Retest's owned log launcher reads TaskPhone's stdout through `simctl launch --console` and writes redacted lines to the attempt's `diagnostics/<test>-<attempt>-<app>.jsonl` artifact, naming `simctl-stdout` and the owned pid.

Accessibility identifiers. Each value is a text view of its own, inside a container that keeps its children apart:

| Area | Identifiers |
| --- | --- |
| Always | `service-status` |
| Sign-in | `account-field`, `password-field`, `sign-in-button`, `sign-in-error` (only after a failure) |
| Signed in | `signed-in-account`, `sign-out-button`, `new-task-title-field`, `create-task-button`, `create-error` (only after a failure) |
| The created task | `created-task-id`, `created-task-title`, `created-task-state` |

The account field has no automatic capitals or corrections. A create is sent once; a failure is shown, not repeated.

### Clean state for TaskPhone

The app keeps nothing of its own: no defaults, no keychain item, no file. The token lives in memory, so every launch starts signed out. Relaunching keeps the app's data container, where iOS itself writes scene-session state (`Library/Saved Application State`) and launch snapshots (`Library/SplashBoard`); `Library/Preferences` stayed empty. A clean state is a new or erased simulator, or `xcrun simctl uninstall` followed by `install`.

The same `NSAllowsLocalNetworking` key is in `TaskPhone/Info.plist`. No entitlement is chosen.
