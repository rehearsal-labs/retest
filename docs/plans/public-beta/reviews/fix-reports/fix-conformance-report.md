# Fix lane K report: conformance cases, Playwright comparison, test harness

## Findings, each with what changed and how it was shown to catch its fault

The judge probe is `/tmp/retest-fix-k/judge-probe.ts`. It re-judges the kept Chrome `web` and `workflow` records with one fault put in at a time, using the new export `judgeGroupRecord` (tests/conformance/execute.ts:180). Log: `/tmp/retest-fix-k/judge-probe.log`.

- **C-1:** I dropped the `toHaveCount(0)` row-by-name line and split F8.1. F8.1a reads the table by position and finds cells by name. F8.1b (fixtures/conformance/workflow/f08-lists.retest.ts:28) must end `error unsupported` at once, with the `namedRowProblem` message. No waiting mark is left. It ended as declared on all three engines. Probe: an unrefused row makes F8.1b differ.
- **C-2:** Every fact the Chromium workflow files check is now in the cases (tests/conformance/cases.ts, the workflow block): step finished failed, line and message (execute.ts:525), sign-up counts, pages opened, choices, fills, paths, saved and restored states, the cookie absent (R16, R17), and sent-nothing for F3.4b. The probe catches each fault: a sign-up sent twice (F6.2), Enter submitting twice (F9.1), F1.4 one line off or with another message, a state not restored (F3.3b and R16), a select set by script (F7.1).
- **C-3:** A case can now require another case (`requires`, execute.ts:445). The premise must end as declared and start first. Secret-absent facts require a fill of that secret, or a saved state (execute.ts:754). Probe: U1 failing makes U2 differ; no secret fill makes R10 differ.
- **C-4:** On macOS a missing Firefox or WebKit, or its driver, now fails the gate. `RETEST_CONFORMANCE_OPT_OUT=firefox,webkit` opts an engine out, and it is reported as "not verified" by name (tests/conformance/engines.ts:52). Chrome cannot be opted out. A driver refusal is no longer read as "not available", and the wrapper and `run.ts` were changed to match. Probe `/tmp/retest-fix-k/c4-probe.log`: a missing Firefox fails the gate, the opt-out excuses it, and naming chrome is refused.
- **C-5:**
  - T7 must record its own `timeoutMs` of 1500 and end within 1 s of it.
  - S4 polls a value that turns true after 200 ms (fixtures/conformance/web/assertions.retest.ts:56), with `polled toBe`.
  - A8 reads a new page counter (actionability.retest.ts:13). I did not add a duration floor: a disabled button hears no click, so one click heard proves the wait, and a floor would depend on when each engine reports the page loaded.
  - Probe: T7 on the run's 20 s budget, the poll looking once, and the counter at 2 each differ.
- **C-6:** `comparisonHolds` now needs `runProblems` to be empty: no run failure, no signal, and the same exit codes (scripts/compare-playwright.ts:228, 239). The wrapper asserts the same. I updated the unit-test fixture that asserted "holds" with exit 2. Mutation run: removing the check fails the new unit test (`/tmp/retest-fix-k/mutation-c6.log`).
- **C-7:**
  - The corpus is now typed against Playwright's own signatures (fixtures/playwright-compat/playwright-test.d.ts).
  - The five bare-string `selectOption` forms were added as declared gaps (fixtures/playwright-compat/tests/select-by-text.spec.ts).
  - The family 3 cases are counted as gaps. The table says "Declared gaps: 10 of 48". The unit test checks the variants.
- **C-8:** An intended failure is equivalent only when the normalised expected and received values agree (compare-playwright.ts:631, 815). Mutation run: `/tmp/retest-fix-k/mutation-c8.log`. All 11 intended failures agree on values in three runs.
- **C-9:** A deadline now allows no early slack and a late bound of max(250 ms, ms/4) (execute.ts:606, 704). Assertions need at least two looks, three for F10.4 and F10.5. Probe: S7 at 1460 ms, at 4400 ms and with one look each differ.
- **C-10:**
  - afterEach reads after a failure, with an `afterwards` fact: L6 (locators.retest.ts:66), A12 and A13 (actionability.retest.ts:31), A14 (actionability.retest.ts:49).
  - Messages for N5, S7 and S11, and the `covering` detail for A9.
  - `steps` facts for T1 and T2, and T2 pinned to line 26.
  - N6 has `navigations: []` and its message.
  - Probe: L6 reading "Buy milk", T1's steps reordered, T2 at line 12 and N5 with no address each differ.
