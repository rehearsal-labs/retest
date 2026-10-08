# Native finds, input and checks

Phase 2 item 2 of [release-0.1.0.md](../release-0.1.0.md), 4 October 2026. It builds the interaction half of native sessions in `src/native/` on the route [native.md](native.md) recommends: exact routes only, one match per action and check, actionability as hittable plus a steady frame, observations from the session's own scoped tree. It sits on the lifecycle half the native sessions lane built and edits none of its files; nothing here is wired into the runner, the contract's driver table or the test API yet.

## Result

| Capability | iOS simulator, TaskPhone | macOS, TaskDesk |
| --- | --- | --- |
| Test id, read back from the element | exercised | exercised |
| Missing identifier fails as a locator failure, never a label or a point | exercised | exercised |
| Role, label, text, scoped steps, `first`/`last`/`nth` | unit tests only | unit tests only |
| Strict count, and the executor's count checked against the tree's | exercised on the passing path; mismatch unit-tested | same |
| Tap / click, once | exercised | exercised |
| Fill: Retest's own clear and type, read back | exercised, text and secure field; every field showing its placeholder cleared before typing, which is the real iOS clear | exercised, text and secure field, before the review fixes; not run after them, see "Phase 2 review fixes" |
| Press: named keys | unit-tested only | `Enter` and `Backspace` exercised |
| Press: chord | refused by name (no route) | `Meta+A` exercised |
| Scroll | W3C drag unit-tested; one drag sent on the real simulator during exploration | exercised: a hidden row became visible |
| Swipe | unit-tested; the same W3C route as the drag above | refused by name |
| Software keyboard: comes up, dismissed by its return key | exercised | not applicable, refused by name |
| First-run card about sliding to type | did not show on TaskPhone; handling unit-tested only, including an app's own "Continue" never taken for it | not applicable, refused by name |
| Alerts: read, answer one named button | no-alert path exercised; answering unit-tested only | no-alert path exercised; answering unit-tested only |
| Alert closed after the press | unit-tested only: only the alert route's own "no such alert" counts as closed | unit-tested only |
| Alert blocking an action | unit-tested only | unit-tested only |
| Checks: visible, hidden, enabled, text, value, count | text, by string and by pattern, exercised; the rest unit-tested | text, value, visible and hidden exercised; the task count was read as text (`toHaveText('33 tasks')`), so `toHaveCount` and enabled are unit-tested only |
| A state the tree does not report, or a value equal to the placeholder | the placeholder case read on the real simulator (identical trees, see below); checks on either unit-tested | unit-tested only |
| Selected and checked state | unit-tested only | unsupported naming exercised; selected unit-tested only |
| Wrong state fails naming the element | exercised | exercised |
| Stale reference after a relaunch refused, nothing sent | exercised | exercised |
| Cancel after a dispatched typing: unknown outcome, nothing typed again | exercised | exercised |
| Lost executor during a lookup is `session_lost` | exercised | exercised |
| Denied permissions | cannot be provoked: neither fixture declares a privacy usage | same |

"Exercised" means on the real executor in `tests/integration/native-interaction.test.ts` or `proofs/native/interaction.ts`; "unit tests only" means against the stand-in executor in `tests/unit/native-interaction-fake.ts`, which proves the protocol and nothing about the platform.

## What exists now

| File | What it does |
| --- | --- |
| `src/native/locators.ts` | Parses the scoped tree; the element type table, the role table, test id, label, name, text, value, visibility, enabled, selected and checked per platform; `locate` with scoped steps and picks; the exact predicate that names an element to the executor and the plan that resolves it, inside an ancestor when its own keys match more than one |
| `src/native/actionability.ts` | `waitUntilActionable`: one match, visible, enabled where the action needs it, no alert over it, no keyboard over it, resolved with the executor's count equal to the tree's, identifier read back, two reads of its frame equal, hittable, and on macOS the app in front with no window of another process at its centre |
| `src/native/input.ts` | Tap, click, fill, press, scroll and swipe, each request sent once and recorded, with how far it got |
| `src/native/keyboard.ts` | The software keyboard: up or not, the first-run card, the return key, waits |
| `src/native/alerts.ts` | Alerts and sheets in the tree, WebDriverAgent's alert routes, blocking, answering one named button |
| `src/native/assertions.ts` | The observation of a locator from the tree, the web's checks plus `toBeSelected`, refusals as `unsupported`, the poll |
| `src/native/interaction-session.ts` | `NativeInteractionSession`: wraps a `NativeAppSession` as the contract's `NativeSession<NativeCommand>`, one request at a time, the input ledger, reconciliation, cancel |
| `src/native/webdriver-client.ts` (appended) | `ElementRoute`, `elementRoutes`, `ExecutorElements` and `attachExecutorSession`; no existing line changed |

