# Phase 2 findings held for the end-of-phase fix round

Findings from the per-lane reviews that were still in flight when the method changed to one review per phase. Each is routed to an Opus or GPT builder after the whole-phase Fable review, together with that review's findings. Source reports: `../codex/review-identity-fixes-report.md` (GPT-6.1 Sol), `../codex/review-native-locators-report.md` (GPT-6.1 Sol, when it lands).

## Identity and capture (GPT-6.1 Sol second look)

1. High. `src/runner/running-test.ts:536` accepts duplicate evaluation ids: a forged process starts a screenshot check, then a text check with the same id; the text check's answer deletes the screenshot check's hold and an action is allowed while that check still runs. Refuse a duplicate id as a protocol violation; test with two checks sharing an id.
2. Medium. `tests/integration/cli-harness.ts:222`: the inherited cleanup signals every remembered browser group even after it exited, with no command-line or ownership check, so a reused group id could be killed. Check before signalling, as the native code does.
3. Medium. `src/browser/capture.ts:98`: when start rejects with two frames waiting, the second is cleared without being delivered or counted. Count it as dropped.
4. Medium. `src/media/capture.ts:264`: a recording failure during failed-start cleanup is overwritten by the capture failure, losing the media-loss explanation. Keep both reasons.
5. Medium. `src/media/capture.ts:237`: an already-aborted signal still starts the recording and the source. Check the signal before starting anything.
6. Medium. `src/browser/page.ts:347`: `identify` retains only part of the owner; a second call changing only `owner.runId` succeeds, and empty owner strings pass when the session id matches their concatenation. Compare the whole owner and refuse empty parts.
7. Medium. `src/media/capture.ts:409`: the frozen report still shares `identity`, `capture`, `started` and `ended` as mutable objects; `page.ts:366` exposes the stored identity object. Freeze deeply or copy.
8. Low. `docs/plans/public-beta/proofs/identity.md:158` says every revert failed or hung, but the failed-start mutation log records 22 passes and no failure, so the 16-frame cap has no regression test. Add the test and correct the record.

Confirmed by that review: items 1, 2, 4 (stop in flight), 5, 6, 7, 10, 12, 13, 14, 15 of the lane's fifteen fixes; a legitimate look on another app still runs; the four unit files pass 55 of 55.

## Native locators, input and assertions (GPT-6.1 Sol review, the lane's first)

Twenty-one findings, thirteen high; the full text is kept here verbatim from the report so the fix round works from the reviewer's own words.


1. **High: native secret redaction has gaps.** [interaction-session.ts:413](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:413) parses XML after `readSource` redacts it. An XML-escaped secret containing `&` survives that redaction and becomes plaintext when attributes are decoded. [interaction-session.ts:480](/Users/dragon/Documents/Projects/retest/src/native/interaction-session.ts:480) also copies executor messages into returned failures and ledger entries without redaction. An executor error that quotes typed text therefore exposes it.

2. **High: secret typing reaches an unredacted XCTest event.** [input.ts:253](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:253) sends secret input through `/wda/keys`. The pinned [typing helper:28](/Users/dragon/Library/Caches/retest-proofs/WebDriverAgent/WebDriverAgentLib/Categories/XCUIElement+FBTyping.m:28) puts a prefix of that text in the event name and sets `shouldRedact:NO`. Redacting Retest’s messages does not protect this executor record; executor output and result bundles also bypass the session redactor.

3. **High: dispatched input is absent from the ledger while awaiting its answer.** [input.ts:146](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:146) and [alerts.ts:121](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/alerts.ts:121) record only after awaiting the request. `aboutToSend` merely notifies listeners. Cancel followed immediately by [reconcile:314](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:314) can return a ledger missing an outstanding click; disposal likewise does not drain the wrapper’s input lane. The existing tests await dispatch before examining the ledger.

4. **High: the integration tests can signal an unrelated process.** [native-interaction.test.ts:274](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:274) and [line 457](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:457) call `process.kill` on stored pids without checking their recorded command lines. If a runner exits and its pid is reused, the test kills the replacement process.

5. **High: callers can bypass the wrapper’s lane and cancellation.** [interaction-session.ts:129](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:129) exposes the underlying session. Calling `interaction.session.cancel(...)` leaves the wrapper’s cancellation signal live. A previously resolved element can subsequently be pressed because the underlying reference check does not check cancellation. Direct lifecycle calls can also overlap wrapper input.

6. **High: resolved handles bypass current actionability.** [interaction-session.ts:248](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:248) resolves with `enabled: false`; [pressResolved:263](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:263) then clicks without another tree, enabled, frame, hittable or coverage check. [session.ts:320](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/session.ts:320) checks the launch and session but not observation freshness. A disabled element, or an old handle now covered by another window, can still receive input.

