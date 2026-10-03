# WebKit proof on macOS

Phase 1 item 6, the WebKit half, of [release-0.1.0.md](../release-0.1.0.md), and the WebKit row of [plan.md](../plan.md) section 6. Recorded 3 October 2026.

## Result

A client written for Retest drove Playwright's automation-enabled WebKit build over its inspector pipe. Playwright was never loaded at runtime. All eleven steps passed against the real build and the task-app fixture. After the review fixes, seven full runs of the last code passed:

- three of `run.ts`
- one with `RETEST_WEBKIT_BUILD` written with a trailing slash
- one with a relative `--build` path
- one through `npm run proof:webkit`
- one through `webkit-proof.test.ts`

Nothing failed, and no step leans on a mock. An eighth run, also passing, was checked for processes from the build right after it exited, 1 s later and 3 s later; there were none. Seven of the eight runs keep their full output. The test run keeps only its step results.

Host: macOS 27.0 (`sw_vers` build 26A428), Darwin 27.0.0, arm64, Node 24.12.0.

| Step | What the run showed |
| --- | --- |
| 1 Launch | Headless, over the inspector pipe. The main process leads its own process group (`ps -o pgid=` equals its pid). It runs with a temporary home and `Playwright.getInfo` answers. The build path is made absolute with links resolved. The revision is read from the folder name, and the sha256 of `protocol.json` is checked against the pinned one. A mismatch fails the step. |
| 2 Context and page | `Playwright.createContext` returns a context and `Playwright.createPage` opens a page in it. Navigating to `/login` loads the page, and `document.readyState` reads `complete`. |
| 3 Evaluate and locate | `Runtime.evaluate` reads the title. `getByRole('heading', 'Sign in')` and `getByRole('button', 'Sign in')` use WebKit's own role and name. `getByTestId` finds elements and reads their text. A role and name that match nothing are refused. |
| 4 Real input | Mouse clicks and key presses fill the sign-in form. Clicking Sign in navigates to `/account`, which reads "Signed in as ada". Typing a title and clicking Save shows "Release checklist", and the server counts exactly 1 save. The page heard 59 input events, every one marked `isTrusted`, including 2 clicks. Clicking the heading and pressing a key with each modifier bit alone set: 1 `shiftKey`, 2 `ctrlKey`, 4 `altKey`, 8 `metaKey`, the same on the click and the key down. |
| 4b Covered button | On the overlay mode, the page reports a `DIV` with `position: fixed` at Save's centre, not the button or anything inside it. Clicking Save is refused. A listener on the window, set before the attempt, heard no `pointerdown`, `mousedown`, `mouseup` or `click`. The server counted 0 saves, but the overlay would absorb a click anyway, so that count proves nothing about the refusal. |
| 5 Screenshot | `Page.snapshotRect` returns a PNG. The file is read back and checked for its signature and every chunk CRC, then decoded: 1280×720 RGBA with 256 distinct colours. The check accepts any 1280×720 PNG with 16 or more colours. That the image shows the task page with "Release checklist" saved was confirmed by eye, not by the check. |
| 6 Isolation | Context A holds `task-app-session` (HTTP only) and `task-app-remember`. Context B holds no cookies: its account page reads "Signed out" and its localStorage and `document.cookie` are empty. Context B then sets a cookie and a localStorage key, and context A sees neither. |
| 7 Console and network | 5 `Console.messageAdded` events arrived: log, warning, error, an uncaught error (source `javascript`) and WebKit's own 404 notice. 6 `Network.requestWillBeSent` and 6 `Network.responseReceived` events arrived, including `POST /api/sign-in` 200 and `/missing` 404. |
| 7b Process swap | A cross-site navigation from `127.0.0.1` to `localhost` created a provisional target. The client set it up, resumed it and followed `Target.didCommitProvisionalTarget`, for example from `page-8` to `page-53`. The step fails unless the navigation produced a swap and the page's target id changed. |
| 8 Clean close | Helpers are sampled after steps 2, 4, 6 and 7b and before every close. Each run with kept output recorded 7 helpers from the build: Networking, GPU and five WebContent processes, all listed by launchd. `ps` found none beyond those. After `Playwright.close` the main process exits with code 0 and its process group is gone. No recorded helper needed SIGKILL, and a final `ps` check found no process from the build that started after launch still running. The temporary home is removed. The step fails if no build helper was recorded or any sample failed. |
| 9 Killed mid-session | 3 build helpers (Networking, GPU, WebContent) are recorded before the kill, and the step fails if there are none. SIGKILL goes to the main process while `Runtime.awaitPromise` waits. The client reports "the browser closed the pipe". The waiting command fails with `WkDisconnectedError`, `written: true`, so its outcome is unknown. A page command afterwards is refused with "was not sent" (asserted), and a browser command is refused unwritten (asserted). Checked by path, all three helpers had ended 38 to 81 ms after the client saw the main process exit, across the seven runs with kept output. The final `ps` check found nothing left. |

