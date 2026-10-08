**Counts:** 2 high, 7 medium, 12 low.

**The five worst:**
- C-1: conformance case F8.1 makes Chrome's habit of giving table rows no name the contract on every engine. The Playwright adapter refuses the same call because it "would pass falsely".
- C-2: on Firefox and WebKit, the workflow cases are judged more loosely than the release gate and the Chromium files. A click sent twice still counts as "as declared".
- C-3: some cases pass even when their premise never happened. Five of Firefox's 112 passes in the generated table are of this kind.
- C-4: an engine that is missing, or whose driver is not wired in, becomes a skip, and both conformance gates exit 0.
- C-6: the Playwright comparison passes even when Retest's own run exits 2 with `cleanup_failed`. This happened in run-3.

All paths below are under `/Users/dragon/Documents/Projects/Gruvi/Products/retest/`.

## Findings

**C-1 (high).** `fixtures/conformance/workflow/f08-lists.retest.ts:24`, `tests/conformance/cases.ts:714`, `docs/plans/public-beta/proofs/conformance.md:67`
- **Claim:** F8.1 declares `getByRole('row', { name }).toHaveCount(0)` a pass on all three engines. That is Chrome's quirk, not the contract. `src/playwright/not-yet.ts:212` refuses the same call because a count of 0 "would otherwise pass falsely", and Playwright 1.63 names the row.
- **Failure:** a native test `expect(page.getByRole('row', { name: 'Grace Hopper grace@example.com Editor 12' })).toBeHidden()` passes against a visible row. A WebKit or Firefox driver that names rows by the accessibility rules would be marked "differs". The record tells both drivers to copy Chrome's rule.
- **Fix:** refuse `getByRole('row', { name })` in the native API too, and drop the `toHaveCount(0)` line from the contract.

**C-2 (high).** `tests/conformance/execute.ts:429-435`, `tests/conformance/cases.ts:666-735`
- **Claim:** a failing workflow case is judged only by class, matcher and step. `workflow-cases.md` defines the gate as the named step, the line of the check, the class and the message. The facts the Chromium files check are also dropped:
  - server sign-up counts (`tests/integration/workflow-validation.test.ts:105-123`)
  - pages opened by an action (`workflow-search.test.ts`)
  - recorded choices (`workflow-selection.test.ts`)
  - saved and restored states, test order and the session cookie (`workflow-saved-state.test.ts:93-124`)
  - each sign-in path (`workflow-sign-in.test.ts`)
- **Failure:** a WebKit driver sends "Create account" twice in F6.2. The server records two sign-ups and the page still shows "Welcome, Ada Lovelace", so conformance says "passed"; the Chromium file would fail at line 110. Enter submitting twice in F9.1 also passes. F1.4 failing at another `toHaveText` in the same step, or with another message, is "as declared". On Firefox and WebKit these cases run only through conformance.
- **Fix:** carry each Chromium file's facts (counts, pages opened, choices, state events, order, failure line and message) into `cases.ts`.

**C-3 (medium).** `tests/conformance/execute.ts:537-543`, `fixtures/conformance/web/isolation.retest.ts:22`, `fixtures/conformance/workflow/f03-saved-state.retest.ts:32,45`
- **Claim:** U2, F3.2 and F3.3b don't require the earlier case that gives them meaning to have passed. The secret-absent facts R10–R12 don't require the secret to have been typed.
- **Failure:** this is what the generated table shows for Firefox (`docs/compatibility/conformance.md:89,119,162-164`):
  - U1 errored at its first fill, yet U2 "passed".
  - No signed-in test ran, yet F3.2 "passed".
  - No secret fill happened anywhere, yet R10, R11 and R12 "hold".
- **Fix:** make these cases depend on their premise case's result, and make secret-absent require an `action.completed` fill naming that secret.

