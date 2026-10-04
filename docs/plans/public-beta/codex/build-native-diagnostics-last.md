1. **Built by path**

   - `src/native/logs.ts`: owned-pid stdout capture, redaction before persistence, shared bounds, identity and explicit capture states. Empty output is unavailable. TaskDesk uses its launch pipe. TaskPhone uses `simctl launch --console`, with the pid reconciled through parent OS observations: the tested `--stdout` pipe produced no bytes, and the console route supplied no usable pid acknowledgement. App text never selects a pid. Launch and stop hooks preserve uncertain outcomes.
   - `src/diagnostics/native-network.ts`: validated, bounded, redacted JSONL metadata for the declared app client and capture interval. No declaration reports `the app provides no network source`; missing and unreadable files have explicit reasons. Headers and bodies are rejected. Each record carries test, attempt, app, session, source and client. The file/client interval needs exclusive ownership.
   - `src/diagnostics/{attempt,policy,report}.ts` and `src/protocol/diagnostics.ts`: native source lifecycle, scope, statuses, schema and reporting. Native stdout cannot satisfy a strict JavaScript error rule.
   - `src/evaluation/evidence.ts`, `src/protocol/evaluation.ts`, `tests/support/fake-evaluator.ts`: frozen native PNG evidence, capture references and times, per-app identity, and a judge that answers from decoded pixel hashes. A later pass retains an earlier required failure.
   - `tests/{unit,integration}/native-{diagnostics,evaluation}.test.ts`: source and evidence tests with fakes, plus real TaskPhone and TaskDesk sessions. The combined test also retains exact task-id, title and state assertions through the fixture service's two clients.
   - `fixtures/cross-platform/README.md`: only the two native log-location paragraphs. `docs/guide.md`: one section after diagnostics. `docs/plans/public-beta/proofs/native-diagnostics.md`: source decisions, proof and limits.

