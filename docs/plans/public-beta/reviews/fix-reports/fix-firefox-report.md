# Firefox fix report

The lane is not ready to declare all gates passing. Real diagnostics capture is refused before subscription because the pinned BiDi console serializer can invoke application getters. Its entries also lack the provenance needed for honest worker and error classification. Multiple-select keyboard changes are now refused before input because the native focused option cannot be verified. Existing success assertions remain in place and expose both gaps. All 140 current Firefox unit tests pass. The final heavy gate attempts exited 75 without acquiring the shared lock, so current browser-suite, compiler and idle-comparison results are unverified. No queued gate remains running.

## Findings and regression evidence

| Finding | Change | Regression and evidence |
| --- | --- | --- |
| F-1 | `src/browser/firefox/bridge.ts:112,183,291` uses an asynchronous lookup context for each recipe and its requested names. Names cannot be replaced by another observation. | Concurrent role/name unit case in `tests/unit/firefox-bridge.test.ts`; removing the per-lookup storage fails `/tmp/retest-firefox-negative/lookup-sharing.log`. The shared two/three-look test retains exact counts for hundreds of matches and staggered starts. The fresh browser gate could not acquire the shared lock. The earlier large loose-name case timed out; exact current real-browser counts are unverified. |
| F-2 | `src/browser/firefox/accessible-names.ts:118,126,131,189` confirms raw candidates against Retest normalization and refuses known role/name divergences from page facts. Password labels with hidden, nested or generated content are refused; an empty title falls through to a plain placeholder. | Removing normalization fails `/tmp/retest-firefox-negative/name-normalization.log`. Real Chrome/Firefox table in `tests/integration/firefox-roles.test.ts` previously had 213 silent differences; `/tmp/retest-firefox-roles-final.log` has zero, with 21593 equal answers and 2140 named refusals across 23733 lookups and 286 pages. |
| F-3 | `src/browser/firefox/navigation-hold.ts:149,154,170` answers only its own intercept. It holds top-context navigation, immediately continues other requests, and answers late requests after removal. | Removing frame release fails `/tmp/retest-firefox-negative/frame-release.log`. `tests/unit/firefox-navigation-hold.test.ts` covers frame fetch, frame navigation, page fetch, another intercept and a late request. `tests/integration/firefox-hold.test.ts:46` requires every frame request to arrive; it passed in `/tmp/retest-firefox-integrations-after.log`. |
| F-4 | The proof and guide now say the real spawn route has never been verified anywhere. `tests/unit/firefox-spawn.test.ts` launches a stand-in through actual launch/process code. `src/browser/firefox/process.ts:223` bounds an output stream held by an unverified helper. | The stand-in suite exercises normal close, ignored close, disconnected close, crash, inherited helpers, failed ownership/recording, incomplete server file, never listening, output redaction and cleanup. The output-bound removal fails `/tmp/retest-firefox-negative/output-bound.log`. The first attempted negative mutation had passed and is not counted as evidence; the corrected mutation failed. The complete current unit suite has 140 passed, zero failed and zero skipped in `/tmp/retest-firefox-resume-units-complete.log`. The stand-in waits for its own owner record before creating the deliberately untraced helper, so the fixture does not accidentally make that helper owned. No expected assertion changed. |
| F-5 | `src/browser/firefox/executable.ts:61,71,83` integrates missing/damaged/installed cache lookup. An implicit system binary must match both the pinned version and build. Explicit binaries remain usable with real identity recorded. | `tests/unit/firefox-executable.test.ts` covers exact pin, other release, absent release, explicit other release and damaged cache without fallback. Removed pin/damage checks fail `/tmp/retest-firefox-negative/system-version.log` and `damaged-cache.log`. Doctor warning is still needed outside this lane. |
| F-6 | `src/browser/firefox/process.ts:146,154,265,458,466` uses asynchronous snapshots, rare live polling and a wake on connection end. `profile.ts:78` and `orphans.ts:31` use asynchronous reads too. `process-table.ts:17,47,51,86` retains a live handle for the awaited reader and handles a table exceeding the metadata reply bound with smaller complete readings. Initial liveness is retained if a process exits during a later batch. Live watching and cleanup read kernel birth/liveness facts without fetching command arguments; those readings never grant signal authority. | `tests/unit/firefox-process.test.ts` checks asynchronous idle watching, immediate wake and a reused pid refusal. `tests/unit/firefox-process-table.test.ts` checks both readers under a size refusal and a disappearing row. Negative logs are `idle-poll.log`, `table-size.log`, `table-absence.log`. The standalone read initially exited before answering, then passed. A later host table exceeded the shared output bound; `/tmp/retest-firefox-resume-process-recheck.log` failed, and `/tmp/retest-firefox-resume-process-final.log` passes all five reader/ownership tests after batching. The full-table cleanup reading failed the existing held-output bound in `/tmp/retest-firefox-resume-late-helper-after.log`; the liveness reading passes both helper cases in `/tmp/retest-firefox-resume-late-helper-final.log`, and the full current unit suite passes all 140 cases. The real idle comparison could not acquire the shared lock. No current before/after event-loop measurements are available. |
| F-7 | `src/diagnostics/firefox-collector.ts:46,134` refuses real capture before subscribing. Synthetic read-only fixtures at `:238` label a non-null navigation as `Document`, retain child context and leave unavailable types absent. This is safe refusal, not diagnostics parity. | Removal of refusal fails `diagnostic-refusal.log` and `collector-safety.log`; removal of the navigation fact fails `navigation-type.log`. `tests/unit/firefox-collector.test.ts` has separate safety cases for getter mutation, CORS errors, promise kind, worker provenance, incomplete object text, unverified frame scope and unavailable resource type. `/tmp/retest-firefox-resume-collector-unit.log` has 14 passed. The real diagnostics gate exits 1 with zero passed, 13 failed and zero skipped. Every selected top-level case ran; the required record subassertions remain unmet because capture setup is refused. |
| F-8 | `src/browser/firefox/sandbox.ts:63,138` installs a preload relay that stops typing before a new document has a guard and transfers that stray event into the guard. `tests/integration/firefox-gate.ts` and the Firefox entry of `engines.ts:102` use the existing shared input gate. Shared suite splits preserve each assertion. | Removing the relay block fails `/tmp/retest-firefox-negative/new-document.log`. The real key-loss gate passed in `/tmp/retest-firefox-integrations-after.log`; replacement-document failure wording still differs and its field/request invariants are now independent subtests. The current shared invariants could not be exercised because the heavy gate did not acquire the lock. Their code is split to run independently; this is not a claim of a passing real result. No success assertion was rewritten to accept Firefox's different failure. |
| F-9 | Role confirmation, page setup, restored cookies, intercept arming and input activation use their command's remaining deadline. Files are `accessible-names.ts`, `page.ts`, `storage.ts` and `navigation-hold.ts`. | Removed name deadline fails `name-deadline.log`. `/tmp/retest-firefox-setup-budget-before.log` has both new setup/cookie cases failing; `setup-budget-after.log` has 11 passed. `/tmp/retest-firefox-hold-budget-before.log` fails arming; `hold-budget-after.log` has seven passed. Activation timeout and error cases in `tests/unit/firefox-page.test.ts:129` failed without the error mapping and pass with it; logs are `activation-error.log` and `resume-page-unit-after.log`. |
| F-10 | `src/browser/firefox/page.ts:601,627,841` arms the hold after readiness has armed the guard, immediately before input, and releases it when readiness retries. | `tests/integration/firefox-hold.test.ts:76` redirects while the original field is absent and requires the fill to target the opened document. It passed in `/tmp/retest-firefox-integrations-after.log`. The fresh run could not acquire the shared lock. The independent unit case requiring no intercept before target readiness fails with the hold moved ahead of readiness, `/tmp/retest-firefox-negative/hold-before-readiness.log`, and passes in the ten-case `/tmp/retest-firefox-resume-page-unit-final.log`. The first mutation attempt had passed because its fixture used the wrong command property; that attempt is not counted. The fixture now supplies `allowedOrigins`. |

