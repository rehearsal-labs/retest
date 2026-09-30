# Milestone 3 build plan

30 September 2026. Every milestone 3 build agent works from this contract. Milestones 1 and 2 are built, reviewed and pushed. Their contracts are `docs/plans/milestone-1/build-plan.md` and `docs/plans/milestone-2/build-plan.md`, the second review is `docs/plans/milestone-2/review.md`, and the handoff is `docs/implementation-handoff.md`. Everything there still holds unless this file changes it.

The product decisions come from `docs/plans/developer-experience/design.md`, cited here as [D1] to [D42]. Milestone 2's decisions are cited as [M2-1] onwards. When this file and the design disagree, this file wins for milestone 3, and the section "Departures from the design" lists each place. If something here conflicts with `AGENTS.md`, stop and report it rather than choosing.

## Who milestone 3 is for

A host: a program that runs Retest on its own machines, for other people's apps. A host:

- writes the test file itself;
- builds the config as an object in memory, not in `retest.config.ts`;
- supplies secrets as functions;
- routes the browser through its own proxy;
- must be able to trust a pass without trusting the test code.

Every piece is generic and useful to any Retest user. Nothing in Retest names a particular host.

## Scope

Wave 1 comes in two parts. The short list is what the first host-run test needs, and it is built first.

1. **`press`** on a locator and on the page's keyboard (M3-1).
2. **Host checks.** Checks the caller supplies, which the parent runs after the test body. A test passes only if they pass. They are keyed by test or by file (M3-2).
3. **Observation events.** A parent event for every observation served to the test process, linked to the assertion that rested on it. The parent judges each passed locator assertion again on that observation (M3-3).
4. **A proxy server per target**, with a bypass list (M3-5, the context half).
5. **The programmatic API a host building its config in memory uses**: `testEnvironment`, the `resolveSecrets` export, `testId` and `testTitle` from `/protocol`, and the guide's notes (M3-7).

The rest of wave 1 lands after the short list, while a host builds on it.

6. **More actions.** `select`, `check`, `uncheck` and `scroll` (M3-1).
7. **Page titles** on navigation events and beside every recorded page address, and **the cause of each navigation** (M3-4).
8. **Containers.** What a container needs to run Chrome with its sandbox on, decided by the Linux check and already built (M3-6).
9. **The rest of the programmatic API**, with each gap named and closed (M3-7).

Wave 2. Before any host runs Retest for customers.

10. **Screencast frames**, their timing, and video through an encoder the caller supplies (M3-8).
11. **Uploads and downloads** (M3-9).
12. **An inbox per app**, through a provider the config supplies (M3-10).
13. **Tabs** the app opens (M3-11).
14. **Proxy authentication**, with credentials under the secret rules (M3-5, the credential half). Built when a host needs it.

Both waves: the protocol changes (M3-12) and what reporters show (M3-13).

The rest of wave 1 starts once the short list has passed its own acceptance checks. Wave 2 starts only after all of wave 1 has passed its acceptance checks and an independent review.

Out of scope for milestone 3:

- The session API that observes and acts by reference. It moved to milestone 4.
- A custom launcher for the test process, for isolation. Milestone 4.
- Firefox, WebKit and Safari.
- Real mobile devices and native apps.
- Parallel workers and `lock`.
- Retries.
- `toMeet`, `test.eval` and judges.
- HTML reports.
- Custom fixtures (`test.extend`) and `retest install`, as in milestone 2.

Never advertise any of these. When a user asks for one, reject it clearly.

## Code quality bar

Unchanged from milestones 1 and 2, and it applies to every agent:

- Vite, Vitest and VoidZero style.
- Small modules with named exports.
- Minimal comments: only a reason the code cannot show.
- Don't repeat yourself.
- Keep separation of concerns: `protocol` is pure, `browser` knows nothing of tests, `runner` knows nothing of CDP, and `reporters` only consume events.
- Handle edge cases and test them.
- No `any`, no unchecked `as` casts, no `!`, no `@ts-ignore`, `@ts-expect-error` or `eslint-disable`.
- Explicit export types, because `isolatedDeclarations` is on.
- `kebab-case.ts` file names, and `.ts` extensions in relative imports.
- Shared Node-level helpers go in `src/shared/`.

Added for milestone 3:

- A rule both processes apply, such as which keys exist, how a host check matches or whether a locator matcher passes, is a pure function in `protocol`, so the parent and the test process read the same rule.
- Every browser behaviour a decision relies on is shown in real Chrome first and written down as a fact, with the probe that showed it. The next section lists them.
- The test process is untrusted. The parent validates every value it takes from it, even one the test process already checked.

## Facts to establish first

The milestone 2 review showed that a guess about Chrome is where holes come from. Before the Browser agent builds a part of a wave, it establishes that part's facts in real Chrome, headless, on Google Chrome 154 and Chrome for Testing 153. Probes use Retest's own CDP client, each in its own profile under one folder in the system temporary folder, removed afterwards. Each fact goes into the handoff with its probe. A fact that contradicts a decision below stops work on that decision, and the agent reports it rather than choosing.

Fact numbers stay as first written, so F2 now sits with wave 2 and F12 with wave 1.

Wave 1, short list:

- **F1.** `Target.createBrowserContext` with `proxyServer` and `proxyBypassList` sends that context's requests through the proxy, including a service worker's and a cross-site frame's, and sends loopback addresses around it unless the list holds `<-loopback>`. Also: what a navigation returns when the proxy answers 407 and nothing answers the challenge.
- **F5.** `Input.dispatchKeyEvent` `keyDown` with `text: '\r'` on a focused text field in a form submits the form once, and the `keyUp` that follows reaches the same document before the next one commits.

Wave 1:

- **F3.** A `Runtime.callFunctionOn` that sets a `<select>`'s selection and dispatches `input` then `change` reaches the page's listeners as the browser's own change does, apart from `isTrusted`. Also, for the record and deciding nothing: whether keyboard type-ahead on a focused, closed `<select>` changes it with trusted events, without opening its list, on macOS and on Linux.
- **F4.** A trusted click on a `<label>` makes the browser click its control, with `isTrusted: true`, after the label's own `click` has finished dispatching.
- **F6.** A `wheel` listener with `passive: false`, added on the window only while a scroll is armed and removed after, leaves the page's own scrolling as it was. `Input.dispatchMouseEvent` `mouseWheel` scrolls the scroll container under the point.
- **F7.** `Page.lifecycleEvent` `DOMContentLoaded` for a committed loader comes after a `<title>` in the head has set `document.title`, for a server page and for each document of a redirect chain.
- **F12.** A navigation the page requests while it handles an action's input raises `Page.frameRequestedNavigation` before the call that delivered that input answers. The cases: a link clicked through `Input.dispatchMouseEvent`, a form submitted by Enter through `Input.dispatchKeyEvent`, a `location` change in a `click` listener, and a `change` listener run by the `Runtime.callFunctionOn` of `select`. A `history.pushState` in a `click` listener reports `Page.navigatedWithinDocument` inside the same window. Also: where a navigation falls that a `setTimeout` in the listener starts. This fact sets where `cause: 'action'` ends (M3-4).

Wave 2:

- **F2.** Only when a host needs proxy authentication (M3-5). With `Fetch.enable({ handleAuthRequests: true, patterns: [{ urlPattern: '*' }] })` on a page session, a proxy's 407 raises `Fetch.authRequired` with `authChallenge.source: 'Proxy'`. Answering it once lets the context's later requests through without another challenge, a service worker's and a cross-site frame's included. Also: whether `Fetch.enable` on the browser session covers every target of a context, which would be the simpler place.
- **F8.** `Page.startScreencast` on a headless page sends frames only when it paints, stops when frames go unacknowledged, and carries `metadata.timestamp` on every frame, or says when it does not.
- **F9.** `Browser.setDownloadBehavior` with `allowAndName`, a `downloadPath`, `eventsEnabled` and a `browserContextId` saves each download under its `guid` and reports `Browser.downloadWillBegin` with the `frameId` of the page that began it, and `Browser.downloadProgress` through `completed` or `canceled`. Also: what `Page.navigate` answers when the address it opens turns into a download.
- **F10.** `Page.setInterceptFileChooserDialog` makes a click on an element that opens a chooser raise `Page.fileChooserOpened` with the input's `backendNodeId`, and `DOM.setFileInputFiles` on it fires `input` and `change` with `isTrusted: true`.
- **F11.** `Target.setAutoAttach` with `waitForDebuggerOnStart` and `flatten` catches a page the app opens, by a `target="_blank"` link, by `window.open` and with `noopener`, before any of its scripts runs. `targetInfo.browserContextId` names its context in every case. Also: how that auto-attach treats the pages Retest opens itself with `Target.createTarget`.

## Decisions

Numbered M3-1 onwards, so agents can cite them. Each says which wave it belongs to, and in wave 1 whether it is on the short list. An item with parts marks each part. M3-5's credential half is wave 2 and stays with its item.

### Wave 1

#### M3-1. More actions. Wave 1; `press` on the short list.

`press`, on a locator and on `page.keyboard`, is wave 1, short list. `select`, `check`, `uncheck` and `scroll` are wave 1.

The API, in `src/api/page.ts`:

```ts
export interface Page<Touch extends boolean = boolean> {
  // goto, getByTestId, getByRole, getByLabel and getByText are unchanged.
  /** The keyboard of this app's page. It presses keys on whatever holds the keyboard focus. */
  readonly keyboard: Keyboard
  /** Turns the mouse wheel at the centre of the viewport. */
  scroll(delta: ScrollDelta): Promise<void>
}

export interface Keyboard {
  press<const K extends string>(key: KeyArgument<K>): Promise<void>
}

export interface Locator<Touch extends boolean = boolean> {
  // fill, click and tap are unchanged.
  press<const K extends string>(key: KeyArgument<K>): Promise<void>
  select(choice: OptionChoice | readonly OptionChoice[]): Promise<void>
  check(): Promise<void>
  uncheck(): Promise<void>
  scroll(delta: ScrollDelta): Promise<void>
}

/** An option by its label, as a person reads it, or by its `value` attribute. */
export type OptionChoice = string | { readonly value: string }

/** CSS pixels. Positive is right and down. */
export type ScrollDelta = { readonly x?: number | undefined; readonly y?: number | undefined }
```

`KeyArgument<K>` is `K` when `K` is a key Retest supports, and a `RetestTypeError` naming the supported forms otherwise.

On the short list: `Page.keyboard`, `Keyboard`, `Locator.press` and `KeyArgument`. The rest of the block is wave 1.

**Keys** (`src/protocol/keys.ts`, with `parseKey(text)`, pure). Wave 1, short list:

