# Phase 2 review, part one: native iOS and macOS code

Scope: `src/native/**`, `proofs/native/**`, `tests/unit/native-*`, `tests/integration/native-*`, and the native records `native.md` and `native-interaction.md`. All `src/native` files are in their committed form; none has uncommitted changes. Where native code depends on shared code (`src/shared/metadata-process.ts`, `process-ownership.ts`), I cite the committed version.

## Findings, most severe first

**N-1 — high — `src/native/assertions.ts:185`** (held: native secrets builder 1, and the same root as reference flow builder 2)
- **Claim:** `pollNative` returns the look's own `timeout` failure unless the poll's deadline has already expired when that failure arrives. A real mismatch seen on an earlier look is then reported as `timeout`.
- **Scenario:** a 1500 ms `toHaveText('Done')` on TaskPhone. The first look sees "Open". The last look gets about 450 ms, and its source request times out. The request sits under three nested budgets, each rounded down to a whole millisecond, so it reports a few ms before the poll's own deadline ends. `deadline.expired` is still false, so the verdict is `timeout`, not `check_failed`.
- **Proof:** I ran `pollNative` with a stand-in look that times out 2, 4 and 8 ms early. All three returned `class timeout` while `actual` still held the observed "Open". When the very first look outlasts the budget, `timeout` with nothing observed is honest, and that part is fine.
- **Fix:** when an earlier look exists, treat any `timeout` failure from a look as the end of polling and judge from that last look.

**N-2 — high — `src/native/locators.ts:282-284`, `:290-294`, `:255-263`; `src/native/assertions.ts:52`** (held: native locators 12)
- **Claim:** when the tree omits `enabled`, `selected`/`traits` or `value`, the observation records disabled, unselected or empty. These are never `null`.
- **Scenario:** an element whose tree entry lacks `enabled` passes `toBeDisabled()` and fails `toBeEnabled()` as a false state. A macOS row without `selected` passes `.not.toBeSelected()`. A field without `value` passes `toHaveValue('')`.
- **Fix:** return `undefined` for an absent attribute, map it to `null` in the observation, and let the checks treat `null` as "could not judge".

**N-3 — high — `src/native/locators.ts:258-261`** (held: native locators 11)
- **Claim:** on iOS, a field value equal to its `placeholderValue` reads as `''`.
- **Scenario:** a user types "Account" into a field whose placeholder is "Account". `toHaveValue('')` then passes. A later `fill` sees length 0, skips the clear and types onto the old text (the fill then fails only after input went).
- **Fix:** report "cannot tell" when the value equals the placeholder: refuse value checks and refuse to fill without a confirmed empty reading.

**N-4 — high — `src/native/alerts.ts:139`, `:146-149`** (held: native locators 9)
- **Claim:** `executorAlertOpen` treats every answer other than `answered` as "no alert".
- **Scenario:** after an iOS accept is pressed, `GET /alert/text` times out, loses its connection or is unreadable. `answerAlert` returns `{ ok: true }` while the system alert may still be up.
- **Fix:** only `refused` with `no such alert` means closed. Anything else fails with `inputSent: 'sent'`.

**N-5 — high — `src/native/input.ts:192-195`** (held: native locators 10)
- **Claim:** a macOS secure field that reads back empty after typing passes `fill`, recorded only as `not_exposed`.
- **Scenario:** focus moves away after the focusing click, so the keys land elsewhere. The secure field reads `''` and `fill` returns ok, so the outcome is inferred, not observed. The record itself says a field being edited reads back U+F79A bullets.
- **Fix:** fail, or return a distinct unverified outcome that cannot count as a pass, when no masked read-back is seen.

**N-6 — high — `src/native/keyboard.ts:62-74`, `:137`** (held: native locators 8)
- **Claim:** `firstRunCardOf` matches any static text containing "slide to type" or "sliding your finger" plus one Continue button anywhere up to the root, with no keyboard present. `dismissKeyboard` presses it first.
- **Scenario:** an app screen says "Slide to type faster" and has one "Continue" button. `keyboard.dismiss()` presses the app's Continue, an unrequested app action.
- **Fix:** require a visible `Keyboard` element, and require the card's container to lie in the keyboard's window or above its frame.

