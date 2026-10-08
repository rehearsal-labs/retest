# Lane report: artifacts-policy

Phase 4 item 5. Brief: `artifacts-policy.md`; signatures: `artifacts-policy-interface.md`; record: `docs/plans/public-beta/proofs/artifacts-policy.md`. Finished on 6 October 2026 by a second worker after the first was cut off by the Mac's restart without a state file.

## What was found

The first worker had written all of it: `src/store/artifacts.ts` (paths, portable references, safe reads with the swap checks, the listing, retention and its proposed events), `src/media/policy.ts` (per-app rules, field masking, withheld stretches, the overlap rule), `src/reporters/html/escape.ts`, four test files, the guide's "Artifacts" and "What may be captured as pixels" sections, and the record with its gate and "not shown" sections left as placeholders. Read in full against the brief and the interface note: nothing was half-written, and all 66 tests passed on the first run.

## What was changed

- `tests/unit/store-artifacts.test.ts`: the test of a purpose, format or container outside the list passed values widened to `unknown` and cast back, which the house rules forbid. It now calls `artifactPath` through `Reflect.apply`, as a JavaScript caller or a parsed record would, and also tries a thumbnail of a hostile purpose. Same assertions, one more case.
- `docs/plans/public-beta/proofs/artifacts-policy.md`: gate results, the "not shown" list, the test count (66), and a correction: the swap-race probe's logs were in `/tmp` and did not survive the restart; the probe was not run again.
- No change to `src/store/artifacts.ts`, `src/media/policy.ts` or `src/reporters/html/escape.ts`.

## Gates

No benchmark ran (`pgrep -f 'benchmarks/[r]un.ts'` before each gate). Logs under `.retest/artifacts-policy/` and `.retest/html-report/`, both gitignored, in the repository.

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| Lane unit files | `node --conditions=retest-source --test tests/unit/store-artifacts.test.ts tests/unit/store-retention.test.ts tests/unit/media-policy.test.ts tests/unit/reporters-html-escape.test.ts` | 66 of 66 (30, 11, 15, 10) | `.retest/artifacts-policy/unit-final.log` |
| Unit suite | `npm run test:unit` | 3799 of 3804; the 5 failures are in other lanes' files: `tests/unit/builds-lock.test.ts` 281, `tests/unit/evaluation-corpus-score.test.ts` 114, `tests/unit/evaluation-frames.test.ts` 491, `tests/unit/native-ios-simulator.test.ts` 299 and 342 (an earlier run, `test-unit-1.log`: 3591 of 3595, with 4 other failures in other lanes' files) | `.retest/html-report/test-unit-2.log` |
| Type markers | `npm run test:types` | 241 of 241 markers on 6.0.3 and 7.0.2 (an earlier run failed only on `src/evaluation/frames.ts:97`, since fixed by its lane) | `.retest/html-report/test-types-2.log` |
| Typecheck 6.0.3 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript/bin/tsc -p tsconfig.json` | 6 errors, none in this lane's files: `src/cli/inspect/test-timeline.ts`, `tests/integration/evaluation-frames.test.ts`, `tests/unit/evaluation-corpus-score.test.ts`, `tests/unit/inspect-looks.test.ts`, `tests/unit/runner-media-lifecycle.test.ts` (2), all other lanes' files mid-edit | `.retest/html-report/tsc6-3.log` |
| Typecheck 7.0.2 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript-7/bin/tsc -p tsconfig.json` | the same 6 and `tests/unit/runner-recording-fakes.ts`, none in this lane's files | `.retest/html-report/tsc7-3.log` |

`npm run typecheck` stops at the first compiler's errors, so each compiler was run on its own through the lock.

Breaks tried and restored at once (`.retest/html-report/mutate.mjs`): every hard-link check in `artifacts.ts` raised fails 5 tests; `scriptJson` left writing `<` and `>` fails 3.

## For other lanes

Unchanged from the record's "For other lanes", in short, for the recording-runner lane (`src/runner`, `src/protocol`, `src/store` but this file, `src/config`):

- `src/protocol/events.ts` and its schema: add `artifact.removed`, `artifact.removal_failed` (types `ArtifactRemovedRecord`, `ArtifactRemovalFailedRecord` in `src/store/artifacts.ts`) and `capture.withheld`, `capture.resumed`, `capture.masked_entry` (type `PixelPolicyRecord` in `src/media/policy.ts`). Write `artifact.removed` from `applyRetention`'s `removing` callback, before the unlink.
- `src/config/types.ts` and `validate.ts`: an app's `screenshots` and `recordings` rules with `appPixelRulesSchema`, filled by `appPixelRules`; a run's `recordings: 'all' | 'failures'` as `RetentionRules`.
- `src/runner/running-test.ts` (failure screenshot), the AI check screenshot path and the recording loop: call `PixelCapturePolicy.decide` before and after each capture; `beginSecretEntry` and `endSecretEntry` around the secret fill in `src/runner/secrets.ts`; `pageLeft` on a new document and at session end; restart a screencast after a stretch ends.
- `src/store/rebuild-result.ts`: leave a removed recording out of a test's evidence.
- When the recording events exist, `eventArtifactReferences` and `resultArtifactReferences` in `src/store/artifacts.ts` (this lane's file) must learn them, with `kind: 'recording'`, `attemptId`, and `of` on thumbnails; until then a recording is named by no record and the listing calls it unreferenced.
- Capture sources (`src/media/capture.ts`, drivers): a `withheld` count beside `dropped`; each driver reads the field fact before the first key and after the last.

## What could not be verified, most important first

1. No run uses these modules yet: no run writes the new paths, applies retention or the pixel policy, or records the proposed events. Everything rests on unit tests in temporary folders.
2. No real driver has fed the pixel policy: reading the field fact around a fill, and the overlap rule against a real screencast's timestamps, are untried.
3. The remaining swap race (a folder flipped several times within one read) is not closed and cannot be from Node; the first worker's probe found no hit, and its logs are gone.
4. Linux untried; the flags and error codes were exercised on macOS only.
5. Whether an older reader refuses folders holding the proposed events is reasoned from the schema, not run.
6. The macOS window-crop rule is reasoned, not shown on a real crop.

## Files changed

- `tests/unit/store-artifacts.test.ts` (this lane's own, uncommitted)
- `docs/plans/public-beta/proofs/artifacts-policy.md` (this lane's own)
- `docs/plans/public-beta/codex/phase-4/artifacts-policy-report.md` (new)

No dependency, script or environment change.
