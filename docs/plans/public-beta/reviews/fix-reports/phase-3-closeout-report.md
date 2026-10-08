# Phase 3 closeout report

## Final result

The assigned implementation and verification work is finished with open findings. Phase 3 is not declared green: the unchanged native blocking-read unit fails, and the four retained intermittents were not diagnosed by these reproductions.

| Check | Observed result | Final evidence under `/tmp/retest-phase-3-closeout/` |
| --- | --- | --- |
| Cross-platform flow | Chrome 2/2, Firefox 2/2; corrected WebKit rerun 2/2. Initial full file 5/6 is retained. | `reference-flow-engines.log`, `reference-flow-webkit.log`, eight kept artifact folders listed in `flow-coverage-final.json` |
| Requested focused reproductions | Each of four cases 10/10; current Firefox loss repeated another 10/10. Original filtered suite-hook failures are retained separately. | `loops/<case>/round-<N>.log`; WebKit raw events/results retained per round |
| Historical helper cost | Each consumer has a 100-dead-helper/one-live-root read-count unit; individual readings target the live root only. | `ownership-consumers.log`, `ownership-safety.log`, `firefox-units-final.log`, `firefox-orphan-final.log` |
| Original consumer unit gate | 80/81, zero skips; native assertion at `tests/unit/native-processes.test.ts:699` requires `Atomics.wait`, whereas the immediate identity reader now awaits `Atomics.waitAsync`. Assertion retained. | `ownership-consumers.log` |
| Final Firefox / orphan units | 27/27 and 15/15, zero skips. Two final orphan deadline guards fail first. | `firefox-units-final.log`, `firefox-orphan-*-before.log`, `firefox-orphan-final.log` |
| Real close paths | Firefox 8/8, WebKit 11/11, iOS simulator 9/9, media client 32/32; zero skips. | `real-close-<target>.log`, identity records under `identities/` |
| Relevant compiler gates | Both root compilers, both media proof compilers and task example compiler exit 0. Initial concurrent-file errors are preserved. | `compile-*-final.log`, `compile-media-*.log`, `compile-examples.log` |
| Final cleanup | 256 recorded PIDs checked; zero live, group members, retained owned folders or simulators. Eight ownership source hashes and media build input/artifact hashes match. | `final-process-audit.json`, `compile-root-final-gate.log`, `ownership-sources-final.json`, `media-build-artifact.json` |

No covering-window refusal occurred in the eight kept flow event files. No coverage check was bypassed, and no foreign window was moved or ended. Firefox ran through Launch Services. Media used an isolated offline build after its default stale-binary prerequisite refusal; no media source or default target directory was changed by this lane.

The four saved failures remain failures, with no new declaration, budget or matcher change. Their measured reproduction outcomes do not establish a cause or a worst-case timing guarantee. Exact retained paths, source boundaries and hypotheses are recorded below. No full shared-engine suite or full conformance suite was rerun by this lane; no physical iOS device, Android or other host was verified. The full six-case flow file was not repeated after the harness correction: its affected WebKit variants were rerun, while the four original Chrome/Firefox outer checks already passed.

Implementation and evidence remain in the workspace. Nothing was committed, stashed, reset, reverted, published or downloaded. There is no queued heavy command or owned target left running.

The entries below are the running log; later results supersede earlier pending states.

Run started 6 October 2026 at 07:48:09 UTC. The user imposed a hard two-hour limit. No benchmark, download, commit, stash, reset or revert is authorized. Heavy commands and all simulator/desktop use go through `/tmp/retest-heavy-gate.lock`.

## Step 0: handoff and workspace

Read `AGENTS.md`, `README.md`, `docs/architecture.md`, common rules, the engine differences report/state, ownership cost report, release invariants and Phase 2 requirements, and the 6 October stop point. Existing changes are preserved. Assigned source excludes shared ownership, runner, capture, common actionability and Firefox accessible names.

Retained failures remain failures. WebKit expects the pinned revision `2359`; no budget or matcher changes are allowed. Firefox real runs use Launch Services. Wispr Flow coverage refusals will be recorded without moving or ending its window.

Exact commands and evidence are appended below as each operation completes. Scratch scripts and logs live in `.retest/scratch-phase-3-closeout/` and `/tmp/retest-phase-3-closeout/`.

## Step 1: flow dispatch