**N-7 — high — `src/native/input.ts:129-136`, `:271-275`, `:366-374`** (held: native locators 13)
- **Claim:** some input paths skip parts of actionability:
  - `clickTreeElement` (return key, first-run card, macOS alert button) has no steady-frame, hittable or coverage check.
  - `press` without a locator has no alert, front or coverage check.
  - scroll/swipe without a locator has no alert or coverage check.
- **Scenario:** on macOS, `page.press('Meta+W')` with no locator while another app is in front sends the chord to the runner's current application with no check that the app is in front. The other paths can press a sheet button that is still sliding in.
- **Fix:** route all of them through the same front, alert and steady-frame checks as `waitUntilActionable`. On macOS, require the app in front before any keys go.

**N-8 — medium — `src/native/alerts.ts:125`** (new)
- **Claim:** the iOS alert press calls `port.readFailure(pressed, …)` without `acting: true`, so an unanswered press gets a read's failure class and message.
- **Scenario:** a cancel arrives while `POST /alert/accept` is in flight. `input` is `unknown`, but the message says "Retest stopped before it sent the request". A lost connection becomes `session_lost`, and a refused error after acting becomes `not_actionable`. In all three cases the class should be `outcome_unknown`, so the failure claims the input was not sent when it may have been.
- **Fix:** pass `acting: true`, and merge `inputSent` into the failure's details instead of replacing them.

**N-9 — medium — `src/native/processes.ts:131`, `:384-389`** (new)
- **Claim:** every `runCommand` and every running `OwnedProcess` reads the whole process table synchronously on the main thread: at construction, at end, and every 100 ms while an executor runs. This goes through `readMetadataProcess`, which blocks with `Atomics.wait`.
- **Measured:**
  - One full `ps -axo` takes about 40 ms with 879 processes.
  - With one `OwnedProcess` (`/bin/sleep`) running, 10 ms timer ticks over 2 s fell from 188 to 120, and event-loop delay p99 rose from 6.4 to 50.4 ms.
  - `commandOf(pid)` costs 110 ms against 1.7 ms for a plain `ps -p`.
- **Scenario:** the reference flow holds two executors. The main thread is blocked for most of each 100 ms. The "every 100 ms" launch-claim poll actually runs at about 350 ms, and every sub-second native budget is distorted.
- **Fix:** read ownership asynchronously off the main thread, and poll descendants far less often (or only at stop and exit).

**N-10 — medium — `src/shared/metadata-process.ts:42`, `:70`, `:97`, `:112` (committed), used by every native process read** (new; relates to diagnostics wiring 4)
- **Claim:** one unanswered metadata query, or a worker exit, sets `bridgeFailure` for good, and every later ownership read in the process throws.
- **Scenario:** a loaded Mac makes one `ps` exceed the 5 s + 1 s allowance. From then on, every native `runCommand` cleanup reports problems, every `remains()` reads true, runtimes close as `cleanup_failed`, leases stay held and starts are refused until the process exits.
- **Fix:** fail only that query, and start a fresh worker for the next one.

**N-11 — medium — `src/native/processes.ts:275-282`, `:295`; `src/native/executor-process.ts:90-94`** (new; residual of held native locators 2)
- **Claim:** the result bundle and derived data are deleted only on an orderly close. On exit the hook deletes them only if no owned process remains, a SIGKILL deletes nothing, and no later start sweeps them.
- **Why it matters:** WebDriverAgent names its typing event "Type '<first 12 characters>…'" with `shouldRedact:NO` (`XCUIElement+FBTyping.m:28-31`), so a password of 12 characters or fewer is whole in that name.
- **Evidence:**
  - TMPDIR holds 56 `retest-executor-*` folders. One holds a staged `result.xcresult` with simulator diagnostics from a real iOS start.
  - My native unit run added 2 more, plus 2 `retest-macos-*`.
- **Scenario:** a run is killed mid-test after a secret fill, and the folder stays in TMPDIR. I did not confirm the activity name is inside it; see unverified item 1.
- **Fix:** sweep stale `retest-executor-*` folders whose recorded owner is gone at each start, and delete the folder even when unowned group members remain.

