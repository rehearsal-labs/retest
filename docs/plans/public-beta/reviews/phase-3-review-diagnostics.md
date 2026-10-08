No High findings. 5 Medium, 8 Low.

Worst, one line each:
- **D-1:** The "same assertions" are gated on each engine's own declared scope. A driver can pass by declaring less, and its mislabelled records then go unchecked.
- **D-2:** On Firefox, the check of network same-process frames never ran: an earlier assertion in the same subtest throws first. The record still implies Firefox was read.
- **D-3:** The per-engine fixture case is looser than the Chrome case it copies, while the record and guide say "the same checks". The pending count is only "at least 1", and out-of-scope marks and absences are not asserted.
- **D-4:** The guide's "Per engine" section says "limits, secrets, capture status and the policy work the same", but the `strict` policy never ran on Firefox or WebKit. Its own next bullet contradicts that sentence for Firefox.
- **D-5:** The secrets row says "passed" on every engine. On Firefox and WebKit the object-preview message and the long token never reached a record, so part of that check passes because nothing arrived.

## Findings

**D-1, Medium.** `tests/integration/diagnostics-engines.test.ts:214-217`
- **Claim:** The frame and worker assertions run only when the engine's own scope declares the area covered, so the declared scope works as a per-engine table of expected values.
- **Scenario:** The progress row tells the Firefox fix lane to reach 11 of 11 without editing the test file. The cheapest fix is to drop `dedicated_workers` from `firefoxScope.console.covered`. The check at :216 then passes. The artifact still holds "from the dedicated worker" with `origin: 'page'`, and nothing fails: `beyondScope` only logs whether the text is present, and the console-level subtest checks only the five level words.
- **Fix:** When a fixture record from a frame or worker is present, require its true label (`origin: 'worker'`, `frame: 'child'`) whatever the scope says.

**D-2, Medium.** `tests/integration/diagnostics-engines.test.ts:216-217`; `docs/plans/public-beta/proofs/engines-diagnostics.md:137`
- **Claim:** On Firefox, line 216 throws (`'page' !== 'worker'`, in `/tmp/retest-final-diagnostics-engines-11.log`), so line 217 never runs. That line is the network same-process-frame check: the frame's document and a fetch labelled `frame: 'child'`.
- **Scenario:** Firefox declares `network.covered: ['top_level_document', 'same_process_frames']`. If the frame's fetch were labelled `main` or missing, no run here would show it. Record line 137 says the case reads `frame: 'child'` "where an engine's scope claims frames (Chrome and Firefox)". The Firefox driver record lists no real-engine check of frame network either.
- **Fix:** Split each scope area into its own subtest. Record the Firefox network-frame claim as unverified until it runs.

**D-3, Medium.** `tests/integration/diagnostics-engines.test.ts:282-288` (also :199-203 and :212-219); record :7; guide :1006
- **Claim:** The per-engine case is weaker than `tests/integration/diagnostics.test.ts:70-194` in these places:
  - pending is `>= 1` where Chrome asserts exactly 1;
  - no `outOfScope` count, and no `out_of_scope` marks on `worker.js` or the remote frame (Chrome :172-177);
  - no count of in-scope `/diagnostics/data` requests (Chrome :114);
  - no absence check for areas declared not covered (Chrome :112);
  - "every argument" checks two of the four arguments, never the array.
- **Scenario:** An engine never ends the worker script or the other site's document, so the capture records it as `network.pending`, reason `attempt_ended`, at the end: an inferred outcome, not an observed one. The per-engine case still passes (`pending >= 1`, `assertCountsMatch` consistent), and the record shows "passed".
- **Fix:** Assert `pending === 1`. Then either assert the out-of-scope marks for each area declared not covered, or require that the record says which area each request came from.

**D-4, Medium.** `docs/guide.md:977, 1006, 1014, 1018, 1020`
- **Claim:** The guide claims more than the logs show:
  - "with the same checks" (:1006);
  - "limits, secrets, capture status and the policy work the same" (:1014), while `strict` never ran on Firefox or WebKit, and :1020 says Firefox's own CORS message counts under a strict `runtimeErrors` rule, which Chrome excludes as `origin: 'browser'`;
  - reports, `inspect`, the oversized-message cut and the byte limit were not run per engine;
  - "failing runs alike, on Chrome, Firefox and WebKit" (:977) is not asserted for WebKit;
  - :1018 states as fact why Firefox runs the getter, which the record (unverified item 4) says was not traced;
  - :1018 presents a breach of "observation is read-only", on by default, as an engine difference with a workaround.
