- High. [running-test.ts:536](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/running-test.ts:536) accepts duplicate evaluation ids. A forged process can start a screenshot check, then submit a text check with the same id. When the text check answers, it deletes the screenshot check’s hold, allowing an action while that check still runs. The supplied tests use distinct ids.

- Medium. [cli-harness.ts:222](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/integration/cli-harness.ts:222), inherited cleanup used by `command-lanes`, signals every remembered browser group even after that group exited. If its id is reused, cleanup can kill another process. It records no command line and performs no ownership check before signaling. I found no evidence that this happened in the recorded run.

- Medium. [browser/capture.ts:98](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/capture.ts:98) loses a waiting frame when start rejects. If two frames arrive during start, the first is delivered and the second waits for its cadence slot. `#release` clears its timer without delivering or counting it. Subsequent `stop` returns immediately. The second frame appears in none of `delivered`, `superseded` or `dropped`. No double-counting path was found.

- Medium. [media/capture.ts:264](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/capture.ts:264) hides a recording failure during failed-start cleanup. If capture start fails and finishing rejects because the media process died, spreading `finished` and then overwriting `status` and `reason` removes the media-loss explanation. The report preserves only the capture failure; the tests do not combine these failures.

- Medium. [media/capture.ts:237](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/capture.ts:237) starts work after cancellation. An already-aborted signal still starts the recording, then calls `source.start`. Aborting during the media start has the same result. Resolving `stopping` does not prevent that new capture command.

- Medium. [page.ts:347](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/page.ts:347) does not retain the whole owner. Changing only `owner.runId` in a second `identify` call succeeds. Empty owner strings also pass when the session id matches their concatenation. The integration test covers a different app, but neither case.

- Medium. [media/capture.ts:409](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/capture.ts:409) freezes only part of the report. `identity`, `capture`, `started` and `ended` remain shared mutable objects. A source that changes its returned stats later changes `report.capture`. Also, [page.ts:366](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/page.ts:366) exposes the page’s bound identity through the source, allowing its fields to be changed without `identify`.

- Low. [identity.md:158](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/identity.md:158) says every revert failed or hung, but [the failed-start mutation log:31](/tmp/retest-identity-probe/mutations/8-nothing-sent-after-a-failed-start.log:31) records 22 passes and zero failures. That mutation removes `sender.close()` from failed-start cleanup. The proof claim needs narrowing.

The fifteen fixes:

1. Confirmed as documentation. Frames carry the parent’s look id or none; native reference ids are explicitly excluded.
2. Confirmed. Contract, adapter, guide and proof describe missing paints and reject conclusions from capture gaps.
3. Not fully confirmed. Ordinary holds match the child’s rule, and the recorded forged Chrome test fails correctly; duplicate ids bypass them.
4. Confirmed for stop in flight. Frames remain offered, and integration compares the wire count with the exact sum. Failed-start accounting remains defective.
5. Confirmed. Source method throws and rejections are guarded; cleanup finishes the recording and removes the abort listener.
6. Confirmed. Chromium stats use capture start and stop; achieved cadence uses that span; default hold gap equals maximum recording length.
7. Confirmed. Future and pre-start timestamps are refused as `clock`; negative clock readings are not clamped.
8. Confirmed in code. Start gating, the 16-frame cap and named finish-wait refusal exist. The cap lacks a supplied regression test; one recorded mutation passes.
9. Not fully confirmed. Late deliveries change no tally, but other report objects remain mutable references.
10. Confirmed. Assertions naming an unavailable app cause a protocol violation before judging or emitting an assertion.
11. Not fully confirmed. Unnamed and foreign pages are unavailable, and different stored identities throw; full-owner binding and identity immutability are incomplete.
12. Confirmed. A refused action emits its own `action.failed`, and the parent retains its failure.
13. Confirmed from code and recorded compiler evidence. Public `RecordIdentity` retains its old shape; `SessionRecordIdentity` exports the new one.
14. Confirmed by inspection. Painting resumes before the after-close check; the stop fake never answers; restored-state absence is asserted. Changed expectations preserve existing failure checks.
15. Confirmed as recorded evidence. Chrome’s version, the ffprobe command and output, and the ended Chrome’s ancestry and profile ownership are documented.

A legitimate look on another app remains allowed because busy-command checks filter by app. Normal cancellation and source-ending paths stop capture and finish the recording; the caller owns closing the reusable media process. A rejected recording ending also triggers capture cleanup. Actual process-death cleanup was not exercised in this review, and the combined failure loses its explanation as noted above.

Ran exactly the four permitted unit files with `node --conditions=retest-source --test`: media capture 22, browser capture 13, command lanes 11, protocol identity 9. All 55 passed, with no skips. Output was captured and read from [the unit log](/tmp/retest-identity-review-unit.log). The benchmark search matched review/build prompts, not a benchmark process.

I did not run integration tests, capture tests, proofs, compilers or mutations. Integration and mutation conclusions use source inspection and existing logs. The new failure scenarios were traced, not executed. Historical process ownership cannot be independently reconstructed from the proof’s description. No repository files were edited.

Model: GPT-6.1 Sol; effort: xhigh.