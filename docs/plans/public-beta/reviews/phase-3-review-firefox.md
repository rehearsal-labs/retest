**Counts:** 2 high, 6 medium, 2 low.

**Five worst:**
1. **F-1 (high):** two looks at the same Firefox page interfere. A visible button counted 0 in 6 of 6 rounds, so `toBeHidden()` on it would pass.
2. **F-2 (high):** 14 of 136 role and name lookups I tried on real Chrome and Firefox return different sets, and none is refused. In 7 of them Firefox finds fewer: a password field labelled "Password" with an `aria-hidden` asterisk, a name holding a no-break space, `<input type=submit>` named "Submit", rowgroup, a lone gridcell, and more.
3. **F-3 (medium):** a secret fill bound to origins leaves every request a frame made during the fill blocked for good.
4. **F-4 (medium):** the record says the default spawn route is unit-tested and was proved by the Phase 1 proof. No test runs its process code, and the Phase 1 record says spawn never started a Firefox anywhere.
5. **F-6 (medium):** on the Launch Services route a synchronous `ps` runs every 100 ms for each live Firefox. With one idle Firefox, p99 event-loop delay was 44 ms and a quarter of the timer ticks were lost.

## Findings

**F-1, high.** `src/browser/firefox/bridge.ts:106` and `:172-182`, read at `:284-290`.
- **Claim:** `resolving()` keeps the names a locator asks for in one field per page. A second look started meanwhile overwrites it, so the first look's `Accessibility.queryAXTree` is answered with the second look's exact names.
- **Failure scenario:** a page holds the buttons Delete and Publish. Two `observe` commands run at once, as `Promise.all([expect(getByRole('button',{name:'Delete'})).toBeHidden(), expect(getByRole('button',{name:'Publish'})).toBeVisible()])` sends them (`src/api/command-lanes.ts:8`: "assertions may look together").
  - Delete came back with count 0 in 6 of 6 rounds; looked at alone, it is 1 (probe 1).
  - So `toBeHidden()` passes while the button is on screen.
- **Fix:** scope the wanted names to each resolution (pass them with the query, or AsyncLocalStorage), or run one resolution at a time per page. Add an integration case with two looks at once.

**F-2, high.** `src/browser/firefox/accessible-names.ts:106-123`, `:169-190` (the password name reader, title and placeholder at `:180`); `bridge.ts:284-290` (only the cell is refused).
- **Claim:**
  - An exact name is matched by Firefox against its own computed name, not after Retest's normalisation.
  - Password field names come from Retest's own reading of `textContent`, hidden parts included.
  - Firefox's role mapping differs from Chrome's for several element kinds.
  - Nothing refuses or records any of these.
- **Failure scenario,** measured on Chrome 154 and Firefox 133.0.3 (probes 1 and 4). Rows where Firefox finds fewer, so a hidden or count-0 check passes on Firefox only:

  | Lookup | Chrome | Firefox |
  | --- | --- | --- |
  | `getByRole('button',{name:'Save now'})` on `aria-label="Save&nbsp;now"` | 1 | 0 |
  | `getByLabel('Password')` on `<label>Password <span aria-hidden=true>*</span></label><input type=password>` | 1 | 0 |
  | `getByRole('textbox',{name:'Password'})` on the same field | 1 | 0 |
  | `getByLabel('Secret')` on a label holding a `display:none` span | 1 | 0 |
  | `getByRole('textbox',{name:'PIN'})` on `<input type=password title="" placeholder="PIN">` | 1 | 0 |
  | `getByRole('rowgroup')` | 1 | 0 |
  | `getByRole('button',{name:'Submit'})` on `<input type=submit>` | 1 | 0 |
  | `getByRole('gridcell')` on a lone `role=gridcell` | 1 | 0 |

  Rows where Firefox finds more, so a visible check passes on Firefox only:

  | Lookup | Chrome | Firefox |
  | --- | --- | --- |
  | `getByLabel('Password *')` on the asterisk field | 0 | 1 |
  | `getByRole('figure',{name:'C'})` on a figure with figcaption C | 0 | 1 |
  | `getByRole('button')` on `<input type=color>` | 0 | 1 |
  | `getByRole('none')` on a page with images | 0 | 3 or 4 |

  The lane's own failed-image case (`img` "Badge": Chrome 1, Firefox 0) is also left unrefused, though the cell, which has the same consequence, is refused.
- **Fix:**
  - Refuse by name each role and name source known to differ (rowgroup, gridcell outside a grid, none or presentation, figure and image alt names, submit, reset and color inputs, password fields whose label holds hidden content or whose title is empty).
  - For exact names, confirm through Firefox's raw candidates instead of the normalised text.
  - Keep a cross-engine table as a test.

**F-3, medium.** `src/browser/firefox/page.ts:627` with `:643`.
- **Claim:** the hold's intercept is set on the tab, and it catches the tab's frames too. But the listener drops every paused event whose context is not the top one, so frame requests are never continued. `removeIntercept` does not release them.
- **Failure scenario:** a sign-in page has an iframe that fetches every 40 ms. A secret fill bound to the origin runs. Requests 19, 20 and 21 were never received by the server and never settled, 3 s and more after the fill passed (probe 2). A captcha, payment or SSO frame stalls, and the test fails on Firefox because of Retest.
- **Fix:** continue at once any paused request that is not a navigation of the top context, and release on removal everything the hold paused.

