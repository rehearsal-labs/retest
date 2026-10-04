Native targets now run through the CLI with leases, identity, parent-owned checks and capture records. The requested sign-in flows and public helpers remain incomplete. No commit, package change or runtime dependency was added.

**1. What was built by path**

| Paths | Change |
| --- | --- |
| `src/browser/contract.ts`, `src/browser/page.ts`, `src/browser/electron.ts` | Additive launch, lifecycle, capture, outcome and frame-source contracts; production web capture and identity adaptation. Some contract fields remain optional for compatibility with the existing native classes and web fakes. |
| `src/config/{types,loaded,read-apps,validate}.ts` | Native arguments/environment, refusals without value disclosure, bundle-id secret destinations, real-path and disk-case folder checks. |
| `src/runner/native-pool.ts` | Runtime/session ownership, acquisition guard, finite cleanup, release hook, unknown outcomes, bound launch settings and unexpected-end readings. |
| `src/runner/{target-drivers,run-session,running-test,test-pages}.ts` | Native startup and command routing, parent assertions, reset records, shutdown, page identity, state.restored session id and the run clock. Browser prewarming removed; web browser/server setup runs concurrently inside the complete lease. |
| `src/api/page.ts`, `src/assertions/expect.ts`, `src/protocol/{commands,locator-checks,events,execution,evidence,result}.ts` | Native finder/action/assertion types, selected checks, native start/end identity, reset records, capture references and exact parent result facts. |
| `src/reporters/{human,run-record,targets}.ts`, `src/cli/inspect/test-timeline.ts`, `src/store/{run-store,rebuild-result}.ts` | Native target names and captures in reports/inspect; explicit capture clock with legacy inference fallback; whole-result reconstruction for comparison with result.json. Missing-result recovery still reports an incomplete error. |
| `tests/unit/runner-native-wiring.test.ts`, native type fixtures, native API integration tests, new cross-platform test files | Lease/start/release ordering, uncertainty, revocation, forged verdicts/commands, scoped native types and required real-target flows. The real flow assertions remain failing rather than weakened. |
| `tests/unit/assertions-matchers.test.ts` | The one requested wording expectation accepts singular time. |
| `dist/schemas/{event-v1,result-v1}.schema.json`, `docs/guide.md`, `docs/plans/public-beta/proofs/wiring.md` | Regenerated version-1 schemas and records of the implemented behavior and remaining gaps. |

**2. Commands and results**

Each test was preceded by `pgrep -f benchmarks/run.ts`, with matching command names checked. No benchmark executor was running. Every heavy/native/Electron gate below used `lockf -t 0 /tmp/retest-heavy-gate.lock`; a busy lock was retried after waiting. Output was captured and read afterward.

| Command | Result | Log |
| --- | --- | --- |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Passed both source compilers and the examples check after the final source edits. | `/tmp/retest-wiring-typecheck-final.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck:proofs` | Passed both compilers for all proof projects. | `/tmp/retest-wiring-proof-types-final.log` |
| `npm run test:types` | Passed on both compilers; 214 expected errors matched 214 markers in ten projects. | `/tmp/retest-wiring-types-records.log` |
| `npm run test:unit` | 2,477 passed, 12 failed, no skips or cancellations. Failures concern exhaustive protocol tables, strict folder checks and old native-refusal expectations. A MaxListenersExceededWarning also appeared in the native fake tests. | `/tmp/retest-wiring-unit-last.log` |
| `node --conditions=retest-source --test tests/unit/runner-native-wiring.test.ts` | All 13 passed. | `/tmp/retest-wiring-native-unit-bound.log` |
| `node --conditions=retest-source --test tests/unit/runner-native-wiring.test.ts tests/unit/runner-config-servers.test.ts tests/unit/runner-parallel.test.ts` | 19 passed, one failed at the assumed order of parallel browser starts. Server setup and all native wiring cases passed. The ordering case passed in the later full unit run, so the focused failure remains recorded. | `/tmp/retest-wiring-acquired-setup-unit.log` |
| `node scripts/write-schemas.ts` | Passed; both schemas regenerated, schemaVersion remains 1. | `/tmp/retest-wiring-schemas-release.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-phone.test.ts tests/integration/native-api-desk.test.ts tests/integration/electron-web-flow.test.ts` | Three Electron flows passed. All three native API cases failed at the secret-input refusal; none skipped. | `/tmp/retest-wiring-api-integration-records.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration` | Stopped before direct native-interaction credential input could reach unprotected output. Partial result: 324 passed, one failed, 44 cancelled, two skipped. The failure expects state.restored to omit sessionId. Only this gate's recorded Node process was signaled. | `/tmp/retest-wiring-integration-suite.log`; ownership record `/tmp/retest-wiring-owned-integration-processes.json` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-wiring-verify-artifacts.mjs <phone folder> <desk folder> <desk/web folder>` | Whole rebuilt result equals result.json for desk, desk/web and phone; no expired lease and all native sessions ended. | `/tmp/retest-wiring-artifact-check.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-wiring-cleanup-proof.mjs` | Both recorded simulators deleted and recorded TaskDesk executables absent. Read-only; no process changed. | `/tmp/retest-wiring-cleanup-proof.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-wiring-old-reader.mjs` | The reader from main refuses a real native.started event at schemaVersion 1. Main protocol files were extracted read-only. | `/tmp/retest-wiring-old-reader.log` |
| `node --conditions=retest-source src/cli/main.ts inspect <retained folder> --test <full test id>` | Phone and desk output names native identity, captures and the refusal. | `/tmp/retest-wiring-inspect-phone.log`, `/tmp/retest-wiring-inspect-desk.log` |

