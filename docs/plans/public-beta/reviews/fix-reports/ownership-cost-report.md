# Process ownership cleanup cost

## Cause

The historical-PID cost is confirmed. The saved pre-fix `signalReport` reads every retained record individually after taking its table snapshot. The unit reproduction records a root and 100 helpers, then leaves only the root alive: the old implementation makes 101 one-PID readings to send one signal. The fixed implementation makes one successful table reading and one individual reading, immediately before signalling the live root. The original `.retest/scratch-waits-and-leftovers/ownership-history.ts` also now passes with `individualIdentityReads: 1` and `signaledProcesses: 1`.

The earlier real Chrome traces locate cleanup work in that method. `.retest/scratch-waits-and-leftovers/logs/close-22521.jsonl:9` and `:10` record synchronous signalling passes of 4436.685 and 4458.406 ms; `close-24395.jsonl:13` and `:14` record 7863.357 and 6527.913 ms. Those calls reported no read, signal or identity problem. Later readings showed the groups gone, but the affected stops did not reach `stop-end` before the host exited. The earlier web group had its declared exit 1 changed to 2 by `cleanup_failed` (`conformance-2/chrome/web/run/events.jsonl:748`) and retained two profiles. The traces did not count historical PIDs in those real groups. The independent reproduction establishes the history-dependent query count; it does not establish that exact count for those runs.

## Changes

- `src/shared/process-ownership.ts`: a successful whole-table snapshot removes absent and zombie records before signal selection. Only remaining candidates get the individual identity query. Confirmed gone PIDs are forgotten on capture, liveness and individual readings. One launch identity remains to distinguish reuse of the original numeric group. A revision counter prevents an older background snapshot restoring a helper a newer observation showed gone. Failed snapshots dispatch no individual query or signal and do not release ownership. Changed identities remain refused. Query failures stay visible even after later proof of absence.
- The shared owner now has asynchronous signalling and liveness operations, and an optional asynchronous one-PID reader. The default host supplies both. Each signal still follows a fresh individual reading and the unchanged start/command comparison, with no intervening await. Caller deadlines are checked before and after readings and again immediately before signalling. An ended or cancelled budget yields an unconfirmed reading, never absence or signal authority.
- `src/shared/metadata-process.ts` and `metadata-process-worker.ts`: caller budget includes startup, queueing and the child query. A queued request past its budget is refused before spawn; a late or cancelled answer is refused by the host. Cancellation wakes an asynchronous wait. A referenced timer keeps an awaited asynchronous query alive when it is the host's last work, including a worker failure; it is cleared on settlement. Previously that standalone host exited 13 with an unsettled top-level await. Failed queries still fail individually, later queries can recover, and metadata children are never signalled. The existing 4 MiB individual-query and 64 MiB whole-table output bounds remain.
- `src/browser/chromium-process.ts`: ordinary stop, exit reconciliation and output's process reconciliation await metadata readings. One ownership deadline covers the stop's capture, signalling and liveness work. Synchronous descendant recording before the remote close and synchronous exit-hook work remain capped. The exit hook stays installed through pending output/profile work and the final awaited liveness query. The returned report is constructed after that final query, so its failure cannot disappear. Failed confirmation says the group could not be confirmed ended rather than claiming it was observed alive. Profiles are removed only after successful absence confirmation.

Start strings, time-zone selection, identity matching (including the existing unreadable-command rule), action/assertion semantics, declared exits, output settlement rules and dependency declarations were not changed. Existing ownership, metadata and Chromium tests were kept unchanged; 22 cases were added. No source outside the assigned files was edited.

## Unit evidence

Scratch evidence is under `.retest/scratch-ownership-cost/`. Pre-fix sources were copied there before implementation; tests import those copies without replacing live source. Relative imports in those copies were made absolute. Browser baseline tests use the current fake owner to isolate the Chromium consumer change. Metadata baseline tests use the saved bridge and the current worker protocol implementation, with no caller deadline supplied by the old bridge.

`logs/saved-old-frozen-evidence.log` runs all 22 added cases plus the existing synchronous reuse guard against those saved implementations: 23 tests, 22 failures, one pass. Missing asynchronous methods are identified below as missing API coverage, not as a demonstrated failure of the old synchronous identity guard. The existing reuse guard passes before and after. `logs/units-typed-final.log` runs all three final unit files: 60 passed, zero failed, cancelled or skipped. Three added empty-signal assertions were changed to check length, because TypeScript's assertion narrowing otherwise made later signal entries `never`; they still require zero signals. The saved-old rerun of those cases also fails all three (`logs/typed-old-snapshot.log`). No existing assertion changed.