Command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/flow.sh`. The wrapper checks the executable identity of `pgrep -f benchmarks/run.ts` candidates, takes `lockf -t 0 /tmp/retest-heavy-gate.lock`, imports the runner, then executes `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/reference-flow-engines.test.ts`. Logs: `/tmp/retest-phase-3-closeout/flow-gate.log`, `runner-load.log`, `reference-flow-engines.log`, `flow-process.log`. Pending.

## Step 2: retained evidence and hypotheses

Read round 2 Firefox actions and hang logs, round 8 Firefox actions, and retained WebKit events/results for conformance 5 web and conformance 7 workflow. Paths are under `/tmp/retest-engine-differences-review/`. The shared-suite rounds retain text logs, without a per-command protocol trace.

- Firefox browser loss: round 2 preserves `cleanup_failed`, "Process group 57770 contains processes whose launch ownership could not be verified; they were left alone." Hypothesis: a helper forks before the crash and becomes reparented before ancestry capture. Group membership cannot grant ownership.
- Firefox checkbox: round 8 preserves `not_actionable`, "Could not check getByLabel('Newsletter'): Retest clicked its label once, and then no single control it matched showed whether it is checked. Retest does not click again." Hypothesis: the post-click read loses its control or deadline while shared lookup runs; no second click is permitted.
- WebKit A11: `conformance5/kept/webkit/web/run/events.jsonl`, sequence 388, duration 751 ms, timeout 500 ms, correct `not_actionable/visible` refusal. Hypothesis: parent reporting or synchronous ownership metadata delays settlement. The 250 ms overhead stays unchanged.
- WebKit F7.3: `conformance7/kept/webkit/workflow/run/events.jsonl`, sequence 500, duration 1502 ms, timeout 1500 ms, `inputSent: false`, exact select Free timeout. Hypothesis: a protocol/actionability read stalls before dispatch.

## Step 3: consumer inspection

Shared ownership already prunes historical records on successful snapshots. Remaining synchronous live-PID queries exist in Firefox, WebKit, native and media ordinary close paths. WebKit also rereads a table for each recorded helper. Firefox orphan sweeping currently signals child PIDs after a table snapshot without a fresh per-child identity reading. These are inspected defects, not yet fixed or validated.

### Firefox consumer change and failing-first check

`node --conditions=retest-source --test --test-name-pattern='prunes 100 dead' tests/unit/firefox-process.test.ts` failed 0/1 before the change. Log `/tmp/retest-phase-3-closeout/firefox-history-before.log` names synchronous cleanup table reads. Ordinary stop now awaits shared signalling/liveness and forwards one cleanup deadline into metadata, with fresh synchronous snapshots retained only for crash/exit paths. Firefox per-PID async reads use the same columns, environment and sentinel. Deadline-bound table reads are not coalesced with unbounded background reads. Orphan cleanup checks each live candidate immediately before its signal. Existing assertions are unchanged. Validation command `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-process.test.ts tests/unit/firefox-process-table.test.ts tests/unit/firefox-orphans.test.ts`, log `firefox-ownership-after.log`, is running.

Chrome positive flow passed, artifacts `/Users/dragon/Library/Caches/retest-proofs/artifacts/reference-flow-engines/chromium/run-VqgtPj`. Remaining flow cases are running.

### Ownership unit results and remaining validation

Firefox existing process, process-table and orphan tests plus the added history case pass 17/17, zero skips, in `firefox-ownership-after.log`.

WebKit history case failed first on synchronous cleanup reads, `webkit-history-before.log`, then passed 1/1 in `webkit-history-after.log`. A WebKit process-table adapter now shares one awaited liveness snapshot across helper owners, retains failed readings, and supplies awaited live-PID identity checks. Dead helper owners are excluded from later passes. Exit hooks stay synchronous and retain the home while any helper may remain.

Native history case failed first on synchronous cleanup readings, `native-history-before.log`; after ordinary signalling/liveness were changed to awaited shared methods with one budget, it passes 1/1 in `native-history-after.log`. The native host supplies async individual readings using unchanged columns, environment and sentinel.

Media history and reuse cases failed first, `media-history-before.log`. The internal media ownership host now supplies async individual readings. Ordinary close, startup failure, protocol failure and encoder reclamation await identity-checked signalling and liveness under caller budgets. Added units pass 3/3 in `media-history-after.log`. The internal factory accepts metadata readers for deterministic testing; no package export or runtime dependency was added. Existing media tests still need their real binary run.

Exact focused commands use `node --conditions=retest-source --test --test-name-pattern=...` with the named unit files. Full original consumer files, compiler checks, real close paths and intermittent loops are pending.

Chrome broken-sync flow passed its outer check and retained the required inner exit 1, artifacts `chromium-broken-sync/run-V7ggx2`. Firefox positive flow passed through Launch Services, artifacts `firefox/run-Qn9uVw`. The flow is still the only heavy command.

### Targeted reproduction command preparation

The focused WebKit wrapper runs the original fixture case with `--grep`, original 1500 ms action budget, A11's own 500 ms budget, and `judgeGroupRecord` for its unchanged outcome and facts. It also requires exactly one test result and the exact CLI exit. It copies each run folder before harness cleanup. No production conformance case or matcher was edited.

Ten runs per case will use `.retest/scratch-phase-3-closeout/loops.sh` inside the lock. Firefox commands are `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='a browser lost between the key down and the key up' tests/integration/firefox-browser-actions.test.ts` and the same command with pattern `a hidden checkbox is checked through its styled label`. WebKit commands are `env RETEST_FIREFOX_ROUTE=launch-services RETEST_CLOSEOUT_CASE=A11 RETEST_CLOSEOUT_KEEP=<round-folder> node --conditions=retest-source --test --test-concurrency=1 .retest/scratch-phase-3-closeout/intermittent-conformance.test.ts`, repeated for `F7.3`. These are reproductions of one requested case each; omitted cases are not counted as passes. Logs and kept WebKit runs go to `/tmp/retest-phase-3-closeout/loops/<case>/round-<N>`. Counts append after each round.

The full existing ownership consumer unit command is now running, log `/tmp/retest-phase-3-closeout/ownership-consumers.log`. Added Firefox orphan cases require fresh live-root reading after 100 dead helper rows, refuse a helper reused between snapshot and signal, and retain the folder on failed identity reading.

### Existing consumer-unit gate

`node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-process.test.ts tests/unit/firefox-process-table.test.ts tests/unit/firefox-orphans.test.ts tests/unit/webkit-process.test.ts tests/unit/native-processes.test.ts tests/unit/media-ownership.test.ts` ended at 80/81, zero skips. Log `/tmp/retest-phase-3-closeout/ownership-consumers.log`. The only failure is the unchanged native test at `tests/unit/native-processes.test.ts:699`, which counts only `Atomics.wait` and requires stop to make a blocking reading. The new host reads the identity with `Atomics.waitAsync`; the added deterministic native history case proves the immediate identity-before-signal order and one live-root reading. This is a harness expectation in conflict with awaited cleanup, not a missing identity check. The existing assertion is retained unchanged as requested, so the unit gate is not green.

- Ownership safety units: exit 0; ℹ tests 18; ℹ pass 18; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/ownership-safety.log`.

