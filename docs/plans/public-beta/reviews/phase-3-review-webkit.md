# Review: Phase 3 WebKit driver

My rules don't let me write files, even under /tmp, so the whole report is below.

**Counts:** 2 high, 4 medium, 4 low.

**Five worst:**
1. **W-1 (high):** two assertions that check the same WebKit page at the same time make one of them see fewer elements, or throw. On the real build, a page with 400 buttons came back as 0, 100, 200 or 300.
2. **W-2 (high):** some role lookups return different elements on WebKit than on Chrome, and the driver does not refuse them. Where WebKit finds fewer, a "must be hidden" or "count is 0" check passes on WebKit and fails on Chrome.
3. **W-3 (medium):** two shared cases that guard invariants are skipped on WebKit for a reason that is not true. The driver accepts a transport hook, so the gate those cases need can be built.
4. **W-4 (medium):** the sweep treats a failed start-time reading as "the Retest process that made this home is dead". It can then kill another live run's WebKit helpers and delete its home.
5. **W-5 (medium):** some page calls ignore the command's time budget and wait up to the 60 s setup budget instead.

## Findings

### W-1 (high): looks at the same time lose elements or throw
- **Where:** `src/browser/webkit/target-session.ts:351-378`, and lines 365-368 and 384-388; `src/browser/accessibility.ts:89`; `src/browser/command-failures.ts:72`.
- **Claim:**
  - Each role or label lookup calls `DOM.getDocument`, and on WebKit that cancels every node id handed out before it.
  - The bridge then reads WebKit's "Missing node for given nodeId" as "this element was removed". It drops the element silently, or the lookup throws.
  - The test API allows this case: `src/api/command-lanes.ts:8` says "assertions may look together".
- **Failure scenario:**
  - A test runs `Promise.all([expect(getByRole('button', { name: 'Delete' })).toBeHidden(), expect(getByRole('heading')).toBeVisible()])`.
  - The first look's node ids are cancelled partway through its read. It returns `ok: true` with a low count, so `toBeHidden` passes while the button is on screen.
  - Seen on build 2359 (`probe6-1.log`): with a second look started 2 to 50 ms after the first, the first reported 0, 100, 200 or 300 of 400 buttons.
  - Started together (`probe5-2.log`), two of the three looks threw `DOM.querySelectorAll failed: Missing node` in 8 of 8 rounds. That error escapes `execute` as an internal error, because `failureFromError` rethrows it.
  - Also seen: after a second `DOM.getDocument`, an old node id fails both `getAccessibilityPropertiesForNode` and `resolveNode`.
- **Fix:** run each target's accessibility read and its node lookups one at a time, under one lock. Never read "Missing node" as removal; retry the whole read. Add an integration case with two looks at once.

### W-2 (high): role lookups differ from Chrome without a refusal
- **Where:** `src/browser/webkit/target-session.ts:334-378` and `src/browser/webkit/roles.ts:5-11` and `40-44`.
- **Claim:** the driver refuses only a few roles by name (cell, grid cell, column and row header, tooltip, and options when a select is on the page). Outside that list, WebKit's computed roles and names still differ from Chrome's, and nothing refuses or records it.
- **Failure scenario (from `probe4-1.log` and `probe3-1.log`):**

  | Lookup | Chrome | WebKit |
  | --- | --- | --- |
  | `getByRole('img')` on `<img>` with no alt | 1 | 0 |
  | `getByRole('combobox', { name: 'Pick' })` on `<input list>` | 1 | 0 |
  | `getByRole('generic')` on `<abbr>` | 1 | 0 |
  | `textbox` on `<input type=date>` | 0 | 1 |
  | `textbox` on a contenteditable div | 0 | 1 |
  | a lone `role=option` | 0 | 1 |
  | `textbox` named by a label inside `display:none` | 0 | 1 |

  - So `expect(getByRole('combobox', { name: 'Country' })).toBeHidden()` on an autocomplete field passes on WebKit and fails on Chrome. That is the "find less on WebKit" outcome the lane's own refusal was built to prevent.
  - The other 41 named lookups I tried, and 45 of the 52 element kinds, agreed.