**N-12 — medium — `src/native/desktop-lock.ts:159-165`, `:254-256`; `src/native/macos-app.ts:295-298`** (new)
- **Claim:** a clean close keeps the desktop record, which names xcodebuild's pid. Every later start treats it as a gone holder's record and runs `groupPresence(oldPid)`.
- **Scenario:** pids wrap (here the maximum seen was 99966 and new pids are about 12000). The old xcodebuild pid is reused by any group leader: a launchd job, a shell, or one of Retest's own detached tool children. Every macOS native start is then refused with "Process group N still has members whose launch ownership was not recorded", until that unrelated process ends. Nothing tells the user to remove the record. The record on this Mac still names xcodebuild 29548 from the last clean run.
- **Fix:** have the holder clear the record (no processes) after a clean close. Check group presence only for a record whose holder died.

**N-13 — medium — `src/native/ios-simulator.ts:233-249`, `:277-278`, `:294-295`; `docs/plans/public-beta/proofs/native.md:262`** (new)
- **Claim:** the orphan sweep now only reports, and `start` refuses on any report. The doc comment and `native.md` still say leftover simulators are deleted ("stay until the next start's sweep").
- **Scenario:** after one SIGKILLed iOS run, every later iOS start is refused with "Retest did not shut it down or delete it", and nothing says how to remove the simulator. If the maker's pid has been reused, the orphan is skipped silently and stays forever.
- **Fix:** fix the comment and the records, and name the exact `xcrun simctl delete <udid>` in the refusal, or keep an ownership record that allows deletion.

**N-14 — medium — `src/native/actionability.ts:199-217`; `src/native/locators.ts:462-468`, `:512-523`** (held: native locators 7)
- **Claim:**
  - An element unique in the scoped tree is resolved with a global executor lookup.
  - An ancestor used to resolve inside is never identity-checked.
  - A verified identifier drops the label from the predicate.
- **Scenario:** `getByRole('button', { name: 'Save' })` matches a button whose identifier stays fixed. Between the tree read and the click, its label changes to "Delete". It still resolves, reads back and is clicked.
- **Fix:** keep label and title in the predicate, read the identity back on ancestors, and anchor macOS lookups inside the owned window element.

**N-15 — medium — `src/native/interaction-session.ts:467`** (held: native locators 15)
- **Claim:** the click-coverage check exempts every window of the AutomationModeUI process at any layer or extent, and every pointer-layer window of any owner. The capture check in `macos-app.ts` was narrowed to the full-screen overlay; this one was not.
- **Scenario:** a smaller AutomationModeUI window over the element's centre, or another process's window at layer 2147483630, does not block a click.
- **Fix:** pass `automationOverlayPids` into `coveringWindows`, as the capture does, and exempt the pointer layer only when the pointer process owns that window.

**N-16 — medium — `src/native/actionability.ts:138-139`, `:245-247`, `:130-135`; `src/native/interaction-session.ts:453-463`** (held: native locators 14)
- **Claim:** the 100 ms frame gap is shortened when little time remains and the action still goes ahead. Frames within 0.5 pt count as equal. One timeout snapshot is shared across several sequential requests.
- **Scenario:** with 30 ms left, the two frame reads are 30 ms apart and the click goes on a sheet still moving.
- **Fix:** if the full gap does not fit, fail. Hand each request its own share of the remaining time.

**N-17 — medium — `src/native/source-scope.ts:75`, `:101-103` vs `src/native/session.ts:331`** (new)
- **Claim:** menu text is hashed (unsalted SHA-256, first 12 hex digits) before the session redacts the tree, so redaction can no longer see the secret.
- **Scenario:** a pop-up menu in the window lists "Signed in as <token>". The saved tree holds `sha256:` of text containing the secret, which allows offline guessing of a weak secret. A rotated secret also changes the tree.
- **Fix:** decode and redact menu text before hashing.

**N-18 — medium — `docs/plans/public-beta/proofs/native.md:260`, `:268`** (new)
- **Claim:** the record describes behaviour the code no longer has:
  - Line 260 says xcodebuild's process group is signalled by group id at a stop and in the exit hook. `processes.ts:375` now never signals a numeric group.
  - Line 268 says recovery ends "xcodebuild with its process group". `desktop-lock.ts:247-256` ends xcodebuild by pid only and refuses while group members remain.
