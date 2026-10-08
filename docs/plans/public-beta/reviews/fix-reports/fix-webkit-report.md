# Fix lane W (WebKit driver): report as it stands at the restart

Old-code runs use an untouched copy of the old tree in `.retest/scratch-fix-webkit/old-tree`.

## Findings
- **W-1 (looks at once).**
  - Change: `src/browser/webkit/turns.ts` (new, one turn per target), and `target-session.ts:396-500`. The document is read once per world. Each look holds the turn from its reading until every element it found is an object. A lost node triggers a full reread, and a look that keeps losing it ends as `LostReadingError`; `page.ts` `lostReading` turns that into a named timeout.
  - Tests that fail on the old code:
    - three unit tests in `webkit-target-session.test.ts` (fail old, pass);
    - the shared case "two or three looks at once…" in `browser-locators.test.ts`: passes on WebKit and Chrome, fails on the old bridge with `Missing node` (`/tmp/retest-fix-webkit-looks-*-1.log`).
- **W-2 and held item 5 (roles and names).**
  - Change: `accessibility-reading.ts` (new; the reading and its doubts), `roles.ts:57` (`chromeRoleOf` mappings), `roles.ts:75-110` (doubt matching, refusals, `generic`), `page.ts:489` (refusal comes from a doubt, before any input goes).
  - Test: `tests/integration/webkit-roles.test.ts`. Cell by aria-label, custom option beside a select, and field by shown label are answered.
- **W-3 (two skipped cases).**
  - Change: a per-engine gate in `tests/integration/engines.ts:52` (`launchGated`, `InputGate`, `launchWithGate`, `crash`, `crashBrowser`). Both shared cases now use it.
  - Result: both cases pass on WebKit and Chrome (`/tmp/retest-fix-webkit-gate-{actions,secrets}-*-1.log`). A Firefox gate must supply `launchGated(options, timeoutMs, gate)`: hold each 'key down'/'key char'/'key up'/'text' input until `gate.hold` settles, and call `gate.loaded(url)` when a main-frame document loads.
- **W-4 (sweep).**
  - Change: `sweep.ts:66-118` and `process.ts:131-170` (`processStartedAt` throws when the reading fails; `parseProcessStart`).
  - Test: 7 new sweep unit tests fail on the old code; all pass now.
- **W-5 (budgets).**
  - Change: `target-session.ts:332` and `:591` (shared world setup and global object, each caller bounded by its own budget) and `:661-700` (one deadline per call and per reading).
  - Tests:
    - unit test (fails old, passes);
    - busy-page case in `webkit-driver.test.ts`: fails on the old code (goto waited 8037 ms). It did not run on the new code in a run that could launch a browser.
- **W-6 (record and splits).**
  - Three shared navigation cases split into seven, every assertion kept.
  - The record (`docs/plans/public-beta/proofs/webkit-driver.md`) is restated, with the old and new titles.
  - It says the m2-state second target is the same build and browser.
- **W-7 (frame label).**
  - Change: `webkit-collector.ts:405`. A provisional target's Document request is now `main`.
  - Test: unit test fails old, passes.
- **W-8 (select).**
  - Change: `select.ts`. Plans now start with Home or End and cover only the options asked for; anything else is refused by name (`detour`).
  - Test: case in `webkit-driver.test.ts`, which logs every change. Its page was served wrongly in the last run (its address carried a query the test server did not know); fixed, then **not run, waiting for the restart**.
- **W-9 (page setup).**
  - Change: `browser.ts:271-300` and `page.ts:208`.
  - Test: `tests/unit/webkit-browser.test.ts` fails old, passes.
- **W-10 (listeners).**
  - Change: `page.ts:904` and `connection.ts:364`.
  - Test: unit test in `webkit-page.test.ts` fails old, passes.
- **Held item 4 (output close).**
  - Change: `process.ts:487`, the same fix as Chrome's.
  - Tests: the late-writing unit test fails old and passes. The busy-thread test passes on old code too, so it does not reproduce the race.
- **Conformance lane findings.**
  1. The hidden-label refusal went too far. It is now limited to names the labelled control could carry (`accessibility-reading.ts`), and a shown-label case was added to the role table.
  2. A failure that comes at the deadline is now held until the budget has passed (`page.ts` `#execute`).
  - Both: **not run, waiting for the restart**.

## Role table (152 pages, 12495 lookups)
- Result: 12106 answered as Chrome answers, 389 refused by name, none answered differently.
- Mapped to Chrome's role from the element's own kind:
  - a one-option select is a combobox;
  - a number field is a spinbutton;
  - an input with a `list` naming a datalist is a combobox, unless it is a range or a colour;
  - date and time fields, and editable `<div>`/`<span>` with no role, get no role a lookup can ask for;
  - a `<figcaption>` is not a caption.
