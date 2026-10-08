# Recording runner report

## Changes needed in other lanes

- `src/store/artifacts.ts`, `eventArtifactReferences` (486–502) and `resultArtifactReferences` (508–529): include `recording.finished.path` and `partialPath`, identity, and retention removals. These settled recording shapes are now on disk. The runner currently supplies its own references for retention.

- `src/media/locate.ts`, `locateMedia`, lines 26–67: discovery always starts a probe process and returns only paths/hello. The runner needs discovery without a separate process, followed by its owned `MediaProcess.start`/`ready`, to keep one media worker per run. Provide discovery without probing, or return the probed process with explicit ownership transfer. The current runner still accepts explicit host/env paths; checked-cache discovery remains blocked on this interface.
- `src/cli/inspect/test-timeline.ts:89`: its exhaustive event switch needs the new recording, media, capture and retention events; full typecheck reports a missing return.
- `tests/unit/inspect-looks.test.ts:29`: its test-event filter must narrow new optional-scope retention events instead of assigning them as test-scoped events.
- `tests/unit/process-ownership.test.ts:208`, `:430`, `:446`: later `host.signals.map(entry => entry.pid)` reads have `entry` narrowed to `never` after the earlier exact empty-array assertion. Preserve both exact signal assertions; read the later observation through an explicitly typed fixture snapshot rather than suppressing the diagnostics. This lane left the file untouched.
- `tests/unit/evaluation-frames.test.ts:672`, credential-reader refusal test: `evaluationDetails(record)` omits the required second run-folder argument. Supply that path while preserving the exact no-credential assertion. This appears in the final global TS7 check.
- `tests/unit/evaluation-frames.test.ts:202`: the expected frame request omits `minGapUs: 1`, which `gatherFrames` now requests to preserve short gaps. Keep the exact request assertion and include the required setting. This is the sole failure in the latest 77/78 follow-up, not a verdict weakened by this lane.

The earlier screenshot-policy request was implemented by the evaluation lane in `src/evaluation/evidence.ts`, `screenshotEvidence`/`pixelRefusal` (153–212). Both pre/post withholding tests pass in `outside-unit-followup-2.log`. That file was never edited here. The runner supplies this policy when recording is requested, an app declares `pixels`, or secrets are declared. Recording-off runs with declared secrets emit withholding events and save no failure screenshot during a withheld stretch. Runs without any of those declarations retain their previous screenshot behavior.

## What the earlier diff contained and what review found

Read the requested briefs, handovers, media and policy reports, fix-runner report and HTML report. The inherited scoped diff is saved whole in `/tmp/recording-runner-takeover/inherited.diff`. The HTML report requests no runner/config registration; CLI registration is already its owner's work.

The earlier builder had implemented the config, protocol, recorder, policy wiring, retention, rebuild and human reporter. Review found:

- The interrupted test's fixed timer could abort collection before a recording existed. The baseline reproduced 19/20. The observation probe found no session, media or recording start before abort. The test now triggers interruption on `recording.started`, retaining every finish, status, exit and rebuild assertion. A separate early-abort test requires zero media and recording starts. No finish event is fabricated for a recording that never existed.
- A frame-count assertion used optional chaining followed by `!== 0`, which allowed `undefined`. It now requires a positive count.
- Encoder refusal closed a worker but left it reusable; its cleanup failure was forgotten. Both now remain explicit.
- A never-answering readiness probe, source restart, leftover request or frame release could hold shutdown. Waits are bounded; failed old-source shutdown keeps frames withheld and refuses restart. A source returning stop stats with problems also used to authorize a restart; a failing-first regression now requires suspension to remain active and no new source to open.
- Synchronous probe/close and source-factory throws escaped the evidence lifecycle. They now produce named evidence/cleanup failures.
- Aggregating a schema-valid partial or unavailable recording with no reasons produced complete attempt evidence. Two regressions fail first; the aggregate now keeps its status and names `capture_incomplete`.
- A media ending could name a missing video or incomplete evidence and still produce complete runner evidence. Source drops, refused/unsent gaps, source cleanup problems and reasonless incomplete media status are also preserved as gaps. Video paths must name a nonempty safe artifact.
- `media.leftovers.runId` replaced the current event's run identity. Its body field is now `previousRunId`.
- Rebuilding an unfinished recording named its loss but omitted test/run evidence status. Both are now derived.
- Leftover output paths could traverse a linked ancestor. Reads and output validation now use the artifacts-policy module.
- A failed retention unlink could still claim the video was removed in a rebuilt result. The failure cancels that mark.
- Capture mode was re-read from changing availability; when no stop stats returned, the source invented screencast/zero fps. The actual start mode and requested rate are retained, and missing cleanup stats remain a problem.
- Cancellation during readiness could start recording and UI capture afterward. The recorder checks cancellation before acquisition and after readiness; the source checks again before dispatching capture. Already dispatched work follows normal finalization.
- The agent reporter omitted evidence entirely. It now reports run and incomplete test evidence separately from outcomes.