**C-4 (medium).** `tests/integration/conformance.test.ts:17-27`, `tests/conformance/execute.ts:141-142,328-333`, `tests/conformance/run.ts:42-46`
- **Claim:** availability decided at run time becomes a skip (in the wrapper) or no difference at all (in `run.ts`).
- **Failure:** on macOS with no Firefox at `/Applications` and no `RETEST_TEST_FIREFOX`, `npm run test:integration` passes. Worse: if `target-drivers.ts` loses the Firefox wiring, every web test is refused with `details.driver: 'firefox'`, `refusal()` marks Firefox "not available", and the gate goes green.
- **Fix:** on darwin, fail when Firefox or WebKit is unavailable unless a variable opts out by name. Never turn a driver refusal into "not available".

**C-5 (medium).** `fixtures/conformance/web/test-budget.retest.ts:6` with `cases.ts:437`; `web/actionability.retest.ts:7-11` with `cases.ts:343-347`; `web/assertions.retest.ts:53` with `cases.ts:404`
- **Claim:** three titles are not established by their cases.
  - T7 never separates the test's own 1500 ms budget from the run's 20 s test budget.
  - A8 observes neither the wait nor the single click.
  - S4's `expect.poll` matches on its first read.
- **Failure:** a runner that ignores `{ timeout: 1500 }` still passes T7 (timeout at `test`). A driver that clicks the still-disabled button at once still passes A8: the `toBeEnabled` after the click plus a completed click is all the case checks. Polling in S4 is never exercised.
- **Fix:** add a 1500 ms deadline fact to T7, a click counter and a duration floor to A8, and a poll on a value that changes to S4 with `attempts > 1`.

**C-6 (medium).** `scripts/compare-playwright.ts:211-213`, `tests/integration/playwright-compat-table.test.ts:22-40`, `tests/unit/playwright-compare.test.ts:197,208`
- **Claim:** the gate ignores Retest's run failure and exit code, and the unit test asserts it "holds" with exit 2 and `cleanup_failed`.
- **Failure:** `/tmp/retest-pwcompat-logs/run-3/retest-run/result.json` has status error, exit 2 and `cleanup_failed`, with 38 cases judged equivalent (`compare-3.log`). Under the current code that run passes.
- **Fix:** require no Retest run failure and the same exit code as Playwright.

**C-7 (medium).** `fixtures/playwright-compat/playwright-test.d.ts:4-6`, `fixtures/playwright-compat/tests/create.spec.ts:10`, `fixtures/playwright-compat/cases.ts:189-197`, `docs/compatibility/playwright.md:27`, `docs/plans/public-beta/proofs/playwright-compat.md:33`
- **Claim:** the corpus is fitted to the subset.
  - Specs must typecheck against Retest's own types, so no untyped Playwright member can appear.
  - Every select uses `{ label }` instead of the common bare string.
  - Family 3's four cases are moved out of the corpus.
- **Failure:** the natural `selectOption('High')` (F4.1, F5.1, F7.1, F7.3, F9.3) and saved state (F3) are gaps. The table says "Declared gaps: 1" and the record says each test is "written as Playwright writes it".
- **Fix:** add those forms as declared gaps and report gaps out of all 43 cases.

**C-8 (medium).** `scripts/compare-playwright.ts:636-639`
- **Claim:** for an intended failure, "equivalent" ignores the reason (message, expected or actual).
- **Failure:** Retest reads stale text in F4.4 and fails `check_failed` at line 49 in the named step. That counts as equivalent to Playwright's failure on "Release checklis".
- **Fix:** compare the normalised expected and actual values of intended failures.

**C-9 (medium).** `tests/conformance/execute.ts:459`
- **Claim:** the deadline fact accepts giving up 50 ms early or up to 3 s late, and doesn't require more than one look. `tests/integration/workflow-async.test.ts:74-76` requires `durationMs >= 1500` and `attempts > 2`.
- **Failure:** a check that gives up at 1460 ms or at 4.4 s satisfies the 1500 ms deadlines of F10.4, F10.5, S7 and L8. A 300 ms check that overruns tenfold passes S10, S11 and N5 when `timeoutMs` matches.
- **Fix:** no early slack, a tight late bound, and `attempts > 1` for assertions.

