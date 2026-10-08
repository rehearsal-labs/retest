# Lane report: html-report

Phase 4 item 7, with the report parts of items 5 and 9. Brief: `html-report.md`; record: `docs/plans/public-beta/proofs/html-report.md`. Finished on 6 October 2026 by a second worker after the first was cut off by the Mac's restart without a state file.

The `report` command's name, usage (`<run-folder>`) and help line (`Write an HTML report of a run folder`) are unchanged.

## What was found

The first worker had built the whole report (`src/reporters/html/`, 20 files), `src/cli/commands/report.ts`, the `html` reporter and its registration in `src/cli/commands/run.ts`, the command's entry in `src/cli/cli.ts`, four unit test files and their fixtures, the integration test, the guide section and the record. All 52 unit tests passed on the first run. Read in full against the brief, what was missing or wrong:

- The integration test had never passed and could not: it gave Retest's `goto` a `file://` address, which the driver refuses by design (`src/browser/navigation.ts`, `resolveTarget`, line 182, in place since the first runner commit).
- `markup.ts` held bidirectional control characters as literal invisible characters in its regular expression and a doc comment, and `reporters-html-safety.test.ts` held a literal U+202E twice: the trap the progress notes warn about.
- No test showed that secrets the events hold as `{{name}}` stay so in the report, or that a `</script>` in embedded JSON cannot end it (the report embedded no JSON).
- A picture was read whole only to check its first bytes.
- No light or dark screenshot, no sample report on disk.
- No recording view. While I worked, the recording-runner lane stopped at a clean point with its event shapes on disk (`src/protocol/recording.ts`, `recording.started`, `recording.finished`, `capture.*`, `artifact.removed`, `TestResult.recordings`, `evidenceStatus`). Without handling them, the report would have called a recorded test's evidence complete even when its result names a recording gap.

## What was built or changed

- `src/reporters/html/markup.ts`: the invisible characters written as `\uXXXX` escapes; `dataBlock(id, value)`, the one way run data reaches the inside of a `<script type="application/json">`, through `scriptJson`.
- `src/reporters/html/page.ts`: data blocks after the body. The policy still says `script-src 'none'`.
- `src/reporters/html/build-report.ts`: the outcome data block `retest-outcome`, version 1: run id, status, exit code, complete, counts, result source, and each test's id, name, variant, status, failure class and evidence state, all from the result and the evidence state the page shows.
- `src/reporters/html/artifact-files.ts`: pictures and videos checked with `checkArtifact`, opened with `open`, and only their first 24 bytes read from that descriptor; `video()` accepts MP4 (`ftyp`) or WebM (EBML) and refuses anything else as `not_a_video`.
- `src/reporters/html/recordings-view.ts` (new): each recording of a test: state, gaps, the video (`<video controls preload="metadata">`), source and mode, video facts, frames, withheld time; no video named where it would be, with a kept partial file; a video removed by rule said so. Open under a test that did not pass.
- `src/reporters/html/evidence-status.ts`: recordings count; each gap of a partial or unavailable recording, a video that cannot be shown, and any other gap in the run's own `evidenceStatus` is a reason; a video removed by the config's rule is not a loss.
- `src/reporters/html/test-view.ts`: the Recordings part after the code. `timeline-view.ts`: recording and pixel-policy events in words, with their app. `folder-view.ts`: recording files named from the result, since the store's listing does not know them. `style.ts`: videos sized like screenshots.
- `tests/unit/reporters-html-fixtures.ts`: `recordedRun`, `recordingRecord`, `mp4`, `configFiles`.
- `tests/unit/reporters-html-safety.test.ts`: escapes for the literal characters; the one allowed script element is the data block (exact tag, nothing else on it, no `<` inside); a title holding `</script>` is written `\u003c/script\u003e` in the block and reads back whole; secrets (the events hold `{{password}}` in a fill, a received value and a page title; the value sits in `logs/`, `states/`, an unnamed file and a linked file outside, and appears nowhere in the report); a hard link beside the symlink case; a recording whose path and gap carry markup.
- `tests/unit/reporters-html.test.ts`: the "loads nothing" check allows exactly the data block and refuses every other script, plus `<base>` and `<form>`; the block's content; four recorded-run tests (complete with its video, lost with a kept partial, removed by rule, a file that is not a video).
- `tests/unit/reporters-html-agreement.test.ts`: in all eighteen folders (two recorded ones added) the data block must equal the folder's result and the evidence state each section marks.
- `tests/integration/report-html.test.ts`: a third test that types a secret the page then shows, whose value must be in none of `events.jsonl`, `result.json` and both reports; the report opened through Retest's driver from a loopback server serving the run folder read-only, every request through `readArtifactFile`, every path asked for kept; every request under that server, none refused, the page asking for the report and its screenshot alone; the evidence labels counted and all visible; a second page at 390 by 844 showing the failing check and its values; `RETEST_REPORT_PROOF_OUT` keeps both screenshots.
- `docs/guide.md` ("The HTML report"): the data block, recordings, videos in the policy sentence.
- `docs/plans/public-beta/proofs/html-report.md`: decisions, results, artifacts, what was not shown.

