# Reference flow: create on iOS, change on the web, verify on macOS

One Retest test on three apps, run through Retest's CLI on real targets: TaskPhone on an iOS 26.5 simulator, the cross-platform fixture's web front end in Chrome, and TaskDesk on this Mac, all on one fixture service. The task is created on the phone, marked done on the web and seen done on the desk, followed throughout by the id the service gave it. The same test file fails at the desk's state check when the service never passes the web's changes to macOS clients. Both runs passed as written on 4 October 2026, on the tree of that day; see the end of the verification paragraph for the rerun in the review fix round, which this Mac could not complete.

| File | What it holds |
| --- | --- |
| `fixtures/cross-platform/tests/reference-flow.retest.ts` | The test: one body on `phone`, `web` and `desk` |
| `tests/integration/reference-flow.test.ts` | Starts the service, writes the config, runs the test through the CLI twice (working sync, then `--broken-sync=web:macos`) and checks the events, the result, the service's network log and what is left running |
| `fixtures/cross-platform/service/{server,store,task-service}.ts` | The `--broken-sync=<from>:<to>` form, documented in `fixtures/cross-platform/README.md` and tested in `tests/integration/cross-platform-service.test.ts` |

The test file uses the named-app API (`{ apps: ['phone', 'web', 'desk'] }` with `NativePage<'ios-simulator'>`, `Page` and `NativePage<'macos'>`). The repository registers no config for its own TypeScript program, so the file types `test` with that three-app signature, as the other native fixture files do. It needs no hosted account: the service, the apps and the password are local, and the password reaches the apps only through `secret('password')`, with `secretOrigins` naming `dev.retest.fixtures.taskphone` and `dev.retest.fixtures.taskdesk`. The web's origin is its base URL's.

## The flow

1. Phone: sign in as `ada` with the secret, create a task titled `Release checklist <8 hex digits>`, check `created-task-id` has an assigned id's shape, then the title and `Open`. Seeded tasks share the title `Release checklist`, so the title is only asserted on.
2. Web: sign in with the secret. Wait for the one row whose test id starts with `task-row-task-`: seeded ids start with `seed-`, so in a fresh account that row is the phone's task, and it appears only once the sync delay has passed. Open it, read the id from the address, and check the phone shows that same id in `created-task-id`. Then open `/tasks/<id>` and check id, title and `Open` by id.
3. Desk: sign in with the secret, type the id into `task-id-field`, show it, and check `selected-task-id`, `selected-task-title` and `task-state-<id>` reads `Open`.
4. Web: tick done, save, check `Saved revision 2.` and `Done`.
5. Desk: `task-state-<id>` reads `Done`, then `selected-task-state` reads `Done`.

Every wait for another client's change is an ordinary assertion poll; the test has no sleep. The desk opens the task before the web changes it, so its last check is made right after the save and has to wait through the sync delay. With the order the brief gives (desk signs in after the save), the desk's sign-in alone could outlast the delay and the check would never wait.

Why the web reads the id: the public API gives a test no way to read text from a native element. Assertions do not return what they saw, and only a web page's `url()` and `title()` return text. So the id travels from the phone to the web as a fact the web finds and the phone must confirm, rather than as text the test copies off the phone's screen. Identity still holds: the web opens the only task with an assigned id, the phone's own check of `created-task-id` must equal that id, the web's title check must equal the title typed on the phone, and the service's log shows exactly one task created, by the phone. Reading the id off the phone directly needs a text read on `NativeLocator`; see the end of this record.

## Broken sync

`--broken-sync=macos` hides every change from macOS clients, the phone's task included, so the desk would fail on a missing task. The new form `--broken-sync=web:macos` hides only changes made by web sessions from macOS sessions, decided when each change is made and kept with it. The desk then sees the phone's task as `Open` and never the web's `Done`. The service test shows the desk seeing the phone's task, never the web's change over fifteen times the delay, a desktop session signed in later kept from it too, and a later phone change reaching the desk. It also shows malformed forms and mixing with the other two forms refused with exit 2. A deliberate break of the rule (hiding the link's target from every maker) was caught by that test.

## What the runs showed

Final runs, both from `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/reference-flow.test.ts`: 2 of 2 passed (`/tmp/retest-reference-flow-2.log`). Those runs were on the tree before the founder's process-ownership change; the runs recorded in the native diagnostics record afterwards failed in the CLI harness's cleanup, and no rerun after the harness fix passed. In the review fix round the file ran again under the lock (`/tmp/fix-runner-int-native-1.log`): both tests ended `not_run` with `setup_failed`, "xcodebuild ended the executor before it served requests", because sandboxed macOS apps cannot start on this Mac until it is restarted. The phone and web parts could not run alone, since the test holds all three apps before it acts. So the flow, and its broken-sync variant, wait for that restart; nothing here says they pass on the current tree. The teardown no longer signals a process group nobody recorded: it ends a service that stays through the record of what it launched, each process checked first, and fails by name if one is left. The service ran with `--sync-delay-ms 3000 --network-log <file>`; the budgets were setup 300 s, action 30 s, assertion 20 s, test 300 s, cleanup 60 s, one worker.

Working sync, `/Users/dragon/Library/Caches/retest-proofs/artifacts/reference-flow/run-iy7RzK`:

