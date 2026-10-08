# Fix lane A: native interaction findings

All of the work list is fixed: N-1 to N-8, N-14 to N-16, N-19 (this lane's side), N-20 to N-26, N-28, N-29, N-35. iOS passes on the real simulator. The macOS runner would not start on this Mac this round, so nothing on macOS ran after the fixes.

## Findings

To check the new tests, I put my 8 source files back to their committed form, left the rest of the tree as it stood, and ran the new tests: 29 of 69 failed, each for the reason it names (`/tmp/retest-lane-a/fixes-off-1.log`). The locators file doesn't load against the old code, because the functions it tests are new. With the fixes back: 92 of 92.

- **N-1** `src/native/assertions.ts:255`. Once a look has answered, a later look that times out ends the polling, and the verdict rests on the last look that answered. With no look answered, the result is still `timeout`. Test: "a look that runs out of time a few milliseconds before…". With looks ending 2, 8 and 30 ms early, old code returned `timeout`; new code returns `check_failed` with actual "Open".
- **N-2** `locators.ts:256-382` adds readings that can say "not reported" (`StateReading`, `enabledReading`, `selectedReading`, `checkedReading`, `valueReading`, `visibilityReading`, `textReading`). In `assertions.ts:43-63` the observation holds null for anything not reported. `assertions.ts:100` (`unsupportedCheck`, which the parent also calls) and `:131` (`unjudged`) fail as `check_failed` naming the attribute in `details.unreported`. `actionability.ts:160-167` blocks an action and says what wasn't reported. Tests: "a state the executor did not report passes no check in either direction…" (old code passed `toBeDisabled` on a missing `enabled`), "an element whose tree carries no enabled…", and "an attribute the tree does not carry is not reported" in locators.
- **N-3** `locators.ts:281` makes `valueOf` return the raw attribute. `valueReading` returns `placeholder` for an iOS value equal to the placeholder. `interaction-session.ts:466` works out which reading the fill got. `input.ts:213` (`clearFor`): a placeholder reading always clears first, one delete pair per placeholder character, never the clear route. `input.ts:230` (`readBackProblem`): a read-back that is the placeholder, or a value not reported, fails with the input sent. Tests: "a field holding exactly its placeholder's text is cleared…" (old code: "Accountada"), "a field that reads as its placeholder is cleared…", "a fill whose read-back is the field's placeholder cannot be verified…", and the placeholder case in assertions.
- **N-4** `alerts.ts:163-185`. After a press, only the alert route's own "no such alert" counts as closed. Any other answer fails with `inputSent: 'sent'`, and a tree that couldn't be read is read again. Test: "after an iOS alert press, an alert route answer other than "no such alert"…" (old code returned ok).
- **N-5** `input.ts:239`. A macOS secure field passes only when the read-back after typing shows one masking character per character typed. A field that reads back nothing fails as "sent and could not verify". `not_exposed` is gone from `ReadBack`. Changed test: "a secure field reads back … one that shows nothing after typing fails as unverified with the input sent" (old code passed it). The integration test now requires `length_matched` on TaskDesk.
- **N-6** `keyboard.ts:68-103`. The first-run card is recognised only when the keyboard is up and the card's container sits in the keyboard's own window, or over the keyboard's frame in a window that is not the app's own and holds no alert. Test: "an app's own text about sliding to type with a Continue button is never taken for the keyboard's first-run card" (old code: `firstRunCard: true` with no keyboard up).
- **N-7**
  - Every press of an element Retest picks itself goes through `pressSubject` (`input.ts:133`), which waits for all the usual checks. That covers the return key, the first-run card's Continue and an alert button; `clickTreeElement` is gone.
  - Input with no element goes through `waitUntilAppReady` (`actionability.ts:225`): the window has a frame, no alert is open, the keyboard is not under a point input, the frame is steady, and on macOS the app is in front with nothing over it. That covers a key press with no locator and a scroll or swipe over the app.
  - On macOS, every request of keys first checks the app is in front (`input.ts:161`, `interaction-session.ts:502`).
  - Tests: "on macOS a key with no element goes only while the app is in front…", "on macOS a fill sends no key once the app has left the front…", "a scroll or swipe over the app with no element waits while an alert is open…", "an alert button still moving into place is not pressed…". Old code sent in all four.
- **N-8** `alerts.ts:151`. The alert press reports its failure as an action, and its details are merged rather than replaced. Test: "an alert press that went and got no answer is an unknown outcome…". Old code gave `not_actionable`, dropped `executorError`, and said "stopped before it sent".
- **N-14**
  - `locators.ts:545`: the label and title stay in the predicate next to an identifier.
  - `actionability.ts:357`: on macOS, lookups run inside the owned window, after its identifier is read back.
  - `actionability.ts:370`: an ancestor has its identifier read back before anything inside it is looked up.
  - Tests: "an element whose label changed after the tree was read…" (old code tapped), "an ancestor an element is resolved inside has its identifier read back first…" (old code tapped), and the macOS window lookup in the updated actionability test.
- **N-15** `interaction-session.ts:476-499`. Automation Mode's overlay is passed over only through `coveringWindows`, with `automationOverlayPids`, while the runner session is open: the same rule as the capture check. The pointer layer is passed over only when the window server owns it, which I confirmed on this Mac (WindowServer, pid 601). Each read gets what is left of the time. Test: "on macOS only the full-screen Automation Mode overlay and the window server's pointer pass over an element…" (old code exempted both).
- **N-16** `actionability.ts:188` and `:270`. If the full 100 ms frame gap doesn't fit in the time left, the action fails as not steady in time and no frame read goes out. Test: "an action with too little time left for the whole frame gap…". On old code the frame read went with 1 ms left and timed out in that run; old code didn't click there, but it did send a request on the shortened gap.
- **N-19, this lane's side** `interaction-session.ts:396`, `:402`, `:413`, `:437`. Every request turn and every press first checks the wrapped session's own `cancelled` and `ended`. These are getters lane B has added to `src/native/session.ts`, uncommitted. The `session` property stays. Tests: "a cancel made on the wrapped session directly stops the interaction session too…" and "an element resolved before a cancel made on the wrapped session is not pressed".
  - Lane B's `checkReference` now refuses cancelled references itself, so the old wrapper passes these tests on the current session.
  - On the committed session, both tests fail with the old wrapper (`/tmp/retest-lane-a/fixes-off-n19.log`).
  - On lane B's session with that refusal taken out, they pass with my wrapper and fail with the old one (`/tmp/retest-lane-a/n19-mine-without-laneb.log`, `n19-old-without-laneb.log`).
- **N-20** `interaction-session.ts:270`. I kept `pressResolved`. It refuses a stale handle, then re-runs full actionability on a fresh tree using the handle's locator (`ResolvedElement.locator`, new), and clicks the element that check resolves. Test: "a resolved element is checked again before it is pressed…" (old code clicked a disabled button).
- **N-21** `webdriver-client.ts:207` adds `ExecutorSession.markEnded`, and `ExecutorElements` now shares the session's ended state (`:524`, `:594`). Test: "once a lookup learns the executor no longer knows the session…" (old code sent the click).
- **N-22**
  - In the stand-in (`tests/unit/native-interaction-fake.ts`, the after hook), a disposal that fails now fails the test unless the test names the failure it expects (`disposal` option).
  - Both `afterEach` hooks in the integration test now collect disposal failures and assert there are none.
  - Shown with a scratch test where the executor never answers its session end: the old stand-in passed, the new one failed (`/tmp/retest-lane-a/n22-disposal.log`).
- **N-23**
  - Both cancel tests now require all three readings to equal the typed length (real iOS: 160, 160, 160).
  - The proof's wrong-state step checks `details.element`.
  - The system-alert unit test checks ok and that the alert closed.
  - The iOS resolve test checks the frame gap is at least 100 ms. With the gap removed it fails: "read again 5 ms after the tree" (`/tmp/retest-lane-a/n23-gap-mutation.log`).
- **N-24** In `tests/integration/native-interaction.test.ts`, only ENOENT counts as a missing build; other errors fail the file. The title is narrowed. No demonstration run.
- **N-25** `docs/plans/public-beta/proofs/native-interaction.md` is corrected: 11 tests, not 12; the macOS "count" step was a text check; macOS toggles, sliders and steppers are added to the value table; the real iOS clear is now exercised. It also records the new rules and a "Phase 2 review fixes" section.
- **N-26** `assertions.ts:91` types `selected` with no widening to unknown. `webdriver-client.ts:19` and `:40` point at both route lists. Typecheck only, no behaviour test.
- **N-28** `keyboard.ts:124` (`readTreeSteadily`): the keyboard wait, the waits after a press, and the alert reads and waits all read a tree again when it can't be read, for example when another app's tree is served in passing. Test: "a tree of another app read in passing is looked at again…" (old code failed at once).
- **N-29** `keyboard.ts:169`: macOS refuses by name. Test: "a macOS app has no first-run card either…" (old code passed with nothing sent).
- **N-35** `proofs/native/interaction.ts` now uses `opened.client` and `opened.executor`. The `/status` attach helper is gone, and so is `attachExecutorSession` in `webdriver-client.ts`, which had no other user.

## What the real targets showed

- **N-2, iOS (WebDriverAgent 16.13.6, TaskPhone):**
  - `enabled`, `visible` and `traits` were present on every element of the sign-in, keyboard and task screens (60 to 137 elements a tree).
  - `value` was absent wherever it is empty: Application, Window, Other, Cell, Key, Keyboard, most Buttons, and static texts with empty text.
  - An empty field writes its placeholder as its value.
- **N-2, macOS:** not read, because the runner didn't start. From its source (`FBXPath.m`), the runner writes `enabled` and `selected` on every element and leaves out a `value` that XCTest gives none.
- **N-3:** no real signal tells the two cases apart. An empty account field and the same field holding "Account" give the same tree (`value="Account" placeholderValue="Account" label="" traits=""`) and the same attribute-route answers for `value`, `placeholderValue`, `label`, `name`, `traits`, `focused` (false even while it took keys), `selected`, `accessible` and `hittable`. With the old code, the next fill typed onto the old text and read back "Accountada", which is the review's scenario reproduced on the real simulator.
- **N-5:** not checked on the real TaskDesk, for the same reason.
- iOS windows read `hittable` true, and the app has three windows while the keyboard is up.

## Existing tests that change behaviour (N-3, N-5, N-14, N-24)

**N-3** — none of these was a real pass, because an empty field and a field holding the placeholder's text give the same reading (the real simulator above shows it):
- "an empty field is typed into without a clear; its placeholder is not taken for text" is replaced by "a field that reads as its placeholder is cleared before typing…". Its pass skipped the clear on a reading that a field holding "Account" also gives.
- "enabled, disabled, value and count …, an iOS placeholder reading as an empty value" is renamed; `toHaveValue('')` on the placeholder field now fails. That pass rested on a reading a field holding "Title" also gives.
- "an iOS field's placeholder, written as its value while it is empty, reads as empty; …" is renamed; it asserted the mapping that is itself the false claim.

**Other renamed or changed tests:**
- N-5: "a secure field … one that shows nothing is said unread" is renamed; that pass rested on no evidence.
- N-14: "the executor is asked by an exact predicate …" is renamed to add "the label kept beside an identifier".
- Predicate strings in the actionability, keyboard-alerts and locators tests now include the label and the window lookup. These assertions are stricter, not looser.
- N-24: "TaskPhone and TaskDesk declare no privacy usage, so no permission can be asked or denied in this suite" is narrowed to what the plist test shows.

## What I need from other lanes

- **Runner lane, `tests/unit/api-native-helpers.test.ts`** (3 failures, predicate strings only):
  - line 271: expect `'type == "XCUIElementTypeButton" AND name == "sign-in-button" AND label == "Sign in"'`
  - line 312: second item `'type == "XCUIElementTypeButton" AND name == "Return" AND label == "done"'`
  - line 372: read `fake.app.on('POST /session/:session/element/:element/elements')` in place of `on(elements)`
  - Checked in a scratch copy: 41 of 41 pass (`/tmp/retest-lane-a/api-native-helpers-proposed.diff`, `.log`).
- **Lane B, `src/native/session.ts`:** keep the `cancelled` and `ended` getters. My wrapper depends on them for N-19.
- **Lane B, `src/native/session.ts`:** `readFieldSource` now receives the raw `value` from `valueOf`, so the placeholder is no longer mapped to empty. Its "exposes no field value" refusal now only fires for element types that hold no value. No change is needed there.
- **Not mine, not run by me:** `tests/integration/native-secrets.test.ts` and `native-evaluation.test.ts` use this layer, and their fills now clear placeholder fields first.

## Gates (every log under `/tmp/retest-lane-a/`)

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` | 342 of 342. An earlier run had 1 failure in lane B's `native-processes` test while they were editing | `unit-native-all-2.log` (earlier: `unit-native-all-1.log`) |
| `npm run test:types` | 236 of 236 markers on both compilers. An earlier run failed only in `src/browser/webkit` | `test-types-2.log` |
| `lockf … npm run typecheck` | exit 2. Errors only in `src/agent/host.ts`, `src/cli/doctor/checks.ts` and `tests/unit/agent-recipes.test.ts`; none in native files or proofs | `typecheck-3.log` |
| `lockf … node_modules/typescript-7/bin/tsc -p tsconfig.json` | errors only in other lanes' files | `typecheck-ts7-1.log` |
| `lockf … npm run typecheck:proofs` | clean on both compilers | `typecheck-proofs-1.log` |
| `lockf … node --conditions=retest-source --test --test-name-pattern="real iOS simulator\|TaskPhone\|Info.plist" tests/integration/native-interaction.test.ts` | 6 of 6 on the real simulator | `integration-ios-1.log` |
| the same file's macOS half | failed in setup: "WebDriverAgentRunner-Runner … Test crashed with signal abrt before establishing connection" | `integration-macos-1.log` |
| `lockf … node --conditions=retest-source proofs/native/interaction.ts --only ios` | 9 of 9 steps; no password in the report | `proof-ios-1.log` |
| the runner tests that use this layer (`runner-native-*`, `api-native-helpers`) | 66 of 69; the 3 failures are the predicate strings above | `unit-runner-native-2.log` |

## Artifacts

- `/Users/dragon/Library/Caches/retest-proofs/artifacts/interaction/2026-10-05T08-25-36Z/` (screenshots: keyboard up, created task; `report.json`)
- Logs under `/tmp/retest-lane-a/`

## Not verified, most important first

1. Everything on macOS after the fixes. The runner aborted at its App Sandbox start all 4 times I tried, including from the committed source, before any interaction code runs; the build is unchanged since 3 October. Untested on a real desktop as a result: window anchoring, the overlay and pointer rules, keys only while in front, the masked read-back (N-5, so "honest TaskDesk sign-in still passes" is not proven), and the macOS `toHaveValue('')` step (if the runner omits an empty field's `value`, that step will now fail by design).
2. Which attributes the macOS runner leaves out: read from its source only.
3. Alerts and the first-run card on real trees: neither fixture shows them.
4. TypeScript 7 and the full `npm run typecheck` didn't reach a clean exit because of other lanes' files.

## Files changed

- `src/native/locators.ts`, `actionability.ts`, `input.ts`, `keyboard.ts`, `alerts.ts`, `assertions.ts`, `interaction-session.ts`, `webdriver-client.ts`
- `tests/unit/native-locators.test.ts`, `native-actionability.test.ts`, `native-input.test.ts`, `native-assertions.test.ts`, `native-keyboard-alerts.test.ts`, `native-interaction-fake.ts`
- `tests/integration/native-interaction.test.ts`
- `proofs/native/interaction.ts`
- `docs/plans/public-beta/proofs/native-interaction.md`

No dependency, script or environment change. My scratch work in `.retest/scratch-native-interaction/` and its kept logs were removed. The two known `native-fake-tool.ts runner-app` leftovers and another agent's booted simulator were left alone.