- **Scenario:** A user sets `strict: { runtimeErrors: true }` on Firefox. Following :1014, they expect Chrome's behaviour, and a page that throws nothing fails.
- **Fix:** Name exactly what ran per engine. Drop "the policy work the same". Mark the getter as an open defect, and its cause as untraced.

**D-5, Medium.** `tests/integration/diagnostics-engines.test.ts:533-559`; record :52
- **Claim:** On Firefox (`[object Object]`) and WebKit (first argument only), these never reach a record:
  - the object message `{ token, note, quoted }`;
  - the long token (`console.log` with the object and with the function source).
- So the ten-character-window check at :544-547 passes for the token because nothing was delivered, not because redaction worked. The per-engine copy also drops Chrome's positive assertions at `diagnostics.test.ts:261-263, 270, 273-274`: the cut preview with `{{password}}`, `Error: failed with {{password}}`, and the stack address without its query. Headers and cookies are never recorded on any engine, so "passed" there holds by construction.
- **Scenario:** A Firefox fix makes objects readable, and a quoting difference leaves `quoted: "correct horse \"battery…"` unredacted. This case was never shown to catch that path, because the path never carried the secret.
- **Fix:** Assert, per engine, that a record holding `{{token}}` and one holding `{{password}}` from the object exist. Otherwise record those paths as not exercised on that engine.

**D-6, Low.** `tests/integration/diagnostics-engines.test.ts` (no such case); record :139-150
- **Claim:** There is no deliberately failing test with diagnostics per engine, though the Phase 3 verification names "passing, failing, interrupted and overflow". The record does not list it as unverified.
- **Scenario:** A WebKit failure path that drops or mixes up the artifact on `check_failed` passes every case here. Firefox shows it only through the accidental getter failure.
- **Fix:** Add a per-engine copy of `diagnostics.test.ts:318-326`, a failing check with an artifact, isolation and status asserted.

**D-7, Low.** `tests/unit/diagnostics-engines.test.ts:22-27, 58-59, 326-345, 382-408, 443-453`; record :63
- **Claim:**
  - "Keeps no listener" is asserted only for the late case. The cannot-start cases never inspect the refused session or client.
  - `Rig.listening()` is defined for each engine and never called.
  - After `endpoint.drop()`, Firefox's "hears nothing more" cannot fail, because the socket is gone.
- **Scenario:** If `ChromiumCollector.start` stopped removing listeners on a failed `Network.enable`, every test here would still pass, and the record row "cannot start … keeps no listener: passed" would stand.
- **Fix:** Return the fake session or client from `refusingPage` and assert zero listeners. Use `rig.listening()` after `lose()` and `close()`.

**D-8, Low.** `src/diagnostics/webkit-collector.ts:184`; `tests/unit/diagnostics-engines.test.ts:22-27, 219-222, 253-271`
- **Claim:** A WebKit console message without a `timestamp` gets the parent's `Date.now()` and is not marked. The unit file's stated contract is "never a zero or a guess", and its WebKit "required" message sends no timestamp but never asserts `time`.
- **Scenario:** WebKit omits `timestamp`. The record carries a receive time presented as the engine's, and the "optional fields left out stay out" case passes.
- **Fix:** Assert `message.time` per engine in the required-fields case, and record the WebKit substitution as a finding.

**D-9, Low.** `tests/integration/evaluation-ai-sdk.test.ts:265-275`
- **Claim:** Each live gate asserts only `pass` on true requirements. Its message "the judge was sent the screenshot the run folder keeps" checks the evidence record, not what reached the provider.
- **Scenario:** The model returns `pass` while ignoring the image, or the image is dropped in transit. The gate passes.
- **Fix:** Add a screenshot check with a false requirement that must come back `fail`.

**D-10, Low.** `src/diagnostics/webkit-collector.ts:200-213`; record :78
- **Claim:** WebKit declares frames not covered, yet records from same-site and other-site frames arrive inside a `complete` capture. The console records carry no `frame`, so they cannot be told apart from the document's. The record calls this "Honest".
- **Scenario:** A `console.error` from another site's frame on WebKit is counted by a strict `consoleErrors` rule as the document's error, from an area the scope disowns.
- **Fix:** Label or filter frame records on WebKit, and drop "Honest" from finding 8.