**C-10 (low).** Cases in `web/locators.retest.ts`, `web/navigation.retest.ts`, `web/actionability.retest.ts` and `web/structure.retest.ts:11-31`
- **Claim:** side effects the titles promise are never observed:
  - L6 "clicks none", N6 "sends nothing", A12 "not checked", A13 "page hears no part of one", A14 "not scrolled" (no page counter is read after the failure).
  - N5, S7 and S11 "naming …": the message is never checked.
  - T1: step order is never checked.
  - T2: it is not pinned which of the two `toHaveText` afterEach checks failed.
- **Failure:** a driver that clicks the first of several matches and then reports `ambiguous` still passes L6.
- **Fix:** read the page's counters after the failure, add the missing message or step facts, and add a step-order fact.

**C-11 (low).** `tests/integration/cli-harness.ts:240-249`
- **Claim:** when a test body fails, node:test drops the after-hook's error, so the "Process group … is still there" message disappears. The `identityRefusals` returned by `signalReport` are also dropped from the message.
- **Failure:** I demonstrated it with `/tmp/retest-review-c/after-hook.test.mjs`: only "BODY FAILURE" was reported, and the leftover was never named.
- **Fix:** write leftovers through `t.diagnostic` or stderr before failing, and include the identity refusals.

**C-12 (low).** `tests/conformance/execute.ts:191,262-264`, `tests/conformance/process.ts:170-171`
- **Claim:** `endRun` waits for the run's exit with no bound. Leftovers that `assertNothingLeft` finds are reported but never ended.
- **Failure:** a Retest regression that ignores SIGINT in cancel-after-input hangs the gate forever, since node:test has no timeout here.
- **Fix:** bound the wait and end the run's group on timeout, as `compare-playwright.ts` does.

**C-13 (low).** `tests/conformance/execute.ts:266-270`, `tests/conformance/process.ts:19-22`, `docs/plans/public-beta/proofs/conformance.md:10`
- **Claim:** `interrupt()` kills the browser's process group by number after checking only pgid and a command substring. There is no start-time check and it bypasses the ownership layer that `m2-guarantees.test.ts:138` now uses. The record's "signals only what it launched" is inaccurate, and the file's comment about a broken harness is stale.
- **Failure:** an exiting browser whose command `ps` shows as `(firefox)` makes the interruption fail.
- **Fix:** use `OwnedProcessGroup(run.pid).groupFor(browser.pid).signalReport`.

**C-14 (low).** `scripts/compare-playwright.ts:221-224,291-301`
- **Claim:** a reused Playwright install is trusted on its own record and the `package.json` versions; nothing is hashed again.
- **Failure:** edited files under `$TMPDIR/retest-playwright-compat` run under the "pinned checksum" label.
- **Fix:** re-verify `packs/*.tgz` when reusing the folder.

**C-15 (low).** `scripts/compare-playwright.ts:389`
- **Claim:** `--untracked-files=no` hides untracked source files.
- **Failure:** with only untracked changes left (`src/playwright/page.ts` is untracked today), the table would say "at commit X" with no uncommitted changes.
- **Fix:** drop that flag.

**C-16 (low).** `scripts/compare-playwright.ts:350-357`
- **Claim:** the limit timer is not cleared when spawn fails.
- **Failure:** with npm missing, the script lingers until its 5-minute install limit fires.
- **Fix:** clear the timer in `finally`.

**C-17 (low).** `docs/plans/public-beta/proofs/playwright-compat.md:57-58`
- **Claim:** the record says "five comparisons after it (run-1 to run-5) gave the same 39 verdicts". `compare-1.log` shows run-1 is the `/private` mismatch run with no judged case; only run-2 to run-5 agree. Line 58 also counts run-1 among "those five" cleanup failures.
- **Fix:** say run-2 to run-5.