- A named key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp` or `PageDown`.
- `Shift+` and a named key, such as `Shift+Tab`.
- One character, such as `a`, `7` or `é`: the key a person types to get it. An uppercase letter is typed with Shift.
- Control, Alt and Meta combinations are refused in the types and at run time as `unsupported`. An editing shortcut needs the platform's own command, and the platforms differ.
- The test process refuses an unknown key before it sends anything. The parent parses it again and answers `usage` for anything it does not accept.
- The CDP parameters for each key live in `src/browser/keys.ts`: `key`, `code`, `windowsVirtualKeyCode`, `text` for keys that type, `rawKeyDown` for keys that do not, and on macOS the editing command a headed browser needs, as `fill` already sends for Delete.

**`press`.** Wave 1, short list:

- On a locator: exactly one match, then these checks: attached, visible, enabled, and it keeps the keyboard focus once Retest focuses it. There is no hit test, because a key does not go through a point.
- On `page.keyboard`: no checks. The key goes to the element that has the focus, or to the document's body when nothing has it.
- The guard arms for that element before the key goes, and watches `keydown`, `keypress`, `beforeinput`, `input` and `keyup`. The `keydown` decides: it must reach the element or something inside it. The rest of the keystroke then belongs to the page, as the click a label passes on to its field does, so a key that makes the page move the focus or submit a form is never stopped halfway. The arming lasts until the key is released, so no part of the keystroke is stopped as stray typing.
- A `keydown` another element takes is stopped before any listener of the page hears it, and the press fails `not_actionable`, naming that element. A `keydown` that never reaches the element's document, as when the focus is inside a frame, is `outcome_unknown`.
- Enter in a form field submits the form once (fact F5). The press succeeded once its `keydown` reached the field. The navigation that follows is the page's own, and is recorded as one.
- While the browser is opening another document in the frame, no press starts, as for every action since the milestone 2 review (B1).
- A press whose `keydown` the page cancels with `preventDefault` still reached its element, and passes.

**`select`.** Wave 1:

- The element must be a `<select>`. Anything else fails at once with `unsupported`, naming the element. A list the page draws itself is chosen with `click`.
- A string names an option by its label: the option's `label` property, whitespace normalised, whole and case-sensitive. `{ value }` names it by its `value` attribute, exactly.
- Each choice must match exactly one option. No match waits until the action's time runs out, because options often arrive late, then fails `not_found`, naming the choice. More than one fails at once with `ambiguous`. A disabled option, or one inside a disabled `<optgroup>`, waits, then fails `not_actionable` with `details.check: 'enabled'`.
- An array chooses exactly those options in a `<select multiple>` and clears the others. An array on a single select, and an empty array, are `usage`.
- The select passes the checks a click does: visible, stable, enabled, in view, and not covered at its centre, because a person has to be able to reach it.
- Then, in the same task as the hit test, Retest sets the selection in the page and dispatches `input` then `change`, both bubbling, as the browser does after a person picks from the list. When the selection already is the one asked for, nothing is dispatched, and the event says `changed: false`.
- This is the one wave 1 action that is not real input. Chrome draws a select's list outside the page, where input over CDP does not reach it (fact F3). The action event says `input: 'script'`, and the guide says that a page which ignores events whose `isTrusted` is false ignores this one too. `select` stays scripted whatever F3 shows about keyboard type-ahead (see "Decided" under the open questions).

**`check` and `uncheck`.** Wave 1:

- The element is a native checkbox or radio button, or has the role `checkbox`, `radio`, `switch`, `menuitemcheckbox` or `menuitemradio`. Anything else is `unsupported`.
- Its state is `checked` for a native control and `aria-checked="true"` for any other. `aria-checked="mixed"` counts as not checked.
- Already in the state asked for: nothing is sent, the action passes, and the event says `changed: false`.
- Otherwise Retest clicks it once, through milestone 1's click, with every check and the guard. On a touch screen it taps, and the event says `touch: true`.
- A native control that is not visible, with exactly one visible label of its own (`control.labels`), is clicked through that label. The checks and the hit test run on the label, and the guard counts the label and everything inside it as the element (fact F4). The event says `via: 'label'`. This is how a person ticks a styled checkbox.
- After the click, Retest reads the state until it is the one asked for, or the action's time runs out. It never clicks again. A control that took the click and did not change fails `not_actionable`, with `details: { check: 'state', inputSent: true }`: "Retest clicked it once, and it stayed unchecked. Retest does not click again."
- `uncheck()` on a radio button is `unsupported`: a person unchecks one by choosing another.

**`scroll`.** Wave 1:

- `locator.scroll(delta)` turns the wheel at the element's centre. It passes the checks a click does, and the `wheel` event must reach the element or something inside it.
- `page.scroll(delta)` turns the wheel at the viewport's centre, and any element of the top-level document may receive it.
- Both `x` and `y` missing or zero, or either not a finite number, is `usage`.
- One wheel event carries the whole delta. The action passes once the `wheel` event reached its element. It says nothing about how far the page moved: smooth scrolling may still be under way, and the next action's stability check waits for it.
- The guard listens for `wheel` only while a scroll is armed. A wheel listener that is not passive slows every scroll of the page, so it is added at arming and removed at settling (fact F6).
- A `wheel` another element takes is stopped, and the scroll fails `not_actionable`, naming that element.
- Every action already brings its element into view first, as in milestone 1. A test scrolls only for what the page does on scroll, such as loading more items, or enabling a button at the end of a text.

**Commands and results** (`src/protocol/commands.ts`), all additive:

```ts
export type OptionChoiceRecord = { label: string } | { value: string }

export type PageCommand =
  | /* goto, fill, click, tap and observe, unchanged */
  | { kind: 'press'; locator?: LocatorRecipe; key: string } // no locator: the page's keyboard
  | { kind: 'select'; locator: LocatorRecipe; choices: OptionChoiceRecord[] }
  | { kind: 'check'; locator: LocatorRecipe }
  | { kind: 'uncheck'; locator: LocatorRecipe }
  | { kind: 'scroll'; locator?: LocatorRecipe; x: number; y: number } // no locator: the page

export type CommandResult =
  | /* milestone 2's results, each gaining page?: PageFacts (M3-4) */
  | { ok: true; kind: 'press' | 'scroll'; page?: PageFacts }
  | { ok: true; kind: 'select' | 'check' | 'uncheck'; changed: boolean; page?: PageFacts }
```

`describeCommand` writes each as a test writes it: `getByLabel('Search').press('Enter')`, `page.keyboard.press('Enter')`, `getByLabel('Country').select('Canada')`, `getByRole('checkbox', { name: 'Remember me' }).check()`, `page.scroll({ y: 600 })`.

The `press` command and its result are wave 1, short list. The other commands, `changed`, and `page` on results (M3-4) are wave 1.

**Events:** `ActionKind` gains `press`, `select`, `check`, `uncheck` and `scroll`. Action fields gain, each present only when it says something: `key`, `choices`, `changed`, `scroll: { x, y }`, `input: 'script'`, `via: 'label'` and `touch: true`. `press` and `key` are wave 1, short list; the rest are wave 1.

**Failure classes:** no new ones.

**Edge cases the builders must handle:**

- An element replaced between its checks and its input: milestone 1's rules hold, since the guard belongs to the document that armed it.
- A check whose click opens a JavaScript dialog: milestone 1's dialog rule, `unsupported`.
- A select whose `change` listener navigates: the action passed when the page call returned. An answer lost to a closed connection is `outcome_unknown`, since the change call goes through `Dispatch` like any input.
- Two options whose labels differ only in spacing: labels normalise whitespace, so they are `ambiguous`.
- A press or scroll on an emulated touch screen: the keyboard and the wheel work as on a desktop. Scroll does not become a swipe; the guide says so.

**Tests that prove it.** Wave 1, short list:

- Unit: `protocol-keys` (every accepted form, and the refusals with the list), `browser-keys` (the CDP parameters of each key, Shift, and the macOS commands), `browser-page-scripts` (a press decides at `keydown` and lets the rest of the keystroke through), `api-actions` (the command `press` and `keyboard.press` send, and usage errors in the test process), `runner-actions` (the event fields of a press), and compile-fail fixtures for `press('Entr')` and `press('Control+a')`.
- Real Chrome, `tests/integration/browser-actions.test.ts` extended, against a new fixture page `/actions` whose server counts submissions and clicks, so "once" is proved: each rule for `press`; a `keydown` covered by an overlay stopped before any page listener; a browser killed between `keyDown` and `keyUp`, held by the gated transport, gives `outcome_unknown`.
- Through the CLI, `m3-press` (acceptance check 1, short list).

Wave 1:

- Unit: `browser-page-scripts` (a label counts as its control for `check`; the wheel listener exists only while armed), `browser-select` (choice matching), `api-actions` and `runner-actions` for the other kinds, and compile-fail fixtures for `select(1)` and `scroll()`.
- Real Chrome, the same file and fixture page: each rule for `select`, `check`, `uncheck` and `scroll`.
- Through the CLI, `m3-actions` (acceptance check 1).

#### M3-2. Host checks. Wave 1, short list.

Checks the caller gives the runner, which the parent process runs itself after a test's body, against one app's page. They are the part of a verdict that test code cannot write.

The API, in `src/runner/contract.ts`, from the `/runner` subpath:

```ts
export type HostCheck =
  | {
      readonly kind: 'address'
      readonly app?: string
      readonly origin: string
      readonly path?: string | RegExp
      readonly name?: string
      readonly timeoutMs?: number
    }
  | {
      readonly kind: 'text'
      readonly app?: string
      readonly text: string
      readonly ignoreCase?: boolean
      readonly absent?: boolean
      readonly name?: string
      readonly timeoutMs?: number
    }

export type RunOptions = {
  // milestone 2's options, unchanged
  /** Checks the parent runs after each named test's body, by test id. A test passes only if they pass. */
  hostChecks?: Readonly<Record<string, readonly HostCheck[]>>
}
```

**Rules:**

- Keys are test ids, `file > describe path > name` [M2-13]. `testId(file, title)` from `/protocol` builds one (M3-7). A test's checks apply to every variant of it.
- A key may also be a file: its path, POSIX and relative to the root, exactly as `run.started.files` lists it. Its checks apply to every test collected from that file, setups included. A test named by a file key and by its own id gets both lists, the file's first. This is how a host that writes the file but does not choose the test's name supplies checks without collecting first.
- After collection and before any test runs, each of these is a usage failure of the run, exit 2, and nothing starts: a key that names no selected test and no selected file; a check whose `app` the test does not use; an `origin` that is not an http or https origin; a `RegExp` with the `g` or `y` flag; empty `text`; a `timeoutMs` that is not a whole number from 1. A host's typo never gives a green run.
- `app` defaults to the test's first app, the one its `page` is.
- The checks run when the test process has reported the test finished, `afterEach` hooks included. That is before the failure screenshot, before a setup's state is saved and before the pages close. "The final page" is the page as the test left it.
- They run only when the body passed. When the body failed, or the test did not run, every check is recorded as `not_run`.
- They run in the order given, and all of them: a failed check does not stop the next, so the result shows the status of every check.
- **`address`**: the page's origin must equal `origin`. With `path`, a string must equal the page's path exactly as the URL standard writes it, and a `RegExp` must match it. The query and the fragment are never read, as everywhere in Retest. The address is the main frame's, as the parent last saw it commit.
- **`text`**: the page's visible text is `document.body.innerText` of the top-level document, with whitespace normalised as locators normalise it. The check passes when that text contains `text`, normalised the same way. It is case-sensitive unless `ignoreCase`. With `absent`, it passes when the text does not contain it. Frames and shadow roots are not read, and the guide says so.
- Each check looks again until it passes or its time runs out: `timeoutMs`, or the assertion budget. It only reads, and the test is over, so no action can repeat. While the browser is opening another document in the frame, a check waits for that document.
- The runner reads the page through `OwnedPage.readPage` and never speaks CDP.

**The verdict:**

- New failure class `host_check_failed`. It is a failed check, not a problem of ours, so the test's status is `failed` and the run exits 1 [D21].
- A test whose body passed and whose checks all passed has passed.
- A test whose body passed and one of whose checks failed has failed. Its failure is the first check that failed; the others are in `details.also`.
- A check that could not read the page, because it or its browser has gone, makes the test `error` with `session_lost`.
- The failure screenshot is taken as for any failure, so it shows the page the check saw.
- A run interrupted during the checks stops them. The test ends `interrupted`, like any other.

**Events and result**, all additive:

```ts
type HostCheckRecord =
  | { kind: 'address'; name?: string; origin: string; path?: string | { pattern: string; flags: string } }
  | { kind: 'text'; name?: string; text: string; ignoreCase?: true; absent?: true }

