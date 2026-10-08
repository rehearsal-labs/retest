# Whole unit suite leftovers

The latest locked whole-tree gate has 4,108 tests, 4,103 passed and five failures, with zero cancelled or skipped. Every remaining failure is an unchanged media-install assertion blocked by the stale reviewed `frame.rs` source pin. The required green gate has not been achieved. The concrete correction is prepared for the worker who owns the excluded installer file. Typecheck and type tests pass after the latest whole gate. Nothing recorded by this task remains running.

The baseline is `/tmp/retest-timezone-switch/logs/whole-unit-final.log`: 4,091 tests, 4,081 passed, 10 failed, zero cancelled or skipped. This report records decisions and validation as they happen. Evidence for this task goes under `/tmp/retest-unit-leftovers/`.

Read the repository instructions, README, architecture, common rules, release invariants and native-phase decisions. The early-waits, waits-validation, ownership-cost, timezone-switch, retention, media-install, media-pin refresh and WebKit colour reports supply the change history. Existing work is preserved. The other workers own the evidence integration files, native proofs, HTML reporter and installer source.

## Failure decisions

Locations below are from the baseline. Current locations can move as coverage is added.

| Failure | Verdict and evidence | Change and verification |
| --- | --- | --- |
| `early-process-waits.test.ts:69`, via `early-waits-clock.ts:32` | Stale fixture. The early-waits lane requires a final status read at the deadline. The subsequent native ownership change in `phase-3-closeout-report.md:65` adds asynchronous individual identity readings under one caller deadline. The old fixture replaces the parent process clock with zero while the metadata worker uses its real monotonic clock. It also treats host-I/O scheduling turns as fake readiness time. The delayed saved-fixture check fails at zero, before any readiness probe. | Scope fake deadline readings to the 120 ms readiness budget, using a real `Deadline` with an injected clock. Keep ownership clocks real. Yield to host I/O while retaining the 30,000-turn guard. Pause cleanup at its entry, restore timers, then await actual cleanup. All final-read, failure-class, survivor and `leftRunning` assertions remain. Add required cleanup entry and absence of cleanup failures. |
| `inspect-looks.test.ts:147` | Stale fixture. Retention finding 7 in `codex/phase-4/fix-report-retention-report.md` separates persisted removal requests from confirmed unlink. The fixture has completion and failure events but no request, while asking for request text. | Add the real request event and require distinct request/completion output in order. |
| `media-install.test.ts:45` | Product regression in the shipped source identity. WebKit colour finding 4 deliberately changes `media/src/frame.rs` to normalize supported ICC profiles and refuse invalid profiles. Its current hash is `6c8bc67a093cd190f881ba79aed0727e1989e87939b1758e7e22439685b17efd`; the installer still pins `ee9901dcaefb437b98012e9536d90beee6b40aac6627e72af53ca027e60b5d84`. Refusal is correct for the stale pin. The package integration omitted the reviewed source-pin refresh. | Installer worker requested to refresh the verified frame hash and recomputed aggregate. Keep every installation assertion and source-integrity check. |
| `media-install.test.ts:172` | Same product regression. The source-pin refusal occurs before valid cache reuse and damage diagnostics. The media-pin refresh report establishes strict current-source identity for reuse. | Preserve the reuse, damaged-cache and byte-preservation assertions. Pending other worker's pin correction and unchanged test rerun. |
| `media-install.test.ts:198` | Same product regression. Source mismatch masks the intended damaged-cache refusal. | Preserve the refusal message and untouched-cache checks. Pending pin correction. |
| `media-install.test.ts:230` | Same product regression. Source mismatch masks missing-Cargo, old-rustc and rewritten-lock checks. | Preserve all toolchain and lock-integrity checks. Pending pin correction. |
| `media-install.test.ts:272` | Same product regression. Source mismatch masks the held generation-lock refusal. | Preserve the exact lock-path and command checks. Pending pin correction. |
| `protocol-identity.test.ts:129` | Stale coverage table. Retention finding 7 documents the added `artifact.removal_requested` event. The schema has 53 types but the identity table has 52. | Add the request's exact identity keys, retaining whole-table equality. |
| `protocol.test.ts:607` | Stale coverage inventory. The same documented request event has no sample. | Add its complete sample. Keep exact sample/schema type equality and round-trip checks. |
| `protocol.test.ts:789` | Stale coverage inventory, the same missing sample. This assertion derives 52 from the samples, rather than using a hard-coded count. | The added sample restores coverage. Keep closed-object and required-field assertions. |

The native-folder failure at `native-macos-app.test.ts:513` belongs to the preceding 11-failure gate, not the final ten. The timezone lane already added `startTimeVersion: 1` to its current-format fixture and preserved all cleanup checks. Separate legacy-record tests require retention. This file passes all 31 cases in this task's focused run and passes in the latest whole gate. No assertion in it changed.