| Added case (unit file and line) | Evidence on saved old code | Fixed result |
| --- | --- | --- |
| `process-ownership.test.ts:182`, 100 dead helpers, one live root | Actual individual-read list contains 101 PIDs; expected only root. Also `logs/ownership-before.log`. | One table, one individual read, one signal. |
| `process-ownership.test.ts:194`, failed snapshot despite successful individual reader | Old code queries and signals the two recorded processes after snapshot failure. | No individual query or signal; resource held; later successful query can recover, failure retained. |
| `process-ownership.test.ts:212`, gone helper returns outside ancestry | Old code queries/refuses the obsolete helper record. | Gone record forgotten; returning foreign process neither queried nor signalled. |
| `process-ownership.test.ts:256`, deadline ends during identity comparison, sync and async | Old synchronous path sends the root signal after budget ends. `logs/pre-signal-deadline-before.log` also fails against the first implementation before the final pre-signal guard. | Neither path signals after comparison spends its budget. |
| `process-ownership.test.ts:297`, stale background snapshot after newer absence | Old snapshot restores the obsolete helper and queries/refuses it. | Newer observation wins; helper stays forgotten. |
| `process-ownership.test.ts:368`, real owned POSIX child, asynchronous cleanup with running timers | Old owner lacks `signalReportAsync`; the test's finally ends its own recorded child. | Actual child exits by SIGKILL; timers run; successful liveness confirms gone. |
| `process-ownership.test.ts:394`, asynchronous 100-helper reproduction | Old owner lacks `signalReportAsync`. | Only the live root is individually read and signalled. |
| `process-ownership.test.ts:406`, reuse between asynchronous table and individual read | Old owner lacks `signalReportAsync`; the existing sync reuse test at :234 passes old and new. | Changed start/command refused, zero signals. |
| `process-ownership.test.ts:418`, failed asynchronous snapshot | Old owner lacks `signalReportAsync`. | No individual query or signal; ownership held. |
| `process-ownership.test.ts:433`, failed asynchronous individual query and retry | Old owner lacks `signalReportAsync`. | Failed candidate neither signalled nor forgotten; no later signal in that pass; successful retry works and failure stays recorded. |
| `process-ownership.test.ts:450`, deadline during table reading | Old owner lacks `signalReportAsync`. | No individual query or release; uncertainty recorded. |
| `process-ownership.test.ts:466`, deadline during individual reading | Old owner lacks `signalReportAsync`. | No signal or later query; ownership held. |
| `process-ownership.test.ts:481`, pruned launch root's numeric group reused | Old code retains/refuses the obsolete root instead of the expected clean report for its remaining owned helper. | Foreign root/group not adopted; only the old verified helper signalled. |
| `metadata-process.test.ts:50`, stalled sync worker under caller deadline | Old bridge spends the startup allowance past the test's bound. | Caller budget bounds the wait; next query succeeds. |
| `metadata-process.test.ts:62`, stalled async worker under caller deadline | Same old startup-allowance failure. | Bounded failure, timers run, later query succeeds. |
| `metadata-process.test.ts:78`, already-ended caller deadline | Old bridge starts/answers instead of refusing. | Both entry points refuse before dispatch. |
| `metadata-process.test.ts:85`, cancellation and recovery | Old bridge ignores cancellation and exceeds the test's bound. | Abort wakes wait, caller fails, later query succeeds. |
| `metadata-process.test.ts:136`, standalone host awaiting its only async metadata query | Old child host exits 13 without an answer. Also `logs/async-liveness-before.log`. | Actual child exit 0 for answer or 2 for deadline failure, with the declared output. |
| `browser-chromium-process.test.ts:20`, normal cleanup read/signal ordering | Old browser calls the fake's forbidden synchronous snapshot; cleanup returns failures. | Awaited snapshots and individual reads in signal order, no synchronous cleanup reading. |
| `browser-chromium-process.test.ts:63`, ended caller budget | Old browser signals, removes the profile and omits the unconfirmed-reading problem. `logs/unconfirmed-before.log` separately catches the first implementation's unsupported “was still there” claim. | Zero signals, profile retained, unconfirmed result without observed-alive claim. |
| `browser-chromium-process.test.ts:88`, hook during final asynchronous query | Old browser never enters that query. More directly, `logs/hook-gap-before.log` fails with the new async implementation's hook removed before the await. | Hook remains installed until query settles. |
| `browser-chromium-process.test.ts:124`, final asynchronous query failure in returned report | Old browser never reads that query. `logs/final-read-before.log` directly fails when the new implementation constructs the return before finally. | Final failed reading is present in returned cleanup problems. |