**D-11, Low.** `tests/integration/diagnostics-engines.test.ts:470, 372`
- **Claim:** The run-stopped case never asserts the network state, and the pooled case never asserts the console state (Chrome has the same gaps).
- **Scenario:** On SIGINT, Firefox's connection closes before `finish`, and the network goes from `complete` to `partial`, or the reverse. Unobserved.
- **Fix:** Assert both states in both cases.

**D-12, Low.** `src/diagnostics/session-capture.ts:158-167, 488-491`; `src/diagnostics/chromium-collector.ts:172-174`
- **Claim:** The new rule misclassifies nothing that starts with `network.` in either direction. But Chromium's `Page.frameDetached`, which only ends network hops, still counts as console when unreadable.
- **Scenario:** An unreadable `Page.frameDetached` (reason `swap`) leaves the frame's hops open. They are marked pending at the attempt's end while the network reads `complete` and the console reads `partial`.
- **Fix:** Classify by the kind the event feeds, not by its name prefix.

**D-13, Low.** Record :115; report :7, :9, :22; progress row
- **Claim:** "5 of its 13 checks": the fixture case has 12 subtests, so Firefox fails 5 of 12, or 6 of 13 counting the parent. "The judges handed exactly the stored bytes": the fake judge is compared by size and dimensions only (`evaluation-engines.test.ts:223-229`). Only the pixel judge is compared by hash.
- **Fix:** Correct both statements.

The engine failures (Firefox's 5 checks, WebKit's 1) are stated as failures, not coverage, in the record table, the commands table and the progress row. I checked this against the log.

## Confirmed by running or reading the artifacts
- `pgrep -fl benchmarks/run.ts`: only another agent's shell matched; no benchmark process was running.
- `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts` (output in `/tmp/review-diag-engines-unit.log`): 27 of 27 pass.
- `/tmp/retest-final-diagnostics-engines-11.log`:
  - 69 tests, 61 pass. Firefox fails the getter/title, argument text, worker origin, rejection kind and runtime error count. WebKit fails argument text.
  - On Firefox, the "every area" subtest stops at line 216 (D-2).
  - The coverage diagnostics match the record's fractions.
- `/tmp/retest-capture-kind-before.log` and `/tmp/retest-diag-engines-unit-2.log`: the Firefox cases fail on the old classification, as the record says.
- `/tmp/retest-eval-live-gates-skip-1.log`: all three gates skip by name and variable.
- `/tmp/retest-final-evaluation-engines-11.log`: 3 of 3; sources `chromium`, `firefox`, `webkit`; defect share 0 and about 0.4989.
- `/tmp/retest-diag-probe-firefox-off-result.json`: the Firefox fixture passes with capture off.
- Read, not run:
  - every caller of `unreadable` and `limited` (only the three collectors), which grounds the D-12 classification check;
  - `package.json` and the harness: no `--env-file` or dotenv; live keys come only from `process.env`.

## Not verified, most important first
1. **Firefox and WebKit integration cases.** I was limited to Chrome, so I did not run them. Firefox's labelling of frame network records (D-2) and the actual pending and out-of-scope counts on Firefox and WebKit (D-3) are unknown.
2. **Live gates with keys.** None was available, and no provider was called.
3. **Typecheck of the lane's files.** I did not run the heavy gate.
4. **Whether the test-file child process is denied the `RETEST_EVALUATION_*_KEY` variables.** There is a `hiddenVariables` mechanism in `src/runner`; I did not trace it for credentials.
5. **The coordinator's authorization of the `session-capture.ts` edit.** The brief did not list that file; the report says the coordinator added it.
6. **Firefox through the default spawn route, renderer crashes on Firefox and WebKit, and Linux.** The lane did not exercise them, and neither did I.

Relevant files:
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/diagnostics-engines.test.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/diagnostics-engines.test.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/evaluation-engines.test.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/evaluation-ai-sdk.test.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/diagnostics/session-capture.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/diagnostics/webkit-collector.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/diagnostics/chromium-collector.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/guide.md`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/engines-diagnostics.md`
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-3/build-engines-diagnostics-report.md`