- Refused by name:
  - `generic`, always;
  - `img`: an `<img>` without alt that WebKit leaves out, or an `<svg>` with no role;
  - `option`: without a name when the page holds select options; with a name only if a select option could carry it;
  - `group`: optgroup or hgroup;
  - `emphasis` and `strong`;
  - an option, list item or tree item outside its context;
  - a role attribute WebKit overrode;
  - every role beside an editable element other than a div or span;
  - names of content-named cells, headers and tooltips;
  - a layout table;
  - names a hidden label's control could carry.

## Collector output changes (W-7 and the diagnostics findings)
- Scope: console and network now cover frames of the page's own site and of other sites, and the reason text says why.
- Frames:
  - console messages carry `frame`, through scripts mapped by WebKit's debugger (turned on, every pause off; no cost measured);
  - a message the browser logs about a request carries that request's frame;
  - the main document of a navigation into another web process is `main`, not `child`.
- Text: every argument now appears, with `(cut)` for one Retest cannot read. `console.count` keeps its type.
- Workers: a worker's own requests are dropped; its script request is kept as the page's.
- Time: a message or repeat without a timestamp is counted unread instead of taking the parent's clock.

## Gates
- Round 2 (`/tmp/retest-fix-webkit-gate-*-2.log`):
  - WebKit:
    - actions 79/80 (the phone page);
    - locators 26/26;
    - navigation 27/31 (named engine differences);
    - secrets 21/21;
    - lookup 1/1;
    - m2-state 3/3;
    - roles 2/2;
    - agent 17/17 with one skip;
    - driver 8/9.
  - Chrome:
    - actions 80/80;
    - secrets 21/21;
    - navigation 31/31;
    - locators 26/26;
    - diagnostics 30/30.
  - Diagnostics on WebKit: two checks failed, fixed since.
  - Conformance failed on both engines (runs exited 2, WebKit homes left behind). Likely cause is ownership readings failing on the crowded process table; not established.
- Unit: 93/93 for the WebKit files that need no process readings (`/tmp/retest-fix-webkit-unit-6.log`). The process-dependent files fail on this machine's crowded process table.
- Typecheck: lane files clean before the last small edits.
- **Not run, waiting for the restart:**
  - typecheck after the last edits;
  - `webkit-driver`;
  - `webkit-roles` (new case);
  - diagnostics on WebKit;
  - conformance on Chrome and WebKit;
  - process-dependent unit files.
  - Reason: about 4000 hung processes from another session made the `ps` output exceed what the ownership reading allows, so no browser could start.

## What I could not verify, most important first
1. The unrun gates above, conformance first.
2. Role lookups outside the table's element kinds.
3. AI checks over WebKit captures.
4. A web content process crashing under a live page.

## Needs from other lanes
- `src/diagnostics/observations.ts`: a way to mark a record's time as the parent's (D-8).
- A protocol field for finished requests (WebKit gives it only at finish).
- `engines.ts` gate hook: see W-3.

## Files changed
- Source:
  - new: `src/browser/webkit/{turns,accessibility-reading}.ts`
  - changed: `src/browser/webkit/{target-session,roles,page,browser,connection,process,sweep,select,capture}.ts`, `src/diagnostics/webkit-collector.ts`
- Unit tests:
  - new: `tests/unit/webkit-browser.test.ts`
  - changed: `tests/unit/webkit-{target-session,input-events,page,process,sweep,collector,connection,navigation,relay,runner}.test.ts`
- Integration tests:
  - new: `tests/integration/webkit-roles.test.ts`
  - changed: `tests/integration/{webkit-driver,engines,browser-actions,browser-secrets,browser-navigation,browser-locators}.test.ts`
- Record: `docs/plans/public-beta/proofs/webkit-driver.md`
- No dependency or script changes.

## After the restart

Every heavy run went through `lockf -t 0 /tmp/retest-heavy-gate.lock`, retried every sixty seconds (`.retest/scratch-fix-webkit/after-locked.sh` and `after-batch.sh`), with no benchmark running. Logs are `/tmp/retest-fix-webkit-after/<gate>-<round>.log`. Round 1 ran the fix round's code; round 2 followed the deadline fix below; round 3 followed element identity and another lane's change to `src/browser/page-scripts.ts`. A session cut came between rounds 1 and 2; nothing of mine was left running and no log was partial.