## Routes

The client's own routes the interaction layer sends:

| Route | Used for | Executor |
| --- | --- | --- |
| `POST /session/:session/element/:element/click` | iOS tap, macOS click | both |
| `POST /session/:session/wda/keys` `{ keys: [...] }` | macOS keys: each item one XCTest `typeKey` with its modifier flags | macOS runner |
| `POST /session/:session/wda/keys` `{ value: [text] }` | iOS typing: one synthesized typing of the text | WebDriverAgent |
| `POST /session/:session/actions` | iOS scroll and swipe as W3C touch actions | WebDriverAgent |
| `GET /session/:session/source` | every look, through the session's scoped, redacted tree | both |
| `GET /session/:session/window/rect` | the main screen, for the covering check | macOS runner |
| `POST /session/:session/wda/apps/state` | the app in front, through the session | both |

Appended to `webdriver-client.ts`, listed as `elementRoutes` beside the sixteen of `executorRoutes`:

| Route | Used for | Input |
| --- | --- | --- |
| `POST /session/:session/elements` | resolving an element by an exact predicate | none |
| `POST /session/:session/element/:element/elements` | resolving inside an ancestor | none |
| `GET /session/:session/element/:element/attribute/:name` | identifier read-back, `hittable`, `focused` | none |
| `GET /session/:session/element/:element/rect` | the second read of the frame | none |
| `GET /session/:session/alert/text` | an alert's text, system alerts included | none |
| `GET /session/:session/wda/alert/buttons` | an alert's button labels | none |
| `POST /session/:session/alert/accept` `{ name }` | one tap on the named button | one tap |
| `POST /session/:session/alert/dismiss` `{ name }` | one tap on the named button | one tap |
| `POST /session/:session/wda/element/:element/scroll` | macOS scroll: one XCTest `scrollByDeltaX:deltaY:` | one scroll |

Never called: `/element/:id/value` and `/element/:id/clear` (both executors type, read back and type again inside them), and WebDriverAgent's `/wda/keyboard/dismiss`, which taps every key whose identifier or label it was given until the keyboard hides, so it can press more than once (`XCUIApplication+FBHelpers.m`). The macOS runner's W3C actions take mouse, key and none sources, no wheel (`FBW3CActionsSynthesizer.m`), so a macOS scroll uses its element scroll route instead; it has no alert routes at all.

The existing test in `tests/unit/native-webdriver-client.test.ts` still counts sixteen `executorRoutes`; `tests/unit/native-input.test.ts` counts the nine new ones and checks none of them types, clears or repeats.

## Mapping tables

### Element types

The tree's tags carry XCTest's type name after `XCUIElementType`; the macOS runner's predicates take its number, WebDriverAgent's the full name. `elementTypeNumbers` holds all 83, checked against `XCUIElementTypes.h` of Xcode 26.5.

### Roles

| ARIA role | iOS | macOS |
| --- | --- | --- |
| `button` | Button | Button |
| `textbox` | TextField, SecureTextField, TextView | TextField, SecureTextField, TextView |
| `searchbox` | SearchField | SearchField |
| `checkbox` | none | CheckBox |
| `switch` | Switch, Toggle | Switch, Toggle |
| `radio`, `radiogroup` | none | RadioButton, RadioGroup |
| `list` | Table, CollectionView | Table, Outline, CollectionView |
| `listitem`, `cell`, `gridcell` | Cell | Cell |
| `row` | none | TableRow, OutlineRow |
| `tree`, `treeitem` | none | Outline, OutlineRow |
| `img` | Image | Image |
| `link` | Link | Link |
| `tab`, `tablist` | Tab, TabBar | Tab, TabGroup |
| `menu`, `menuitem` | Menu, MenuItem | Menu, MenuItem |
| `combobox` | none | ComboBox, PopUpButton |
| `dialog` | none | Dialog, Sheet |
| `alert`, `alertdialog` | Alert | Alert |
| `slider`, `spinbutton`, `progressbar` | Slider, Stepper, ProgressIndicator | Slider, Stepper, ProgressIndicator and LevelIndicator |
| `navigation`, `toolbar`, `scrollbar` | NavigationBar, Toolbar, ScrollBar | none, Toolbar, ScrollBar |