Completed commands:

```sh
node --conditions=retest-source --test --test-concurrency=1 tests/unit/process-ownership.test.ts tests/unit/metadata-process.test.ts tests/unit/browser-chromium-process.test.ts
node --conditions=retest-source .retest/scratch-waits-and-leftovers/ownership-history.ts
```

The ownership reproduction's original failing logs remain in `.retest/scratch-waits-and-leftovers/logs/ownership-history.log` and `ownership-history-final.log`; its fixed result is `logs/ownership-history-after.log`. Additional shared/Chromium/Firefox/WebKit consumer units passed 111 cases (`logs/units-consumers.log`), and native process units passed 47 (`logs/units-native-consumer.log`). Those consumer runs preceded the last metadata timer, final-report and immediate-deadline refinements; the final assigned-file 60-case run covers those refinements. Native units are not proof of native application support.

## Chrome conformance

Five runs in a row passed on installed Chrome **154.0.8037.98**, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, on Node **24.12.0**. Each run had **164 passed, zero failed or cancelled, two explicitly opted-out engines**, and harness exit **0**. All 75 group outcomes matched their declarations, including the intended exits 1, 2 and 130. No `cleanup_failed` occurs anywhere in their structured events. No profile or owned process was retained.

Each run went through this command with `N` replaced by 1 through 5:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock env \
  RETEST_CONFORMANCE_OPT_OUT=firefox,webkit \
  RETEST_CONFORMANCE_KEEP=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-ownership-cost/conformance-N \
  RETEST_OWNERSHIP_TRACE_ROOT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-ownership-cost/logs/trace-N \
  NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-ownership-cost/trace-close.ts \
  node --conditions=retest-source --test --test-concurrency=1 tests/integration/conformance.test.ts