Every product defect above has a failing-first regression. The hanging-sweep and retention checks were also run against isolated copies of inherited behavior, without replacing or restoring working source. Log names are in the proof record.

## Built by path

- `src/runner/run-media.ts`: lazy run worker, bounded readiness/close/sweep/release, retained cleanup failures, one replacement after loss, attempt recording lifecycle, actual mode, cancellation guards and artifact validation.
- `src/runner/policed-source.ts`: frame policy, fresh source after a withheld stretch, bounded start/stop/restart, no restart after unknown stop, cancellation guard and retained mode/rate.
- `src/runner/evidence-status.ts`: independent evidence aggregation, named capture losses and incomplete media endings.
- `src/runner/media-leftovers.ts`: bounded sibling log reads, recorded owner check, policy path validation.
- `src/runner/run-session.ts`, `running-test.ts`, `test-pages.ts`, `contract.ts`, `outcome.ts`: inherited recording config, secret-entry policy, failure screenshot checks, body/host-check finalization, evidence-first run release, required-evidence ending; added run cancellation wiring. Browser/native driver close code needed no edit because recording finishes before those existing closes.
- `src/protocol/recording.ts`, `events.ts`, `result.ts`, `index.ts`, `failures.ts`: additive recording/media/pixel/retention events, identity, counts, clock mapping, evidence status and `evidence_incomplete`. The new gap is `capture_incomplete`. The leftovers event uses `previousRunId`.
- `src/config/read-recording.ts`, `types.ts`, `loaded.ts`, `validate.ts`: recording and pixel configuration, validation and host override; recording remains off by default.
- `src/store/rebuild-result.ts`: recording and evidence reconstruction, unfinished recording status, correct failed-retention handling.
- `src/reporters/agent.ts`, `human.ts`, `format.ts`, `run-record.ts`: independent evidence display and event preservation.
- Unit files: inherited `config-recording.test.ts`, `runner-evidence-status.test.ts`, `runner-recording-fakes.ts`, `runner-recording.test.ts`; added `runner-media-lifecycle.test.ts`, `runner-media-leftovers.test.ts`, `runner-policed-source.test.ts`; extended `protocol.test.ts`, `protocol-identity.test.ts`, `reporters-agent.test.ts`.
- `tests/types/fixtures/recording-config.ts`: accepted settings and rejected flag, app, retention, pixel and size types.
- `tests/integration/recording-harness.ts`, `recording-run.test.ts`, `recording-endings.test.ts`, `recording-pixels.test.ts`, `recording-leftovers.test.ts`, `recording-exit.test.ts`: real Chrome/video/identity/status checks; worker and encoder kills, SIGINT, timeout, browser crash; secret video/store check; killed-run leftovers and an unrelated sentinel; runner-only SIGKILL cleanup without killing its descendants in the test body; required-evidence exit 2 from the CLI while the observed test passes.
- `docs/guide.md`: anchored recording section and stale recording statements corrected. `docs/plans/public-beta/proofs/recording.md`, this report and `recording-runner-state.md`: commands, findings, handoff and limits.

These lists name this lane's new and existing changed files, including the inherited work being finished. Other modified paths in the shared tree were preserved.

## Commands and results

