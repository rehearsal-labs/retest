# Early waits

This sweep keeps browser and native retry reads through their exact deadlines. It adds an internal capped pause in `src/assertions/wait-before-read.ts`, with `Deadline.reached` and `Deadline.waitToEndMs`. The pause checks the clock after waking before the final read. Every changed retry loop records whether its read began at the deadline, so a read that crosses the deadline cannot suppress the final read. Command allocations still use `commandTimeoutMs`. Input is never retried.

Existing work was preserved. No runner, protocol, store, config, reporter, evaluation, media, capture, shared, CLI, conformance or Chromium-process source was edited. No dependency, download, benchmark, commit, stash, reset or revert was made. Driver edits read the current file and replaced anchored code.

## Places and failing-old-code tests

The browser tests below are in `tests/unit/early-browser-waits.test.ts`, the native tests in `tests/unit/early-native-waits.test.ts`, and the process tests in `tests/unit/early-process-waits.test.ts`. `early-waits-clock.ts` supplies a fake monotonic clock and timers that wake early. Reads spend a fractional millisecond. Completed simple waits must end below 122 ms for their 120 ms budget. Tests check the time of dispatch, not just the time a refusal returns.

| Place | Change | Test that exposes the old behavior |
| --- | --- | --- |
| `src/browser/actionability.ts`, readiness loop and timeout catch | Exact final-read predicate, capped and rechecked pauses. A timed-out look preserves the last readiness reason and continues. | `browser actionability sends a final readiness look after an early read timeout` |
| `src/browser/checked-state.ts`, post-click read loop | Exact final read and pauses. An early timeout preserves the last state and continues. | `checked-state verification sends its final read after early timers and an early read timeout` |
| `src/browser/page.ts`, screenshot retries | A retryable between-document failure or an early read timeout reaches a final screenshot probe, including when a read crosses the deadline. | `Chrome screenshot retries send their final probe after early timers and a straddling read` |
| `src/browser/page.ts`, post-select verification | Exact final read and pauses. Read timeouts continue through the deadline. | `Chrome selection verification sends the final read after early timers and retries a read timeout` |
| `src/browser/electron.ts`, first-window wait | Its end timer uses the rounded-up and capped delay and rechecks the exact clock before refusing. The losing timer is aborted. | `Electron first-window readiness rechecks an early end timer` |
| `src/native/actionability.ts`, element readiness and timeout path | Exact final read and pauses. Earlier timed-out reads preserve the last readiness reason. | `native element readiness reads at the deadline through early timers and read timeouts` |
| `src/native/actionability.ts`, app-coordinate readiness and timeout path | The same change for app input. | `native app-coordinate readiness reads at the deadline through early timers and read timeouts` |
| `src/native/actionability.ts`, both late front checks | A front problem arriving in the last fraction remains the latest readiness reason. An exhausted front read preserves the earlier known reason. Neither ends the loop before its final tree read. | Four `native ... readiness keeps observing after a front check at ...` cases exercise element and app readiness at 249.5 and 250.1 ms of a 250 ms budget. The original code fails the last-fraction cases; the saved first correction fails both exhausted-read cases. |
| `src/native/actionability.ts`, both stability gaps | Insufficient time for a complete proof remains unready while readiness reads continue. A timer waking early is rechecked against a separate 100 ms deadline starting at the first frame read. | The readiness cases above require the final tree read even when another complete proof cannot fit. Both `native ... stability proof keeps the full frame gap after early timers` cases require the second frame read at or after 100 ms and pass only with the complete proof. |
| `src/native/alerts.ts`, alert-close verification and both timeout paths | Early tree or executor-alert timeouts continue. Final tree and alert-route probes use the exact deadline. Non-time failures return with the already-sent input recorded. | `native alert-close verification sends its final tree and executor probe after early timeouts`, with one alert press. |
| `src/native/input.ts`, field read-back retries | Unread-tree and early-timeout retries keep the final field read and recheck capped pauses. | `native field read-back retries send the final read and never type twice` |
| `src/native/input.ts`, optional keyboard discovery pause | Its pause is bounded by the optional stage and the action deadline. Discovery still need not find a keyboard to continue. | `optional native keyboard discovery caps its pause at the remaining stage and action budget` |
| `src/native/keyboard.ts`, steady-tree retries | Exact final read and rechecked capped pauses, including early read timeouts. | `native steady-tree retries send their final read after early timers` |
| `src/native/keyboard.ts`, keyboard-up verification | Early read timeouts continue; the final tree read starts at the deadline. If every read times out, the original timeout remains the failure. | `native keyboard-up verification sends a final tree read after an early timeout` and `native keyboard-up verification preserves an unanswered first read through the full deadline` |
| `src/native/keyboard.ts`, post-dismiss verification | Early read timeouts continue, with the press recorded and never repeated. | `native keyboard-dismiss verification reads at the deadline and never presses twice` |
| `src/native/executor-process.ts`, executor readiness | The last status probe runs at the exact deadline. The expiration check follows the probe, rather than preventing it. Pauses are capped and rechecked. | `native executor readiness sends its final status probe after early timers`. This uses stand-in processes, records their ownership, and requires all of them gone. Cleanup has its own bound. |
| `src/browser/firefox/process.ts`, Remote Agent readiness | Exact final address-file probe and rechecked pauses. Missing files remain retryable; another filesystem error returns immediately. | `Firefox Remote Agent readiness sends the final address probe after early timers` |
| `src/browser/firefox/window-order.ts`, turn timeout and turn-arrival check | The timer rechecks the exact deadline and reschedules on an early wake. A turn may be used in the last fractional millisecond. | `Firefox window ordering rechecks its end timer` and `Firefox window ordering permits a turn in the deadline's last fraction` |
| `src/browser/firefox/page.ts`, screenshot retries | Exact final probe and pauses. Early timeouts retry; a pending navigation also retries transient screenshot protocol errors. Malformed replies return immediately. | The Firefox screenshot test and `Firefox screenshot retries preserve a non-time protocol failure immediately during navigation`. |
| `src/browser/firefox/page.ts`, post-select verification | Exact final read and pauses, continuing early read timeouts. | The Firefox selection-verification test. |
| `src/browser/firefox/page.ts`, returned action-refusal hold | Chromium's narrow hold applies to timeout-related refusals claiming the whole command budget. It checks cancellation again after the hold. | The Firefox whole-budget, stop-during-hold and ambiguous-before-stop tests. |
| `src/browser/webkit/page.ts`, screenshot retries | Exact final probe and rechecked pauses during target swaps and after early read timeouts. | The WebKit screenshot test. |
| `src/browser/webkit/page.ts`, post-select verification | Exact final read and pauses, continuing early read timeouts. | The WebKit selection-verification test. |
| `src/browser/webkit/page.ts`, returned action-refusal hold | Removes the broad `deadline.expired` condition. An ambiguous or other non-time failure returns immediately. Cancellation is checked after a qualifying hold. | The WebKit stop-during-hold and ambiguous-before-stop tests. The whole-budget test also retains its existing intended behavior. |