Firefox broken-sync flow passed its outer check and retained the required inner failure at the desk, artifacts `/Users/dragon/Library/Caches/retest-proofs/artifacts/reference-flow-engines/firefox-broken-sync/run-tmqmkI`. No covering-window refusal was found in the four completed flow event files. Coverage audit folder list is `/tmp/retest-phase-3-closeout/flow-coverage-partial.json`. WebKit is running.

Source hashes for the seven ownership implementation files are recorded in `/tmp/retest-phase-3-closeout/ownership-sources.json`, before real close-path validation.

WebKit positive flow produced an inner passed result, exit 0, with 20 assertions. Its outer Node check failed and the file is still running its broken-sync case, so the detailed outer failure is pending the Node summary. Artifacts `/Users/dragon/Library/Caches/retest-proofs/artifacts/reference-flow-engines/webkit/run-Zgiyph`. The old native setup failure has not recurred in this positive run. The recorded WebKit revision is exactly `2359`, and rebuilding the result from events agrees. No passing outer result is claimed.

- All-engine flow before harness correction: exit 1; ℹ tests 6; ℹ pass 5; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/reference-flow-engines.log`.

### All-engine flow result and test defect

The locked six-case file finished at 5/6 outer checks, zero skips. Chrome and Firefox positive/broken cases pass. WebKit broken passes, artifacts `webkit-broken-sync/run-gMU3ww`. WebKit positive inner flow passes, but its outer cleanup check at `tests/integration/reference-flow-engines.test.ts:219` misidentifies another worker's fake xcodebuild processes as processes this flow started. The failure lists PID 66212, `/bin/sh .../retest-native-fake-1G1wnb/bin/xcodebuild ...`, and PID 66217, `node .../tests/unit/native-fake-tool.ts xcodebuild ...`. Neither is the real selected Xcode executable. No such process was ended. This is a test defect under concurrent unit runs. The native setup failure did not recur. The harness will identify the actual executor executable rather than any argument containing its name. Assertions requiring all owned real processes gone remain.

- Flow process identification unit: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/reference-flow-processes-unit.log`.

The flow harness now resolves `selectedXcodebuild(systemTools)` and requires the process command to begin with that exact executable, including the argument boundary. The regression unit retains both failed fake process forms and checks that the real executable is found. The real failing-first six-case flow remains in its log. WebKit positive and broken-sync variants are queued together through the lock with `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='web on WebKit' tests/integration/reference-flow-engines.test.ts`. Logs `/tmp/retest-phase-3-closeout/flow-webkit-gate.log`, `reference-flow-webkit.log`, `flow-webkit-process.log`. No flow assertion was removed or widened.