Earlier typecheck, unit and native acceptance runs are retained in `/tmp/retest-wiring-*.log`. The table gives the final relevant checks and the incomplete full integration gate. The real-target gate preceded the final bound-session wrapper and web/server setup adjustment; those final changes have typecheck and fake coverage, not another real-target run.

**3. Artifacts with absolute paths**

- Phone run, events, result and executor-screen PNG captures: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-phone/run-Mir1oz`.
- Desk run, events, result and named window-capture refusal: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-9yi0vh`.
- Desk/web run using one lease table: `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-YsOvk0`.
- Proof record: [wiring.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/proofs/wiring.md).
- This report: [build-wiring-report.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/build-wiring-report.md).
- Prepared, unapplied public-helper patch: `/tmp/retest-wiring-app-page.patch`.

The retained runs were checked for the fixture credential before copying. No credential was typed by these native API runs. Native identity includes app checksum/build, OS, device/runtime, executor and Xcode. Adopted executor builds record commitVerified false. Cleanup checks prove the recorded simulator and app absence, not a general sweep of unrelated processes.

**4. What could not be verified**

1. Native sign-in, task creation, task-id/state assertions, the intentional wrong-state failures, the desk chord and the shared desk/web task flow. Executor output is not safe for secret input, so native fills refuse secret references before reading their value. The full integration gate cannot safely complete while direct native-interaction tests still send credentials through that output path.
2. Public `locator(step)`, iOS swipe, keyboard dismissal/wait/card and alert helpers. Their constructors are in `src/api/app-page.ts`, outside the explicit ownership list. The concrete patch is ready but unapplied and unverified; scope approval is pending. Parent routes are implemented.
3. Full TaskDesk window capture. The AutomationModeUI exclusion landed, but another foreign layer-1000 window still overlaps the app. Capture was refused and no foreign window was closed. iOS executor-screen capture did run.
4. Green full gates. The twelve unit failures require updates in tests outside this lane's ownership, preserving all existing assertions. Parallel browser-start order remains nondeterministic after acquisition replaces prewarming. The full integration gate is incomplete.
5. Mandatory contract normalization in raw native classes and web fakes. Native execution identity and WebSession frameSource remain optional in the shared compatibility type. Raw lifecycle launch still ignores the additive spec argument, while the runner wrapper refuses changed settings. The wrapper supplies unexpected-end readings. The interaction wrapper attaches through GET /status rather than a runtime-provided client/session.
6. Exact source correspondence of the adopted executor builds, continuous native capture, keychain isolation and a clean-machine setup. No independent review of this wiring change was performed. `doctor` still follows the web-only native refusal path outside this lane's ownership.

**5. Every existing file changed by this work**

Paths are relative to `/Users/dragon/Documents/Projects/Gruvi/Products/retest`.

- `src/browser/contract.ts`, `src/browser/electron.ts`, `src/browser/page.ts`
- `src/config/types.ts`, `src/config/loaded.ts`, `src/config/read-apps.ts`, `src/config/validate.ts`
- `src/runner/target-drivers.ts`, `src/runner/run-session.ts`, `src/runner/running-test.ts`, `src/runner/test-pages.ts`
- `src/api/page.ts`, `src/assertions/expect.ts`
- `src/protocol/commands.ts`, `src/protocol/locator-checks.ts`, `src/protocol/events.ts`, `src/protocol/execution.ts`, `src/protocol/evidence.ts`, `src/protocol/result.ts`
- `src/reporters/human.ts`, `src/reporters/run-record.ts`, `src/reporters/targets.ts`
- `src/cli/inspect/test-timeline.ts`, `src/store/run-store.ts`, `src/store/rebuild-result.ts`
- `tests/unit/assertions-matchers.test.ts`, `tests/types/fixtures/native-config.ts`, `tests/types/fixtures/native-targets/register.ts`
- `docs/guide.md`, `dist/schemas/event-v1.schema.json`, `dist/schemas/result-v1.schema.json`

New repository files: `src/runner/native-pool.ts`; `tests/unit/runner-native-wiring.test.ts`; `tests/integration/native-api-phone.test.ts`; `tests/integration/native-api-desk.test.ts`; `fixtures/cross-platform/tests/native-phone.retest.ts`; `fixtures/cross-platform/tests/native-desk.retest.ts`; `fixtures/cross-platform/tests/native-desk-web.retest.ts`; `docs/plans/public-beta/proofs/wiring.md`; this report.

**6. Smallest src/native changes needed**

- `processes.ts` and executor startup: redact stdout/stderr before persistence and disable or protect input-bearing XCTest activity/result output. Redact decoded source/alert fields, including escaped input. Prove the path on real targets before enabling secret fills. Native secretOrigins are exact app bundle identifiers.
- Native runtime openSession: expose its existing client and executor session for interaction; never create a replacement session.
- Native identity/state/lifecycle: embed execution in runtime identity, include endedUnexpectedly in raw state readings, and explicitly honor or refuse LaunchSpec. The runner currently wraps the latter two behaviors.
- Startup failures: return a partial runtime/desktop cleanup handle so uncertain startup can be reconciled and cleanup retried. Keep the lease held until ending is proved.

No src/native file was edited by this work.

**7. What moved during the work**

The native builder changed `src/native/macos-app.ts`, `src/native/png.ts`, `tests/unit/native-fake-tools.ts`, `tests/unit/native-macos-app.test.ts`, `tests/integration/native-macos-lifecycle.test.ts`, `docs/plans/public-beta/proofs/native.md` and `docs/plans/public-beta/progress.md`. I reread the native implementation and records. The overlay exclusion and pixel helpers landed; their record still refuses full TaskDesk coverage because Wispr Flow overlaps it. Those changes are not this lane's edits. All other pre-existing work was preserved, including the protected files and package settings.