Negative source copies live under `/tmp/retest-firefox-negative`; their imports point to the real dependency files. The repository fixes were never reverted for these checks. Every listed negative test exits 1. The logs identify the assertion it failed. The source copy is a regression check, not a claim that the entire earlier driver was reconstructed.

## Role and name resolutions

| Reviewed difference | Resolution |
| --- | --- |
| `Save now` with a no-break space in the raw name | Raw names are confirmed, then Retest normalization matches the requested exact name. |
| Password label with an aria-hidden asterisk, including the incorrect `Password *` match | Refuse the affected password name source. Neither the smaller nor the larger set is returned. |
| Password label with hidden content | Refuse the affected password name source. |
| Password with empty title and a plain `PIN` placeholder | Read the placeholder after an empty title. The table agrees with Chrome. |
| `caption`, `generic`, `rowgroup`, `gridcell`, `none` and `presentation` | Refuse these role lookups by name. |
| Native submit/reset/color/file/image inputs as buttons | Refuse the affected button lookup from the actual visible markup. |
| Named figure/figcaption and named cell | Refuse those named role lookups. |
| Failed image by alternative text and implicit SVG image role | Refuse the affected image lookup by name. |
| Native date/time/month/week/datalist roles and contenteditable role differences | Refuse the affected role from its actual markup. |
| Native table/row/cell/header semantics, orphan rows/headers, native options, lone tabs/menu items | Refuse the affected lookup from its actual markup and required role parent. |
| Editable heading names, native media-control group, hidden labels and generated/nested password labels | Refuse the affected role or name source. |

The completed table names each refusal count: caption 286, generic 286, gridcell 289, img 27, none 286, presentation 286, rowgroup 286, combobox 33, searchbox 29, slider 29, spinbutton 30, textbox 92, button 55, heading 11, option 22, tab 1, cell 15, columnheader 16, row 17, rowheader 14, table 15, group 1, menuitem 1, menuitemcheckbox 1, menuitemradio 1 and figure 11. These counts describe unsupported lookups, not equality.

The expanded table includes the reviewer's role/name and element-kind probes plus normalization, loose/pattern matching and markup combinations. Refusals are asserted as named `unsupported` failures. The required outcome is equality or a named refusal, never a silent difference. Earlier table counts were 22102 equal, 1418 refused and 213 different. Completed corrected counts are 21593 equal, 2140 refused and zero different. The table rerun could not acquire the lock. The completed counts above remain evidence of the earlier corrected role/name source, not a fresh whole-suite result.

## Native input and window creation

`src/browser/firefox/input-order.ts` keeps activation, readiness and dispatch together across windows; observations stay independent. `page.ts:820` activates a window before readiness and maps activation failure without sending input. The earlier four-window test returned success while most fields were empty. Its assertions remain unchanged. The activation-error source mutation fails both new page-unit cases. The current page unit file has ten passed, including the independent hold-readiness regression. Current real four-window behavior remains unverified because the rerun did not acquire the lock.

`input.ts:173` and `page.ts:760` refuse a plan with native list movement/toggles before any input. `tests/unit/firefox-input.test.ts` proves the refusal and retains single-select typing. Removing it fails `/tmp/retest-firefox-negative/selection-refusal.log`. The real safety case in `tests/integration/firefox-input-behavior.test.ts` requires `unsupported`, input not sent, no keyboard events and unchanged selection. The existing repeated success case remains unchanged and will fail by this refusal. The exact Firefox cause of a missed native move is still unknown; Retest has no fact with which to verify focus before a Space toggle.

`page.ts:702` splits a requested wheel delta into separately guarded turns and preserves uncertainty after partial delivery. The old fixture scrolled to 90 for a requested 900. The corrected fixture reaches the end and hears fifteen trusted events of 60, summing to 900. Logs are `/tmp/retest-firefox-input-before.log` and `/tmp/retest-firefox-input-after.log`. This changes the page's event sequence, which is stated in the guide. The shared terms assertion is retained.

`browser.ts:210` asks for a window once, names protocol rejection or unanswered creation as setup failure, and removes the user context through the caller's cleanup. `tests/unit/firefox-browser.test.ts:25,44` verifies one create request and one context removal. No attempt retries into a second window. The original rare real `unknown error` was not reproduced; its protocol failure path is exercised with a scripted endpoint.

## Collector output and unmet diagnostics checks

The real page never supplies the synthetic collector's `consoleSerialization: 'read-only'` fixture option. Real capture therefore emits no guessed page/worker, CORS/runtime or promise-kind records. It rejects before subscription, with a named unsupported reason, so enabling capture cannot make the pinned Firefox serializer run a getter.

The pinned installed source under `/tmp/retest-firefox-lane/omni/chrome/remote/content/webdriver-bidi/modules/windowglobal/log.sys.mjs` serializes logged arguments with property reads before sending the event and assigns its default page realm as source. JavaScript entries do not carry the reliable category or promise-kind fact needed here. Retest reading `entry.text` alone cannot prevent the engine's prior serialization. A read-only source with true provenance is required for parity.

This does not fix runtime error classification, worker identity, full object argument text, actual scope agreement, pending count or captured-object redaction. Their safety tests verify refusal, not fabricated output. The synthetic parser's old classifications/scope are not production compatibility evidence. Main/child navigation type uses the protocol's navigation field; no fetch resource type is inferred from a URL. The real stricter diagnostics file was untouched and ran under the lock. Capture setup refusal prevents its fixture subassertions from reaching the promised record parity; that gate is unmet.

## Shared test titles and preserved assertions

The inherited shared splits were reused. Focus-moved fills now run both values and check field values before the differing event-detail assertion. Character values and modifier facts are independent. Each editing-key case and image/math/heading lookup has its own subtest. Navigation error message/details, empty/long/control titles and reload/back/forward without content run separately. Secret origin refusal, cancelled-navigation notification and each field/navigation/request invariant run independently.