/** What the check saw last. Free text for the redactor. `title` comes with M3-4. */
type HostCheckActual = { url?: string; title?: string; found?: boolean }

type HostCheckFields = AttemptScope & {
  session: string // the app
  check: HostCheckRecord
  actual: HostCheckActual
  attempts: number
  timeoutMs: number
  durationMs: number
}

| (HostCheckFields & { type: 'host_check.passed' })
| (HostCheckFields & { type: 'host_check.failed'; failure: Failure })

// run.started.options gains:
hostChecks?: Record<string, HostCheckRecord[]>

// TestResult gains, listing every check the test had, in order, whatever happened:
hostChecks?: { check: HostCheckRecord; app: string; status: 'passed' | 'failed' | 'not_run'; failure?: Failure }[]
```

Both events always carry `origin: 'parent'`. `run.started` records what the run was asked to check, so a reader can tell a missing check from one that was never asked for.

**Browser contract** (`src/browser/contract.ts`):

```ts
export type TextQuery = { text: string; ignoreCase: boolean }

/** `found` answers each query in order. `navigating` is true while the frame is opening another document. `title` comes with M3-4. */
export type PageReading = { url: string | undefined; title?: string | undefined; navigating: boolean; found: boolean[] }

interface OwnedPage {
  /** Reads the page's address, title and whether its visible text holds each query. Sends no input. */
  readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading>
}
```

`readPage` sends the queries as arguments to a function in Retest's world, and gets back only whether each was found. The page's whole text never leaves the page. Until M3-4 lands, it reads no title, and `actual` has none.

The pure rules live in `src/protocol/host-check.ts`: `normalizePageText`, `matchesAddress`, `hostCheckRecord` and the schemas.

**Edge cases:** a page that is still redirecting when the body ends (the check waits for it); a page whose success text appears after a delay (the check looks again); an `absent` check that passes at once on a blank page, which is why hosts pair it with an `address` check (the guide says so); a setup test named in `hostChecks` (allowed; its state is saved only when its checks passed); two checks on two apps of one test.

**Tests that prove it:**

- Unit: `protocol-host-check` (address and text rules, records of `RegExp` paths), `runner-host-checks` (order, statuses, `not_run` listing, the usage failures before any test, looking again within the budget, the failure class and `also`, interruption, a lost page), `reporters-host-checks`.
- Real Chrome, `browser-read-page`: visible text rules for hidden elements, whitespace, frames and shadow roots.
- Programmatic, `m3-host-checks` (acceptance check 2).

#### M3-3. Observation events and the parent's judgement. Wave 1, short list.

- Each time the parent answers the test process's `observe` command with what the page showed, it writes an `observation` event, before it sends the answer. A look that failed served nothing and writes no event; its failure is in the assertion's.
- The parent gives each observation an id, `o1`, `o2` and so on, counted within the attempt, and sends it with the answer as `observationId`.
- On each locator assertion event, the test process names the observation its verdict rested on: its last look. It also sends the matcher and its arguments whole, as `check`, because `expected` is cut at 4096 code units. A value assertion sends neither.
- The parent checks that claim before it writes the assertion event. The id must be one it served to this attempt, for the same app and a locator deeply equal to the assertion's. An `assertion.passed` with a locator must name one, and every locator assertion must carry `check`. A claim that fails any of this is a protocol violation, and the test ends `test_error`, as for any message the parent cannot accept [M2-12].
- The parent replaces the assertion event's `pageUrl` with the named observation's, on every locator assertion, and `pageTitle` too once M3-4 lands. A `pageUrl` the test process sent is dropped from every assertion event, value assertions included: the page's address is the parent's fact, and today the parent keeps one the test process claims when it sends one.
- An observation's `pageUrl` is the address the parent last saw that app's page commit, as an action's is today. From M3-4, it is the address the look itself read, with `pageTitle` beside it.

**The parent judges each passed locator assertion:**

- Before it writes `assertion.passed` for a locator assertion, the parent builds the check from `check` with `locatorCheck`, and applies it to the observation the assertion names. It judges that observation exactly as it sent it: redacted, and whole, not the copy cut short for the event.
- A check that does not pass on that observation is a protocol violation. No `assertion.passed` is written, the test ends `test_error`, and its process is killed, as milestone 2 treats every other violation [M2-12].
- On every locator assertion, passed or failed, the parent writes `matcher`, `expected` and `comparison` from that check, and `actual` from the named observation, or none when it names none. The test process's own values are dropped, so the event says what the parent judged.
- Every `assertion.passed` says who judged it, in `judgedBy`, which the parent sets: `'parent'` for a locator assertion, `'child'` for a value assertion. A value matcher compares values the test process holds and the parent never sees, so its pass stays the test process's claim. A failed assertion carries no mark: a test may always fail itself.

**Where the rule lives.** The locator checks move from `src/assertions/locator-checks.ts` to `src/protocol/locator-checks.ts`, with the `LocatorCheck` type from `poll-locator.ts`. `quoteText` (with `shorten`, which shares its limit) and `textComparison` move into `src/protocol/text.ts` beside `normalizeText`. `protocol` is the one module both processes import. It is pure and imports only itself. The runner may not import `src/assertions/`, which is the test's side and reaches into the test run. Apart from those two helpers, the checks read only `protocol` (`Observation`, `observedItemLimit`, `normalizeText`), so they move whole, and the test process and the parent apply the same rule.

**Protocol**, all additive:

```ts
// locator-checks.ts: a locator matcher and its arguments, whole
export type LocatorCheckRecord =
  | { matcher: 'toBeVisible' | 'toBeHidden' }
  | { matcher: 'toHaveText'; text: string }
  | { matcher: 'toHaveText'; texts: string[] }
  | { matcher: 'toHaveCount'; count: number }
  | { matcher: 'toHaveValue'; value: string }
/** The rule the test process polls with and the parent judges with. */
export function locatorCheck(record: LocatorCheckRecord): LocatorCheck

// commands.ts: the observe result gains an id the parent adds, and page facts the browser adds (M3-4)
| { ok: true; kind: 'observe'; observation: Observation; observationId?: string; page?: PageFacts }

// events.ts
type ObservedRecord = {
  count: number
  visible: boolean | null
  text: TruncatedText | null
  value: TruncatedText | null
  items: { text: TruncatedText; visible: boolean }[]
  itemsTruncated: boolean
}
| (StepScope & {
    type: 'observation'
    observationId: string
    locator: LocatorRecipe
    pageUrl?: string
    pageTitle?: string // M3-4
    observed: ObservedRecord
    durationMs: number
  })

// assertion fields gain
observationId?: string
pageTitle?: string // M3-4
// assertion.passed gains, set by the parent and never sent by the test process
judgedBy: 'parent' | 'child'

// childEventSchema: a locator assertion as the test process sends it gains, read by the parent and never written
check: LocatorCheckRecord
```

- `text` and `value` are cut to 4096 code units, and each item's text to 512, never inside a surrogate pair (`truncateText`).
- `observed` is free text for the redactor, so page text holding a secret reads `{{name}}` in the event, exactly as the test process received it.
- Nothing is skipped to save space. An assertion that looked 13 times writes 13 events, because which look passed is the point.

**Edge cases:** `expect.soft` locator assertions link like any other; `expect.poll` reads values, names none and is marked `judgedBy: 'child'`; an observation answered after the test was revoked is neither sent nor written; ids count per attempt, so a later attempt never matches an earlier id; `toBeHidden` and `toHaveCount(0)` pass on an observation with no match, name it, and pass the parent's judgement; page text the parent redacted before the test process saw it is judged redacted, so a check that compares a placeholder agrees on both sides; an expected text longer than the event keeps is judged whole, from `check`.

**Tests that prove it:**

- Unit `protocol-locator-checks`: every matcher's rule, moved with the checks from `assertions-text`, and `locatorCheck` for each record.
- Unit `runner-observations`: one event per answered look, ids per attempt, the event written before the answer, and each of the violations. The judgement: a test process that sends `assertion.passed` for `toBeVisible` naming an observation with count 0 ends `test_error`, its process is killed and no `assertion.passed` is written; a pass the check agrees with is written with `judgedBy: 'parent'`, and its `expected` and `actual` are the parent's; a value assertion is written with `judgedBy: 'child'`; the redacted observation is the one judged; an expected text past the event limit is judged whole.
- Unit `assertions-observation-id`: the last look's id and the `check` record on the event, for pass, fail and soft.
- Through the CLI, `m3-observations` (acceptance check 3).

#### M3-4. Page titles and the cause of each navigation. Wave 1.

- `navigation` events gain `title` and `cause`.
- Action events, assertion events and `observation` events gain `pageTitle` beside `pageUrl`. Host check `actual` has `title`.
- A title is `document.title`, read in Retest's world, with control characters removed, trimmed, and cut to 300 code units, never inside a surrogate pair (`pageTitle()` in `src/protocol/page-facts.ts`). An empty title is absent.
- Titles are page text. They are free text for the redactor (`title`, `pageTitle`), and untrusted data for everything that reads them.

**When each is read:**

- An action or a look reads the title in the same page call that checks or reads the element, so it names the document the action went to. `goto` reads it after `load`. The browser returns it as `page: PageFacts` on the command's result.
- A new document's `navigation` event is written once its title is known: when its `DOMContentLoaded` fires, when the next command to that page begins, or one second after it committed, whichever comes first (fact F7). A later navigation that commits before any of these writes the earlier one with the title it had then, or none.
- A page's `navigation` event is always written before any event of a command that began after it committed, and it names the step the test was in when it committed.
- A navigation within the document, through the history API, is written at once with the title as it stands. A title the app sets later is not a new navigation, and is not recorded until something reads it.
- The address still moves at commit. The parent's secret origin check reads the page's current address (`OwnedPage.url`), never a navigation event, so it never waits for a title.

**The cause of each navigation:**

- Every `navigation` event says what started it, in `cause`: `'goto'`, `'action'` or `'page'`.
- `goto`: the navigation the test's `goto` started. `Page.navigate` starts it, so no `Page.frameRequestedNavigation` comes before it (fact 1 of the milestone 2 review), and its loader is the one `Page.navigate` returns.
- `action`: a navigation the page requested while an action's input was being delivered. The window runs from the first input call Retest sends for the action until its last one answers. For `select`, that call is the one that dispatches `input` and `change`. It counts when the page's `Page.frameRequestedNavigation` arrives inside that window, or, for a new path within the document, its `Page.navigatedWithinDocument` does (fact F12).
- `page`: everything else, such as a redirect the page makes on its own, a timer, or the browser.
- The browser tells the cause, since telling it takes CDP. The parent writes it, so it is the parent's fact.
- What a host can do with it: require that the page its checks saw was not opened by `goto`. The app's last `navigation` before the checks ran must not say `cause: 'goto'`. It says nothing about the steps before that navigation, and the guide says so.

**Contract:**

```ts
// src/protocol/page-facts.ts
export type PageFacts = { url: string; title?: string }
export type NavigationCause = 'goto' | 'action' | 'page'

