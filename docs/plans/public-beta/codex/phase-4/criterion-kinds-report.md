# Criterion kinds

Implementation is built. Evaluation units and the offline corpus are green. Corrected public type validation and Chrome integration remain unverified because another builder's failed native run retained the shared heavy gate. The first completed type gate failed on schema/type mismatches; its correction has not received a compiler result. The waiting queue was stopped after checking its exact command, pid and start time; it had no dispatched child. Final checks and process audit are recorded below. The work log that follows preserves intermediate results.

## Final validation

| Check | Result | Log or artifact |
| --- | --- | --- |
| Evaluation units on the final source | 295/295, zero skips, exit 0 | `/tmp/retest-criterion-kinds-unit-stable.log` |
| Offline corpus integration | 7/7, zero skips, exit 0 | `/tmp/retest-criterion-kinds-corpus-final.log` |
| Four retained corpus CLI matrices | 135 judgments each; perfect exit 0, other three exit 1 | `/tmp/retest-criterion-kinds-corpus/` and four corpus logs below |
| Initial completed public type gate | Exit 1; schema/type mismatches and one diagnostic marker mismatch | `/tmp/retest-criterion-kinds-types-queued.log` |
| Corrected public type gate | Did not start; foreign lock remained held | `/tmp/retest-criterion-kinds-types-fixed-queue.log` |
| Chrome evaluation integration | Did not start; foreign lock remained held | No Chrome log exists from this lane |
| Whole-tree source typecheck | Not run | Command listed below |
| Scoped whitespace check | Exit 0 | `git diff --check` over the assigned paths |
| Owned-process audit | 33 recorded identity entries checked, none still owned and running | `/tmp/retest-criterion-kinds-process-audit.json` |

The founder chose explicit `state`, `seen` and `never` criteria. The existing missing-frame settlement remains strict: no pass over partial frames, a required appearance not witnessed stays inconclusive, and a forbidden appearance fails only with a citation to a frame actually sent. A complete capture can support an explicit `never` pass. Existing snapshot syntax and the older absence marker remain accepted; their existing restrictions stay intact.

The new shape is `{ requirement: { saved: { kind: 'state', requirement: 'The message says Saved.' } }, evidence: { recording: { step: 'save' } } }`. Kinds travel through the protocol, judge request, criterion record and criteria hash. Settlement reads the declared criterion and capture facts, never the judge's justification.

| Kind | Complete capture | Partial capture | No usable frames |
| --- | --- | --- | --- |
| `state` | Judge the last frame held; pass, fail or inconclusive | Inconclusive for pass or fail, with the missing-frame reason | Inconclusive, no judge call |
| `seen` | Pass only with a seen-frame citation; otherwise inconclusive, never fail | Inconclusive, including a witnessed pass, under the existing missing-frame rule | Inconclusive, no judge call |
| `never` | Fail with a seen-frame citation, pass when the judge finds the complete interval satisfies the criterion, otherwise inconclusive | Fail with a seen-frame citation; otherwise inconclusive | Inconclusive, no judge call |

Built label changes: `frames-toast-wrong` and `frames-injection` become `seen` and inconclusive; `frames-spinner-early` becomes `seen` and remains inconclusive. `shot-chrome-saving` becomes an explicit `state` snapshot and an unambiguous failure. Every corpus requirement receives its kind. Captures and requirement wording stay intact.

No benchmark, download, commit, stash, reset, revert or publication is authorized. Other builders own the rest of the shared tree. Heavy commands use `lockf -t 0 /tmp/retest-heavy-gate.lock`, with one command queued at a time. Before every test this lane checks for `benchmarks/run.ts`.

Unverified at this point: the new API, settlement matrix, corpus, Chrome integration and type fixtures. Live model accuracy, native frames and other browser behavior are outside this validation.

Command: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`. Exit 1. Log: `/tmp/retest-criterion-kinds-unit-first.log`. Process identities: `/tmp/retest-criterion-kinds-unit-first.log.owner.json`.

The first evaluation unit gate ran 290 tests: 289 passed, one failed, zero skips. All 33 added kind checks passed. The sole failure was the existing AI SDK frame-message exact string, which lacked the new explicit partial-capture sentence; the expectation now includes that sentence without removing any prior text assertion.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-first.log`. Process identities: `/tmp/retest-criterion-kinds-types-first.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-retry.log`. Process identities: `/tmp/retest-criterion-kinds-types-retry.log.owner.json`. The lock was busy; no gate started.

