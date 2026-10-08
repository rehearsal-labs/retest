# Fix lane G (agent sessions): report

State: all findings fixed in code and unit-tested; the final real-browser gate pass is not run, waiting for the restart.

## Findings (file and line, failing-first test, result)

- A-1: `src/agent/recipes.ts:44` `keyedRecipeProblem`, `:72` `oneReadRecipeProblem`; `src/agent/session.ts:572`, `:580`. A recipe is accepted only when a read proves it finds the referenced node (keys in one read), or, without driver keys, only when it is the look's own locator finding one element; else `unproven`. Failing first: `on a driver that cannot compare elements, a recipe naming another element that shows the same text is refused by name` and its keyed twin (agent-session.test.ts); `agent-recipes.test.ts` would not load on the old code. Pass now; on Chrome at 12:5x the integration case `a reference becomes a durable recipe only when one read proves ...` passed and failed on the old code.
- A-4: `src/agent/session.ts:537` `#target`, `:594` `#unpinned`, `:672` `#callPinned`; `src/agent/identity.ts:28` (driver contract). Pinned on a driver with keys; otherwise only a look's single element, through the look's own locator; else `unpinned`. Failing first: the six cases of `a reference acts only on the element it names`; on Chrome `fields that show the same, put in another order, ...` failed on old code. Pass now (unit; Chrome at 12:5x and 17:47).
- A-2: `src/agent/host.ts:191` (open catches everything), `:270` (one give-back), `:372` (launcher throw is a failed launch, forgotten), `:215` (allSettled). Failing first: `a launcher that throws before it returns fails each open by name, ...`, `... is asked again by each open`, `no launcher fault leaves a rejection unhandled to crash the host process` (child process crashed on old code). Pass now.
- A-3: `src/agent/host.ts:419` `#closeLate`, `:223` bounded wait in close, `:442` `#closeNow`. Failing first: `a browser that arrives after the host closed is closed as it arrives, and close waits for it`, `a late browser whose close fails makes the host close say so`, `a browser whose close throws before it returns ...`. Pass now.
- A-5: `src/agent/host.ts:318` hold cap; `src/agent/session.ts:309` `renew`, `:493`, `:500` lease, ending `caller_silent`. Failing first: `an open asking to stay longer than the host's hold is refused by name, holding nothing`, two lease unit cases; Chrome lease case failed on old code. Pass now (unit; Chrome at 12:5x, 17:47; Firefox at 18:01).
- A-6: `src/agent/host.ts:333` `#scopeOf` (a scope per owner, done inside src/agent; no runner change needed). Failing first: `a refusal names only the holders of the owner that asked, and counts the rest`; Chrome `owner and host limits ...` with added heldBy assertions failed on old code. Pass now.
- A-7: `src/agent/checks.ts:75` calls the runner's `decideHostCheck` (src/runner/run-host-checks.ts, landed by the runner lane); the copy is removed; `session.ts:413` passes `connected` and a stop reason that is undefined until stopped. Failing first: `a check is decided by the runner's own host check: ...` plus two message assertions now in the runner's words. Pass now.
- A-8: `src/agent/host.ts:318` (unknown secret, other owner, other app); `src/agent/session.ts:648` (allow-list). Failing first: `a session types only the secrets its open request names, and reads no other`, `an open naming a secret the host does not hold is refused by name`, `saved state restores only into a session of the owner and app that saved it`. Pass now.
- A-9: `src/agent/host.ts:411` lost browser closed after `lostBrowserGraceMs` (2 s). Failing first: `a lost browser is closed after a short grace, without waiting for the host to close`; Chrome lost-browser case (profile gone while the host is open) failed on old code. Pass now.
- A-10: `docs/plans/public-beta/proofs/agent-sessions.md` gate table rows narrowed and renamed, new rows, "Fix round" and "Element identity" sections. Record only.
- `./agent` export: `package.json:43`. Failing first: `tests/unit/agent-entry.test.ts` (both cases failed on the old package.json). Pass now. The capacity host program now imports `@rehearsal-labs/retest/agent`.

Old-code runs used the original agent sources (copy taken before this lane at /tmp/retest-fix-install/before/src/agent) in /tmp/retest-fix-agent/old-tree.

## What each driver needs for node identity

`readElements(locators, timeoutMs, signal)` (one task, keys per node per document) and `dispatchTo(command, key, ...)` (refuse `not_actionable`/`moved` in the readying task), as in `src/agent/identity.ts:28`; pieces in page-scripts.ts, locate.ts, and the three page.ts files. Sent to the orchestrator; held as docs/plans/public-beta/codex/fix-round/element-identity.md. Until then every engine refuses by name; integration cases assert `pinsElements === false`.

## Gates

- Agent unit files: `node --conditions=retest-source --test tests/unit/agent-*.test.ts` 93 pass, 0 fail (/tmp/retest-fix-agent/unit-agent-2.log).
- `npm run test:unit`: 3409 tests, 15 fail, none in agent files (cli-help, cli-run, diagnostics-engines, evaluation-contract, evaluation-runs, firefox-browser, firefox-sandbox, firefox-spawn, playwright-resolve, runner-resolve-hook, runner-target-drivers) (/tmp/retest-fix-agent/unit-all.log). Final rerun: not run, waiting for the restart.
- `npm run test:types`: fails on src/evaluation/frames.ts:97 only, not an agent file (/tmp/retest-fix-agent/types.log).
- `lockf ... npm run typecheck` (last run): exit 2, five errors, all in src/evaluation/frames.ts, tests/unit/evaluation-frames.test.ts, fixtures/evaluation-corpus/runner/score.ts; none in agent files (/tmp/retest-fix-agent/final3-typecheck.log). Scoped typecheck of every agent file: exit 0 (/tmp/retest-fix-agent/tsc.log).
- Chrome, three agent suites: 17 pass, 1 named skip at 12:5x on this code before the last capacity edit (/tmp/retest-fix-agent/integration-chrome-1.log); 16 pass, 1 fail, 1 skip at 17:47, the failure a `ps` buffer overflow in tests/integration/browser-harness.ts that another lane fixed during the run (/tmp/retest-fix-agent/final-chrome.log). Final run: not run, waiting for the restart (the 20:1x attempt had every launch refused by the ownership reader's output limit, src/shared/metadata-process-worker.ts:64, because another session's processes made the table 5 MB; that file then never exited).
- Old code on Chrome: 8 of the new cases fail as expected, 6 pass, 1 skip (/tmp/retest-fix-agent/final-before-chrome.log).
- Firefox (Launch Services): 15 pass, 2 fail, 1 skip at 18:01; both failures are typed text not arriving (handoff sign-in, four concurrent fills), the driver defect recorded before, Firefox lane mid-edit (/tmp/retest-fix-agent/final-firefox.log). Final run: not run, waiting for the restart.
- WebKit: not run, waiting for the restart (earlier attempts died with the host session or loaded during a Firefox mid-edit).

## Not verified, most important first

1. A final green Chrome run of the three agent suites after the last edit (a 1.5 s hold inside the shared-budget program's test so the agent's 300 ms open cannot be granted as the run ends; the old-tree run showed that race).
2. WebKit agent suites on this code.
3. Firefox green: two typing cases fail in the driver.
4. Node identity on any real engine: no driver offers it; only the fake proves the pinned and keyed paths.

## Files changed

src/agent/{host,session,looks,recipes,checks,index}.ts, src/agent/identity.ts (new); tests/unit/agent-{fakes,host,session,recipes,checks}.test.ts/.ts, tests/unit/agent-entry.test.ts and agent-host-program.ts (new); tests/integration/agent-sessions.test.ts, agent-capacity.test.ts; package.json (one `./agent` export block); docs/guide.md (agent section); docs/plans/public-beta/proofs/agent-sessions.md. No dependency or script change.

## After the restart

State: every gate the report left unrun is run; the agent fixes hold on Chrome and WebKit; on Firefox one case fails inside the Firefox driver. Element identity is built for Chromium and lifted into the agent there; Firefox and WebKit keep refusing by name until their pages add two methods (handover below). Logs under `/tmp/retest-fix-agent/` (the temporary folder may not survive a restart). `/tmp` was emptied by the restart, so the old gate script and the old-tree copy are gone; every heavy run below went through `lockf /tmp/retest-heavy-gate.lock`, waited on with one blocking call, and `pgrep -f benchmarks/run.ts` found no benchmark before each.

### Gates

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| Agent unit, before identity | `node --conditions=retest-source --test tests/unit/agent-*.test.ts` | 93 of 93 | `unit-agent-restart-1.log` |
| Agent suites on Chrome, before identity | `lockf … node --conditions=retest-source --test --test-concurrency=1 tests/integration/agent-{sessions,participants,capacity}.test.ts` | 17 pass, 1 named skip, 0 fail | `chrome-restart-1.log` |
| Agent suites on WebKit, before identity | `lockf … node … --test tests/integration/agent-webkit.test.ts` | 17 pass, 1 named skip, 0 fail | `webkit-restart-1.log` |
| Agent suites on Firefox, before identity | `lockf … node … --test tests/integration/agent-firefox.test.ts` | 16 pass, 1 fail, 1 named skip | `firefox-restart-1.log` |
| Firefox typing, driver only | `lockf … node --conditions=retest-source /tmp/retest-fix-agent/firefox-four-fills.ts 5` | 5 of 5 rounds: every fill `ok`/`sent`, one to three of four fields empty | `firefox-four-fills.log` |
| Whole unit suite, baseline | `npm run test:unit` | 3547 tests, 3529 pass, 18 fail, none in agent files | `unit-all-restart-1.log` |
| Type tests | `npm run test:types` | exit 1, only `src/evaluation/frames.ts:97` on both compilers | `types-restart-1.log` |
| Shared and agent unit, after identity | `node … --test tests/unit/browser-{element-identity,page-scripts,actionability,locate}.test.ts tests/unit/agent-*.test.ts` | 169 of 169 | `unit-mine-final.log` |
| Agent suites with identity on Chrome | `lockf … node … --test --test-concurrency=1 tests/integration/agent-{sessions,participants,capacity,identity}.test.ts` | 25 pass, 2 named skips, 0 fail; `agent-identity` 7 of 7 again after its last edit | `chrome-identity-1.log`, `chrome-identity-2.log` |
| Shared Chrome suites | `lockf … node … --test --test-concurrency=1` browser-locators, browser-actions, browser-secrets, browser-read-page, browser-playwright-rules, browser-navigation, m3-actions, m3-press, m3-observations, workflow-lists, workflow-selection | 180 of 181; the failure is outside the page code (below) | `chrome-shared-1.log` |
| Conformance on Chrome | `RETEST_CONFORMANCE_OPT_OUT=firefox,webkit lockf … node … --test tests/integration/conformance.test.ts` | 164 pass, 2 skipped as opted out, 0 fail | `chrome-conformance-1.log` |
| Agent suites with identity on WebKit | `lockf … node … --test tests/integration/agent-webkit.test.ts` | 18 pass, 9 named skips, 0 fail | `webkit-identity-1.log` |
| Agent suites with identity on Firefox | `lockf … node … --test tests/integration/agent-firefox.test.ts` | 17 pass, 1 fail (the same typing case), 9 named skips | `firefox-identity-1.log` |
| Breaks caught | the identity and agent-sessions suites on two copies of the tree under `/tmp/retest-identity-mutants/`, under the lock | no pin check: 5 cases fail; one token for every document: the earlier-document case fails at the refusal | `mutant-no-pin.log`, `mutant-fixed-token-2.log` |
| Typecheck | `lockf … npm run typecheck` | exit 2, five errors, all in `src/evaluation/frames.ts`, `fixtures/evaluation-corpus/runner/score.ts`, `tests/unit/evaluation-frames.test.ts`; none in mine | `typecheck-restart-1.log` |
| Scoped typecheck of every changed file, both compilers | `node_modules/typescript{,-7}/bin/tsc -p /tmp/retest-fix-agent/tsconfig.scoped.json` | errors only in `src/evaluation/frames.ts` and, TypeScript 7 only, `src/browser/firefox/accessible-names.ts:131` | `tsc-scoped-final.log`, `tsc7-scoped-final.log` |
| Whole unit suite, final tree | `npm run test:unit` | 3565 tests, 3547 pass, 18 fail: the same 18 in the same seven files as the baseline, none in my files | `unit-all-restart-2.log` |

In both whole-unit runs `tests/unit/diagnostics-engines.test.ts` (another lane's) hung at no CPU; I ended only my own run's child for that file (its ten failures are that), and left another session's orphaned run of it (pid 36744) alone.

### Findings and their state

- A-1 to A-10 and the `./agent` export: hold as fixed. The final real-browser runs the report owed are above; the Chrome race noted as unverified item 1 did not show.
- Found by the runs, Firefox driver: four sessions filling at once answer `ok`/`sent` while text does not reach every field. Reproduced with `launchFirefox` and four Firefox pages alone, no agent code: `/tmp/retest-fix-agent/firefox-four-fills.ts`, 5 of 5 rounds. Cause inside `src/browser/firefox` (typing through `input.performActions` per context); not fixed, not hidden; for the Firefox lane.
- Found by the runs, outside my files: `tests/unit/runner-resolve-hook.test.ts:89` (`exportedSpecifiers`) lists the package's subpaths and fails on the `./agent` export this lane added; the one-line change is adding `'@rehearsal-labs/retest/agent'` to its expected set (runner lane's file, not edited).
- Found by the runs, outside my files: `tests/integration/m3-observations.test.ts:138`, the forged `assertion.passed` scenario, is now refused as "a message Retest could not read: $.testId missing required key; $.attemptId missing required key", since the runner lane made those fields required; the scenario's forged message needs them. Not a page code effect.
- Agent change made by these runs: on a pinning driver, a reference whose list changed (not only re-sorted) is refused with the same "has changed (it saw 3 matches and the page now has 4)" words as on the refusing rule (`src/agent/session.ts`, `#target` and `#changed`), so the existing stale-reference assertion holds on Chrome unchanged.