2. **Commands and results**

   Each test invocation first checked `pgrep -f benchmarks/run.ts`. An early match was the task's `codex` process; no benchmark runtime was found. No benchmark command ran. Gate output was saved and read afterward.

   | Command | Result | Log |
   | --- | --- | --- |
   | `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Exit 0; both TypeScript compilers and the example passed | [typecheck-complete.log](/tmp/retest-native-diagnostics-build/typecheck-complete.log) |
   | Unit command below | Exit 0; 205 passed, none failed or skipped | [unit-delivery.log](/tmp/retest-native-diagnostics-build/unit-delivery.log) |
   | `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/native-diagnostics.test.ts` | Exit 0; TaskPhone and TaskDesk passed, none skipped | [native-diagnostics-reconciled.log](/tmp/retest-native-diagnostics-build/native-diagnostics-reconciled.log) |
   | `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/native-evaluation.test.ts` | Exit 1; TaskPhone passed, TaskDesk and combined checks failed, none skipped | [native-evaluation-final.log](/tmp/retest-native-diagnostics-build/native-evaluation-final.log) |

   ```sh
   node --conditions=retest-source --test tests/unit/native-diagnostics.test.ts tests/unit/native-evaluation.test.ts tests/unit/diagnostics-capture.test.ts tests/unit/diagnostics-policy.test.ts tests/unit/evaluation-contract.test.ts tests/unit/protocol.test.ts tests/unit/diagnostics-run.test.ts tests/unit/evaluation-commands.test.ts tests/unit/evaluation-runs.test.ts
   ```

   Earlier attempts exposed validation/type errors, a silent iOS stdout pipe, missing console pid acknowledgement and an unbounded test polling loop. Those were fixed; their outputs remain in [/tmp/retest-native-diagnostics-build](/tmp/retest-native-diagnostics-build), including `unit.log`, `typecheck-second.log`, `typecheck-seventh.log`, `native-first.log`, `native-diagnostics-second.log`, `native-third.log` and `native-latest.log`. Busy gates were retried without ending another owner's process. The leftover test subprocess alone was recorded, its command checked again, and ended; [the process record](/tmp/retest-native-diagnostics-build/ended-owned-test.json) and [stop output](/tmp/retest-native-diagnostics-build/end-owned-test.log) remain.

   Each real diagnostics test started `node --conditions=retest-source fixtures/cross-platform/service/server.ts --port 0 --network-log <file>` and stopped its own recorded service, app and executor processes. No unrelated window was changed and no permission prompt was requested.

3. **Artifacts with absolute paths**

   - Saved report: [build-native-diagnostics-report.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/build-native-diagnostics-report.md).
   - TaskPhone logs, network records, summaries, undeclared-source and missing-file artifacts: [/tmp/retest-native-diagnostics-build/diagnostics-ios-simulator-MdJ0dK](/tmp/retest-native-diagnostics-build/diagnostics-ios-simulator-MdJ0dK).
   - TaskDesk equivalents: [/tmp/retest-native-diagnostics-build/diagnostics-macos-PUFV2w](/tmp/retest-native-diagnostics-build/diagnostics-macos-PUFV2w). Both real diagnostics runs captured complete stdout and metadata with the correct identity and client; credential checks passed.
   - TaskPhone pixel verdicts and parent events: [/tmp/retest-native-diagnostics-build/evaluation-ios-simulator-qu4GgM/run/evaluation-records.json](/tmp/retest-native-diagnostics-build/evaluation-ios-simulator-qu4GgM/run/evaluation-records.json). Actual `executor-screen` PNGs are in [/tmp/retest-native-diagnostics-build/evaluation-ios-simulator-qu4GgM/run/artifacts](/tmp/retest-native-diagnostics-build/evaluation-ios-simulator-qu4GgM/run/artifacts). The inspected visible-defect image is [evaluation-2](/tmp/retest-native-diagnostics-build/evaluation-ios-simulator-qu4GgM/run/artifacts/native-pixel-checks-15cma6h55z5l3-evaluation-1tv257ppym8f7-phone-0rd604o397f5b-evaluation-2-1uf86vwiyi2lo.png). Its hash failed despite misleading text; the later good image did not clear that required failure.
   - TaskDesk capture refusal: [/tmp/retest-native-diagnostics-build/evaluation-macos-btu6y6/run/evaluation-records.json](/tmp/retest-native-diagnostics-build/evaluation-macos-btu6y6/run/evaluation-records.json).
   - Combined check, retained phone evidence and separate synchronization assertions: [/tmp/retest-native-diagnostics-build/evaluation-QeWHQz/run/evaluation-records.json](/tmp/retest-native-diagnostics-build/evaluation-QeWHQz/run/evaluation-records.json) and [/tmp/retest-native-diagnostics-build/evaluation-QeWHQz/run/sync-assertions.json](/tmp/retest-native-diagnostics-build/evaluation-QeWHQz/run/sync-assertions.json).

4. **Could not verify, most important first**

   TaskDesk and combined screenshot evaluation remain failed: the production source refused a genuine overlapping window at layer 1000. The required checks remained inconclusive and their test assertions failed. No foreign pixels were saved and no assertion or capture rule was weakened.

   Runner/config integration remains unverified and outside this ownership. The real tests exercise sources and parent evaluation directly. The network source cannot distinguish concurrent copies using the same declared client. The combined synchronization assertions prove the fixture service's shared task, not that both native UIs displayed it.

   `simulator-display` evaluation, live-model accuracy, full integration and proofs typechecking were not verified by this work. Screenshots are actual pixels; text redaction does not redact images or video. No pixel masking capability was added.

5. **Every existing file changed by this work**

   `src/native/logs.ts`, `src/diagnostics/native-network.ts`, the four native test files, the proof and this report are new. Existing files changed were exactly:

   - `src/diagnostics/attempt.ts`
   - `src/diagnostics/policy.ts`
   - `src/diagnostics/report.ts`
   - `src/protocol/diagnostics.ts`
   - `src/evaluation/evidence.ts`
   - `src/protocol/evaluation.ts`
   - `tests/support/fake-evaluator.ts`
   - `fixtures/cross-platform/README.md`
   - `docs/guide.md`

   Existing work was preserved. `src/diagnostics/observations.ts` needed no change. No commit was made.

6. **Changes needed in files not owned**

   The native lifecycle owner needs an optional stdout launch hook in `src/native/{session,ios-simulator,macos-app}.ts` or its driver wrapper: check the existing launch blocker, adopt the returned app and console-launcher process records, retain and await the stop hook, and reconcile dispatched launches and cancellation without assuming an action was undone. The wrapper supplies the app-scoped OS process reading.

   `src/runner/**` needs to start native diagnostics before launch and await `finishNative` after dispatched work and host checks settle, before cleanup, retaining its parent-owned failures. `src/config/**` needs a typed file/client declaration and exclusive ownership of that capture interval. Apps without instrumentation must retain the unavailable reason.

   The macOS capture owner needs a genuinely clear window or a separately proved source correction before full-window pixel evaluation can be claimed. This work supplies no capture bypass.