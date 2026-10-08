# Report and retention fixes

Current verification: all six fixes are implemented; 199 selected unit tests pass, scoped TypeScript 6 and 7 pass, and the unchanged real-Chrome report integration test passes. Two failures from an additional untouched recording test file remain recorded below.

Scope: review findings 1, 2, 3, 4, 7 and 8, handled in that order. Existing work and concurrent lanes are preserved. No commits, downloads or benchmarks are authorized.

Read the project instructions, README, architecture, common rules, Phase 4 common brief and the full second-read review. Logs for this work are under `/tmp/retest-fix-report-retention/`.

Before tests, `pgrep -f 'benchmarks/[r]un.ts'` returned exit 1 with no matches. Heavy checks use `/tmp/retest-heavy-gate.lock`.

## Finding 1: source file disclosure

Confirmed the HTML code-frame path reads arbitrary project-local locations with `readFileSync`, follows links and does not redact source. The run bundle now authorizes the test path before a bounded regular-file read; source without the run redactor is withheld.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-source.test.ts > /tmp/retest-fix-report-retention/finding-1-before.log 2>&1` returned exit 1. All 4 tests failed on source disclosure or absent source redaction. An edit script had a syntax error before it changed any file; the preliminary after-check therefore still failed those same 4 tests.

Fixed source reads in `src/reporters/code-frame.ts`, `src/reporters/html/{build-report,failure-view,report-context,test-view,summary-view,reporter}.ts`, with async callers in `src/cli/commands/report.ts`. The HTML builder authorizes a test file only when its execution bundle names it. The bounded `readRecordText` reader refuses leaf links and FIFOs; source-parent identities are checked around the read. The live `EventLog` passes the run redactor through `Reporter.onRunEnd`, wired in `src/runner/run-session.ts`. The report command withholds source when no live redactor is available and keeps the location text. This is deliberate loss of optional source display, not of test outcomes or assertions.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-source.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html-command.test.ts > /tmp/retest-fix-report-retention/finding-1-after.log 2>&1` returned exit 0: 67 passed, 0 failed, cancelled or skipped. Existing script/markup safety assertions remain unchanged. Two intermediate edit/fixture errors were corrected before this successful check: duplicated `async` and an incomplete synthetic execution record. Final Chrome and compiler results are recorded below.

## Finding 2: refused diagnostics links

Confirmed `ArtifactFiles.link` accepts syntax alone, and diagnostics build the link before the safe read. The symlink and hard-link regressions reproduce the premature link.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='refused diagnostics' tests/unit/reporters-html-safety.test.ts > /tmp/retest-fix-report-retention/finding-2-before.log 2>&1` returned exit 1, 2 failed. Both refused files still had an href.

Fixed `src/reporters/html/{artifact-files,diagnostics-view}.ts`: the successful diagnostics read owns its link; the renderer reads first and prints a refused file name without an href. Removed the syntax-only link method.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html.test.ts > /tmp/retest-fix-report-retention/finding-2-after.log 2>&1` returned exit 0, 40 passed, 0 failed, cancelled or skipped. Links remain generation-time decisions; later filesystem mutation when a browser opens a saved report is not prevented by this check.

## Finding 3: retention directory replacement

The original final verification was followed by an absolute-path unlink. The regression swaps the folder after final verification.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='directory swapped after final' tests/unit/store-retention.test.ts > /tmp/retest-fix-report-retention/finding-3-before.log 2>&1` returned exit 1, 1 failed. The post-verification directory swap deleted the outside file.

Fixed `src/store/artifacts.ts`: `CheckedArtifact.remove` opens the parent with `O_DIRECTORY | O_NOFOLLOW`, verifies it with `fstat`, retains its descriptor through removal, derives the entry from the verified parent, and rechecks folder identities immediately before unlink. A replaced directory is refused with `changed`, the intended file is not claimed removed. Linux uses `/proc/self/fd/<descriptor>/<entry>`. This Mac's `/dev/fd/<descriptor>/<entry>` probe returned `ENOENT`, so the final Mac path uses a synchronous directory-relative unlink after checking the entered directory against the opened descriptor. Node has no `unlinkat` API. The final-audit regression below also covers a swap inside the unlink call. The regression exercises the reviewer's change between artifact verification and unlink.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention.test.ts tests/unit/store-artifacts.test.ts > /tmp/retest-fix-report-retention/finding-3-after.log 2>&1` returned exit 0, 44 passed, 0 failed, cancelled or skipped. The outside file and the intended moved file survive the interleaving; removal is refused as changed.