// src/browser/contract.ts
/** A navigation of the main frame, told at commit. `title` settles by the rule above. */
export type PageNavigation = { url: string; title: Promise<string | undefined>; cause: NavigationCause }

interface OwnedPage {
  /** The main frame's origin and path as of its latest commit. */
  readonly url: string | undefined
  onNavigation(listener: (navigation: PageNavigation) => void): () => void
}
```

The runner notes the step when the listener is called, and writes the event when `title` settles. `ChromiumPage` settles every pending title before a new command to that page goes past its start.

**Tests that prove it:** unit `protocol-page-facts` (control characters, cutting, surrogates, empty), `browser-titles` with a scripted CDP session (`DOMContentLoaded`, the next command, one second, a newer commit first, a navigation within the document), `browser-navigation-cause` with a scripted CDP session (the loader `goto` started, a requested navigation inside an action's window and after it, `pushState` inside it), `runner-titles` (the event names the step at commit, carries its cause and comes before the next command's events; a secret in a title is redacted); real Chrome, `browser-navigation` extended (a server page, a redirect chain, `pushState`, a title written after load, and the cause of a `goto`, a link click, Enter in a form, `pushState` in a click listener and a redirect a timer starts); through the CLI, `m3-titles` (acceptance check 4).

#### M3-5. A proxy per target. Wave 1, short list; authentication in wave 2.

What the code does today: `ChromiumBrowser.newPage` calls `Target.createBrowserContext` with no parameters, and `launchBrowser` passes no proxy flag. Every context uses the machine's own connection.

The proxy server and its bypass list are wave 1, short list. Proxy authentication is wave 2, built when a host needs it. A host that runs its own proxy on loopback keeps its credentials there, out of the browser, and needs only the server setting.

**The server and the bypass list.** Wave 1, short list.

Config (`src/config/types.ts`):

```ts
export type ProxySettings = {
  /** The proxy's address: http, https, socks4 or socks5, with no user name or password in it. */
  readonly server: string
  /** Chrome's bypass rules, such as 'localhost', '*.internal' or '<-loopback>'. */
  readonly bypass?: readonly string[] | undefined
}

export type TargetSettings = {
  readonly headless?: boolean | undefined
  readonly emulate?: DeviceName | CustomEmulation | undefined
  readonly proxy?: ProxySettings | undefined
}
```

Loaded and passed on:

```ts
// src/config/loaded.ts
export type LoadedProxy = { readonly server: string; readonly bypass: readonly string[] }
// LoadedTarget gains proxy?: LoadedProxy

// src/browser/contract.ts
export type ProxyOptions = { server: string; bypass: readonly string[] }
// NewPageOptions gains proxy?: ProxyOptions

// src/protocol/events.ts: TargetInfo gains
proxy?: { server: string; bypass?: string[] }
```

Rules:

- A proxy is a setting of the browser context. Each app's page in each test gets a context with its target's proxy, through `proxyServer` and `proxyBypassList` joined with `;`. Targets that differ only by proxy share one browser, so the browser pool's key does not change.
- Loopback addresses go around a proxy unless `bypass` holds `<-loopback>` (fact F1). Retest does what Chrome does, and the guide says so.
- The config is refused, naming the key, for: a `server` that is not one of the four schemes with a host; a `server` with a user name or password in it, refused without quoting it; a bypass entry that is empty or holds `;`. Until the credential half is built, the refusal of a user name or password says that Retest does not sign in to a proxy.
- `browser.started` records each app target's `server` and `bypass`.
- **Failures:** a navigation that fails with one of Chrome's proxy errors (`net::ERR_PROXY_CONNECTION_FAILED`, `net::ERR_TUNNEL_CONNECTION_FAILED`, `net::ERR_PROXY_AUTH_UNSUPPORTED`, `net::ERR_PROXY_CERTIFICATE_INVALID`, `net::ERR_NO_SUPPORTED_PROXIES`) is `setup_failed`, not `not_actionable`. The proxy failed, not the app. The message names the proxy's `server` and the error. A proxy that asks for credentials gets no answer; what Chrome then gives is part of fact F1, and the guide says what a test sees.
- Retest never adds `--ignore-certificate-errors` or anything like it. A proxy that presents its own certificate for the sites it carries fails as Chrome fails it.
- `doctor` prints each target's proxy `server`.

Edge cases: a service worker's or a cross-site frame's requests (fact F1); a proxy that closes the connection mid-page; the same proxy on two apps of one test (two contexts).

Tests that prove it:

- Unit: `config-validate` (every refusal, never quoting a user name or password in a `server`), `runner-proxy` (each app's context gets its target's proxy; `TargetInfo`), `browser-navigation` (proxy errors classed `setup_failed`).
- Real Chrome, `browser-proxy`, with a fixture proxy in `fixtures/proxy/cli.ts`: an HTTP proxy with `CONNECT`, built on Node's own modules, which logs each host it carries and adds a header to each plain request it forwards. The fixture app can be told to refuse any request without that header.
- Through the CLI, `m3-proxy` (acceptance check 5).

**Authentication.** Wave 2, when a host needs it. Fact F2 first.

Config and API gain:

```ts
export type ProxySettings = {
  // server and bypass, as above
  readonly username?: string | undefined
  /** env('NAME'), read once when the run starts, or a function called for each browser context. */
  readonly password?: SecretSource | undefined
}

// src/config/loaded.ts: LoadedProxy gains
credentials?: { readonly username: string; readonly password: LoadedSecretSource }

// src/browser/contract.ts: ProxyOptions gains
credentials?: { username: string; password: string }

// src/runner/contract.ts: ConfiguredApps gains
/** Each target's proxy password, by `variantKey({ [app]: target })`. Needed for every target whose proxy has credentials. */
proxyPasswords?: ReadonlyMap<string, ResolvedSecret>

// resolveSecrets' result gains (M3-7)
proxyPasswords: Map<string, ResolvedSecret>
```

Rules:

- The config is refused, naming the key, for: `password` without `username`, or the reverse; credentials on a SOCKS proxy, which Chrome does not authenticate to. A `server` with a user name or password in it is refused with the fix "put the password in proxy.password".
- **The password follows the milestone 2 secret rules** [M2-23]:
  - An `env` source is read once when the run starts. A missing, empty or short value stops the run with exit 2 before any test, naming the variable. Its variable is hidden from the test process.
  - A function is called for each browser context that needs it, with a signal aborted when the context's time runs out. An error, a rejection or no text fails that test `setup_failed`, naming the target and never the value.
  - Every value is taught to the redactor before it goes anywhere, and nothing records it. The four-character floor applies.
  - A proxy password is never a fillable secret. `secret()` cannot name it, so no test can type it into a page.
- A target whose proxy has credentials with no resolved password in `proxyPasswords` is a setup failure at run start, exit 2, naming the target and `resolveSecrets`.
- The user name is not a secret, and nothing records it either. `browser.started` never records the credentials.
- Authentication happens between the parent and the browser (fact F2). On a page whose proxy has credentials, the page session enables `Fetch` for every request with `handleAuthRequests`, and continues each paused request unchanged. A challenge whose source is the proxy is answered with the credentials once per request; a second challenge for the same request is cancelled. A server's own challenge gets the browser's default answer, as it would without a proxy. Pages whose proxy has no credentials enable no `Fetch`. No loopback relay is started, since the test process could use one to reach the proxy with the host's credentials.
- A challenge Retest had to cancel is `setup_failed`, like the proxy errors above. The message names the proxy's `server`, never the credentials.

Edge cases: a service worker or a cross-site frame whose request is the first to meet the challenge (covered if F2 holds; documented if it does not); a function source that is slow (it has the setup budget); the same proxy on two apps of one test (two calls to the function).

Tests that prove it:

- Unit: `config-validate` (the credential refusals, never quoting a password), `runner-proxy` (an `env` password read once and hidden, a function called per context, the value learned before use, `TargetInfo` without credentials, `setup_failed` on a failing function), `runner-secrets` (proxy passwords from `resolveSecrets`), `browser-proxy-auth` with a scripted session (a proxy challenge answered once, a second cancelled, a server challenge left to the browser, every paused request continued).
- Real Chrome, `browser-proxy`, with the fixture proxy's basic authentication turned on.
- Through the CLI, `m3-proxy-auth` (acceptance check 15).

#### M3-6. Container launch settings. Wave 1. Decided by the Linux check.

The Linux check ran every gate in Docker on 30 September 2026 with Chrome's sandbox on: in the public harness `docker/linux/` (Debian 13, Node 24.21, Google Chrome 154 and Debian's Chromium 154, as the `node` user), and the unit and integration suites in a host's own runner image (Ubuntu 24.04, Chrome for Testing 153). Everything passed. It ran on arm64 inside Docker Desktop, not on a Linux host or on x86-64.

Decisions:

- **Retest gains no launch setting.** `LaunchOptions` and the target stay as they are. What a container needs is met by the container and explained in the guide's "Run in a container". Retest never turns the sandbox off, never passes `--no-sandbox`, `--disable-setuid-sandbox` or any flag that weakens it, and never retries a launch without it.
- **What a container needs,** as the guide says:
  - a user other than root;
  - a seccomp profile that lets Chrome make its user namespaces. `docker/linux/chromium-seccomp.json` is Docker's default profile plus five rules: `clone` for the three namespace combinations Chrome uses, `unshare` of a user namespace, and `chroot` without the capability. Chrome's setuid helpers do not help, because they need `CAP_SYS_ADMIN`;
  - `--init`, or another init, so the browser's ended processes are reaped;
  - no added capability. `--cap-drop ALL` works with the profile;
  - a larger `--shm-size` for heavy pages. Docker's default 64 MB was enough for Retest's own tests.
- **Failures name the fix.** When Chrome says its sandbox could not start, or that it will not run as root, or that a system library is missing, the launch fails with that cause and its fix (`src/browser/start-failure.ts`). A browser whose processes are left unreaped says to start the container with an init (`src/shared/unreaped-group.ts`). Both are built.
- **The executable.** `chrome()` finds Google Chrome at `/opt/google/chrome/chrome`. A Chrome for Testing or a distribution's Chromium is passed as `chromium({ executablePath })` or through `RETEST_CHROMIUM`.

What wave 1 still owes here: the short list's and the rest's Verification also run the `m3-*` integration checks in the Linux harness (`docker/linux/run.sh` followed by the milestone 3 command from the Gates section), so the per-context proxy (M3-5) is proved on Linux. The screencast (M3-8) is proved there in wave 2.

Not checked, and said so in the guide: fonts beyond the harness's, a read-only root file system, a headed browser under Xvfb, a real Linux host with Ubuntu's AppArmor rule for user namespaces, and x86-64.

#### M3-7. The programmatic API a host needs. Wave 1; part on the short list.

The audit of `runFiles` and the `/runner` and `/protocol` subpaths against what a host does. Each decision says whether it is on the short list: the parts a host building its config in memory uses.

| A host needs to | Today | Decision |
| --- | --- | --- |
| Build the config as an object | `defineConfig` and `validateConfig(value, path)` work in memory. `path` is only a label, and the folder relative paths start from; no file needs to exist. `run.started` records it as the config | Wave 1, short list. No change. The guide says so |
| Supply secret functions | Function sources work, but `apps.secrets` must hold every secret already resolved, and `resolveSecrets` is not exported, so every host rewrites it. A function gets no way to learn that Retest stopped waiting | Wave 1, short list: export `resolveSecrets(config, env)`. Wave 1: a function source is called with `{ signal }`, aborted when the fill's time runs out. Wave 2 adds proxy passwords to `resolveSecrets` (M3-5) |
| Keep its own credentials from test code | The test process inherits the parent's whole environment, minus the variables `env` secrets read | Wave 1, short list. `RunOptions.testEnvironment`: when given, the test process gets exactly these variables and no others. The command line does not set it |
| Set budgets | `timeouts` in full; `defaultTimeouts` and `mergeTimeouts` from both subpaths; each host check's `timeoutMs` | No gap |
| Set emulation | In the config's targets | No gap |
| Stop a run, and say why | `signal` stops it, but any reason other than `'SIGTERM'` reads as "The run was interrupted." | Wave 1. `signal.reason` may also be a `Failure`. The run records it as its interruption, in `run.finished` and in each test it stopped. Status `interrupted`, exit code 130 |
| Choose the run folder | `outputDir`, refused when it holds files. But every run also writes `.retest/last-run.json` under `rootDir` | Wave 1. `RunOptions.lastRunFile`: a path, or `false` for none. The default is today's. Until then, a host points `rootDir` at a folder of the run's own |
| Read output as it arrives | Reporters get every event in order, stamped, redacted and valid; `onOutput` gets the test file's output | Wave 1, short list. No gap. The guide says the returned result and the events a reporter receives come from the parent's memory, and the files are copies |
| Read the run folder afterwards | `readRunFolder` lives in the CLI and throws `CliError`. The folder's file names are not exported | Wave 1. Move `readRunFolder` and `rebuildResult` to `src/store/`. Export `readRunFolder` and `RunFolderReadError` from `/runner`, and `eventsFile`, `resultFile` and `logsFolder` from `/protocol` |
| Run a test file it wrote anywhere | The test process resolves the package from the test file's folder. A file in a folder with no `node_modules` fails collection, and a file beside another copy of Retest loads that copy, whose registry the running copy never reads | Wave 1. The test process resolves the package and its subpaths to the copy that runs it, through `module.registerHooks`, before it loads a test file. Until then, a host writes the file where the package resolves |
| Require checks the test cannot write | Nothing | Wave 1, short list. M3-2, with `testId` and `testTitle` exported from `/protocol` |
| Route the browser through its proxy | Nothing | Wave 1, short list: the proxy server and bypass list. Wave 2: authentication (M3-5) |
| Run two runs at once in one process | Never exercised | Wave 1. The Verification phase runs two at once. Anything they share that they should not is a bug to fix, not a limit to document |
| Launch browsers its own way | `runFiles(options, reporters, launch, findExecutable)` | No gap in wave 1. Container settings wait for M3-6 |

**Signatures:**

```ts
// from /runner. Wave 1, short list. Wave 2 adds proxyPasswords to the result (M3-5).
export function resolveSecrets(
  config: LoadedConfig,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; secrets: Map<string, ResolvedSecret> } | { ok: false; failure: Failure }