```

The scratch wrapper retries a busy lock after `sleep 60`. It checks `pgrep -f benchmarks/run.ts` before dispatch and inspects matches: other workers' shell/Codex instruction text containing that path is not a running benchmark. Initial waiting wrappers treated those textual matches as benchmarks; they were ended only after matching their recorded ownership, then restarted with inspection. No compiler or conformance test had started in those initial wrappers. No benchmark was run, and no other lane's process was ended.

Evidence: `logs/conformance-1.log` through `conformance-5.log`; `logs/conformance-exits.log`; `conformance-1/chrome/` through `conformance-5/chrome/`, each containing all 15 retained run folders; `proof-summary.json`. `tests/conformance/process.ts:258` checks the CLI group, every reported browser/app group, Retest entries in the per-run temporary folder, processes naming that folder and saved states. `tests/conformance/execute.ts:241` records a failure before attempting leftover cleanup, so later cleanup cannot turn a retained profile or process into a passing group. Those checks passed in all five runs. Conformance source and declarations were not edited.

| Group | Declared | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| web | 1 | 1 | 1 | 1 | 1 | 1 |
| workflow | 1 | 1 | 1 | 1 | 1 | 1 |
| projects | 0 | 0 | 0 | 0 | 0 | 0 |
| projects-narrow | 0 | 0 | 0 | 0 | 0 | 0 |
| server | 0 | 0 | 0 | 0 | 0 | 0 |
| server-fails | 2 | 2 | 2 | 2 | 2 | 2 |
| participants | 0 | 0 | 0 | 0 | 0 | 0 |
| limits | 0 | 0 | 0 | 0 | 0 | 0 |
| locks | 0 | 0 | 0 | 0 | 0 | 0 |
| only | 0 | 0 | 0 | 0 | 0 | 0 |
| only-ci | 2 | 2 | 2 | 2 | 2 | 2 |
| filter | 0 | 0 | 0 | 0 | 0 | 0 |
| cancel-after-input | 130 | 130 | 130 | 130 | 130 | 130 |
| lost-after-input | 2 | 2 | 2 | 2 | 2 | 2 |
| lost-while-looking | 2 | 2 | 2 | 2 | 2 | 2 |

The copied tracing preload preserves the earlier phases and adds async signal/liveness phases, forwarding deadlines. It records method outcomes and elapsed times, no page text or command lines. Before the fix, total stop time is unavailable for the affected stops because they never logged `stop-end`; the measured synchronous signal portions are listed under Cause. After the fix, all 90 stop starts have corresponding successful ends with empty problem lists. Observed timings in milliseconds:

| Run | Stop samples | Stop minimum / median / maximum | Async signal samples | Async signal minimum / median / maximum |
| --- | ---: | --- | ---: | --- |
| 1 | 18 | 49.951 / 301.742 / 589.330 | 15 | 92.016 / 104.208 / 203.066 |
| 2 | 18 | 50.222 / 257.774 / 509.248 | 15 | 49.942 / 94.589 / 197.221 |
| 3 | 18 | 94.365 / 277.284 / 455.485 | 16 | 56.702 / 93.672 / 121.329 |
| 4 | 18 | 61.038 / 283.412 / 625.936 | 15 | 92.315 / 101.979 / 212.905 |
| 5 | 18 | 52.806 / 285.043 / 557.347 | 16 | 90.802 / 94.850 / 196.902 |

These are diagnostic observations from different executions and Chrome builds, not a speed claim or a worst-case timing guarantee. Trace files are `logs/trace-N/close-<pid>.jsonl`. The four production source hashes match the snapshot taken before the first run (`pre-conformance-source-hashes.json`). Only the three added unit assertion type fixes occurred during the first run; they do not enter the conformance execution path.

## Compiler and final process checks

The initial `npm run typecheck`, through the heavy gate, exited 2: the three added assertion-narrowing errors described above, plus `src/runner/app-server.ts:115` and `tests/unit/runner-deadline-clock.test.ts:19` in the active runner lane (`logs/typecheck.log`). This lane fixed only its tests. The final components were then run separately, together under `lockf -t 0 /tmp/retest-heavy-gate.lock sh .retest/scratch-ownership-cost/compile-final.sh`, so an earlier failure would not suppress a later compiler:

| Command | Final exit | Evidence |
| --- | ---: | --- |
| `node_modules/typescript/bin/tsc -p tsconfig.json` (6.0.3) | 0 | `logs/tsc6-final.log` |
| `node_modules/typescript-7/bin/tsc -p tsconfig.json` (7.0.2) | 0 | `logs/tsc7-final.log` |
| `node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json` | 0 | `logs/examples-final.log` |

`logs/compiler-exits.log` records all three exits; the final compiler logs contain no errors. All launched commands and waiting wrappers have ended. `audit-proof.py` recursively checks failure classes, the five exit matrices, empty stop reports and the production hashes, then checks the recorded wrapper, CLI, browser and app PIDs/groups. **178 recorded PIDs checked, none live**, including the old waiting-wrapper groups (`logs/process-audit.json`). Scratch evidence remains for review. Nothing was committed, stashed, reset, reverted, published or downloaded.

## Other users: cost and exact follow-up

These are source inspections, not runtime proofs of the unchanged drivers. Shared snapshot pruning removes the historical-dead-PID query cost for every `OwnedProcessGroup` consumer. The remaining costs below must be addressed in their owning lanes.

| User, file and line | Same cost? | Exact change still needed outside this lane |
| --- | --- | --- |
| Native, `src/native/processes.ts:409`, :460, :475, :482, :549, :554, :560 | Previously inherits historical queries. Now prunes them, but `ProcessTable.during` only makes the table async; `readProcess` remains synchronous per live candidate. Termination deadlines are created outside signalling and not passed to metadata. | Add `readProcessAsync(pid, deadline)` using the same columns/environment and sentinel; forward deadlines through table readers. Await `signalReportAsync(signal, deadline)` and `remainsAsync(deadline)` with one budget across signalling and waits. Keep bounded synchronous exit hooks. |
| Chromium, `src/browser/chromium-process.ts:210`, :228, :232, :239, :416 | Historical cost fixed centrally; ordinary stop and group reconciliation now await table/individual queries under a shared deadline. | No further historical-query fix. The deliberately synchronous signal APIs and exit hooks still require fresh live-PID checks. Failed debugging-pipe setup at :319 remains a synchronous signalling path; shared pruning applies there too. |
| WebKit, `src/browser/webkit/process.ts:291`, :335, :339, :358, :363, :369, :439, :469 | Previously inherits historical queries. Still synchronous for live candidates. `#remainingHelpers` calls a whole-table liveness query separately for each helper on every pass; polls check their deadline only after queries. | Await async signal/liveness with one caller deadline. Take one successful async table per helper-liveness pass and share it with the helper owners, while keeping an individual fresh identity query before each signal. Preserve recorded launchd-helper handoff and bounded sync exit hooks; never substitute group membership for ownership. |
| Firefox, `src/browser/firefox/process.ts:221`, :228, :237, :250, :266, :470, :492, :494 | Async table refresh feeds a cached snapshot; shared pruning now removes absent history. The individual reader is still synchronous, and query budgets are not forwarded. | Add async individual reader preserving `readProcessIdentity`'s exact identity format; forward the deadline through actual async table refresh, `signalReportAsync` and final `remainsAsync`. Keep the command-free liveness optimization for observation only, never signal authority, and bound sync exit hooks. |
| Firefox orphan sweeper, `src/browser/firefox/orphans.ts:112`, :116, :123, :125, :126, :135, :140 | No historical shared ledger. It takes asynchronous tables per folder/poll; creates its deadline only after signalling, so query work is outside that budget. | Create one budget before verification; add an async one-PID identity reader. Re-read and compare the recorded root/child identity immediately before each individual kill. Keep failed queries unconfirmed with the folder retained; poll using the same budget. See the separate signal-safety finding below. |
| Media, `src/media/client.ts:122`, :170, :173, :177, :615, :623, :990, :1274 | Previously inherits historical queries. Selection already prunes absent tracked helpers/groups, and shared pruning now prevents historical individual queries. Each snapshot still has a links query followed by a selected-arguments query; live individual checks and cleanup polling remain synchronous and lack caller budgets. | Forward one deadline through both selection queries; add the same async one-PID reader; await `signalReportAsync` and `remainsAsync(deadline)` in normal cleanup/reclaim. Preserve selection completeness and failed-query retention. Keep sync exit fallback bounded. |