Final-audit follow-up to finding 3: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='swap inside the unlink' tests/unit/store-retention.test.ts > /tmp/retest-fix-report-retention/finding-3-call-boundary-before.log 2>&1` returned exit 1, 1 failed. Rechecking directory identity alone still allowed an interleaving inside unlink. The final implementation uses a synchronous directory-relative unlink on macOS after verifying that the entered directory matches the retained descriptor. The kernel keeps that directory identity across a rename; the process directory is restored in finally, before any recorder, reporter or awaited work runs. Linux uses the descriptor path directly. The first interleaving remains refused with the original file kept; a later call-boundary swap cannot reach the outside file and removes only the original entry. No broader atomic claim about concurrent replacement of the leaf entry is made.

## Finding 4: frame and diagnostics evidence

Confirmed evidence status ignores these kinds, rendering classifies them as screenshots, and extraction skips nested frame paths. Full-report and reference tests now include agreement cases alongside all 18 existing run folders.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='evaluation-(frames|diagnostics)|frame and diagnostics evaluation references' tests/unit/reporters-html-agreement.test.ts tests/unit/store-artifacts.test.ts > /tmp/retest-fix-report-retention/finding-4-before.log 2>&1` returned exit 1, 5 failed. The corrected fixture removes both diagnostic capture start and finish, so an unrelated stopped capture does not mask the reproduced evidence-status error.

Fixed `src/reporters/html/{evidence-status,evaluations-view,artifact-files}.ts` and `src/store/artifacts.ts`. Frame omissions, unplaced frames, lost stretches and missing frame files now contribute explicit evidence reasons. Selected diagnostics use a bounded safe JSON read and render the exact judge context as diagnostics. Frame images keep their frame IDs and capture timestamps. Criteria show both judge verdict and parent rule. Event/result extraction includes nested frame files with kind `frames`, and diagnostics with kind `diagnostics`. Added four frame/diagnostics cases to the agreement suite, preserving all 18 existing folders.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/store-artifacts.test.ts > /tmp/retest-fix-report-retention/finding-4-after.log 2>&1` returned exit 0, 95 passed, 0 failed, cancelled or skipped. This is report/reference verification with synthetic evidence, not real frame capture or judge accuracy.

## Finding 7: removal request and completion

Confirmed the real EventLog catches append failures and returns normally, while retention deletes after its intent record is labelled removed. Real-log append failure and interrupted-recorder tests reproduced that contract failure before the change.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention-records.test.ts > /tmp/retest-fix-report-retention/finding-7-before.log 2>&1` returned exit 1, 3 failed. The actual EventLog with a failing RunStore append allowed deletion. A recorder that persisted intent then died caused reference reconstruction to exclude a present file. Successful retention emitted no completion after unlink.

Fixed the request/completion contract in `src/store/artifacts.ts`, `src/runner/event-log.ts`, and retention wiring in `src/runner/run-session.ts`. `EventLog.emitPersisted` reports actual append success, including false after the store has failed. Retention requires the boolean true. The version-1 event schema adds `artifact.removal_requested`; `artifact.removed` now confirms successful unlink, and `artifact.removal_failed` confirms refusal/failure. Run record handling and reconstruction retain an uncompleted request as `removalPending`, with its path present and no removed claim. HTML names it "Present, removal not confirmed". The recording schema adds this optional field. Existing retention checks were strengthened to assert request-before-delete and completion-after-delete.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention-records.test.ts tests/unit/store-retention.test.ts tests/unit/runner-event-log.test.ts tests/unit/store-rebuild-result.test.ts tests/unit/store-artifacts.test.ts tests/unit/runner-recording.test.ts tests/unit/reporters-html.test.ts > /tmp/retest-fix-report-retention/finding-7-after.log 2>&1` returned exit 1: 106 passed, 2 failed, 0 cancelled or skipped. All three new removal regressions passed. The two failures are the untouched no-recording fixture in `tests/unit/runner-recording.test.ts:96` and `:119`, which expects no pixel-policy events and a retained screenshot after secret input. Current policy emits capture.withheld/resumed and withholds that image. These checks were not weakened or changed. This mismatch is outside the retention path, and its behavior was not independently checked on the pre-edit tree. The final scoped unit checks below pass without that untouched file; those two failures remain unresolved in this lane. The first new-after check needed correction of synthetic EventLog sequence numbers, then passed in this combined check.

Reconstruction audit follow-up to finding 7: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='recorder that dies' tests/unit/store-retention-records.test.ts > /tmp/retest-fix-report-retention/finding-7-input-before.log 2>&1` returned exit 1, 1 failed. The new pending marker mutated the original recording event. Reconstruction now copies the pending recording instead; the test also requires the input event to stay unchanged.