All takeover logs are under `/tmp/recording-runner-takeover/`, with durable copies and verification helpers under `.retest/recording-runner-takeover/logs/`. The lane implementation and owned checks are finished; whole-project checks remain failed as listed. Every test first checked `pgrep -f 'benchmarks/[r]un.ts'`. Heavy commands use `gate-wait.sh`: `lockf -t 0 /tmp/retest-heavy-gate.lock "$@"`, retrying a busy lock after a minute. A persistent `pgrep` false positive came from another worker's Codex instructions and its sole waiting launch shell. The helper verifies that process relationship before excluding those instruction-text matches; every other or unreadable candidate still closes the guard. No benchmark, download, commit, stash, reset or revert was performed.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/runner-recording.test.ts` | Baseline 19/20; no recording had started in the failed interruption | `unit-baseline.log`, `interrupt-probe.log` |
| `node --conditions=retest-source --test tests/unit/config-recording.test.ts tests/unit/runner-evidence-status.test.ts tests/unit/runner-recording.test.ts tests/unit/runner-media-lifecycle.test.ts tests/unit/runner-media-leftovers.test.ts tests/unit/runner-policed-source.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/reporters-agent.test.ts` | 108/108 before the final no-stats mode regression | `unit-lane-4.log` |
| `node --conditions=retest-source --test tests/unit/runner-policed-source.test.ts tests/unit/runner-recording.test.ts` | 28/28 after that regression's fix | `capture-stats-fixed.log` |
| Same recording/source command after stop-problem restart fix | 29/29; the new regression failed first with restart allowed | `stop-problems-failing-first.log`, `stop-problems-fixed.log` |
| Expanded focused lane command above after source-stop and aggregate fixes | 112/112 | `unit-lane-5.log`, preceding `aggregate-failing-first.log` has 0/2 |
| `npm run test:unit` | 3,761/3,762, Firefox deadline failure; focused rerun 16/16 | `unit-all-1.log`, `unit-followup.log` |
| `node /tmp/recording-runner-takeover/unit-owned.ts` (launches `npm run test:unit`) | 3,801/3,804; corpus scorer, evaluation capture gap, native fake cleanup failures; wrapper exit 1 from process-table read problems, no recorded descendants remained | `unit-all-2.log`, `unit-owned-process.json` |
| `node --conditions=retest-source --test tests/unit/evaluation-frames.test.ts tests/unit/evaluation-corpus-score.test.ts` | 75/78 during that lane's edits. The prior corpus/short-gap assertions passed; frame request expectation and two pre/post screenshot withholding assertions failed. Nothing in those files was changed here | `outside-unit-followup.log` |
| Same command after that lane's screenshot-policy change | 77/78; both screenshot-withholding checks pass, frame request expectation still fails during its edits | `outside-unit-followup-2.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Final TS6 exit 2; only outside-lane CLI timeline, inspect event filter and three process-ownership fixture errors. The npm chain stops at TS6; separate TS7 ran in the next row | `typecheck-7.log`; earlier `typecheck-1.log`, `typecheck-3.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock sh /tmp/recording-runner-takeover/scoped-types.sh` | Scoped TS6 exit 0, scoped TS7 exit 0, examples TS6 exit 0. Global TS7 exit 1 from outside CLI timeline, inspect filter, three ownership signal-fixture errors and evaluation-details run-folder argument. Helper exit 1 preserves that failure | `typecheck-scoped-6.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types` | 241/241 markers on both 6.0.3 and 7.0.2 | `test-types-2.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_RECORDING_PROOF_OUT=<repo>/.retest/recording-runner-takeover/proof-2 node --conditions=retest-source --test --test-concurrency=1 tests/integration/recording-run.test.ts tests/integration/recording-endings.test.ts` | 7/7, Chrome 154.0.8037.93. Earlier 6/7 exposed this new test's incorrect timeout expectation; it now matches the established failed/timeout/exit 1 contract and compares directly to recording off | `recording-integration-6.log`, earlier `recording-integration-5.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/recording-pixels.test.ts tests/integration/recording-leftovers.test.ts tests/integration/browser-lifecycle.test.ts tests/integration/run-interrupt.test.ts tests/integration/m2-guarantees.test.ts tests/integration/m2-state.test.ts` | 36/36, Chrome 154.0.8037.93. Pixel proof decoded 11 frames; killed-run cleanup preserved the unrelated sentinel | `lifecycle-integration-1.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_RECORDING_PROOF_OUT=<repo>/.retest/recording-runner-takeover/proof-4 node --conditions=retest-source --test --test-concurrency=1 tests/integration/recording-exit.test.ts` | 2/2. Runner-only SIGKILL leaves all recorded descendants gone before harness cleanup. Required lost evidence preserves passed test and actual CLI exit 2/`evidence_incomplete` | `runner-exit-1.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_RECORDING_PROOF_OUT=<repo>/.retest/recording-runner-takeover/proof-3 node --conditions=retest-source --test --test-concurrency=1 tests/integration/recording-pixels.test.ts` | 1/1, Chrome 154.0.8037.98. Eleven decoded frames exclude the secret document; no kept frame lies in the withheld stretch; worker/encoder ownership gone | `pixel-proof-2.log`; `pixel-proof-1.log` was guard-refused, no test ran |
| Scoped `git diff --check` over the listed lane paths | Exit 0 | `diff-check.log` |
| `node scripts/write-schemas.ts` | Exit 0 | `schemas.log` |

