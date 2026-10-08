# Engine differences lane state

## Independent review: current result

Logs: `/tmp/retest-engine-differences-review/`. Report: [engine-differences-report.md](engine-differences-report.md). The review of all 23 declarations is complete. No case was skipped or given alternative outcomes. Chrome has no declarations.

- **Mechanism:** four demonstrated gaps are fixed: conformance skip/absent/regex outcomes; nonexistent cases hidden by filtered runs; caught stale comparisons; and intentional Chrome failures redeclared as engine differences. Each failed first. Final unit: 21/21, no skips (`unit-baseline-after.log`); seven scratch bypass mutations each exit 1 (`mutations-final-4.log`). A7's message substitutes only its failing event's exact count. Four real declarations pass and twenty record mutations fail (`record-audit-final.log`, 3/3).
- **Driver findings:** Firefox's false pixel-ratio refusal is fixed after the new shared desktop case failed first (80/81 actions in `pixel-before.log`). Raw Firefox accepts and reports 2.625. The phone refusal still asserts touch/mobile `unsupported` exactly. Firefox's blanket native-table row refusal is a defect left open: raw Firefox and Chrome both return 7 rows on the original team fixture; the later named Grace Hopper cell really differs. Probe reproduction and actionable limitations are in the report, proof and guide.
- **Shared suites complete:** rounds 9 and 10 are consecutive green rounds on Chrome, Firefox and WebKit, each actions 81/81, locators 26/26, navigation 33/33 and secrets 24/24: 164/164 per engine, no skips. All 13 Firefox and 6 WebKit declarations apply; Chrome 0. Logs `round9/`, `round10/`; counts `round9-10-counts.json`. The later conformance-only guard does not alter this comparison or these declarations.
- **Conformance:** rounds 8 and 9 are consecutive green rounds, each 148/148 cases, 15/15 groups and 164/164 Node checks per engine (492/492 overall), with zero skips. Counts: `conformance8-9-counts.json`. Round 5's WebKit A11 timing bound failed at 751 ms; round 7's WebKit F7.3 timed out selecting Free at 1500 ms. Neither was declared or loosened. S7, S11, N5, F10.5 and L7 passed rounds 5–9 and remain undeclared.
- **Other shared-suite failures preserved:** round 2 Firefox browser-loss cleanup refused unverified process-group ownership; the fixture is now opened before its browser so fixture cleanup runs first while retaining the failure. The hung test child was recorded, rechecked and stopped. Round 8 Firefox's hidden checkbox label was clicked once but its checked state could not be read; this remains an undeclared intermittent result. Rounds 3/4 and first conformance/flow preflights hit missing helpers while another lane edited process ownership. Rounds 5/6 were deferred by an overly broad benchmark-text guard. No benchmark was confirmed from that text-only evidence; the guard now identifies executable/script and records candidates.
- **Native flow:** the real positive and broken-sync variants are green on Chrome and Firefox (four Node checks); WebKit's positive and broken inner flows also end as required; both outer checks fail on the stale `webkit-2359` expectation versus the exact recorded build `2359`. The failing-first correction now requires `webKitPin.revision`. Its WebKit broken-sync check passes; the positive run fails setup while opening the desk page, before any action/assertion, with "The app is no longer running: it ended without the session terminating it, and may have crashed." Cleanup checks pass. A fresh isolated positive case is queued; neither failure is declared or softened. Both Chrome/Firefox broken variants fail exactly at the desk state check. The test's request log, simulator cleanup and Chrome process checks were strengthened. The first attempt stopped at runner import. A mutable scratch scheduling wrapper later returned without executing the native command; its exit 0 is not a flow result. Fresh immutable `flow-only.sh flow4` finished after conformance 9, under the same heavy-gate lock. Any window-coverage refusal is recorded without a workaround. Firefox uses Launch Services on this host.
- **Locked checks3:** `npm run test:types` passes both compilers, 241 expected errors and 241 markers in 10 projects each. `npm run typecheck` fails only in other lanes' files, with no lane error. The full unit gate ended with 3867/3873 passing, 6 failures and no skips. Five ordinary failures are in other lanes' early-wait/evaluation/native-actionability tests. The sixth is `wait-before-read.test.ts`: its only remaining child made no progress; its ancestry, start time and full command were recorded and rechecked, then that child alone received SIGTERM. Logs `checks3/unit-hang-{processes,termination}.log`. Both parent and child exited. Checks4 type tests pass, typecheck still names only other-lane files, and full unit completes at 3874/3877 with three other-lane failures and zero skips; early waits and the formerly hung test pass. After the corrected WebKit run, type tests pass on both compilers; typecheck still has only other-lane errors, now including `tests/unit/evaluation-frames.test.ts:672`. The fresh positive run and its compiler/type checks are queued.

No browser, simulator or native app has been started outside the lock. No benchmark, download, commit, stash, reset or revert was run. Earlier gates remain recorded in the report rather than counted as the required consecutive green pair.

## Previous handover, retained as history

The paragraphs below describe the earlier stop, not the current code or current gate status.