Finding 7 final association audit: the actual retention emitter supplies test and attempt IDs without variant fields. `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='variantless retention' tests/unit/inspect-timeline.test.ts > /tmp/retest-fix-report-retention/finding-7-variant-before.log 2>&1` returned exit 1, 1 failed. Unlike the earlier fixture with an explicit variant, this production-shaped record was absent from the test timeline. The assertion still requires both distinct records in order. The report record now matches variantless retention events to the started attempt when the direct test/variant lookup has no record. This avoids inventing a variant or losing the production event.

Finding 7 association verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/inspect-timeline.test.ts tests/unit/inspect-command.test.ts tests/unit/store-retention-records.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-agreement.test.ts > /tmp/retest-fix-report-retention/finding-7-variant-after.log 2>&1` returned exit 0, 74 passed, 0 failed, cancelled or skipped. The strengthened inspect scenario omits variant fields just as the actual emitter does.

## Finding 8: shared recording thumbnail

The passed/failed multiple-owner thumbnail scenario reproduced the planner error before the change.

Failing first: `node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='thumbnail shared' tests/unit/store-retention.test.ts > /tmp/retest-fix-report-retention/finding-8-before.log 2>&1` returned exit 1, 1 failed. The planner selected the shared thumbnail despite the failed recording retaining ownership.

Fixed `src/store/artifacts.ts`: a thumbnail is kept when another attempt owns it, another reference protects it, its source is unknown, or any source recording remains retained. The keep reason names the protecting record and owner.

Verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/store-artifacts.test.ts > /tmp/retest-fix-report-retention/finding-8-after.log 2>&1` returned exit 0, 49 passed, 0 failed, cancelled or skipped. This verifies the planner with actual temporary-file inventory and synthetic multiple-owner references.

## Final verification

The final required checks completed successfully: 199 selected unit tests, one real-Chrome report integration test, and scoped TypeScript 6 and 7. Earlier commands and follow-up regressions are retained below.

Final selected-unit command: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-source.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html-command.test.ts tests/unit/reporters-html-escape.test.ts tests/unit/reporters-format.test.ts tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/store-artifacts.test.ts tests/unit/runner-event-log.test.ts tests/unit/store-rebuild-result.test.ts > /tmp/retest-fix-report-retention/final-unit.log 2>&1` returned exit 0: 167 passed, 0 failed, cancelled or skipped. All then-touched HTML/store/EventLog test files were included; additional format, command, escape and rebuild tests verified the affected callers. Inspect was added later and is included in the final 199-test command.

The safety suite also exercises hostile text in both new evidence renderers. It still requires exactly one non-executable JSON block and no executable markup. A new EventLog test verifies true on append success and false on the failed append and all later events. Source reads now also reject multiple file names and recheck the source entry identity.

The first two locked TypeScript 6 attempts returned exit 75 before compiling because the shared heavy-gate lock was occupied. The shared gate initially refused the compiler attempts. Compiler versions are TypeScript 6.0.3 and 7.0.2; their final successful results and commands are recorded below.

Follow-up verification: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/store-artifacts.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html-safety.test.ts > /tmp/retest-fix-report-retention/final-followup-unit.log 2>&1` returned exit 0, 114 passed, 0 failed, cancelled or skipped. This covers the tighter unlink boundary and the final criterion rendering, which shows ordinary judge verdicts as well as overridden ones.

Further TypeScript attempts found the lock occupied. `sh /tmp/retest-fix-report-retention/check-typescript-6.sh` retried the exact locked command once per minute and exited with the compiler's exit code. It wrote `/tmp/retest-fix-report-retention/typescript-6.log`. The complete compiler invocation is also saved in `/tmp/retest-fix-report-retention/typecheck-command.txt`; the successful invocation is included below.

Source boundary follow-up: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-source.test.ts > /tmp/retest-fix-report-retention/source-boundaries.log 2>&1` returned exit 0, 9 passed, 0 failed, cancelled or skipped. Added explicit hard-link, byte-bound, FIFO, absent-redactor and absent-bundle cases alongside the original four failing-first cases. The FIFO fixture uses only the host's `mkfifo` and was removed with its temporary folder.

TypeScript 6 acquired the lock and returned exit 2 with one error: the exhaustive inspect timeline had no branch for the new request event, `src/cli/inspect/test-timeline.ts:94`. The failing log is preserved at `/tmp/retest-fix-report-retention/typescript-6-before.log`. Added the request entry and distinguished it from completed removal in that necessary caller. Final compiler and Chrome results are recorded below.

The final unit command above was rerun with output `/tmp/retest-fix-report-retention/final-unit-complete.log` after the source boundary and reconstruction audit changes. Exit 0: 173 passed, 0 failed, cancelled or skipped.

Inspect and pending-result check: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/store-retention-records.test.ts tests/unit/inspect-timeline.test.ts tests/unit/inspect-command.test.ts > /tmp/retest-fix-report-retention/inspect-and-pending.log 2>&1` returned exit 0, 28 passed, 0 failed, cancelled or skipped. The interrupted-recorder regression now verifies both the unchanged input event and the HTML's explicit unconfirmed-removal text.