- Firefox WebKit media and flow helper units: exit 0; ℹ tests 19; ℹ pass 19; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/ownership-short-final.log`.

The follow-up short consumer gate passed 19/19, zero skips, log `ownership-short-final.log`. Firefox browser close now creates its deadline before descendant recording and forwards the same object to process stop, rather than giving ownership a renewed budget. WebKit's browser caller at `src/browser/webkit/browser.ts:248` still records helpers before its own close call without an outer ownership deadline; that caller is outside this assignment. Its process signal and liveness steps share an internal budget; helper discovery still uses its existing synchronous, separately bounded readers, so no whole-close caller-bound claim is made.

A Firefox caller-deadline regression also fails against a scratch copy with the former two call sites, then passes against the changed caller. The scratch only restores those call sites and resolves imports to the live modules; no working source is replaced. Commands `node --conditions=retest-source --test --test-name-pattern='forwards one existing deadline' .retest/scratch-phase-3-closeout/firefox-browser-before.test.ts` and `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-browser.test.ts tests/unit/firefox-process.test.ts`. Logs `firefox-close-budget-before.log` and `firefox-close-budget-after.log`.

- Firefox close caller budget before: exit 1; ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/firefox-close-budget-before.log`.

- Firefox close caller budget after: exit 0; ℹ tests 9; ℹ pass 9; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/firefox-close-budget-after.log`.

`/tmp/retest-phase-3-closeout/flow-inner-results.json` records all six inner ends from versioned events: three positive passes with exit 0 and three broken-sync failures with exit 1. These do not turn the failed WebKit outer cleanup check into a pass. The corrected rerun remains waiting for the shared lock; no second heavy command is queued.

- WebKit flow after process identification fix: exit 0; ℹ tests 2; ℹ pass 2; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/reference-flow-webkit.log`.

The corrected WebKit flow passed 2/2 outer checks, zero skips. Positive artifacts `webkit/run-Nsc0J5`; broken-sync artifacts `webkit-broken-sync/run-XGKo3o`. Thus Chrome and Firefox each passed their two original outer checks and WebKit passed both after the harness correction. All inner required outcomes remain intact. The old setup failure did not recur. Firefox loss is now the sole heavy run: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/loops.sh firefox-loss`, gate log `/tmp/retest-phase-3-closeout/firefox-loss-gate.log`.

- firefox-loss round 1: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-1.log`.

- firefox-loss round 2: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-2.log`.

- firefox-loss round 3: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-3.log`.

- firefox-loss round 4: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-4.log`.

- firefox-loss round 5: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-5.log`.

- firefox-loss round 6: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-6.log`.

- firefox-loss round 7: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-7.log`.

- firefox-loss round 8: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-8.log`.

- firefox-loss round 9: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-9.log`.

- firefox-loss round 10: exit 1; ℹ tests 2; ℹ pass 1; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-10.log`.

### Focused Firefox harness coverage refusal

The original filtered browser-actions file executes the requested case successfully, then fails its global after-hook because seven unrelated declared cases did not run (`tests/integration/engine-expectations.ts:314`). This is preserved in every original round log; it is not the retained browser-loss cleanup failure. The one-case reproduction will use scratch files containing the exact original test bodies (loss at `browser-actions.test.ts:726`, checkbox at `:901`) and the unchanged helper/cleanup code they call. No production declaration check was edited or bypassed for a full-suite claim. Body hashes and source lines are in `/tmp/retest-phase-3-closeout/focused-case-sources.json`. The scratch commands hold the same assertions and budgets, and contain no difference declarations.

The original loss loop finished: ten target cases passed their full case and cleanup checks; all ten commands exited 1 solely on the unrelated suite-coverage after-hook (each 1 passed, 1 failed). Logs were moved together to `/tmp/retest-phase-3-closeout/loops/firefox-loss-filtered-suite/`, including owned-process records. A fresh ten-case run now uses `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='a browser lost between the key down and the key up' .retest/scratch-phase-3-closeout/firefox-loss.test.ts`. Checkbox will analogously use its scratch copy with its original name pattern.

- firefox-loss round 1: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-1.log`.

- firefox-loss round 2: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-2.log`.

- firefox-loss round 3: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-3.log`.

- firefox-loss round 4: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-4.log`.

- firefox-loss round 5: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-5.log`.

- firefox-loss round 6: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-6.log`.

- firefox-loss round 7: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-7.log`.

- firefox-loss round 8: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-8.log`.

- firefox-loss round 9: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-9.log`.

- firefox-loss round 10: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-10.log`.

The focused Firefox loss loop passes ten commands in a row, each 1/1 with zero skips and exit 0. No ownership refusal recurred. This does not diagnose or erase the kept round-2 failure. Logs `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-1.log` through `round-10.log`; gate `firefox-loss-focused-gate.log`. Firefox checkbox is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/loops.sh firefox-checkbox`, gate `/tmp/retest-phase-3-closeout/firefox-checkbox-gate.log`.

- firefox-checkbox round 1: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-1.log`.

- firefox-checkbox round 2: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-2.log`.

- firefox-checkbox round 3: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-3.log`.

- firefox-checkbox round 4: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-4.log`.