The old combined title test now has separate control, empty and long-title cases so an earlier control-character mismatch cannot hide the later assertions. Its control-title return and navigation-event assertions are also independent subtests. The old combined no-content history title became separate reload, back and forward cases, retaining history and timing assertions. No expected outcome was changed. The replacement-document case keeps its original title and expected failure; the replacement field and both origins' request counts now have separate subtests so a failure-wording mismatch cannot hide them. The key-loss case keeps its original title and exactly-one-down invariant; its instrument uses the existing cross-engine gate.

## Earlier failing case inventory

These are the 32 failures in the earlier completed integration gate. They describe that source state; they are not current gate results. Each title remains in the tests, or its component assertions are preserved in the independent splits described above. The current gate did not acquire the lock, so which failures remain is unverified. The inherited shared title that says "real Chrome" ran through the Firefox harness.

- fill with an empty value clears the field.
- Release checklist.
- fill stops the typing when the focus moves after Retest focused the field, and names where it went.
- a character is typed with the key a person presses for it, and Shift for an uppercase letter or a shifted symbol.
- Backspace.
- ArrowLeft then Backspace.
- ArrowLeft then ArrowLeft then Delete.
- ArrowLeft then ArrowLeft then ArrowRight then X.
- Shift+ArrowLeft then X.
- Home then X.
- Home then End then X.
- Shift+Home then X.
- each editing key edits a field once.
- the wheel turned on the terms scrolls them to their end, which enables Accept.
- a scroll delta is in CSS pixels, also on a phone page zoomed out to fit, where the wheel still scrolls.
- img Logo.
- img Badge.
- role without a name finds every element with it, and a role Chrome names its own way is found by its WAI-ARIA name.
- two or three looks at once, started together or a few milliseconds apart, each count every one of hundreds of matches.
- an address nobody answers fails with the browser navigation error.
- an address nobody answers names the address without its query and the browser's error in its details.
- a title reaches the parent as the page has it, a C1 control character and all.
- a page that sets off for another origin as the field takes focus is kept where it is, and the secret is never typed.
- a fill bound to its origin still lets the page move within the document, and leave once the text has arrived.
- a document that arrives while the text is on its way never receives it, and the fill names that document.
- several pages of one Firefox each take the text filled into them, and each field holds its own.
- the collector hears the page's console, its uncaught error, its requests and a failed one, says what it covers, and tells the loss of its page once.
- the sweep ends a Firefox whose launcher was killed outright, with its folder, and leaves a live launch alone.
- scoped locators, picks, CSS, placeholders, patterns, state and page matchers, history, hover and shortcuts, against real Chrome.
- a setup signs in once per target, its dependents start signed in, a failed one keeps them from running, and no state is left.
- a test file run on its own brings in the setup it needs from another file.
- a test that starts from a state no setup saves fails collection, naming the state.

Capture remains refused. Native multiple-select changes remain refused, with the repeated-success test retained. Home/End, modifier event details, Firefox error names and title control characters remain named engine differences. The new activation and cleanup changes address the historical multi-window and sweep failures, but their current real behavior is unverified because the rerun did not acquire the lock. The wheel fixture has separate completed regression evidence. The large concurrent loose-name case previously timed out; its exact current counts remain unverified, and its deadline was not increased. The state and collection failures need the current runner gate result before assigning a cause. No outcome was inferred from a test that did not reach its assertion.

## Changes needed outside this lane

At `src/cli/doctor/checks.ts:11,155`, import `untestedFirefox` with the release reader. For an explicitly named executable, append its returned warning after `readFirefoxRelease`, including the unknown-release warning. Keep the binary usable, keep its real release/build and route information, and say it differs from the tested build. The Firefox executable helper already implements that message. This file belongs to the installed-build lane and was not edited here.

The initial compiler errors outside this lane were `fixtures/evaluation-corpus/runner/score.ts:93` and `:117`, `src/evaluation/frames.ts:90` and `:97`, and `tests/unit/evaluation-frames.test.ts:334`. The type fixture also failed on `src/evaluation/frames.ts:97`. Those files were left untouched. The final checks could not acquire the lock, so whether their owners have since resolved the errors is unverified.

The installed-build API at `src/browser/builds.ts:624` is now integrated. No further cache signature change is pending. The protocol and runner now name Firefox screenshot source and browser engine/build; this lane needs no further source-name change. It has no live frame source, and no AI judge was exercised on a Firefox screenshot. No other platform or build was verified.

## Gates