The initial inspect request/completion test omitted the variant and exposed an unassociated event. An intermediate fixture supplied the variant; the final audit below then recognized that the actual retention emitter also omits it and corrected the production association instead. The timeline type explicitly includes the request event. `node --conditions=retest-source --test --test-concurrency=1 tests/unit/inspect-timeline.test.ts > /tmp/retest-fix-report-retention/inspect-request-completion.log 2>&1` returned exit 0, 9 passed, 0 failed, cancelled or skipped. The test requires distinct request and completion text in that order. Necessary inspect callers changed in `src/cli/inspect/{test-timeline,looks}.ts`; these were outside the initial path list but must handle the added event.

Chrome queue command: `sh /tmp/retest-fix-report-retention/check-chrome-report.sh`. It retries `lockf -t 0 /tmp/retest-heavy-gate.lock sh /tmp/retest-fix-report-retention/run-chrome-report.sh` once per minute. Inside the lock the script checks `pgrep -f 'benchmarks/[r]un.ts'`, then runs `env RETEST_REPORT_PROOF_OUT=/tmp/retest-fix-report-retention/chrome-proof node --conditions=retest-source --test --test-concurrency=1 tests/integration/report-html.test.ts`. Output is `/tmp/retest-fix-report-retention/chrome-report.log`, with retained proof output under `/tmp/retest-fix-report-retention/chrome-proof/` if the test succeeds. The command initially waited for the gate; its successful result is recorded below.

Final current-tree unit command: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/reporters-html-source.test.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/reporters-html-command.test.ts tests/unit/reporters-html-escape.test.ts tests/unit/reporters-format.test.ts tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/store-artifacts.test.ts tests/unit/runner-event-log.test.ts tests/unit/store-rebuild-result.test.ts tests/unit/inspect-timeline.test.ts tests/unit/inspect-command.test.ts > /tmp/retest-fix-report-retention/final-current-unit.log 2>&1` returned exit 0: 199 passed, 0 failed, cancelled or skipped. This rerun was required by the final attempt-association change and includes every touched unit test file, plus the affected command, formatting and reconstruction callers.

Scoped TypeScript 6.0.3 acquired the gate and returned exit 0, no diagnostics. Exact command:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2024 --lib es2024 --module nodenext --types node --customConditions retest-source --strict --declaration --isolatedDeclarations --erasableSyntaxOnly --verbatimModuleSyntax --allowImportingTsExtensions --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --skipLibCheck false src/reporters/code-frame.ts src/reporters/reporter.ts src/reporters/run-record.ts src/reporters/html/*.ts src/cli/commands/report.ts src/store/artifacts.ts src/store/rebuild-result.ts src/runner/event-log.ts src/runner/run-session.ts src/protocol/events.ts src/protocol/recording.ts tests/unit/reporters-html-source.test.ts tests/unit/reporters-html-fixtures.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/store-artifacts.test.ts tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/runner-event-log.test.ts src/cli/inspect/test-timeline.ts > /tmp/retest-fix-report-retention/typescript-6.log 2>&1
```

Log: `/tmp/retest-fix-report-retention/typescript-6.log` (empty on success). The source roots include the changed inspect source and its imports. TypeScript 7 additionally roots the inspect test explicitly. The TypeScript 6 retry process has ended.