Inspected the prior scratch suite/conformance wrappers at `.retest/scratch-engine-differences-review/suites.sh` and `conformance.sh`, and inventoried `.retest/scratch-engine-differences*`; the retained raw run folders and round logs are under `/tmp/retest-engine-differences-review/`, not duplicated into those script folders. A final event audit covers all eight flow run folders (original six plus corrected WebKit two): no covering-window refusal was emitted. Audit `/tmp/retest-phase-3-closeout/flow-coverage-final.json`. No foreign window was moved or ended and no capture coverage rule changed. Ownership source hashes for eight implementation files are refreshed in `ownership-sources-final.json` before close-path validation.

- firefox-checkbox round 5: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-5.log`.

- firefox-checkbox round 6: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-6.log`.

- firefox-checkbox round 7: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-7.log`.

- firefox-checkbox round 8: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-8.log`.

- firefox-checkbox round 9: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-9.log`.

- firefox-checkbox round 10: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-10.log`.

Firefox styled-label checkbox passes ten focused commands, each 1/1, zero skips, exit 0. Every original assertion holds: checked state, one label click and one control click, then uncheck state. The retained unread-state refusal did not recur and remains undiagnosed. Logs `/tmp/retest-phase-3-closeout/loops/firefox-checkbox/round-1.log` through `round-10.log`. A11 is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/loops.sh A11`, gate `/tmp/retest-phase-3-closeout/A11-gate.log`.

Close-path commands are prepared as `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/real-close.sh <firefox|webkit|ios|media>`. They execute the unchanged driver/lifecycle/media files serially with `--test-concurrency=1`. A scratch preload records PIDs, already-returned verified starts, executable names and owned folders, without adding process readings or logging arguments, application text or environment values. Identity logs will be `/tmp/retest-phase-3-closeout/identities/<target>/identities-<host-pid>.jsonl`; command/log details are in the retained script. No close-path command is yet queued.

- A11 round 1: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-1.log`.

- A11 round 2: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-2.log`.

- A11 round 3: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-3.log`.

- A11 round 4: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-4.log`.

- A11 round 5: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-5.log`.

- A11 round 6: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-6.log`.

- A11 round 7: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-7.log`.

- A11 round 8: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-8.log`.

- A11 round 9: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-9.log`.

- A11 round 10: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/A11/round-10.log`.

WebKit A11 passes ten commands, each 1/1, zero skips, exit 0, while each inner CLI preserves its required failure exit 1. Every original conformance difference list is empty. Kept events/results are `/tmp/retest-phase-3-closeout/loops/A11/round-<1..10>/run/`; action measurements are `loops/A11/observed-actions.json`. The retained 751 ms overrun did not recur and remains undiagnosed. F7.3 is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/loops.sh F7.3`, gate `/tmp/retest-phase-3-closeout/F7.3-gate.log`.

- F7.3 round 1: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-1.log`.

- F7.3 round 2: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-2.log`.

- F7.3 round 3: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-3.log`.

- F7.3 round 4: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-4.log`.

- F7.3 round 5: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-5.log`.

- F7.3 round 6: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-6.log`.

- F7.3 round 7: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-7.log`.

- F7.3 round 8: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-8.log`.

- F7.3 round 9: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-9.log`.

- F7.3 round 10: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/F7.3/round-10.log`.

WebKit F7.3 passes ten commands, each 1/1, zero skips, exit 0; all ten inner CLI results preserve exit 0 and empty original conformance difference lists. Kept events/results `/tmp/retest-phase-3-closeout/loops/F7.3/round-<1..10>/run/`. All four requested focused loops have now completed ten valid cases. No intermittent reproduced. The saved four failures remain failures and have no new declaration.

### Intermittent source boundaries and remaining uncertainty

Loss ownership refusal originates at `src/shared/process-ownership.ts:399`, after ancestry capture at `:158`; Firefox crash/close calls it through `src/browser/firefox/process.ts` and descendants are captured at `:149`. A reparented unobserved helper remains a hypothesis, not a diagnosed cause. Checkbox post-click verification is `src/browser/firefox/page.ts:772`; unread state is retained at `src/browser/checked-state.ts:54`, after the read at `:37`. A11 elapsed action reporting is `src/runner/running-test.ts:483`, while its unchanged late-bound check is `tests/conformance/execute.ts:725`; its fixture click is `fixtures/conformance/web/actionability.retest.ts:28`. F7.3 requests Free at `fixtures/conformance/workflow/f07-selection.retest.ts:44`; WebKit selection begins at `src/browser/webkit/page.ts:793`, performs pre-input reads at `:799` and `:804`, and reports the timeout and input dispatch state at `:606`. Aggregate kept events cannot identify which protocol read stalled. No local action implementation was changed on these hypotheses.

Firefox close-path verification is now the sole heavy command, through `locked.sh real-close.sh firefox`. Its exact inner command is `env RETEST_FIREFOX_ROUTE=launch-services RETEST_CLOSEOUT_IDENTITIES=/tmp/retest-phase-3-closeout/identities/firefox NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-phase-3-closeout/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-driver.test.ts`. Log `/tmp/retest-phase-3-closeout/real-close-firefox.log`, gate `real-close-firefox-gate.log`.