// from /runner. Wave 1.
export type RunFolder = { source: 'result.json' | 'events.jsonl'; result: RunResult; events: RetestEvent[]; warnings: string[] }
/** Reads and validates a run folder. A run cut off halfway is rebuilt from its events and marked incomplete. */
export function readRunFolder(folder: string): RunFolder
export class RunFolderReadError extends Error {}

export type RunOptions = {
  // milestone 2's options, and hostChecks (M3-2)
  /** Wave 1, short list. The test process's whole environment. Absent: the parent's, without the variables secrets read. */
  testEnvironment?: Readonly<Record<string, string>>
  /** Wave 1. Where `--last-failed` reads from. `false` writes nothing. Default `<rootDir>/.retest/last-run.json`. */
  lastRunFile?: string | false
  /** Wave 1. Aborted to stop the run. Its reason is 'SIGINT', 'SIGTERM' or a Failure that says why. */
  signal: AbortSignal
}

// src/config/types.ts. Wave 1.
export type SecretSource = EnvSecret | ((context: { readonly signal: AbortSignal }) => string | Promise<string>)
```

- The resolve hook maps exactly the package's own name and its exported subpaths, and nothing else. Its own tests prove a file in a folder with no `node_modules` collects, and a file beside another copy gets the running copy.

**What a host can trust after milestone 3:**

- The parent writes every event and stamps its `origin`. Only `step.*` and `assertion.*` events come from the test process. The parent checks their shape. From M3-3 it also checks that each locator assertion rests on an observation it served, and judges each passed one on that observation itself. A passed value assertion is the test process's claim, and says `judgedBy: 'child'`.
- Host checks, navigations and their causes, actions, observations and every outcome are the parent's own facts.
- The `RunResult` that `runFiles` returns, and the events a reporter receives, come from the parent's memory.
- A host that must trust a run takes the `RunResult` from `runFiles`' return and the events from its own reporter, and reads the run folder only for artifacts. `result.json` and `events.jsonl` are copies in a folder the test process can write.

**What it cannot:**

- The test process is not a sandbox. It runs as the same user. It can read and write what that user can, the run folder's files included, and it can reach the network. A host that runs code it did not write runs the whole of Retest inside isolation it controls, such as one container per run, until milestone 4 brings a launcher for the test process.
- A host check sees the final page, not every step to it. A host can require that the final page was not opened by `goto`: the app's last `navigation` before the checks must not say `cause: 'goto'` (M3-4). Nothing proves the test took the flow's own steps before that.
- Screenshots and, in wave 2, frames and downloads are not redacted.

**Tests that prove it:** unit `runner-test-environment` and `runner-secrets` (the new signature), short list; `runner-stop-reason`, `runner-last-run-file`, `runner-resolve-hook` and `store-read-run-folder` (moved, with its own error), wave 1; `protocol-entry` and `runner-entry` (the new exports, in both parts); integration `m3-host-run` (short list, extended in wave 1), `m3-concurrent-runs` and `m3-package` (acceptance checks 6 to 8).

### Wave 2

#### M3-8. Screencast frames and video. Wave 2.

Retest bundles no encoder, adds no dependency and starts no encoder process of its own. It writes frames with their timing, in a form any encoder reads, and calls an encoder only when the caller supplies one.

**Config and API:**

```ts
// the config's top level, and RunOptions
video?: { readonly record: 'on' | 'retain-on-failure'; readonly encode?: VideoEncoder } | undefined

/** Writes one video file into `recording.folder` and returns its file name. */
export type VideoEncoder = (recording: Recording, context: { readonly signal: AbortSignal }) => Promise<string>

export type Recording = {
  /** The absolute path of the recording's folder. */
  readonly folder: string
  readonly frames: readonly RecordedFrame[]
  /** The absolute path of the ffconcat list of the frames. */
  readonly concatFile: string
  readonly width: number
  readonly height: number
}

export type RecordedFrame = { readonly file: string; readonly elapsedMs: number; readonly durationMs: number }
```

The command line gains `--video on|retain-on-failure|off`, which replaces the config's `record`.

**What Retest writes:**

- One recording for each app page of each test, and for each tab (M3-11). It starts when the page opens, before the body, and stops before the page closes.
- `Page.startScreencast`, JPEG at quality 70, at most 1280 CSS pixels on the long side. Every frame is acknowledged at once (fact F8). At most 25 frames a second are kept; the others are acknowledged and dropped. After 15 000 frames the recording stops and says `truncated: true`.
- `artifacts/recordings/<slug of test id>-<attempt>-<app>/`, with `-tab<n>` for a tab:
  - `frame-000001.jpg` onwards;
  - `frames.json`: `{ testId, attemptId, app, tab?, clock, width, height, truncated, frames: [{ file, elapsedMs, durationMs, browserTimestamp? }] }`;
  - `frames.ffconcat`: the `ffconcat version 1.0` list of files and durations that ffmpeg's concat demuxer and other encoders read.
- `elapsedMs` counts on the run's clock, as events' `elapsedMs` does, so steps and frames line up.
- A frame lasts until the next one; the last lasts until the recording stopped. When every frame carries Chrome's timestamp, durations come from it and `clock` is `'browser'`. Otherwise they come from when the parent received each frame, and `clock` is `'received'`. The two are never mixed.

**Encoding:**

- With `encode`, the parent calls it for each recording it keeps, after the run's browsers have closed, one at a time, each within 120 seconds.
- It returns a file name. Retest checks the file exists inside the recording's folder, then records `evidence.captured` with `kind: 'video'`.
- An encoder that throws, runs out of time, or names a file outside the folder gives `evidence.failed`. The test's outcome does not change, as for a screenshot [M2-14].
- `retain-on-failure` removes the folder of a test that passed as soon as its result is known, before any encoding.
- **Without an encoder**, the command line keeps the frames, the index and the list in the run folder. The human report prints the recording folder on each failure card. `inspect` prints the folder and one ffmpeg command that turns `frames.ffconcat` into a video. Retest runs nothing.

**Events and result:** `evidence.captured` gains `kind: 'frames'`, with the folder as `path`, `frames` and `durationMs`, and `kind: 'video'`; `reason` gains `'recording'`. `Evidence` gains the same kinds, with `app` and `tab`.

**Frames are pictures.** They are not redacted: a secret typed into a field that shows it is in the frames. The guide says so beside screenshots.

**Edge cases:** a page that never paints (zero frames, recorded as such); a browser lost mid-recording (the frames written stay); an interrupted run (frames stay, nothing is encoded); a full disk (`evidence.failed`, the test unaffected); an emulated device's pixel ratio.

**Tests:** unit `browser-screencast` (scripted: acknowledgement, the 25 a second limit, the cap), `runner-recordings` (the index, durations and the clock rule, `retain-on-failure`, encoder calls, refusals and failures), `reporters-recordings`; real Chrome `browser-screencast`; through the CLI, `m3-video` with a fixture encoder script that writes a small file (acceptance check 10). No test needs ffmpeg.

#### M3-9. Uploads and downloads. Wave 2.

**Uploads:**

```ts
interface Locator<Touch extends boolean = boolean> {
  upload(files: UploadFile | readonly UploadFile[]): Promise<void>
}

export type UploadFile = string | { readonly name: string; readonly mimeType?: string; readonly bytes: Uint8Array }
```

- A string is a path, relative to the run's root directory. It must name a file inside the root directory once links are followed; anything else is `usage`, naming the path. The browser reads the file from disk, and the test process never sends its bytes.
- Bytes go in the command as base64, at most 16 MiB per call. The parent writes them to a private folder, mode 0700, under `name`, and removes them when the test ends. `name` must be a plain file name: no `/`, no `\`, not `.` or `..`.
- A locator that matches an `<input type="file">` has the files set on it with `DOM.setFileInputFiles`, which fires `input` and `change` as a file chooser does (fact F10). Its checks are attached and enabled, not visible, because file inputs are usually hidden behind a label. The event says `input: 'files'`.
- Any other element is clicked once, with every milestone 1 check and the guard, while file chooser interception is on for that page, and only for the length of the action. Retest answers the chooser the click opens. No chooser within the action's time fails `not_actionable` with `inputSent: true`: "clicking it opened no file chooser".
- Several files for an input without `multiple` is `usage`. An empty list clears the input.
- Uploads need a browser that shares Retest's file system. A custom `launch` whose browser runs elsewhere cannot read the paths. Retest cannot tell, and the guide says so.
- The action event lists `files: [{ name, size, sha256 }]`. Names are free text for the redactor.

**Downloads.** This changes milestone 2's rule on purpose (review m6). Downloads were refused in every context so that none could land in the person's own folder. They are now allowed, into a folder Retest owns:

```ts
interface Page<Touch extends boolean = boolean> {
  waitForDownload(options?: { readonly timeout?: number }): Promise<Download>
}