### Element identity

Built, for Chromium, per `codex/fix-round/element-identity.md`:
- `src/browser/page-scripts.ts`: `keyedObserveFunction` (`observeKeyed(limit, queries, ...elements)`, the same `resolve` and, through a new shared `observationOf` helper, the same observation as `observe`; keys from a `WeakMap` on Retest's world, prefixed with a per-document random token); `prepareFunction` answers `{ status: 'moved' }` when `intent.element` is set and its one match is another node, before fitting, focusing, scrolling or arming.
- `src/browser/locate.ts`: `locatorsArguments(locators, values)`; `locatorArguments` now built from the same two helpers, its output unchanged (its unit tests pass as they were).
- `src/browser/element-queries.ts`: `observeKeyed`, the `moved` readiness, `dispatchPinned(command, key, dispatch)` (an `AsyncLocalStorage` pin read by `prepare`, so every readying look of one command, each select key included, checks the node; a command naming no element refused with `usage`).
- `src/browser/actionability.ts`: `moved` fails at once, `not_actionable`, `details: { refused: 'moved', inputSent: false }`.
- `src/browser/contract.ts`: `ElementIdentity`, `KeyedRead`, `KeyedReading` (additive); `src/agent/identity.ts` re-exports them.
- `src/browser/page.ts`: `ChromiumPage implements WebSession, ElementIdentity`; `readElements` and `dispatchTo` only, nothing else in the file changed.
- Agent: no logic change was needed to lift the refusals; `pinsElements` is true on Chrome. Integration cases now assert the engine's rule (`pinsOn` in `agent-harness.ts`, table `pinningEngines`); refusing cases skip by name on Chrome and pinning cases skip by name on Firefox and WebKit.

Per-driver handover (exact, also in the record under "What Firefox and WebKit need"):
- `src/browser/firefox/page.ts`, `FirefoxPage`: add `ElementIdentity` to `implements`; `readElements(locators: readonly LocatorRecipe[], timeoutMs: number, signal?: AbortSignal): Promise<KeyedReading>` built as `ChromiumPage.readElements` is, around `observeKeyed(this.#world, locators, deadline)`; `dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand>` returning `dispatchPinned(command, key, () => this.dispatch(command, timeoutMs, signal, commandToken))`. `FirefoxBridge.resolving(locator, work)` (`src/browser/firefox/bridge.ts:180`) needs a form taking `readonly LocatorRecipe[]` (each through `lookupRefusal`, their `roleWants` merged) so a keyed read's role steps all resolve. Confirm `crypto.getRandomValues` and `WeakMap` on the sandbox realm and a new realm per document.
- `src/browser/webkit/page.ts`, `WebKitPage`: the same two methods, with the lookup refusals its `observe` case applies, per locator. `listPlanFunction` (`src/browser/webkit/select.ts`) plans from the locator again; keys are pinned, but the plan should come from the pinned node.
- Then add the engine to `pinningEngines` in `tests/integration/agent-harness.ts`.

Test titles: `a reference acts only on the one element its look listed, …; one of several is refused by name and clicks nothing` kept, now skipped by name on Chrome since one of several acts there; new: `on a driver that pins, a reference to one of several elements, twins among them, acts on exactly that node`, `on a driver that pins, fields put in another order while an action waits for its field are refused as moved, and nothing is typed`, the six cases of `tests/integration/agent-identity.test.ts`, the thirteen of `tests/unit/browser-element-identity.test.ts`. No title vanished; no assertion was removed. The fields case and the recipe case now assert the refusal of the engine's rule (`changed` or `other-element` on Chrome, `unpinned` or `unproven` elsewhere).

### Other lanes' files

Edited, additively, outside `src/agent` because the element identity brief owns them and no running lane was editing them (all clean in git when I began): `src/browser/page-scripts.ts`, `src/browser/locate.ts`, `src/browser/element-queries.ts`, `src/browser/actionability.ts`, `src/browser/contract.ts`, `src/browser/page.ts` (two methods), `tests/unit/browser-page-scripts.test.ts` (one list entry). Not edited and needed: the runner-resolve-hook expected set, the m3-observations forged scenario, the Firefox typing defect, the two Firefox/WebKit pages.

### Not verified, most important first

1. Element identity on Firefox and WebKit: not built there (their lanes were editing); both refuse by name, asserted.
2. Firefox concurrent typing: fails in the driver; the Firefox row of that gate is not met.
3. The read that confirms a pinned `check` or `select` after its input finds the element by its locator, not its key; a re-sort between input and that read could read another node's state for the answer (input never goes elsewhere).
4. Shared suites and conformance on Firefox and WebKit after the shared page-script change: only the agent suites ran there (no failure from the change); their lanes' own runs cover the rest.
5. TypeScript 7 over the whole tree: the full typecheck stops at the first compiler's errors in the evaluation lane's files; the scoped run of my files is clean on 7.

### Files changed in this pass

`src/agent/identity.ts`, `src/agent/session.ts`; `src/browser/page-scripts.ts`, `src/browser/locate.ts`, `src/browser/element-queries.ts`, `src/browser/actionability.ts`, `src/browser/contract.ts`, `src/browser/page.ts`; `tests/unit/browser-element-identity.test.ts` (new), `tests/unit/browser-page-scripts.test.ts`; `tests/integration/agent-identity.test.ts` (new), `agent-harness.ts`, `agent-sessions.test.ts`, `agent-firefox.test.ts`, `agent-webkit.test.ts`; `docs/guide.md` (agent section), `docs/plans/public-beta/proofs/agent-sessions.md`, this report. No dependency, script or environment change.

## Follow-ups after the restart

Three items the coordinator handed back. Logs under `/tmp/retest-fix-agent/`.

### 1. The read that confirms a pinned check or select

Closed on Chrome. Before: after a pinned `check` the confirming read found the element by its locator, so a page that kept the clicked box unchecked and moved an already checked box into its place got "checked" as the answer. Now `readChecked` and `readSelection` (`src/browser/element-queries.ts`) pass the pin (`pinnedKey()`, new) through `locatorArguments(locator, values, pinned)` (`src/browser/locate.ts`, the key goes on the query as `element`); `checkedFunction` answers null and `selectionFunction` answers `lost` when the one element at the locator's place is another node (`src/browser/page-scripts.ts`, `pinnedReadHelper`). A check then fails `not_actionable` with `{ check: 'state', inputSent: true }` and the words "the locator no longer found the element it clicked" (`src/browser/checked-state.ts`); a select keeps only what the guard read of the pinned select itself as its change arrived, else fails the same way. Another element's state is never the answer.

- Test failing on the code before: `a pinned check whose element the page moves before Retest reads its state is not confirmed by the element now in its place` (`tests/integration/agent-identity.test.ts`). On a copy of the tree without the fix (`/tmp/retest-confirm-before/`) it failed with the check reported done (`confirm-before-chrome.log`); with the fix it passes. Two unit cases in `tests/unit/browser-element-identity.test.ts` (`read whether the pinned checkbox is checked, and never another's in its place`, `read the pinned select's options, and call another select in its place lost`) failed before the fix (`unit-confirm-before.log`) and pass after.
- Clash found on the way: the WebKit lane's `src/browser/webkit/select.ts` now splices the selection function's body after its own copy of the keys helper, so my first version, which put that helper in the selection function, declared it twice (`webkit-relay.test.ts` could not parse the list plan). The pin is now read straight from the keys' store under a name of its own, the keys helper is back to exactly what their slice expects, and `webkit-relay.test.ts` passes. Their file was not touched.
- Handover: the record's "What Firefox and WebKit need" now states the requirement (every confirming read inside `dispatchTo` reads the pinned node only; a node gone or a key that no longer matches leaves input sent and state unconfirmed) and names the case to carry over.

### 2. `tests/unit/runner-resolve-hook.test.ts:89`

The test's purpose is that the running copy's resolve hook names every public subpath of the exports map, so a test file loads this copy by any of them. Checked for `./agent` before editing: from `/tmp`, a folder with no `node_modules`, `resolveOwnPackage()` then `import('@rehearsal-labs/retest/agent')` loaded the running copy's agent entry (13 exports, `AgentHost` a function), as it did `/runner`, `/protocol` and `/playwright` (`/tmp/retest-fix-agent/resolve-agent.ts`). Edit: `${name}/agent` added to the expected set, one anchored line. The file: 5 of 5 (`unit-resolve-hook.log`).

### 3. `tests/integration/m3-observations.test.ts:138`

Why the runner requires them: a `command` message must name its test and attempt (`#isOwn`, `src/runner/running-test.ts:328`, since `fb8eb41`), so a process left from an attempt that is no longer running is refused as "a command for an inactive test attempt" and never acts on the current attempt's page. Why the scenario lost them: `fixtures/tests/forged-visible.retest.ts` copied the ids from the `run` message in its own listener, but the child program starts the body inside its listener for that same message, which runs first, so the body's first command went out before the ids were stored. Fix, in the fixture only: the body waits for the `run` message's ids, and every message it sends, the forged `assertion.passed` included, carries those real ids. The runner is unchanged and the case's assertions are unchanged: the forged pass is still caught by the parent's own look (`…which fails on o1, the look it named, where nothing matched.`). `m3-observations.test.ts` 3 of 3 on Chrome, under the lock (`m3-observations-after.log`); before, 0 of 1 for that case (`chrome-shared-1.log`).

### Gates

| Gate | Result | Log |
| --- | --- | --- |
| Touched unit files: `browser-{element-identity,page-scripts,check,select,locate,actionability,navigation-cause}`, `runner-resolve-hook`, `agent-*`, `webkit-relay` | 224 of 224 | `unit-followups-final.log` |
| Agent and identity suites on Chrome, under the lock | 26 pass, 2 named skips, 0 fail | `confirm-after-chrome.log` |
| Chrome suites that check and select through the shared code (`browser-actions`, `m3-actions`, `workflow-selection`, `workflow-lists`, `browser-locators`), under the lock | 110 of 110 | `confirm-shared-chrome.log` |
| `m3-observations` on Chrome, under the lock | 3 of 3 | `m3-observations-after.log` |
| Scoped typecheck of every changed file, the fixture included, TypeScript 6 and 7 | errors only in `src/evaluation/frames.ts` | `tsc-scoped-followups.log`, `tsc7-scoped-followups.log` |

### Not verified, most important first

1. The pinned confirming reads on Firefox and WebKit: neither engine pins yet in the runs I made; the shared code carries the pin, and the WebKit lane is adding its own engine.
2. Firefox's and WebKit's shared check and select suites after this change to `checkedFunction` and `selectionFunction`: not rerun by me; without a pin the functions behave as before, and those lanes are running their own suites.
3. A select whose confirming read sees another node in its place still accepts what the guard read of the pinned select as its change arrived, the rule unpinned selects already follow for a select that left the page; no real-browser case moves a select between its change and that read.

### Files changed in this round

`src/browser/page-scripts.ts`, `src/browser/locate.ts`, `src/browser/element-queries.ts`, `src/browser/checked-state.ts`; `tests/unit/browser-element-identity.test.ts`, `tests/unit/runner-resolve-hook.test.ts` (one line); `tests/integration/agent-identity.test.ts`; `fixtures/tests/forged-visible.retest.ts`; `docs/plans/public-beta/proofs/agent-sessions.md`; this report. `tests/integration/agent-harness.ts` not touched in this round. No dependency, script or environment change.
