# Native secret build report

The native implementation is built and the real TaskPhone and TaskDesk secret proofs pass. Public secret references still stop in the parent runner. Its refusal and web-only resolver are outside the assigned files; no runner file was changed.

## What changed by file

| File | Change |
| --- | --- |
| `src/native/output.ts` | Added complete-line redaction. Split pipe chunks remain in memory until the line ends. Input-bearing XCTest activity names become `{{native-input}}`, covering abbreviated typing and individual keys. Added redaction for executor failure messages and details. |
| `src/native/processes.ts` | Owned processes pipe both output streams through that writer before disk writes. Temporary output is removed after the pipes close. Process exit and output closure are tracked separately, so a runner app holding a pipe cannot deadlock shutdown. Cleanup can confirm output removal. `commandOf` accepts an explicit read bound, as the native log builder needs. |
| `src/native/executor-process.ts` | Each execution puts its XCTest bundle and derived data in an owned temporary folder, outside run folders and caches. Startup failures and normal close remove it. Cleanup reports when deletion cannot be confirmed. |
| `src/native/executors.ts` | Build stdout and stderr pass through the native line redactor before the build log is written. |
| `src/native/ios-simulator.ts` | Takes the run redactor and hidden variables through runtime options. `openSession` returns the runtime's existing client and executor session. Keeps exact executor PID and command records, and confirms temporary-output cleanup on close. |
| `src/native/macos-app.ts` | Applies the same runtime options and client/session handover. Exposes the app runtime's existing port and recorded executor processes. Confirms output cleanup after recorded runner apps end. |
| `src/native/locators.ts` | Decodes XML attribute values before redaction, then escapes them for the saved source. Named, decimal and hexadecimal entities are covered. |
| `src/native/session.ts` | Hands out redacted source. A private fill read keeps the original field value in the parent for exact verification and returns a redacted tree. Redacts executor failures and stored session-loss failures. |
| `src/native/actionability.ts` | Adds the private field-read operation to the internal native port. |
| `src/native/input.ts` | Verifies fills against the original field value. Retries transient source observations within the existing bound, without retyping. Completes the ledger record even when a request was not sent. |
| `src/native/interaction-session.ts` | Records an outstanding input before awaiting its response. Reconcile can see it immediately; the final response updates the same record. Disposal drains its input lane. Failure text is redacted before returning or recording it. |
| `src/native/alerts.ts` | Redacts decoded alert text and button labels. Alert input also completes its provisional ledger entry. |
| `tests/integration/native-interaction.test.ts` | Uses the client/session returned by `openSession` and gives both runtimes the learned redactor. Executor-loss tests end only exact PID/command pairs recorded by their own runtime. Existing assertions remain. |
| `tests/unit/native-secrets.test.ts` | Adds split-output, XML decoding, original fill read-back, alert redaction, executor-error redaction, and cancel/reconcile tests while input is still outstanding. |
| `tests/integration/native-secrets.test.ts` | Runs real sign-in and private fills on TaskPhone and TaskDesk, saves redacted trees and logs, checks bundle/derived removal, and greps for the typed value and its XCTest prefix without putting patterns in a file or command line. |
| `docs/plans/public-beta/proofs/native.md` | Records the native secret implementation and the real proof in its native lifecycle section. |
| `docs/plans/public-beta/proofs/wiring.md` | Records what the native follow-up supplies and what still blocks the public path. |
| `docs/plans/public-beta/codex/build-native-secrets-report.md` | This report. |

No runtime npm dependency was added. The public API tests and native fixture flows are unchanged. No commit or repository state operation ran.

## Commands and results