- **Fix:** refuse by name, or map, every role where WebKit's mapping is known to differ. Keep a cross-engine table of role membership as a test.

### W-3 (medium): two invariant cases skipped for a reason that is not true
- **Where:** `tests/integration/browser-actions.test.ts:701` and `tests/integration/browser-secrets.test.ts:245`; the record `docs/plans/public-beta/proofs/webkit-driver.md`, section "Cases not run on WebKit"; `src/browser/webkit/browser.ts:61`.
- **Claim:**
  - The record says these cases need "an instrument only Chrome's protocol has".
  - But `launchWebKit(options, timeoutMs, transport)` accepts a transport factory. The same gate could hold back the wrapped `Page.insertText`, or the key event sent to the page proxy.
- **Failure scenario:** two invariants are never exercised on WebKit and are reported as impossible to test:
  - a browser lost between key down and key up gives an unknown outcome, and the key went down once;
  - a secret is never typed into a document that arrives while the text is on its way.

  My probe shows the steady-state part works: stray typing is stopped, and `Page.insertText` respects a cancelled `beforeinput`. The race between documents remains unexercised.
- **Fix:** build a WebKit gate through the transport parameter and run both cases.

### W-4 (medium): sweep counts a failed reading as a dead launcher
- **Where:** `src/browser/webkit/sweep.ts:62`; `src/browser/webkit/process.ts:131-140` and `180`.
- **Claim:**
  - `processStartedAt` returns `undefined` both when the process does not exist and when the reading fails.
  - It records the launcher's start time as `'unknown'` when its own reading failed.
  - The sweep treats any mismatch as "the launcher is gone". It then SIGKILLs every recorded helper that still verifies, and runs `rm` on the home.
  - This is the opposite of the ownership rule: a failed reading should hold the resource, not grant kill authority.
- **Failure scenario:**
  - Runs A and B both use WebKit on one machine. B launches while the system file table is exhausted. That happened on this machine during this review: 276356 of 276480 open files, with "Too many open files in system".
  - B's `ps -o lstart= -p <A>` fails, so B kills A's WebContent, Networking and GPU helpers and deletes A's live home. A's page crashes mid-test.
  - A launcher whose own start time was recorded as `'unknown'` is swept even by its own next launch.
- **Fix:** tell "no such process" apart from "could not read". Leave the home alone on any failed reading, and never sweep a record with an unknown start time unless the pid is proven absent.

### W-5 (medium): page calls not bounded by the command's budget
- **Where:** `src/browser/webkit/target-session.ts:289-297` (`#install`), `477-489` (`#global`) and `351-377` (`#readAccessibility`).
- **Claim:**
  - `#global` and `#install` send with no timeout, so the connection default applies: the launch timeout, which is the 60 000 ms setup budget by default.
  - `raceSignal` only reacts to a stop, not to the deadline.
  - Each accessibility batch gets the whole remaining budget again, so several round trips in a row can together run past it.
- **Failure scenario:** a page starts a long busy loop 100 ms after load.
  - `goto`'s page-facts read, budgeted at 1000 ms or less, waits for the loop.
  - The first check after it, with a 2000 ms budget, reports its timeout only when the page frees up, or at 60 s, where Chrome reports at 2 s.
  - On a large DOM, a role look can also answer after its poll deadline.
- **Fix:** pass the caller's `timeoutMs` and deadline into `#global` and `#install`, and bound the whole accessibility read by one deadline.

