Changes needed in other lanes' files come first. This review edited no media, capture, runner, diagnostics, public index or guide file.

1. **Chrome reproduction and capture boundary:** `src/browser/capture.ts`, `ChromiumFrameSource.#frame`, line 186, sets every delivered frame's `earliestUs` to screencast start. `src/media/capture.ts`, `FrameSender.#withholds`, lines 860–862, correctly refuses a frame whose possible capture window overlaps a closed withheld stretch. The original newest-pending-frame check ran after suspension and resume without restarting the source. `/tmp/retest-frames-chrome-trace.log` records 13 delivered frames, eight sent and five withheld, including three post-resume deliveries with the old capture boundary. The query `[3938000, 5438000]` returned no frames and `storedThroughUs: 2869037`. This explains the failure; it is not evidence that the media store lost a fresh safe frame. Do not forward those frames to make the check pass. A caller that needs capture after resume must restart with a confirmed fresh boundary. The runner's `#policyRecord`, `src/runner/run-session.ts:1451`, already requests recorder resume. That full CLI path was not exercised here. The owned integration test now checks pending frames before suspension and retains the assertion.
2. **Default screenshot policy wiring:** `src/runner/run-session.ts`, constructor, line 399, creates `PixelCapturePolicy` only when an app records or explicit pixel rules exist; `#pagesContext`, line 1552, supplies `pixels` only when that policy exists. `#secretEntry`, lines 1472–1475, does nothing without it. The evaluation fix consults an available policy, so the default non-recording path still has no policy decision at capture. Supply the policy for secret-aware screenshot checks too, or refuse unsafe capture when no decision is available. This is a static call-path finding, not a newly reproduced real-secret capture; default secret screenshot protection remains unverified. No runner code was edited.
3. **Capture-gap visibility:** `media/src/jobs.rs`, `stretches`, lines 619–620, skips a short stretch before looking for its capture-gap reasons. The default threshold can therefore hide a known short pixel-policy gap. Return known capture gaps regardless of the quiet-stretch threshold. Evaluation queries now set `minGapUs: 1`; any unlisted stretches keep evidence partial. The failing-first short-gap test proves the evaluation mitigation, not a fix of the generic media API.
4. **Diagnostics wiring:** `src/runner/run-session.ts`, `#runRecorded`, line 1036, passes recordings but no diagnostics view to evaluation. `src/diagnostics/attempt.ts`, `AttemptDiagnostics`, line 64 onward, needs a read-only snapshot of the current bounded records and capture states, preserving their identity. Pass that view as `diagnostics` to the evaluation attempt. Until then a CLI check selecting diagnostics has unavailable evidence; the unit and corpus stand-ins do not establish CLI support.
5. **Named public types:** `src/index.ts:3` omits `TextRecordsEvidence`, `DiagnosticsFor`, `EvidenceItem` and `AbsenceRequirement` from the evaluation exports. Their structural use in `test.evaluate` is implemented, but consumers cannot import those names from the package root.
6. **Guide corrections:** `docs/guide.md:896`, `:922`, `:941` and `:942` still say absence is never asked and all frame failures stand. Describe the new settlement table below. At `:944`, distinguish the returned newest frame from a window that need not include it. At `:948`, recordings are now wired; diagnostics still lack a runner view. At `:1460`, evaluation screenshots now apply the available pixel policy. At `:1557`, the statement that runs never apply the pixel policy is obsolete. These sections are outside the ownership granted for this takeover.

## Review findings and fixes

The adversarial review covered frames, diagnostics, test API and protocol shapes, the corpus and scorer, all four fakes, and evaluation tests. The regressions below failed before their corresponding fixes; passing targeted runs are listed where completed. The corrected-label check is still included in the pending final unit gate. Each result is from Node's built-in test runner; successful unit self-tests alone are not claimed as lifecycle or platform proof.