The lane was stopped by the coordinator at a clean point. Every file it touched is whole, and a scoped typecheck of them passes (`/tmp/retest-engine-differences/scoped-tsc-7.log`, exit 0). No shared suite case is half converted. Nothing it started is running: the last conformance round was interrupted and its runs ended (see Gates). Nothing was committed.

## The expectation mechanism

- `tests/integration/engine-expectations.ts` is the mechanism.
  - Types: `SuiteDifference` (engine, suite, case title path, reason, proof item, observed value) and `ConformanceDifference` (engine, case id, reason, proof item, a conformance `Declared` outcome and `Fact[]`). The engine is typed `'firefox' | 'webkit'`, so Chrome cannot be declared.
  - `engineExpectations(suite)` is called once at the top of each shared suite. Its `assertOutcome(t, observed, chrome, values?)` compares by deep strict equality with Chrome's outcome. When a declaration names this engine and `t.fullName`, it compares with the declared outcome instead, exactly.
  - Words in braces such as `{origin}` are filled from `values`. A missing value fails by name.
  - The engine giving Chrome's outcome fails, saying to remove the declaration. A declaration equal to Chrome's outcome fails.
  - Each case asserts once.
  - A root `after` hook fails the suite in three cases: a declaration is unsound (Chrome, a reason that is not one sentence, a proof item that does not exist, a duplicate); or any declaration of the suite, for any engine, names a case that did not reach `assertOutcome` in this run. This is checked on every engine, since the cases are shared. In a run narrowed by `--test-name-pattern`, `--test-skip-pattern` or `--test-only`, the hook reports the unchecked declarations as a diagnostic instead of passing them.
  - A proof item is `{ item, title }`: a numbered `N. **title**` line under `## Engine differences` in `proofs/firefox-driver.md` or `proofs/webkit-driver.md`.
- `tests/integration/engine-differences.ts` holds the declarations: 13 Firefox and 6 WebKit suite cases, 3 Firefox and 1 WebKit conformance cases.
- Conformance (`tests/conformance/execute.ts`):
  - `runEngine` refuses to judge if a conformance declaration is unsound or names no test case (`conformanceProblems`).
  - `testCaseReport` and `withPremises` use `conformanceExpectation(engine, case)`, the declared outcome and facts on that engine.
  - A declared engine that ends a case as the case's own outcome is told the declaration no longer holds.
  - `report.ts` marks such cells **declared** and adds a "Declared differences" table.
- Unit test `tests/unit/engine-expectations.test.ts`, 15 of 15 (`/tmp/retest-engine-differences/unit-5.log`). It proves:
  - exact holding;
  - a stale declaration fails;
  - Chrome has none;
  - a declaration naming no case fails, run end to end through `tests/unit/engine-expectations-suite.ts` as a child test process on WebKit and on Chrome;
  - the narrowed-run diagnostic;
  - proof items and one-sentence reasons;
  - that the repository's own declarations are sound.
- Mutations of a scratch copy each fail it: no existence check, lookup for any engine, either-outcome comparison (`/tmp/retest-engine-differences/mutation-{existence,any-engine,either}.log`).

## Cases converted, and the verdict on each

All 19 shared-suite cases and 4 conformance cases are converted and declared. Each is judged a true refusal or engine difference, not a driver defect. The "Evidence" column lists only what this lane read or ran.

| Engine | Case | Verdict | Evidence |
| --- | --- | --- | --- |
| Firefox | actions › fill stops the typing… › Release checklist: `event: 'keydown'` | difference (BiDi has no text insertion) | round0 log; driver types key by key |
| Firefox | actions › a character is typed… › the page hears each key…: Shift keys heard | difference | round0 |
| Firefox | actions › each editing key › Home then X: `abcdX` | difference (macOS key bindings; Shift+Home still selects) | round0; Shift+Home passes |
| Firefox | actions › select multiple: all three choices refused `unsupported`, `inputSent: false`, shown stays `cheese` | refusal | round0 |
| Firefox | actions › wheel on the terms: Accept `disabled`, click refused, terms moved | difference | round0; probe1: 108 px in 5 of 5 tries, one wheel event |
| Firefox / WebKit | actions › scroll delta on a phone page: phone page refused at open | refusal | round0 |
| Firefox | locators › img Logo: refused (`<img alt="Logo" src="data:,">` did not load) | refusal | round0; fixture markup |
| Firefox | navigation › refused connection message and details: `connectionFailure` (from `about:neterror?e=`) | difference | round0; `navigation.ts:204` |
| WebKit | same two cases: "Could not connect to the server." | difference | round0; WebKit proof 1 |
| Firefox / WebKit | navigation › title, goto and navigation: ESC kept | difference | round0 |
| WebKit | navigation › goBack onto no content: next goBack fails again, page stays on `/flip?for=forward` | difference | round0; WebKit proof 3 |
| Firefox | secrets › navigation cancelled: 0 posts in 5 s | difference (`typeof navigation` is `"undefined"`) | round0; probe1 |
| Firefox | secrets › the text reached one request: 0 | difference | round0; probe1: 0 of 20 |
| Firefox | conformance A5: `error unsupported at select`, exact message, `inputSent false`, at once | refusal | the Firefox lane's kept run `pass2-b` |
| Firefox | conformance A7: `failed check_failed at toBeEnabled`, deadline 1500 ms | difference | `pass2-b` |
| Firefox | conformance F8.1a: `error unsupported at toHaveText` on `getByRole('row')` | refusal, broader than needed (it reads only that a native table is on the page) | `pass2-b`; `accessible-names.ts:158` |
| WebKit | conformance F8.1a: `error unsupported at toBeVisible` on a cell named by text | refusal | the WebKit lane's kept run `conformance-keep-3` |