Before every test, `pgrep -f benchmarks/run.ts` found only PID 56597, whose process name was `codex`; it contained the task instructions, not a benchmark runtime. Every native integration and compiler gate used `lockf -t 0 /tmp/retest-heavy-gate.lock`. Busy attempts were left alone and retried. All gate output was captured and read.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/native-secrets.test.ts tests/unit/native-input.test.ts tests/unit/native-keyboard-alerts.test.ts tests/unit/native-processes.test.ts` | 45 passed. | `/tmp/retest-native-secrets-unit.log` |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` | 237 passed, no failures or skips. | `/tmp/retest-native-secrets-unit-all-final.log` |
| `node --conditions=retest-source --test tests/unit/native-secrets.test.ts` | Six passed after changing the new secret assertions to expose only comparison results on failure. | `/tmp/retest-native-secrets-unit-private-failures.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-secrets.test.ts` | Both real sign-in/fill proofs passed, no skips. | `/tmp/retest-native-secrets-real-final.log` |
| `rg --hidden --no-ignore -a -F -l -f - <paths>` | Patterns entered through stdin. Both real proofs found no matches for the fresh typed value, XML-escaped forms or its XCTest prefix in their run folders, build derived data and executor caches. Both found typing and tree placeholders. Temporary result bundles and execution derived data were deleted. | `grep.json` in each proof artifact below |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-phone.test.ts tests/integration/native-api-desk.test.ts` | All three failed at the parent's explicit native secret refusal. No skips. Their assertions remain unchanged. | `/tmp/retest-native-secrets-api.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='TaskPhone: a text field and a secure field' tests/integration/native-interaction.test.ts` | One failed, no skips. Keyboard, sign-in, creation and positive id/state checks passed. The deliberate wrong-state check returned `timeout` where the existing assertion requires `check_failed`. No assertion was changed. | `/tmp/retest-native-secrets-phone-interaction-retry.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Exit 0. Source passed on both compilers; examples passed. | `/tmp/retest-native-secrets-typecheck-current.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck:proofs` | Exit 0. All configured proof projects passed on both compilers. | `/tmp/retest-native-secrets-typecheck-proofs.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration` | Exit 1. 455 passed, seven failed, two live-provider checks skipped. Both refreshed secret proofs passed. | `/tmp/retest-native-secrets-integration.log` |

Earlier checks exposed two issues fixed here. An experimental attribute-value route conflicted with an existing no-repeat assertion, so fill verification uses private source reads instead. A unit gate stalled because an owned runner app held an output pipe after the root exited; the owned gate and descendants were recorded by PID and command and ended, then process exit was separated from output closure. The rerun passed all 237 native unit tests. Records: `/tmp/retest-native-secrets-unit-first.log`, `/tmp/retest-native-secrets-unit-all.log`, `/tmp/retest-native-secrets-stopped-unit-processes.json`.

The first real proof found a transient SpringBoard source during phone fill verification. Only observation retry changed; input still dispatches once. The next phone proof found that its runner logged synthesized events without a typing line. Those input-bearing names now receive the same placeholder. Logs: `/tmp/retest-native-secrets-real.log`, `/tmp/retest-native-secrets-phone-retry.log`. The passing proof followed both fixes.

Earlier source checks failed while the diagnostic/evaluation builder's tests were changing. The native app runtime's missing port was fixed here; the other errors were left to that builder. The final source and proof checks pass. Earlier logs: `/tmp/retest-native-secrets-typecheck.log`, `/tmp/retest-native-secrets-typecheck-final.log`.

The full integration failures were:

- All three public API flows stopped at the parent's native secret refusal.
- `tests/integration/native-diagnostics.test.ts` failed its phone stdout case because `simctl` did not name the app PID. The launch stayed unreconciled. `src/native/logs.ts` and that test belong to the diagnostic builder and were not edited here.
- Two cases in `tests/integration/native-evaluation.test.ts` correctly refused desktop captures: one had overlapping windows at layers 2147483630 and 1000; the paired case had an overlapping layer-1000 window. No foreign window or process was changed. These tests belong to the evaluation builder and were not edited here.
- The first existing TaskPhone interaction case failed at its initial keyboard wait because the source belonged to another app. It failed before secret input. The focused rerun got past keyboard, sign-in, creation and positive id/state checks, then failed at the deliberate wrong-state check because it returned `timeout` instead of the required `check_failed`. The ownership check and every assertion remain intact. This source/timing issue was recorded; no assertion or retry rule was changed to conceal it.

The two skips were live AI-provider checks whose required environment variables were unset. No native case was skipped in the full suite.

## Artifacts