`tests/unit/wait-before-read.test.ts` checks capped-pause rechecking, maximum-delay timer arithmetic and cancellation. The non-time native failure test requires the original `session_lost` failure at 119.5 ms, unchanged and without a pause.

The failing-old-code runs use `.retest/scratch-early-waits/old-code.ts`. Its Node resolve hook redirects only this sweep's source files to snapshots taken before editing. Snapshot relative imports were rewritten to the original absolute source locations so unchanged dependencies remain current. No live source was reverted and no production test seam was added.

## Uses previously judged fine

I agree with the command-allocation, protocol-work, navigation-grace, change-wait, ownership, cleanup and non-deadline-search judgments in Task 1. Their whole-millisecond values allocate one stage or cap reconciliation; they do not promise a final required read at the user's deadline. The shared look and native assertion timeout classifiers remain appropriate.

Two table entries need qualification. The native stability-gap guards correctly require the complete gap, but their terminal refusal ended readiness early. They now remain unready and keep reading. Their raw timer also needed a clock recheck to prevent an early wake shortening the proof; both paths now wait through the full gap. Optional keyboard discovery need not read at its stage's end, but its uncapped 100 ms pause could meaningfully overrun that end. That pause is now capped. No missing proof is accepted as a passing action.

## Runner changes still needed

These files were read and left to their owner:

- `src/runner/run-host-checks.ts`, `decideHostCheck`: cap retry pauses with `waitToEndMs`, recheck the clock after capped wakes, and capture `const finalRead = deadline.reached` immediately before `readOnce`. Stop on that captured value after an unsuccessful read, so a read starting before the deadline and finishing afterward cannot suppress the final read. Preserve stopped and non-time unread failures immediately. Retain `readOnce`'s timeout classification as `late` and any earlier observation. The current shared file already has the pause correction and `reached`, but still checks the deadline only after the read; the captured predicate remains needed.
- `src/runner/running-test.ts`, `#command` and `#evaluate`: replace `this.#deadline?.expired === true` with `this.#deadline?.reached === true` before `#runOutOfTime()`. Keep whole-millisecond allocations for individual commands and evaluations. The current shared file already contains both changes from its owner; this sweep did not edit or independently validate them.
- `src/runner/app-server.ts`, launched-server readiness loop in `startAppServer`: replace the pre-probe `while (!deadline.expired)` guard with a probe-first loop. Check interruption and server exit, capture `const finalProbe = deadline.reached` immediately before the bounded probe, and stop on that captured predicate after an unsuccessful probe. Cap pauses with `waitToEndMs` and recheck after capped wakes. Keep `probeLimitMs`, `commandTimeoutMs`, failed-launch cleanup and the log path. The current shared file already has the probe-first loop and pause correction, but its post-probe `deadline.reached` check still needs the captured predicate.

## Commands and results

Validation is pending. All queued commands use `sh .retest/scratch-early-waits/gate.sh <log> <command>`. The wrapper checks for a benchmark, acquires `lockf -t 0 /tmp/retest-heavy-gate.lock`, checks again under the lock, and retries a busy gate after sixty seconds. Logs and process records are under `.retest/scratch-early-waits/`. Firefox integration uses `RETEST_FIREFOX_ROUTE=launch-services`; that host route is recorded rather than treated as a defect.

## Not verified

Validation results and process cleanup will be filled after the queued commands end.