export type Download = { readonly name: string; readonly path: string; readonly size: number; readonly sha256: string }

// TargetSettings gains
readonly downloads?: boolean | undefined // default true
```

- Every context saves downloads with `allowAndName` into a private folder of the run, mode 0700, under a name the browser makes up, so the page's suggested name never becomes a path (fact F9). It is never the person's own Downloads folder.
- When a download completes, the parent moves it to `artifacts/downloads/<slug of suggested name>-<short id>` and emits `evidence.captured` with `kind: 'download'`, `name` (the suggested name), `url` (origin and path), `size` and `sha256`. The result lists it in `evidence`, with its app. `name` and `url` are free text for the redactor.
- A download larger than 100 MiB is cancelled, removed and recorded as `evidence.failed`. So is one still running when the test ends.
- `downloads: false` on a target keeps milestone 2's refusal for it.
- `waitForDownload` resolves with the oldest completed download of this app the test has not taken yet, or waits for the next one to complete. It may overlap one action [D17]. Its time is the navigation budget unless `timeout` says otherwise. None in time fails `timeout`. A download that was cancelled or too large fails `unsupported`, naming why.
- `goto` to an address that turns into a download passes. The page stays where it was, and the download is recorded.
- Downloads are the app's own files. They are not redacted and may hold whatever the app put in them. The guide says so.

**Edge cases:** a download from a `blob:` or `data:` address (its `url` is the scheme alone, as page addresses are); a suggested name with path separators, control characters or no extension; two downloads with the same name; a download begun in a tab (it belongs to the tab's app).

**Tests:** unit `browser-downloads` and `browser-uploads` (scripted), `runner-downloads` (artifact names, the cap, cancellation at test end, `downloads: false`), `api-uploads` (paths, bytes, the limits), type fixtures; real Chrome `browser-uploads`, `browser-downloads`; through the CLI, `m3-files` (acceptance check 11).

#### M3-10. An inbox per app. Wave 2.

A minimal provider interface. The config supplies it for each app. It runs in the parent only. Retest builds in no provider; the tests use a fixture one.

**Config** (an app setting, beside `baseUrl` [D4]):

```ts
export type InboxProvider = {
  /** The address this app's test account receives mail at. */
  readonly address: () => string | Promise<string>
  /** The newest message to `query.address` received at or after `query.since` that matches, or null. */
  readonly latest: (query: InboxQuery) => Promise<InboxMessage | null>
}

export type InboxQuery = {
  readonly address: string
  readonly since: Date
  readonly subject?: string
  readonly from?: string
  readonly signal: AbortSignal
}

export type InboxMessage = {
  readonly subject: string
  readonly from?: string
  readonly receivedAt: Date | string
  readonly text: string
  readonly html?: string
  /** When given, these are the message's codes, and Retest looks for none itself. */
  readonly codes?: readonly string[]
  /** When given, these are the message's links, and Retest looks for none itself. */
  readonly links?: readonly string[]
}

// AppSettings gains
readonly inbox?: InboxProvider | undefined
```

**The test's side:**

```ts
interface Page<Touch extends boolean = boolean> {
  /** Only on an app whose config has an inbox. Elsewhere a type error that says so. */
  readonly inbox: Inbox
  goto(url: string | Secret): Promise<void>
}

export interface Inbox {
  address(): Promise<string>
  latest(query?: {
    readonly subject?: string
    readonly from?: string
    readonly after?: Message
    readonly timeout?: number
  }): Promise<Message>
}

export type Message = {
  readonly subject: string
  readonly from: string | null
  readonly receivedAt: string
  readonly text: string
  readonly codes: readonly Secret[]
  readonly links: readonly Secret[]
}
```

**Rules:**

- `address()` is called once per test per app, and its text goes to the test process. An address is not a secret.
- `latest()` asks the provider again and again, waiting 0, 250, 500 and then 1000 ms between asks, until it returns a message or the time runs out: `timeout`, 30 000 ms by default, within the test's own budget. `since` is when the test started, or just after `after.receivedAt`. Each ask gets a signal, aborted when the time runs out. Asking only reads, so asking again repeats nothing.
- **Codes:** the provider's `codes` when given. Otherwise every run of 4 to 10 digits in the subject and the text that stands alone, bounded by characters that are not letters or digits, in order.
- **Links:** the provider's `links` when given. Otherwise every http and https address in the text and in the HTML's `href` attributes, in order, without repeats.
- Each code and link becomes a secret for the rest of the test, named `<app>.code.<n>` and `<app>.link.<n>`, counted across the test's messages and shown as `{{web.code.1}}`. The dot keeps these names apart from the config's secret names.
- The redactor learns each at once: a code as it is; a link in every form a URL gives it, its origin and path, and each path segment and query value of 16 characters or more, or of 8 or more that mixes letters and digits. So a token in a recorded address reads as the placeholder.
- `subject` and `text` reach the test process redacted, so the codes and links in them read as their placeholders.
- `fill(message.codes[0])` types a code under the milestone 2 rules, bound to the origins of the test's apps' base URLs.
- `goto(message.links[0])` opens a link. The parent resolves it, and any http or https address may be opened. Its navigation is recorded redacted.
- A name the test was never given fails `usage`, as an unknown config secret does [M2-23]. Names are forgotten when the test ends.
- A provider that throws, rejects or returns something that is not a message fails `setup_failed`, naming the app and never the message. No message in time fails `not_found`: "no message to the web inbox matched within 30000 ms".

**Events:** `inbox.read`, origin parent, with `app`, `found`, `subject` (redacted), `receivedAt`, the number of `codes` and `links`, `attempts` and `durationMs`. It never holds the address, the text or a value.

**Protocol:** commands `{ kind: 'inbox-address' }` and `{ kind: 'inbox-latest'; subject?: string; from?: string; after?: string; timeoutMs: number }`, with their results; `goto.url` becomes `string | SecretRef`.

**Types:** `Page.inbox` exists only for apps whose registered config has an inbox (`AppHasInbox<Name>`, like touch [M2-9]). Elsewhere it is `RetestTypeError<'This app has no inbox in the config'>`.

**Edge cases:** a year in a footer read as a code (the provider's `codes` exists for this; the guide says so); a link that redirects through a tracking address; a second message after a resend (`after`); two apps with inboxes in one test; a provider that returns an older message than `since` (refused as `setup_failed`, since the contract says it must not).

**Tests:** unit `runner-inbox` (polling, `since` and `after`, extraction, names, redaction of each form, the failures), `api-inbox`, type fixtures; through the CLI with a fixture provider the fixture app's sign-up writes to, `m3-inbox` (acceptance check 12).

#### M3-11. Tabs. Wave 2.

```ts
interface Page<Touch extends boolean = boolean> {
  /** The oldest tab this app opened that the test has not taken yet, or the next one it opens. */
  waitForTab(options?: { readonly timeout?: number }): Promise<Page<Touch>>
}

// HostCheck gains
readonly tab?: number | undefined // default 1
```

**Rules:**

- A page the app opens in its own browser context is a tab of that app: a `target="_blank"` link, `window.open`, or a form with a target. Retest attaches to it before any of its scripts run (fact F11). It installs the guard, applies the target's emulation and starts the screencast if one is on, then lets it run. Downloads and the proxy apply already, since they belong to the context.
- Tabs are routed by their browser context, so a tab opened with `noopener` belongs to its app all the same.
- The page Retest opened is tab 1. The app's tabs are numbered from 2, in the order they opened.
- Every event about a tab carries `tab`. Tab 1's events carry none, so milestone 2 readers see nothing new.
- `waitForTab` returns the oldest tab of this app the test has not taken yet, or waits for the next one, within the action budget unless `timeout` says otherwise. It may overlap one action [D17]. None in time fails `timeout`.
- A tab takes one command at a time, like an app [D17]. Two tabs of one app may act at once.
- A tab the app closes writes `tab.closed`. A command to it fails `not_actionable`: "the app closed this tab". An action whose input made the app close the tab passes when the guard answered first, and is `outcome_unknown` otherwise, as for any page that went away.
- Failure screenshots, recordings and host checks cover tabs. The secret origin check reads the tab's own address.
- Retest opens no tab itself.

**Events and protocol:** `tab.opened` with `app`, `tab` and `url`, and `tab.closed` with `app` and `tab`. `tab` is added to `navigation`, `action.*`, `assertion.*`, `observation`, `evidence.*` and `host_check.*`, to the command message, and to `Evidence`. All additive.

**Edge cases:** a tab that opens and closes before the test waits for it; a tab opened while an action on tab 1 is still running; a sign-in popup that closes itself after its button is clicked; a tab that opens another tab; the browser lost while a tab is paused before its scripts.

**Tests:** unit `browser-tabs` (scripted attach, pause, guard before resume), `runner-tabs` (numbering, claims, routing, closed tabs), `api-tabs`, type fixtures; real Chrome `browser-tabs`; through the CLI, `m3-tabs` (acceptance check 13).

### Both waves

#### M3-12. Protocol changes are additive, and `schemaVersion` stays 1.

Nothing has been released, so the JSON Schemas in `dist/schemas` are regenerated, as in milestone 2 [M2-28]. The schema builder rejects unknown keys and values, so a reader validating against milestone 2's schema must use the regenerated one. Retest's own readers do.

The schemas are regenerated at the end of each part of a wave.

Wave 1, short list:

- Commands and results: `press`; `observationId` on the observe result.
- Events: `observation`, `host_check.passed`, `host_check.failed`; `observationId` on `assertion.*`, and `judgedBy` on `assertion.passed`; `key` on `action.*`; `proxy` in `TargetInfo`; `hostChecks` in `run.started.options`.
- `ActionKind` gains `press`. `FailureClass` gains `host_check_failed`.
- Result: `hostChecks` on `TestResult`.
- IPC: `press` and its result; `observationId` and `check` on the assertion events the test process sends.

Wave 1:

- Commands and results: `select`, `check`, `uncheck`, `scroll`; `page` on results; `changed`.
- Events: `title` and `cause` on `navigation`; `pageTitle` on `assertion.*` and `observation`; `pageTitle`, `choices`, `changed`, `scroll`, `input`, `via` and `touch` on `action.*`.
- `ActionKind` gains four more values.
- IPC: the new commands and results.

Wave 2:

- Commands: `upload`, `next-download`, `next-tab`, `inbox-address`, `inbox-latest`; `goto.url` as `string | SecretRef`; `tab` on command messages.
- Events: `tab.opened`, `tab.closed`, `inbox.read`; `tab` on page events; `evidence.*` kinds `frames`, `video` and `download`, and reason `recording`.
- Result: `Evidence` kinds and `tab`.

#### M3-13. Reporters, list and inspect.

- The human report writes each new action as the test wrote it, through `describeCommand`: `press` on the short list, the others in wave 1. The failure card's `Page` line shows the title before the address (wave 1).
- A failed host check is a card of its own: "Host check failed", the check, what it expected, what the page showed, how many times it looked and for how long, the screenshot and the rerun command. The summary gains "Host checks  3 passed · 1 failed" when a run had any. Short list.
- The agent report writes `host_check_failed address expected https://app.example/done, page https://app.example/login`. Short list.
- `inspect --test` shows the observations under the assertion that rested on them, such as "looked 4 times, passed on o7: 1 match, text "Saved"", and the host checks after the body (short list), and titles and causes beside navigations (wave 1). `inspect --json` includes the new events and keeps its shape.
- `doctor` prints each target's proxy `server`. Short list.
- Wave 2: recording folders on failure cards and the ffmpeg line in `inspect`; downloads in a test's evidence; `tab 2` beside a tab's actions; `--video`.
- Page text in titles and observations is printed with control characters removed, so a page cannot write escape sequences into a terminal.