Two assertions written by this lane's first worker were changed, both in this lane's own uncommitted files: "no script element" became "exactly one script element, the JSON data block, with nothing else on it and no `<` inside", in the safety test and the content test.

## Gates

No benchmark ran (`pgrep -f 'benchmarks/[r]un.ts'` before each gate). Logs under `/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/html-report/` (gitignored).

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| Lane unit files | `node --conditions=retest-source --test tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html-command.test.ts tests/unit/reporters-html-escape.test.ts` | 73 of 73 (23, 15, 18, 7, 10) | `unit-final.log` |
| Unit suite | `npm run test:unit` | 3799 of 3804; the 5 failures are in other lanes' files: `tests/unit/builds-lock.test.ts` 281, `tests/unit/evaluation-corpus-score.test.ts` 114, `tests/unit/evaluation-frames.test.ts` 491, `tests/unit/native-ios-simulator.test.ts` 299 and 342 (an earlier run, `test-unit-1.log`: 3591 of 3595, with 4 other failures in other lanes' files) | `test-unit-2.log` |
| Type markers | `npm run test:types` | 241 of 241 markers on 6.0.3 and 7.0.2 | `test-types-2.log` |
| Typecheck 6.0.3 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript/bin/tsc -p tsconfig.json` | 6 errors, none in this lane's files (`src/cli/inspect/test-timeline.ts`, `tests/integration/evaluation-frames.test.ts`, `tests/unit/evaluation-corpus-score.test.ts`, `tests/unit/inspect-looks.test.ts`, `tests/unit/runner-media-lifecycle.test.ts` twice: other lanes mid-edit) | `tsc6-3.log` |
| Typecheck 7.0.2 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript-7/bin/tsc -p tsconfig.json` | the same 6 and `tests/unit/runner-recording-fakes.ts`, none in this lane's files | `tsc7-3.log` |
| Real Chrome | `RETEST_REPORT_PROOF_OUT=<repo>/.retest/html-report/proof lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/report-html.test.ts` | 1 of 1 on Chrome 154.0.8037.93, before and after the recordings work | `integration-4.log`, `integration-5.log` |
| `file://` screenshots | `lockf -t 0 /tmp/retest-heavy-gate.lock sh .retest/html-report/screenshots.sh <report> <out> <name> <size> [flags]`, Chrome 154's own headless `--screenshot`: light, dark (`--force-dark-mode`), 400 px | three screenshots, the failure screenshot loaded beside the report in each; Chrome's log holds no console or policy message | `screenshots-3.log` |

`npm run typecheck` stops at the first compiler's errors, so each compiler was run on its own through the lock.

The integration file failed three times before it passed, each time in the test, not the report: `goto` refused `file://` (hence the loopback server); a helper that wants exactly one match met six evidence labels; Chrome's own icon request to the server drew a 404 that the collector counted as a console error (the server now answers `favicon.ico` with an empty 204, and the check that the page asked for nothing else ignores only that path).