- firefox real close path: exit 0; ℹ tests 8; ℹ pass 8; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-firefox.log`.

Firefox real driver file passes 8/8, zero skips, exit 0 on Firefox 133.0.3 build 20241209150345 through Launch Services. The close/profile case and orphan sweeper case both pass; the swept launch report has one ended PID, one removed folder, no kept folder or problem. Log `/tmp/retest-phase-3-closeout/real-close-firefox.log`. The final identity audit will independently check the recorded PIDs/folders.

F7.3 Free durations across the ten kept runs are 1059–1074 ms, `loops/F7.3/observed-actions.json`. Source inspection adds a narrower hypothesis: the shared type-ahead plan retains a 1100 ms quiet window at `src/browser/page-scripts.ts:317`, consumed by WebKit at `src/browser/webkit/page.ts:820`; remaining pre-input reads can spend the rest of 1500 ms. The quiet window is required keyboard behavior and was not shortened. These passing observations do not prove that was the saved timeout cause.

WebKit is now the sole heavy close-path command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/real-close.sh webkit`. The inner command has the same recorded environment/preload and flags as Firefox, with identities `/tmp/retest-phase-3-closeout/identities/webkit` and file `tests/integration/webkit-driver.test.ts`. Logs `real-close-webkit.log`, `real-close-webkit-gate.log`.

Firefox independent close audit: 11 recorded root/helper/host PIDs checked, 0 live; 0 recorded folders remain. `/tmp/retest-phase-3-closeout/firefox-close-audit.json`. The real driver assertions cover groups/profile state separately. No process was signalled by this audit.

- webkit real close path: exit 0; ℹ tests 11; ℹ pass 11; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-webkit.log`.

WebKit real driver passes 11/11, zero skips, exit 0. The outside-group helper close case, crash cleanup and killed-launcher home sweep all pass. The repeated deadline case also preserves 200 refusal checks under its original 60 ms budgets. Independent audit: 60 recorded root/helper/host PIDs checked, 0 live, 0 recorded folders remain; `/tmp/retest-phase-3-closeout/webkit-close-audit.json`. Logs `real-close-webkit.log` and `real-close-webkit-gate.log`.

iOS real simulator lifecycle is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/real-close.sh ios`. Exact inner command keeps the same preload/flags with identity folder `/tmp/retest-phase-3-closeout/identities/ios` and file `tests/integration/native-ios-lifecycle.test.ts`. Logs `real-close-ios.log` and `real-close-ios-gate.log`. No simulator starts before this command owns the lock.

Compiler commands are prepared, not queued: `node_modules/typescript/bin/tsc -p tsconfig.json`, `node_modules/typescript-7/bin/tsc -p tsconfig.json`, both compilers with `-p proofs/media/tsconfig.json`, and TypeScript 6 with `-p examples/tasks/tsconfig.json`. They run separately inside one locked serial script so a failure does not suppress a later check. Root checks cover the changed driver/native source and unit/integration harness. The media proof check covers its unchanged real client tests.

Independent flow browser audit checks all 8 browser PIDs reported by the eight flows: 0 live. `/tmp/retest-phase-3-closeout/flow-browser-audit.json` also lists the 8 simulator UDIDs whose deletion the original flow harness required. No native tool or simulator is started by this read-only PID check.

The first iOS lifecycle suite completed its eight original cases and its runtime cleanup successfully. The same file is still running the second-runtime app-data/keychain isolation case under the same lock; no whole-file result is claimed yet.

- ios real close path: exit 0; ℹ tests 9; ℹ pass 9; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-ios.log`.

iOS real lifecycle passes 9/9 across two suites, zero skips, exit 0. All three simulator runtimes pass their deletion/process/port cleanup checks; app-data and keychain isolation also pass. The independent PID audit checks 4 recorded executor/host PIDs, 0 live; `/tmp/retest-phase-3-closeout/ios-close-audit.json`. Log `real-close-ios.log`. This is a real iOS 26.5 simulator and WebDriverAgent lifecycle proof, not a physical-device claim.

Media is now the sole heavy close-path command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/real-close.sh media`. Exact inner command keeps the same preload/flags with identity folder `/tmp/retest-phase-3-closeout/identities/media` and file `proofs/media/client.test.ts`. Logs `real-close-media.log` and `real-close-media-gate.log`. It uses the existing media binary and ffmpeg; no build/download is dispatched.

- media real close path: exit 1; ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-media.log`.

Media prerequisite refusal: the first command exits 1, 0/1 file-load checks, zero client cases executed. `proofs/media/support.ts:40` refuses the default release binary because it is older than `media/src/jobs.rs`. Log `real-close-media.log` retains the exact refusal. No media or ffmpeg process started. An isolated offline build is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/build-media.sh`, which executes `cargo build --offline --locked --release --jobs 1 --manifest-path media/Cargo.toml --target-dir .retest/scratch-phase-3-closeout/media-target`. Logs `/tmp/retest-phase-3-closeout/media-build.log`, `media-build-gate.log`, `media-build-process.log`; input hashes `media-build-inputs.json`. No media source or default target directory is edited, and offline mode prohibits dependency downloads.