**C-18 (low).** `docs/plans/public-beta/proofs/conformance.md:16-34,73`, `docs/plans/public-beta/progress.md:160`, `tests/conformance/run.ts:43-46`
- **Claim:** the record and the progress row still say X5 differs on Chrome and give 144/111/133. The table itself was written by the WebKit lane's run 5: it is byte-identical to `/tmp/retest-webkit-conformance-5-table.md`, and the Firefox lane's script copies it aside and restores it. Run 5's log asserts only Chrome (0 differences) and Firefox (34), because `run.ts` stops at the first engine with differences. "WebKit 144 of 145" rests on the table alone.
- **Fix:** update the record, and assert every engine before failing.

**C-19 (low).** `src/playwright/page.ts:32`
- **Claim:** the row-by-name refusal exists only at runtime; `Finders.getByRole` types `row` with a name as valid. That is how F8.1 entered the typechecked corpus.
- **Fix:** add a type-level refusal.

**C-20 (low).** `tests/unit/runner-target-drivers.test.ts:326-350`
- **Claim:** the changed assertion now expects a WebKit target with no build to take one of the two browsers. Chromium's tests used to keep both; they now share one.
- **Fix:** confirm with the runner lane that this is intended.

**C-21 (low).** `tests/integration/engines.ts:66,81`
- **Claim:** `target(_, 'second')` returns the same build on Firefox (without saying so) and on WebKit.
- **Failure:** m2-state's two-target case runs "chrome" and "testing" on one build on those engines.
- **Fix:** say so in the suite's output, or skip by name.

## Do the 33 conformance files establish their titles?
- **`web/navigation`:** mostly. N5 and N6 only partly ("naming", "sends nothing").
- **`web/locators`:** yes, except L6 "clicks none".
- **`web/actions`:** mostly. "Saves once" (A1) and "Enter submits once" (A4) are not counted.
- **`web/actionability`:** no for A8, A12, A13 and A14. Yes for A9 to A11, except that "naming what covers it" is unchecked.
- **`web/assertions`:** no for S4. S7 and S11 partly ("naming"). The rest yes.
- **`web/structure`:** T3 to T6 yes. T1 partly (step order). T2 doesn't pin which afterEach failed.
- **`web/test-budget`:** T7 no. T8 yes.
- **`web/isolation`:** U1 yes. U2 vacuous when U1 fails.
- **`workflow/f01`:** passing cases yes. F1.4 lacks line and message.
- **`workflow/f02`:** partly; sign-in paths are dropped.
- **`workflow/f03`:** no. Order and saved/restored states are unchecked, and F3.2 and F3.3b can pass vacuously.
- **`workflow/f04`:** mostly; commands are checked.
- **`workflow/f05`:** yes on the page; failing cases lack line and message.
- **`workflow/f06`:** no. "Sends nothing" and "accepted once" go unchecked.
- **`workflow/f07`:** partly; "changes once" is unchecked.
- **`workflow/f08`:** F8.1 encodes Chrome's quirk (C-1). F8.2 to F8.4 yes.
- **`workflow/f09`:** no. "One page from the server" is unchecked.
- **`workflow/f10`:** yes, within the C-9 slack.
- **`projects/viewport`:** yes; height is not checked per target.
- **`server/served`, `server-fails/never-ready`, `filter/titles`, `only/focused`:** yes.
- **`locks/holds-a`, `holds-b`, `holds-c`:** yes, through the app's own overlap counter plus R2.
- **`limits/holds-one`, `holds-two`:** yes, with R3.
- **`lifecycle/cancel-after-input`, `lost-after-input`:** yes, through the app's save count.
- **`lifecycle/lost-while-looking`:** yes. A kill that lands before the check starts makes it flaky, never a false pass.
- **`participants/two-accounts`, `four-sessions`:** yes, but R12 is vacuous when nobody signs in.

## Assertions changed in the shared suites (`git diff HEAD`)