The first current-tree whole gate found two further failures during the other workers' edits. Both are included in this task's final gate:

| Failure | Verdict and evidence | Change |
| --- | --- | --- |
| `runner-target-drivers.test.ts:476` | Stale expectation. Decision 2 in `codex/phase-4/report-jump-and-notices-prompt.md` supplies WebKit notices and deliberately leaves the archive checksum unpinned. Doctor now reports the checksum refusal. | Require that exact refusal, rather than the previous missing-notices regex. Keep the empty-cache, no-write and Chromium-only launch assertions. |
| `native-source-retry.test.ts:70` | Product regression in exact budget propagation. The native recording lane's source-retry change promises to hold permanent scope refusal through the original deadline. `NativeInteractionSession.observe` instead turns its remaining fractional budget into whole command milliseconds, then the app session creates another deadline. A controlled failing-first test returns at 119.35 ms for a required 120 ms observation. | Forward the observation's original `Deadline` through the internal source-reading path. Command allocations remain whole and shrink. The existing permanent-tree test uses a controlled clock and retains its full-budget, multiple-read, no-input and no-after-read assertions. Add exact failure-preservation and no-reset checks in the new rounded-allocation case. |

The source-pin inventory independently checked all 21 declared files. Only `frame.rs` differs. `/tmp/retest-unit-leftovers/source-pin-audit.json` computes the required aggregate as `ba7d170a845abf3f6c9338b0c1b370f79294d67c223b195c586207afbeb20bff`; no installer source was edited by this task. The requested other-worker correction remains pending.

The concrete two-value correction is `/tmp/retest-unit-leftovers/media-pin-refresh.patch`, prepared without applying it to the other worker's source. It changes only the independently verified frame hash and aggregate digest. The file allowlist, version, limits, notices, Cargo lock and refusal rules remain identical.

## Commands and results

The benchmark guard runs `pgrep -f benchmarks/run.ts` before every check and again inside the heavy lock. A match or an unreadable guard refuses the command. Gate argv, PIDs, outputs and results are recorded by `/tmp/retest-unit-leftovers/gate.py`; process command observations are stored only as hashes. Final checks remain pending. Snapshots of this task's initial test files are in `/tmp/retest-unit-leftovers/before/`; initial workspace status is `initial-status.txt`.

Completed `python3 /tmp/retest-unit-leftovers/gate.py focused-before node --conditions=retest-source --test --test-concurrency=1 tests/unit/inspect-looks.test.ts tests/unit/protocol-identity.test.ts tests/unit/protocol.test.ts tests/unit/media-install.test.ts tests/unit/early-process-waits.test.ts`, exit 1. Log `/tmp/retest-unit-leftovers/logs/focused-before.log`: 57 tests, 48 passed, 9 failed, zero cancelled/skipped/todo. All four stale coverage failures and five source-pin failures reproduce. The two readiness cases pass in this isolated command.

Completed `python3 /tmp/retest-unit-leftovers/gate.py coverage-after node --conditions=retest-source --test --test-concurrency=1 tests/unit/inspect-looks.test.ts tests/unit/protocol-identity.test.ts tests/unit/protocol.test.ts`, exit 0. Log `/tmp/retest-unit-leftovers/logs/coverage-after.log`: 39 tests, 39 passed, zero failed/cancelled/skipped/todo. The exact protocol type-set equality, round trips, closed schemas and identity checks remain. The timeline retains every previous text assertion and additionally requires request, completion and failure in order.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock whole-before-readiness npm run test:unit`, exit 75. The lock was busy; no test ran. Log `/tmp/retest-unit-leftovers/logs/whole-before-readiness.lock.log`.

Completed `python3 /tmp/retest-unit-leftovers/gate.py readiness-after node --conditions=retest-source --test --test-concurrency=1 tests/unit/early-process-waits.test.ts tests/unit/native-macos-app.test.ts`, exit 1. Log `/tmp/retest-unit-leftovers/logs/readiness-after.log`: 33 tests, 32 passed, 1 failed, zero cancelled/skipped/todo. The unchanged native macOS fixture file passes all 31 cases, including current-format folder cleanup. The first readiness correction still lets setup's short `ps` commands use the fake ownership clock and fails on the metadata deadline. This attempt is superseded by the scoped-clock correction.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock whole-before-readiness-2 npm run test:unit`, exit 1. It expands to `lockf -t 0 /tmp/retest-heavy-gate.lock /opt/homebrew/opt/python@3.14/bin/python3.14 /tmp/retest-unit-leftovers/gate.py --inside whole-before-readiness-2 npm run test:unit`. Log `/tmp/retest-unit-leftovers/logs/whole-before-readiness-2.log`: 4,103 tests, 4,095 passed, 8 failed, zero cancelled/skipped/todo. This exploratory gate ran while the scoped-clock fixture was still being corrected. It verifies the four coverage failures are gone, reproduces the five unchanged media pin failures, and identifies the two additional failures above. It is not the final gate.