Scoped TypeScript 7.0.2 acquired the gate and returned exit 0, no diagnostics. Exact command:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock node node_modules/typescript-7/bin/tsc --ignoreConfig --noEmit --target es2024 --lib es2024 --module nodenext --types node --customConditions retest-source --strict --declaration --isolatedDeclarations --erasableSyntaxOnly --verbatimModuleSyntax --allowImportingTsExtensions --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --skipLibCheck false src/reporters/code-frame.ts src/reporters/reporter.ts src/reporters/run-record.ts src/reporters/html/*.ts src/cli/commands/report.ts src/store/artifacts.ts src/store/rebuild-result.ts src/runner/event-log.ts src/runner/run-session.ts src/protocol/events.ts src/protocol/recording.ts tests/unit/reporters-html-source.test.ts tests/unit/reporters-html-fixtures.ts tests/unit/reporters-html.test.ts tests/unit/reporters-html-safety.test.ts tests/unit/reporters-html-agreement.test.ts tests/unit/store-artifacts.test.ts tests/unit/store-retention.test.ts tests/unit/store-retention-records.test.ts tests/unit/runner-event-log.test.ts src/cli/inspect/test-timeline.ts src/cli/inspect/looks.ts tests/unit/inspect-timeline.test.ts > /tmp/retest-fix-report-retention/typescript-7.log 2>&1
```

Log: `/tmp/retest-fix-report-retention/typescript-7.log` (empty on success). The TypeScript 7 retry process has ended.

The unchanged real-Chrome report integration command described above acquired the gate and returned exit 0: 1 passed, 0 failed, cancelled or skipped. Chrome 154.0.8037.98 was recorded by the test; the browser process group was 21198. Log: `/tmp/retest-fix-report-retention/chrome-report.log`. Proof folder: `/tmp/retest-fix-report-retention/chrome-proof/`. It exercised the run's exit code 1 for the intentional application assertion failure, successful report reconstruction, visible failure values and screenshot, matching recorded outcomes, absence of the supplied secret, and no requested files outside the run folder. The Chrome queue process has ended.

Chrome artifacts retained: `/tmp/retest-fix-report-retention/chrome-proof/run/report.html`, `run/events.jsonl`, `run/result.json`, `collector.jsonl`, `report-in-chrome.png`, `report-in-chrome-390.png`, and the run's screenshot and diagnostics files. Both report screenshots were visually inspected: the overview, failure status and values remain readable at the captured widths. This establishes the captured viewports, not every viewport or evidence kind.

Cleanup: `ps -p 21198,97181,1948 -o pid,ppid,command` returned exit 1 with no listed processes; `ps -p 21073 -o pid,ppid,command` also returned exit 1. PID 21073 is the run browser recorded in the retained events; 21198 is the report-view browser group recorded by the integration harness. `ps -axo pid,pgid,ppid,command | awk '$2 == 21073 || $2 == 21198'` printed no descendants. `pgrep -f '/tmp/retest-fix-report-retention/(check-|run-chrome)'` returned exit 1, so all this lane's retry processes ended. The final benchmark check returned exit 1 with no matches. No process belonging to another lane was ended.

## Changed paths and boundaries

Source changes in this lane:

- `src/reporters/code-frame.ts`, `src/reporters/reporter.ts`, `src/reporters/run-record.ts`.
- `src/reporters/html/build-report.ts`, `failure-view.ts`, `report-context.ts`, `test-view.ts`, `summary-view.ts`, `reporter.ts`, `write-report.ts`, `artifact-files.ts`, `diagnostics-view.ts`, `evidence-status.ts`, `evaluations-view.ts`, `recordings-view.ts`, `timeline-view.ts`.
- `src/cli/commands/report.ts`. The necessary exhaustive inspect callers also changed: `src/cli/inspect/test-timeline.ts:178` renders the request event distinctly from completed removal, and `src/cli/inspect/looks.ts:7` includes it in timeline types.
- `src/store/artifacts.ts`, `src/store/rebuild-result.ts`, `src/protocol/events.ts`, `src/protocol/recording.ts`, `src/runner/event-log.ts`.
- `src/runner/run-session.ts`: live-redactor reporter context at line 320 and retention request/completion wiring at line 1516 only. Concurrent media changes are preserved. `src/shared/regular-file.ts` belongs to the other fixer and was used without edits here.

Test changes: new `tests/unit/reporters-html-source.test.ts` and `tests/unit/store-retention-records.test.ts`; existing `tests/unit/reporters-html-fixtures.ts`, `reporters-html.test.ts`, `reporters-html-safety.test.ts`, `reporters-html-agreement.test.ts`, `store-artifacts.test.ts`, `store-retention.test.ts`, `runner-event-log.test.ts`, `inspect-timeline.test.ts`. The existing HTML safety requirements remain exactly one non-executable JSON block and no executable script. `tests/integration/report-html.test.ts` is exercised unchanged.

Documentation changes: this report and `docs/plans/public-beta/proofs/report-retention-fixes.md`. No commit, stash, reset, revert, download or benchmark was run.

Unverified boundaries: the two untouched recording-fixture failures remain unresolved; real frame/diagnostics capture, judge accuracy, Linux descriptor-relative removal, other browser/native targets, clean-host packaging and concurrent replacement of the leaf entry are not established by this lane. Saved reports require safe files when generated; these changes do not prevent later filesystem mutation before a browser opens a saved link. Offline report generation withholds source because the live secret redactor cannot be reconstructed from redacted records.