## The build

| Fact | Value |
| --- | --- |
| Revision | 2359, from `browsers.json` in `playwright-core` 1.63.0 (`"browserVersion": "26.6"`). Each run reads it from the build folder's name and reports it in `report.json`. The download URL is reported only when the revision and the `protocol.json` sha256 both match the pin. |
| WebKit version | `626.1.6+`, the `CFBundleVersion` of `WebKit.framework` |
| Host platform | `mac26-arm64`. Playwright caps Darwin 27 to macOS 26 (`LAST_STABLE_MACOS_MAJOR_VERSION = 26`) |
| Built with | Xcode 26.5, SDK `macosx26.5`, `LSMinimumSystemVersion` 26.5 |
| Download URL | `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip`. Fallbacks: `playwright.download.prss.microsoft.com/dbazure/download/playwright/…` and `cdn.playwright.dev/builds/…` |
| Download size | 81,853,194 bytes (78.1 MiB). `Last-Modified` 1 September 2026, Azure ETag `0xC6C9860757F4497B38FB3EA44AB019A52E31778C87803B51D0B995AE06F9D674` |
| Unpacked | `~/Library/Caches/ms-playwright/webkit-2359`, 303,392 KiB in 6,923 files |
| Installed by | `npx --no-install playwright install webkit` in `$TMPDIR/retest-benchmarks/playwright-project`, log `/tmp/retest-webkit-install.log` |
| sha256 | `Playwright.app/Contents/MacOS/Playwright` `7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f`; `protocol.json` `5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c`; `pw_run.sh` `a85baad3d8c07173ac387a59b41500c382b21ed692afe0964d29aac247ccc63b` |
| Upstream | `pw_run.sh` matches `browser_patches/webkit/pw_run.sh` at Playwright tag `v1.63.0` byte for byte. That tag's `UPSTREAM_CONFIG.sh` names WebKit `main` at `4d05d732e5a84f32675bef4cc135a2e7a9269a87`. Nothing here proves this commit is the exact source of build 2359. |

The installer deletes the zip after unpacking, so no zip checksum was taken. The ETag is Azure's, not a verified content hash. Pinning for Phase 3 needs our own checksum of the zip, taken when the pin is chosen.

The build carries its protocol as `protocol.json`: 33 domains, with WebKit's inspector protocol plus `Playwright` (21 commands, 7 events) and `Screencast`. The client was written against this file and against Playwright's launcher. The protocol belongs to the build: macOS 14 uses revision 2251, a different build, so a pin is a build and its `protocol.json` together.

## Licenses found in the build

Four license files, all in the Web Inspector front end, which the proof never loads:

| File | License | sha256 |
| --- | --- | --- |
| `WebInspectorUI.framework/Versions/A/Resources/External/CodeMirror/LICENSE` | MIT | `168a4becc968f5001e2ee2e0291b6e4daabafc1894a11ade1e11d56e96096e07` |
| `…/External/three.js/LICENSE` | MIT | `551f06ddc3dc36b56610aa23db680826ba9d9a02e8f89f7bec05d7fa27401a2b` |
| `…/External/Esprima/LICENSE` | BSD-2-Clause | `94bcb9959136723aa4fb36e1a6c4d5c662a2369978cfae344dabfb83ae619e79` |
| `…/External/CSSDocumentation/LICENSE` | MIT (Microsoft) | `b5179f780ec212a434efcc989a2295a140deb0bdb17182d2bf9c5f6f1f1a01c4` |

Not in the build: WebKit's own license texts (LGPL-2.1 and BSD-2-Clause), any notice for Playwright's patches, or a notice for any of the bundled libraries below. `Info.plist` says "Copyright 2003-2026 Apple Inc." and nothing more. Playwright itself is Apache-2.0 (`LICENSE` at `v1.63.0`).

Bundled code with obligations of its own, as `strings -a` and `otool -L` showed it. The licenses named are upstream's and were not checked against these files.