- Phone secret proof: `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-native-secrets-ios-simulator-3kRoU6`.
- Desk secret proof: `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-native-secrets-macos-TLauNH`.
- Phone proof repeated in the full suite: `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-native-secrets-ios-simulator-PMUq6V`.
- Desk proof repeated in the full suite: `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-native-secrets-macos-fFHAaS`.
- Each contains redacted executor output, `runner.log`, `tree.xml` and `grep.json`. No private value is written into the grep record. No screenshot or video is taken with the proof value visible.
- Public phone run: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-phone/run-Ee3ID0`.
- Public desk run: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-nT7kIH`.
- Public desk/web run: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-y0YdVG`.
- Full-suite public runs: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-phone/run-DoW91g`, `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-HbcOCG`, `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-5TVFJZ`.
- Other builders' failing full-suite records: `/tmp/retest-native-diagnostics-build/diagnostics-ios-simulator-Nd1bmv`, `/tmp/retest-native-diagnostics-build/evaluation-macos-g6qex0`, `/tmp/retest-native-diagnostics-build/evaluation-x5xyEF`.
- Owned full-suite gate record: `/tmp/retest-native-secrets-integration-processes.json`.
- Independent read of the latest grep records and confirmation that all four recorded executor PIDs are absent: `/tmp/retest-native-secrets-cleanup.json`. Both value scans and both credential scans returned exit 1 with no matches.

The fixture service starts locally through the implementation behind the README's service command, with an ephemeral loopback port. Each test closes the service it started. Native runtime cleanup closes only its owned app/session and recorded executor processes. No prompt occurred in the completed secret and public API runs.

## What remains unverified

Passing public phone, desk and desk/web sign-in flows are not established. They fail before dispatching the credential. Exact native bundle destination authorization is not implemented in the parent resolver, and the pool still discovers its active session through `GET /status`.

The full suite is not passing, for the seven failures recorded above. Both secret proofs passed in that suite with the final output-drain code and sign-in credential grep. The complete phone interaction case remains unverified: its focused rerun completed the positive flow but did not retain the required wrong-state failure class. Source and proof compiler checks pass.

Text redaction proves nothing about screenshot or video pixels. The secret proof saves neither while the private value is visible. Other applications, native platforms and a clean machine are not claimed.

## Every file changed

`src/native/actionability.ts`, `src/native/alerts.ts`, `src/native/executor-process.ts`, `src/native/executors.ts`, `src/native/input.ts`, `src/native/interaction-session.ts`, `src/native/ios-simulator.ts`, `src/native/locators.ts`, `src/native/macos-app.ts`, `src/native/output.ts`, `src/native/processes.ts`, `src/native/session.ts`, `tests/unit/native-secrets.test.ts`, `tests/integration/native-interaction.test.ts`, `tests/integration/native-secrets.test.ts`, `docs/plans/public-beta/proofs/native.md`, `docs/plans/public-beta/proofs/wiring.md`, `docs/plans/public-beta/codex/build-native-secrets-report.md`.

Other uncommitted workspace changes belong to prior work or other builders. They were preserved.

## Changes needed outside the owned files

- `src/runner/native-pool.ts` must pass `redact` into `NativeTools` before executor build/start, consume the client and executor returned by `openSession`, and replace its explicit secret refusal with an exact bundle destination check before dispatch. It must refuse missing handover fields rather than attach by status or create a new session.
- `src/runner/running-test.ts` must replace its native secret refusal with a parent-authorized resolution using the current native session's exact bundle id. It must keep command validation, secret-locator refusal, the deadline, cancellation and parent verdicts.
- `src/runner/secrets.ts` and the fill context must permit a native secret only when that exact bundle id is explicitly listed for the secret. Check it before reading a function-backed credential and teach the run redactor before dispatch. Preserve the current web-origin checks.
- Runner unit tests must cover an allowed bundle, a different or absent bundle, a refused destination that never reads a credential, shared redaction, and use of the returned session with no status attachment. Those tests are outside this builder's assigned test files.
- The diagnostic builder needs to resolve its unreconciled phone stdout launch in `src/native/logs.ts` and `tests/integration/native-diagnostics.test.ts`. The evaluation builder needs to account for the capture refusals in `tests/integration/native-evaluation.test.ts` while preserving the coverage check. Those files were not edited here. Their earlier compiler errors are gone in the final compiler gates.

A scope question for these runner changes is pending. Without that permission, the public refusal stays in place and this report does not claim the task's public flows are complete.