- **Scenario:** a reader relying on the record expects a killed runner's group to be cleaned at the next start. Instead the start is refused.
- **Fix:** rewrite both paragraphs to the current rules.

**N-19 — low — `src/native/interaction-session.ts:133-135`; `src/native/session.ts:355-363`** (held: native locators 5)
- **Claim:** the wrapped session is still exposed, and `checkReference` ignores cancellation.
- **Scenario:** `interaction.session.cancel(r)` leaves the wrapper's lane open, and a resolved element can then be pressed. No runner or public path does this: `src/native` is not exported, and the runner only reads `.session`.
- **Fix:** expose read-only facts instead of the session, and refuse references once cancelled.

**N-20 — low — `src/native/interaction-session.ts:248-270`** (held: native locators 6)
- **Claim:** `resolve` (`enabled: false`) then `pressResolved` clicks with no fresh tree, enabled, frame, hittable or coverage check.
- **Scenario:** an old handle to a now-disabled or covered button receives a click. Only tests and proofs call it.
- **Fix:** re-run actionability on the resolved element before the click, or remove `pressResolved`.

**N-21 — low — `src/native/webdriver-client.ts:600`** (held: native locators 16)
- **Claim:** `ExecutorElements` ends only itself on `invalid session id`.
- **Scenario:** a caller holding the `ExecutorSession` can still send keys. Inside the interaction layer, `#lose` → `markLost` makes `sendOnce` refuse, so this is mitigated there.
- **Fix:** give both objects one shared ended state.

**N-22 — low — `tests/integration/native-interaction.test.ts:108`, `:279`; `tests/unit/native-interaction-fake.ts:611`** (held: native locators 17)
- **Claim:** dispose failures are swallowed with `.catch(() => undefined)`.
- **Scenario:** a session that fails to end its app still lets the suite pass.
- **Fix:** collect and assert disposal errors.

**N-23 — low — `tests/integration/native-interaction.test.ts:254-255`, `:438-439`; `proofs/native/interaction.ts:99-104`; `tests/unit/native-keyboard-alerts.test.ts:120-126`; `tests/unit/native-actionability.test.ts:13-27`** (held: native locators 18)
- **Claim:** these tests don't establish their titles:
  - The cancel tests accept any stable positive length; doubled typing would pass.
  - `wrongState` checks the class but not `details.element`.
  - The system-alert test checks `input` but not success or closure.
  - The frame test checks request order, not spacing.
- **Fix:** assert length equals the typed text, assert the element detail, assert `result.ok` and closure, and assert the timing gap.

**N-24 — low — `tests/integration/native-interaction.test.ts:29`, `:92`** (held: native locators 19)
- **Claim:** every access error is labelled "missing" (the harness itself was fixed), and the plist-only test title claims no permission can be asked.
- **Fix:** treat only ENOENT as missing, and narrow the title.

**N-25 — low — `docs/plans/public-beta/proofs/native-interaction.md:185`, `:23`, `:126-133`** (held: native locators 20)
- **Claim:** the record claims more than the tests show:
  - "12 of 12": the file holds 11 tests.
  - Real macOS "count" is listed as exercised, but the count step uses `toHaveText('33 tasks')`.
  - The value table omits the macOS toggles, sliders and steppers that `valueOf` accepts.
  - No real iOS clear was exercised.
- **Fix:** correct the record.

**N-26 — low — `src/native/assertions.ts:83`; `src/native/webdriver-client.ts:18-21`** (held: native locators 21)
- **Claim:** the selected value is still widened to `unknown`, and `ExecutorRoute` is still called the whole route inventory.
- **Fix:** type `selected` properly, and point the doc comment at both route lists.

**N-27 — low — `tests/integration/native-ios-lifecycle.test.ts:175`, `:218`; `tests/integration/native-macos-lifecycle.test.ts:182`, `:212`** (new; same class as held 4)
- **Claim:** these tests `process.kill(pid, 'SIGKILL')` stored pids with no command-line check.
- **Fix:** use `endRecorded`, as `native-interaction.test.ts:263` and `:446` now do.