Before every test launch, `pgrep -f '[b]enchmarks/run.ts'` checked for a benchmark. All real browsers and whole-tree typechecks used `lockf -t 540 /tmp/retest-heavy-gate.lock`. Gate output went to files. No benchmark, dependency installation or download ran.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/firefox-*.test.ts` on recovered disk | 126 passed, zero failed/skipped | `/tmp/retest-firefox-resume-units.log` |
| Same unit command after activation error mapping | 128 passed, zero failed/skipped | `/tmp/retest-firefox-resume-units-after.log` |
| Same unit command after added refusal cases | 119 passed, 18 failed, zero skipped; host metadata table exceeded its output limit | `/tmp/retest-firefox-resume-units-final.log` |
| `node --conditions=retest-source --test tests/unit/firefox-process-table.test.ts tests/unit/firefox-process.test.ts` after bounded complete reads | Five passed, zero failed/skipped | `/tmp/retest-firefox-resume-process-final.log` |
| `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-*.test.ts` on current source | Exit 0, 140 passed, zero failed/cancelled/skipped | `/tmp/retest-firefox-resume-units-complete.log` |
| `lockf -t 540 /tmp/retest-heavy-gate.lock npm run typecheck` | Initial exit 2, no Firefox path errors; shared evaluation files failed | `/tmp/retest-firefox-resume-typecheck-initial.log` |
| `npm run test:types` | Initial exit 1, unexpected compiler error in evaluation frames | `/tmp/retest-firefox-resume-types-initial.log` |
| `lockf -t 540 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-*.test.ts` | Exit 75, lock not acquired; no current tests ran | `/tmp/retest-firefox-resume-integrations.log` |
| `lockf -t 540 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='^Firefox:' tests/integration/diagnostics-engines.test.ts` | Exit 1, zero passed, 13 failed, zero skipped. Every selected top-level case ran. Required record subassertions remain unmet. | `/tmp/retest-firefox-resume-diagnostics.log` |
| `lockf -t 540 /tmp/retest-heavy-gate.lock python3 /tmp/retest-firefox-resume-gates.py` | Both final attempts exited 75, lock not acquired. None of its commands ran. | `/tmp/retest-firefox-resume-gates-lock.log`, `/tmp/retest-firefox-resume-gates.log` |

The blocked script would run `npm run typecheck` and `npm run test:types`, then every `tests/integration/firefox-*.test.ts` file with `RETEST_FIREFOX_ROUTE=launch-services` and `--test-concurrency=1`, then `node --conditions=retest-source --test --test-name-pattern='two or three looks' tests/integration/browser-locators.test.ts`, then `env RETEST_FIREFOX_ROUTE=launch-services RETEST_CONFORMANCE_KEEP=/tmp/retest-firefox-resume-conformance-runs node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='Chrome|Firefox' tests/integration/conformance.test.ts`, then `node --conditions=retest-source /tmp/retest-firefox-idle/run.ts`. No per-command logs or result JSON were created by these attempts. The all-Firefox integration command also includes the Chrome/Firefox role table. The Chrome looks command covers Chrome; the Firefox wrapper includes the same unchanged concurrent-looks case.

Earlier completed integration counts were 129 passed, 32 failed, zero skipped in `/tmp/retest-firefox-integrations-after.log`. Earlier strict conformance was 310 passed, 18 failed, zero skipped including run wrappers in `/tmp/retest-firefox-conformance-final.log`. Those are earlier source states, not the fresh gate result. The original builder's broad conformance count does not establish success under the now stricter cases.

## What remains unverified

1. Required real diagnostic parity and all fixture record invariants are unmet. The source is refused before it can mutate the page or guess record kinds.
2. Native multiple-select changes are unsupported. The refusal helper is unit-verified. The new real no-input safety case did not run, so its dispatch, event and unchanged-selection assertions remain unverified on the browser. The old success case is retained and will receive a named unsupported result for a native movement/toggle plan. The exact engine cause of missed movement is unresolved.
3. Current browser integration, four-window input, Chrome/Firefox concurrent looks, stricter conformance and the real idle comparison are unverified. Repeated heavy-lock attempts exited 75. The held lock belonged to another worker and was left alone. The idle probe has no measured result; the reviewer's earlier delay observation is not a current before/after comparison.
4. Whole-tree typecheck and type fixtures initially failed in the evaluation files listed above, with no Firefox-path compiler errors in that run. The final compiler rerun did not acquire the lock, so the latest source is not compiler-verified. Those files were left untouched.
5. The real spawn route, another Firefox build/platform, a live frame source and AI checks over Firefox captures were not verified.
6. The no-request stop-loading fallback of an origin-bound fill still lacks real coverage.

## Fixture diagnostic exposure

An initial cleanup-fixture assertion compared a process mock object. Its failure formatter printed the process object, including environment data, to a temporary failure log and session tool output. This was a test assertion mistake. The assertion now checks only the numeric signal count; the passing and negative cases were rerun. The affected temporary failure logs were regenerated with the numeric assertion output. Their current paths are `/tmp/retest-firefox-resume-fixture-ownership.log` and `/tmp/retest-firefox-negative/fixture-ownership.log`. The report repeats no environment values. Output already returned by the session tool cannot be removed, and whether it contained credential values remains unverified.

## Changed file inventory

The Firefox files were already untracked on recovery, so git cannot distinguish this continuation from the interrupted edits. This inventory covers fix-bearing files across the continued lane, not unrelated changes in the shared tree.

- `src/browser/firefox/accessible-names.ts`, `bridge.ts`, `browser.ts`, `executable.ts`, `input.ts`, `input-order.ts`, `navigation-hold.ts`, `orphans.ts`, `page.ts`, `process.ts`, `process-table.ts`, `profile.ts`, `sandbox.ts`, `storage.ts`.
- `src/diagnostics/firefox-collector.ts`.
- `tests/unit/firefox-bridge.test.ts`, `firefox-browser.test.ts`, `firefox-collector.test.ts`, `firefox-executable.test.ts`, `firefox-gate.test.ts`, `firefox-input.test.ts`, `firefox-input-order.test.ts`, `firefox-navigation-hold.test.ts`, `firefox-orphans.test.ts`, `firefox-page.test.ts`, `firefox-process.test.ts`, `firefox-process-table.test.ts`, `firefox-sandbox.test.ts`, `firefox-spawn.test.ts`, `firefox-stand-in.ts`, `firefox-storage.test.ts`, `firefox-table-worker.ts`, `firefox-reused-table-worker.ts`.
- Firefox shared-suite wrappers `tests/integration/firefox-browser-actions.test.ts`, `firefox-browser-locators.test.ts`, `firefox-browser-navigation.test.ts`, `firefox-browser-secrets.test.ts`; `firefox-driver.test.ts`, `firefox-gate.ts`, `firefox-hold.test.ts`, `firefox-input-behavior.test.ts`, `firefox-roles.test.ts`; Firefox entries in `tests/integration/engines.ts`; anchored assertion splits in `browser-actions.test.ts`, `browser-locators.test.ts`, `browser-navigation.test.ts`, `browser-secrets.test.ts`.
- `docs/plans/public-beta/proofs/firefox-driver.md`, Firefox section of `docs/guide.md`.

No commit, stash, reset, checkout, discard, publication or ownership change occurred. No forbidden repository file was edited by this lane. No process belonging to another worker was ended. Read-only cleanup audits found no live Firefox matching Retest owner records and no running member in a retained recorded launch group. Firefox launches in tests are closed by their registered cleanup, with ownership checks retained before signals; the lock-blocked attempts started no browsers. The read-only final audit found no live root or group member in the retained Retest launch records.

Additional completed regression gates: `node --conditions=retest-source --test --test-name-pattern='a helper the launch never traced|a helper the launch left alone' tests/unit/firefox-spawn.test.ts` has two passed in `/tmp/retest-firefox-resume-late-helper-final.log`. The fixture cleanup identity case has one passed in `/tmp/retest-firefox-resume-fixture-ownership.log`; its isolated mutation fails in `/tmp/retest-firefox-negative/fixture-ownership.log` with a mocked signal count of one instead of zero. No actual signal was sent by that mutation. `node --conditions=retest-source --test tests/unit/firefox-process-table.test.ts` has two passed in `/tmp/retest-firefox-resume-table-unit.log`. `node --conditions=retest-source --test tests/unit/firefox-page.test.ts` has ten passed, zero failed/skipped in `/tmp/retest-firefox-resume-page-unit-final.log`. `python3 /tmp/retest-firefox-hold-placement-negative.py` exits zero only because the restored-early-hold regression exits 1 as required; `/tmp/retest-firefox-hold-placement-negative.log` records it.

## After the restart

Every gate listed above as not run was run on real Firefox 133.0.3 build 20241209150345 (Launch Services route; this host still cannot read `~/Library/Application Support/Firefox`, EPERM). The first runs found two false passes and two regressions in the earlier fixes. All four are fixed, each with a test that fails on the old code. Element identity was added to the Firefox page. Logs are under `/tmp/retest-fix-firefox/`: `round1/` is the code as found, `round4/` and `round6/` the final code.

### Findings and their state

| Id | Severity | Finding | State and evidence |
| --- | --- | --- | --- |
| A-1 | high | A fill answered `ok`, input `sent`, while the field stayed empty. A press of Enter answered `ok` and the form never submitted. Firefox 133 runs the preload script twice in the first document a new window opens, in two sandboxes with the same name, and sends every call to one of them. The other sandbox's relay never got a guard, so it stopped every key as unguarded typing (`preventDefault`, `stopImmediatePropagation`) after the live guard had already counted the key as reached. The page heard nothing. This was the four-window failure, the agent worker's four-fill case and the Enter, select and fill failures on a test's first page. | Fixed in `src/browser/firefox/sandbox.ts` (`relayScript`, `wrapped`) and `page.ts` (`documentScript`). The sandbox that calls reach claims its document with an event whose random type is written into the script, and any other relay stops blocking when it hears it. Relays are added once per document a sandbox runs in, and a guard left from an earlier document is dropped. Two new tests in `tests/unit/firefox-sandbox.test.ts` fail on the old relay (`negative/two-sandboxes.log`). On the real browser, four windows filled at once in their first document: before, 0 or 1 of 4 fields held text in every run (`probes/probe-many-1.log` to `-5.log`); after, 4 of 4 in 3 of 3 runs (`probes/probe-many-after.log`). The agent worker's `/tmp/retest-fix-agent/firefox-four-fills.ts`: 5 of 5 bad rounds before, 0 of 5 after (`probes/agent-four-fills-after.log`). |
| A-2 | high | The F-10 change armed the hold only after readiness. A navigation started by the field's focus then went through unheld. The shared case "a page that sets off for another origin as the field takes focus" threw an internal `CdpProtocolError` ("Cannot find context") out of `execute`, and the page left. | Fixed in `page.ts` (`#fill`, `#actSeeingInOrder`) and `navigation-hold.ts` (`letGo`). The hold is armed before the first look. Each look starts by letting go what was held before it, as the page's own, and waits for that document. A navigation that starts during the look that readies the field, or after it, is held and refused. A readied document that goes before any key is sent fails by name with `inputSent: false`. New unit test in `tests/unit/firefox-page.test.ts`; a copy without `letGo` fails it (`negative/hold-let-go.log`). It replaces "an origin-bound fill cannot arm a navigation hold before its target readiness has been established", which asserted the placement that caused this. Real: refusal, empty field, page kept and no typing all pass (`round4/firefox-browser-secrets.log`), and the F-10 redirect case still passes (`round4/firefox-hold.log`). |
| A-3 | medium | The wheel split made the page hear dozens of wheel events for one requested scroll. The shared case whose page loads more near its end loaded four times instead of once, and failed. | Reverted to one wheel event carrying the whole delta (`page.ts` `#scroll`). The shared viewport case passes. Reaching the end of the terms with one large delta goes back to being a named difference. In `tests/integration/firefox-input-behavior.test.ts`, "several Firefox wheel turns carry one whole requested delta…" asserted the split; it is replaced by "one Firefox scroll is one trusted wheel event carrying the whole requested delta, as on Chrome", which passes. Guide updated. |
| A-4 | medium | Conformance F3.1b failed on every run with `browsingContext.create failed: unknown error`. Firefox's own message, now kept, is `TypeError: tabBrowser is undefined`. Firefox puts a new tab in its most recent window of any kind, which can be a page window still being built. | New `src/browser/firefox/window-order.ts`. One browser opens and closes its windows and tabs one at a time (`browser.ts` `openWindow` and the cleanup removal, `storage.ts` tab create and close, `page.ts` dispose). Two tests in `tests/unit/firefox-window-order.test.ts` fail on the old `openWindow` (`negative/window-order.log`). Real: eight pages opened at once, four with a saved state, failed 3 of 4 in 3 of 3 launches before and 0 in 3 of 3 after (`probes/probe-restore-many-before.log`, `-after.log`). F3.1b, F3.2 and R16 now pass. |
| A-5 | low | A timed-out look was told a moment before its budget. Conformance L7 and F10.5 failed with "gave up after 1498 ms, before its 1500 ms". | `page.ts` waits out the budget after a timeout in `#execute` and `readElements`, as Chromium's page does. New unit test: on a copy without the wait it fails in 2 of 3 runs (`negative/outlast.log`); with the wait it passes 5 of 5. |
| A-6 | low | TypeScript 7 rejected `markupRefusalFunction` without an explicit type (`accessible-names.ts:131`, TS9010). | Fixed. |
| A-7 | medium | `input-order.ts` holds the browser's input turn through the whole actionability wait. A page waiting for its element blocks input on every other page of the same browser up to its deadline. Those pages can then time out through Retest's fault. The turn was added to fix the four-window failure, whose real cause was A-1. | Open. It may now be narrowed or removed; that needs its own measured run. |
| A-8 | low | The Launch Services exit watch (`process.ts` `#pollMainExit` through `readProcessLivenessAsync`) matches the pid without its start time, so a reused pid would read as Firefox still running. Signals still check identity. | Open. |
| A-9 | low | The collector's test-only option `consoleSerialization: 'read-only'` lives in production code (`firefox-collector.ts:22`). | Open. |
| A-10 | low | One failed image anywhere on a page refuses every `img` lookup (`accessible-names.ts` markup check), including images that loaded. The shared "img Logo" case fails on that. | Open. The refusal is honest, but broader than needed. |