7. **High: executor resolution is not anchored to the owned macOS window.** [locators.ts:506](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/locators.ts:506) uses a global lookup whenever the scoped tree contains one match. If that element disappears while another window contains the same identifier at the same frame, global resolution can return the other window’s element and pass the identifier/frame checks. Ancestor resolution at [actionability.ts:200](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/actionability.ts:200) also lacks ancestor identity read-back. Additionally, identifier-based resolution drops label constraints: a button can change from Save to Delete after the tree read and still satisfy the executor predicate.

8. **High: ordinary app content can be mistaken for the keyboard card.** [keyboard.ts:64](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/keyboard.ts:64) searches all static text and climbs ancestors up to the app root. An app containing “slide to type” and one Continue button matches even without a keyboard. `dismissKeyboard` can consequently press that app button automatically.

9. **High: a failed alert read becomes a successful closure check.** [alerts.ts:148](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/alerts.ts:148) treats every answer other than `answered` as “not open.” After pressing a system alert absent from the scoped tree, a timeout, unreadable answer or connection loss makes `answerAlert` return success. Only an explicit `no such alert` answer establishes absence.

10. **High: an unreadable secure-field result passes fill.** [input.ts:192](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:192) returns success when a macOS secure field reads back empty, recording `not_exposed`. If the field rejected the input or focus moved elsewhere, that same empty reading passes. The record states the limitation, but the returned verdict still treats an unverified required outcome as successful.

11. **High: placeholder equality can produce a false value assertion.** [locators.ts:251](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/locators.ts:251) converts a value equal to its placeholder into empty text. A user actually typing “Account” into a field whose placeholder is “Account” makes `toHaveValue('')` pass. A subsequent fill can also omit clearing that existing text and append to it.

12. **High: missing state attributes become observed false states.** [locators.ts:283](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/locators.ts:283) treats absent `selected` or `traits` attributes as unselected, so `.not.toBeSelected` passes without selection evidence. The same problem affects missing `enabled` at [line 274](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/locators.ts:274) and missing field `value` at [line 248](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/locators.ts:248): disabled or empty assertions can pass on unavailable observations.

13. **High: several input paths skip actionability altogether.** [input.ts:129](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:129) clicks keyboard/card/sheet buttons without steady-frame or hittable checks. Locator-free press at [line 273](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:273) and scrolling/swiping at [line 364](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/input.ts:364) also omit alert and coverage checks. A moving sheet or a covered app can therefore receive input through these entry points.

14. **Medium: the action bound and frame-spacing requirement are not enforced throughout.** [actionability.ts:137](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/actionability.ts:137) shortens the required 100 ms gap when little time remains, then continues checking and can dispatch afterward. Recursive resolution reuses one timeout snapshot across multiple requests; [frontProblem:424](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:424) likewise gives several sequential operations the same remaining allowance. Frames differing by less than half a point are also accepted as equal.

15. **Medium: Automation Mode exclusion is broader than the observed exception.** [interaction-session.ts:438](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/interaction-session.ts:438) ignores every window owned by the AutomationModeUI process, regardless of layer or extent. It ignores pointer-layer windows regardless of owner. Another covering window from that process is therefore exempted even when it is not the observed full-screen overlay.

16. **Medium: element-client session loss does not stop the attached input client.** [webdriver-client.ts:600](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/webdriver-client.ts:600) sets only `ExecutorElements.#ended`. After an element request receives `invalid session id`, the supplied `ExecutorSession` still considers itself live and can send click or keys requests directly. This contradicts the stated shared-ended-state guarantee.

17. **Medium: cleanup failures can disappear from a passing integration run.** [native-interaction.test.ts:119](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:119), [line 290](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:290) and [fake teardown:609](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/native-interaction-fake.ts:609) swallow disposal errors. For example, a failed executor-session cleanup can be forgotten after the lifecycle session releases itself, even if later runner cleanup succeeds.

18. **Medium: several assertions do not establish their titles.** The cancellation tests at [native-interaction.test.ts:266](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:266) and [line 450](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:450) accept any positive, stable field length; duplicated typing completed before sampling still passes. [wrongState:101](/Users/dragon/Documents/Projects/Gruvi/Products/retest/proofs/native/interaction.ts:101) never checks the promised element details, so removing them leaves the proof green. The system-alert unit test at [line 124](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/native-keyboard-alerts.test.ts:124) checks dispatch state without checking successful completion or closure. The frame test checks request order without checking spacing.