- Offline isolated media build: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/media-build.log`.

The isolated offline media build exits 0. All Rust/Cargo/build input hashes match the pre-build snapshot. Artifact path and SHA-256 are in `/tmp/retest-phase-3-closeout/media-build-artifact.json`. The initial load-refusal logs and PID record are preserved as `real-close-media-stale.log`, `real-close-media-stale-gate.log` and `real-close-media-stale-process.log`.

Media rerun is now the sole heavy command, `locked.sh real-close.sh media`, using `RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-phase-3-closeout/media-target/release/retest-media` to select that freshly built artifact. Other flags, source tests and assertions are unchanged. Logs `real-close-media.log` and `real-close-media-gate.log`. The configured-binary branch is the existing API for selecting an alternative artifact; this artifact was built from the hashed current sources.

### Immediate orphan-signal deadline guard

Final inspection found that the orphan sweeper checked the deadline before comparing identities but did not check again immediately before signalling. A deterministic added getter advances the monotonic clock during comparison. `node --conditions=retest-source --test --test-name-pattern='identity comparison that spends' tests/unit/firefox-orphans.test.ts` fails first, 0/1, by observing a signal after the budget. Log `firefox-orphan-deadline-before.log`. `src/browser/firefox/orphans.ts` now checks the same deadline again after comparison and immediately before `system.kill`. Existing tests, budgets and identity matching stay unchanged. This changes one ownership source after the earlier real Firefox gate; a fresh real sweeper case and refreshed source snapshot are required. Media remains the only heavy command.

- Firefox orphan immediate deadline after: exit 0; ℹ tests 14; ℹ pass 14; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/firefox-orphan-deadline-after.log`.

- media real close path: exit 0; ℹ tests 32; ℹ pass 32; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-media.log`.

A second deterministic orphan test catches a late candidate table that shows absence: the former code removed the folder after its cleanup deadline. `node --conditions=retest-source --test --test-name-pattern='late orphan candidate snapshot' tests/unit/firefox-orphans.test.ts` fails first, 0/1, `firefox-orphan-late-before.log`. The sweeper now checks the deadline after that snapshot/lookup before accepting absence. Both added guards preserve uncertainty and require the existing folder to remain. Full orphan units are rerun unchanged plus these two additions.

- Firefox orphan final guards: exit 0; ℹ tests 15; ℹ pass 15; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/firefox-orphan-final.log`.

The final orphan gate passes 15/15, zero skips, `firefox-orphan-final.log`. The immediate-signal first guard separately passed 14/14 in `firefox-orphan-deadline-after.log`. The comparison also detects the concurrent Firefox crash change described below; the old snapshot is preserved as `ownership-sources-before-final-orphan-guards.json` and `ownership-sources-final.json` is refreshed. A real orphan-sweeper case is pending the media command.

Snapshot correction: comparison also finds a concurrent change in `src/browser/firefox/process.ts`. Reconstructing its former crash body yields the exact earlier hash: the change is only the crash helper, now ending the freshly verified main process before the shared owner signals helpers. It was written before this lane's real 8-case Firefox driver gate, which passed it, but after the ten loss reproductions. This lane preserves that concurrent work. Diff evidence `/tmp/retest-phase-3-closeout/firefox-concurrent-crash-diff.txt`. A final real Firefox driver gate and another ten loss reproductions will verify the combined current files. The previous paragraph's “only orphans” statement is superseded by this measured comparison.

Media real client file passes 32/32, zero skips, exit 0. Log `/tmp/retest-phase-3-closeout/real-close-media.log`; all original close/encoder/orphan/forced-exit assertions are retained. The tested isolated artifact is the SHA-256 already recorded in `media-build-artifact.json`. A final locked audit will check its recorded media/encoder PIDs and groups.

Final combined Firefox verification is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/final-firefox.sh`. It serially runs the unchanged 8-case real driver file through `real-close.sh firefox`, then ten exact loss cases through `loops.sh firefox-loss`. Gate log `/tmp/retest-phase-3-closeout/final-firefox-gate.log`. The earlier real Firefox command/logs are preserved under `real-close-firefox-before-final-guards*`; the earlier focused loss evidence under `loops/firefox-loss-before-concurrent-crash-change/`. Current logs remain `real-close-firefox.log` and `loops/firefox-loss/round-<N>.log`.

- firefox real close path: exit 0; ℹ tests 8; ℹ pass 8; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/real-close-firefox.log`.

- firefox-loss round 1: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-1.log`.

- firefox-loss round 2: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-2.log`.

- firefox-loss round 3: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-3.log`.

- firefox-loss round 4: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-4.log`.

- firefox-loss round 5: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-5.log`.

- firefox-loss round 6: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-6.log`.