**Integration:**
- **`browser-actions.test.ts:701` and `browser-secrets.test.ts:245`:** skipped off Chromium through `protocolOnly`, because the gate holds DevTools messages. Two invariant cases (lost between key down and key up; a document arriving mid-fill) stay unverified on Firefox and WebKit.
- **`browser-harness.ts`:** `launch`, `sharedBrowser` and `launchEngine` launch the engine under test. The group-gone assertion is kept.
- **`cli-harness.ts`:** a leftover now fails by name where it used to be silently signalled. `startAppServerFixture` asserts the ownership report has no problems. Off Chromium, `startRun` uses a config for the engine under test.
- **`m2-guarantees.test.ts:138`:** `signalGroup` is replaced by ownership `capture`/`groupFor`/`signalReport` with two asserts. Identity refusals are not asserted.
- **`m2-state.test.ts:64-65,159`:** both targets come from the engine; same build off Chromium (C-21).
- **`browser-lifecycle.test.ts`:** one test added (main process killed from outside) and a bounded first-output wait. These are strengthenings.
- **`cross-platform-service`, `electron-web-flow`, `native-diagnostics-wired`:** teardown now uses `endService`, which fails by name; it used to kill without asserting.
- **`reference-flow.test.ts`:** teardown goes through ownership. A service that stopped on SIGTERM skips the check of its group's other members.
- **`evaluation-ai-sdk.test.ts`:** the live gate is split per provider, each skipped by its own key. New asserts cover judge, provider and model, screenshot evidence, and the key absent from stdout and stderr. One provider can now pass while the other is skipped.

**Unit:**
- **`cli-help`:** the command list now includes `install`.
- **`protocol-identity`:** `firefox` and `webkit` are now valid capture sources.
- **`runner-target-drivers`:** the Firefox and WebKit refusal tests are replaced by missing-build tests; the browser-share expectation changed (C-20).
- **`runner-command-lanes`:** the observed class becomes `check_failed`, with the child's `usage` in `details.also`.
- **`runner-native-wiring`:** `browserStorage` is now required.
- **`media-capture`:** `equal` becomes `deepEqual` plus `notEqual` (frozen copies). An aborted-before-start signal now starts nothing.
- **Native suites (actionability, assertions, locators, input, keyboard-alerts, desktop-lock, executors, ios-simulator, processes):**
  - Predicates now carry the label, and macOS lookups are scoped to the window.
  - The iOS placeholder no longer passes `toHaveValue('')`.
  - A secure field with no read-back now fails, with the input recorded as sent.
  - Process identities carry start times.
  - One policy change: the temporary output is deleted while a changed descendant still runs.
  - All of these are strengthenings except that policy change.

## What I confirmed by running it
- `node --conditions=retest-source --test tests/unit/playwright-subset.test.ts tests/unit/playwright-compare.test.ts tests/unit/playwright-compat.test.ts`: 35 of 36 pass. The one failure is `tests/unit/playwright-compat.test.ts:71`: observe commands now carry `check: true`, from the runner fix lane's uncommitted edit to `src/protocol/commands.ts`. That lane's change, not a finding here.
- The node:test after-hook behaviour (C-11), with a throwaway test under `/tmp/retest-review-c/`.
- `openssl dgst -sha512` on the three packed tarballs: all match the pinned integrity values.
- `diff` of `/tmp/retest-pwcompat-logs/run-5/playwright.md` against `docs/compatibility/playwright.md`: identical, so the table was generated, not hand-written.
- `diff` of `/tmp/retest-webkit-conformance-5-table.md` against `docs/compatibility/conformance.md`: identical below the header, with the same "Generated" line.
- Read the run logs: `retest-conformance-run-4.log`, `retest-webkit-conformance-5.log`, `compare-1.log` to `compare-5.log`, and the run-1 and run-3 `result.json` files (status error, exit 2, `cleanup_failed`).
- The corpus spec files match run-5's copy byte for byte.
- No heavy run. The Firefox lane is still running `tests/conformance/run.ts`, and every finding is visible in code or existing logs.

## What I could not verify, most important first
1. How Firefox and WebKit behave on the facts conformance drops: double dispatch, server counts, order.
2. Whether any declared outcome changed during the lanes' work. The files are untracked, so there is no history.
3. Whether the comparison's setup really matches: Retest's default viewport against Playwright's 1280×720 is not recorded.
4. The full suites, Linux, and whether the harness-fix tests fail on the old code.