19. **Medium: a green integration-file exit does not establish native execution, and one skip is imprecise.** [native-interaction.test.ts:31](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:31) labels every fixture-access error “missing,” including access failures. Both native suites can skip while the standalone plist test passes without an executor. Its [title:103](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/native-interaction.test.ts:103) also claims absence of permission requests from plist keys alone.

20. **Medium: the record overstates some evidence and its value mapping differs from code.** [native-interaction.md:185](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/native-interaction.md:185) claims 12 integration tests; the file and cited log contain 11. [Line 23](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/native-interaction.md:23) claims real macOS count-check coverage, but the task-count assertion checks text. The saved proof has no iOS clear entry; replacement clearing rests on the discarded exploration described in the record. [Line 131](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/native-interaction.md:131) omits sliders, steppers and macOS toggles that `valueOf` accepts.

21. **Low: two source contracts need correction.** [assertions.ts:83](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/assertions.ts:83) explicitly widens the selected value to `unknown`, against the house rule and hiding changes to its known observation type. [webdriver-client.ts:19](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/webdriver-client.ts:19) still calls `ExecutorRoute` the complete route inventory; an audit using it alone now misses the appended routes.

Confirmed sound by that review: no route that repeats input, no automatic repeat of typing, clearing, clicking or alert answers, the clear sequences as recorded, count mismatches refused, identifier read-back per platform, the web checks reused, stale references refused, the integration suites built on real executors, the five unit files 56 of 56.

## Noted by the Opus loose-ends builder in code it did not edit

1. `src/protocol/commands.ts:285`: the alert description drops the button, so a report reads `page.alert.accept()` when the test wrote `page.alert.accept('Allow')`.
2. `src/runner/running-test.ts:748`: `actionDetails` records no swipe direction, keyboard operation or alert button, so `keyboard.wait()` and `keyboard.dismiss()` leave identical events; the event schema has no field for them.
3. `src/api/test-run.ts:201`: options are read under the command kind, so a bad option names `nativeKeyboard()` or `nativeAlert()`; worked around in `app-page.ts` only.
4. `src/reporters/run-record.ts:79` with `human.ts:84-85`: the header reads the first `browser.started` to arrive, and browsers no longer start in a fixed order, so it can drop "· 2 browsers".
5. `src/runner/resources.ts:468-484`: the case probe is written into the parent of the data folder, so a writable folder under an unwritable parent is refused.
6. `src/native/keyboard.ts:119`: `dismissFirstRunCard` has no macOS check and passes silently there (types block it; JavaScript callers can reach it).
7. `docs/guide.md:210` still says the public helpers are unfinished.
8. `src/index.ts` does not export the new public types (`NativeLocatorStep`, `NativeStepPick`, `SwipeDirection`, `NativeKeyboard`, `Alert`).

## Seen by the native secrets builder in code it did not edit

1. `tests/integration/native-interaction.test.ts`, the TaskPhone text and secure field case: the deliberate wrong-state check came back `timeout` where the assertion requires `check_failed`, so a native assertion that polls to its bound on a real mismatch is classed as a timeout rather than a failed check. Native assertion code (`src/native/assertions.ts`), to be fixed in the phase's fix round; the assertion was not changed.
2. The same case once failed its initial keyboard wait because the source tree belonged to another app (SpringBoard) during the transition; observation retries were added, input still dispatches once.

## Noted by the reference flow builder

1. `docs/guide.md` still says native secret input is refused; it is accepted when `secretOrigins` names the app's bundle id.
2. `fixtures/cross-platform/tests/native-phone.retest.ts:28`: the deliberate wrong-state check's 300 ms budget is shorter than one iOS tree read (0.5 to 1.6 s), so it ends `timeout` rather than `check_failed`; and a native check that reaches its bound on a real mismatch should still be classed `check_failed` when the last observation showed the mismatch (same root as the earlier native-interaction finding).
3. No native element's text can be read through the public API; the smallest addition is `textContent()` on `NativeLocator` in `src/api/page.ts`, implemented in `src/api/app-page.ts` over one observed element.
4. `src/runner/native-pool.ts` and `src/runner/secrets.ts` were edited by this lane beyond its named files (the pool's own refusal and the resolver's web-only origin check); recorded here so the review reads them.

## Noted by the native diagnostics wiring builder

1. Two simultaneous runs reading one network metadata file are not guarded; the config check holds within one run only.
2. A macOS logged launch gives the app only its declared environment, and a SIGKILL of the Retest process leaves that app running until the next start's recovery.
3. The iOS logged launch relies on WebDriverAgent's own choice of the active app, as the executor launch does; "tree of another app" was seen once in the broken-sync variant.
4. Closing the phone runtime hit `ps ETIMEDOUT` in `src/shared/process-ownership.ts` (a 1 s timeout) in two of three runs; whether the logged launch contributes is not established.