Chrome 154's headless `--screenshot` writes its file and then stays up. The first light shot's Chrome (pid 72177) and its script (pid 72174), both started by this lane, were ended by this lane with SIGTERM after the file was written; the script now ends its own Chrome once the screenshot stops growing, and removes its profile. Nothing of this lane is left running. Each fresh Chrome profile woke Google's updater once (`GoogleUpdater --wake`, which exited by itself).

Breaks tried and restored at once (`.retest/html-report/mutate.mjs`): `escapeHtml` removed from `markup.ts`'s rendering fails 9 of 14 safety tests; `scriptJson` left writing `<` and `>` fails 3; every hard-link check in the store raised fails the report's hard-link test and 4 others.

## Sample report

`/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/html-report/proof/run/report.html`: a real run on Chrome, two tests passed, one failed, one typed a secret. Screenshots in `/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/html-report/`: `file-screenshots/report-light.png`, `report-dark.png`, `report-narrow.png` (opened from the file address), `proof/report-in-chrome.png` and `proof/report-in-chrome-390.png` (through Retest's driver; Chrome followed this Mac's dark setting).

## For other lanes

Nothing in `src/runner` or `src/config` is needed for the report today. `--reporter html` is registered in `src/cli/commands/run.ts` (`reporterNames`, the option's help, one branch in `createReporter`), as the brief allowed.

For the recording-runner lane, once its shapes are settled:
- The click from a step to the video's time: the report needs nothing new in the records (`RecordingRecord.clock` holds the mapping, every timeline row carries `data-elapsed-ms`); the report adds a hashed script and a second data block. Say when the shapes are final.
- `eventArtifactReferences` and `resultArtifactReferences` in `src/store/artifacts.ts` should name recordings (`path`, `partialPath`, thumbnails with `of`), so every reader's listing does what the report's own `folder-view.ts` does now.
- The terminal's evidence lines and the HTML's evidence state were not compared; the HTML also counts diagnostics captures, so it can be stricter.

For whoever owns `src/browser/navigation.ts`: opening a report through Retest's own driver from its file address would need an opt-in for `file:` in `resolveTarget` that a test cannot reach. Not done; nobody asked for it.

The README does not mention `retest report` or `--reporter html`; not this lane's file.

## What could not be verified, most important first

1. No run with recording on was made: the recordings part rests on fixtures in the recording-runner lane's shapes, and that lane has not run on real Chrome yet. Not built: the timeline over the video and the click that moves the video to a step.
2. Opening the report from its `file://` address through Retest's own driver: the driver refuses `file:`. The file address was opened only by Chrome's own headless mode, which shows the page and its screenshot loading but has no collector on it.
3. Withheld screenshots and stretches from a real run: shown from fixtures only.
4. Firefox and Safari opening the report: not tried.
5. A run with several apps of different engines in one test: fixtures only.
6. The policy probe on a `file://` page (that `img-src 'self'` reaches files above the folder) was the first worker's and was not repeated.

## Files changed

This lane's own, uncommitted, all new in this phase: `src/reporters/html/markup.ts`, `page.ts`, `build-report.ts`, `artifact-files.ts`, `evidence-status.ts`, `test-view.ts`, `timeline-view.ts`, `folder-view.ts`, `style.ts`, `recordings-view.ts` (new this session); `tests/unit/reporters-html-fixtures.ts`, `reporters-html.test.ts`, `reporters-html-safety.test.ts`, `reporters-html-agreement.test.ts`; `tests/integration/report-html.test.ts`; `docs/plans/public-beta/proofs/html-report.md`; this report (new).

Shared file: `docs/guide.md`, anchored edits in "The HTML report" only (other lanes edit the guide too).

Left as the first worker made them, named as the brief asks: `src/cli/cli.ts` (import and list entry of `reportCommand`), `src/cli/commands/run.ts` (the `html` reporter).

No dependency or script change. Helper scripts and logs live in `.retest/html-report/` (gitignored).