| Finding | Fix | Failing-first and passing logs |
| --- | --- | --- |
| Missing or duplicate case/repeat results could shrink the scorer denominator and hide a failure. An entirely missing final repeat also escaped a helper that inferred repeats from answers. | Require and validate the full declared case/repeat matrix in both summary and gate helper. Reject duplicate case ids, unknown ids, invalid repeats and missing/duplicate results. | `/tmp/retest-frames-review-first.log`, `/tmp/retest-frames-review-fixed.log`; `/tmp/retest-frames-review-final-repeat-gap-first.log`, `/tmp/retest-frames-review-final-repeat-gap-fixed.log` |
| Callback credentials were learned after evidence had been frozen or saved, leaving text and diagnostics unredacted. | Prepare the judge before freezing evidence in both the attempt and corpus runner. Tests inspect the request, record and saved diagnostics. | `/tmp/retest-frames-review-first.log`, `/tmp/retest-frames-review-fixed.log`; `/tmp/retest-frames-review-corpus-first.log`, `/tmp/retest-frames-review-corpus-fixed.log` |
| Foreign diagnostics were restamped with the current attempt's identity. | Refuse a foreign snapshot or record before saving/sending. Corpus fixtures are explicitly rebound to the corpus attempt; source provenance stays in their artifacts. | `/tmp/retest-frames-review-first.log`, `/tmp/retest-frames-review-fixed.log` |
| Duplicate frame ids and unexplained omissions were accepted; stretch losses could be ignored when aggregate loss was zero. | Check unique ids, full frame/omission accounting and per-stretch losses. | `/tmp/retest-frames-review-counts-first-2.log`, `/tmp/retest-frames-review-counts-fixed.log` |
| A short reported capture gap disappeared below the default stretch threshold and let a scripted pass count. | Ask for every nonempty stretch with `minGapUs: 1`, and retain partial status if the bounded list omits stretches. | `/tmp/retest-frames-review-final-repeat-gap-first.log`, `/tmp/retest-frames-review-final-repeat-gap-fixed.log` |
| The corpus dispatched a judge after pre-dispatch cancellation. | Check cancellation before setup and again after setup/evidence, before dispatch. | `/tmp/retest-frames-review-corpus-first.log`, `/tmp/retest-frames-review-corpus-fixed.log` |
| The perfect fake read the labels it was being scored against, making agreement tautological. | Use a separate fixed answer script. A test changes a label and verifies that the fake's answer stays fixed. This still proves arithmetic only. | `/tmp/retest-frames-review-corpus-first.log`, `/tmp/retest-frames-review-corpus-fixed.log` |
| `frames-flash-absence` was inconclusive despite a seen forbidden error banner. | Correct the provisional label to fail and make the fake cite the actual seen banner frame. Founder review remains pending. | `/tmp/retest-frames-label-first.log`; final evaluation-unit gate |
| Evaluation screenshots ignored the run's pixel policy and could be saved and sent while withheld. | Ask before capture and again over the capture span before persistence, using the actual native capture source where applicable. Both refusals use no call budget, send no call and save no image. | `/tmp/retest-frames-review-pixels-first-valid.log`, `/tmp/retest-frames-review-pixels-fixed.log` |

The first screenshot regression used unreadable fake bytes and did not demonstrate the bypass. It was corrected to use a valid captured PNG before the failing-first run recorded above. The frame/omission tests exercise each mutation independently. Latency test data now supplies all declared repeats rather than relying on incomplete inputs.

Parent-owned failure precedence, atomic budgets, cancellation, provider/malformed-output/model/rate-limit errors and ignored late replies remain exercised by evaluation unit and CLI tests. The test process's claim cannot override a parent result. Judge credentials remain host-only; tests use synthetic credentials and inspect child, app, browser and run-folder boundaries. Pixel refusal withholds images; text redaction is not claimed to redact pixels. Application content remains judge data, never Retest instructions.

## Missing-frame decision

`settle` now asks absence criteria too, marked as written, so a seen violation can be judged. The parent applies these rules over an interval with missing frames:

| Criterion | Judge answer | Parent result |
| --- | --- | --- |
| Something must appear | pass | inconclusive |
| Something must appear | fail | inconclusive: missing frames may have held the appearance |
| Something must never appear | pass | inconclusive |
| Something must never appear | fail | fail only with a specific frame citation actually sent; otherwise inconclusive |

All four combinations and the unsupported absence failure passed in `/tmp/retest-frames-decision-fixed.log`, after four of those five tests failed in `/tmp/retest-frames-decision-first.log`. Complete sampled frames still cannot prove absence. A sequence citation or diagnostics citation alone cannot support an absence failure. Records retain the judge verdict and citations beside the parent's effective verdict and rule. The frame prompt version is `retest-judge-1+frames-2`, with `+diagnostics-1` when selected.

Only shown or superseded frames are sent. Pending/unprocessed frames are named as not sent; undecodable, out-of-range, omitted, lost and unstored frames keep the check missing or partial. No evidence refusal, empty interval or late reply can produce a required pass.

## What was built, by path