The scoped helper runs `node_modules/typescript/bin/tsc -p .retest/recording-runner/tsconfig.json`, `node_modules/typescript-7/bin/tsc -p .retest/recording-runner/tsconfig.json`, `node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json`, then `node_modules/typescript-7/bin/tsc -p tsconfig.json`. It keeps the checkout's strict settings and does not suppress diagnostics. Schema generation writes the ignored `dist/schemas/` artifacts.

Artifact folders: `proof-3/pixels` contains the video and `recording-proof.json`, with identity, withheld stretches and the independent decoded/store counts. `proof-4/runner-exit` preserves the killed run, and `proof-4/required-evidence` preserves the separate run failure with a passed test. `.retest/recording-runner-takeover/proof-2/` holds `passed-and-failed`, `media`, `encoder`, `SIGINT`, `timeout`, `browser`: result/events, videos or named incomplete partial files, and browser/diagnostics logs. `proof-1/` preserves the first gate's successful cases. No proof folder was overwritten. Recording-off tests deliberately name missing media tools and still produce the same outcomes with no media events. The pixel/lifecycle gate confirms all recorded launch descendants gone through ownership; playable files are independently probed and fully decoded by ffprobe/ffmpeg.

## What the other lanes must know

- Capture-sources: every `frameSource(identity)` call must return a fresh source. A failed old-source stop keeps suspension active. The client/runner review fix now stops every running source at run cancellation and discards an in-flight image on arrival. The earlier pre-start guard alone did not prove this; the new running-loop probes are in fix-client-runner-report.md. Mode comes from successful start, never a later availability query. A driver masking fact is still needed to allow safe password-field pixels; unread facts conservatively withhold until a new document/session end.
- Media-install: explicit `RunOptions.media` and env names work; cache discovery is not integrated for the locator reason at the top. No run implicitly builds or downloads a binary. Protocol 2 and encoder readiness are checked on the run's owned worker.
- Evidence/evaluation: `AttemptRecorder` supplies kept-frame stores and step spans. Pixel stretches suspend sending and are named in evidence. Frame stores release only after the attempt's checks. Your screenshot-policy guards and short-gap handling now pass their focused assertions; the remaining request-expectation failure is recorded above. Policy activation is recording, an explicit `pixels` block, or declared secrets, including recording-off runs.
- Artifacts-policy: portable recording/partial references, policy decisions and retention calls are in use. Add shared recording references rather than duplicating path logic. A failed removal cannot claim successful retention.
- HTML: shapes are settled in `recording.ts` and `events.ts`. Recording identity uses the event envelope plus test/attempt/app/session; `RecordingRecord.clock` and timeline `elapsedMs` supply seeking, with shortened gaps explicitly mapped. `capture_incomplete` is a new named reason. Retention and unfinished runs preserve evidence status. No reporter registration change is requested here. No callable `SendMessage` to `main` exists in this session; this report is the handoff.
- Older schema-version-1 readers refuse the new event types; this is inferred from the schemas rather than an old reader binary exercised here. The folder schema version remains 1.

## What could not be verified

1. Whole-project typecheck is not green. Final global TS6 and TS7 name only outside-lane locations listed first. Both scoped compilers and examples pass. No outside assertion or diagnostic was suppressed here.
2. Checked-cache runner discovery needs the media-install interface change. Explicit executable/env paths are exercised.
3. Full unit verification is not green. The exact runs and subsequent outside follow-ups are above; no later whole-suite pass is claimed.
4. Pixel protection is verified with the policy active. Recording-off runs preserve prior screenshot behavior only when neither pixel rules nor secrets are declared; declared secrets activate withholding. Real native screenshot protection was not exercised here.
5. Native, Firefox, WebKit and Electron recording are not exercised by this lane. Automatic retry scheduling is not implemented; separate attempts are checked for distinct outputs.
6. HTML seeking/playback and the shared recording artifact index remain outside this lane's verification.

No lane-started browser, worker, encoder, test process or gate waiter remains running. The real-target tests confirm their launch descendants through ownership. The replaced queued compiler waiter was ended only after its saved parent, start and command matched (`restarted-scoped-waiter.json`); the first helper refused a caller-parent mismatch and signalled nothing. Other workers and their edits were preserved.