I found no loosened assertion in the earlier fixes' tests. The assertions I changed: the page unit test's preload arguments (still the exact two channels, plus an exact pattern for the claim type in the script); the bridge test fixture shape (`locators: [locator]`); the two replaced tests named above.

### Element identity (coordinator addition)

`FirefoxPage` implements `ElementIdentity`. `readElements` runs the shared `observeKeyed` inside `FirefoxBridge.resolvingAll`, which refuses each locator by `lookupRefusal` and merges their `roleWantsOf`. `dispatchTo` is `dispatchPinned` around `dispatch`. `Lookup` now carries `locators`, and a markup refusal names the locator that asked for the role. `crypto.getRandomValues` and `WeakMap` work in the sandbox, shown by the keyed reads passing. Keys stay unique if a sandbox outlives its document, since their count only grows. `pinningEngines` in `tests/integration/agent-harness.ts:37` now names Firefox. `tests/integration/agent-firefox.test.ts`: 26 passed, 0 failed, 2 skipped by name (the live frame source, and the refusal-rule case the harness skips on a pinning engine). The identity suite's 7 cases all pass, and so does the concurrent four-session typing case (`round4/agent-firefox.log`, `round5/agent-firefox.log`).

### Gates on the final code

`pgrep -f '[b]enchmarks/run.ts'` before each run; none ran. Each heavy command ran as `lockf -t 540 /tmp/retest-heavy-gate.lock <command>` through `/tmp/retest-fix-firefox/gates.sh`. Integration commands ran as `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 <file>`.

