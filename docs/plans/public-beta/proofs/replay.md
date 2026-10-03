# Replay lane record: participants, session limits, preparation, execution and requirement identity

Phase 1 item 11 of [the 0.1.0 handoff](../release-0.1.0.md), against [the replay contract](../replay.md). Written 3 October 2026. Every claim in the gate table names the test that proves it; the sections on names, shapes and compatibility describe the code and name no test. A test against real Chrome is marked Chrome, one against the fake browser with real test file processes is marked fake, and a pure unit is marked unit.

## Settled names and shapes

### `RunOptions` (from `@rehearsal-labs/retest/runner`)

| Option | Shape | What it does |
| --- | --- | --- |
| `sessions` | `{ owner: string; budget: SessionBudget; waitMs?: number }` | Counts each attempt's sessions, one per app, against `owner` and the host. `waitMs` defaults to the setup budget. |
| `prepare` | `Record<testId \| file, HostPreparation>` | Host preparation and cleanup per attempt, keyed as `hostChecks` are, file first. |
| `requirement` | `{ version: string; checks?: Record<checkId, sha256> }` | The requirement version; with `checks`, a frozen requirement. |
| `appBuilds` | `Record<app, string>` | Each app's build as the host knows it. |

`SessionBudget` (new class, exported): `new SessionBudget({ perOwner, host })`, `reserve(request, stopped)`, `snapshot()`, `peak()`. One budget counts the sessions of every run given it in one process.

`HostPreparation`: `{ prepare?, cleanup?, backendData?: 'reused' | 'external', apps?, timeoutMs?, cleanupTimeoutMs? }`. `prepare(context)` answers `{ status: 'prepared', recipe, seed?, receipt?, metadata? }` or `{ status: 'failed' | 'uncertain', reason }`. `PreparationContext` carries the key, test id, attempt id, file, covered apps, variant, owner, `timeoutMs` and `signal`; `CleanupContext` adds `preparation`, `prepared` and `failed`.

`HostCheck` gains `id?: string` (a name). Host AI checks already had `id`.

### Events (schema version 1, additive)

- `session.reserved` (attempt scope): `owner`, `sessions`, `waitedMs`, `active: { owner, host }`, `limits: { perOwner, host }`. Before `test.started`.
- `session.released` (attempt scope): `owner`, `sessions`, `after: contexts_closed | browser_closed`. Written when the attempt gives its sessions back, which is once it has closed its contexts, a stopped run's included, or, when a context could not be closed, once its browser has.
- `test.started.execution?: ExecutionRecord`.
- `preparation.finished` (attempt scope): `preparation: PreparationRecord`.
- `cleanup.finished` (attempt scope): `cleanup: CleanupRecord`.
- `test.finished.ending?: Ending`, and `test.finished.bundle?: BundleRecord` when the body loaded modules after `test.started`.
- `run.started.options` gains `sessions`, `requirement` (`{ version, checks: RequirementCheck[] }`), `appBuilds` and `preparations` (the keys).
- Host check records and results carry `id`; a failed host check's failure carries `details.checkId`.

### Result (`result.json`, additive)

`TestResult` gains `execution`, `preparations`, `cleanups` and `ending`. `rebuildResult` restores all four from events, with the final bundle in place.

### Records (`src/protocol/execution.ts`, types and schemas exported from `/protocol`)