### W-6 (medium): the record claims more than its tests show
- **Where:** `docs/plans/public-beta/proofs/webkit-driver.md`, the browser-scope table and "Engine differences"; `tests/integration/engines.ts:80-81`.
- **Claim:**
  - **Navigation "passing":** the three failing cases stop at their first assertion, so the rest of each never ran on WebKit. That rest covers: the title cut at the read limit without splitting a surrogate pair, an empty title reported as none, titles in navigation events, the `readPage` title, the 204 `goForward` half, and the connection-refused `details`.
  - **Locators "passing":** that sits beside W-1 and W-2, and the line "names agree for every role" holds only for the sampled roles.
  - **Diagnostics "passing":** that sits beside W-7.
  - **The skip reason:** see W-3.
  - **m2-state:** its "second build" target is the same build with the same pool key, so both targets share one browser. Per-target state is tested only through two contexts.
- **Fix:** restate each row with what actually ran, and list the unexercised assertions.

### W-7 (low): main document of a cross-process navigation labelled a child frame
- **Where:** `src/diagnostics/webkit-collector.ts:296-299`, used at line 258.
- **Claim:** the frame role is judged against `page.mainFrameId` at request time. The temporary new target's main frame id is not committed yet, so its document request is marked a child frame.
- **Failure scenario:** `goto` from 127.0.0.1 to localhost. The new document's request is recorded with `frame: 'child'`, `type: Document` (`probe-3.log`), and reports show the navigation as a child-frame request.
- **Fix:** classify Document requests of the provisional target, or of the pending navigation's loader, as main.

### W-8 (low): choosing several options sets options that were never asked for along the way
- **Where:** `src/browser/webkit/select.ts:53-58`.
- **Claim:** the plan starts with `Home`, which selects only the first option and clears the rest. Arrow keys then move that single selection, and the page fires `change` for each step.
- **Failure scenario:** a `select multiple` holds B and C, and the test asks for B, C and D. The page sees "A alone", then "B alone", then "B and C", then "B, C and D". An autosave-on-change page stores A alone for a moment. Chrome's toggle plan never selects an option nobody asked for.
- **Fix:** start from the first requested option where possible, or refuse when the current selection would be cleared on the way. At minimum, record the difference.

### W-9 (low): a page's setup can go to the wrong page
- **Where:** `src/browser/webkit/browser.ts:290-303`.
- **Claim:** `#pageCreated` hands the next queued setup to whichever page of the context is announced first.
- **Failure scenario:**
  - The test page calls `window.open` while `captureState` opens its side page.
  - The popup takes the side page's empty-document setup. The side page then opens the real site with no interception, so requests reach the site and its code runs. That breaks the claim at `storage.ts:76-79`.
  - The same race can give a test page the default screen in place of its viewport.
- **Fix:** bind the setup by the `pageProxyId` that `createPage` returns, and keep the target paused until then.

### W-10 (low): page listeners and connection maps can leak
- **Where:** `src/browser/webkit/page.ts:856-868`; `src/browser/webkit/connection.ts:358-365`.
- **Claim:** `dispose` never removes the page's connection listeners; only `markClosed` does, when `pageProxyDestroyed` arrives. The connection's maps also keep one empty listener set per page id for good.
- **Failure scenario:** a `deleteContext` that fails leaves the page subscribed to every later event on a pooled browser. Each test also adds two map entries that are never freed.
- **Fix:** unsubscribe in `#dispose`, and delete empty map entries.

## Status of the five held WebKit-lane items, on the current code

1. **Capture source name:** open. `CaptureSourceName` still lacks `'webkit'` (`src/protocol/identity.ts:25-27`), and `screenshotSource` still returns undefined for WebKit (`src/runner/test-pages.ts:102-104`). WebKit screenshots carry no source, and the screencast stays outside the contract.
2. **Chrome's early timeout:** open. `src/browser/page.ts` has no equivalent of `outlast`, and `look-until.ts` is unchanged.
3. **Shared isolated-world interface:** open. The bridge still copies Chrome's messages (`target-session.ts:28-32` and `528-544`).
4. **Output not closing within 1000 ms (`cleanup_failed`):** open, cause unknown. The code is unchanged (`process.ts:318` and `446-455`). Note that this machine hit system file-table exhaustion during this review.
5. **Role refusals too broad:** open (`roles.ts:44`, `page.ts:530-538`). W-2 is the opposite gap: missing refusals.