**N-28 — low — `src/native/keyboard.ts:101`, `:155`; `src/native/alerts.ts:138`** (held: native secrets builder 2)
- **Claim:** a transient tree of another app (`check: 'tree'`) ends `waitForKeyboard` and the post-press waits at once. The retries the note mentions exist only in `waitUntilActionable`, `pollNative` and `readField`.
- **Scenario:** SpringBoard owns the tree for one read during the keyboard wait, and the wait fails.
- **Fix:** treat `check: 'tree'` as "look again" in these loops.

**N-29 — low — `src/native/keyboard.ts:119-128`** (held: loose-ends builder 6)
- **Claim:** `dismissFirstRunCard` has no platform check and passes with nothing sent on macOS. The runner forwards it unchecked, and a JavaScript caller can reach it.
- **Fix:** refuse on macOS, as `dismissKeyboard` does.

**N-30 — low — `src/native/logs.ts:155`, `:221-226`** (held: diagnostics wiring 2)
- **Claim:**
  - The macOS logged app is spawned in Retest's own process group with no exit hook. After a SIGKILL nothing "recovers" it: the next start's launch blocker refuses until the user quits it.
  - On iOS, a reconciliation failure leaves the `simctl launch --console` child running and untracked.
- **Fix:** spawn the app detached and give it the session's exit hook. End the launcher child, which Retest started itself.

**N-31 — low — `src/native/source-scope.ts:43`; `src/native/interaction-session.ts:427-433`** (held: diagnostics wiring 3)
- **Claim:** WebDriverAgent still reads whichever app it picks as active. This is mitigated: another app's tree is refused whole and retried. N-28 lists the loops that do not retry.
- **Fix:** none beyond N-28 is needed for safety.

**N-32 — low — `src/native/executors.ts:601-618`** (new)
- **Claim:** the build lock is a pid file with a non-atomic takeover.
- **Scenario:** two processes both read a dead holder's pid; one removes the other's fresh lock, and both build into one cache folder. An empty lock file (written before its pid) reads as holder 0 and is taken over.
- **Fix:** use the same `lockf` kernel lock as the desktop.

**N-33 — low — `src/native/processes.ts:528-553`, `:600-613`; `src/native/session.ts:461-463`** (new)
- **Claim:** native kills and ownership use pid plus exact command only, not start time. This differs from the founder's binding rule (pid plus start time). Every start of one macOS runner build shares one command line.
- **Scenario:** a recorded pid is reused by a process with the identical command line, which is then signalled. Unlikely, but the rule is not followed.
- **Fix:** record and compare `lstart` alongside the command.

**N-34 — low — `src/native/reset-policy.ts:44`** (new)
- **Claim:** the iOS contract states `keychain: 'reset'`, but `native.md` "Not verified" item 3 says the keychain was never exercised.
- **Fix:** exercise it once, or mark it unverified.

**N-35 — low — `proofs/native/interaction.ts:62-71`, `:143`, `:208`** (new)
- **Claim:** the proof still attaches to whichever session `/status` names and types the fixture password into it. The wiring forbids attaching that way.
- **Fix:** use `opened.client` and `opened.executor`, as the integration test does.

## Status of held findings in scope