| Paths | Work |
| --- | --- |
| `src/api/evaluate.ts`; `src/protocol/evaluation.ts` | Recording step/window and diagnostics selectors, marked absence requirements, versioned structured evidence and criterion records. Current schemas retain run-folder schema version 1. |
| `src/evaluation/frames.ts`; `diagnostics-evidence.ts`; `evidence.ts` | Bounded gathering, identity and frame accounting, persisted hashes and exact sanitized diagnostics, missing-frame reasons, screenshot pixel-policy checks. |
| `src/evaluation/judging.ts`; `attempt.ts`; `instructions.ts`; `report.ts` | Shared request/settlement code, early credential setup, parent criterion rules and descriptions, frame prompt version 2. |
| `src/evaluation/contract.ts`; `ai-sdk.ts`; `answer.ts`; `budget.ts`; `judges.ts`; `run-evaluations.ts` | Retained predecessor frame layout, answer/citation validation, budgets and optional recording/diagnostics views. Reviewed and covered by the final evaluation-unit gate. |
| `fixtures/evaluation-corpus/cases.json`; `README.md` | 45 provisional labelled cases, rubric, source provenance, honest fake-judge scope and corrected absence label. |
| `fixtures/evaluation-corpus/runner/cases.ts`; `evidence.ts`; `frame-store.ts`; `run.ts`; `score.ts` | Fixed-capture reader and protocol-shaped store, production gathering/settlement, serial repeated calls, complete-matrix scorer and gate arithmetic. |
| `fixtures/evaluation-corpus/judges/fake-judges.ts`; `retest.config.ts` | Four offline judges and their named configuration; independent script for the perfect fake. |
| `fixtures/evaluation-corpus/capture/capture-browsers.ts`; `scenes.ts`; `captures/` | Retained predecessor fixture capture implementation and original screenshots, text, diagnostics, Chromium sequences and native provenance. Not rebuilt during takeover. |
| `scripts/run-evaluation-corpus.ts` | Retained predecessor CLI runner; not edited during takeover. |
| `tests/unit/evaluation-frames.test.ts`; `evaluation-corpus-score.test.ts`; `evaluation-corpus-cases.test.ts`; `evaluation-corpus-run.test.ts` | Failing-first regressions and revised decision expectations, complete repeat fixtures and independent fake/cancellation tests. |
| `tests/unit/evaluation-races.test.ts`; `evaluation-evidence-api.test.ts`; `evaluation-ai-sdk-frames.test.ts`; `evaluation-ai-sdk.test.ts`; `evaluation-runs.test.ts` | Retained predecessor coverage for races, public shapes, SDK frame layout and parent result behavior. |
| `tests/integration/evaluation-frames.test.ts`; `evaluation-corpus.test.ts` | Real-Chrome trace, preserved pending-frame assertion before suspension, teardown order, saved-frame identity/hash checks and offline script/gate checks. |
| `tests/integration/evaluation-ai-sdk.test.ts`; `tests/support/fake-evaluator.ts` | Retained predecessor named live skips and deterministic adapter modes; no SDK download or provider call here. |
| `docs/plans/public-beta/proofs/evaluation.md` | New proof section appended from the corrected draft; earlier sections preserved. |
| `docs/plans/public-beta/codex/phase-4/frames-evaluation-state.md`; `frames-evaluation-report.md` | Current handover and this completed report. |

Existing tracked lane files with changes in the shared tree are `src/api/evaluate.ts`, `src/protocol/evaluation.ts`, `src/evaluation/ai-sdk.ts`, `answer.ts`, `attempt.ts`, `budget.ts`, `contract.ts`, `evidence.ts`, `instructions.ts`, `judges.ts`, `report.ts`, `run-evaluations.ts`, `tests/unit/evaluation-ai-sdk.test.ts`, `evaluation-runs.test.ts`, `tests/integration/evaluation-ai-sdk.test.ts`, `tests/support/fake-evaluator.ts`, and `docs/plans/public-beta/proofs/evaluation.md`. This list includes retained predecessor work, not just edits made during takeover. New lane files are listed by path above.

## Corpus and founder review

Counts are 45 cases: 14 text, 20 screenshots and 11 frame sequences; 14 pass, 20 fail, 11 inconclusive; 31 critical and 33 unambiguous conclusive. Kinds overlap: 14 clear passes, 20 clear failures, seven plausible wrong texts, five clipped-content cases, ten incomplete-evidence cases, four injection cases and five missing-transient-event cases. All 45 labels await the founder.