| File | What the binary shows | Upstream license |
| --- | --- | --- |
| `libANGLE-shared.dylib` | ANGLE | BSD-3-Clause |
| `libwebrtc.dylib` | WebRTC | BSD-3-Clause |
| `libwebrtc.dylib` | BoringSSL: 156 source paths under `third_party/boringssl`, and OpenSSL CRYPTOGAMS notices such as "Montgomery Multiplication for ARMv8, CRYPTOGAMS by <appro@openssl.org>" | OpenSSL and ISC |
| `libwebrtc.dylib` | abseil-cpp: source paths under `third_party/abseil-cpp/absl` | Apache-2.0 |
| `libwebrtc.dylib` | libvpx: "WebM Project VP8 Encoder v1.16.0-176-gade52487a" and the VP8 decoder and VP9 encoder strings | BSD-3-Clause |
| `libwebrtc.dylib` | calls into libyuv and SRTP names | Whether libyuv, libsrtp, Opus or libaom are linked in was not established |
| `libswiftCompatibilitySpan.dylib` | A Swift compatibility library, install name `/usr/lib/swift/libswiftCompatibilitySpan.dylib`, current version 6.3.2 | Apache-2.0 with the Runtime Library Exception |

No code was copied. Retest's client follows the message shapes in `protocol.json` and the launch flags and message routing in `playwright-core/lib/coreBundle.js`, read at `wkConnection.ts`, `wkBrowser.ts`, `wkPage.ts`, `wkInput.ts` and the WebKit `BrowserType`. In 1.63.0 the WebKit backend is bundled there; `lib/server/webkit/` no longer exists.

## Launch

```text
~/Library/Caches/ms-playwright/webkit-2359/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless --no-startup-window
```

- `--inspector-pipe`: the browser reads commands on fd 3 and writes replies on fd 4. The process is spawned with `stdio: ['ignore', log, log, 'pipe', 'pipe']` and `detached: true`, so it leads a new process group.
- `--headless`: no window.
- `--no-startup-window`: Playwright passes this when there is no persistent profile. With a profile it passes `--user-data-dir=<dir>` instead, and the browser opens a default context. The proof uses no profile, so every page needs a context from `Playwright.createContext`. In a probe, `Playwright.createPage` without `browserContextId` failed with "Browser started with no default context".
- The environment is set in full, so nothing of Retest's own environment reaches the browser: `PATH=/usr/bin:/bin`, `HOME` and `CFFIXED_USER_HOME` set to a temporary folder, `TMPDIR` inside it, and `DYLD_FRAMEWORK_PATH` and `DYLD_LIBRARY_PATH` set to the build folder. That is what the build's `pw_run.sh` does, minus the shell.
- Even with in-memory contexts, the build writes caches and website data under `~/Library`. The temporary home catches `Library/Caches/org.webkit.Playwright` and `Library/WebKit/org.webkit.Playwright`. One file still escapes it: cfprefsd writes `~/Library/Preferences/org.webkit.Playwright.plist` (one key, `WebKitLinkedOnOrAfterEverything`) to the account's real home. I removed it before a run and it came back during the run, born 01:49:36. Step 8 of each run reports whether it existed before and after.
- Graceful close is `Playwright.close`. The main process then exits with code 0.

Helper processes are not in the process group. The WebContent, Networking and GPU helpers are XPC services that launchd starts with parent pid 1, each in its own process group. Killing the group therefore does not cover them. The proof finds them two ways and records both:

- `launchctl print pid/<browser pid>` needs no root. It lists each service launchd started for the browser with its pid, and each helper's executable is confirmed with `ps -o comm= -p <pid>`. Output without a services block is an error, not an empty list. `launchctl print` is launchd's text, not a stable interface.
- `ps -A -o pid=,comm=` finds every process whose executable lies in the build folder and that was not running before this browser started. This still works after the browser is gone. It cannot tell two browsers started from the same build apart, so the proof starts one at a time. A process that was there before the browser started is reported and never signalled.

What the sampling observed:

- Sampling happens after steps 2, 4, 6 and 7b and before every close. A helper that starts and ends between two samples is never seen.
- In each of the seven runs with kept output, step 8 recorded 7 build helpers and step 9 recorded 3, all listed by launchd; `ps` found no others.
- After the clean close, no recorded helper needed SIGKILL and the final check by path found nothing left.
- After SIGKILL of the main process, the recorded helpers were gone by path within 81 ms.
- `com.apple.SetStoreUpdateService`, a system service, is also started for the browser; it ended in every run. The proof never signals it.