- No driver fix was made.
- The conformance declarations are not yet verified on a run of this lane: their values come from the driver lanes' kept runs.
- Cases S7, S11, N5, F10.5 and L7 were left undeclared, as the brief says.

## Shared suites restructured

A few cases were restructured so that the case can be compared once:

- the select-multiple case;
- the wheel case;
- the phone case (`scrollSixty`);
- the goBack history tail;
- the img subtests.

Two of them assert more precisely on Chrome now, and nothing less than before:

- the select-multiple case checks the full result of the third select, `changed: true`;
- the wheel case checks the full result of the Accept click, and that the terms moved.

Local helpers were added: `lastLook` (actions and navigation suites) and `postsWithin` (secrets suite). `browser-harness.ts` was not touched.

## Docs

- `proofs/firefox-driver.md` has a new `## Engine differences` section with items 1 to 11, which the declarations cite. Its "Gate record" paragraph still gives the old counts.
- `proofs/webkit-driver.md` has two changes:
  - the introduction to its differences now names the declared items;
  - item 3 now describes the exact goBack outcome.
- `docs/guide.md`, Firefox section:
  - the `keydown` detail of a stopped fill;
  - the multiple select refused for one option too;
  - Home gives `abcdX`;
  - scroll in steps;
  - the cancelled request stated as definite;
  - the table and image refusals spelled out.
- `docs/guide.md`, WebKit section: the history bullet says to use `goto`.
- `docs/compatibility/conformance.md` is not regenerated. It is not this lane's file.

## Gates

Logs are under `/tmp/retest-engine-differences/`. Every browser run went through `lockf -t 0 /tmp/retest-heavy-gate.lock`, using `.retest/scratch-engine-differences/locked.sh` with a 60 s retry, with no benchmark running.

- round0, before any declaration, all four suites: Chrome 80, 26, 33 and 24 of each, all passed; Firefox 71/80, 24/26, 28/33, 19/24; WebKit 79/80, 26/26, 27/33, 24/24.
- probe1 (`probe-firefox.log`): three Firefox probes, 3 of 3 passed.
- round1, the declarations in place: all 12 suite runs passed. Chrome 80/80, 26/26, 33/33, 24/24; Firefox 80/80, 26/26, 33/33, 24/24; WebKit 80/80, 26/26, 33/33, 24/24. Every declaration was applied: 13 Firefox, 6 WebKit and 0 Chrome "ends this case as declared" diagnostics.
- round1 conformance was started and interrupted at the stop, so it has no result. Its test processes were ended first, then its runs. No Chrome, Firefox or WebKit of the lane is left.
- Needed and not run:
  - a second suite round;
  - two conformance rounds on all three engines;
  - `npm run typecheck` under the lock;
  - `npm run test:unit`.
- Not under the lock, by mistake: one unscoped run of `node_modules/typescript/bin/tsc -p tsconfig.json`, early on.
- `npm run test:types` failed only on `src/runner/run-session.ts`, another worker's file, mid-edit.

## Per-engine flow

- `tests/integration/reference-flow-engines.test.ts` is written and passes the scoped typecheck. It has never been run.
  - It runs the passing and broken-sync variants for Chrome, Firefox and WebKit.
  - It checks `browser.started` engine, product, version and build against the pins: Firefox 133.0.3 build 20241209150345, WebKit `webkit-2359`.
  - It checks that the `test.started` session names the same engine, product and version.
  - It also checks that no browser process of the run is left.
- `.retest/scratch-engine-differences/flow.sh` runs it under the lock. Artifacts go to `~/Library/Caches/retest-proofs/artifacts/reference-flow-engines/`, as the base test's do.
- The fixture app builds exist. No simulator, TaskDesk or runner was running at the stop.

## Learned, not in the brief

- A nested `node --test` inherits `NODE_TEST_CONTEXT` and then runs nothing. The unit test strips it.
- `src/runner/run-session.ts` was briefly syntactically broken by another worker, and every CLI run then fails at load. `gates.sh`, `flow.sh` and `conformance.sh` check that it loads before a conformance or flow run.
- Another worker's long Chrome conformance chain (`scratch-fix-diagnostics-tests/gates-more.sh`) holds the lock for long stretches.
- The Firefox phone refusal also names "a pixel ratio of 2.625". Whether `browsingContext.setViewport` takes a pixel ratio on 133 is unverified.
- The WebKit guide's multiple-select bullet ("only when next to each other") is looser than the WebKit proof's item 5. Left unchanged.