- `ExecutionRecord`: `bundle?`, `configuration: { sha256, settings }`, `secretReferences?` (beside the fingerprint, not in it), `runtime: { retest, node, platform }`, `sessions: { app, sessionId, engine, product, version }[]`, `owner?`, `appBuilds?`, `requirement?: { version, sha256, checks }`, `startingState: { app, browserStorage: 'fresh' | 'saved', state?, backendData }[]`, `unavailable?` (such as `bundle`, `app-build:web`, `judge-code:<judge>`).
- `BundleRecord`: `{ sha256, modules: { path, sha256 }[] }`, paths POSIX from the root, `../` outside it, sorted; the fingerprint is the SHA-256 of the list's canonical JSON. The test file's process names the paths (`collected` and `test-finished` carry `modules: string[]`); the parent reads and hashes each file itself, once per process, and refuses an absolute path, a backslash or a file that is not a module (`.ts .mts .cts .js .mjs .cjs .json`). An attempt's bundle is the modules loaded with the file plus those that attempt loaded first.
- `ExecutionSettings`, per test: its own apps (`target`, `kind`, `browser`, `channel`, `headless`, `device` or `emulation`, `proxy` without credentials, iOS `simulator`), its `timeouts`, its `locks`, `environment` (the names of `RunOptions.testEnvironment`'s variables, never their values, since a value the host put there is its own and may be a secret it never declared; absent without it), `diagnostics` (`capture`, the strict and required policy, the limits), `evaluation` only for the judges its host AI checks name (each judge's adapter kind and module, `moduleSha256` for a file adapter, `packageVersion` for a package adapter, `codeUnavailable` for a factory or an unreadable adapter, accepts, credential references, `optionsSha256` over redacted options; time; limits; `promptVersion`), `playwright`. Base URLs and executable paths are left out. Every string is redacted before the hash.
- `BackendData`: `prepared | reused | external | unavailable`.
- `PreparationRecord`: `key`, `apps`, `backendData`, `outcome: prepared | failed | uncertain | cancelled | not_run`, `recipe?`, `seed?`, `receipt?`, `metadata?`, `reason?`, `durationMs`.
- `CleanupRecord`: `key`, `outcome: done | failed | timed_out`, `reason?`, `durationMs`.
- `Ending`: `kind` (`passed`, `skipped`, `not_run`, `assertion_failed`, `required_check_failed`, `check_error`, `inconclusive`, `evaluation_error`, `setup_failed`, `action_failed`, `timed_out`, `test_error`, `crashed`, `cancelled`, `outcome_unknown`, `cleanup_failed`), `checkId?`, `notRun?`. It is decided from the parent's records only: its host check results, its evaluation records, the failures `RunningTest` saw for itself (`BodyReport.observed`), its preparation, page, diagnostics and state failures, whether the process ended on its own, whether a browser was gone, and the run's interruption. A failure only the test process reports is `assertion_failed` for `check_failed` or `timeout` (a value assertion, an `expect.poll`), `test_error` otherwise.
- `RequirementCheck`: `{ id, kind: 'page' | 'evaluation', sha256 }`, the SHA-256 of `{ kind, content }` as canonical JSON, every string redacted first. A page check's content leaves out `name` and `id`; an AI check's includes its judge's settings, adapter code and options. The version is redacted before it is recorded or hashed.

## Reused and added

Reused as they were: apps as participants and a browser context per app per attempt (`RunSession.#openPages`), saved states per app (`state: { app: name }`, `test.setup` with `apps`), `formatSessionId` and the look references the contract lane bound to sessions, the scheduler's order and the all-or-none rule of `src/runner/locks.ts` (copied in shape, not in code, by `sessions.ts`), host checks and host AI checks run in the parent, `run.started`, the redactor, and `rebuildResult`.

Added: `src/runner/sessions.ts`, `src/runner/preparation.ts`, `src/runner/fingerprint.ts`, `src/protocol/execution.ts`, `src/shared/sha256.ts`; module tracking in the loader's load hook (`loadedModules()` in `src/loader/project.ts`, kept by the loader lane in its rewrite) reported by the test file's process in `collected` and `test-finished`; the shared-records pages of the task app (`fixtures/task-app/shared-records.ts`).

## Release gates on Chromium