The review expected launchd to stop listing a dead browser's helpers. That is not what happened here. In each of the seven runs with kept output, `launchctl print pid/<dead pid>` still answered right after the exit and listed the helpers still running: one in six runs, none in the seventh. Moments later it listed none. How long launchd keeps a dead process's domain was not measured. The proof does not rely on it: after the browser exits it looks only by path.

A SIGKILL of the proof process itself skips all cleanup. In one trial the proof was killed 1.5 s into a run. Within 3 s no process from the build was running, so the browser ended when its pipe closed. Its temporary home stayed behind in `$TMPDIR` and nothing removes it later. One home from a probe run on the earlier stop code was also left behind; its cause was not established. Runs of the revised code left none, checked after each set of runs.

## Protocol

There are three addresses on one pipe, and every command takes its id from one counter:

| Address | Message | Used for |
| --- | --- | --- |
| Browser | `{id, method, params}` | `Playwright.*`: contexts, pages, navigation, cookies, close |
| Page proxy (the browser-process side of a page) | `{id, method, params, pageProxyId}`; replies and events carry `pageProxyId` | `Input.*`, `Emulation.*`, `Target.*`, `Dialog.*`, `Screencast.*` |
| Page target (the web-process side) | inner `{id, method, params}` as the `message` string of `Target.sendMessageToTarget`; replies and events come back inside `Target.dispatchMessageFromTarget` | `Page.*`, `Runtime.*`, `DOM.*`, `Console.*`, `Network.*` |