Completed `python3 /tmp/retest-unit-leftovers/gate.py source-deadline-before node --conditions=retest-source --test --test-name-pattern='a permanent another-app tree' tests/unit/native-source-retry.test.ts`, exit 0, 1/1 passed, zero cancelled/skipped/todo, `/tmp/retest-unit-leftovers/logs/source-deadline-before.log`. The original timing failure is intermittent; the controlled rounded-allocation test below supplies the discriminating failing-first evidence.

Completed `python3 /tmp/retest-unit-leftovers/gate.py source-rounded-before node --conditions=retest-source --test --test-name-pattern='a source refusal after a rounded' tests/unit/native-source-retry.test.ts`, exit 1, 0/1 passed, 1 failed, zero cancelled/skipped/todo. Log `/tmp/retest-unit-leftovers/logs/source-rounded-before.log` records preserved scope refusal at 119.35 ms, before the required 120 ms. No product correction preceded it.

Readiness fixture experiments all ran `python3 /tmp/retest-unit-leftovers/gate.py <name> node --conditions=retest-source --test --test-name-pattern='native executor readiness' <file>`:

| Name and log under `/tmp/retest-unit-leftovers/logs/` | File | Exit and counts |
| --- | --- | --- |
| `readiness-delayed-before.log` | `/tmp/retest-unit-leftovers/readiness-delayed-before.test.ts` | Exit 1, 0/1 passed, 1 failed. Saved original fixture, delayed before clock mocking, exhausts host turns at zero. |
| `readiness-only-after.log` | `tests/unit/early-process-waits.test.ts` | Exit 0, 1/1 passed. Initial cleanup-only clock restoration; not sufficient for setup. |
| `readiness-delayed-after.log` | `/tmp/retest-unit-leftovers/readiness-delayed-after.test.ts` | Exit 1, 0/1 passed, 1 failed. Host yielding alone still leaves the wrong ownership clock. |
| `readiness-delayed-after-2.log` | `/tmp/retest-unit-leftovers/readiness-delayed-after-2.test.ts` | Exit 1, 0/1 passed, 1 failed. Intermediate getter-wrapper error, not defect evidence. |
| `readiness-scoped-clock.log` | `tests/unit/early-process-waits.test.ts` | Exit 1, 0/1 passed, 1 failed. Same intermediate getter-wrapper error; corrected by retaining the real getter descriptors. |
| `readiness-scoped-clock-2.log` | `tests/unit/early-process-waits.test.ts` | Exit 0, 1/1 passed. Final scoped clock preserves setup and cleanup readings. |
| `readiness-delayed-final.log` | `/tmp/retest-unit-leftovers/readiness-delayed-final.test.ts` | Exit 0, 1/1 passed. Same delayed setup as the saved failing fixture, with all readiness and cleanup assertions intact. |

Every readiness experiment has zero cancelled/skipped/todo cases. The delayed fixtures wait 6,100 ms before clock mocking to place real ownership-worker time beyond the fake parent's metadata bound. These are stand-ins, not native platform proofs. No readiness product code changed.

Completed `python3 /tmp/retest-unit-leftovers/gate.py source-rounded-after node --conditions=retest-source --test --test-concurrency=1 tests/unit/native-source-retry.test.ts tests/unit/native-source-scope.test.ts tests/unit/native-session.test.ts tests/unit/runner-target-drivers.test.ts`, exit 0, 83/83 passed, zero failed/cancelled/skipped/todo. Log `/tmp/retest-unit-leftovers/logs/source-rounded-after.log`. This includes the new rounded-allocation regression, all source-scope and lifecycle checks, shrinking source command budgets, cancellation, malformed-tree refusal and the exact updated WebKit doctor refusal.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock typecheck npm run typecheck`, exit 75, lock busy, no compiler ran. Log `/tmp/retest-unit-leftovers/logs/typecheck.lock.log`.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock typecheck-2 npm run typecheck`, exit 2. Log `/tmp/retest-unit-leftovers/logs/typecheck-2.log`. The compiler found this task's index-signature access `details.also`; it now uses `details['also']`. No assertion or type was weakened.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock typecheck-final npm run typecheck`, exit 0. Log `/tmp/retest-unit-leftovers/logs/typecheck-final.log`. Both root compilers and the example project pass.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock test-types npm run test:types`, exit 0. Log `/tmp/retest-unit-leftovers/logs/test-types.log`. TypeScript 6.0.3 and 7.0.2 each match 241 expected errors to 241 markers in 10 projects.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock whole-after-deadlines npm run test:unit`, exit 1. Log `/tmp/retest-unit-leftovers/logs/whole-after-deadlines.log`: 4,108 tests, 4,102 passed, 6 failed, zero cancelled/skipped/todo. The original coverage and readiness failures, added native-source deadline regression and updated WebKit doctor case all pass in the whole tree. Five remaining failures are the unchanged media-pin cases. The sixth is `builds-lock.test.ts:292`, whose unchanged cancellation bound requires less than 5,000 ms and observed 5,045 ms. Its exact stopped result and empty lock-folder assertions pass.