| Gate in [replay.md](../replay.md) | Shown on Chromium | Test |
| --- | --- | --- |
| Fixed test passes on a correct fixture, fails at the intended check on a broken one, passes after repair; source, requirement and configuration fingerprints unchanged; app build changes | Yes, one attempt of each | Chrome: `participants-identity.test.ts` "a fixed test passes on a correct app, fails at its intended required check…" |
| Each engine repeats the defect in two fresh prepared sessions and the repair twice | No: one attempt each, and preparation is proven in a separate run | Phases 3 and 5 |
| Two-participant reference flow transfers the exact recorded object between distinct accounts | Yes | Chrome: `participants-reference.test.ts`, two runs, two generated references, two decoys with the same title |
| Four named sessions keep login and storage apart | Yes | Chrome: `participants-four-sessions.test.ts`, 16 parent host checks, four screenshots each showing its own account |
| Owner limits enforced; owners share a host budget without oversubscription; cancellation releases queued and acquired reservations | Yes | Chrome: `participants-session-limits.test.ts` (four tests, holders counter, one a stopped owner and a waiting owner on a host budget of 1); fake: `runner-replay-run.test.ts` "under workers…", with an unlimited control, "a stopped run closes its contexts before another owner gets their sessions" and "contexts that could not be closed keep their sessions until their browser closes"; unit: `runner-sessions.test.ts`. When the rule was changed, the real stopped-owner test was run once by hand on the old rule and passed, since Chrome closes the stopped run's browser before the next owner's first request lands; no command reproduces that now. The fake test fails on the old rule (2 contexts open on a budget of 1) and passes on the new |
| A separate session rejects an observation reference from discovery | Unit only, by the contract lane | unit: `runner-session-evidence.test.ts`. No real-Chrome case forges a reference across sessions |
| Fresh input data cannot be substituted by an object left from a previous attempt | Yes | Chrome: `participants-reference.test.ts` |
| Failed, timed-out or uncertain preparation prevents test actions and produces a setup result | Yes | Chrome: `participants-preparation.test.ts`; fake: `runner-replay-run.test.ts`; unit: `runner-preparation.test.ts` |
| Cleanup failure preserves the original failure and is reported separately | Yes | Chrome: `participants-preparation.test.ts`; fake: `runner-replay-run.test.ts` |
| A changed helper, requirement, evaluator policy or configuration changes the identity; a changed check cannot pass as the frozen one | Yes | Chrome: `participants-identity.test.ts` (both tests; an edited judge adapter changes the configuration and makes the frozen AI check refused); fake: `runner-replay-run.test.ts` (full and grep runs give a test the same bundle; a rotated secret changes no fingerprint); unit: `runner-fingerprint.test.ts` (per-test judges, environment, diagnostics, judge code, redaction before hashing) |
| An early setup or action failure, or an unexecuted required check, cannot count as the intended assertion | Setup and unexecuted checks on Chrome; an action failure's ending as a unit only | Chrome: `participants-identity.test.ts` (`notRun`), `participants-preparation.test.ts` (`setup_failed`); fake: `runner-replay-run.test.ts` (a forged `host_check_failed`, `session_lost` or `outcome_unknown` from the test process ends `test_error`; a host check on a page that never answers ends `check_error`); unit: `runner-fingerprint.test.ts` "the ending of an attempt" |
| Missing required capture, inconclusive evaluation and a late prior-attempt judgment cannot become success | By the evaluation lane, not this one | `evaluation-runs.test.ts`, `evaluation.test.ts` |
| Terminal, JSONL, HTML and host results agree | JSONL and `result.json` agree on the execution record; no HTML yet; terminal output was not compared | Phase 4 |
| A standalone consumer exercises preparation and replay without Rehearsal credentials | From source only: every host program above runs without Rehearsal | Packed-consumer run in Phase 5 |

The participants' cookies and storage are proved by the server's own reading of each session cookie and each page's reading of its own local storage, both read again by the parent's host checks after the body; looks by each `observation` naming its session and never showing another account; screenshots by a banner the task app paints in a colour derived from the signed-in account, read from the PNG.

## Compatibility

`schemaVersion` stays 1 and every change is an optional field or a new event type. A reader built from this tree reads run folders written before it. A reader built before this lane refuses every new run folder: objects reject unknown keys, `test.started` now carries `execution` for every attempt that starts, `test.finished` and each test result carry `ending`, and the three new event types are unknown to it.

## What remains

- Phase 2: preparation and cleanup on the native iOS and macOS fixtures; native app builds in `appBuilds`; native executor identity in `sessions` (the record names web engines only); persistent-data limits.
- Phase 3: the participant, limit, preparation and identity gates on Firefox and WebKit; two fresh defective and two repaired attempts per engine; a real cross-session forged reference; agent sessions under the same owner budget.
- Phase 4: the execution record, check ids and `ending` in HTML and in media artifacts; terminal, JSONL and HTML agreement.
- Phase 5: the standalone replay gates from the packed package; Rehearsal's runner carrying `owner`, `prepare`, `requirement` and `appBuilds` through its result path.
- A session budget is per process. Several Retest processes on one host need a budget each, or a host-wide one that does not exist yet.
- A secret read by a function source is not known when the requirement is checked, so only secrets read from the environment are refused in check content.
- The version a judge reports for itself is known only once it is set up, at its first check, so it is in each check's evaluation record and not in the start fingerprint; a judge named only in a test's own `test.evaluate` is not in the fingerprint either.
- A test that imports late a module an earlier test in the same process already imported does not count it, since Node loads it once.
- Not tested: `waitMs` left to its default; the `setup_failed` class on an attempt that asks for more sessions than the budget holds; cleanup timing against the browser's close under session limits; `browserStorage: 'saved'` in the record; a rebuilt result's `cleanups` and `ending` compared whole; a reader built from this tree reading an older folder, and an older reader refusing a new one (both reasoned from the schemas, not run); participants kept from opening another context or a popup.
- Cleanup runs in the parent, so a parent killed outright (SIGKILL) runs none. After a stop without session limits, cleanup runs before the run closes its browsers, while the attempt's pages may still be open; with session limits, after the attempt has closed them.
- A preparation never called (an earlier one failed, or the run had stopped) is `not_run` and has no cleanup; one stopped while it ran is `cancelled` and its cleanup runs. The cleanup gets the preparation's answer as given; only the record is redacted, and thrown text in either record is cut to 500 characters.