Firefox's orphan sweeper also has a safety gap independent of historical cost: the root is compared against one whole-table snapshot, then `system.kill(pid)` and every `system.kill(child.pid)` run without individual readings immediately before each signal. A child reused after the snapshot can be signalled as the captured child. This lane did not edit or reproduce that race; the exact follow-up is above. It should be addressed before treating the sweeper as meeting the shared layer's signal rule.

`src/browser/browser.ts:150` records synchronously before creating its close deadline, and :157 calls `stop(0)` without forwarding that deadline. The assigned Chromium process now caps recording and supplies its own ownership budget. To make this caller's precise budget cover the whole path, create the deadline before recording, pass it to `recordDescendants(deadline)`, and call `stop(0, deadline)`. This caller file was outside the assignment and was not edited.

## Not verified, most important first

1. The Firefox orphan sweeper's individual-signal safety gap is a source finding, not a forced real-PID-reuse reproduction. The exact change and lines are above. The remaining native, Firefox, WebKit and media async/deadline work was documented, not implemented; their live-candidate queries can still block the event loop. No real target of those unchanged drivers was exercised by this lane.
2. `ChromiumBrowser.close` does not yet forward its precise outer deadline to descendant recording and `stop`; the exact out-of-scope caller change is above. The process implementation now accepts and honors a forwarded deadline and bounds its default ownership work, but a real short outer-budget close was not exercised. Output keeps its existing separate settlement bounds. Table parsing, allocation and OS scheduling cannot be physically preempted by the deadline guard; late confirmation is refused. The five runs prove their observed outcomes, not a hard wall-clock guarantee under every host load.
3. The known time-zone/start-reading inconsistency was left untouched as requested. The existing whole-second start resolution, unreadable-command identity rule and macOS reading-to-signal window remain. Reuse between snapshot and individual reading is tested with controlled identities; no OS-level PID reuse race was forced.
4. No full unit or integration suite, Linux host proof, real native application proof, or Firefox/WebKit conformance was run by this lane. Firefox and WebKit were explicitly opted out, not passed. The consumer unit results above do not establish platform compatibility.
5. No long-run memory soak or benchmark was run. Pruning is verified with 100-helper history, gone-PID reuse and stale-snapshot tests. The old real traces did not count their historical records, so their exact history size and a timing comparison under matched host conditions remain unverified.