- Exit 0; the test passed. One `lease.taken` covering the desktop (`desk`) and the simulator device (`phone`) at sequence 3, before `browser.started` (4) and both `native.started` (6 and 7).
- One task id, `task-ccba9287d894`, throughout: the phone's `created-task-id` check expected and saw it, the web opened it, the service logged `PATCH /api/tasks/task-ccba9287d894` from `web` with 200, the desk's `selected-task-id` and `task-state-task-ccba9287d894` checks saw it.
- The service's network log: `POST /api/tasks` once, from `ios`, 201; one sign-in each from `ios`, `web` and `macos`, all 200; the one `PATCH` from `web`; no write from `macos`.
- Times of this run: the web's row check passed 3429 ms after the phone's `POST`, after 6 looks over 969 ms. The desk's `Done` check passed 3388 ms after the web's `PATCH` began, after 8 looks over 3334 ms. By the run's clock: `browser.started` at 40.0 s, `test.started` at 43.5 s, `native.started` at 45.4 s (phone) and 45.9 s (desk), the test finished at 81.0 s after a 37.5 s body. Measured once on a machine running other gates; no claim.
- `rebuildRecordedResult(events)` equals `result.json`. No `lease.expired`.

Broken sync, `/Users/dragon/Library/Caches/retest-proofs/artifacts/reference-flow-broken-sync/run-KWhH8e`:

- Exit 1; the test failed `check_failed`. The one failed assertion is the desk's `getByTestId('task-state-task-3d33e2ec8477')`: `has text "Open", expected "Done"`, after 35 looks over 20001 ms. No action or assertion of the attempt follows it.
- Before it, the desk's `task-state-<id>` check passed with `Open`, so the desk had the phone's task: the failure is the missing change, not a missing task. The web's save had passed with `Done`.
- The network log holds no bodies, so it shows the reads, not their contents: after the change was due (its `PATCH` start plus the delay) the desk read its list 18 times, all 200, and it wrote nothing. Read after the run, a fresh `macos` session sees the task `done: false`, revision 1, and a fresh `web` session `done: true`, revision 2. `/api/health` reported `{ kind: "links", links: [{ from: "web", to: "macos" }] }`.
- Failure screenshots: the phone's (`executor-screen`) and the web's were saved under `artifacts/`; both were opened and show no credential. The desk's `window-crop` was refused: a Wispr Flow window at layer 1000 (512 by 614 at 608,445) lay over TaskDesk's frame at 20,60,700,480. No foreign window or process was touched.

In both runs: the password was in no file of the run folder and not in the service's network log (`filesHolding`, every written form). After each run the simulator named in `native.started` was no longer listed by `simctl` and no process ran under its folder, no TaskDesk ran, and no runner (`WebDriverAgentRunner-Runner.app`) or `xcodebuild` process was left that had not been running before. No prompt appeared.

## Identities recorded

| App | Recorded in `native.started` or `browser.started` |
| --- | --- |
| phone | TaskPhone `dev.retest.fixtures.taskphone` 1.0 (1), sha256 `1a2972daa5d0da1d333b607a477a9295f678c82cdadcdce0ea63242fddca4a85`, the installed copy on a fresh iPhone 17 simulator; iOS 26.5 (23F77); WebDriverAgent 16.13.6 at `9d1d17ddb59e6097ddc3324b23ca9f4174507b12`, built from that commit (`commitVerified: true`), products sha256 `0ddb9244e806b6a5d3b8248189d1816f7a7fd828fd7301ecaa46bd482bad8aec`; Xcode 26.5 (17F42) |
| web | Chrome 154.0.8037.93, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| desk | TaskDesk `dev.retest.fixtures.taskdesk` 1.0 (1), sha256 `dc7b3ff7f9d4a1d8f178313fd47c0773afe735571d3ec95afbe08f492b86b843`; macOS 27.0.1 (26A434); appium-mac2-driver 4.3.6 at `f38257191fa9f273a684f6a9c8c2b16d1272bd09`, adopted (`commitVerified: false`), products sha256 `9c87eb50ea0649ec42c4742036d21f671c8842dedc89c03d7438d0896d69ac2f`; Xcode 26.5 (17F42) |

The integration test checks bundle ids, platforms, OS names, the iOS version, build and device type, the app checksum's shape, each executor's name, version and commit against `nativePins`, and Xcode against the pinned toolchain.

## How a secret reaches the native apps

The runner used to refuse every `secret()` typed into a native app. It now resolves one as it does for a web page, with the app's bundle id, read from the installed app, as the destination: the secret is read only when `secretOrigins` names that exact id, and the native page refuses a resolved fill that does not name its own id. The runner also drives the executor session the runtime opened for the app, rather than whichever session the executor reports as active. Details, tests and the public native API runs are in [wiring.md](wiring.md).

## Not verified

- The phone's id read off its own screen by the test. The flow proves the phone shows the id the web opened; a test cannot read a native element's text through the public API. Smallest change, in files this lane did not own: a `textContent(options?)` on `NativeLocator` in `src/api/page.ts`, implemented in `src/api/app-page.ts` as an `observe` of exactly one element answered with the parent's redacted observation text, no new protocol command.
- TaskDesk's failure screenshot: refused for the Wispr Flow window above. Nothing in the flow depends on it.
- Stability: each variant ran twice under the lock, once with a fault in the integration test's own event filter (it counted the phone's regex check of `created-task-id` as a second check of the id; both Retest runs were correct, `/tmp/retest-reference-flow-1.log`) and once passing. No repeat count beyond that.
- The web leg's first lookup relies on a fresh account: in a shared service another assigned task would make the row count 2 and the check fail, which it states.
- Firefox, WebKit, a clean machine and any other native platform.