Command: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`. Exit 0. Log: `/tmp/retest-criterion-kinds-unit-fixed.log`. Process identities: `/tmp/retest-criterion-kinds-unit-fixed.log.owner.json`.

Evaluation units now pass 292/292 with zero skips, `/tmp/retest-criterion-kinds-unit-fixed.log`. This includes the 27 combinations of three kinds, three capture states and three judge answers, four unsupported-witness cases, kind/hash preservation and typed host validation. The sole heavy queue is `node /tmp/retest-criterion-kinds-queue.mjs /tmp/retest-criterion-kinds-types-queued.log npm run test:types`; queue output is `/tmp/retest-criterion-kinds-types-queue.log`. It waits between busy-lock attempts and rechecks the benchmark guard before starting.

Command: `node --conditions=retest-source --test --test-concurrency=1 tests/integration/evaluation-corpus.test.ts`. Exit 0. Log: `/tmp/retest-criterion-kinds-corpus-integration.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-integration.log.owner.json`.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-queued.log.owner.json`. The lock was busy; no gate started.

Command: `node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge perfect --out /tmp/retest-criterion-kinds-corpus/perfect`. Exit 0. Log: `/tmp/retest-criterion-kinds-corpus-perfect.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-perfect.log.owner.json`.

Command: `node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge always-pass --out /tmp/retest-criterion-kinds-corpus/always-pass`. Exit 1. Log: `/tmp/retest-criterion-kinds-corpus-always-pass.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-always-pass.log.owner.json`.

Command: `node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge flip --out /tmp/retest-criterion-kinds-corpus/flip`. Exit 1. Log: `/tmp/retest-criterion-kinds-corpus-flip.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-flip.log.owner.json`.

Command: `node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge error --out /tmp/retest-criterion-kinds-corpus/error`. Exit 1. Log: `/tmp/retest-criterion-kinds-corpus-error.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-error.log.owner.json`.

The offline corpus integration passed 7/7 with zero skips in `/tmp/retest-criterion-kinds-corpus-integration.log`. The retained CLI matrices each contain all 45 cases over three repeats, 135 judgments. Perfect exits 0 with 135/135 matching labels, zero false passes or failures, and the conclusive gate 96/96. Always-pass, flip and error each exit 1 as required. Logs are `/tmp/retest-criterion-kinds-corpus-{perfect,always-pass,flip,error}.log`; retained `summary.json`, `judgments.jsonl` and frozen evidence are under `/tmp/retest-criterion-kinds-corpus/<judge>/`. There are 14 pass, 18 fail and 13 inconclusive labels, 31 critical cases and 32 unambiguous conclusive cases. The four founder-settled labels are reviewed; 41 remain awaiting review, so the perfect gate remains provisional. This is scripted runner and scoring proof, not model accuracy.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-queued.log.owner.json`. The lock was busy; no gate started.

Command: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`. Exit 0. Log: `/tmp/retest-criterion-kinds-unit-final.log`. Process identities: `/tmp/retest-criterion-kinds-unit-final.log.owner.json`.

The final evaluation unit command passed 295/295, zero skips, `/tmp/retest-criterion-kinds-unit-final.log`. Added mixed-kind tests preserve a state failure beside a seen inconclusive result and preserve a witnessed never failure beside a state capped by missing frames. Protocol regressions accept old calls and each new kind, reject unknown kinds and conflicting kind/absence fields. `EvaluateOptions` also rejects those conflicting fields statically.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 1. Log: `/tmp/retest-criterion-kinds-types-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-queued.log.owner.json`.

Command: `node --conditions=retest-source --test --test-concurrency=1 tests/integration/evaluation-corpus.test.ts`. Exit 0. Log: `/tmp/retest-criterion-kinds-corpus-final.log`. Process identities: `/tmp/retest-criterion-kinds-corpus-final.log.owner.json`.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed.log.owner.json`. The lock was busy; no gate started.

Command: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`. Exit 0. Log: `/tmp/retest-criterion-kinds-unit-exclusive.log`. Process identities: `/tmp/retest-criterion-kinds-unit-exclusive.log.owner.json`.