## Account of every skipped or differing shared case

Counts come from the lane's logs, `/tmp/retest-webkit-int-webkit-*-4.log`.

- **browser-actions, 66 of 68.**
  - Fail: "a scroll delta is in CSS pixels, also on a phone page zoomed out to fit". The desktop half passed; the phone half is refused at `newPage` by name. The difference is real.
  - Skip: "a browser lost between the key down and the key up". The skip reason is not true (W-3).
- **browser-navigation, 23 of 26.** Each failure is a real engine difference, but the rest of each case never ran (W-6).
  - Connection refused: the class assertion passed; the message is in WebKit's words; the `details` assertion never ran.
  - Title: WebKit keeps the ESC control character; the rest of the case never ran.
  - 204 case: the reload and first back parts passed; it fails at `assertOk(goBack)`, so the forward half never ran.
- **browser-locators:** 21 of 21.
- **browser-secrets, 10 of 11.** Skip: "a document that arrives while the text is on its way". Same untrue reason (W-3).
- **m2-state, 3 of 3.** The second target is the same build and the same browser, so distinct builds are not exercised.
- **lookup:** 1 of 1.
- **Conformance, 144 of 145.** F8.1 ends `unsupported` (refused by name) against a declared pass. `tests/conformance/` has no per-engine expected outcomes, so nothing there is loosened for WebKit.

## What I confirmed by running it

- **Unit tests:** `node --conditions=retest-source --test tests/unit/webkit-*.test.ts tests/unit/runner-target-drivers.test.ts` gave 99 of 99. A first attempt failed only because the system file table was full; the rerun was clean.
- **Probes on the real build:** each ran as `lockf -t 0 /tmp/retest-heavy-gate.lock perl -e 'alarm N; exec @ARGV' node --conditions=retest-source /tmp/retest-review-webkit/probeN.ts`, with output in `/tmp/retest-review-webkit/probe*-*.log`.
  - **`probe.ts`:** 45 named role lookups agree on both engines (41 found on both, 4 on neither). A fill whose field loses focus is refused the same way on both. The collector labels the cross-process main document as a child frame (W-7).
  - **`probe2.ts`:** page and provisional targets are created paused. `Page.insertText` into a focused field is stopped by the guard; the page never sees `beforeinput` and the value stays empty.
  - **`probe3.ts`:** hidden-element lookups agree except the textbox named by a hidden label. Names changed by the action just before a look are seen at once, 10 of 10 rounds on both engines.
  - **`probe4.ts`:** 53 element kinds; 7 differ (W-2).
  - **`probe5.ts`:** a second `DOM.getDocument` cancels earlier node ids, and looks started together throw in 8 of 8 rounds.
  - **`probe6.ts`:** staggered looks at once silently count 0, 100, 200 or 300 of 400 buttons (W-1).
- **Lane logs read:** `/tmp/retest-webkit-int-webkit-{browser-actions,browser-navigation,browser-secrets,browser-locators,m2-state}-4.log`, to account for each differing case.
- **Leftovers:** one early probe hung on my own `listening` race. I stopped that process (I had started it); nothing of mine is running now.

## What I could not verify, most important first

1. I did not run the WebKit integration suites, conformance or typecheck myself. The brief forbade whole-suite runs, so their counts are the lane's own.
2. W-4 in a real two-run collision; it is from reading the code only.
3. W-5's overrun on a page that busy-loops; from reading the code, not probed.
4. Navigations that end with no commit, no `loadingFailed` and no `provisionalLoadFailed` (a denied download, a policy "ignore"). `#pendingNavigation` may stay set and actions then time out. Not probed.
5. What holds the browser's output open in the `cleanup_failed` run.
6. W-9 (popup takes a side page's setup); from reading the code only.
7. A web content process crashing under a live page.
8. Whether `select()` with Home also fires `input` events the guard reports differently (W-8).