- **C-11:** The harness teardown now writes leftovers and identity refusals through `t.diagnostic` and stderr before failing (tests/integration/cli-harness.ts:252). Stand-in `/tmp/retest-fix-k/c11/leftover.test.ts`: the leftover is now named next to the body's failure (`after.log`). With the two lines removed it is dropped (`before.log`).
- **C-12:** A run is bounded at 5 min and then has its group ended (execute.ts:54, process.ts:118). Leftovers are ended through the ownership record (process.ts:161). Stand-in `/tmp/retest-fix-k/c12-probe.log`: a run that ignores SIGINT is ended after the bound.
- **C-13:** The browser is ended only through the run's ownership record, by verifying it beneath the run and killing its main process with `killBrowserFromOutside` (process.ts:137). A Firefox started through Launch Services is ended only after a fresh start-time and command check, and its command must name the run's own temporary folder.
  - A first version that killed the recorded group children-first spread the loss over time. Chrome X4 and X6 then differed, so I changed it to end the main process alone.
  - X1 to X6 then ended as declared on all engines.
- **C-14:** On reuse, the three tarballs are re-hashed and `node_modules` is reinstalled offline from them (compare-playwright.ts:262, 323). Probe `/tmp/retest-fix-k/c14-probe.log`: a changed `node_modules` file was restored, and one added byte in a tarball fails the check.
- **C-15:** `--untracked-files=no` is dropped (compare-playwright.ts:477).
- **C-16:** The limit timer is cleared in `finally` (compare-playwright.ts:445).
- **C-17:** The record now says run-1 judged no case, run-2 to run-5 agree, and run-1 and run-3 ended `cleanup_failed`.
- **C-18:** `run.ts` now judges each engine in a test of its own, and all three verdicts showed separately in every run. I corrected docs/plans/public-beta/proofs/conformance.md. progress.md:160 is not my file and still says 144/111/133.
- **C-19:** `getByRole` in the Playwright adapter is now `<const Role>(role, options?: RoleOptionsFor<Role>)` (src/playwright/page.ts:39). Two new type markers are in tests/types/fixtures/playwright-finders.ts. Mutation run: reverting the signature leaves both markers unused (`/tmp/retest-fix-k/mutation-c19.log`).
- **C-20:** The changed expectation in the unit test is not a pooling change. src/runner/target-drivers.ts:42-43 now gives WebKit and Firefox a driver, so their attempts count in the share rule at src/runner/run-session.ts:532 (`ceil(browsers × attempts / total)`). In that test, 6 WebKit attempts out of 8 leave Chromium one browser of two.
  - Probe `/tmp/retest-fix-k/c20/probe.log`: two Chromium builds still get their own browsers (one each with browsers 2, two each with browsers 4), and Chromium alone gets both browsers.
  - Open policy point for the runner lane: a target whose build is missing still takes a share.
- **C-21:** `TestEngine.secondBuild` is now set to `distinct` for Chromium only (tests/integration/engines.ts). m2-state writes a diagnostic naming an engine with one build (tests/integration/m2-state.test.ts:67). I have not seen it on a real Firefox run: the run stopped at import while another lane was editing the Firefox driver.
- **Held item:** I brought the Playwright adapter rows of inventory.md up to date.
- **Also fixed in the harness:** `processesUsing` read `ps` with execFile's default buffer, which this machine's 4 MB process table overflows. It now uses a 256 MB buffer (tests/integration/browser-harness.ts:356).

## Conformance counts

| Engine | Before | After |
| --- | --- | --- |
| Chrome | 144 of 145 cases, 15 of 15 runs | 147 of 148 cases, 15 of 15 runs |
| Firefox | 141 of 145, 15 of 15 | 146 of 148, 15 of 15 |
| WebKit | 144 of 145, 15 of 15 | 142 of 148, 15 of 15 |

The "after" numbers are from the second run, the last one that could judge every case.

## Driver findings per engine (engine, case, assertion, what the engine did)

- **Chrome:**
  - **N5:** `expect(page).toHaveURL('/lookup/history/two', { timeout: 300 })` gave up after 299.x ms, before its time. This is the early-timeout race, in src/browser/page.ts or src/assertions/look-until.ts (runner lane). In one later run S11 (`not.toHaveTitle`, 300 ms) did the same.
- **Firefox:**
  - **A7:** `getByTestId('terms').scroll({ y: 2000 })` leaves Accept disabled, so `toBeEnabled` failed after 1500 ms. The wheel delta is scaled in src/browser/firefox/page.ts before `wheelAt`.
  - **F8.1a:** `getByRole('cell', { name: 'Grace Hopper' })` is refused as `unsupported` ("Firefox's accessibility tree does not" name a cell), at src/browser/firefox/accessible-names.ts:79.
  - **Seen in one run on a loaded machine:**
    - A5 and F4.1: `select` was refused as `not_actionable` after typing.
    - U1: the save click was not heard.
    - F8.1a: `getByRole('row')` itself was refused ("native tables can be layout tables").
    - F9.3 and F9.4: Enter opened no page.