Commands the proof sent (29): browser `Playwright.close`, `closePage`, `createContext`, `createPage`, `deleteContext`, `enable`, `getAllCookies`, `getInfo`, `navigate`; page proxy `Emulation.setActiveAndFocused`, `Emulation.setDeviceMetricsOverride`, `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, `Target.resume`, `Target.sendMessageToTarget`; page target `Console.enable`, `DOM.getAccessibilityPropertiesForNode`, `DOM.getContentQuads`, `DOM.getDocument`, `DOM.querySelectorAll`, `DOM.resolveNode`, `DOM.scrollIntoViewIfNeeded`, `Network.enable`, `Page.enable`, `Page.snapshotRect`, `Runtime.awaitPromise`, `Runtime.callFunctionOn`, `Runtime.enable`, `Runtime.evaluate`.

Events the proof received (22): browser `Playwright.pageProxyCreated`, `Playwright.pageProxyDestroyed`; page proxy `Target.targetCreated`, `Target.targetDestroyed`, `Target.didCommitProvisionalTarget`, `Target.dispatchMessageFromTarget`; page target `Console.messageAdded`, `Console.messagesCleared`, `DOM.childNodeCountUpdated`, `DOM.documentUpdated`, `DOM.setChildNodes`, `Network.dataReceived`, `Network.loadingFinished`, `Network.requestWillBeSent`, `Network.responseReceived`, `Page.defaultUserPreferencesDidChange`, `Page.didCheckNavigationPolicy`, `Page.domContentEventFired`, `Page.frameNavigated`, `Page.loadEventFired`, `Page.willCheckNavigationPolicy`, `Runtime.executionContextCreated`.

The proof listens to `Playwright.provisionalLoadFailed` but did not receive it. `Screencast.*` and `Playwright.takePageScreenshot` were not exercised. Both lists come from a transport that notes each method name, never parameters, and are in each run's `report.json`.

Where WebKit differs from Chromium's CDP, as this proof met it:

- An error's `data` is a list of errors, where CDP sends a string.
- There are no flat `sessionId` sessions. A page has a page proxy addressed by `pageProxyId`, and its page targets take wrapped messages.
- A new page target starts paused (`isPaused: true`). The client turns on `Page`, `Runtime`, `Console` and `Network` first, then sends `Target.resume`, so the first script's events are heard.
- A cross-site navigation loads into a provisional target in a new web process. That target has to be set up before it runs, and becomes the page's target on `Target.didCommitProvisionalTarget`. The navigation's `loaderId` from `Playwright.navigate` matched the provisional target's `frameNavigated`.
- Input and emulation go to the page proxy, not to the target. `Input.dispatchMouseEvent` takes whole-pixel `x` and `y`.
- Modifier bits, as observed: on `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` alike, 1 set `shiftKey`, 2 `ctrlKey`, 4 `altKey` and 8 `metaKey` (step 4). This build's own `protocol.json` documents the mouse, wheel, tap and touch `modifiers` as Alt 1, Ctrl 2, Meta 4, Shift 8. The behaviour contradicts that documentation, so a driver has to follow the observed bits and keep a test for them.
- `DOM.getAccessibilityPropertiesForNode` gives WebKit's computed role and label. The proof matches role and name on them exactly, with no approximation in Retest.
- The user agent carries no WebKit version and `Playwright.getInfo` returns only `os`. The version has to come from the build: `WebKit.framework`'s `Info.plist`, or a pinned record.
- In one early probe, `Page.loadEventFired` arrived before `Page.domContentEventFired`, by their own timestamps. A driver should not assume CDP's order.

## How much of the Chromium code was reusable

| Chromium module | Reused | Why |
| --- | --- | --- |
| `src/browser/cdp/transport.ts` (`PipeTransport`, 139 lines) | Whole, by import, unchanged | Same framing: NUL-terminated UTF-8 JSON on fds 3 and 4, with the same written and withdrawn tracking |
| `src/browser/cdp/message.ts` | `isRecord` only | `parseMessage` drops `pageProxyId` from events and calls every WebKit error malformed because `data` is not a string. `wk-client.test.ts` shows both. |
| `cdp/connection.ts`, `session.ts`, `channel.ts`, `errors.ts` | None | Built around flat CDP sessions (`sessionId`, `Target.attachToTarget`) and CDP's error body. `WkConnection` keeps their rule that a command which may have been written has an unknown outcome (`written`) |
| `src/browser/listeners.ts` | Whole | Protocol-neutral |
| `src/browser/chromium-process.ts` | `signalGroup` only | `ChromiumProcess` passes no environment and knows nothing of helpers outside the group |
| `protocol/deadline.ts`, `protocol/failures.ts`, `shared/process-exit.ts`, `shared/error-code.ts` | By import | Protocol-neutral |

In lines, `transport.ts` and one function of `message.ts` were reused out of the 751 lines in `src/browser/cdp/`. Everything above the transport (`page.ts`, actionability, isolated worlds, navigation) calls CDP directly, so this proof did not try to reuse it. The semantics there are protocol-neutral in principle: strict matching, the hit test before a click, observation retries. They only become reusable once separated from the CDP calls.

## Recommended route for Phase 3

Build the WebKit driver as Retest's own client over the inspector pipe to a pinned Playwright WebKit build, as this proof does. It covers launch, isolated contexts, observation, trusted input, screenshots, console, network and process swaps with no framework underneath. Prerequisites, most important first:

1. **License and distribution decision.** The build ships no license text for WebKit or for the code bundled with it. If Retest downloads it for users, through the planned explicit install, notices must be shown for:
   - WebKit (LGPL-2.1 and BSD-2-Clause)
   - ANGLE and WebRTC (BSD-3-Clause)
   - BoringSSL (OpenSSL and ISC), abseil-cpp (Apache-2.0) and libvpx (BSD-3-Clause), all inside `libwebrtc.dylib`
   - the Swift compatibility library (Apache-2.0 with the Runtime Library Exception)
   - whatever else a full audit of the binaries finds, starting with libyuv, libsrtp, Opus and libaom

   Users also need a pointer to the corresponding source. That pointer still has to be established: nothing here proves which WebKit commit and which Playwright patches built revision 2359. The tag's `UPSTREAM_CONFIG.sh` is only a lead. Two questions were not examined: whether Retest may send users to Microsoft's CDN for the build at all, and how long old revisions stay there. This needs a founder or legal decision before the install command is built.
2. **Pin build and protocol together.** Record the zip's sha256 at pin time and the sha256 of `protocol.json`, and refuse a build whose `protocol.json` differs, as step 1 of the proof does now. Supported macOS versions map to different zips, and macOS 14 to a different revision; decide which are claimed, arm64 only per the 0.1.0 scope.
3. **Helper ownership.** Group kill alone leaves the helpers out. After the browser died, `launchctl print` kept answering in these runs, but listed only helpers still running, and soon none. Nothing guarantees how long it answers at all, so it cannot be relied on to find helpers after the browser has died. The driver therefore needs the `ps` check by build path, with a note of what ran before launch. Keep launchd for attribution while the browser runs, with a test that fails loudly if its format changes. The path check cannot tell two sessions of the same build apart. Concurrent WebKit sessions need their own build copy, or a sturdier attribution.
4. **The escaping preferences file.** Accept and document `~/Library/Preferences/org.webkit.Playwright.plist`, or find a way to keep cfprefsd off the real home.
5. **Leftover homes.** A client killed with SIGKILL leaves its temporary home behind. Sweep stale homes at the next launch, as the Chromium launcher already does for its profiles.
6. **Driver work above this client**, behind the session contract from the contract lane:
   - dialogs (`Dialog.*` on the page proxy)
   - failed and same-document navigations (`Playwright.provisionalLoadFailed`, `Page.navigatedWithinDocument`)
   - frames and frame targets
   - storage state (`Playwright.setCookies`, `DOMStorage.*`)
   - viewport
   - redirects (`redirectResponse` on `requestWillBeSent`) and `Network.loadingFailed`
   - runtime errors from `Console.messageAdded` with source `javascript`
   - actionability, assertions and locators from shared semantic code, kept apart from protocol code (proposed `src/browser/webkit/`)
7. **Identity in results.** Report the build revision and `WebKit.framework` version, since the page never states them.

## Linux route (not built, not run)

Linux WebKit is outside 0.1.0: the release plan says the support matrix does not claim it. Two routes exist.

- **Playwright's Linux build.** There are zips for Ubuntu 22.04, 24.04 and 26.04 and Debian 12 and 13, on x64 and arm64, at the same revision. Its `pw_run.sh` runs `minibrowser-wpe` (WPE) when `--headless` is passed and `minibrowser-gtk` otherwise, with the same `--inspector-pipe` and `Playwright` domain. The same client should therefore apply, but only running it proves that. It would need:
  - a `docker/linux` image variant with the zip for the image's distribution
  - the system packages Playwright lists for WebKit (about 50 on Ubuntu 24.04, among them GStreamer, GTK 4, ICU, libsecret, libmanette and libwoff)
  - a check of where helpers run: on Linux they are expected to be child processes inside the group, with no launchd
  - a check of where caches and website data go under `HOME` and the XDG folders
  - the same eleven steps passing in the container
- **Distribution WebKitGTK or WPE with `WebKitWebDriver` or `WPEWebDriver`.** This is a W3C WebDriver server, a different protocol. Retest has no WebDriver classic client, and the Firefox lane writes BiDi. Classic WebDriver has no network or console events, and this lane did not check how far WebKit's BiDi support has come. Distribution versions trail upstream. This would be a separately named WebKit and would have to pass the same contract.

If Linux WebKit is ever claimed, the first route reuses this client and is the one to try first.

## How to run

```sh
npm run proof:webkit                                                 # the same as node --conditions=retest-source proofs/webkit/run.ts
                                                                     # exit 0 all passed, 1 a step failed, 2 could not start