Completed `python3 /tmp/retest-unit-leftovers/gate.py lock-cancel-focused node --conditions=retest-source --test --test-name-pattern='a stop while a process' tests/unit/builds-lock.test.ts`, exit 0, 1/1 passed, zero failed/cancelled/skipped/todo. Log `/tmp/retest-unit-leftovers/logs/lock-cancel-focused.log`. No cancellation product code or test assertion changed. The whole-tree timing failure remains unresolved, not cleared by the isolated pass.

The initial gate wrapper sampled the complete process table in both its lock parent and command child. That extra host work can interfere with real-time bounds, but it is not proven to explain the cancellation failure. Further full-tree gates use the spawn preload alone during execution and a separate final read-only process audit. The benchmark guard and shared lock are unchanged.

Completed `python3 /tmp/retest-unit-leftovers/audit.py > /tmp/retest-unit-leftovers/logs/audit-interim.log`, exit 0. All observed and spawned process identities and detached groups are gone, and all nine scoped source hashes still match `/tmp/retest-unit-leftovers/validation-sources.json`. The audit sends no signals. Final gates and the final audit remain pending.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock whole-spawn-only npm run test:unit`, exit 1. Output is `/tmp/retest-unit-leftovers/logs/whole-spawn-only.log`: 4,108 tests, 4,103 passed, 5 failed, zero cancelled/skipped/todo. It uses the original npm script and its normal concurrency, through the same shared lock, with no periodic process-table sampler. All failures are the five unchanged media cases. Readiness, exact native-source budgets, current-format native folder cleanup, retention/protocol coverage, the updated doctor refusal and the unchanged install-cancellation bound all pass. No cancellation assertion changed; this result does not establish the cause of the earlier timing failure.

The installer worker's file is explicitly excluded by the task. An asynchronous question requests that worker apply the prepared patch, or a new user scope decision after its installer work finishes. Until then this task does not alter the excluded file or bypass its source check.

## Latest checks and remaining work

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock typecheck-after-unit npm run typecheck`, exit 0. Log `/tmp/retest-unit-leftovers/logs/typecheck-after-unit.log`. Both root compilers and the example project pass after the latest whole-unit gate.

Completed `python3 /tmp/retest-unit-leftovers/gate.py --lock test-types-after-unit npm run test:types`, exit 0. Log `/tmp/retest-unit-leftovers/logs/test-types-after-unit.log`. Each of TypeScript 6.0.3 and 7.0.2 matches 241 expected errors to 241 markers in 10 projects.

Completed `python3 /tmp/retest-unit-leftovers/audit.py > /tmp/retest-unit-leftovers/logs/audit-final.log`, exit 0. The audit checks 12,723 observed identities, 43,546 spawned PIDs and 35,926 recorded detached groups. It finds zero live recorded identities, zero unconfirmed live PIDs, zero remaining group members and zero changed scoped sources. No signal was sent. The final `pgrep -f benchmarks/run.ts` returns 1 with no matches, recorded in `logs/benchmark-final.json`. The scoped `git diff --check` exits 0, `logs/diff-check-final.log`; final workspace inventory is `final-status.txt`.

The gate wrapper's actual argv and PIDs are in `commands.jsonl`, each gate's exit and counts in its `.result.json`, and outputs under `logs/`. An occupied lock returns 75 without starting a check. Every successful heavy command explicitly passes through `lockf -t 0 /tmp/retest-heavy-gate.lock` and an inside-lock benchmark guard.

Remaining work is to apply the verified two-value media pin correction in the installer worker's scope, then rerun unchanged `npm run test:unit` through the shared lock to require zero failures and zero skips. That green whole-tree result remains unverified. No test outcome, deadline assertion, source check, required identity, failure-preservation check or cleanup requirement was removed or weakened. The task edited no evidence integration file, HTML reporter source or installer source. No benchmark, download, commit, push, stash, reset or revert ran. No native desktop or simulator proof, physical device or other operating system was exercised by this task.