## Departures from the design

1. **`select` is not real input.** Milestone 1, `AGENTS.md` and the architecture ask for real browser input where a test promises a user interaction. Chrome draws a select's list outside the page, where CDP input cannot reach it, so `select` sets the choice from Retest's world and dispatches `input` and `change`. Every check a click runs still runs, the event says `input: 'script'`, and fact F3 must hold first.
2. **An upload to a file input sets its files without a pointer** (wave 2). A file chooser is the browser's own window, and CDP's `DOM.setFileInputFiles` is how its answer reaches the input. Any other element is clicked for real, and its chooser is answered.
3. **`check` may click the control's label** when the control is hidden. This widens milestone 1's hit rule for one action, because a styled checkbox is ticked through its label.
4. **Scroll on an emulated touch screen turns the wheel.** [D12] makes `click` a tap on touch targets. A swipe needs touch-move input and a gesture model that milestone 3 does not build, so `scroll` stays a wheel everywhere, and the guide says so.
5. **The keyboard has only `press`,** with Shift but no Control, Alt or Meta. The design names no keyboard API; the rest waits for a use.
6. **`waitForTab` and `waitForDownload` also return what arrived before the wait began,** oldest first. [D17] lets these waits overlap one action. Returning the oldest one not yet taken removes the race without asking the test to start the wait first.
7. **Host checks are programmatic only.** The design has none. No config key or flag is added until a use for one appears.
8. **`goto` accepts a `Secret`,** for inbox links (wave 2). [D30] names only `fill`.
9. **The test process resolves Retest to the copy that runs it,** whatever copy sits beside the test file. The design assumes the project's own installation. A test process that loads another copy never registers its tests with the running one, so this fixes a fault as well as serving hosts.

## Contracts: who owns what

Each wave runs in three phases: Foundation alone, then four agents in parallel on disjoint files, then Verification. Wave 1 runs the three phases twice: first for the short list, then for the rest. An independent review follows each wave, as `docs/plans/milestone-2/review.md` did, before the next wave starts. Wave 1's review covers both parts, after the rest's Verification.

The Linux check's changes to `src/` and `tests/` were reviewed and settled before wave 1's first Foundation started (M3-6). They are the baseline every agent below builds on.

Each agent's unit tests go in `tests/unit/`, named with its area's prefix. An agent edits only what its phase owns. If a contract has to change, it stops and reports.

### Wave 1, short list

**Phase 1, Foundation.** One agent. It leaves `npm run typecheck` passing. Each new `OwnedPage` member gets a placeholder in `src/browser/page.ts` and in `tests/support/fake-browser.ts` that fails with `unsupported`, until phase 2 replaces it.

| Path | What |
| --- | --- |
| `src/protocol/**` | The `press` command and result, and `describeCommand` for it (M3-1); new `keys.ts` (M3-1); new `host-check.ts` (M3-2); the `observation` event and ids, `judgedBy`, and `check` on the assertion events the test process sends (M3-3); `locator-checks.ts` and the helpers it uses, moved from `src/assertions/` (M3-3); `TargetInfo.proxy` (M3-5); `host_check_failed`; `index.ts`, which also exports `testId` and `testTitle` |
| `src/assertions/**`, `tests/unit/assertions-*` | Imports only, for the move, in the same change |
| `src/config/**` except `load.ts` | `ProxySettings` with `server` and `bypass`, its validation and `LoadedProxy` (M3-5) |
| `src/browser/contract.ts` | `NewPageOptions.proxy`, `readPage`, and `BrowserCommand` with `press` |
| `src/runner/contract.ts`, `src/runner/index.ts` | `HostCheck`, `RunOptions.hostChecks` and `testEnvironment`, and the export of `resolveSecrets` |
| `src/runner/secrets.ts` (signature only), `src/cli/commands/run.ts` (its call) | `resolveSecrets(config, env)`, reading the config's secrets as today |
| `src/browser/page.ts`, `tests/support/fake-browser.ts` | Placeholders only |
| `src/shared/**` | Any Node-level helper the wave needs. Frozen in phase 2: an agent that needs a new shared helper stops and reports |
| `scripts/write-schemas.ts` | Only if the new schemas need it |
| `tests/unit/protocol-*`, `config-*` | Their tests |

**Phase 2.** Four agents in parallel.

| Agent | Paths | Items |
| --- | --- | --- |
| Browser | `src/browser/**` except `contract.ts`; `fixtures/**`, including the new `fixtures/proxy/`; `tests/integration/browser-*.test.ts` and `browser-harness.ts`; `tests/unit/browser-*` and `cdp-*` | Facts F1 and F5 first. Then, in this order: `press`, keys and the guard's arming for a keystroke (M3-1); `readPage` (M3-2); proxy contexts and the proxy failure class (M3-5) |
| API | `src/api/**`, `src/assertions/**`, `src/index.ts`, `tests/types/**`, `tests/unit/api-*`, `assertions-*` and `type-*` | `press` and `keyboard.press`, with `KeyArgument` and their compile-fail fixtures (M3-1); `observationId` and `check` on locator assertion events, polling with the checks from `protocol` (M3-3) |
| Runner | `src/runner/**` except `contract.ts` and `index.ts`; `src/store/**`; `tests/support/**`; `tests/unit/runner-*`, `store-*` and `run-*` | The event fields of a press (M3-1); host checks, keyed by test and by file (M3-2); observation events, ids, their validation, and the parent's judgement of each passed locator assertion, with `judgedBy` (M3-3); each context's proxy and `TargetInfo` (M3-5); the test environment (M3-7) |
| CLI | `src/cli/**`, `src/reporters/**`, `tests/unit/cli-*`, `reporters-*` and `inspect-*` | M3-13 for the short list |

**Phase 3, Verification.** One agent.

| Path | What |
| --- | --- |
| `tests/integration/m3-*.test.ts`, `tests/integration/cli-harness.ts` | Acceptance checks 2, 3, 5 and 6, the short list's part of checks 1 and 8, and check 9 |
| The existing integration tests (`matrix-*`, `m2-*`, `run-interrupt`, `cli-commands`, `package-smoke`) | Updated where a wave 1 change alters what they observe, such as a reporter line or a regenerated schema. Never weakened |
| `fixtures/**` | New pages and routes the checks need, after the Browser agent's |
| `examples/**` | A host-style example, `examples/host/`, run by `m3-host-run` |
| `docs/guide.md`, `docs/implementation-handoff.md` | How to use the short list, and part 3 of the handoff |

A host may build on the short list once this Verification passes.

### Wave 1, the rest

The same three phases, on the same paths, after the short list's Verification.

**Phase 1, Foundation.** One agent, with placeholders as above.

| Path | What |
| --- | --- |
| `src/protocol/**` | The `select`, `check`, `uncheck` and `scroll` commands and results, and `describeCommand` for them (M3-1); new `page-facts.ts`, the title fields and `cause` (M3-4); `index.ts`, which also exports `eventsFile`, `resultFile` and `logsFolder` |
| `src/config/**` except `load.ts` | `SecretSource` with its signal (M3-7) |
| `src/browser/contract.ts` | `OwnedPage.url`, `PageNavigation` with `title` and `cause`, `PageReading.title`, and `BrowserCommand` with the new kinds |
| `src/runner/contract.ts`, `src/runner/index.ts` | `lastRunFile`, the stop reason, and the exports of `readRunFolder` and `RunFolderReadError` |
| `src/store/read-run-folder.ts`, `src/store/rebuild-result.ts` | Moved from `src/cli/inspect/`, with `RunFolderReadError`. The CLI's imports are updated in the same change |
| `src/browser/page.ts`, `tests/support/fake-browser.ts`, `src/shared/**`, `scripts/write-schemas.ts` | As in the short list |
| `tests/unit/protocol-*`, `config-*`, `store-read-run-folder*` | Their tests |

**Phase 2.** Four agents in parallel, on the short list's paths.

| Agent | Items |
| --- | --- |
| Browser | Facts F3, F4, F6, F7 and F12 first. `select`, `check`, `uncheck` and `scroll`, and the guard's arming for a wheel (M3-1); titles, the navigation rule and each navigation's cause (M3-4) |
| API | `select`, `check`, `uncheck` and both `scroll`s, with their compile-fail fixtures (M3-1) |
| Runner | Their event fields (M3-1); title fields, `cause`, and the redactor's new keys (M3-4); the resolve hook in `child.ts`, `lastRunFile`, the stop reason and secret signals (M3-7) |
| CLI | M3-13 for the rest of wave 1 |

**Phase 3, Verification.** One agent, on the short list's paths: acceptance checks 4 and 7, the rest of checks 1, 6 and 8, and check 9 again. The guide and the handoff cover all of wave 1.

M3-6 is decided and built; each Verification also runs the `m3-*` checks in the Linux harness.

### Wave 2

**Phase 1, Foundation:** `src/protocol/**` (the wave 2 commands, events, evidence kinds and `tab`), `src/config/**` except `load.ts` (`video`, `downloads`, `inbox`), `src/browser/contract.ts` (recording, uploads, downloads, tabs), `src/runner/contract.ts` and `index.ts` (`video`, `VideoEncoder`, `Recording`), and placeholders as in wave 1. When a host needs proxy authentication: `ProxySettings.username` and `password`, `LoadedProxy.credentials`, `ProxyOptions.credentials`, `ConfiguredApps.proxyPasswords` and `resolveSecrets`' `proxyPasswords` (M3-5).

**Phase 2**, in parallel:

| Agent | Paths | Items |
| --- | --- | --- |
| Browser | as in wave 1 | Facts F8 to F11 first. The screencast (M3-8); file inputs, choosers and downloads (M3-9); tabs (M3-11). When a host needs it, fact F2, then proxy authentication (M3-5) |
| API | as in wave 1 | `upload`, `waitForDownload`, `inbox`, `goto(Secret)`, `waitForTab` and their types (M3-9 to M3-11) |
| Runner | as in wave 1 | Recordings, retention and encoding (M3-8); upload files and download artifacts (M3-9); inbox calls, secret names and redaction (M3-10); tab routing, claims and events (M3-11). When a host needs it, proxy passwords, their redaction and hiding (M3-5) |
| CLI | as in wave 1 | `--video`, and M3-13 for wave 2 |

**Phase 3, Verification:** as in wave 1, with acceptance checks 10 to 14, and 15 when proxy authentication is built.

## Acceptance checks