### Gates

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| WebKit unit files | `node --conditions=retest-source --test tests/unit/webkit-*.test.ts` | 103/103, then 104/104 after each change | `unit-2.log`, `unit-3.log`, `unit-5.log` |
| Driver | `node --conditions=retest-source --test --test-concurrency=1 tests/integration/webkit-driver.test.ts` | 9/9; 10/10; 10/11 (my new case expected a trailing space `document.title` drops; fixed); 11/11 | `webkit-driver-{1,2,3,4}.log` |
| Role table | same, `webkit-roles.test.ts` | 2/2 each round; 12581 lookups in 152 pages, 12189 alike, 392 refused by name, none different | `webkit-roles-{1,2,3}.log` |
| Shared suites on WebKit | same, `webkit-browser-{actions,locators,navigation,secrets}`, `webkit-lookup`, `webkit-m2-state` | each round 79/80, 26/26, 27/33, 24/24, 1/1, 3/3, nothing skipped; the failures are the phone page (refused by name) and the three recorded navigation differences (the title case now counts two subtests and itself) | `webkit-*-{1,2,3}.log` |
| Collector on the real build | `--test-name-pattern='^WebKit: ' tests/integration/diagnostics-engines.test.ts`, and `^Chrome: ` | WebKit 30/30 in three rounds; Chrome 30/30 | `diagnostics-webkit-{1,2,3}.log`, `diagnostics-chrome-1.log` |
| Collector contract, unit | `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts` | WebKit 5/7; the file then hangs until the alarm (its Firefox rigs fail and keep a handle) | `unit-diagnostics-engines-1.log`, `unit-diagnostics-engines-webkit-1.log` |
| Agent suites on WebKit | `tests/integration/agent-webkit.test.ts` | 26 pass, 0 fail, 2 skipped by name (the refusal-rule case, skipped on a pinning engine; Chrome's screencast) | `agent-webkit-3.log` |
| Shared suites on Chrome | `tests/integration/browser-{actions,secrets,navigation,locators}.test.ts` | 80/80, 24/24, 33/33, 26/26 | `browser-*-1.log` |
| Conformance | `RETEST_CONFORMANCE_OPT_OUT=firefox ... tests/integration/conformance.test.ts` | Chrome 146, 148, 148 of 148; WebKit 146, 147, 146 of 148; 15/15 runs on both each round | `conformance-{1,2,3}.log` |
| Compilers | `node_modules/typescript/bin/tsc -p tsconfig.json`, `node_modules/typescript-7/bin/tsc -p tsconfig.json` | no error in a WebKit file; errors only in other lanes' files | `tsc6-3.log`, `tsc7-3.log`, `typecheck-1.log` |
| Type tests | `npm run test:types` | fails on `src/evaluation/frames.ts:97` only | `types-2.log` |

Conformance differences on WebKit: F8.1a every round, a cell looked up by name, refused by name (difference 4 of the record); A12 in round 1, a covered checkbox refused at 499 of 500 ms (fixed below, passing in rounds 2 and 3); S7 in round 3 at 1499 of 1500 ms, in the shared poll (below). F7.1 to F7.4 and A11 pass every round. On Chrome: N5 and F10.5 in round 1, the same poll race.

### Found and fixed in these runs

- **A failure told before its budget.** `src/browser/webkit/page.ts:595`: a failed result is now held to its budget when the deadline has run out, when it is a timeout, or when it says it waited the whole budget (`waitedWholeBudget`, `page.ts:164`). The last look's browser call can time out more than a millisecond early by the clock, with the deadline still reading time left; A12 showed it. Tests: unit `a timeout, or a failure that says it waited the whole budget, is held to its budget; one that fails at once is not` (`webkit-page.test.ts`); integration `a click on an element that stays hidden, and a check of a checkbox that stays covered, are refused only once the whole budget has passed, every time` (200 refusals at 60 ms; on the code before the fix round one hidden-button refusal came at 59.753 ms, `old-driver-1.log`).
- **Element identity (the coordinator's addition).** `WebKitPage implements ElementIdentity` (`page.ts:173`): `readElements` around `observeKeyed`, refusing a `generic` lookup and any lookup a reading's doubt could change, for each locator (`page.ts:362`); `dispatchTo` through `dispatchPinned` (`page.ts:412`). The multiple-select plan reads the pin: `select.ts` builds `listPlanFunction` with its own first line taking `{ choices, element }`, the shared key store sliced from `keyedObserveFunction` (with a load-time check that fails by name if the shared source changes shape), and answers `moved` before planning; `page.ts:805` turns that into the shared `moved` refusal's words (`movedList`). `pinningEngines` in `tests/integration/agent-harness.ts` now names `webkit`. Tests: integration `a WebKit list's keys are planned only from the element an action is pinned to, and a pinned choice reaches only that list`; the agent identity suite on WebKit. Changed title in `tests/unit/webkit-relay.test.ts`: "a WebKit list's plan is the shared selection function with its last step replaced, and its keys are Home and the arrows, Shift widening" became "... with its first line and last step replaced, checks the element an action is pinned to before it plans, ...", since the plan's first line is now its own; it still holds the shared body verbatim and fails on the earlier `select.ts` (`old-relay-plan-1.log`).

### Findings

Old-code runs used today's tests against this lane's files from before the fix round (`.retest/scratch-fix-webkit/old-tree`), everything else current.

| Finding | State | Evidence on the old code |
| --- | --- | --- |
| W-1 looks at once | fixed | unit: the two target-session cases fail; integration: looks at once throws `Missing node` (`old-looks-1.log`); passes on WebKit and Chrome now |
| W-2 roles differing silently | fixed | the role table on old code stops at W-1's `Missing node` before any comparison, so it does not show W-2 alone; the review's seven differing kinds are the old-code evidence; the table passes now |
| W-3 gated cases skipped | fixed | both now run on WebKit and Chrome, none skipped |
| W-4 sweep on a failed reading | fixed | seven sweep unit cases fail (`old-unit-1.log`) |
| W-5 budgets | fixed | unit case fails (waited 5001 ms); the busy-page integration case passed on old code this time (goto 1015 ms), so it does not show W-5 |
| W-6 record | fixed | record restated, now with these counts |
| W-7 frame label | fixed | collector unit case fails |
| W-8 select | fixed | integration case fails: the page heard A, B, C, D alone on the way to D and E |
| W-9 page setup | fixed | `webkit-browser.test.ts` fails |
| W-10 listeners | fixed | `webkit-page.test.ts` dispose case fails |
| Held 4 output close | fixed | late-writing case fails 3 of 3 (`old-held4-*.log`); the busy-thread case passes on old code too |
| Held 5 refusals too broad | fixed | the cell by `aria-label` is refused on old code (`old-roles-1.log`) |
| Conformance lane: hidden label | fixed | F7.1 to F7.4 pass in all three runs |
| Conformance lane: deadline | fixed, widened above | hidden-button refusal at 59.753 ms on old code; A12 on the round-1 code |

### In other lanes' files

1. `src/assertions/look-until.ts:56` and `:76`: the poll stops once less than a whole millisecond is left, so a check fails at 1499.x of 1500 ms (S7 on WebKit, N5 and F10.5 on Chrome). Reproduce: conformance on either engine, intermittent. Waiting out the rest of the budget after `deadline.expired` would close it.
2. `tests/unit/diagnostics-engines.test.ts:242-243` against `:291` and `:321`: the WebKit rig's "required" console message has no `timestamp` but the case expects the engine's time and a complete console. The collector counts such a message unread (it no longer takes the parent's clock). Reproduce: `node --conditions=retest-source --test --test-name-pattern="webkit collector" tests/unit/diagnostics-engines.test.ts`. The file also hangs after its Firefox cases.
3. `tests/unit/runner-target-drivers.test.ts:453`: the doctor case expects "no driver for iOS simulator apps yet" where doctor now names the missing HOME cache. Reproduce: `node --conditions=retest-source --test tests/unit/runner-target-drivers.test.ts`.
4. `tests/integration/agent-harness.ts:36`: the comment above `pinningEngines` still says "Chromium's".
5. `src/browser/actionability.ts:231`: `moved` is not exported, so the WebKit list plan repeats its words; exporting it would remove the copy.
6. Typecheck errors in `fixtures/evaluation-corpus/runner/score.ts`, `src/evaluation/frames.ts`, `tests/unit/evaluation-frames.test.ts`, and on TypeScript 7 `src/browser/firefox/accessible-names.ts:131`.

### Not verified, most important first

1. The shared poll's early end (item 1 above) is left open; it is not the page's.
2. The pinned list plan when a page swaps its select between the look and the plan: shown by calling the plan with another list's key and end to end through `dispatchTo`, not by a page that swaps in that moment.
3. The widened hold failing on the code just before it: the early timer cannot be forced; the unit case holds the rule, and A12 was seen once on the real build.
4. W-2 on old code alone, and W-5's busy page on old code (both above).

### Files changed after the restart

- `src/browser/webkit/page.ts`: `waitedWholeBudget`, the widened hold, `ElementIdentity` (`readElements`, `dispatchTo`), the pin carried to the list plan, `movedList`.
- `src/browser/webkit/select.ts`: `ListPlanRequest`, the plan's own first line, the shared key store, `moved`.
- `tests/unit/webkit-page.test.ts`: the hold rule case.
- `tests/unit/webkit-relay.test.ts`: the list plan case, retitled as above.
- `tests/integration/webkit-driver.test.ts`: the held-refusals case and the pinned list case.
- `tests/integration/agent-harness.ts`: `'webkit'` added to `pinningEngines`.
- `docs/plans/public-beta/proofs/webkit-driver.md`: result, scope rows, differences 4 and 9, commands, not verified.
- Scratch, ignored by git: `.retest/scratch-fix-webkit/after-batch.sh`, `after-locked.sh`; the two scratch trees made for old-code runs were removed. No dependency or script change.