Labels needing particular review:

- `frames-flash-absence`: changed from inconclusive to fail. The captured red error banner is a seen contradiction of “No error banner appears during the save.”
- `frames-toast-wrong` and `frames-injection`: labelled unambiguous fail for “A notification appears that says the task ... was saved.” Their seen notification has a wrong title or says save failed, but an existential appearance could still have occurred between sampled frames. Decide whether the requirement means this particular notification, or an appearance anywhere in the interval. The current wording and label may disagree.
- `frames-spinner-early`: inconclusive because the interval ends before the save answers and frames show “Saving…”. Its requirement says the message shows the saved title. Clarify snapshot versus interval meaning and apply that distinction consistently with the two frame cases above.
- `shot-chrome-saving` is a failure marked ambiguous, while `text-saving` is a failure marked unambiguous. Both show a saving state, but ask different requirements. Review the meaning of unambiguous and their inclusion in the conclusive denominator.

The native screenshot cases reuse healthy TaskPhone/TaskDesk captures with differing requirements; there are no native app-side controlled defects or native frame sequences. All frame cases use five Chromium scenes. This falls short of native defect and frame proof. The perfect fake is deliberately scripted by case id, not an image-reading judge, and its passing result says nothing about model accuracy or injection resistance.

The predecessor's browser capture command was:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source fixtures/evaluation-corpus/capture/capture-browsers.ts
```

Its log is `/tmp/retest-frames-capture-1.log`; `captures/capture-browsers.json` records browser builds and source commands. Native source commands and original artifact hashes are in `captures/native/sources.json`. The rebuild script replaces fixed capture folders. It was not rerun during this review, preserving the evidence the labels refer to. Viewing retained captures and validating their hashes does not establish a newly exercised native, Firefox or WebKit target.

A further credential path is under review: `src/evaluation/judges.ts`, `#credential`, line 184, reports a callback failure's error text before the callback has supplied its value to the redactor. A synthetic regression for both throws and rejected reads is queued in `/tmp/retest-frames-review-credential-reader-first.log` before the source fix. Only the owned queued final launcher was stopped, with identity recorded in `/tmp/retest-frames-final-launcher-stopped-for-review.json`; no final gate had started and no other process was signalled.

## Final gates pending

The requested final batch has not started because another lane holds the shared lock. It will be restarted after the credential-reader regression and fix as:

```sh
node /tmp/retest-frames-locked-gate.mjs /tmp/retest-frames-final-gates.log node /tmp/retest-frames-final-gates.mjs
```

The wrapper runs `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-frames-final-gates.mjs`, retrying a busy lock and refusing to start if the benchmark precheck cannot establish no benchmark is running. The batch runs evaluation units, corpus integration and four offline CLI judges, evaluation integration on real Chrome, Chrome screenshot checks, `npm run test:types`, `npm run typecheck`, then `npm run test:unit`, sequentially under the same lock. `/tmp/retest-frames-final-gates-result.json` will record exact commands, exits and log paths when they finish. It does not yet exist. One queued attempt stopped at the benchmark guard before starting any gate; the owned queued launcher was stopped to stage the newly found credential-reader regression; that targeted run now waits for the lock.

The named live gate command completed, exit 0, with three skips and no provider call:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_EVALUATION_ANTHROPIC_KEY -u RETEST_EVALUATION_OPENAI_KEY -u RETEST_EVALUATION_AZURE_KEY node --conditions=retest-source --test --test-name-pattern='live provider gate' tests/integration/evaluation-ai-sdk.test.ts
```

Log: `/tmp/retest-frames-live-skips.log`. The selected bodies installed no SDK.

## Unverified, most important first

- Default non-recording secret screenshot protection: the runner can supply no pixel policy, as recorded at the top.
- Final requested gates and the relocated newest-pending-frame assertion. These remain queued, not passed.
- Live judge accuracy, model behavior and injection resistance; no provider was called. All 45 labels still await founder review.
- Native app-side controlled defects and native frame sequences; neither is present in the corpus. Real native screenshot policy branches were not exercised during this review.
- A full CLI recorded-step frame check and the runner's resume boundary. The real frame harness supplies recordings and step spans directly. CLI diagnostics selection lacks its required snapshot view.
- Rebuilt browser/native corpus captures during takeover, installed provider SDK frame transport and an older installed run-folder reader.

This report remains open for the final gate results. No commit, download, benchmark or source change outside the granted evaluation lane was made.