The Verification phase proves each through the real command line, or the real `/runner` subpath where it says so, against real Chrome: Google Chrome 154 stable, and Chrome for Testing 153 at `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, passed as `chromium({ executablePath })`. That is a plain browser build on disk; no Playwright code runs. After every run the harness validates `events.jsonl` and `result.json` against the regenerated schemas, checks that JSONL stdout is exactly those events, and checks cleanup as the handoff's part 2, section 9 describes.

### Wave 1

Each check says which part of wave 1 it proves. The short list's Verification runs the checks and parts marked short list, and check 9. The rest's Verification runs the others, and check 9 again.

1. **Actions.**
   - Wave 1, short list, `m3-press`:
     - A form submitted with `locator.press('Enter')`, and one with `page.keyboard.press('Enter')` after a fill: the server counts one submission each, and the navigation that follows is recorded.
     - `Tab` moves the focus; `Shift+Tab` moves it back.
     - A covered element fails `press` with `not_actionable`, and no listener of the page heard the key.
     - A browser killed during a press gives `outcome_unknown`, and the press is not sent again.
   - Wave 1, `m3-actions`:
     - `select` by label, by value, and several in a `<select multiple>`; a missing option waits and fails `not_found`; two options with one label fail `ambiguous` at once; the event says `input: 'script'`.
     - `check` and `uncheck` on a native checkbox, a `role="checkbox"` element and a hidden checkbox with a styled label; one already checked sends nothing; one that ignores its click fails `not_actionable` after one click; `uncheck` on a radio button is `unsupported`.
     - `page.scroll` loads more items; `locator.scroll` on a terms box enables its Accept button.
     - A covered element fails `check` and `scroll` with `not_actionable`, and no listener of the page heard the input.
2. **Host checks** (`m3-host-checks`, through `/runner`). Wave 1, short list.
   - Passing checks pass the test, as parent events and in the result.
   - A test whose own assertions pass, but which ends on the wrong page, fails with `host_check_failed`, exit 1, with a screenshot of that page.
   - A file key applies to every test of that file, setups included, and its checks come before the test's own.
   - A key naming no selected test and no selected file, or an app the test does not use, exits 2 before any browser starts.
   - A test whose body failed lists its checks as `not_run`.
   - `absent`, `ignoreCase` and a `RegExp` path behave as M3-2 says.
3. **Observations** (`m3-observations`). Wave 1, short list.
   - In a real run, every `assertion.passed` with a locator names an `observation` event that the parent wrote earlier, for the same app and locator, and its observed text is the text the matcher compared. It says `judgedBy: 'parent'`, and every passed value assertion says `judgedBy: 'child'`.
   - A secret the page shows reads `{{name}}` in the observation.
   - A test file that speaks the protocol itself, and sends `assertion.passed` for `toBeVisible` naming an observation whose count was 0, ends `test_error`. Its process is gone, and no `assertion.passed` is written for it.
4. **Titles and causes** (`m3-titles`). Wave 1.
   - `navigation`, `action.*`, `assertion.*` and `observation` events carry titles; a redirect chain gives each document its own; a title holding a secret reads `{{name}}`; a title with control characters has none in any report.
   - Each navigation carries its cause: `goto` for a `goto`, `action` for a link click and for Enter in a form, and `page` for a redirect the page makes on its own a moment after it loads.
5. **Proxy** (`m3-proxy`). Wave 1, short list. With the fixture proxy and `bypass: ['<-loopback>']`:
   - every request the page makes goes through the proxy, proved by the fixture app refusing any request without the proxy's header;
   - a host in `bypass` goes around it;
   - a proxy that refuses the connection fails the test `setup_failed`, naming the proxy's `server`;
   - `browser.started` records the proxy's `server` and `bypass`.
6. **A host-style run** (`m3-host-run`, through `/runner`, from a project outside the repository with the packed tarball installed offline). Wave 1, short list, extended in wave 1.
   - The config is `defineConfig({ ... })` in the host script, validated with `validateConfig(value, '<root>/host.config.ts')`, a label with no file behind it.
   - One app on Chrome for Testing, with the fixture proxy as its `proxy.server` and no credentials.
   - Every secret is a function. `resolveSecrets(config, {})` gives the map. The one-time code's function reads the code the fixture app last sent.
   - The script writes the test file into a new folder inside the project, and the file imports the package by name.
   - `hostChecks` keyed by the test file's path: an address with origin and path, text present, and text absent.
   - `testEnvironment: { CANARY: 'visible' }`, while the script's own environment holds `HOST_TOKEN`. The test prints whether each is set.
   - An `outputDir` the script chose, and a reporter of the script's own that collects events as they arrive.

   It checks: `passed` and exit 0; every page request went through the proxy; the host checks are parent events and in the result; each passed locator assertion names a parent observation and says `judgedBy: 'parent'`; the test process saw `CANARY` and not `HOST_TOKEN`; neither the sign-in password nor the code is in any file of the run folder, in stdout or in the collected events. Then, against a fixture that saves and ends on the wrong page, the same run exits 1 with `host_check_failed`.

   Once the rest of wave 1 lands, the same check also: writes the test file into a new temporary folder with no `node_modules`; sets `lastRunFile: false`, and finds no `.retest` folder under the root; finds that `readRunFolder(outputDir)` gives the result `runFiles` returned and the events the reporter collected; finds that the app's last `navigation` before the host checks does not say `cause: 'goto'`; and, aborted with a `Failure` as the reason, records that reason and exits 130.
7. **Two runs at once** (`m3-concurrent-runs`). Wave 1. Two `runFiles` calls in one process, with different roots and run folders, both pass. Each folder holds only its own events, and cleanup holds for both.
8. **Package** (`m3-package`). The tarball exports every new name from `/runner` and `/protocol`, and a registered consumer type-checks on TypeScript 6 and 7 with `skipLibCheck: false`. The compile-fail fixtures reproduce on both compilers. Wave 1, short list: the short list's names, and a consumer using `press` and `keyboard`. Wave 1: the rest, and a consumer using `select`, `check` and `scroll`.
9. **Milestones 1 and 2 still hold.** Both parts of wave 1. Every existing integration test passes: honest outcomes and exit codes, no repeated actions, timeouts, disconnects and signals, JSONL purity, `inspect` on torn runs, the secret rules, and cleanup of every process, profile, server and state file.

### Wave 2

10. **Video** (`m3-video`). With `record: 'on'`, each test's page has frames, `frames.json` with times that never go backwards, and `frames.ffconcat`. `retain-on-failure` keeps only failed tests' frames. A fixture encoder is called once per kept recording and its file is recorded as `kind: 'video'`. An encoder that throws gives `evidence.failed` and leaves the outcome alone. Without an encoder, `inspect` prints the ffmpeg line.
11. **Uploads and downloads** (`m3-files`). A path and bytes reach a hidden file input and a button that opens a chooser; a path outside the root is `usage`. A download lands in `artifacts/downloads/` with its size and hash; `waitForDownload` returns it; one over the cap is cancelled and recorded; `downloads: false` refuses it; nothing is written outside the run's own folders.
12. **Inbox** (`m3-inbox`). A sign-up through the fixture app: the test types `inbox.address()`, reads the message, fills `codes[0]` and opens `links[0]`. Neither value is in any file of the run folder or the test process's output. No message in time fails `not_found`.
13. **Tabs** (`m3-tabs`). A `target="_blank"` link, `window.open` and a `noopener` link each give a tab with the guard before its scripts; `waitForTab` returns the oldest one not yet taken; a popup that closes itself after its button is clicked passes; a command to a closed tab fails `not_actionable`; a host check on tab 2 passes.
14. **The host-style run again**, with video, an upload, a download, the inbox and a tab added.
15. **Proxy authentication** (`m3-proxy-auth`). Only when M3-5's credential half is built. With the fixture proxy's basic authentication on, and a `username` and a function `password`:
    - the page's requests pass the challenge, a service worker's and a cross-site frame's included (fact F2);
    - an `env` password is read once, and its variable is hidden from the test process;
    - a wrong password exits 2 with `setup_failed`, naming the proxy's `server`;
    - the password is in no file of the run folder, not in stdout or stderr, and not in the test process's environment;
    - `resolveSecrets(config, {})` gives the proxy passwords, and the host-style run of check 6 passes with them.

### Gates

Each command runs from the repository root, one after another, never two at once. Each runs with its output redirected to a file, such as `npm run test:unit > "$gates/unit.txt" 2>&1; echo "exit $?" >> "$gates/unit.txt"`, with `$gates` one folder under the system temporary folder. Read the file after the command ends. Never pipe a running gate through `tail` or `grep`, which hides its exit code.

| Command | What it proves |
| --- | --- |
| `npm run build` | `dist/`, and schemas that include every new event |
| `npm run typecheck` | TypeScript 6 and 7, and `examples/tasks` |
| `npm run test:unit` | Logic, with fakes |
| `npm run test:types` | Every compile-fail marker on both compilers |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/browser-*.test.ts" tests/integration/cdp.test.ts` | Real Chrome at the browser level |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/matrix-*.test.ts" tests/integration/run-interrupt.test.ts tests/integration/cli-commands.test.ts tests/integration/package-smoke.test.ts` | Milestone 1 |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m2-*.test.ts"` | Milestone 2 |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | Milestone 3 |

A group that takes more than five minutes is split by file, and the split is written into the handoff.

## Rules for every agent

- Work only in the Retest repository, and only in your phase's files. Never commit, stage, reset, stash or discard anything.
- Never touch `x-series/` or `README.md`, and never change `private` or `description` in `package.json`.
- Never touch the user's own browsers, profiles or apps. Kill only process ids you started.
- Keep the Chromium sandbox on. Never pass `--no-sandbox`, `--disable-setuid-sandbox` or any flag that weakens it, in code, tests or probes.
- In tests, temporary folders come only from `tests/support/temp-folder.ts`. A probe puts its files under one folder of its own in the system temporary folder and removes it afterwards.
- No network beyond loopback, and no installs. No new dependency of any kind.
- Keep every command under five minutes. Split a suite that would take longer. Never wait idle on a background process.
- Capture every gate to a file as the Gates section says, and report its exit code from the command itself.
- Report exactly what ran, with exit codes and counts, and what you could not verify, most important first.

## Open questions

Most important first. None blocks wave 1 from starting; each names who settles it.

1. **Download and recording limits** (wave 2): 100 MiB per download, 15 000 frames per recording, 25 frames a second and 120 seconds per encoding are constants. Whether a host needs to set them is unknown until one runs at volume.

### Decided

These were open questions. The orchestrator has decided each, for the reason given.

- **Proxy authentication.** Deferred to wave 2, built when a host needs it (M3-5). A host that runs its own proxy on loopback needs only `proxy.server`. If it is built, Retest starts no relay on loopback, since the test process could use one to reach the proxy with the host's credentials.
- **A host check sees the final page, not the path to it.** `navigation` events say their cause (M3-4). It costs one field and makes "the final page was not opened by `goto`" a parent fact.
- **Judging passes twice.** The parent judges every passed locator assertion on the observation it names (M3-3). Without it, a passed locator assertion is the test process's claim, not the parent's fact.
- **`select` by keyboard.** `select` stays scripted selection whatever F3 shows, and its event says `input: 'script'`. Type-ahead follows prefix rules that differ by platform and cannot reach a second option with the same prefix.
- **Inbox heuristics** (wave 2). The provider's own `codes` and `links` are the normal path, and the stated rules are the fallback for a provider that supplies raw messages. A provider knows its messages; the rules only guess.
- **Navigation title timing.** Keep the `DOMContentLoaded`, next command or one second rule. `Target.targetInfoChanged` would mean discovering targets browser-wide, which the browser pool avoids on purpose.
- **Host checks outside code.** Programmatic only, until someone asks for a config key or a flag. The one user today is a program.
- **File-keyed host checks.** `hostChecks` keeps the file-keyed form beside test ids (M3-2). It is additive, and saves loading the file a second time on every run to learn the test's id.