- **WebKit:**
  - **A11:** a click on a hidden element was refused after 499.x ms of its 500 ms, before its time (src/browser/webkit/page.ts).
  - **F7.1 to F7.4:** `getByLabel('Plan')`, `getByLabel('Product updates')` and `getByLabel('Weekly summary')` on /workflow/preferences are refused as `unsupported` ("a hidden <label>, whose text WebKit's accessibility tree still gives the control"). They passed in the "before" run of the same cases, so the WebKit lane's edits brought this in.
  - **F8.1a:** a cell by name is refused, as on Firefox.
  - **Seen in one run on a loaded machine:**
    - Gave up long past their time: L7 and S9 (2.2 s and 2.1 s of 1.5 s), A12 and A14 (0.93 s and 1.06 s of 0.5 s), S6 and S10 (0.58 s and 0.69 s of 0.3 s), T7 (3.0 s of 1.5 s).
    - Clicks not confirmed within 1.5 s: F2.4, F4.3, F5.2, F6.3.
    - A read timed out: F1.1.

## Gates

| Gate | Result | Log |
| --- | --- | --- |
| Playwright unit files | 42 of 44 | `/tmp/retest-fix-k/unit-playwright-2.log` |
| `npm run test:types` | my two markers matched; the run still failed on `src/evaluation/frames.ts:97` (another lane) | `/tmp/retest-fix-k/types-2.log` |
| `lockf … npm run typecheck` | exit 2, with no error in my files; errors are in fixtures/evaluation-corpus, src/evaluation/frames.ts, tests/integration/webkit-roles.test.ts and tests/unit/evaluation-frames.test.ts. The script stops after TypeScript 6 | `/tmp/retest-fix-k/typecheck-2.log` |
| Scoped typecheck of my files, earlier | exit 0 | `/tmp/retest-fix-k/tsc-scoped-3.log` |
| Scoped typecheck of my files, last | its only errors are in src/browser/firefox/page.ts and src/evaluation/frames.ts | `/tmp/retest-fix-k/tsc-scoped-5.log` |
| Conformance before / after | exit 1 both; counts as above | `/tmp/retest-fix-k/conformance-before.log`, `/tmp/retest-fix-k/conformance-after-2.log`, kept folders in `/tmp/retest-fix-k/after-keep-2/` |
| Comparison, 3 runs | exit 0 each: 38 of 44 equivalent, 6 gaps hold, 0 run problems, exit codes 1 and 1, identical case rows; the table was written by run 3 | `/tmp/retest-fix-k/pwcompare/compare-{1,2,3}.log` |
| playwright-compat-table wrapper | 1 of 1 passed | `/tmp/retest-fix-k/pwcompare/wrapper-2.log` |

Two notes on the gates:
- The 2 unit failures are in `playwright-resolve.test.ts`: the founder's `.tsx`/`.jsx` lookups. `playwright-compat.test.ts:71` now passes, with the runner lane's `check: true` change kept.
- Later conformance runs could not judge: one had a harness buffer problem (now fixed), and two could not launch browsers because about 1,250 hung `bash -c python3` processes of another session on the Gruvi repo filled the process table, so Retest's ownership reading overflowed. `docs/compatibility/conformance.md` is the second run's generated table, put back after the broken fifth run overwrote it.

## Incident

When I came back after the host restart, an import check I ran loaded `tests/conformance/run.ts` and started an unlocked conformance run. It ran for about 2.5 minutes. I stopped it and the run it had started, with SIGINT so the run closed its Firefox, and nothing of it is left.

## Not verified, most important first

1. A clean final conformance run on a quiet machine with the current files. The process table is still flooded by another session.
2. The m2-state single-build diagnostic on a real Firefox run.
3. `tests/integration/conformance.test.ts` itself. It runs the same `runEngine` as `run.ts`.
4. The WebKit F7 refusal and the loaded-machine timings need a quiet run to confirm.
5. Firefox through spawn, and Linux.

## Files changed

- **New:**
  - tests/types/fixtures/playwright-finders.ts
  - fixtures/playwright-compat/tests/select-by-text.spec.ts
- **Changed:**
  - tests/conformance/{cases,execute,process,engines,run,report}.ts
  - tests/integration/conformance.test.ts
  - fixtures/conformance/web/{actionability,locators,assertions}.retest.ts
  - fixtures/conformance/workflow/f08-lists.retest.ts
  - scripts/compare-playwright.ts
  - fixtures/playwright-compat/{cases.ts,playwright-test.d.ts}
  - src/playwright/{page,index}.ts
  - tests/unit/playwright-compare.test.ts
  - tests/integration/{playwright-compat-table.test.ts,cli-harness.ts,browser-harness.ts,m2-state.test.ts}
  - tests/integration/engines.ts (the `secondBuild` field)
  - docs/compatibility/{conformance,playwright}.md (generated)
  - docs/plans/public-beta/proofs/{conformance,playwright-compat}.md
  - docs/plans/public-beta/inventory.md (the adapter rows)
  - docs/guide.md (the Playwright section)
- **Task app, outside my files:** I added one counter to fixtures/task-app/lookup-routes.ts: the `later-clicks` span and its click listener on /lookup/states.
- No dependency, script or environment changes.