**F-4, medium.** `docs/plans/public-beta/proofs/firefox-driver.md:123`; `codex/phase-3/build-firefox-report.md:72`.
- **Claim:** the record says the spawn route's code "is unit-tested and was proved in the earlier Firefox proof on a host with that access". Neither is true.
- **Failure scenario:**
  - No unit or integration test calls `spawnFirefox` or `FirefoxProcess` on a child. The only spawn tests parse `RETEST_FIREFOX_ROUTE` or hand `'spawn'` to a fake launcher.
  - `proofs/firefox.md` says the spawn route "was not exercised on this machine… that was not verified", and lists it first under "Not verified".
  - So the product's default route, which `doctor` reports as "found; a run starts it", has never started a Firefox, and the record does not say so plainly.
- **Fix:** restate it as "never run anywhere; no test covers its process code", and add a unit test of `spawnFirefox` with a stand-in executable.

**F-5, medium.** `src/browser/firefox/executable.ts:32-41`, and `checkFirefox` in `src/cli/doctor/checks.ts`.
- **Claim:** when the pinned 133.0.3 build is not in the cache, a run silently uses whatever Firefox is in `/Applications`, at any version. No version check, no warning, and `doctor` says "found; a run starts it".
- **Failure scenario:** a machine with Firefox 150 installed and no pinned build runs every Firefox test on an engine nobody exercised. The driver encodes facts specific to 133: password fields missing from the locator, `image` for `img`, unnamed cells, no Navigation API, `remote.active-protocols`. Only `browser.started.version` shows the swap.
- **Fix:** compare the version in `application.ini` with the pin, and fail setup by name unless the target names its `executablePath`.

**F-6, medium.** `src/browser/firefox/process.ts:211-226` (and the 20 ms polls at `:162` and `:203`).
- **Claim:** `#pollMainExit` calls `readProcessTable()` every 100 ms for the life of a Launch Services Firefox. That read is `readMetadataProcess`, which blocks the main thread with `Atomics.wait`; a full `ps -ww -axo` takes about 35 ms here.
- **Failure scenario:**
  - With one idle Firefox open, p99 loop delay went from 6.0 to 43.7 ms, and 10 ms ticks dropped from 382 to 284 in 4 s (probe 4).
  - Deadlines fire late and BiDi messages wait.
  - With three Firefox instances in one process, the polls take about all of the loop.
- **Fix:** use `readMetadataProcessAsync`, or watch the BiDi connection's end, and poll much less often.

**F-7, medium.** `src/diagnostics/firefox-collector.ts:204` (`origin: 'page'` always), `:63` and `:214-226` (`navigation` not read), scope at `:28-39`.
- **Claim:** worker messages and worker requests are recorded as the page's main frame, and the main document of a navigation is not labelled. BiDi's `beforeRequestSent` carries `navigation`, and nothing marks the field as unavailable.
- **Failure scenario** (probe 5):
  - A dedicated worker's `console.log` is recorded `origin: 'page', frame: 'main'`, although the scope claims dedicated-worker console coverage and Chromium labels it `worker`.
  - The worker's own `fetch` is recorded as a main-frame request, though the scope says worker network is not covered.
  - The main document, favicon, `worker.js` and the worker's fetch all read `frame: 'main'` with no `resourceType`.
  - A null `text` becomes `''`.
  - `tests/integration/diagnostics-engines.test.ts:216` asserts `origin === 'worker'` when that coverage is claimed. I did not run it.
- **Fix:** tell worker realms apart through `script.realmCreated`, and mark a request with a non-null `navigation` as the document. Otherwise name the missing field in the scope's `reason`.

**F-8, medium.** Shared suites at `browser-actions.test.ts:323`, `browser-locators.test.ts:84`, `browser-navigation.test.ts:256`, `browser-secrets.test.ts:156`; `tests/integration/engines.ts:66`; record rows at `firefox-driver.md:31-41` and `:80`.
- **Claim:** several Firefox failures stop at their first assertion, so the invariant checks after them never ran. Yet the rows read "Passing", and difference 6 asserts behaviour the suite never showed.
- **Failure scenario:**
  - The fill whose focus moves never checked that the page got no text (`'Old|Other'`), nor the empty-value round.
  - Locators never checked `math 'Formula'` or `heading 'Locators'`.
  - The title case never checked an empty title, long titles, the surrogate-pair cut or the `readPage` title.
  - The secrets case at line 137 never checked the empty field, that the page never left, or that no origin got typing. My probe 3a shows these do hold on Firefox.
  - The m2-state "second build" is the same Firefox under the same pool key, so one browser serves both targets.
  - The two `protocolOnly` skips are a test-instrument limit, not a Firefox one. A wrapper around `BidiClient.send` or a socket relay, or the `FREEZE_ON_PRESS` trick for a key, would run both.