| Held item | Status on current code |
| --- | --- |
| Native locators 1: XML-escaped secret; unredacted executor messages | Fixed: `locators.ts:173-179` decodes before redacting; `interaction-session.ts:493`, `:506-508` and `session.ts:570-573` redact failures. Residual in N-17 |
| 2: typed text in the XCTest event name and output | Fixed for what Retest writes: `output.ts:50-55` and the owned temporary folder. Residual in N-11 |
| 3: input absent from the ledger while in flight | Fixed: `input.ts:145` → `interaction-session.ts:472-478`; dispose drains the lane at `:333-343` |
| 4: integration tests kill stored pids | Fixed in `native-interaction.test.ts:263` and `:446` (`endRecorded`). Same pattern remains elsewhere: N-27 |
| 5: wrapper lane bypass | Still applies, low: N-19 |
| 6: resolved handles skip actionability | Still applies, low (test-only path): N-20 |
| 7: resolution not anchored | Still applies: N-14 |
| 8: keyboard card false match | Still applies: N-6 |
| 9: failed alert read counts as closed | Still applies: N-4 |
| 10: unreadable secure field passes fill | Still applies: N-5 |
| 11: placeholder equals value | Still applies: N-3 |
| 12: missing attributes read as false | Still applies: N-2 |
| 13: input paths skip actionability | Still applies: N-7 |
| 14: bound and frame spacing | Still applies: N-16 |
| 15: Automation Mode exemption | Still applies (click check only): N-15 |
| 16: element-client end not shared | Still applies, mitigated by `markLost`: N-21 |
| 17: swallowed cleanup failures | Still applies: N-22 |
| 18: assertions don't establish titles | Still applies: N-23 |
| 19: skips and access errors | Partly fixed (the harness fails on unreadable prerequisites); still applies in the test file: N-24 |
| 20: record overstates | Still applies: N-25 |
| 21: `unknown` widening; route doc | Still applies: N-26 |
| Native secrets builder 1: mismatch classed `timeout` | Still applies, root cause found and reproduced: N-1 |
| Native secrets builder 2: other-app tree during keyboard wait | Still applies: N-28 |
| Loose-ends builder 6: `dismissFirstRunCard` on macOS | Still applies: N-29 |
| Diagnostics wiring 2: logged macOS app after SIGKILL | Still applies; the "recovery" wording is wrong: N-30 |
| Diagnostics wiring 3: WebDriverAgent picks the active app | Still applies, mitigated: N-31 |
| Diagnostics wiring 4: `ps ETIMEDOUT` with a 1 s limit | Changed: committed reads use a 5 s limit (`metadata-process.ts:31`, `:40`). Not reproduced. A single timeout now poisons the process: N-10 |

## Confirmed by running

- `pgrep -f benchmarks/run.ts` found nothing before each run.
- `node --conditions=retest-source --test tests/unit/native-*.test.ts`: 286 pass, 0 fail. It printed one `MaxListenersExceededWarning` (11 exit listeners) and left 2 new empty `retest-executor-*` and 2 `retest-macos-*` folders in TMPDIR.
- `node --conditions=retest-source --trace-warnings --test tests/unit/native-macos-app.test.ts`: 27 pass. The 11th exit listener came from a `GroupGuard` in `runCommand` called by `startExecutor`.
- `node -e` stand-ins with no files written:
  - `pollNative` with the last look timing out 2, 4 and 8 ms before its deadline returned `timeout` each time with `actual: "Open"` (N-1).
  - An event-loop delay measure with `OwnedProcess` on `/bin/sleep 4` gave 188 → 120 ticks and p99 6.4 → 50.4 ms. `stop()` reported no problems and nothing was left (N-9).
  - `commandOf` cost 110 ms against 1.7 ms for a plain `ps -p` (N-9).
- A full `ps -axo pid=,ppid=,pgid=,stat=,lstart=,args=` took about 40 ms with 879 processes.
- `~/Library/Caches/retest/macos-desktop.json` still names xcodebuild 29548 and runner 29579 from the last clean run; pids have wrapped on this Mac (N-12).
- TMPDIR holds 56 `retest-executor-*` folders; one contains a staged `result.xcresult` (N-11).
- `log show --last 20h` for `testmanagerd`, `WebDriverAgentRunner-Runner` and `XCTRunner` returned no persisted lines.
- I read WebDriverAgent's `XCUIElement+FBTyping.m:28-31` (event name carries up to 12 characters, `shouldRedact:NO`) and the macOS runner's `/wda/keys` handler (no request logging).
- I ran no integration test and no proof, and did not take the desktop or a simulator.

## Not verified, most important first

1. Whether a killed run's staged result bundle holds the "Type '…'" activity names (N-11). No real run was killed mid-fill.
2. How often N-1 happens on the real simulator; I showed the rule with a stand-in look only.
3. Whether WebDriverAgent or the macOS runner ever echo a 12-character typed prefix in an error message. The redactor removes whole values only, so a prefix would reach failures.
4. How often WebDriverAgent 16.13.6 or the macOS runner 4.3.6 omit `enabled`, `selected`, `traits` or `value` (how real N-2 is).
5. N-12 on the real lock, which needs a reused group-leader pid; reasoned from the code.
6. Which hooks push `native-macos-app.test.ts` past 10 exit listeners: deliberately kept failure hooks, or a leak.
7. The iOS keychain reset (N-34).
8. Debug-level or older unified-log contents.