| Gate | Found (round1) | Final | Log |
| --- | --- | --- | --- |
| `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-*.test.ts` (no lock) | 140 of 140 | 145 of 145 | `units-start.log`, `units-final.log` |
| `npm run typecheck` | exit 2, 5 errors, none in Firefox paths | exit 2, 6 errors, none in Firefox paths | `round4/typecheck.log` |
| `node_modules/typescript-7/bin/tsc -p tsconfig.json` | not run (the script stops at TypeScript 6) | exit 1, 6 errors, none in Firefox paths (one Firefox error found in round 2 and fixed) | `round4/typecheck7.log` |
| `npm run test:types` (no lock) | exit 1, `src/evaluation/frames.ts:97` | same | `test-types-final.log` |
| `tests/integration/firefox-driver.test.ts` | 6 of 8 | 7 of 8 (the collector case, refused capture) | `round4/` |
| `firefox-hold.test.ts` | 2 of 2 | 2 of 2 | `round4/` |
| `firefox-input-behavior.test.ts` | 2 of 3 | 2 of 3 (the multiple-select success case, refused) | `round4/` |
| `firefox-browser-actions.test.ts` | 69 of 80 | 71 of 80 | `round4/` |
| `firefox-browser-locators.test.ts` | 23 of 26 | 23 of 26 (failed image refused) | `round4/` |
| `firefox-browser-navigation.test.ts` | 28 of 33 | 28 of 33 (error names, ESC in titles) | `round4/` |
| `firefox-browser-secrets.test.ts` | 14 of 18 | 19 of 24 (the split runs more subtests; failures: no Navigation API in the page, a request lost as the page leaves) | `round4/` |
| `firefox-lookup`, `firefox-m2-state` | 1 of 1, 3 of 3 | 1 of 1, 3 of 3 | `round4/` |
| `firefox-roles.test.ts` (Chrome and Firefox) | 23733 lookups, 21593 alike, 2140 refused, 0 different | same | `round4/firefox-roles.log` |
| `--test-name-pattern='^Firefox:' tests/integration/diagnostics-engines.test.ts` | 1 of 13 | 1 of 13 (capture refused) | `round4/diagnostics.log` |
| `RETEST_CONFORMANCE_KEEP=… --test-name-pattern='Firefox' tests/integration/conformance.test.ts` | 148 of 164 | 160 of 164 (A5 multiple select, A7 wheel, F8.1a native table, the umbrella case) | `round6/conformance.log` |
| same with `'Chrome'` | not run | 162 of 164 (S11, an early timeout in Chrome's page) | `round3/conformance-chrome.log` |
| `--test-name-pattern='two or three looks' tests/integration/browser-locators.test.ts` (Chrome) | 1 of 1 | 1 of 1 | `round3/looks-chrome.log` |
| `tests/integration/agent-firefox.test.ts` | not run | 26 passed, 2 skipped | `round4/agent-firefox.log` |

Load note: round 5 ran at a load average near 26, from another worker's parallel unit run, which needs no lock. Conformance then gave 144 of 164, with action timeouts at the 1500 ms budgets. Rerun on a quieter machine it gave 160 of 164 (`round6/`). The shared actions suite gave 70 of 80 in rounds 5 and 6, both under load: a label lookup timed out and the select failed by name. It gave 71 in round 4.

### The two refusals

Console capture: the refusal stands, and it is honest, tested and named. Proven on the real browser with no Retest code reading the page. A bare `session.subscribe` to `log.entryAdded` made a logged object's getter change the page's title in 2 of 2 tries. With no subscription, or with only `network.beforeRequestSent`, the title was untouched (`probes/probe-console.log`). The pinned source `chrome/remote/content/webdriver-bidi/modules/windowglobal/log.sys.mjs` (from the app's `omni.ja`) serializes every argument with Xrays waived and default options before it sends an entry. The subscriber has no option to change that. Runtime errors share the same subscription. No `log.entryAdded` route avoids running page code. One fault remains: the refusal also withholds network capture, which runs no page code. Offering network alone needs the collector and the diagnostics scope to report console as unavailable beside a complete network capture. That is for the diagnostics lane and the orchestrator to decide; it was not built here.

Keyboard multiple select: the refusal stands, and it is honest, tested on the real browser (unsupported, input not sent, no key events, selection unchanged) and named in the message. The toggle plan presses Space on whichever option holds the listbox's native focus. Neither the DOM nor BiDi exposes that focus before the Space, so a missed move would select an option nobody asked for, and the page would hear its `input` and `change` before any read could catch it. Holding the modifier with real key events does not change what can be checked. The earlier "miss once in thirty" is not explained by A-1, which blocks every key in a document rather than one move. A correct route would be a modifier-click on each option's own box, guarded by the hit test. That needs a new readiness and guard intent for options, beyond the bounded effort, so it was not built.

### In other lanes' files (not edited)

- `tests/unit/diagnostics-engines.test.ts` (diagnostics lane): 7 Firefox collector contract cases fail, because capture is refused before subscribing. The file's process also stays alive after its cases finish; a process of the same file started before any of these edits was still running. Reproduce: `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts`.
- `src/browser/page.ts`: Chrome tells a timeout early. Conformance S11 on Chrome: "It gave up after 299 ms, before its 300 ms had passed" (`round3/conformance-chrome.log`).
- Compiler errors on both compilers: `fixtures/evaluation-corpus/runner/score.ts:93`, `:117`; `src/evaluation/frames.ts:90`, `:97`; `tests/unit/evaluation-frames.test.ts:334`; `tests/unit/media-protocol.test.ts:46`.
- `src/cli/doctor/checks.ts`: the `untestedFirefox` warning is still owed, as written above.
- `tests/integration/agent-harness.ts:36`: the comment above `pinningEngines` still says "Chromium's"; only line 37 was mine to change.
- `docs/plans/public-beta/proofs/agent-sessions.md` lines 101 and 131 still describe the Firefox typing defect and missing identity as open.

### What I could not verify, most important first

1. The real spawn route: this host gets EPERM on Firefox's data folder, so every run used Launch Services.
2. The F-6 event-loop comparison with one idle Firefox: not measured, because other workers kept the machine loaded and a number would mean nothing.
3. Why a multiple-select move missed in the earlier builder's probes.
4. Diagnostics parity on Firefox: capture is refused.
5. Whether `input-order.ts` (A-7) is still needed after A-1.
6. Any Firefox build or platform other than 133.0.3 on macOS arm64.

### Files changed in this pass

`src/browser/firefox/sandbox.ts`, `page.ts`, `navigation-hold.ts`, `bridge.ts`, `accessible-names.ts`, `browser.ts`, `storage.ts`; new `src/browser/firefox/window-order.ts`; `tests/unit/firefox-sandbox.test.ts`, `firefox-page.test.ts`, `firefox-bridge.test.ts`; new `tests/unit/firefox-window-order.test.ts`; `tests/integration/firefox-input-behavior.test.ts`; `tests/integration/agent-harness.ts` line 37; `docs/plans/public-beta/proofs/firefox-driver.md`; `docs/guide.md` (the Firefox section, plus three sentences of the agent section that described Firefox wrongly); this report. No dependency, script or environment change. No Firefox process or profile folder is left.

## Second pass

Logs are under `/tmp/retest-fix-firefox/`. `pass2-a/` and `pass2-b/` are the real-browser gate rounds; `pass2-b/` is the final code. Gates ran through `lockf -t 540 /tmp/retest-heavy-gate.lock`, with no benchmark running.

### 1. Network capture on Firefox, alone

- `src/diagnostics/firefox-collector.ts` now subscribes to `network.beforeRequestSent`, `responseStarted`, `responseCompleted` and `fetchError` only, and never to `log.entryAdded`. Its collection carries `unavailable: { console: firefoxConsoleUnavailable }`.
- The scope covers network for the document and for frames of its own site and of other sites. Workers are not claimed. Its `reason` says a dedicated worker's request is recorded as its page's (Firefox names only the browsing context), and that only a navigation's request has a resource type.
- The console scope covers nothing. The test-only `consoleSerialization` option is gone, with the console parsing.
- **Outside my files, flagged:** no existing path let a web collector mark one kind unavailable. Without one, console would read `complete` with zero records, which is false. I made a minimal additive change to two shared files:
  - `src/diagnostics/observations.ts`: an optional `unavailable?: Partial<Record<DiagnosticKind, string>>` on `DiagnosticCollection`.
  - `src/diagnostics/attempt.ts`: `withoutSource`, applied to the finished capture in `#finishSession`.
  - With these, the summary and the artifact's end marker both say `unavailable`, and the policy's existing rule turns a strict console rule into "could not judge" (`reporting_failed`).
  - Neither file was being edited by the other worker as far as I could see; the orchestrator should confirm it accepts the change.
- **Unit tests:** `tests/unit/firefox-collector.test.ts` was rewritten for network-only capture (8 pass). New `tests/unit/firefox-collector-attempt.test.ts` checks: console unavailable with the reason, network complete, a strict console rule `reporting_failed` "could not judge", and the end marker. On a copy of `attempt.ts` without `withoutSource` it fails (`negative/console-unavailable.log`).
  - Removed from the collector unit file, because their behaviour no longer exists: the console-parsing case, "the real Firefox BiDi source refuses diagnostics…", the six "never guessed" refusal cases, and "capture refuses before an upstream console serializer…".
- **Real Firefox:** new `tests/integration/firefox-diagnostics.test.ts`, 6 of 6 (`pass2-b/firefox-diagnostics.log`). It checks, through the attempt that owns the capture:
  - the document is labelled `Document`;
  - a 404 and a 500 finish, while the refused connection fails as `NS_ERROR_CONNECTION_REFUSED` with no status;
  - a redirect of two hops is linked hop to hop;
  - the request that never ended is pending with `attempt_ended`;
  - a secret in a path is written `{{password}}` with the query cut (`?…`), and neither the secret nor `token=` is anywhere in the artifact;
  - there is no console record;
  - the page's logged getter is never run: the title stays `untouched`.
- `firefox-driver.test.ts`: the collector case now asserts the network records and the console's absence, and is 8 of 8.
- **The shared file `tests/integration/diagnostics-engines.test.ts` on Firefox** (not edited): 11 of 30 cases and subtests now pass, against 1 of 13 cases before. The fixture's network subtests pass, including another site's frame, the pending request and the getter not run.
- **Opt-in console capture, for the founder:** a target flag could subscribe to `log.entryAdded` with the stated caveat that Firefox then runs the getters of objects the page logs. Its records would also lack worker provenance and the kind of error. Not built.

**What must change in `tests/integration/diagnostics-engines.test.ts` for Firefox** (it asserts the same on every engine, so each needs a per-engine expectation the orchestrator approves):

1. Fixture case, the subtests on console levels, message text, other console calls, uncaught error and rejection: on Firefox, expect console `unavailable` with `firefoxConsoleUnavailable` and no console record.
2. The console frame and worker subtests pass on Firefox today only because there are no records; they should assert that the record exists, or that the kind is unavailable, so they cannot pass empty.
3. "the capture is complete…": network `complete`, console `unavailable`, and the scope's console `covered: []`.
4. "network, a dedicated worker…": Firefox records the worker's fetch as the page's. This is a named difference, stated in the scope's reason.
5. "the summary's counts…": no console counts for an unavailable kind.
6. Navigation and reload, two apps, pooled browser, ended capture, run stopped, limits, browser lost: these use console messages as per-page markers and assert console `complete`. On Firefox they need network markers (a fetch to `/mark/<name>`) and console `unavailable`.
7. Secrets: the network parts (paths, queries) stay checkable; no console record exists on Firefox.
8. Strict policy cases: on Firefox a console or runtime-error rule fails as `reporting_failed` "could not judge"; a network rule judges as on the other engines.
9. Quiet page: console `unavailable`, network `complete` and empty.

**What must change in `tests/unit/diagnostics-engines.test.ts`** (not edited; 3 of its Firefox cases fail, read-only run `unit-diagnostics-engines.log`):

- "a request, a response and an end that carry only the fields the protocol requires…" and "the optional fields the engine gives are kept…": both feed Firefox a `log.entryAdded` and expect "one console record". On Firefox the collector does not hear `log.entryAdded`, and the kind is unavailable in the attempt.
- "a console event that cannot be read makes the console capture partial…" does not apply to Firefox, which reads no console event.
- These cases drive a bare `SessionCapture`, so the `unavailable` hook, which lives in the attempt, is not seen there.

### 2. Every remaining red case

| Suite | Case | Kind | Where |
| --- | --- | --- | --- |
| actions | "Release checklist", parent "fill stops the typing when the focus moves…" | Firefox difference: typing is key by key, so the first typing event the guard stops is `keydown`, not Chrome's `beforeinput` | `proofs/firefox-driver.md`, remaining engine facts |
| actions | "the page hears each key and its modifiers", parent "a character is typed with the key a person presses…" | Firefox difference: BiDi sets Shift only by pressing it, so the page also hears Shift go down and up | guide, Firefox section |
| actions | "Home then X", parent "each editing key edits a field once" | Firefox difference: macOS key bindings, Home moves no caret | guide, Firefox section |
| actions | "a list chooses exactly those options of a select multiple…" | Refusal: "Firefox cannot verify the native option holding keyboard focus before toggling it. … Retest refuses multiple-select keyboard input before an unrequested option could be selected. Retest sent no input." | guide; asserted in `firefox-input-behavior.test.ts` |
| actions | "the wheel turned on the terms scrolls them to their end…" | Firefox difference: one wheel event moves at most one page | guide, Firefox section |
| actions | "a scroll delta is in CSS pixels, also on a phone page…" | Refusal: "Firefox cannot emulate a pixel ratio of 2.625, a touch screen, a mobile layout through WebDriver BiDi in the release Retest drives. …" | guide; asserted in `firefox-refusals.test.ts` |
| locators | "img Logo", parent "role without a name finds every element…" | Refusal: "…an image that did not load has different accessibility membership. Retest cannot judge this lookup on Firefox." | guide; asserted in `firefox-refusals.test.ts` |
| navigation | "an address nobody answers fails with the browser navigation error", "… names the address … and the browser's error in its details" | Firefox difference: `connectionFailure`, not `net::ERR_CONNECTION_REFUSED` | guide, Firefox section |
| navigation | "the goto hands over the title", "the navigation hands over the title", parent "a title reaches the parent as the page has it…" | Firefox difference: Firefox's `document.title` keeps ESC | guide, Firefox section |
| secrets | "the page hears that its navigation was cancelled", parent "a page that sets off for another origin…" | Firefox difference: a page's own script has no Navigation API in Firefox 133. The refusal, empty field, page kept and no typing all pass. | guide, Firefox section |
| secrets | "the text reached one request", parents "the page leaves after receiving the text once", "a fill bound to its origin still lets the page move…" | Firefox difference: Firefox cancels the page's request as the page leaves | guide, Firefox section |
| conformance | A5 | Refusal (multiple select) | as above |
| conformance | A7 | Firefox difference (wheel) | as above |
| conformance | F8.1a | Refusal: "Could not look up getByRole('row'): native tables can be layout tables in Chrome and data tables in Firefox. …" | asserted in `firefox-refusals.test.ts` |

- **Load timeouts:** none in the final round. The earlier ones (select in round 6; L7, L8, F10.5 in round 5) passed in `pass2-b/` and in round 4. L7 and F10.5 were early timeouts, fixed in the first pass.
- **Impossible or just not built:**
  - Impossible through BiDi 133 or the page itself: the key-by-key first event, Shift as its own key, macOS Home, one-page wheel, Navigation API, ESC in titles, the request cancelled as the page leaves.
  - Error names: a mapping from Firefox's names to Chrome's would be a guess.
  - Not built: the multiple select (needs a guarded modifier-click route per option). The failed image's name (Firefox's tree gives no confirmable fact).
  - Phone: touch, mobile layout and user agent are absent from BiDi 133. The refusal's sentence also names the pixel ratio, which `browsingContext.setViewport` may accept; not settled.
- **Cheaply buildable, done:** one failed image now refuses only the lookups it could change. Locators went from 23 to 24 of 26: "img Badge" passes, and the role table still has 0 differences in 23733 lookups.
- **Refusals asserted by name in my files:** new `tests/integration/firefox-refusals.test.ts`, 3 of 3: failed image, native table row, phone.
  - In `firefox-input-behavior.test.ts` the multiple-select refusal case stays. The forty-round success case is removed, with a note in the file: its success cannot happen while the refusal stands.
  - The shared suites keep their assertions and stay red on these cases, as they must.

### 3. My own open items

- **`input-order.ts`:** measured under one lock hold with a guaranteed restore (`measure-input-order.sh`, logs in `measure/`). With it: 10 of 10 four-window runs passed and 0 of 10 four-fill rounds went wrong. Without it: the same. Removed `src/browser/firefox/input-order.ts` and its unit test `tests/unit/firefox-input-order.test.ts`; that test's only case covered a turn that no longer exists. The activation before readiness stays. In the final round, the agent suites 26 passed, 2 skipped, including four sessions typing at once, and the four-window case passed.
- **The Launch Services exit watch** matches pid and the start time recorded at launch (`process.ts`, `startedAt` passed in by `openFirefox`). New unit case; it fails on a copy without the check (`negative/exit-watch.log`).
- **The collector's test-only option** is removed (item 1).
- **One failed image** now refuses only the lookups it could change (`accessible-names.ts` `markupRefusalFunction` takes the exact names asked for). Real: `firefox-refusals.test.ts` and the role table.

### 4. Small fixes

- `tests/integration/agent-harness.ts:36`: the comment now says "Chromium's and Firefox's".
- `docs/plans/public-beta/proofs/agent-sessions.md`: line 101 says the typing defect is fixed and why; line 131 now speaks of WebKit only and records Firefox's identity run.

### Gates on the final code (`pass2-b/`)

| Gate | Result |
| --- | --- |
| Firefox unit files, `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-*.test.ts` | 140 of 140 (`units-pass2.log`) |
| `npm run typecheck` and `node_modules/typescript-7/bin/tsc -p tsconfig.json` | no error in Firefox or diagnostics paths. The failures are in `fixtures/evaluation-corpus/runner/score.ts`, `src/evaluation/frames.ts`, `tests/unit/evaluation-frames.test.ts` and the new `tests/integration/report-html.test.ts` of another lane |
| `npm run test:types` | exit 1, `src/evaluation/frames.ts:97` (another lane) |
| `firefox-driver`, `firefox-hold`, `firefox-input-behavior`, `firefox-refusals`, `firefox-diagnostics`, `firefox-lookup`, `firefox-m2-state`, `firefox-roles` | 8/8, 2/2, 2/2, 3/3, 6/6, 1/1, 3/3, 1/1 (23733 lookups, 0 different) |
| `firefox-browser-actions`, `-locators`, `-navigation`, `-secrets` | 71/80, 24/26, 28/33, 19/24; every failure is in the table above |
| `diagnostics-engines.test.ts`, Firefox | 11 of 30 cases and subtests |
| conformance, Firefox | 160 of 164 (A5, A7, F8.1a, and the umbrella case) |
| `agent-firefox.test.ts` | 26 passed, 2 skipped by name |

No Firefox process or profile folder is left. Nothing was staged or committed.

### What I could not verify, most important first

1. The shared diagnostics file and the shared collector unit file still fail on Firefox until the changes listed above are made by their owners.
2. Whether `browsingContext.setViewport` honours a device pixel ratio on Firefox 133, which would narrow the phone refusal's wording.
3. The real spawn route (EPERM on this host).
4. The event-loop comparison with one idle Firefox (the machine stayed loaded).

### Files changed in this pass

- Mine: `src/diagnostics/firefox-collector.ts`, `src/browser/firefox/page.ts`, `process.ts`, `accessible-names.ts`. `src/browser/firefox/input-order.ts` deleted.
- Shared, flagged above: `src/diagnostics/observations.ts`, `src/diagnostics/attempt.ts`.
- Unit tests: `tests/unit/firefox-collector.test.ts`, `firefox-process.test.ts`; new `firefox-collector-attempt.test.ts`; `firefox-input-order.test.ts` deleted.
- Integration tests: `tests/integration/firefox-driver.test.ts`, `firefox-input-behavior.test.ts`; new `firefox-diagnostics.test.ts`, `firefox-refusals.test.ts`.
- Other: `tests/integration/agent-harness.ts` line 36; `docs/plans/public-beta/proofs/agent-sessions.md` lines 101 and 131; `docs/plans/public-beta/proofs/firefox-driver.md`; `docs/guide.md` (Firefox diagnostics line); this report.
- No dependency, script or environment change.