- **Fix:** split those cases so the invariant assertions run on Firefox, build a Firefox gate, and list in the record each assertion that never ran.

**F-9, low.** `page.ts:665`; `accessible-names.ts:107-150` and `:187`, `:196`, with the budget fixed at `bridge.ts:287`.
- **Claim:** the hold's release gives each command at least 5000 ms past the deadline. A role lookup gives each of its sequential round trips the whole remaining budget again.
- **Failure scenario:**
  - A fill bound to origins whose deadline passed, with two held requests, can spend up to about 21 s in `finally` before it reports.
  - A loose name over many distinct names sends up to 25 batches, each with the full budget, so a 2000 ms look can answer far past its deadline.
- **Fix:** bound every call by the command's own `Deadline`.

**F-10, low.** `page.ts:587` and `:622-624`.
- **Claim:** the hold starts before the actionability wait. Any navigation the page starts while the fill waits for its field is held, then cancelled, and the fill fails. Chrome's guard holds only once armed, right before input.
- **Failure scenario:** the field enables after 300 ms, and the page does `location.replace('/login?step=2')` on the same origin at 100 ms. Firefox cancels the app's own redirect and fails with "the page started to open … before Retest typed". Chrome lets the page go and fills the next document.
- **Fix:** arm the hold when the readiness call arms the guard, and treat earlier navigations as pending, as Chrome does.

## Account of skipped or differing shared cases

Counts are the lane's, from `/tmp/retest-firefox-lane/it-*.log`.

**browser-actions: 62 pass, 5 fail, 1 skip**
- Focus moved: Firefox stops at `keydown`, which is real, since it types key by key. The rest of the case never ran (F-8).
- Shift: the typed text matched; only the extra Shift keydowns differ. Fully run.
- Editing keys: Home on macOS Firefox is real. "Home End X" and "Shift+Home X" never ran.
- Wheel on terms: one page per turn of the wheel. The Accept click never ran; splitting the delta into several turns was not tried.
- Phone scroll: the desktop half passed; the phone half was refused by name. Real.
- Skip, key down then key up: the invariant is not exercised for keys on Firefox (it is for a click in `firefox-driver`).

**browser-navigation: 24 of 26**
- Connection refused: Firefox's own words. `details` never ran.
- Title: ESC is kept. Everything after it never ran.

**browser-locators: 20 of 21**
- Failed-image alt: Firefox finds fewer and does not refuse it (F-2). Math and heading never ran.

**browser-secrets: 8 of 11**
- Line 137: the page has no Navigation API, so its `navigateerror` report never comes. The remaining assertions hold by my probe but never ran in the suite.
- Line 177: the `/typed` POST is lost as the page leaves. Only the last line failed.
- Line 244, skipped. The missing protection: on Firefox the new document's guard is not in place when the document starts. It is installed by a call after Retest hears the commit, and the relays carry nothing until then. So a document arriving mid-typing is stopped only by the network hold, which exists only for fills bound to origins and only for navigations that make a request.

**Others**
- m2-state 3 of 3, one browser for both targets.
- lookup 1 of 1.
- Conformance 142 of 145: A7 is the wheel, F8.1 is the cell refused by name, and X5 failed the same way on Chrome. Not re-run by me.

## What I confirmed by running it

- **Unit tests:** `node --conditions=retest-source --test tests/unit/firefox-*.test.ts`: 81 of 81 pass.
- **Probes on the real browsers.** Each ran as `lockf -t 0 /tmp/retest-heavy-gate.lock perl -e 'alarm N; exec @ARGV' node --conditions=retest-source /tmp/retest-review-firefox/probeN.ts`, with output in `/tmp/retest-review-firefox/probeN.log`. Firefox went through Launch Services and was closed every time.
  - **Probe 1:** names table, and two looks at once (F-1, F-2).
  - **Probe 2:** frame requests during a secret fill (F-3). The secret was not in the browser log.
  - **Probe 3:**
    - (a) The rest of the secrets case at line 137 holds.
    - (b) A plain fill whose page leaves at the first key, 5 rounds: the arriving document received no keys.
  - **Probe 4:** 119 lookups by element kind, 7 differ; event-loop delay measured (F-2, F-6).
  - **Probe 5:** collector attribution (F-7).
- **Timing of `ps`:** a full `ps -ww -axo …` takes 30 to 40 ms here.
- **Lane logs:** read to account for each differing case.
- **Leftovers:** nothing of mine is running, and no `retest-firefox-*` folder is left.

## What I could not verify, most important first

1. The spawn route on a real Firefox: this host cannot spawn one.
2. Whether a plain fill's later keys can reach a document that commits before its guard is installed. Probe 3b was 5 rounds and inconclusive.
3. Navigations that need no request (about:blank, blob:) during a secret fill.
4. The diagnostics-engines worker assertion on Firefox, the whole suites, conformance and typecheck. Other lanes are editing those files.
5. How the driver behaves on a newer system Firefox (F-5).
6. The budget overruns in F-9: from reading the code only.
7. Whether Firefox ever answers `no such frame` for a call that had already begun. The bridge maps that answer to "never ran".