The first completed public type gate exited 1 in `/tmp/retest-criterion-kinds-types-queued.log`. Both compilers rejected two exact schema/type mismatches in the new exclusive criterion definitions, and the new unknown-kind marker expected a shorter error string than the compiler emitted. The correction makes the protocol criterion a mutually exclusive union and uses an impossible optional marker schema for the other field. `withCriterionRequirement` preserves that union while redacting and recording, so no cast, `any`, ignored error or wider type is used. The marker now matches the actual `CriterionKind | undefined` diagnostic. The single pending heavy queue is the corrected `npm run test:types`, `/tmp/retest-criterion-kinds-types-fixed-queue.log`.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

The exclusive-protocol correction passes the complete evaluation unit set again, 295/295 with zero skips, `/tmp/retest-criterion-kinds-unit-exclusive.log`. The protocol tests prove that no conflicting marker reaches settlement. The guide uses fresh anchored replacements only in the evaluation section. `git diff --check` over assigned source, fixture, test and document paths returned no whitespace findings. The public API is available structurally through the already exported `EvaluateOptions` and `EvaluationRequest`; optional named exports for `CriterionRequirement`, `CriterionKind` and `HostCriterion` would require edits to `src/index.ts` or `src/protocol/index.ts`, outside this lane. No new named package export is claimed.

Corpus CLI counts by fake, each over 135 judgments:

| Fake | Exit | Correct | False passes | False failures | Inconclusive | Errors | Conclusive gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| perfect | 0 | 135 | 0 | 0 | 39 | 0 | 96/96 |
| always-pass | 1 | 48 | 87 | 0 | 6 | 0 | 42/96 |
| flip | 1 | 92 | 29 | 11 | 31 | 0 | 64/96 |
| error | 1 | 0 | 0 | 0 | 0 | 135 | 0/96 |

The corpus integration was rerun after adding an explicit critical false-pass assertion for complete-capture `never`: 7/7, zero skips, `/tmp/retest-criterion-kinds-corpus-final.log`. A permissive fake may claim a never pass over complete capture, but the known forbidden-banner case still fails the critical scorer gate. No critical flag was removed.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

A read-only lock audit found PID 5128 holding `/tmp/retest-heavy-gate.lock` for another builder's `tests/integration/evidence-native.test.ts` run. Only process identities, executable names and matching test paths were inspected; no process was signalled. The corrected type gate remains the sole pending heavy command. Chrome integration has not started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

## Files changed by this lane

| Paths | Change |
| --- | --- |
| `src/api/evaluate.ts`, `src/protocol/evaluation.ts` | Add the explicit requirement kinds, mutually exclusive marker types, runtime validation, schemas, criterion records and host shapes. Existing string and absence syntax stays accepted. |
| `src/evaluation/judging.ts`, `attempt.ts`, `run-evaluations.ts` | Settle using declared criteria and capture facts; preserve effective verdicts, judge verdicts, citations, kinds and hashes, including checks that did not run. |
| `src/evaluation/contract.ts`, `instructions.ts`, `ai-sdk.ts`, `report.ts`, `frames.ts` | Type the request, name each kind's question, version the new frame instructions, send explicit capture status, display kinds and rules, and correct the gathering comment. |
| `fixtures/evaluation-corpus/cases.json`, `README.md`, `runner/cases.ts`, `runner/run.ts`, `runner/score.ts`, `judges/fake-judges.ts` | Declare every criterion kind, settle the four founder decisions, retain critical flags and capture files, share production settlement, score by kind and update fixed fake scripts and frame citations. |
| `tests/unit/evaluation-contract.test.ts`, `evaluation-evidence-api.test.ts`, `evaluation-frames.test.ts`, `evaluation-ai-sdk-frames.test.ts`, `evaluation-corpus-cases.test.ts`, `evaluation-corpus-score.test.ts` | API and protocol validation, every kind/capture/answer combination, witness checks, mixed-kind failures, kind/hash preservation, adapter message status and corpus scoring. |
| `tests/integration/evaluation.test.ts`, `evaluation-frames.test.ts`, `evaluation-corpus.test.ts` | Exercise state through CLI transport and inspect, all kinds on complete real-Chrome frames, and the strict revised corpus labels and critical false-pass gate. |
| New `tests/types/fixtures/evaluation-kinds/{checks.ts,retest.config.ts,tsconfig.json}` | A frames judge with all kinds; invalid kind, missing requirement, conflicting marker and wrong requirement type are expected compile errors. |
| `docs/guide.md` evaluation section, `docs/plans/public-beta/proofs/evaluation.md`, this report | Explain the three kinds, settlement, compatibility, exact gates and limits. |

The list covers this lane's edits only. Existing work in all files is preserved; whole-tree git diff statistics also include other builders and earlier work. No sibling repository was read or copied. No package, manifest, lockfile, release metadata, owner or remote changed.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

