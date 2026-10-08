# Report: console, network and visual evaluation on every engine

The lane of [build-engines-diagnostics.md](build-engines-diagnostics.md), Phase 3 item 7. The full record is [proofs/engines-diagnostics.md](../../proofs/engines-diagnostics.md).

## What was built

- `tests/integration/diagnostics-engines.test.ts` (new). The task app's diagnostics pages on Chrome, Firefox and WebKit, one test per engine per case, named with the engine first, every engine held to the same assertions. Through `retest run`: the fixture page in 12 separate subtests (pass, state and scope, each console level, every argument in a message's text, the other console types, every covered area's record, runtime error kinds, 404 and 500 against a refused connection, a fetch's metadata and duration, a two-hop redirect, a pending request, counts equal to the records); capture across navigations into another site and back and a reload; two apps at once; one pooled browser for two files, twice; a run stopped mid-capture; limits and `requireComplete`; secrets; a quiet page and capture turned off. Below the runner, through `AttemptDiagnostics`, on a browser launched by each engine's own driver: a capture on a closed page is unavailable; a browser gone mid-capture leaves a partial capture with the open request marked; an ended capture hears nothing and two contexts keep their own records. Engines come from `tests/integration/engines.ts`; Firefox and WebKit skip by name on a platform that cannot run them.
- `tests/unit/diagnostics-engines.test.ts` (new). Each of the three collectors fed its own engine's events through the parent's `SessionCapture`: optional fields left out stay out, those given are kept; an unreadable network or console event and a request past the collector's tracking limit make only their own kind partial; a lost connection makes both partial; a capture that cannot start, or answers late, is unavailable and keeps no listener; and a capture-level case per engine for each engine's own event names.
- `tests/integration/evaluation-engines.test.ts` (new). AI checks over each engine's own 800 by 600 screenshots through `retest run`: the fake judge's pass, fail and inconclusive; a pixel judge (written into the test's project, decoding the PNG with Retest's decoder) that passes the fixed page and fails the page with a magenta banner; a judge with `accepts: ['text']` asked for a screenshot, which errors and is never called. Same statuses, classes and verdicts on every engine; each record's identity, size, hash, run clock and capture source; the pixel judge handed the stored bytes, matched by hash, and the fake judge's captures matched by size in bytes and dimensions only.
- `tests/integration/evaluation-ai-sdk.test.ts` (edited). The combined Anthropic and OpenAI live gate became two tests, `live provider gate, Anthropic: …` and `live provider gate, OpenAI: …`, each needing only its own key from the environment and skipping by its name and variable otherwise; each asserts the pass, judge, provider, model, a model revision, the screenshot record and that its key is in no file or output. The Azure gate is unchanged.
- `src/diagnostics/session-capture.ts` (edited, added to this lane by the coordinator). `unreadable` and `limited` count an event as network when its name starts `network.` in any case (one helper, `isNetworkEvent`), so Firefox's `network.…` names count as Chrome's and WebKit's `Network.…` did. Nothing else in the file changed.
- `docs/plans/public-beta/proofs/engines-diagnostics.md` (new): coverage table per engine, findings, visual evaluation, live gates, commands, unverified.
- `docs/guide.md`, "Console and network diagnostics" only: the intro names the three engines and points at a new "Per engine" subsection (coverage per engine and every difference found); "Scope" says it describes Chrome; "Capture status" says "the browser" for an unreadable event.
- No change to `src/diagnostics/{attempt,policy,report}.ts` (the summary's scope already names the engine) or `src/evaluation/evidence.ts` (the capture source is named by `screenshotSource`, which another lane changed while this lane ran).

## Commands and results

Browsers and compilers ran under `lockf -t 0 /tmp/retest-heavy-gate.lock` through `.retest/scratch-diagnostics/locked.sh` (retries every sixty seconds). No real benchmark process was running at any check (`ps` for a node process running `benchmarks/run.ts`; `pgrep -f` also matched other agents' shells whose command lines hold that text). Logs under `/tmp`.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/integration/diagnostics-engines.test.ts` (all engines, last run) | 61 of 69. Chrome every case. Firefox 10 of 11 cases; the fixture case fails 5 of its 12 subtests: the getter ran (title changed), text without objects' content, worker message as `page`, rejection as `uncaught`, 3 runtime errors for 2. WebKit 10 of 11 cases; the fixture case fails 1 check: text holds only the first argument | `retest-final-diagnostics-engines-11.log` |
| the same, an earlier full run | 61 of 69, same failures | `retest-final-diagnostics-engines-7.log` |
| Firefox cases only, after the Firefox driver landed | same: 10 of 11 cases, 5 checks failing | `retest-diag-engines-int-firefox-10.log` |
| `node --conditions=retest-source --test tests/integration/evaluation-engines.test.ts` (last) | 3 of 3; sources `chromium`, `firefox`, `webkit`; defect colour 0 on the fixed page and 0.4989 on the broken page on each engine | `retest-final-evaluation-engines-11.log` |
| the same, before another lane named the capture sources | 3 of 3, Firefox and WebKit sources absent | `retest-final-evaluation-engines-7.log` |
| `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts`, before the `session-capture.ts` fix | 22 of 24, the two Firefox cases failing | `retest-diag-engines-unit-2.log` |
| capture-level case per engine, before the fix | 2 of 3, Firefox failing | `retest-capture-kind-before.log` |
| six diagnostics unit files after the fix | 78 of 79; `diagnostics-run.test.ts` failed to load on another lane's half-written `src/browser/webkit/target-session.ts` | `retest-capture-kind-after.log` |
| `npm run test:unit` after the fix | 3176 of 3196; no failure in a diagnostics file; all 20 in other lanes' files | `retest-diag-unit-all-12.log` |
| `npm run test:unit` before the fix | 3036 of 3040 (the two Firefox cases, two `playwright-resolve`) | `retest-diag-unit-all-1.log` |
| `npm run test:types` | 234 matched on 6.0.3 and 7.0.2 | `retest-diag-types-8.log` |
| `npm run typecheck`, early | exit 0, both compilers and the example | `retest-diag-typecheck-1.log` |
| `npm run typecheck`, last | exit 2: 3 errors, all in other lanes' files (`tests/conformance/engines.ts`, `tests/integration/webkit-roles.test.ts`); none in this lane's files, no `FATAL` | `retest-diag-typecheck-15.log` |
| `tsc -p tsconfig.json`, 6.0.3 and 7.0.2, before that | 9 and 10 errors, all in other lanes' files; none in this lane's | `retest-diag-typecheck6-13.log`, `retest-diag-typecheck7-13.log` |
| `tests/integration/diagnostics.test.ts`, `diagnostics-collector.test.ts`, `evaluation.test.ts` | 15 of 15, 6 of 6, 1 of 1 | `retest-final-diagnostics-7.log`, `retest-final-diagnostics-collector-7.log`, `retest-final-evaluation-7.log` |
| `--test-name-pattern="live provider gate" tests/integration/evaluation-ai-sdk.test.ts`, no keys | 3 skipped by name: Anthropic, OpenAI, Azure | `retest-eval-live-gates-skip-1.log` |
| `tests/integration/evaluation-ai-sdk.test.ts` whole, after the edit | 3 pass (without the SDK; the pinned SDK against the stand-ins; the proxy and default endpoints), 3 live gates skipped by name | `retest-final-evaluation-ai-sdk-14.log` (an earlier attempt could not pack on another lane's file: `retest-final-evaluation-ai-sdk-7.log`) |
| probe: Firefox fixture page with `capture: false` | passes, title unchanged | `retest-diag-probe-firefox-off-result.json` |
| probe: WebKit console message of four arguments | plain object preview has no `overflow` | `retest-diag-probe-webkit-args.log` |

Runs that died on other lanes' half-written files (`src/shared/process-ownership.ts` ReferenceError, `src/native/locators.ts` missing export) were waited out and run again: `retest-diag-engines-int-cw-3.log`, `-cw-4.log`, `-firefox-4.log` hold those failures.

## Coverage per engine

Condensed; the full table is in the record.

| Capture | Chrome | Firefox | WebKit |
| --- | --- | --- | --- |
| Fixture page capture | complete | complete | complete |
| Console covers (declared) | document, same-process frames, dedicated workers | same | document |
| Network covers (declared) | document, same-process frames | same | document |
| Console levels, other types, uncaught error with stack | passed | passed | passed |
| Every argument in a message's text | passed | failed | failed |
| Rejection kind, worker origin, browser messages out of runtime errors | passed | failed (all three) | passed (worker not claimed) |
| Capture leaves the page unchanged | passed | failed (getter ran) | passed |
| Request, response, 404/500 vs transport failure, redirect hops, durations, pending | passed | passed | passed |
| Message place / frame | 14 of 14 / 14 of 14 | 3 of 16 / 16 of 16 | 15 of 15 / 0 of 15 |
| Resource type / protocol / transferred size | all / all / all | none / all / all | all / none / 12 of 14 |
| Navigation into another site and back, reload | passed | passed | passed |
| Two contexts at once; pooled browser for two files | passed | passed | passed |
| Cancellation mid-capture; over the limits; `requireComplete` | passed | passed | passed |
| Secrets reach no file or report | passed | passed | passed |
| Closed page unavailable; browser gone partial; ended capture silent | passed | passed | passed |
| Unit: optional fields, unreadable events, tracking limit, loss, start failure | passed | passed after the fix (two failed before) | passed |
| Visual evaluation, same contract, pixel defect, image judge only | passed | passed | passed |
| Screenshot capture source | `chromium` | `firefox` | `webkit` |

## Driver findings

File, line and scenario for each are in the record's "Engine differences".

1. Firefox: capture runs a getter of an object the page logs (`log.entryAdded` subscription, `src/diagnostics/firefox-collector.ts:41`); the fixture page's title changes and its test fails; with capture off it passes.
2. Firefox: unreadable network events and requests past the tracking limit were counted under console. Fixed here in `src/diagnostics/session-capture.ts`.
3. Firefox: Firefox's own `javascript` messages (a CORS "Cross-Origin Request Blocked") become uncaught runtime errors (`firefox-collector.ts:185-198`); a strict `runtimeErrors` rule would count them.
4. Firefox: an unhandled rejection is recorded as `uncaught` (`firefox-collector.ts:191`).
5. Firefox: a dedicated worker's message carries `origin: 'page'` (`firefox-collector.ts:204`) while the scope claims dedicated workers.
6. Firefox: message text is Firefox's `entry.text`, objects as `[object Object]` (`firefox-collector.ts:205`); a place only for messages with a stack.
7. WebKit: a message keeps only its first argument when another is a plain object, because WebKit leaves `overflow` out of that preview (`src/diagnostics/console-text.ts:36`, `src/diagnostics/webkit-collector.ts:332-341`); not marked cut.
8. WebKit and Firefox scopes claim less than was captured (frames' records arrive; `webkit-collector.ts:32-37`, `firefox-collector.ts:28-39`).
9. Firefox and WebKit screenshots named no capture source; resolved by another lane while this lane ran.
10. Smaller gaps: WebKit drops `metrics.protocol` (`webkit-collector.ts:67`) and names no frame for messages; Firefox requests have no resource type.

No case depends on how WebKit labels the main document of a cross-process navigation; the WebKit change to that labelling moves no assertion here.

## What could not be verified

Most important first.

1. Firefox through its default spawn route: every Firefox run used Launch Services, since this host app may not read Firefox's data folder.
2. The live provider gates with a key: none was available; the Anthropic, OpenAI and Azure gates skipped by name, and the two new per-provider gates never ran with a key. Live judges over Firefox and WebKit screenshots are not wired.
3. The whole `npm run test:integration` suite: not run while other lanes were editing the runner, native, shared and WebKit code; only the six diagnostics and evaluation files ran.
4. The mechanism of finding 1 is read from the protocol (Firefox serializes console arguments for `log.entryAdded`), not traced to a property read.
5. A renderer crash on Firefox and WebKit, service and shared workers there, Linux, and capture overhead per engine: not exercised.

## Existing files changed

- `tests/integration/evaluation-ai-sdk.test.ts`: the live gates split per provider (the old combined title is gone; two new titles).
- `src/diagnostics/session-capture.ts`: the network classification in `unreadable` and `limited`, and the `isNetworkEvent` helper.
- `docs/guide.md`: the "Console and network diagnostics" section only.

New files: the three test files above and the record. Scratch files outside the repository's tracked tree: `.retest/scratch-diagnostics/` (lock wrapper, probes, a scoped tsconfig; `.retest/` is ignored). No dependency, script, `package.json` or environment change. No process of this lane is left running; the Firefox started at 07:31 under a temporary profile `retest-firefox-18626-…`, whose launching process is gone, belongs to another lane and was left alone.

## After the review

The review's thirteen findings (`reviews/phase-3-review-diagnostics.md`) were closed by this lane's fix round. Its report is `reviews/fix-reports/fix-diagnostics-tests-report.md`, and the record's "After the review" section gives the current results per engine. Two statements above were corrected:
- the fixture case had 12 subtests, not 13 checks;
- only the pixel judge is matched by hash; the fake judge's captures are matched by size in bytes and dimensions only.