- firefox-loss round 7: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-7.log`.

- firefox-loss round 8: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-8.log`.

- firefox-loss round 9: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-9.log`.

- firefox-loss round 10: exit 0; ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/loops/firefox-loss/round-10.log`.

Final combined Firefox gate passes its unchanged real file 8/8, zero skips, exit 0, and all ten repeated loss cases 1/1, zero skips, exit 0. The current crash-helper change and this lane's orphan guards are exercised together. Logs `real-close-firefox.log` and `loops/firefox-loss/round-1.log` through `round-10.log`; original evidence remains separately retained.

Compilers are now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/compile.sh`, gate `/tmp/retest-phase-3-closeout/compile-gate.log`. The exact five compiler invocations were listed when prepared, and each appends its exit independently. A 26-case Firefox unit gate is also dispatched with the benchmark guard and no browser/native target: `node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-browser.test.ts tests/unit/firefox-process.test.ts tests/unit/firefox-process-table.test.ts tests/unit/firefox-orphans.test.ts`, log `firefox-units-final.log`.

- Final Firefox units: exit 0; ℹ tests 27; ℹ pass 27; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `/tmp/retest-phase-3-closeout/firefox-units-final.log`.

- typescript root typecheck: exit 2; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-typescript.log`.

- typescript-7 root typecheck: exit 1; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-typescript-7.log`.

- typescript media proof typecheck: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-media-typescript.log`.

- typescript-7 media proof typecheck: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-media-typescript-7.log`.

- TypeScript task example typecheck: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-examples.log`.

Final Firefox unit gate passes 27/27, zero skips, `firefox-units-final.log`; the concurrent lane has added a deliberate crash-order unit, explaining the extra case beyond the prepared 26. All original cases remain. Both root compilers fail on the same three errors in the concurrent lane's `tests/unit/early-browser-waits.test.ts:266`: destructuring `result`/`input` from unknown and calling `dispatch` on `OwnedPage`. TypeScript 6 exit 2, TypeScript 7 exit 1, logs `compile-typescript.log` and `compile-typescript-7.log`. This lane does not edit that owned file. The two media-proof compiler commands and the task-example compiler each exit 0. The root typecheck gate is not green.

The final PID/group/folder/simulator audit is now the sole heavy command: `sh .retest/scratch-phase-3-closeout/locked.sh python3 .retest/scratch-phase-3-closeout/final-audit.py`, log `/tmp/retest-phase-3-closeout/final-audit-gate.log`. Its simulator inventory runs only under the shared lock, and its process checks issue no signal.

Final locked audit: 254 recorded PIDs checked, 0 live; 0 recorded folders remain; 0 recorded flow/lifecycle simulators remain; 0 members remain in recorded launch/encoder groups. 0 ownership source hashes changed since the validation snapshot. `/tmp/retest-phase-3-closeout/final-process-audit.json`. No signal is issued by the audit.

The concurrent early-waits owner has since added `assert.ok(page instanceof FirefoxPage)` immediately before the failing call; its mtime is later than both failed compiler logs. That concrete source change justifies rechecking only the root compiler commands. `sh .retest/scratch-phase-3-closeout/locked.sh sh .retest/scratch-phase-3-closeout/compile-root-final.sh` is now the sole heavy command. It repeats both exact `tsc -p tsconfig.json` invocations into `compile-typescript-final.log` and `compile-typescript-7-final.log`, then refreshes the locked final audit to include those compiler PIDs. Gate `compile-root-final-gate.log`. This lane did not edit the other owner's file.

- typescript final root typecheck: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-typescript-final.log`.

- typescript-7 final root typecheck: exit 0; no Node test counts. Log `/tmp/retest-phase-3-closeout/compile-typescript-7-final.log`.

Final locked audit: 256 recorded PIDs checked, 0 live; 0 recorded folders remain; 0 recorded flow/lifecycle simulators remain; 0 members remain in recorded launch/encoder groups. 0 ownership source hashes changed since the validation snapshot. `/tmp/retest-phase-3-closeout/final-process-audit.json`. No signal is issued by the audit.

Both final root compilers exit 0, with empty logs: `compile-typescript-final.log` and `compile-typescript-7-final.log`. The prior concurrent-file errors remain in their original logs, and were corrected by their owner before these reruns. All five relevant final compiler commands pass. The refreshed audit checks 256 recorded PIDs, zero live, zero group members, folders or simulators; all eight ownership source hashes match the refreshed snapshot. Media source input hashes and tested binary hash also remain unchanged.

A read-only evidence check requires all forty current requested round logs to report exactly one test, one pass, zero failures and exit 0, and all five final compiler logs to be empty. It passes. Scoped `git diff --check -- <assigned paths>` exits 0; the five new source/helper/test files have zero trailing-whitespace lines. No heavy command remains queued or running.

Run finished 2026-10-06 08:39:23 UTC. Step-by-step commands, counts and evidence were written during the run, within the user's hard limit.
