You are a builder on Retest 0.1.0, in /Users/dragon/Documents/Projects/Gruvi/Products/retest, on a sweep that makes every user-visible wait keep its full time limit.

Read, in full: docs/plans/public-beta/codex/common-rules.md; docs/plans/public-beta/reviews/fix-reports/waits-and-leftovers-report.md, Task 1 (with its audit table of remaining places and its table of uses judged fine) and Task 2 (the three defects found in the first fix, including the WebKit hold that is still too broad); src/protocol/deadline.ts (`reached`, exact; `waitToEndMs`, rounded up and capped), src/assertions/look-until.ts, src/assertions/poll-value.ts and src/native/assertions.ts as fixed, with their fake-clock unit tests, which are your model.

The rule: a user's time limit of N ms means the last look, read or probe is sent at or after N ms by the clock the deadline uses; a capped pause rechecks the clock after waking before the final read; a failure that is not about time returns at once and is never held or replaced; nothing waits meaningfully past its limit or forever.

Fix each place the audit lists, each with a fake-clock unit test that fails on the current code (group tests sensibly; one per loop):
- src/browser/actionability.ts:96,97 and the timeout catch at :104; src/browser/checked-state.ts:43,44; src/browser/page.ts:304,305 (screenshot retries) and :697,698 (post-select verification); src/browser/electron.ts:318.
- src/native/actionability.ts:145,146,233,234 and :199,283; src/native/alerts.ts:168,173,175,176; src/native/input.ts:264,265; src/native/keyboard.ts:127,128,143,144,145,231,232,233; src/native/executor-process.ts:179,195.
- src/browser/firefox/process.ts:180,181; src/browser/firefox/window-order.ts:48,56; src/browser/firefox/page.ts:332,333,827,828, and action refusals returned from `#execute` (about :476) have no whole-budget hold: give Firefox the same narrow rule Chromium has now.
- src/browser/webkit/page.ts:429,431,852,853; and narrow the hold at about :597 so it applies only to timeout-related results that claim the whole budget, never to another failure (an ambiguous match returned just before the limit must come back as itself), with the same cancellation check after the hold that Chromium has.
Line numbers drift: find each by its code. Reread the "judged fine" table and say if you disagree with any entry.

Not in this sweep (another worker is editing src/runner): src/runner/run-host-checks.ts:132,139, src/runner/running-test.ts:339,648, src/runner/app-server.ts:99,108. Do not edit them; restate the exact change each needs in your report.

Other workers are editing right now, not yours: src/runner, src/protocol (other than deadline.ts, which you should not need to change), src/store, src/config, src/reporters, src/evaluation, src/media, media/, every capture file (src/browser/capture.ts, the capture files under src/browser/firefox and src/browser/webkit, src/native/capture*), src/shared, src/browser/chromium-process.ts, tests/integration/browser-*, tests/conformance, src/cli. One worker may make a small driver fix in the Firefox or WebKit page files while declaring engine differences: before each edit of a driver file, read it fresh and make anchored edits only, never a rewrite.

Then run, through the heavy-gate lock (it is busy much of the time; wait and retry as the rules say): the unit files of everything you touched; the Chrome, Firefox and WebKit driver integration files (RETEST_FIREFOX_ROUTE=launch-services on this host; that is recorded, not a defect); the native unit files. The iOS simulator and Mac desktop integration runs are worth one pass for the native loops if the lock allows; never start either outside the lock.

Never run tests while a benchmark is running; run no benchmark. Nothing may loosen what a passing test means. Never commit, stash, reset or revert; no downloads; end only processes you started and recorded and leave nothing running; no estimated dates or durations in anything you write.

End by writing docs/plans/public-beta/reviews/fix-reports/early-waits-report.md: place by place, what changed and the test that fails on the old code; exact commands and results with log paths; the src/runner changes still needed; what you could not verify, most important first.