Every other role, `heading` and `paragraph` among them, is refused as `unsupported`, naming the role and the platform. Static text has no role; `getByText` and `getByTestId` find it. On iOS 26.5 SwiftUI lists come out as CollectionView with Cell children; on macOS 27 a SwiftUI `List` is an Outline of OutlineRows holding Cells.

### What each finder reads

| Finder | iOS (WebDriverAgent) | macOS (runner) |
| --- | --- | --- |
| `getByTestId` | `name`, only where it differs from `label`: WebDriverAgent writes the label as `name` when the identifier is empty (`wdNameWithSnapshot`), so a `name` equal to the label is not counted, and a lookup that finds only such elements says so | `identifier` |
| `getByRole(name)` | `label` | `label`, else `title` |
| `getByLabel` | `label` of the labelled control types (the roles the web's `getByLabel` finds) | the same |
| `getByText` | static text's `value`, else `label`; other elements' name; never a field; innermost match | the same, with `title` |
| Read-back of a test id on the resolved element | `attribute/name` equal to the id and `attribute/label` not | `attribute/identifier` |

Text compares with the web's own `matchesText`: exact and case-sensitive on whitespace-normalised text by default, a case-insensitive part with `exact: false`, a pattern searched for. CSS, placeholders and Playwright's dialect are refused by name.

Observed on the real fixtures: TaskPhone's SwiftUI text and secure fields have an empty `label` and their title as `placeholderValue`, so `getByLabel('Account')` finds nothing on iOS; TaskDesk's fields have no label either, their caption being a separate static text. Both are found by test id.

### What each check reads

| Check | iOS | macOS | Elsewhere |
| --- | --- | --- | --- |
| visible | `visible`, WebDriverAgent's own judgement | a frame with area inside the window and inside every enclosing ScrollView: the runner writes no visibility, and a list keeps rows scrolled out of view in its tree | |
| enabled | `enabled` | `enabled` | containers often read `false` on macOS |
| text | as `getByText` reads it | the same | a field: `unsupported` |
| value | a field's text; a value equal to the field's placeholder cannot be told from an empty field, so no value check passes on it either way; a toggle's `0`/`1` | a field's text; a toggle's, slider's or stepper's value | anything else: `unsupported` |
| selected | the `Selected` trait of Button, Cell, Tab | `selected` of Cell, TableRow, OutlineRow, Tab | any other type: `unsupported`, so `not.toBeSelected` never passes on a text |
| checked | Switch, Toggle value | CheckBox, RadioButton, Switch, Toggle value | anything else: `unsupported` |
| count | matches | matches | |

An attribute the tree does not carry is not reported, never false or empty: the observation holds null, no check on it passes in either direction (`toBeDisabled` and `.not.toBeSelected` included), and once the check gives up it fails as `check_failed` naming the attribute (`details.unreported`); the parent's judgement through `unsupportedCheck` names the same. What the executors leave out was read before choosing that wording: on the real simulator, WebDriverAgent 16.13.6 wrote `enabled`, `visible` and `traits` on every element of TaskPhone's sign-in, keyboard and task screens (from 60 to 137 elements a tree), and left `value` out of every element that holds none and of static texts with empty text; an empty iOS field writes its placeholder as its value (`wdValue` falls back to `placeholderValue`), and one with no placeholder writes none. The macOS runner 4.3.6 could not be started for this round (see "Phase 2 review fixes"); by its source (`FBXPath.m`) it writes `enabled` and `selected` on every element and leaves out a `value` XCTest gives none.

The matchers the web has keep its rules, `.not` included, through `locatorCheck`; `toBeSelected` is a native check of one element. The poll is the web's: looks at once and after 50, 100, 250 and then every 500 ms, the last at the deadline, and a failure says how many times it looked. A check the platform cannot judge on the element that matched fails at once as `unsupported`.

## Actionability

Each look reads the session's scoped tree and requires, in order: exactly one match (several fail at once as `ambiguous`), no alert open outside it, visible, enabled for tap, click, fill and press (a visibility or enabled state the tree does not report blocks, naming it), no software keyboard over its centre (the keys or the suggestions bar above them), a frame with area; then the executor resolves it with the exact predicate, which keeps the label and title beside an identifier, and its count must equal the tree's; on macOS every lookup runs inside the owned window, resolved first with its identifier read back; an ancestor it is resolved inside has its identifier read back before anything is looked for in it; the element's identifier reads back, the frame read through `rect` the whole 100 ms after the tree's equals the tree's, `hittable` reads true, and on macOS the app is in front (state 4) and no window of another process lies at the element's centre. Passed over, as the capture's check passes them: Automation Mode's overlay only when it covers the whole screen, belongs to the exact system process and a runner session is open, and the pointer's own window only when the window server owns it. With less time left than the frame gap, the action fails as not steady in time and nothing is sent. Every input on an element passes here, a test's locator or an element Retest picks itself (the keyboard's return key, the first-run card's Continue, an alert's button). Input on the app as a whole, a key with no element or a scroll or swipe over the app, passes the checks that mean something without an element: the window has a frame, no alert is open, the keyboard is not where a point input lands, two reads of the window's frame the whole gap apart agree (on macOS through the resolved window, on iOS through a second tree, since the app's windows cannot be told apart by a predicate there), and on macOS the app is in front with nothing over the window's centre. Anything unready waits with pauses from 20 ms doubling to 200 ms, as the web's actions do, and the failure names what was not true. A tree that could not be read yet, as TaskDesk's just after a launch before its window is in the tree, is looked at again.

Why the window check stays on macOS: an element under another app's floating window at layer 1000 read back as hittable here, so `hittable` alone does not show a covering window. Why Automation Mode's overlay is excepted: while the runner drives the desktop, macOS lists `AutomationModeUI` with a window over the whole screen at layer 1000, and every click the runner sent landed with it in place.

## Input

| Action | iOS | macOS |
| --- | --- | --- |
| tap / click | one `/element/:id/click`; `click` refused on iOS, `tap` on macOS | the same |
| fill | one tap to focus; a short wait for the keyboard; read the field; when it holds text, or reads as its placeholder (an empty field and one holding the placeholder's text read alike), one `/wda/keys` of a backspace and a forward delete per character read (`"\b\u007f"` × n, the placeholder's length for a placeholder reading), then a read that must not show text left; the text in one `/wda/keys`; a read-back that must show exactly the text, so a read-back equal to the placeholder fails as unverified with the input sent | one click to focus; `focused` must read true; read the field; when it holds text, reads as anything but plain text, or always for a secure field, one `/wda/keys` `[{ key: 'a', modifierFlags: 16 }, 'XCUIKeyboardKeyDelete']`, then a read that must not show text left; the text in one `/wda/keys`, a capital as its lowercase key with Shift; a read-back; every request of keys goes only while the app is in front |
| press | `Enter`, `Tab`, `Backspace`, `Space` and single characters as text; chords and the other named keys refused by name | named keys as `XCUIKeyboardKey` names, modifiers as XCTest's flags (Shift 2, Control 4, Option 8, Command 16; `ControlOrMeta` is Command); a locator's field is clicked first unless it holds the focus, and any other element is refused rather than clicked |
| scroll | one W3C touch drag from the element's centre by minus the delta, 600 ms, a 200 ms hold so it does not fling, refused when it would leave the element | one runner element scroll by minus the delta, since XCTest's deltas move the content the other way |
| swipe | one W3C touch drag from the centre a third of the element's extent in the direction | refused |

The read-back of a secure field compares the count of masking characters, never text: iOS writes U+2022, and AppKit, while the field is being edited, U+F79A. A macOS secure field passes only on that evidence, one masking character per character typed, seen after typing; one that reads back nothing (as AppKit does once editing ended) fails, saying the input was sent and could not be verified. No message, record or tree holds the secret; the fill names it `{{password}}`.

Every request that may have gone is recorded with its kind, route, launch, the look it acted on and how far it got. A request with no answer is `unknown`, enters the ledger beside the session's own, is reconciled against the app's processes through the operating system, and is never sent again. A reference from another launch or session object is refused before anything is sent.

## Keyboard and alerts

The iOS keyboard is part of the app's tree while it is up: a `Keyboard` element in a window of its own, a `SystemInputAssistantView` bar of suggestions above it, and a return key that is a Button named `Return` labelled `return`, or for TaskPhone's title field (`submitLabel(.done)`) named `Done` labelled `done`. Retest dismisses it by pressing that key once, resolved exactly, and fails by name when the keyboard stays, since that field's return key does not dismiss it. Both of TaskPhone's fields tried dismissed it.

The first-run card about sliding to type ("Speed up your typing by sliding your finger across the letters to compose a word.", with a Continue button) showed over the keyboard of Settings' search field in the native sessions lane's run. It did not show for any of TaskPhone's fields on fresh simulators, in the tree or on the simulator's display; all three have autocorrection turned off, which is the likely reason but was not established. It is named only over a keyboard that is up, with its text and one Continue button in one container lying in the keyboard's own window, or over the keyboard's frame in another window that is neither the app's own nor holds an alert; on the real simulator the keyboard sits in the third of three windows, under three `Other` elements. An app's own text and Continue button are never taken for it. Its handling is unit-tested only, and its real accessibility tree was never captured.

On iOS an app's alert is an `Alert` element of its tree, and WebDriverAgent's alert routes also see system alerts outside it; `readAlert` reads the tree first and then those routes, redacting what they return. Answering an alert reads its button labels, requires exactly one with the label, and sends the accept or dismiss route with that name, which taps the first button with the label (`clickAlertButton`), so uniqueness is checked first; an alert of the app's own is in the tree, so its button first passes every check an element passes before input, while a system alert has no frame to check. On macOS an alert is an Alert, Sheet or Dialog inside the owned window and its button is clicked after the same checks. After the press, the alert counts as closed only when the tree shows none and, on iOS, the alert route answers "no such alert"; any other answer fails with the press sent. A press that went and got no answer is `outcome_unknown`, never "stopped before it sent". An action outside an open alert waits and fails naming it. Neither fixture shows an alert, so only the no-alert answers were exercised: `GET /alert/text` and `/wda/alert/buttons` answer `no such alert` on the real WebDriverAgent.

## For the wiring lane

Gaps in the session's surface, which `interaction-session.ts` works around without touching the session files:

1. Done since: `openSession` hands over the runtime's own client and executor session, and the integration test and the proof use them; nothing attaches to the session `GET /status` names, and the helper that did is gone.
2. The session's lane and unknown-outcome ledger are private. The interaction session has its own lane, which every request goes through, the forwarded lifecycle ones and captures included, its own cancel, which also cancels the session, and its own input ledger, merged in `unknownOutcomes`. A cancel, loss or disposal made on the `NativeAppSession` directly stops the interaction session too: every request and every press first asks the session's `cancelled` and `ended`.
3. The session keeps no process reader the interaction layer can use after a cancel; reconciliation takes one injected (`simulatorAppProcesses` on iOS, `listProcesses` on macOS).
4. The session's redaction is private; the interaction session takes the same function, for text read outside the tree.
5. The contract's `Gesture` has a tap without an element; Retest refuses it rather than tap a point.
6. `toBeSelected` is not in `LocatorCheckRecord`; the parent needs it to judge native selected checks. `NativeObservation` adds `selected` to the web's `Observation`.
7. The macOS capture check of the sessions lane counts Automation Mode's overlay, which covers the whole screen at layer 1000 whenever the runner drives the desktop, so on this Mac every TaskDesk capture was refused, at any window frame, with the pointer off the window or on it.

## Commands and results

Every simulator and desktop run held `/tmp/retest-heavy-gate.lock`.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/native-locators.test.ts tests/unit/native-actionability.test.ts tests/unit/native-input.test.ts tests/unit/native-assertions.test.ts tests/unit/native-keyboard-alerts.test.ts tests/unit/native-webdriver-client.test.ts` | 67 pass, 0 fail; the five new files passed three runs in a row, 56 each | `/tmp/retest-interaction-unit-final.log`, `/tmp/retest-interaction-unit-repeat-{1,2,3}.log` |
| `node --conditions=retest-source --test tests/integration/native-interaction.test.ts` | every test of the file on the real simulator and the real macOS runner; the file holds 11 tests, not the 12 written here before | `/tmp/retest-interaction-integration-1.log` |
| `node --conditions=retest-source proofs/native/interaction.ts` | 19 of 19 steps, run `2026-10-03T23-19-51Z` | `/tmp/retest-interaction-proof-1.log` |
| `npm run typecheck:proofs` | clean on both compilers for all four proofs | `/tmp/retest-interaction-typecheck-proofs-1.log` |
| `npm run typecheck` | clean on both compilers and the examples project | `/tmp/retest-interaction-typecheck-5.log` |
| `npm run test:unit` | every test of this lane passed; failures and two files that never ended (`native-desktop-lock`, `native-macos-app`, stopped after 12 minutes) were all in other lanes' files, which were being edited during the run | `/tmp/retest-interaction-test-unit.log` |

What the integration test and the proof showed on the real targets:

- TaskPhone: the account field tapped, the keyboard up within the wait, dismissed by its `return` key; account and password filled (the password read back as 20 bullets for 20 characters, counted, never shown); signed in; the title filled, the keyboard dismissed by its `done` key; the task created and its id read from the screen by pattern (`task-9eec97503a2e` in the proof), its title and its state `Open`; the service held that task under that id; exactly one sign-in and one create reached the service. A check for `Done` failed as `check_failed`: "getByTestId('created-task-state') has text "Open", expected "Done"", with the element named in its details.
- TaskDesk: signed in the same way (the password read back as 20 U+F79A characters while edited); a wrong id filled, `Meta+A` through `press` on the field and `Backspace` emptied it, checked with `toHaveValue('')`; `seed-ada-2` filled and `Enter` pressed showed it, `Done`; in the proof the phone's task found by its id showed `Open`; a check for the other state failed naming `the StaticText "selected-task-state"`; `toBeSelected` on that text was refused as `unsupported`. Thirty more tasks overflowed the list, the first row below its view checked hidden, one scroll of the list by 120 points, and the row checked visible.
- Both: `getByTestId('sign-in')` failed as `not_found`; on iOS `getByTestId('Sign in')` named the section header whose name equals its label; a reference resolved before a terminate and relaunch was refused with nothing sent; the alert routes, or on macOS the tree, said no alert was open.
- Cancel after dispatch, on both: a cancel 100 ms after the sign-in tap or click was sent left the input `unknown`, class `interrupted`, one entry in the ledger, reconciled with the app running; the service then saw exactly one sign-in, and the cancelled session sent nothing more. A cancel 300 or 500 ms into a fill's typing left it `unknown` too, and the field then held the whole text (160 of 160 characters on iOS, 120 of 120 on macOS) and the same length a second and two seconds later: the executor finished the typing it had been sent, and nothing was typed again.
- Lost executor, on both: the runner app killed while a check polled; the check ended `session_lost`.

The macOS capture was refused in every run, before any click and after them: "1 window(s) of other processes lie over the app's window (layer 1000)". The proof recorded what lay over the window: Automation Mode's own overlay (`AutomationModeUI`) over the whole screen at layer 1000, and the Dock's full-screen surface at layer 20, which the capture check does not count. Wispr Flow's floating window, which also lay over the window's bottom right corner in the earlier explorations, had been quit by the founder before the final runs. So the coverage check refuses every capture on this Mac while the runner drives the desktop, whatever the window's frame; that is for the native sessions lane, which owns the check.

Artifacts, `~/Library/Caches/retest-proofs/artifacts/interaction/2026-10-03T23-19-51Z/`: `proof-phone-launch1-o3-keyboard-simulator-display.png` (the account field with the keyboard up), `proof-phone-launch1-o30-created-executor-screen.png` and `proof-phone-launch1-o31-created-simulator-display.png` (the created task's id, title and state), and `report.json` with the inputs each half sent, the service's request lines and the covering windows. No tree was kept: an iOS tree with the keyboard up names the simulator's keyboard languages.

Exploration before the tests, from `/tmp/retest-interaction-scratch/` and not kept: the attribute and tree shapes of both executors, the keyboard's tree, the clear sequence on iOS (`"\b\u007f"` per character emptied the field with the caret at the end and after a second tap), typing speed, the macOS list scrolling, and `hittable` reading true for TaskDesk's elements under another app's floating window.

## Phase 2 review fixes

The native findings of [reviews/phase-2-review-native.md](../reviews/phase-2-review-native.md) that sit in this layer were fixed on 5 October 2026: N-1 to N-8, N-14 to N-16, this layer's side of N-19, N-20 to N-26, N-28, N-29 and N-35. Each new unit test was run against the committed code (the eight files of this layer put back, everything else as it stood) and failed there for the reason it names; N-19's two tests were run with the committed session too, since the session's own new refusal of cancelled references already stops the old wrapper, and with that refusal taken out of the current session they fail on the old wrapper and pass on the new one.

What the real simulator showed, read with a scratch script not kept (attribute counts only, no tree): TaskPhone's empty account field and the same field holding "Account", its placeholder's text, give the same tree (`value="Account" placeholderValue="Account" label="" traits=""`) and the same answers from the attribute route for `value`, `placeholderValue`, `label`, `name`, `traits`, `focused` (false, even while it took keys), `selected`, `accessible` and `hittable`. No signal tells them apart, so that one reading is "cannot tell". With the old code, a fill of "Account" read back as empty and failed, and the next fill of "ada" skipped the clear and typed onto the old text: the field read back "Accountada". The iOS windows read `hittable` true; with the keyboard up the app has three windows.

The macOS runner did not start for this round: xcodebuild reported "WebDriverAgentRunner-Runner encountered an error (Early unexpected exit, operation never finished bootstrapping. Test crashed with signal abrt before establishing connection)", and the system log's last line from the runner is its App Sandbox start. It failed the same way all four times it was tried, from a snapshot of the committed source as well as from the fixed one, and before any code of this layer runs; the runner build is the one from 3 October, unchanged. So nothing on macOS was run after the fixes: the macOS half of the integration test failed in its setup, and the proof ran with `--only ios`.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/native-{locators,actionability,input,assertions,keyboard-alerts,webdriver-client}.test.ts` | 92 of 92 | `/tmp/retest-lane-a/unit-owned-2.log` |
| the same new tests against the committed code of this layer | 29 of 69 fail, each for the reason it names; the locators file does not load, since the readings it tests are new | `/tmp/retest-lane-a/fixes-off-1.log` |
| `node --conditions=retest-source --test --test-name-pattern="real iOS simulator\|TaskPhone\|Info.plist" tests/integration/native-interaction.test.ts`, under the lock | 6 of 6 on the real simulator; the cancelled typing held 160, 160 and 160 of 160 characters | `/tmp/retest-lane-a/integration-ios-1.log` |
| the macOS half of the same file, under the lock | failed in setup: the runner did not start | `/tmp/retest-lane-a/integration-macos-1.log` |
| `node --conditions=retest-source proofs/native/interaction.ts --only ios`, under the lock | 9 of 9 steps, run `2026-10-05T08-25-36Z`; the report holds no password | `/tmp/retest-lane-a/proof-ios-1.log` |
| `npm run typecheck:proofs`, under the lock | clean on both compilers | `/tmp/retest-lane-a/typecheck-proofs-1.log` |

## What the platforms do not expose

- iOS: an identifier apart from the label (WebDriverAgent's `name` is the identifier or else the label, and `attribute/identifier` is an unknown attribute); keyboard focus (`focused` read false on a field that had just been tapped and was taking text); modifier keys and named keys with no text; a value for static text.
- macOS: visibility; a secure field's characters (masked while edited, empty afterwards); scrolling through W3C actions; alert routes.
- Both: input already sent is completed by the executor after the client stops waiting: a typing stopped after a second still landed in full on both platforms, so a cancel never takes input back.

## Not verified

1. Anything on macOS after the review fixes: the runner did not start (see "Phase 2 review fixes"). The window anchoring, the narrow overlay rule, the keys-only-in-front check, the masked read-back rule and the macOS attribute omissions were exercised against the stand-in only; the omissions are read from the runner's source.
2. Answering an alert, an alert blocking an action, and system alerts on the real executors: neither fixture shows an alert.
3. The first-run card on a real tree: it never showed on TaskPhone, so the window rule rests on where the real keyboard sits.
4. Role, label and text finders, scoped steps and picks, selected and checked state, and the count mismatch refusal on the real executors; they ran against the stand-in only.
5. Swipe and the iOS scroll through Retest's own `scroll` on the real simulator: TaskPhone's form fits the screen, so a drag moves nothing to check; one raw drag was sent during exploration and answered.
6. Denied permissions: neither fixture asks for any.
7. Behaviour under another macOS release, another Xcode, an Intel Mac, a second display, or a keyboard language other than this simulator's.