The lock holder's output is `.retest/secure-field-rule/logs/evidence-ios.log`. A read-only tail shows two failed native evidence checks and no completion summary; its process still owns the gate. This is another lane's result and is not attributed to the criterion changes. No native file or process was changed. The owning builder needs to finish or clean up that run before this lane's pending heavy gates can start.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Optional handovers outside this lane: `src/index.ts:3` can export `CriterionRequirement`, and `src/index.ts:107` plus `src/protocol/index.ts:43` can export `CriterionKind` and `HostCriterion` for callers wanting named aliases. Existing exported `EvaluateOptions`, `EvaluationRequest` and protocol record types already expose the new shape. `src/reporters/html/evaluations-view.ts:47` displays ids, requirement text, effective verdict, citations, judge verdict and the rule generically, but no criterion-kind column. Its owner can display `criterion.kind` beside the requirement. No field or rule is lost from the structured record, and this lane makes no claim that HTML displays the kind.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.

Command: `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`. Exit 75. Log: `/tmp/retest-criterion-kinds-types-fixed-queued.log`. Process identities: `/tmp/retest-criterion-kinds-types-fixed-queued.log.owner.json`. The lock was busy; no gate started.


## Validation that could not run

The corrected `npm run test:types` never acquired the shared lock. The attempted busy-lock results are retained in `/tmp/retest-criterion-kinds-types-fixed-queue.log`; the log `/tmp/retest-criterion-kinds-types-fixed-queued.log` contains only the lock refusal. The corrected exclusive-schema code passes runtime unit validation, but compilation is not established. Whole-tree `npm run typecheck` was not run in this lane.

No Chrome integration file started in this lane. Remaining commands, each after the benchmark guard and through the shared lock, are:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types
lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck
lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium node --conditions=retest-source --test --test-concurrency=1 tests/integration/evaluation.test.ts tests/integration/evaluation-handovers.test.ts tests/integration/evaluation-frames.test.ts
lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='Chrome:' tests/integration/evaluation-engines.test.ts
lockf -t 0 /tmp/retest-heavy-gate.lock env npm_config_offline=true RETEST_TEST_ENGINE=chromium node --conditions=retest-source --test --test-concurrency=1 tests/integration/evaluation-ai-sdk.test.ts
```

The SDK command must keep live provider keys absent and downloads disabled. The lane gate wrapper already enforces those settings. Missing cached SDK/provider packages can leave the existing installed-provider checks explicitly unverified. No real model call was made.

The foreign lock holder remained PID 5128, `evidence-native.test.ts`, with two failed checks in `.retest/secure-field-rule/logs/evidence-ios.log` and no completion summary. It was never signalled. Only this lane's waiting queue, PID 6516, was stopped with SIGTERM after exact command and start-time checks and after confirming it had no child. Identity record `/tmp/retest-criterion-kinds-stopped-queue.owner.json`; the queue's session ended 143. This stopped no test or browser.

Unverified, most important first: corrected public type compilation and new Chrome integration; whole-tree source typecheck; real judge accuracy, injection resistance and installed SDK frame transport; a full CLI recorded-step evaluation; native frames and new Firefox/WebKit behavior; older installed-reader refusal; the 41 corpus labels still awaiting founder review. No new platform claim follows from this lane's fake-judge or runtime unit results.

Command: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`. Exit 0. Log: `/tmp/retest-criterion-kinds-unit-stable.log`. Process identities: `/tmp/retest-criterion-kinds-unit-stable.log.owner.json`.


Final source check: `node --conditions=retest-source --test --test-concurrency=1 'tests/unit/evaluation-*.test.ts'`, exit 0, 295/295, 60 suites, zero failed, cancelled, skipped or todo, `/tmp/retest-criterion-kinds-unit-stable.log`. The final process audit checks this lane's recorded wrapper, child and stopped-queue identities by pid, start time and executable; 33 entries, none still owned and running. Audit `/tmp/retest-criterion-kinds-process-audit.json`. No command remains queued. No test, browser, native app or service remains running from this lane. The foreign native gate remains untouched.

No benchmark, download, commit, stash, reset, revert, push, publication or ownership change occurred. The guide, proof, report, structured records and corpus describe the three declared kinds without inferring a label from requirement wording. Validation is incomplete at the shared-gate boundary described above; this report does not claim the corrected types or new Chrome path are verified.