node --conditions=retest-source --test "proofs/webkit/**/*.test.ts"  # protocol units plus one test on the real build
```

`RETEST_WEBKIT_BUILD` or `--build` names another unpacked build; a trailing slash, a relative path or a link all name the same folder. A build whose folder name or `protocol.json` differs from the pin fails step 1. Every `plutil`, `launchctl` and `ps` call has a time limit, and stopping the browser has an overall deadline. Output goes to `.retest/proofs/webkit/<time>/`, which git ignores: `report.json`, `webkit-task-app.png`, `browser.log` and `browser-disconnect.log`. Without the build, `run.ts` exits 2 with the install command, and the real-build test fails rather than skipping.

## Evidence

- Install: `/tmp/retest-webkit-install.log`.
- Final runs: each "11 of 11 steps passed", exit 0, with artifacts under `.retest/proofs/webkit/`:
  - `/tmp/retest-webkit-proof-final-1.log` to `-3.log`
  - `/tmp/retest-webkit-proof-trailing-slash.log`
  - `/tmp/retest-webkit-proof-relative.log`
  - `/tmp/retest-webkit-proof-npm.log`
- After-run process check: `/tmp/retest-webkit-proof-after-check.log`.
- SIGKILL of the proof process: `/tmp/retest-webkit-client-kill.log`.
- Tests: `/tmp/retest-webkit-tests.log`, 28 tests, 28 passed, 0 skipped.
- Typecheck: `/tmp/retest-webkit-typecheck.log`, empty, exit 0. TypeScript 6.0.3 and 7.0.2 with `proofs/webkit/tsconfig.json`, which extends the root config.
- Missing build: `/tmp/retest-webkit-proof-missing.log`, exit 2.
