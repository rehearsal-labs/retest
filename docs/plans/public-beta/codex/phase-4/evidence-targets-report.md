# Evidence targets report

Verification closed with failing and unverified target capabilities. This lane changed tests and records only. The final full TypeScript check passed; all recorded process identities are absent. Phase 4 is not validated on all five targets.

## Findings and limits, most important first

1. Native CLI videos are unavailable with `no_frame_source`. Runner owner: `src/runner/native-pool.ts:316`, `NativePageAdapter`, lacks the frame-source delegation exposed by the native session. Current refusal is `src/runner/run-media.ts:464`. Real TaskPhone normal pass and expected assertion failure produced valid PNGs, but no native movie exists. Native cadence, video identity/timeline and secret-pixel video proof remain unverified.
2. None of the three browser flows has all three app videos or complete state evidence. Native source owner: `src/native/source-scope.ts:50`, desk account fill at retained `reference-flow.retest.ts:53`, refuses a tree with no owned window. Chrome broken-sync also encountered another-app phone tree, source-scope.ts:45, and one lease expired, run-session.ts:828. WebKit broken-sync reached the intended `Open` versus `Done` failure at :68, but its stale desktop pixels were not recorded. Five web timelines have checks inside named withholding; Chrome broken-sync never reached the web. This is incomplete visual evidence, not a proposed privacy relaxation.
3. macOS target was not exercised for recorded evidence. Its capture was refused by the covering window at layer 1000. Exact refusal is in `macos/macos-refusal.json` below. Wispr Flow was never moved or ended and the coverage check was not bypassed. The original run folder was removed after a concurrent async HTML API change met the old helper; its exact finished terminal JSONL survives and was reconstructed with missing-file warnings.
4. WebKit release target gate is failing on the unchanged safe-green decoded-frame witness. Media owner review: `media/src/frame.rs:97-109`, colour-profile conversion/preservation. Source JPEG has Color LCD profile; the decoded video colour witness differs. This is an unresolved colour contract, not a proven causal diagnosis. Whole decode, identity/maps and recording-off verdicts passed, but complete WebKit colour/secret-pixel proof is not claimed.
5. Native ownership owner: iOS off run's third bootstatus attempt at `src/native/ios-simulator.ts:153` ended `not_run/cleanup_failed`, CLI 2, instead of the on run's intended verdicts and CLI 1. `src/runner/native-pool.ts:167` reports the unproved start with lease held. This does not establish that recording off caused it. Final owned-device cleanup audit is clear.
6. Report owner: `src/reporters/human.ts:138-150` and :235-265 omit exact recording-gap messages when reconstructing a killed runner from JSONL. The HTML names `run_stopped`; human output gives only aggregate unavailable evidence. Two report children and their parents remain failing. Cleanup and owned partial removal checks passed independently.
7. Additional image-route tests retain two strict expectation failures per browser: `tests/integration/evidence-pixel-artifacts.test.ts:73-74` expects a literal word and categorical frame refusal. Actual screenshot reason names policy withholding without that word; a wholly withheld frame interval is inconclusive with no frames, rather than error. These new expectations are over-specified and are not release-defect proof. Their assertions were not adjusted for green. Independent decoder children passed for actual resumed frame sequences, screenshots, videos and three source-derived thumbnails per browser. Review this extra expectation before treating it as a contract.
8. Native every-tick paint-to-run-clock mapping, physical iOS devices, other platforms, live views and remote judge quality were not exercised by this lane. The fake judge checks approved references, byte lengths and hashes; the diagnostics gate hashes the actual bytes at its dispatch boundary. No compiled/package-install or release readiness claim follows from these source-CLI checks.

## Current gate results

Counts include nested tests and their failed parents, not just application verdicts. Every count below has zero skips and cancellations. Paths are relative to `.retest/evidence-targets/`; exact locked commands and retries remain in the step record below.

| Check | Passed / total | Exit | Log | Artifact root |
| --- | ---: | ---: | --- | --- |
| Step 0 focused | 1/1 | 0 | `logs/step-0.log` | in-memory seam and mutation records |
| Removed read / blocking read mutations | 0/1 each, intended failures | 1 each | `logs/step-0-{remove,blocking}.log` | no product file changed |
| Full native-processes unit file | 48/48 | 0 | `logs/unit-native-processes.log` | unit cleanup assertions |
| Chrome release target | 2/2 | 0 | `logs/chrome-release.log` | `chrome-release/` |
| Firefox release target, launch-services | 2/2 | 0 | `logs/firefox-release.log` | `firefox-release/` |
| WebKit release target | 0/2 | 1 | `logs/webkit-release.log` | `webkit-release/` |
| iOS simulator | 0/4 | 1 | `logs/ios.log` | `ios/` |
| macOS, refused and not exercised | 0/1 | 1 | `logs/macos.log` | `macos/` |
| Chrome release flow, normal + broken-sync | 2/10 | 1 | `logs/flow-chrome-release.log` | `flow-chrome-release/` |
| Firefox flow, normal + broken-sync | 2/10 | 1 | `logs/flow-firefox.log` | `flow-firefox/` |
| WebKit flow, normal + broken-sync | 2/10 | 1 | `logs/flow-webkit.log` | `flow-webkit/` |
| Shutdown, failures and next-run cleanup | 17/21 | 1 | `logs/failures-independent.log` | `failures-independent/` |
| Diagnostics flood and actual judge byte hashes | 1/1 | 0 | `logs/diagnostics-hashes.log` | `diagnostics-hashes/` |
| Queue saturation and off comparison | 1/1 | 0 | `logs/queue-final.log` | `queue-final/` |
| App timelines | 6/25 | 1 | `logs/timelines.log` | `timelines/` |
| Strengthened flow video readback | six runs / six videos | 0 | `logs/video-readback.log` | `video-readback/` |
| Extra image routes, each browser | 1/4 each | 1 each | `logs/pixels-{chrome-final,firefox,webkit}.log` | matching `pixels-*` roots |
| Full TS 6, TS 7 and example | all three completed | 0 | `logs/types-final-complete.log` | earlier failed compilers retained |
| Native cleanup audit | 13 owned devices absent, TaskDesk zero | 0 | `logs/native-audit-final.log` | `native-audit/final-result.json` |
| Process audit | 569 recorded readings, zero present | 0 | `logs/process-audit.log` | `process-audit.json` |

Fresh browser on/off CLI verdicts are `passed`, `failed/check_failed`, `passed`, exit 1 in both modes. Recording off starts no media/recording event and uses invalid media paths to prove independence. All nine target movies decoded fully and map to actual forwarded run/test/app/session/attempt identity; normal/failure PNG references also decoded. Chrome secret movie has 14 frames, 10 blue and 4 green; Firefox has 17 frames, 10 blue and 6 green. Both reject every red secret scene. WebKit has 14 frames, 10 blue and no green witness, so remains failing. No forwarded frame occupies the closed withheld intervals and no declared secret bytes were found in run or approved-observation files.

## What changed and how to rerun

Only the Step 0 section of existing `tests/unit/native-processes.test.ts` is this lane's change. It counts individual PID reads through metadata-worker requests and requires exactly one immediately before the real signal. Atomics is used only to reject main-thread blocking, across start/watch/stop. Removed-read and blocking-read in-memory mutations each failed at the intended assertion; full file passed 48/48. Other pre-existing unit edits are preserved.

Ten new integration files are `tests/integration/evidence-{support,judge,browsers,native,flows,failures,diagnostics,queue,timelines,pixel-artifacts}.test.ts`. The support and judge files are observation helpers. They run Retest's own CLI lifecycle and inspect actual results, exits, validated events, approved images and media. Observer hooks return original calls/results, except the queue fixture explicitly selects the supported bound of two. No production source file, package export, dependency or CLI command was changed. Existing reference-flow and failure assertions remain.

The documents changed are this report, `evidence-targets-state.md`, and `../../proofs/evidence.md`. The ignored `.retest/evidence-targets/` folder holds gates, observation loaders, readback helpers, exact logs, preserved raw artifacts and process identities.

Run one target at a time from the repository root using the exact command in its step entry. Each heavy gate goes through `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock` and the benchmark guard, with a fresh `RETEST_EVIDENCE_OUT`. Firefox on this host requires `RETEST_FIREFOX_ROUTE=launch-services`. Native preflight, simulator queries and desktop work also stay inside the lock. No second heavy gate was queued. No benchmark, download, commit, stash, reset, revert, publish or window workaround was performed.

Final binary digest is `6cd7160729dfc2bc2cc10ed8da10bffda1b4f8efb53d9ee7be87967af7fe27e7`, recorded in `release-binary-final.json`. The earlier `effa8c...` binary and shared source changed while this lane ran; each gate's actual events and failed history remain separate. These are single-host observations, not frozen-release or speed claims.

## Step record


## Initial read

Read repository instructions, README and architecture, lane common rules and evidence brief, Phase 4 release bullets, the stop-point lane table, and the supplied implementation reports. Existing shared-tree work is preserved. This lane edits tests and records only, with the explicitly authorized native-processes unit-test correction. No product source edit, benchmark, download or git mutation is authorized.

Logs and artifacts live under `.retest/evidence-targets/`. Every real target and compiler gate uses `lockf -t 0 /tmp/retest-heavy-gate.lock`; only one heavy command is submitted at a time. Before each test, the benchmark check must be clear. Firefox uses `RETEST_FIREFOX_ROUTE=launch-services`, a host route, not a defect. Wispr Flow is left untouched; a covered macOS window is recorded as not exercised.

## Step 0 staged

`tests/unit/native-processes.test.ts`: metadata worker requests count individual pid readings independently of Atomics. The signal hook requires exactly one individual reading of the signalled pid as the preceding host operation. Blocking waits are separately rejected across start, watch and stop. Verification and mutation checks are pending.

## Targets pending

Chrome, Firefox, WebKit, iOS simulator, macOS app, then three recorded cross-platform browser variants. No new capability is claimed yet. Existing reports are background, not this lane's results.

Step 0 focused command `node --conditions=retest-source --test --test-name-pattern="a long-running process takes no blocking ownership reading while it runs" tests/unit/native-processes.test.ts` passed 1/1, no skip, exit 0. Log `.retest/evidence-targets/logs/step-0.log`. Isolated in-memory mutations are next; working product files are never replaced.

Gate submitted `chrome`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome.log`.
Gate completed `chrome`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome.log`. Results require inspection before another gate.

Step 0 mutations both failed for the intended property, 0/1 each. Commands `RETEST_EVIDENCE_MUTATION=remove node --import ./.retest/evidence-targets/step-0-mutate.mjs --conditions=retest-source --test --test-name-pattern="a long-running process takes no blocking ownership reading while it runs" tests/unit/native-processes.test.ts` and the same with `RETEST_EVIDENCE_MUTATION=blocking`. Logs `logs/step-0-remove.log` and `logs/step-0-blocking.log` under `.retest/evidence-targets`. Removed reading failed the exact one-reading assertion; blocking reading failed zero blocking waits. Product files were loaded with an in-memory mutation only, never written.

Chrome first test attempt failed before a result folder existed. This is not target verification. Added sanitized CLI-output retention to diagnose the new test fixture; no behavioral assertion changed.

Gate submitted `chrome-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome-2.log`.
Gate completed `chrome-2`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome-2.log`. Results require inspection before another gate.

Chrome attempt 2 found a syntax error in the new observation loader: nested string escaping produced a newline inside a string literal. Corrected the loader escaping only. No target had started; no product finding and no passing check are claimed. Sanitized CLI diagnostics are `chrome/chromium-observations/cli-output.json`.

Gate submitted `chrome-3`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome-3.log`.
Gate completed `chrome-3`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome-3.log`. Results require inspection before another gate.

Chrome attempt 3 reached the real target and retained all three runs' recordings in `chrome/chromium-on`. The new test read the failure screenshot from the wrong property; the actual result names it in `TestResult.evidence`. Corrected that field access while retaining the required screenshot and independent decode assertions. The run had passed/failed/passed application verdicts, complete/complete/partial evidence, and an explicit pixels_withheld gap. Full verification still pending.

Gate submitted `chrome-4`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome-4 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome-4.log`.
Gate completed `chrome-4`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome-4.log`. Results require inspection before another gate.

Test construction step completed. New files `evidence-support.test.ts`, `evidence-browsers.test.ts`, `evidence-native.test.ts`, `evidence-flows.test.ts` own observation/decode checks, three browser scenarios with recording-on/off comparison, native equivalents, and the unchanged reference-flow assertions with added recorded-app checks. Observation hooks return original calls/results and save only frames already approved and forwarded by the runner. Native readiness assertions use the fixture's actual Connected to state. No product source changed.

Chrome attempt 4 retained a failed frame comparison, mean error 25.5966796875. The independent source decode stretched the source instead of preserving the recording's proportions and black padding. Corrected the comparison's geometry to match the documented media sizing contract; its error threshold and every sampled frame remain checked. This is test-harness geometry, not a product defect. Artifacts remain in `chrome-4/`; they are not overwritten.

Gate submitted `chrome-5`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome-5 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome-5.log`.
Gate completed `chrome-5`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome-5.log`. Results require inspection before another gate.

## Chrome result

Chrome gate 5 passed 1/1, exit 0, no skips. Three recorded tests had application verdicts passed, failed/check_failed, passed; recording-off matched all three and started no media or recording. One on-run media process served all three attempts. Evidence complete, complete, partial; the secret gap names pixels_withheld. Every video fully decoded, ffprobe frame count/duration matched, all forwarded-frame identities and frame-map order matched, and mapped samples matched source pixels. Decoded counts 8, 27, 14. Whole secret video had 9 safe blue and 5 safe green frames and zero red secret-state frames; no approved frame fell in the withheld interval and no run file held the secret. HTML outcome agrees with JSONL/result and shows all recordings and their gaps. Artifacts `.retest/evidence-targets/chrome-5/{chromium-on,chromium-off,chromium-observations}`; decode and secrecy JSON beside raw approved frames. Cadences per recorded attempt 9.728904087599052/s, 10.047751941100078/s, 3.1938065702988765/s, measured forwarded frames divided by first-to-last capture time on this host. Mode screencast. Added explicit normal-pass screenshot decode/identity/reference assertions; saved Chrome screenshots will be read back before proceeding.

Gate submitted `chrome-screenshots`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome-5 node --conditions=retest-source .retest/evidence-targets/chrome-readback.ts`. Log `.retest/evidence-targets/logs/chrome-screenshots.log`.
Gate completed `chrome-screenshots`. Exit 0. . Log `.retest/evidence-targets/logs/chrome-screenshots.log`. Results require inspection before another gate.

Chrome screenshot readback passed, exit 0, log `logs/chrome-screenshots.log`. Three real screenshots independently decoded; approved evaluation images on normal pass/failure carry the correct test/attempt/app/session identity, and HTML names exactly the judge's references. The failure screenshot also decoded.

Gate submitted `firefox`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/firefox.log`.
Gate completed `firefox`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/firefox.log`. Results require inspection before another gate.

## firefox target inspection

Run `.retest/evidence-targets/firefox/firefox-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser Firefox 133.0.3, build 20241209150345, engine firefox.
Attempt `ru7qntt16h`, web: mode screenshot-loop, source firefox, evidence partial, frames {"delivered": 8, "sent": 8, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 8, "shown": 8, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 9, "durationUs": 900000, "placedBy": "link"}.
Missing capture_incomplete: Capture lost 1 frames; 0 capture gaps were not sent and 0 were refused. browsingContext.captureScreenshot failed: unknown error (-32000)
Missing capture_gaps: The capture reported 1 stretch in which it could hand over no frame.
Attempt `kfylbkwk9o`, web: mode screenshot-loop, source firefox, evidence complete, frames {"delivered": 28, "sent": 28, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 28, "shown": 28, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 28, "durationUs": 2800000, "placedBy": "link"}.
Attempt `j0vpyhz4cx`, web: mode screenshot-loop, source firefox, evidence partial, frames {"delivered": 11, "sent": 10, "dropped": 0, "notSent": 0, "withheld": 1, "refused": 0}, media {"received": 10, "shown": 10, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 17, "durationUs": 1700000, "placedBy": "link"}.
Missing pixels_withheld: The pixel capture policy withheld 1 frame over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/firefox/firefox-observations/j0vpyhz4cx-1-1/decode.json`: 17 frames; forwarded cadence 6.1269854496349545/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "6", "videoFrame": 12, "meanAbsolutePixelError": 0.0003255208333333333}, {"frameId": "10", "videoFrame": 16, "meanAbsolutePixelError": 0.0003255208333333333}].
Decode `.retest/evidence-targets/firefox/firefox-observations/kfylbkwk9o-1-1/decode.json`: 28 frames; forwarded cadence 10.248616802753657/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "15", "videoFrame": 14, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "28", "videoFrame": 27, "meanAbsolutePixelError": 0.0022786458333333335}].
Decode `.retest/evidence-targets/firefox/firefox-observations/ru7qntt16h-1-1/decode.json`: 9 frames; forwarded cadence 9.884145460026662/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "5", "videoFrame": 5, "meanAbsolutePixelError": 0.006184895833333333}, {"frameId": "8", "videoFrame": 8, "meanAbsolutePixelError": 0.009114583333333334}].
Off run `.retest/evidence-targets/firefox/firefox-off`, verdicts compared in integration; no media or recording event.

Gate submitted `webkit`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/webkit.log`.
Gate completed `webkit`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/webkit.log`. Results require inspection before another gate.

Gate submitted `webkit-color-readback`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit node --conditions=retest-source .retest/evidence-targets/color-readback.ts`. Log `.retest/evidence-targets/logs/webkit-color-readback.log`.
Gate completed `webkit-color-readback`. Exit 0. . Log `.retest/evidence-targets/logs/webkit-color-readback.log`. Results require inspection before another gate.

## webkit target inspection

Run `.retest/evidence-targets/webkit/webkit-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser WebKit 626.1.6+, build 2359, build 2359, engine webkit.
Attempt `rtcq1xb4lv`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 3, "sent": 3, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 3, "shown": 3, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 8, "durationUs": 800000, "placedBy": "link"}.
Attempt `ezg111gpqg`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 4, "sent": 4, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 4, "shown": 4, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 27, "durationUs": 2700000, "placedBy": "link"}.
Attempt `044ub9zzmd`, web: mode screencast, source webkit, evidence partial, frames {"delivered": 3, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 1, "refused": 0}, media {"received": 2, "shown": 2, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 15, "durationUs": 1500000, "placedBy": "link"}.
Missing pixels_withheld: The pixel capture policy withheld 1 frame over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/webkit/webkit-observations/044ub9zzmd-1-1/decode.json`: 15 frames; forwarded cadence 2.0227007707501286/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.12858072916666666}, {"frameId": "2", "videoFrame": 10, "meanAbsolutePixelError": 0.8763020833333334}].
Decode `.retest/evidence-targets/webkit/webkit-observations/ezg111gpqg-1-1/decode.json`: 27 frames; forwarded cadence 2.8992839493466103/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.1396484375}, {"frameId": "3", "videoFrame": 13, "meanAbsolutePixelError": 0.7939453125}, {"frameId": "4", "videoFrame": 14, "meanAbsolutePixelError": 0.79296875}].
Decode `.retest/evidence-targets/webkit/webkit-observations/rtcq1xb4lv-1-1/decode.json`: 8 frames; forwarded cadence 7.088478387229397/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 1.1041666666666667}, {"frameId": "2", "videoFrame": 1, "meanAbsolutePixelError": 0.17122395833333334}, {"frameId": "3", "videoFrame": 4, "meanAbsolutePixelError": 0.814453125}].

WebKit first run independently decoded all three videos, mapped samples and screenshots, with no secret frame or bytes. The new colour-witness check failed on the safe green scene. Retained readback `logs/webkit-color-readback.log` compares the same video with YUV-before-scale and RGB-before-scale: chroma subsampling at a single pixel changed the green witness to [109,242,68]; RGB-first gives the actual mean colour. Corrected the decoder to convert to RGB before averaging; no colour threshold, frame or secrecy assertion changed. Initial failure remains recorded. Recording-off comparison has not yet run for WebKit.

Gate submitted `webkit-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit-2 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/webkit-2.log`.
Gate completed `webkit-2`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/webkit-2.log`. Results require inspection before another gate.

Gate submitted `webkit-color-full-readback`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit node --conditions=retest-source .retest/evidence-targets/color-readback.ts`. Log `.retest/evidence-targets/logs/webkit-color-full-readback.log`.
Gate completed `webkit-color-full-readback`. Exit 0. . Log `.retest/evidence-targets/logs/webkit-color-full-readback.log`. Results require inspection before another gate.

Correction to the prior WebKit diagnosis: converting to RGB before the one-pixel scale did not cure the colour witness. WebKit attempt 2 still fails the unchanged safe-before/after assertion. The earlier chroma explanation was provisional and not established. No passing WebKit gate is claimed. Further retained-pixel diagnosis follows before deciding whether this is a product finding.

The WebKit safe-state witness remains failing after RGB-first readback. Decoded approved JPEG pixels average [116.92838541666667,251.84505208333334,75.94921875] while the image viewer displays the CSS green scene. The video's sampled frames match the source in the unchanged grayscale comparison. This is not yet established as a product defect; the independent colour witness and WebKit JPEG interpretation need review at `tests/integration/evidence-browsers.test.ts:95`, with the target bytes forwarded at `src/browser/webkit/capture.ts:178`. The unchanged secrecy assertion remains failing. Moved the secrecy checks into an awaited subtest so their failure does not suppress the separate recording-off check. No assertion or threshold was removed or loosened.

Gate submitted `webkit-3`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit-3 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/webkit-3.log`.
Gate completed `webkit-3`. Exit 1. ℹ tests 2; ℹ pass 0; ℹ fail 2; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/webkit-3.log`. Results require inspection before another gate.

Gate submitted `webkit-colour-artifact`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit node --conditions=retest-source .retest/evidence-targets/color-readback.ts`. Log `.retest/evidence-targets/logs/webkit-colour-artifact.log`.
Gate completed `webkit-colour-artifact`. Exit 0. . Log `.retest/evidence-targets/logs/webkit-colour-artifact.log`. Results require inspection before another gate.

## webkit-3 target inspection

Run `.retest/evidence-targets/webkit-3/webkit-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser WebKit 626.1.6+, build 2359, build 2359, engine webkit.
Attempt `yfzlhz8srd`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 3, "sent": 3, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 3, "shown": 2, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 8, "durationUs": 800000, "placedBy": "link"}.
Attempt `ovccmiurx0`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 2, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 2, "shown": 2, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 27, "durationUs": 2700000, "placedBy": "link"}.
Attempt `n3z01f7k68`, web: mode screencast, source webkit, evidence partial, frames {"delivered": 3, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 1, "refused": 0}, media {"received": 2, "shown": 2, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 14, "durationUs": 1400000, "placedBy": "link"}.
Missing pixels_withheld: The pixel capture policy withheld 1 frame over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/webkit-3/webkit-observations/n3z01f7k68-1-1/decode.json`: 14 frames; forwarded cadence 2.0603093760559084/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.12858072916666666}, {"frameId": "2", "videoFrame": 10, "meanAbsolutePixelError": 0.8759765625}].
Decode `.retest/evidence-targets/webkit-3/webkit-observations/ovccmiurx0-1-1/decode.json`: 27 frames; forwarded cadence 5.307278135871628/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.1396484375}, {"frameId": "2", "videoFrame": 4, "meanAbsolutePixelError": 0.79296875}].
Decode `.retest/evidence-targets/webkit-3/webkit-observations/yfzlhz8srd-1-1/decode.json`: 8 frames; forwarded cadence 7.224354744715384/s; sampled source comparison [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.1396484375}, {"frameId": "3", "videoFrame": 4, "meanAbsolutePixelError": 0.8343098958333334}].
Off run `.retest/evidence-targets/webkit-3/webkit-off`, verdicts compared in integration; no media or recording event.

## WebKit result and media finding

WebKit attempt 3 failed 0/2, including the unchanged safe-green subtest and its parent; no skip. Recording off nevertheless ran and matched all three application verdicts and exit 1, with no media/recording event. All three recordings fully decoded with identity, order, container facts and source samples; normal pass/failure screenshots decoded and HTML referenced the judge's exact approved images. No forwarded secret-interval frame and no secret bytes in any run file. Artifact `.retest/evidence-targets/webkit-3/`; exact frame counts, cadence, gap and source metadata are recorded above. This is a failing evidence gate, not five-target verification.

A colour-fidelity finding for the media owner is retained at `media/src/frame.rs:97` through `:109`, `onto_canvas` converts decoded images into RGB without preserving or converting their embedded colour profile. Scenario: WebKit screencast JPEG of CSS #00ff00 has profile Color LCD and displays saturated green; the independently decoded MP4 safe-after frame has no profile and displays a lighter yellow-green. Source `.retest/evidence-targets/webkit/webkit-observations/044ub9zzmd-1-1/2.jpg`; decoded video frame `.retest/evidence-targets/webkit/decoded-safe-after.png`; decoder log `logs/webkit-colour-artifact.log`. The unchanged colour witness fails on three real WebKit runs. Native paint-clock proof is unaffected by this diagnosis. No media or driver product code was edited. Review is needed to settle the capture/encoding colour-profile contract; no colour threshold was relaxed to obtain a pass.

Gate submitted `types-before-native`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-before-native.log`.
Gate completed `types-before-native`. Exit 2. . Log `.retest/evidence-targets/logs/types-before-native.log`. Results require inspection before another gate.

Gate submitted `types-before-native-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-before-native-2.log`.
Gate completed `types-before-native-2`. Exit 0. . Log `.retest/evidence-targets/logs/types-before-native-2.log`. Results require inspection before another gate.

The first typecheck stopped at evidence-support.test.ts:60 because isolatedDeclarations requires an explicit type for the defaulted decoder bound. Added the number annotation without changing the bound. Repeated full npm run typecheck passed exit 0: pinned TypeScript, TypeScript 7 and the example project. Native target gates follow.

Gate submitted `ios`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_NATIVE=ios-simulator RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/ios node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts`. Log `.retest/evidence-targets/logs/ios.log`.

Prepared evidence-failures.test.ts using the existing real-Chrome recording endings, exit and leftovers scenarios. Their verdict, cleanup and evidence assertions remain unchanged; added preserved CLI output, HTML outcome/gap checks and terminal/process exit agreement. Not yet exercised. No heavy command added while iOS runs.

Prepared evidence-diagnostics.test.ts: recording during 2,000 console entries generated from a real secret fill; ten kept entries and a byte bound; dropped counts; two required screenshot AI checks and exact saved/hash/size/HTML references. Not yet run. No product edits.

Prepared evidence-queue.test.ts: a real Chrome animated page, real media/ffmpeg and recorded encoder identity; a supported protocol queue bound of two, deliberate SIGSTOP/SIGCONT stall, at least ten dropped frames, full video decode, HTML gap and unchanged application pass. Injection changes only the test-selected queue bound. Not yet run.

## iOS finding during gate

Real TaskPhone on iPhone 17 / iOS 26.5 ran all three application tests: passed, expected check_failed, passed secret fill. Recording checks fail because all three recordings are unavailable with no_frame_source: "Retest has no frame source for iOS simulator apps yet, so this session was not recorded." Owning runner lane: src/runner/native-pool.ts:316 NativePageAdapter exposes screenshot/capture but no frameSource delegation; src/native/interaction-session.ts:186 and src/native/session.ts:329 already expose it, and src/runner/run-media.ts:534 checks the adapter. Scenario: real native recording through retest run. No product edit or assertion change. Retained run .retest/evidence-targets/ios/ios-simulator-on/. Off comparison is still running. Native recorded-video identity, cadence and secret-pixel decode remain unverified because no video was captured.

Native screenshot verification is now an independent subtest, retaining every video assertion so missing native videos do not suppress checks of screenshots that were captured. macOS coverage detection also reads failure/evaluation refusal messages, because the missing adapter hook can prevent a recording gap from carrying the window refusal. This preserves the host refusal and stops before an off retry on a covered app. iOS gate already loaded its earlier test; screenshots will be read back separately.

Created the required proofs/evidence.md as a live record with completed browser gates and current native findings. Flow media assertions now run independently per app; no check was removed, so a missing native video cannot suppress the real web video checks. Flows are not yet exercised.

Added human terminal replay from the same recorded events/result to the evidence helper, saving terminal-report.txt and checking exact count parts and every missing recording reason against HTML/JSONL. Existing browser/iOS retained results will receive an independent readback gate for this added check; no passing result is assumed from an earlier test version.

The iOS off run has a separate setup/ownership failure on its third attempt: test.finished is not_run/cleanup_failed from xcrun simctl bootstatus. Exact event text is retained in .retest/evidence-targets/ios/ios-off-interim/events.jsonl, sequence 42, while CLI cleanup continues. Owner scenario: third sequential simulator session with recording off; src/native/ios-simulator.ts:153 invokes bootstatus, src/shared/process-ownership.ts:466 and src/shared/metadata-process.ts:109 reject readings after their deadlines. This does not establish matching on/off verdicts. No process is ended by a bare pid from an event. Final cleanup and result remain pending.

Prepared retained-artifact report-readback.ts for fresh human/JSONL/HTML agreement and independent native/browser screenshots without relaunching a target. It will run under the lock after the current native gate; no second heavy gate is queued.
Gate completed `ios`. Exit 1. ℹ tests 4; ℹ pass 0; ℹ fail 4; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/ios.log`. Results require inspection before another gate.

Visually inspected both retained iOS evaluation PNGs. They show TaskPhone, the connected service and the empty sign-in form before input, matching the two AI-check timeline positions. Independent decoder and HTML reference readback remain queued only after the current gate ends. No video is inferred from those screenshots.

## ios target inspection

Run `.retest/evidence-targets/ios/ios-simulator-on`. Exit 1. Verdicts [["ready", "passed", null], ["wrong", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 0.
Native identity {"platform": "ios-simulator", "app": {"bundleId": "dev.retest.fixtures.taskphone", "version": "1.0", "build": "1", "path": "/Users/dragon/Library/Developer/CoreSimulator/Devices/8632D5D7-30F3-4D73-BE39-BB12038F21BE/data/Containers/Bundle/Application/EBB40297-010B-4D02-A2E4-BD14235E3D0B/TaskPhone.app", "sha256": "1a2972daa5d0da1d333b607a477a9295f678c82cdadcdce0ea63242fddca4a85"}, "os": {"name": "iOS", "version": "26.5", "build": "23F77"}, "device": {"name": "retest-native-62580-18b99c40", "type": "iPhone 17", "udid": "8632D5D7-30F3-4D73-BE39-BB12038F21BE"}, "executor": {"name": "webdriveragent", "version": "16.13.6", "commit": "9d1d17ddb59e6097ddc3324b23ca9f4174507b12", "commitVerified": true, "productsSha256": "0ddb9244e806b6a5d3b8248189d1816f7a7fd828fd7301ecaa46bd482bad8aec", "codeDirectoryHash": "6536ddf3398ac1008b61fa1762121bb7e432d7b8", "origin": "built"}, "xcode": {"version": "26.5", "build": "17F42"}}.
Native identity {"platform": "ios-simulator", "app": {"bundleId": "dev.retest.fixtures.taskphone", "version": "1.0", "build": "1", "path": "/Users/dragon/Library/Developer/CoreSimulator/Devices/F1BBB627-BDF9-46FC-87B5-44A327AF08B0/data/Containers/Bundle/Application/A2A8E3F2-96F6-41BA-B852-3AD114981CB7/TaskPhone.app", "sha256": "1a2972daa5d0da1d333b607a477a9295f678c82cdadcdce0ea63242fddca4a85"}, "os": {"name": "iOS", "version": "26.5", "build": "23F77"}, "device": {"name": "retest-native-62580-0b98f86d", "type": "iPhone 17", "udid": "F1BBB627-BDF9-46FC-87B5-44A327AF08B0"}, "executor": {"name": "webdriveragent", "version": "16.13.6", "commit": "9d1d17ddb59e6097ddc3324b23ca9f4174507b12", "commitVerified": true, "productsSha256": "0ddb9244e806b6a5d3b8248189d1816f7a7fd828fd7301ecaa46bd482bad8aec", "codeDirectoryHash": "6536ddf3398ac1008b61fa1762121bb7e432d7b8", "origin": "built"}, "xcode": {"version": "26.5", "build": "17F42"}}.
Native identity {"platform": "ios-simulator", "app": {"bundleId": "dev.retest.fixtures.taskphone", "version": "1.0", "build": "1", "path": "/Users/dragon/Library/Developer/CoreSimulator/Devices/EFB6D946-D845-4E96-9BED-480C11C6BF74/data/Containers/Bundle/Application/C9E994D8-5E14-4C7E-8C38-1AB87CB5B371/TaskPhone.app", "sha256": "1a2972daa5d0da1d333b607a477a9295f678c82cdadcdce0ea63242fddca4a85"}, "os": {"name": "iOS", "version": "26.5", "build": "23F77"}, "device": {"name": "retest-native-62580-ed0136ea", "type": "iPhone 17", "udid": "EFB6D946-D845-4E96-9BED-480C11C6BF74"}, "executor": {"name": "webdriveragent", "version": "16.13.6", "commit": "9d1d17ddb59e6097ddc3324b23ca9f4174507b12", "commitVerified": true, "productsSha256": "0ddb9244e806b6a5d3b8248189d1816f7a7fd828fd7301ecaa46bd482bad8aec", "codeDirectoryHash": "6536ddf3398ac1008b61fa1762121bb7e432d7b8", "origin": "built"}, "xcode": {"version": "26.5", "build": "17F42"}}.
Attempt `7tb2g2upvq`, phone: mode None, source None, evidence unavailable, frames null, media null, video null.
Missing no_frame_source: Retest has no frame source for iOS simulator apps yet, so this session was not recorded.
Attempt `hoptr9ehjq`, phone: mode None, source None, evidence unavailable, frames null, media null, video null.
Missing no_frame_source: Retest has no frame source for iOS simulator apps yet, so this session was not recorded.
Attempt `msw2jo2zhd`, phone: mode None, source None, evidence unavailable, frames null, media null, video null.
Missing no_frame_source: Retest has no frame source for iOS simulator apps yet, so this session was not recorded.
Off run `.retest/evidence-targets/ios/ios-simulator-off`, verdicts compared in integration; no media or recording event.

## iOS final gate result

Gate ios failed 0/4, exit 1; no skip or cancellation. On-run CLI exit 1 with passed/check_failed/passed; no video and no media start, all three recording records explicitly unavailable/no_frame_source. HTML names each missing source and keeps verdicts. Off-run CLI exit 2: first two verdicts are passed/check_failed, third is not_run/cleanup_failed on bootstatus ownership deadlines; verdict equality fails unchanged. Final preserved folders are ios-simulator-on and ios-simulator-off under .retest/evidence-targets/ios. The interim off folder is explicitly not final. Independent screenshot/readback and final simulator/process audit still pending.

Gate submitted `macos`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_NATIVE=macos RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/macos node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts`. Log `.retest/evidence-targets/logs/macos.log`.
Gate completed `macos`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/macos.log`. Results require inspection before another gate.

## macOS refusal and concurrent report API change

macOS target gate failed 0/1, exit 1, no skip, while saving HTML: buildReport now returns a Promise (source modification time changed during the iOS gate), so this lane's helper now awaits that API and its callers await the helper. No source or assertion changed. CLI events/output were saved before this error at .retest/evidence-targets/macos/macos-observations/cli-output.json. The first native AI capture refused: "1 window(s) of other processes lie over the app's window (layer 1000), so a capture would hold their pixels. Retest captures the window only when nothing lies over it." This host fact is consistent with the supplied Wispr Flow coverage fact. macOS is NOT EXERCISED for recorded evidence. No window was moved or ended and no off retry will be made. All three native recording records also name no_frame_source. The two later app attempts report no window in the tree. Original run folder was removed by the harness after the HTML helper error; its exact terminal JSONL remains and will be rebuilt as an interrupted record readback without claiming the removed files exist.

Gate submitted `types-after-native`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-after-native.log`.
Gate completed `types-after-native`. Exit 2. . Log `.retest/evidence-targets/logs/types-after-native.log`. Results require inspection before another gate.

Clarification: the macOS retained terminal JSONL contains run.finished. Its rebuilt report is a finished run with missing removed files, not an interrupted run. Prepared macos-rebuild.ts and native-audit.ts to preserve that distinction and verify reported native identities without signals. Not queued while typecheck runs.

Full typecheck after native stopped at TypeScript 6, exit 2. Corrected this lane's unexecuted queue test to read the protocol's media.dropped field (bound remains at least ten). External mid-edit errors are src/native/capture.ts:105 unused withheld and src/reporters/code-frame.ts:59/:67 parents inferred as any[]. No external file was edited. TS7 and examples did not run in this failed wrapper. A retry follows only after other useful readback work.

Gate submitted `macos-rebuild`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/macos node --conditions=retest-source .retest/evidence-targets/macos-rebuild.ts`. Log `.retest/evidence-targets/logs/macos-rebuild.log`.
Gate completed `macos-rebuild`. Exit 0. . Log `.retest/evidence-targets/logs/macos-rebuild.log`. Results require inspection before another gate.

Gate submitted `native-audit`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py node --conditions=retest-source .retest/evidence-targets/native-audit.ts`. Log `.retest/evidence-targets/logs/native-audit.log`.
Gate completed `native-audit`. Exit 0. . Log `.retest/evidence-targets/logs/native-audit.log`. Results require inspection before another gate.

macos-rebuild readback passed exit 0. Exact CLI JSONL reconstructed the finished run (two failed, one inconclusive, exit 1) and saved the exact coverage refusal in macos-refusal.json; HTML under macos-rebuilt-from-terminal names the removed original files. This verifies the refusal record, not the macOS target. The proof matrix is current. Native audit runs as the sole locked gate before the three flow engines.

Gate submitted `report-readback`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/readback node --conditions=retest-source .retest/evidence-targets/report-readback.ts .retest/evidence-targets/chrome-5/chromium-on .retest/evidence-targets/chrome-5/chromium-off .retest/evidence-targets/firefox/firefox-on .retest/evidence-targets/firefox/firefox-off .retest/evidence-targets/webkit-3/webkit-on .retest/evidence-targets/webkit-3/webkit-off .retest/evidence-targets/ios/ios-simulator-on .retest/evidence-targets/ios/ios-simulator-off`. Log `.retest/evidence-targets/logs/report-readback.log`.
Gate completed `report-readback`. Exit 0. . Log `.retest/evidence-targets/logs/report-readback.log`. Results require inspection before another gate.

Native audit passed exit 0: all five reported simulator identities are absent, TaskDesk is absent, and no listed simulator name belongs to either recorded iOS CLI pid 62580 or 65775 (including the failed third off setup). There are 22 other simulator entries; they were not changed. No signal was sent. Report/screenshot readback passed exit 0 for eight retained on/off folders: terminal/JSONL/result/HTML counts and missing reasons agree, and twelve on-run screenshots independently decoded across Chrome, Firefox, WebKit and iOS. Native screenshots do not supply missing video evidence. Logs native-audit.log and report-readback.log; audit .retest/evidence-targets/native-audit/result.json; agreement .retest/evidence-targets/readback/report-readback.json.

Gate submitted `types-after-native-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-after-native-2.log`.
Gate completed `types-after-native-2`. Exit 2. . Log `.retest/evidence-targets/logs/types-after-native-2.log`. Results require inspection before another gate.

Repeated full typecheck failed at TypeScript 6, exit 2, with no error in this lane: code-frame.ts parents type and tests/unit/regular-file.test.ts:66/:102 options versus ReadHooks. These files are being edited outside this lane; they remain untouched. Native capture unused-parameter error no longer appears. TS7/examples were not reached. Recorded Chrome flow gate follows; no benchmark runs.

Gate submitted `flow-chrome`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`. Log `.retest/evidence-targets/logs/flow-chrome.log`.
Gate `flow-chrome` lock busy, exit 75; no test started.

The not-yet-executed diagnostics flood test also requires exactly one withholding/resume stretch, no forwarded frame in it and no red exposed-secret scene in any decoded video frame. This supplements byte sanitization with a pixel witness; screenshots already use saved/hash/size/HTML reference checks. Chrome flow remains the sole active heavy gate.
Gate `flow-chrome` lock busy, exit 75; no test started.

## Cadence calculation correction

Earlier decode.json cadence used frame count / first-to-last span, which includes one extra interval. Corrected derived measurement to (forwarded frames - 1) / elapsed capture time; the span includes secret withholding. This changes no assertion, threshold, capture or encoding. Original decode.json files remain retained; fresh corrected measurements are cadence-corrected.json beside each decode.json. Source cadence and requested encoder FPS are separate; one frame has no measurable interval.
{"target": "chrome-5", "recording": "794d1o0496-1-1", "forwardedFrames": 4, "cadencePerSecond": 7.29667806569929, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 1123519, "lastUs": 1534665}
{"target": "chrome-5", "recording": "7op3ci0z9t-1-1", "forwardedFrames": 4, "cadencePerSecond": 7.535813955825058, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 2305564, "lastUs": 2703663}
{"target": "chrome-5", "recording": "qxqnhhpvhm-1-1", "forwardedFrames": 3, "cadencePerSecond": 2.129204380199251, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 5583842, "lastUs": 6523160}
{"target": "firefox", "recording": "ru7qntt16h-1-1", "forwardedFrames": 8, "cadencePerSecond": 8.64862727752333, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 1783765, "lastUs": 2593142}
{"target": "firefox", "recording": "j0vpyhz4cx-1-1", "forwardedFrames": 10, "cadencePerSecond": 5.514286904671459, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 9072464, "lastUs": 10704588}
{"target": "firefox", "recording": "kfylbkwk9o-1-1", "forwardedFrames": 28, "cadencePerSecond": 9.882594774083884, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 3672460, "lastUs": 6404536}
{"target": "webkit-3", "recording": "yfzlhz8srd-1-1", "forwardedFrames": 3, "cadencePerSecond": 4.816236496476923, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 1899575, "lastUs": 2314837}
{"target": "webkit-3", "recording": "n3z01f7k68-1-1", "forwardedFrames": 2, "cadencePerSecond": 1.0301546880279542, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 6688654, "lastUs": 7659382}
{"target": "webkit-3", "recording": "ovccmiurx0-1-1", "forwardedFrames": 2, "cadencePerSecond": 2.653639067935814, "method": "forwarded intervals / first-to-last capture span, including withholding", "firstUs": 3319294, "lastUs": 3696135}

Prepared a final read-only process audit of every recorded gate/decoder pid and its start/command identity. Reused pids will be recorded and left alone; the audit sends no signal. Runtime/browser/media ownership checks remain in the real-run harness and failure scenarios, with native device checks separate. No second heavy gate is queued.

New gates now copy raw run files before any report assertion through preserveReport. A report failure therefore retains the run for its owner; approved HTML/terminal files are added only after that check passes. No verdict, screenshot, video or report assertion was removed. The active Chrome flow already loaded the earlier helper; future gates use this preservation order. Failure scenarios also preserve raw files before report verification.

## Chrome flow first run findings

The normal flow retained all three recording records and failed their playable-video checks. Phone and desk name no_frame_source (native-pool adapter finding above). Web names media_unavailable: the explicit debug binary is now refused because current discovery expects a release build. This is a prerequisite/profile mismatch after the shared installer guard changed, not a browser capture defect and not bypassed. The first run .retest/evidence-targets/flow-chrome/chromium-recorded has no media process/video. Application status is failed/not_actionable: reference-flow.retest.ts:53 filling the desk account gets "The app has no window in its tree" with input not_sent. Owning native source/actionability lane; inspect src/native/macos-app.ts source/owned window route and src/native/source.ts. No assertion or product source change. Broken-sync variant is still running under the same gate. A matching existing-source release binary must be built offline through the lock before later media gates; none is queued now.

Corrected the native source finding location: src/native/source-scope.ts:50 emits the missing-window refusal; src/native/macos-app.ts:490-491 delegates owned source through src/native/webdriver-client.ts:261. src/native/source.ts does not exist and was an erroneous location in the preceding note.

The test helper now explicitly selects media/target/release/retest-media, matching current discovery's profile contract. No profile check, assertion or SDK path was bypassed. The current Chrome gate already loaded its debug setting; it stays recorded as failing. Matching release build and subsequent real-target checks wait for this gate to finish. This lane will make no claim that earlier debug-binary gates verify the new release-profile discovery guard.
Gate completed `flow-chrome`. Exit 1. ℹ tests 10; ℹ pass 0; ℹ fail 10; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/flow-chrome.log`. Results require inspection before another gate.

The unexecuted failure suite now adds recording-off verdict/exit baselines for media loss, encoder loss, SIGINT and browser loss, in addition to the existing unchanged timeout baseline. Off browser loss kills only a freshly recorded owned browser; SIGINT signals only the launched runner. Each baseline is preserved and requires no media event. Original failure/cleanup assertions are retained.

## flow-chrome target inspection


Chrome initial flow gate completed failing, 0/10, no skip/cancellation. Both normal and broken-sync variants reached real Chrome/iOS/macOS setup but failed on desk account fill with missing owned window; broken-sync did not reach its intended desk state check. Both retain no_frame_source for native apps and release-profile refusal for web. Artifact folders chromium-recorded and chromium-broken-sync-recorded under .retest/evidence-targets/flow-chrome; cache copies and engine identities are in flow-chrome.log. All base assertions remain intact. No passing cross-platform recording claim. Offline matching release build follows as the sole next gate.

Gate submitted `media-release-build`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py cargo build --release --locked --offline --manifest-path media/Cargo.toml`. Log `.retest/evidence-targets/logs/media-release-build.log`.
Gate `media-release-build` lock busy, exit 75; no test started.
Gate `media-release-build` lock busy, exit 75; no test started.
Gate `media-release-build` lock busy, exit 75; no test started.

Observation loader now records a fixed end-error.json marker when a recording-ending promise rejects, without persisting arbitrary error text. A rejected ending is not silently accepted: video verification still requires the real end.json, and the run recording gap supplies the exact reason. No source or assertion changed. Matching release build remains waiting for the lock.
Gate completed `media-release-build`. Exit 0. . Log `.retest/evidence-targets/logs/media-release-build.log`. Results require inspection before another gate.

Offline release build passed exit 0, cargo --release --locked --offline; three busy-lock attempts preceded acquisition. No package download or dependency change. Log media-release-build.log. The release artifact already matched Cargo's current sources when this gate acquired the lock. A fresh Chrome recorded-flow gate follows with this explicitly selected release binary; earlier debug-profile failure is retained.

Gate submitted `flow-chrome-release`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-chrome-release node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`. Log `.retest/evidence-targets/logs/flow-chrome-release.log`.

Failure suite now uses PID-recorded asynchronous decoder commands with every original ffprobe/whole-decode assertion retained. Raw run/report saving precedes outcome assertions when a finished run is returned, so an unexpected verdict is reviewable. No existing behavioral assertion was weakened. The suite remains unexecuted; Chrome release flow is the sole active gate.

## Chrome release flow normal run

Web video independently decoded and mapped with the explicit matching release binary; native recordings still no_frame_source and normal application flow still failed/not_actionable at desk account fill before its final check. HTML and human terminal preserve that observed failure and the named native gaps. The web subtest is a narrow pass, not a passing three-app flow. Run .retest/evidence-targets/flow-chrome-release/chromium-recorded; approved frames and decode.json in chromium-observations. Broken-sync is still running.
{"app": "phone", "status": "unavailable", "source": null, "mode": null, "frames": null, "media": null, "video": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for iOS simulator apps yet, so this session was not recorded.", "app": "phone", "sessionId": "9zaw5kebzw:phone"}]}
{"app": "web", "status": "partial", "source": "chromium", "mode": "screencast", "frames": {"delivered": 62, "sent": 62, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "media": {"received": 62, "shown": 34, "superseded": 28, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 507, "durationUs": 50700000, "placedBy": "link"}, "gaps": [{"code": "capture_incomplete", "message": "Capture lost 2 frames; 0 capture gaps were not sent and 0 were refused.", "app": "web", "sessionId": "9zaw5kebzw:web"}, {"code": "capture_gaps", "message": "The capture reported 3 stretches in which it could hand over no frame.", "app": "web", "sessionId": "9zaw5kebzw:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "9zaw5kebzw:web"}]}
{"app": "desk", "status": "unavailable", "source": null, "mode": null, "frames": null, "media": null, "video": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for macOS apps yet, so this session was not recorded.", "app": "desk", "sessionId": "9zaw5kebzw:desk"}]}
.retest/evidence-targets/flow-chrome-release/chromium-observations/9zaw5kebzw-2-1/decode.json {
  "identity": {
    "runId": "bdec0511-fef2-42a3-b146-36b406b3ca35",
    "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id",
    "attemptId": "9zaw5kebzw",
    "app": "web",
    "sessionId": "9zaw5kebzw:web"
  },
  "probe": {
    "programs": [],
    "stream_groups": [],
    "streams": [
      {
        "codec_name": "h264",
        "width": 320,
        "height": 240,
        "nb_read_frames": "507"
      }
    ],
    "format": {
      "duration": "50.700000"
    }
  },
  "decodedFrames": 507,
  "samples": [
    {
      "frameId": "1",
      "videoFrame": 0,
      "meanAbsolutePixelError": 0.875
    },
    {
      "frameId": "30",
      "videoFrame": 338,
      "meanAbsolutePixelError": 0.3033854166666667
    },
    {
      "frameId": "62",
      "videoFrame": 498,
      "meanAbsolutePixelError": 0.3030598958333333
    }
  ],
  "captureCadencePerSecond": 1.2242335219422285,
  "cadenceMethod": "forwarded intervals / elapsed time between first and last forwarded capture timestamps; secret withholding remains in that elapsed span",
  "recording": {
    "recordingId": "9zaw5kebzw-2-1",
    "sequence": 1,
    "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id",
    "attemptId": "9zaw5kebzw",
    "app": "web",
    "sessionId": "9zaw5kebzw:web",
    "source": "chromium",
    "mode": "screencast",
    "frames": {
      "delivered": 62,
      "sent": 62,
      "dropped": 0,
      "notSent": 0,
      "withheld": 0,
      "refused": 0
    },
    "withheld": {
      "stretches": 1,
      "durationUs": 1102994
    },
    "stoppedBy": "attempt_ended",
    "path": "artifacts/9zaw5kebzw/web-1fszmh3anyupd/recording-1.mp4",
    "status": "partial",
    "gaps": [
      {
        "code": "capture_incomplete",
        "message": "Capture lost 2 frames; 0 capture gaps were not sent and 0 were refused.",
        "app": "web",
        "sessionId": "9zaw5kebzw:web"
      },
      {
        "code": "capture_gaps",
        "message": "The capture reported 3 stretches in which it could hand over no frame.",
        "app": "web",
        "sessionId": "9zaw5kebzw:web"
      },
      {
        "code": "pixels_withheld",
        "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.",
        "app": "web",
        "sessionId": "9zaw5kebzw:web"
      }
    ],
    "media": {
      "received": 62,
      "shown": 34,
      "superseded": 28,
      "dropped": 0,
      "outOfOrder": 0,
      "outOfRange": 0,
      "undecodable": 0,
      "duplicate": 0,
      "unprocessed": 0
    },
    "captureGaps": 4,
    "clock": {
      "capture": "run_us",
      "videoZeroUs": 51692470,
      "durationUs": 50700000,
      "shortened": [],
      "shortenedCount": 0
    },
    "finalizeMs": 63,
    "video": {
      "codec": "h264",
      "container": "mp4",
      "width": 320,
      "height": 240,
      "fps": 10,
      "outputFrames": 507,
      "durationUs": 50700000,
      "placedBy": "link"
    }
  }
}

WebKit privacy interpretation remains bounded by its failed colour witness: no frame was forwarded in the closed withheld interval and no secret bytes were found, but the safe-scene pixel check is failing and the colour-profile cause still needs review. Do not treat that gate as complete proof of secret-pixel absence or colour fidelity. Chrome/Firefox positive safe-scene witnesses passed on the earlier path; fresh release-backed browser checks remain pending.

The active Chrome release broken-sync run has a different application refusal: reference-flow.retest.ts:25 service-status read receives "The tree is of another app, not dev.retest.fixtures.taskphone". This is refused before input; no attempt to attach to or drive that other app is made. The CLI has closed media and emitted lease.expired; native cleanup remains active. No broken-sync final-state claim. Exact final artifacts will be retained when the run returns.
Gate completed `flow-chrome-release`. Exit 1. ℹ tests 10; ℹ pass 2; ℹ fail 8; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/flow-chrome-release.log`. Results require inspection before another gate.

## flow-chrome-release target inspection

Decode `.retest/evidence-targets/flow-chrome-release/chromium-broken-sync-observations/g7ajjgpw74-2-1/decode.json`: 147 frames; forwarded cadence None/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.875}].
Decode `.retest/evidence-targets/flow-chrome-release/chromium-observations/9zaw5kebzw-2-1/decode.json`: 507 frames; forwarded cadence 1.2242335219422285/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.875}, {"frameId": "30", "videoFrame": 338, "meanAbsolutePixelError": 0.3033854166666667}, {"frameId": "62", "videoFrame": 498, "meanAbsolutePixelError": 0.3030598958333333}].

Chrome release flow gate completed exit 1, 2/10 passed and 8 failed, no skip/cancellation. Only the two web recording leaf checks passed. Normal flow fails desk account input before its final check; broken-sync fails the phone's initial service-status read as another-app tree, then emits one lease.expired. All original zero-expiry and application assertions remain failing. Native recorded videos and stale desk state are unverified. Own simulator, native runner, TaskDesk and browser disappearance assertions ran before the lease-expiry assertion; they passed. Final retained folders chromium-recorded and chromium-broken-sync-recorded; engine, movie counts/cadence/gaps and cache copies are in the gate log and observations. Firefox flow follows with the required launch-services host route and release binary.

Gate submitted `flow-firefox`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`. Log `.retest/evidence-targets/logs/flow-firefox.log`.

Proof record updated with both Chrome flow attempts and the two narrow web-video passes. Both three-app outcomes remain failing; another-app tree and missing window are retained as source refusals whose cause needs native-owner review, not established colour/recording defects. Firefox is the sole current gate, with launch-services explicitly recorded as host configuration.

Release binary readback {"path": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media", "sha256": "effa8cc72e5936e1a49162d4b4437f733caa3227e835bd2be19b611f0451a543", "bytes": 1398208, "method": "read after the offline locked Cargo build; media.started records each run build separately"}. Record .retest/evidence-targets/release-binary.json. This read does not claim that mutable shared source files were frozen; each gate remains tied to its actual events/build facts.

## Firefox normal flow

Real Firefox 133.0.3 / build 20241209150345, host route launch-services. Web video decode/identity subtest passed; phone and desk videos remain unavailable. Normal application flow is failed/not_actionable: Could not fill getByTestId('account-field') within 30000 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree... Full flow is failing, not verified. Final artifact .retest/evidence-targets/flow-firefox/firefox-recorded; observation decode.json beside forwarded source bytes. Broken-sync runs under the same sole gate.
{"app": "phone", "mode": null, "source": null, "status": "unavailable", "frames": null, "media": null, "video": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for iOS simulator apps yet, so this session was not recorded.", "app": "phone", "sessionId": "qymp6yxknn:phone"}]}
{"app": "web", "mode": "screenshot-loop", "source": "firefox", "status": "partial", "frames": {"delivered": 494, "sent": 494, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "media": {"received": 494, "shown": 488, "superseded": 6, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 519, "durationUs": 51900000, "placedBy": "link"}, "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "qymp6yxknn:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "qymp6yxknn:web"}]}
{"app": "desk", "mode": null, "source": null, "status": "unavailable", "frames": null, "media": null, "video": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for macOS apps yet, so this session was not recorded.", "app": "desk", "sessionId": "qymp6yxknn:desk"}]}
Gate completed `flow-firefox`. Exit 1. ℹ tests 10; ℹ pass 2; ℹ fail 8; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/flow-firefox.log`. Results require inspection before another gate.

## flow-firefox target inspection

Decode `.retest/evidence-targets/flow-firefox/firefox-broken-sync-observations/8w1l37chgq-2-1/decode.json`: 528 frames; forwarded cadence 9.51412701636825/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0}, {"frameId": "252", "videoFrame": 273, "meanAbsolutePixelError": 0.1240234375}, {"frameId": "502", "videoFrame": 527, "meanAbsolutePixelError": 0.0966796875}].
Decode `.retest/evidence-targets/flow-firefox/firefox-observations/qymp6yxknn-2-1/decode.json`: 519 frames; forwarded cadence 9.522636785289167/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0}, {"frameId": "246", "videoFrame": 266, "meanAbsolutePixelError": 0.130859375}, {"frameId": "494", "videoFrame": 518, "meanAbsolutePixelError": 0.1044921875}].

Firefox flow gate finished failing, exit 1, 2/10 passed and 8 failed, no skip/cancellation. The two web video leaf checks passed; normal and broken-sync native videos unavailable/no_frame_source. Actual application outcomes:
.retest/evidence-targets/flow-firefox/firefox-broken-sync-recorded/result.json {"exitCode": 1, "tests": [{"status": "failed", "failure": {"class": "not_actionable", "message": "Could not fill getByTestId('account-field') within 30000 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree..", "location": {"file": "reference-flow.retest.ts", "line": 53, "column": 43}, "details": {"check": "tree", "waitedMs": 30000, "inputSent": "not_sent"}}}]}
.retest/evidence-targets/flow-firefox/firefox-recorded/result.json {"exitCode": 1, "tests": [{"status": "failed", "failure": {"class": "not_actionable", "message": "Could not fill getByTestId('account-field') within 30000 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree..", "location": {"file": "reference-flow.retest.ts", "line": 53, "column": 43}, "details": {"check": "tree", "waitedMs": 30000, "inputSent": "not_sent"}}}]}
Launch Services is the required host route, not a defect. Both intended final desk checks/stale-state pixels remain unverified. WebKit follows as the sole next gate.

Gate submitted `flow-webkit`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`. Log `.retest/evidence-targets/logs/flow-webkit.log`.
Gate `flow-webkit` lock busy, exit 75; no test started.
Gate `flow-webkit` lock busy, exit 75; no test started.

Added evidence-timelines.test.ts for independent retained-flow readback. It writes per-app run/test/attempt/session identity and action/check video positions, refuses omitted shortening maps, and fails when an app was not reached, a check is outside the recording or its pixels were withheld. No time is clamped or invented. It needs explicitly named real run folders; without those it is labelled unverified, never a target claim. Its own gate follows after real flow targets finish; WebKit remains the sole active gate.
Gate `flow-webkit` lock busy, exit 75; no test started.

Video helper now also checks clock zero against the real ending, each source capture timestamp against the frame map and exact shortening entries. These are added assertions, not replacements. Timeline readback requires all three app recording records, so empty failed setup cannot pass it. Earlier real gates loaded the previous helper; retained web videos will be checked against these additional assertions under the lock.
Gate `flow-webkit` lock busy, exit 75; no test started.
Gate `flow-webkit` lock busy, exit 75; no test started.

Prepared independent retained-video readback for the strengthened clock-zero, shortening-map and actual capture-timestamp assertions. It requires explicitly selected playable runs and cannot substitute for missing native movies. Extended the final native audit to explicitly named recorded run folders; it reads owned simulator identities and sends no signals. WebKit is still the sole pending heavy gate; neither readback has run yet.

WebKit acquired the shared lock; the normal real flow completed before the broken-sync variant started. The web recording leaf passed the strengthened clock, timestamp, identity, whole-decode and source-sample assertions. Native phone/desk videos remain unavailable. Actual normal outcome and gaps: {"exitCode": 1, "tests": [{"status": "failed", "failure": {"class": "not_actionable", "message": "Could not fill getByTestId('account-field') within 30000 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree..", "location": {"file": "reference-flow.retest.ts", "line": 53, "column": 43}, "details": {"check": "tree", "waitedMs": 30000, "inputSent": "not_sent"}}, "recordings": [{"recordingId": "dzdxv2ngfe-1-1", "sequence": 1, "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "dzdxv2ngfe", "app": "phone", "sessionId": "dzdxv2ngfe:phone", "status": "unavailable", "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for iOS simulator apps yet, so this session was not recorded.", "app": "phone", "sessionId": "dzdxv2ngfe:phone"}]}, {"recordingId": "dzdxv2ngfe-2-1", "sequence": 1, "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "dzdxv2ngfe", "app": "web", "sessionId": "dzdxv2ngfe:web", "source": "webkit", "mode": "screencast", "frames": {"delivered": 7, "sent": 7, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "withheld": {"stretches": 1, "durationUs": 1027450}, "stoppedBy": "attempt_ended", "path": "artifacts/dzdxv2ngfe/web-1fszmh3anyupd/recording-1.mp4", "status": "partial", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "dzdxv2ngfe:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "dzdxv2ngfe:web"}], "media": {"received": 7, "shown": 6, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 2, "clock": {"capture": "run_us", "videoZeroUs": 54984948, "durationUs": 60400000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 55, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 604, "durationUs": 60400000, "placedBy": "link"}}, {"recordingId": "dzdxv2ngfe-3-1", "sequence": 1, "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "dzdxv2ngfe", "app": "desk", "sessionId": "dzdxv2ngfe:desk", "status": "unavailable", "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for macOS apps yet, so this session was not recorded.", "app": "desk", "sessionId": "dzdxv2ngfe:desk"}]}]}]}

Failure-test preparation now also compares the killed-run HTML structured outcome to the explicit JSONL reconstruction and writes reconstructed human output with matching counts and interrupted gap messages. Actual CLI termination is retained as SIGKILL with no result.json; reconstructed output is labelled separately and never presented as a completed CLI run. All pre-existing failure assertions remain. WebKit flow is the only live gate.

Finding location readback on the shared tree: missing native recording is selected at src/runner/run-media.ts:420-422 by frameSourceOf at :563-569; NativePageAdapter remains at src/runner/native-pool.ts:316 without delegation. Earlier :534 points to ending reconciliation rather than the frame-source check and is superseded by this location. Native source refusals are src/native/source-scope.ts:45 for another app and :50 for no window. RGB conversion is media/src/frame.rs:97-109. No owner file was edited.
Gate completed `flow-webkit`. Exit 1. ℹ tests 10; ℹ pass 2; ℹ fail 8; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/flow-webkit.log`. Results require inspection before another gate.

## flow-webkit target inspection

Decode `.retest/evidence-targets/flow-webkit/webkit-broken-sync-observations/z35tenx8kr-2-1/decode.json`: 662 frames; forwarded cadence 0.49184616656557945/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 1.0416666666666667}, {"frameId": "17", "videoFrame": 436, "meanAbsolutePixelError": 0.4544270833333333}, {"frameId": "33", "videoFrame": 651, "meanAbsolutePixelError": 0.2490234375}].
Decode `.retest/evidence-targets/flow-webkit/webkit-observations/dzdxv2ngfe-2-1/decode.json`: 604 frames; forwarded cadence 0.160175804691875/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 1.0416666666666667}, {"frameId": "5", "videoFrame": 314, "meanAbsolutePixelError": 0.294921875}, {"frameId": "7", "videoFrame": 375, "meanAbsolutePixelError": 0.294921875}].

WebKit flows completed exit 1, 2/10 passed, 8 failed, no skips/cancellation. Both web video checks passed; native videos and intended final desktop checks are unverified. Retained outcomes:
.retest/evidence-targets/flow-webkit/webkit-recorded/result.json {"exitCode": 1, "tests": [{"status": "failed", "failure": {"class": "not_actionable", "message": "Could not fill getByTestId('account-field') within 30000 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree..", "location": {"file": "reference-flow.retest.ts", "line": 53, "column": 43}, "details": {"check": "tree", "waitedMs": 30000, "inputSent": "not_sent"}}, "recordings": [{"app": "phone", "status": "unavailable", "mode": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for iOS simulator apps yet, so this session was not recorded.", "app": "phone", "sessionId": "dzdxv2ngfe:phone"}]}, {"app": "web", "status": "partial", "mode": "screencast", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "dzdxv2ngfe:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "dzdxv2ngfe:web"}]}, {"app": "desk", "status": "unavailable", "mode": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for macOS apps yet, so this session was not recorded.", "app": "desk", "sessionId": "dzdxv2ngfe:desk"}]}]}]}
.retest/evidence-targets/flow-webkit/webkit-broken-sync-recorded/result.json {"exitCode": 1, "tests": [{"status": "failed", "failure": {"class": "check_failed", "message": "a look at getByTestId('task-state-task-896d920f34f5') has text \"Open\", expected \"Done\". Compared whole text, ends trimmed, each run of spaces or line breaks read as one space. Element: the StaticText \"task-state-task-896d920f34f5\".", "location": {"file": "reference-flow.retest.ts", "line": 68, "column": 54}, "details": {"also": "not_actionable: Reading the app's tree: The app has no window in its tree."}}, "recordings": [{"app": "phone", "status": "unavailable", "mode": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for iOS simulator apps yet, so this session was not recorded.", "app": "phone", "sessionId": "z35tenx8kr:phone"}]}, {"app": "web", "status": "partial", "mode": "screencast", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "z35tenx8kr:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "z35tenx8kr:web"}]}, {"app": "desk", "status": "unavailable", "mode": null, "gaps": [{"code": "no_frame_source", "message": "Retest has no frame source for macOS apps yet, so this session was not recorded.", "app": "desk", "sessionId": "z35tenx8kr:desk"}]}]}]}

Correction after outcome inspection: WebKit broken-sync DID reach reference-flow.retest.ts:68 and retained check_failed, Open expected Done, with a secondary no-window observation. Its original application scenario assertions passed, but its parent test fails because the native evidence subtests fail. The stale desktop TEXT was observed; stale desktop PIXELS remain unverified because no desk recording exists. Chrome and Firefox did not reach this final check. The preceding general statement about all final checks being unverified applies to recorded pixels, not this observed WebKit assertion.

Gate submitted `chrome-release`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/chrome-release node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/chrome-release.log`.
Gate completed `chrome-release`. Exit 0. ℹ tests 2; ℹ pass 2; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/chrome-release.log`. Results require inspection before another gate.

## chrome-release target inspection

Run `.retest/evidence-targets/chrome-release/chromium-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser Chrome 154.0.8037.98, build @b859317bf11f6be47f9b7799ec690a0a42a1fb33, engine chromium.
Attempt `ilupjgkkr1`, web: mode screencast, source chromium, evidence complete, frames {"delivered": 4, "sent": 4, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 4, "shown": 2, "superseded": 2, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 8, "durationUs": 800000, "placedBy": "link"}.
Attempt `qaejj033v4`, web: mode screencast, source chromium, evidence complete, frames {"delivered": 4, "sent": 4, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 4, "shown": 2, "superseded": 2, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 27, "durationUs": 2700000, "placedBy": "link"}.
Attempt `pmpo0m4wmp`, web: mode screencast, source chromium, evidence partial, frames {"delivered": 3, "sent": 3, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 3, "shown": 2, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 14, "durationUs": 1400000, "placedBy": "link"}.
Missing capture_gaps: The capture reported 1 stretch in which it could hand over no frame.
Missing pixels_withheld: The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/chrome-release/chromium-observations/ilupjgkkr1-1-1/decode.json`: 8 frames; forwarded cadence 7.264450202193864/s; sampled source comparison [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.20963541666666666}, {"frameId": "4", "videoFrame": 4, "meanAbsolutePixelError": 0.6754557291666666}].
Decode `.retest/evidence-targets/chrome-release/chromium-observations/pmpo0m4wmp-1-1/decode.json`: 14 frames; forwarded cadence 2.0847014186393156/s; sampled source comparison [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.15983072916666666}, {"frameId": "3", "videoFrame": 10, "meanAbsolutePixelError": 0.6546223958333334}].
Decode `.retest/evidence-targets/chrome-release/chromium-observations/qaejj033v4-1-1/decode.json`: 27 frames; forwarded cadence 7.5626756746536925/s; sampled source comparison [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.20963541666666666}, {"frameId": "4", "videoFrame": 4, "meanAbsolutePixelError": 0.6350911458333334}].
Off run `.retest/evidence-targets/chrome-release/chromium-off`, verdicts compared in integration; no media or recording event.

Fresh release-backed Chrome gate passed 2/2, exit 0, no skip/cancellation. All three recorded movies decoded with exact clock/source timestamps, frame identities and sample matches; normal/failure screenshots and HTML refs passed. Secret movie has 14 decoded frames, 10 blue and 4 green, no red; no withheld-interval frame or secret bytes. The recording-off run matched all three application verdicts and had no media process/events. Artifacts chrome-release/{chromium-on,chromium-off,chromium-observations}. CLI recording status facts [{"recordingId": "ilupjgkkr1-1-1", "sequence": 1, "testId": "evidence.retest.ts > Safe before", "attemptId": "ilupjgkkr1", "app": "web", "sessionId": "ilupjgkkr1:web", "source": "chromium", "mode": "screencast", "frames": {"delivered": 4, "sent": 4, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "attempt_ended", "path": "artifacts/ilupjgkkr1/web-1fszmh3anyupd/recording-1.mp4", "status": "complete", "gaps": [], "media": {"received": 4, "shown": 2, "superseded": 2, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 0, "clock": {"capture": "run_us", "videoZeroUs": 1697911, "durationUs": 800000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 38, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 8, "durationUs": 800000, "placedBy": "link"}}, {"recordingId": "qaejj033v4-1-1", "sequence": 1, "testId": "evidence.retest.ts > Wrong title", "attemptId": "qaejj033v4", "app": "web", "sessionId": "qaejj033v4:web", "source": "chromium", "mode": "screencast", "frames": {"delivered": 4, "sent": 4, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "attempt_ended", "path": "artifacts/qaejj033v4/web-1fszmh3anyupd/recording-1.mp4", "status": "complete", "gaps": [], "media": {"received": 4, "shown": 2, "superseded": 2, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 0, "clock": {"capture": "run_us", "videoZeroUs": 2917209, "durationUs": 2700000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 67, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 27, "durationUs": 2700000, "placedBy": "link"}}, {"recordingId": "pmpo0m4wmp-1-1", "sequence": 1, "testId": "evidence.retest.ts > secret fill", "attemptId": "pmpo0m4wmp", "app": "web", "sessionId": "pmpo0m4wmp:web", "source": "chromium", "mode": "screencast", "frames": {"delivered": 3, "sent": 3, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "withheld": {"stretches": 1, "durationUs": 532909}, "stoppedBy": "attempt_ended", "path": "artifacts/pmpo0m4wmp/web-1fszmh3anyupd/recording-1.mp4", "status": "partial", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "pmpo0m4wmp:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "pmpo0m4wmp:web"}], "media": {"received": 3, "shown": 2, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 2, "clock": {"capture": "run_us", "videoZeroUs": 6151644, "durationUs": 1400000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 66, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 14, "durationUs": 1400000, "placedBy": "link"}}]

Gate submitted `firefox-release`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/firefox-release node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/firefox-release.log`.
Gate `firefox-release` lock busy, exit 75; no test started.

Chrome release result is the current browser evidence claim; the earlier debug gate remains historical. Firefox release is waiting for the shared lock, with no target command started on its busy attempt. No second heavy command has been submitted.
Gate `firefox-release` lock busy, exit 75; no test started.
Gate `firefox-release` lock busy, exit 75; no test started.

Proof record updated with current release-backed Chrome verification and all three completed flow gates. Firefox release remains the sole submitted gate; its busy retries start no test and no other heavy gate is queued.

Queue test now includes the same real application source with recording off, invalid media/encoder paths and exact verdict/failure-class/CLI-exit comparison. This adds an assertion of unchanged application outcome; the required drop count, partial gap, identity and whole-decode assertions are unchanged. It has not run. Firefox release is still the only submitted heavy command.
Gate completed `firefox-release`. Exit 0. ℹ tests 2; ℹ pass 2; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/firefox-release.log`. Results require inspection before another gate.

## firefox-release target inspection

Run `.retest/evidence-targets/firefox-release/firefox-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser Firefox 133.0.3, build 20241209150345, engine firefox.
Attempt `tih014whmg`, web: mode screenshot-loop, source firefox, evidence complete, frames {"delivered": 9, "sent": 9, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 9, "shown": 9, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 9, "durationUs": 900000, "placedBy": "link"}.
Attempt `yyisg02f1n`, web: mode screenshot-loop, source firefox, evidence complete, frames {"delivered": 28, "sent": 28, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 28, "shown": 28, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 29, "durationUs": 2900000, "placedBy": "link"}.
Attempt `7w0a8yqe42`, web: mode screenshot-loop, source firefox, evidence partial, frames {"delivered": 11, "sent": 11, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 11, "shown": 11, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 17, "durationUs": 1700000, "placedBy": "link"}.
Missing capture_gaps: The capture reported 1 stretch in which it could hand over no frame.
Missing pixels_withheld: The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/firefox-release/firefox-observations/7w0a8yqe42-1-1/decode.json`: 17 frames; forwarded cadence 6.273203009631876/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "6", "videoFrame": 11, "meanAbsolutePixelError": 0.0003255208333333333}, {"frameId": "11", "videoFrame": 16, "meanAbsolutePixelError": 0.0003255208333333333}].
Decode `.retest/evidence-targets/firefox-release/firefox-observations/tih014whmg-1-1/decode.json`: 9 frames; forwarded cadence 9.84157524253332/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "5", "videoFrame": 4, "meanAbsolutePixelError": 0.09342447916666667}, {"frameId": "9", "videoFrame": 8, "meanAbsolutePixelError": 0.0322265625}].
Decode `.retest/evidence-targets/firefox-release/firefox-observations/yyisg02f1n-1-1/decode.json`: 29 frames; forwarded cadence 9.797773945759523/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "15", "videoFrame": 14, "meanAbsolutePixelError": 0.0022786458333333335}, {"frameId": "28", "videoFrame": 28, "meanAbsolutePixelError": 0.0022786458333333335}].
Off run `.retest/evidence-targets/firefox-release/firefox-off`, verdicts compared in integration; no media or recording event.

Fresh release-backed Firefox gate passed 2/2, exit 0, no skip/cancellation. Launch Services is the required host route. Three movie whole-decodes/clock/source timestamps/identity/source samples and normal/failure screenshot references passed. Secret video decoded 17 frames: 10 blue, 6 green and one frame outside the blue/green witness predicates; zero red secret scene, no withheld-interval forwarded frame or secret bytes. Off matched all three verdicts/CLI exit and started no media. Artifacts firefox-release/{firefox-on,firefox-off,firefox-observations}. Recording statuses and gaps [{"recordingId": "tih014whmg-1-1", "sequence": 1, "testId": "evidence.retest.ts > Safe before", "attemptId": "tih014whmg", "app": "web", "sessionId": "tih014whmg:web", "source": "firefox", "mode": "screenshot-loop", "frames": {"delivered": 9, "sent": 9, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "attempt_ended", "path": "artifacts/tih014whmg/web-1fszmh3anyupd/recording-1.mp4", "status": "complete", "gaps": [], "media": {"received": 9, "shown": 9, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 0, "clock": {"capture": "run_us", "videoZeroUs": 2020696, "durationUs": 900000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 44, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 9, "durationUs": 900000, "placedBy": "link"}}, {"recordingId": "yyisg02f1n-1-1", "sequence": 1, "testId": "evidence.retest.ts > Wrong title", "attemptId": "yyisg02f1n", "app": "web", "sessionId": "yyisg02f1n:web", "source": "firefox", "mode": "screenshot-loop", "frames": {"delivered": 28, "sent": 28, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "attempt_ended", "path": "artifacts/yyisg02f1n/web-1fszmh3anyupd/recording-1.mp4", "status": "complete", "gaps": [], "media": {"received": 28, "shown": 28, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 0, "clock": {"capture": "run_us", "videoZeroUs": 3347690, "durationUs": 2900000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 77, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 29, "durationUs": 2900000, "placedBy": "link"}}, {"recordingId": "7w0a8yqe42-1-1", "sequence": 1, "testId": "evidence.retest.ts > secret fill", "attemptId": "7w0a8yqe42", "app": "web", "sessionId": "7w0a8yqe42:web", "source": "firefox", "mode": "screenshot-loop", "frames": {"delivered": 11, "sent": 11, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "withheld": {"stretches": 1, "durationUs": 624291}, "stoppedBy": "attempt_ended", "path": "artifacts/7w0a8yqe42/web-1fszmh3anyupd/recording-1.mp4", "status": "partial", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "7w0a8yqe42:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "7w0a8yqe42:web"}], "media": {"received": 11, "shown": 11, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "captureGaps": 2, "clock": {"capture": "run_us", "videoZeroUs": 6655306, "durationUs": 1700000, "shortened": [], "shortenedCount": 0}, "finalizeMs": 71, "video": {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 17, "durationUs": 1700000, "placedBy": "link"}}]

Gate submitted `webkit-release`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/webkit-release node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-browsers.test.ts`. Log `.retest/evidence-targets/logs/webkit-release.log`.
Gate completed `webkit-release`. Exit 1. ℹ tests 2; ℹ pass 0; ℹ fail 2; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/webkit-release.log`. Results require inspection before another gate.

## webkit-release target inspection

Run `.retest/evidence-targets/webkit-release/webkit-on`. Exit 1. Verdicts [["Safe before", "passed", null], ["Wrong title", "failed", "check_failed"], ["secret fill", "passed", null]]. Media starts 1.
Real browser WebKit 626.1.6+, build 2359, build 2359, engine webkit.
Attempt `1mmf30v2hy`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 3, "sent": 3, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 3, "shown": 2, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 7, "durationUs": 700000, "placedBy": "link"}.
Attempt `t1ar5ps17y`, web: mode screencast, source webkit, evidence complete, frames {"delivered": 2, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 2, "shown": 2, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 27, "durationUs": 2700000, "placedBy": "link"}.
Attempt `s24qmhgrwj`, web: mode screencast, source webkit, evidence partial, frames {"delivered": 2, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, media {"received": 2, "shown": 2, "superseded": 0, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, video {"codec": "h264", "container": "mp4", "width": 320, "height": 240, "fps": 10, "outputFrames": 14, "durationUs": 1400000, "placedBy": "link"}.
Missing capture_gaps: The capture reported 1 stretch in which it could hand over no frame.
Missing pixels_withheld: The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.
Decode `.retest/evidence-targets/webkit-release/webkit-observations/1mmf30v2hy-1-1/decode.json`: 7 frames; forwarded cadence 4.944681377093763/s; sampled source comparison [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.1396484375}, {"frameId": "3", "videoFrame": 4, "meanAbsolutePixelError": 0.814453125}].
Decode `.retest/evidence-targets/webkit-release/webkit-observations/s24qmhgrwj-1-1/decode.json`: 14 frames; forwarded cadence 1.0410225339737704/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.12858072916666666}, {"frameId": "2", "videoFrame": 10, "meanAbsolutePixelError": 0.8759765625}].
Decode `.retest/evidence-targets/webkit-release/webkit-observations/t1ar5ps17y-1-1/decode.json`: 27 frames; forwarded cadence 2.7481511812927852/s; sampled source comparison [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.1396484375}, {"frameId": "2", "videoFrame": 4, "meanAbsolutePixelError": 0.79296875}].
Off run `.retest/evidence-targets/webkit-release/webkit-off`, verdicts compared in integration; no media or recording event.

Fresh release-backed WebKit gate failed 0/2, exit 1, no skip/cancellation. All three videos decoded, clock/maps/source identity samples and screenshots/HTML references passed. Secret safe-green predicate still fails unchanged: 14 decoded frames, 10 blue and zero green. No forwarded frame in withheld interval and no secret bytes were found; full secret-pixel and colour-fidelity proof is not claimed from this failing gate. Off still matched all three application verdicts and CLI exit with no media. Artifacts webkit-release/{webkit-on,webkit-off,webkit-observations}; failed witness secrecy.json is retained beside approved frames. Owning media finding remains media/src/frame.rs:97-109, RGB conversion/profile treatment requiring review; not a proven causal diagnosis.

Gate submitted `failures`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/failures node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-failures.test.ts`. Log `.retest/evidence-targets/logs/failures.log`.

The sole failures gate has completed its media-process-crash and encoder-kill scenarios. Both subtests passed, including exact off outcome/exit comparison, named missing evidence, HTML/terminal/JSONL agreement and owned descendant disappearance. Retained facts [{"folder": ".retest/evidence-targets/failures/media", "exitCode": 0, "tests": [{"status": "passed", "failure": null, "recordings": [{"recordingId": "5g9jbngt82-1-1", "sequence": 1, "testId": "tests/record.retest.ts > waits", "attemptId": "5g9jbngt82", "app": "web", "sessionId": "5g9jbngt82:web", "source": "chromium", "mode": "screencast", "frames": {"delivered": 2, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "recording", "partialPath": "artifacts/5g9jbngt82/web-1fszmh3anyupd/recording-1.mp4.partial", "status": "unavailable", "gaps": [{"code": "media_process_lost", "message": "The media process ended while this recording ran: the media process ended with signal SIGKILL; recording 5g9jbngt82-1-1 did not end: its recorded encoder processes exited on their own, and it left /private/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-tests-Ua3f2P/retest-cli-7Jtgti/run/artifacts/5g9jbngt82/web-1fszmh3anyupd/recording-1.mp4.partial A partial file is kept at artifacts/5g9jbngt82/web-1fszmh3anyupd/recording-1.mp4.partial; whether it plays was not checked.", "app": "web", "sessionId": "5g9jbngt82:web"}]}]}]}, {"folder": ".retest/evidence-targets/failures/media-off", "exitCode": 0, "tests": [{"status": "passed", "failure": null, "recordings": null}]}, {"folder": ".retest/evidence-targets/failures/encoder", "exitCode": 0, "tests": [{"status": "passed", "failure": null, "recordings": [{"recordingId": "3e1sinhfu7-1-1", "sequence": 1, "testId": "tests/record.retest.ts > waits", "attemptId": "3e1sinhfu7", "app": "web", "sessionId": "3e1sinhfu7:web", "source": "chromium", "mode": "screencast", "frames": {"delivered": 2, "sent": 2, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "stoppedBy": "recording", "status": "unavailable", "gaps": [{"code": "encoder_failed", "message": "the encoder ended with signal 9 during the recording", "app": "web", "sessionId": "3e1sinhfu7:web"}, {"code": "frames_unprocessed", "message": "1 frame reached the media process after the video was finished.", "app": "web", "sessionId": "3e1sinhfu7:web"}], "media": {"received": 2, "shown": 0, "superseded": 1, "dropped": 0, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 1}, "captureGaps": 0, "clock": {"capture": "run_us", "videoZeroUs": 1413964, "durationUs": 0, "shortened": [], "shortenedCount": 0}}]}]}, {"folder": ".retest/evidence-targets/failures/encoder-off", "exitCode": 0, "tests": [{"status": "passed", "failure": null, "recordings": null}]}]
Gate completed `failures`. Exit 1. ℹ tests 8; ℹ pass 5; ℹ fail 3; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/failures.log`. Results require inspection before another gate.

Failure gate completed exit 1, 5/8 passed, 3 failed, no skips/cancellations. Required-media loss passed: observed test pass remains, while required evidence gives run error/evidence_incomplete and CLI exit 2. SIGINT/timeout preserve off verdict/exit. Artifact root .retest/evidence-targets/failures.

Browser-loss report failure was a new harness escaping error, not a missing HTML reason: the exact gap includes "page's", and HTML correctly renders page&#39;s. The comparison now encodes quotes/apostrophe/backtick as well as &, < and >, still requiring the full exact gap. No required message or threshold was removed.

Product finding for report owner: src/reporters/human.ts:146-173 onRunEnd and :235-265 summaryLines/describeEvidence, scenario killed runner or killed-run leftovers rebuilt from JSONL. HTML names run_stopped, but human reconstruction prints only "Evidence unavailable · 1 unavailable" and omits the actual recording-gap message. The exact gap assertion remains failing. Retained files failures/{runner-exit,leftovers}/{report.html,reconstructed-terminal-report.txt,events.jsonl,cli-output.json}. This lane does not edit the reporter.

Report checks are now independent subtests so a missing report message cannot stop the unchanged outcome/decode/cleanup assertions from executing. Raw copying still precedes assertions. Every existing assertion remains, and a failed report subtest still fails its parent. A fresh gate follows to verify the repaired escaping comparison and exercise the independent remaining checks. Original killed-run cleanup assertions were not reached after the first report failure, so they are not yet claimed.

Gate submitted `failures-independent`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/failures-independent node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-failures.test.ts`. Log `.retest/evidence-targets/logs/failures-independent.log`.

Human finding location correction after numbered read: onRunEnd is src/reporters/human.ts:138-150, with summary at :235-265. Proof table now names current Chrome/Firefox release passes and WebKit release failure. failures-independent is the only submitted heavy gate.
Gate completed `failures-independent`. Exit 1. ℹ tests 21; ℹ pass 17; ℹ fail 4; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/failures-independent.log`. Results require inspection before another gate.

Failure independent gate completed exit 1, 17/21 passed, 4 failed, no skip/cancellation. Two failed report children and their two parents reflect the missing human run_stopped message; browser capture-loss HTML and its unchanged outcome/decode/cleanup assertions now passed. All five ending scenarios have exact on/off verdict and exit matches and zero media events off. Killed-runner original disappearance assertions ran and passed; its parent fails only the reporting child. Leftover removal assertions ran and passed, removing owned partials while preserving the unrelated sentinel; its parent likewise fails only the reporting child. Required evidence still retains observed pass and separate run error/exit 2. Retained artifacts failures-independent/{media,encoder,SIGINT,timeout,browser,runner-exit,required-evidence,leftovers}, with five -off baselines.

Gate submitted `diagnostics`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/diagnostics node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-diagnostics.test.ts`. Log `.retest/evidence-targets/logs/diagnostics.log`.
Gate completed `diagnostics`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/diagnostics.log`. Results require inspection before another gate.

Diagnostics flood passed 1/1, exit 0, no skips/cancellations, real Chrome with release media. {"console": {"state": "partial", "reason": "1991 messages over the attempt's limits were dropped", "entries": 10, "errors": 0, "warnings": 0, "runtimeErrors": 0, "handledLater": 0, "dropped": 1991, "truncated": 0, "bytes": 13101}, "judgeRequests": 2, "decodedFrames": 17, "cadence": 2.44047230460511, "recordingStatus": "partial", "gaps": [{"code": "capture_gaps", "message": "The capture reported 1 stretch in which it could hand over no frame.", "app": "web", "sessionId": "ojtk0lkfz1:web"}, {"code": "pixels_withheld", "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.", "app": "web", "sessionId": "ojtk0lkfz1:web"}], "samples": [{"frameId": "2", "videoFrame": 0, "meanAbsolutePixelError": 0.15787760416666666}, {"frameId": "4", "videoFrame": 12, "meanAbsolutePixelError": 0.6533203125}, {"frameId": "5", "videoFrame": 16, "meanAbsolutePixelError": 0.6533203125}]}
Two approved screenshots matched judge byte lengths and SHA256 references, independently decoded and used by HTML. All 2000 secret-bearing console messages were bounded/sanitized; no run/observer/judge-call file held the secret. Every decoded video frame rejected the exposed red secret scene and no forwarded frame lay in the withheld interval. Artifacts diagnostics/flood, flood-summary.json, judge-calls.jsonl and observations/*/decode.json. Fake evaluator verifies local evidence references, not remote model quality.

Gate submitted `queue`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/queue node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-queue.test.ts`. Log `.retest/evidence-targets/logs/queue.log`.
Gate `queue` lock busy, exit 75; no test started.
Gate completed `queue`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/queue.log`. Results require inspection before another gate.

Retained-video readback writes its strengthened decode findings into a separate readback folder through an explicit helper report path. Original decode.json files are preserved. All decoder assertions are unchanged. Queue gate is still the sole submitted command; it has not loaded the helper on its busy lock attempts.

Queue first gate failed 0/1, exit 1, before the target started. The new queue observation loader lacked the closing brace of registerHooks' outer object. Corrected only the generated JavaScript braces and laid them out explicitly. No outcome, drop count, gap or decode assertion changed; no product finding is claimed. First attempt log queue.log and generated observations/observe.mjs retained. Fresh queue-2 artifact root is separate.

Gate submitted `queue-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/queue-2 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-queue.test.ts`. Log `.retest/evidence-targets/logs/queue-2.log`.
Gate completed `queue-2`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/queue-2.log`. Results require inspection before another gate.

Queue gate 2 passed 1/1, exit 0, no skip/cancellation. Exactly the recorded encoder was stopped/resumed with fresh identity checks. {"verdict": "passed", "recordingStatus": "partial", "frames": {"delivered": 61, "sent": 61, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "media": {"received": 61, "shown": 36, "superseded": 3, "dropped": 22, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "gaps": [{"code": "frames_dropped", "message": "The media process dropped 22 frames from a full queue.", "app": "web", "sessionId": "ij07xc0kkm:web"}], "decodedFrames": 61, "captureCadencePerSecond": 9.992964952673319, "samples": [{"frameId": "1", "videoFrame": 0, "meanAbsolutePixelError": 0.875}, {"frameId": "41", "videoFrame": 40, "meanAbsolutePixelError": 0.6813151041666666}, {"frameId": "61", "videoFrame": 60, "meanAbsolutePixelError": 0.6813151041666666}]}
Whole-video decode, clock/identity/frame-map and sampled pixels passed. HTML/human/JSONL names drops and retains pass; recording off has the same verdict and exit with no media process/events. Owned descendants were gone. Artifacts queue-2/{queue,queue-off,queue-summary.json,stalled-encoder.json,observations/*/decode.json}.

Gate submitted `timelines`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/timelines RETEST_EVIDENCE_TIMELINES=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-chrome-release/chromium-recorded,/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-chrome-release/chromium-broken-sync-recorded,/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-firefox/firefox-recorded,/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-firefox/firefox-broken-sync-recorded,/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-webkit/webkit-recorded,/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/flow-webkit/webkit-broken-sync-recorded node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-timelines.test.ts`. Log `.retest/evidence-targets/logs/timelines.log`.
Gate completed `timelines`. Exit 1. ℹ tests 25; ℹ pass 6; ℹ fail 19; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/timelines.log`. Results require inspection before another gate.

Timeline readback failed with 6/25 passed and 19 failed, exit 1, no skips/cancellations. The six three-app-record existence checks passed; 12 native app clocks are unavailable and all six web timeline leaves failed. Five web flows have assertions inside their named pixel-withheld interval; Chrome broken-sync never reached a web action/assertion and its blank movie cannot prove flow state. This is incomplete recorded-state evidence, not a reason to relax privacy. No time is clamped or withholding removed. Six retained per-web-app timeline JSON files include exact event sequences/times and missing reasons. Facts [{"path": ".retest/evidence-targets/timelines/bdec0511-fef2-42a3-b146-36b406b3ca35-web-timeline.json", "identity": {"runId": "bdec0511-fef2-42a3-b146-36b406b3ca35", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "9zaw5kebzw", "app": "web", "sessionId": "9zaw5kebzw:web"}, "missing": ["An app check falls in withheld pixels; a prior frame cannot prove the state it checked."], "events": 13, "withheldAssertions": 3}, {"path": ".retest/evidence-targets/timelines/5abd4acf-06ba-4cfe-8628-6dc638a8320e-web-timeline.json", "identity": {"runId": "5abd4acf-06ba-4cfe-8628-6dc638a8320e", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "dzdxv2ngfe", "app": "web", "sessionId": "dzdxv2ngfe:web"}, "missing": ["An app check falls in withheld pixels; a prior frame cannot prove the state it checked."], "events": 13, "withheldAssertions": 3}, {"path": ".retest/evidence-targets/timelines/63c334b3-886d-4148-a7dc-4e1e14c801e1-web-timeline.json", "identity": {"runId": "63c334b3-886d-4148-a7dc-4e1e14c801e1", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "8w1l37chgq", "app": "web", "sessionId": "8w1l37chgq:web"}, "missing": ["An app check falls in withheld pixels; a prior frame cannot prove the state it checked."], "events": 13, "withheldAssertions": 3}, {"path": ".retest/evidence-targets/timelines/11cd8d57-638a-4131-b9e9-8633d9c575c8-web-timeline.json", "identity": {"runId": "11cd8d57-638a-4131-b9e9-8633d9c575c8", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "z35tenx8kr", "app": "web", "sessionId": "z35tenx8kr:web"}, "missing": ["An app check falls in withheld pixels; a prior frame cannot prove the state it checked."], "events": 17, "withheldAssertions": 3}, {"path": ".retest/evidence-targets/timelines/bf252a71-fe34-4b3b-b475-7b948126cf58-web-timeline.json", "identity": {"runId": "bf252a71-fe34-4b3b-b475-7b948126cf58", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "g7ajjgpw74", "app": "web", "sessionId": "g7ajjgpw74:web"}, "missing": ["The flow reached no action or assertion on this app; a blank recording cannot prove its flow state."], "events": 0, "withheldAssertions": 0}, {"path": ".retest/evidence-targets/timelines/923fd382-c326-41cf-9aef-cd287032aeb6-web-timeline.json", "identity": {"runId": "923fd382-c326-41cf-9aef-cd287032aeb6", "testId": "reference-flow.retest.ts > creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id", "attemptId": "qymp6yxknn", "app": "web", "sessionId": "qymp6yxknn:web"}, "missing": ["An app check falls in withheld pixels; a prior frame cannot prove the state it checked."], "events": 13, "withheldAssertions": 3}]

Gate submitted `video-readback`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/video-readback node --conditions=retest-source .retest/evidence-targets/video-readback.ts .retest/evidence-targets/flow-chrome-release/chromium-recorded=.retest/evidence-targets/flow-chrome-release/chromium-observations .retest/evidence-targets/flow-chrome-release/chromium-broken-sync-recorded=.retest/evidence-targets/flow-chrome-release/chromium-broken-sync-observations .retest/evidence-targets/flow-firefox/firefox-recorded=.retest/evidence-targets/flow-firefox/firefox-observations .retest/evidence-targets/flow-firefox/firefox-broken-sync-recorded=.retest/evidence-targets/flow-firefox/firefox-broken-sync-observations .retest/evidence-targets/flow-webkit/webkit-recorded=.retest/evidence-targets/flow-webkit/webkit-observations .retest/evidence-targets/flow-webkit/webkit-broken-sync-recorded=.retest/evidence-targets/flow-webkit/webkit-broken-sync-observations`. Log `.retest/evidence-targets/logs/video-readback.log`.
Gate completed `video-readback`. Exit 0. . Log `.retest/evidence-targets/logs/video-readback.log`. Results require inspection before another gate.

Strengthened video readback passed, exit 0: six retained runs, six actual web videos. Exact clock zero, shortening records and every source capture timestamp matched their real media endings/maps; ffprobe, whole decode and source pixel samples also passed. Separate findings are video-readback/*-decode.json and video-readback/video-readback.json; original decode files preserved. This verifies clocks/identity/encoding, not the state of withheld pixels or absent native movies.

The web timeline gaps are consistent with the documented conservative policy at src/runner/run-session.ts:1474-1484: a secret fill whose masking is unread withholds until another document or session end. Five flow movies have early post-login checks within that interval. This is named incomplete visual evidence, not a privacy-policy defect and not a proposed relaxation. Native desktop post-login capture remains unverified for the same policy boundary as well as the missing adapter frame source.

Gate submitted `unit-native-processes`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py node --conditions=retest-source --test tests/unit/native-processes.test.ts`. Log `.retest/evidence-targets/logs/unit-native-processes.log`.
Gate completed `unit-native-processes`. Exit 0. ℹ tests 48; ℹ pass 48; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/unit-native-processes.log`. Results require inspection before another gate.

Final process-audit preparation now includes exact CLI-owner pid/start identities from retained media.started events, in addition to recorded gate and decoder identities. It reports only start/command comparisons for any reused pid, never foreign command text, sends no signals, and fails if an owned start identity remains. It will run only after all gates have returned. The unit-native-processes gate is the sole current command.

Full native-processes unit gate passed 48/48, exit 0, no skip/cancellation. Exact command and log are above; this includes Step 0 in the full file as well as the other builder's preserved assertions. Focused test and both mutation failures remain separate evidence. No production source changed. Final full npm typecheck follows under the shared lock.

Gate submitted `types-final`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-final.log`.
Gate `types-final` lock busy, exit 75; no test started.
Gate completed `types-final`. Exit 2. . Log `.retest/evidence-targets/logs/types-final.log`. Results require inspection before another gate.

Final full typecheck first attempt failed exit 2 at TypeScript 6, src/media/client.ts:444 TS18030, optional chain with a private identifier. This is another lane's concurrent edit; no change made here. TypeScript 7 and the example command were not reached. Native audit can progress independently; full typecheck will retry after waiting. Scoped diff whitespace check of the existing unit file passed, and evidence files contain no any/ignored-error directives.

Gate submitted `native-audit-final`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py node --conditions=retest-source .retest/evidence-targets/native-audit.ts ios/ios-simulator-on ios/ios-simulator-off macos/macos-rebuilt-from-terminal flow-chrome/chromium-recorded flow-chrome/chromium-broken-sync-recorded flow-chrome-release/chromium-recorded flow-chrome-release/chromium-broken-sync-recorded flow-firefox/firefox-recorded flow-firefox/firefox-broken-sync-recorded flow-webkit/webkit-recorded flow-webkit/webkit-broken-sync-recorded`. Log `.retest/evidence-targets/logs/native-audit-final.log`.
Gate completed `native-audit-final`. Exit 0. . Log `.retest/evidence-targets/logs/native-audit-final.log`. Results require inspection before another gate.

Final release-binary readback {"path": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media", "sha256": "6cd7160729dfc2bc2cc10ed8da10bffda1b4f8efb53d9ee7be87967af7fe27e7", "bytes": 1398208, "matchesPreviousRecordedHash": false}. Record .retest/evidence-targets/release-binary-final.json. This does not freeze shared TypeScript edits.

Final native audit passed exit 0 through the shared lock. All 13 reported owned simulator identities from 11 retained target/flow folders are absent from the current 22-entry simulator list and have no /Devices/<UDID>/ process; TaskDesk process count is zero. No signals sent. Artifact native-audit/final-result.json; log native-audit-final.log. Earlier failed off-start simulator names were already independently confirmed absent. Other simulator entries and Wispr Flow remain untouched.

Release-binary hash changed from the earlier effa8c... readback to 6cd7160729dfc2bc2cc10ed8da10bffda1b4f8efb53d9ee7be87967af7fe27e7. File modification readback is 2026-10-06 13:35:20 +04, before the fresh release target and resilience gates. The media owner's closeout report attributes this final release build to the stdout descriptor close-on-exec fix and records the same final digest. Earlier flow gates crossed this binary transition and are not claimed as one frozen binary build. Each actual media.started build/version/target/profile remains in its JSONL. This lane made no second Cargo/source change.

Gate submitted `types-final-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-final-2.log`.
Gate `types-final-2` lock busy, exit 75; no test started.

Prepared .retest/evidence-targets/target-summary.json with the nine fresh target recording identities, actual whole-decode counts, forwarded cadence, drops/gaps, on/off exits and exact artifact references. Fresh capture intervals use (forwarded count minus one) divided by first-to-last capture time, including withholding. Typecheck retry remains the sole pending gate.
Gate completed `types-final-2`. Exit 2. . Log `.retest/evidence-targets/logs/types-final-2.log`. Results require inspection before another gate.

Final npm typecheck retry failed exit 2 at TypeScript 6, same optional-private-chain error now at src/media/client.ts:449. The shared file continued changing; it is still left to its owner. Full TypeScript validation is not green. Since the npm chain stops there, the TypeScript 7 project and TypeScript 6 example checks will run independently and sequentially through one remaining compiler gate; no compiler error is suppressed or patched. This syntax finding belongs to the media-client owner and blocks the package build.

Gate submitted `types-remaining`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py python3 .retest/evidence-targets/types-remaining.py`. Log `.retest/evidence-targets/logs/types-remaining.log`.

Independent remaining compiler `node node_modules/typescript-7/bin/tsc -p tsconfig.json` exited 1. Log `.retest/evidence-targets/logs/types-7-final.log`. Shared heavy gate remains held while commands run sequentially.

Independent remaining compiler `node node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json` exited 0. Log `.retest/evidence-targets/logs/types-example-final.log`. Shared heavy gate remains held while commands run sequentially.
Gate completed `types-remaining`. Exit 1. . Log `.retest/evidence-targets/logs/types-remaining.log`. Results require inspection before another gate.

Independent remaining compiler gate exited 1: TypeScript 7 project exited 2 and TypeScript 6 example exited 0. TypeScript 7 found two shared media-client errors, src/media/client.ts:489 TS2367 and :1119 TS6133, plus one own queue-test error at :61. The queue test had already asserted result.failure undefined, so TypeScript correctly rejects reading its class afterward. Its on/off comparison now compares the whole failure value instead of only class. The earlier no-failure assertion remains, and this cannot weaken the comparison. Queue will rerun in a fresh folder before closeout. Product source remains untouched; both compiler versions must be repeated after this own correction.

Gate submitted `queue-final`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/queue-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-queue.test.ts`. Log `.retest/evidence-targets/logs/queue-final.log`.
Gate `queue-final` lock busy, exit 75; no test started.
Gate `queue-final` lock busy, exit 75; no test started.
Gate `queue-final` lock busy, exit 75; no test started.
Gate completed `queue-final`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/queue-final.log`. Results require inspection before another gate.

Added evidence-pixel-artifacts.test.ts to cover remaining real image routes explicitly: advisory screenshot/frame requests during an actual unmasked secret fill must be refused and reach no judge; resumed kept-frame sequences must match judge hashes and HTML paths. Three actual approved source images feed real media thumbnails, independently decoded for the secret-scene marker, with process identity and close checks. Thumbnail service is a separate explicit-media test after the CLI, not a claim that the runner creates thumbnail references. No live-view claim. Native routes remain unverified without a runner frame source. Queue-final is still the sole gate; this new test has not run.

Queue-final passed 1/1, exit 0, no skips/cancellations, with whole-failure-value on/off comparison. {"media": {"received": 61, "shown": 37, "superseded": 2, "dropped": 22, "outOfOrder": 0, "outOfRange": 0, "undecodable": 0, "duplicate": 0, "unprocessed": 0}, "frames": {"delivered": 61, "sent": 61, "dropped": 0, "notSent": 0, "withheld": 0, "refused": 0}, "status": "partial", "gaps": [{"code": "frames_dropped", "message": "The media process dropped 22 frames from a full queue.", "app": "web", "sessionId": "4u7t3zkpqy:web"}]} Artifacts queue-final/{queue,queue-off,queue-summary.json,stalled-encoder.json,observations}.
Thumbnail test cleanup is registered immediately after its own process starts, before ownership assertions; each thumbnail reply is retained separately before asserting/decode. No production source edit.

Gate submitted `pixels-chrome`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-chrome node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-chrome.log`.
Gate completed `pixels-chrome`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-chrome.log`. Results require inspection before another gate.

First pixels-chrome gate failed 0/1 before a run folder existed. The new test tried to save CLI diagnostics into that absent folder, so the initial underlying CLI refusal was not retained; no target/media proof is claimed. The test now first saves sanitized CLI output into its existing proof root and requires a result explicitly before copying the real run. No policy/image assertion changed. Fresh diagnostic attempt uses pixels-chrome-2; first log preserved.

Gate submitted `pixels-chrome-2`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-chrome-2 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-chrome-2.log`.
Gate completed `pixels-chrome-2`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-chrome-2.log`. Results require inspection before another gate.

Pixel-artifacts Chrome attempt 2 failed 0/1, CLI exit 2 before a target launched. The generated config lacked its root closing brace. Corrected the configuration layout, now retained as project-config.ts with environment variable names only. No policy, frame/thumbnail, hash, judge-dispatch or pixel assertion changed. Sanitized CLI refusal is pixels-chrome-2/cli-output.json; log preserved.

Gate submitted `pixels-chrome-3`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-chrome-3 node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-chrome-3.log`.
Gate completed `pixels-chrome-3`. Exit 1. ℹ tests 1; ℹ pass 0; ℹ fail 1; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-chrome-3.log`. Results require inspection before another gate.

Pixel-artifacts Chrome attempt 3 reached the real target, CLI pass, and retained pixels-chrome-3/pixels. Its new strict refusal check failed: screenshot reason explicitly says Retest withheld the capture by policy due to unread secret field, but contains no literal "pixel". The frame query returned inconclusive/no frames with a named missing interval instead of the expected error refusal. This is an over-specified new test expectation, not established product corruption. Both existing strict assertions remain failing, rather than rewriting them for green. They now run as independent children, preserving failed parent status while allowing actual approved-frame/thumbnail routes to be measured separately. The fixture now waits inside the secret stretch before requesting its last 500 ms, so that request cannot include safe pre-entry frames. No absence criterion or required outcome is removed. Failure verdict/report artifacts remain retained.

The incomplete frame reason counts a reported capture gap without saying explicitly that it was pixel withholding. Evaluation owner can review src/evaluation/frames.ts:105 and its lossSummary helper, plus src/runner/run-session.ts:1439, which supplies withheldFrom only for recordings forbidden by config. The correct contract for querying already approved frames during current withholding needs review; this lane makes no proposed privacy relaxation or assertion change.

Gate submitted `pixels-chrome-final`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-chrome-final node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-chrome-final.log`.
Gate completed `pixels-chrome-final`. Exit 1. ℹ tests 4; ℹ pass 1; ℹ fail 3; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-chrome-final.log`. Results require inspection before another gate.

Pixel-artifacts Chrome final gate failed with 1/4 passed and 3 failed, exit 1, no skips/cancellation. The approved image-route decoder leaf passed: {"sequenceFrames": 3, "sequenceStatus": "partial", "thumbs": 3, "judgedCalls": 3, "decodedVideoFrames": 30, "cadence": 6.195012808188981, "blockedRequests": [{"verdict": "error", "reason": "Retest withheld this capture of web by policy: the secret \"value\" was typed into a field Retest could not read, and the field had not been seen to stop showing it."}, {"verdict": "inconclusive", "reason": "The recording of web kept no frame from 1827 ms to 2327 ms on the run's clock, so the check has nothing to judge."}]}
Screenshot refusal and no judge dispatch were observed, while both strict refusal children failed unchanged. All saved frame hashes matched the judge and HTML, every selected frame was after resume, three real source-derived thumbnails decoded safely, and the recorded thumbnail worker closed and disappeared. No secret bytes or forwarded withheld-interval frame. Artifacts pixels-chrome-final/{pixels,pixel-artifacts.json,thumbnail-*.png,thumbnail-*.json,thumbnail-process.json,judge-calls.jsonl,observations/*/decode.json}. Gate remains failing; only its independently passing decoder leaf is claimed.

Gate submitted `pixels-firefox`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-firefox node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-firefox.log`.
Gate `pixels-firefox` lock busy, exit 75; no test started.
Gate completed `pixels-firefox`. Exit 1. ℹ tests 4; ℹ pass 1; ℹ fail 3; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-firefox.log`. Results require inspection before another gate.

Pixel-artifacts Firefox gate failed with 1/4 passed and 3 failed, exit 1, no skip/cancellation; host route launch-services. Independent decoder leaf passed. {"frames": 3, "sequenceStatus": "partial", "thumbs": 3, "judgedCalls": 3, "videoFrames": 32, "cadence": 7.160241651646433, "blocked": [{"verdict": "error", "reason": "Retest withheld this capture of web by policy: the secret \"value\" was typed into a field Retest could not read, and the field had not been seen to stop showing it."}, {"verdict": "inconclusive", "reason": "The recording of web kept no frame from 2576 ms to 3076 ms on the run's clock, so the check has nothing to judge."}]}
All actual frame hashes/byte lengths and HTML refs matched; forwarded withholding interval empty and no declared secret bytes. Approved screenshots, sequence, video and thumbnails decoded without red secret scene. Thumbnail worker confirmed gone. Strict literal-word/categorical-error expectations remain failing; no proven privacy leak. Artifacts pixels-firefox/{pixels,pixel-artifacts.json,thumbnail-*.png,thumbnail-*.json,thumbnail-process.json,judge-calls.jsonl,observations/*/decode.json}.

Gate submitted `pixels-webkit`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=webkit RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/pixels-webkit node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-pixel-artifacts.test.ts`. Log `.retest/evidence-targets/logs/pixels-webkit.log`.
Gate completed `pixels-webkit`. Exit 1. ℹ tests 4; ℹ pass 1; ℹ fail 3; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/pixels-webkit.log`. Results require inspection before another gate.

Pixel-artifacts WebKit failed with 1/4 passed and 3 failed, exit 1, no skip/cancellation; same two strict expectation children and failed parent. Independent decoder leaf passed. {"frames": 2, "sequenceStatus": "partial", "thumbs": 3, "judgedCalls": 3, "videoFrames": 30, "cadence": 5.846838958107055, "blocked": [{"verdict": "error", "reason": "Retest withheld this capture of web by policy: the secret \"value\" was typed into a field Retest could not read, and the field had not been seen to stop showing it."}, {"verdict": "inconclusive", "reason": "The recording of web kept no frame from 2771 ms to 3271 ms on the run's clock, so the check has nothing to judge."}]}
Actual approved sequence hashes/byte counts and HTML refs matched; all selected frames followed resume, no forwarded withheld-interval frame or secret bytes, and approved screenshots/video/sequence/thumbnails rejected the red secret scene. Recorded thumbnail worker gone. The earlier absolute safe-green colour witness remains failing, so complete WebKit pixel/colour proof is still not claimed. Artifacts pixels-webkit/{pixels,pixel-artifacts.json,thumbnail-*.png,thumbnail-*.json,thumbnail-process.json,judge-calls.jsonl,observations/*/decode.json}. Strict extra expectation mismatch is explicitly not release-defect proof.

Shared media-client readback shows its private optional chain and unused reclaim parameter changed by their owner. All image gates have returned. Full current typecheck follows, including every new evidence file; no source error has been suppressed by this lane.

Gate submitted `types-closeout`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-closeout.log`.
Gate completed `types-closeout`. Exit 0. . Log `.retest/evidence-targets/logs/types-closeout.log`. Results require inspection before another gate.

Full closeout npm typecheck passed exit 0: TypeScript 6 project, TypeScript 7 project and TypeScript 6 example all completed. Log types-closeout.log. This includes all nine new evidence integration files and the Step 0 unit correction. Earlier shared-source compiler errors and own queue correction remain in history. All heavy gates have returned; final process-identity and whitespace audits follow without starting a target.

Final process audit `python3 .retest/evidence-targets/process-audit.py > .retest/evidence-targets/logs/process-audit.log` passed exit 0. {"recordedReadings": 553, "present": [], "noSignalsSent": true}. It includes gate/decoder identities, CLI owner identities from media.started, and thumbnail workers. Actual runner/browser/media/encoder disappearance assertions also ran in the target/failure/queue harnesses. No signals were sent by either final audit. Final whitespace audit passed across 13 owned files, and scoped git diff --check passed. No target, gate or retry command remains queued.

Added evidence-judge.test.ts, an observation-only fake adapter wrapper that hashes actual approved screenshot arrays at dispatch and returns the original fake request/answer unchanged. Diagnostics test now requires these byte hashes, app/id/capture-time and lengths to equal its saved screenshot references and HTML paths, in addition to every existing flood/privacy/decode assertion. No existing assertion or required verdict was weakened. A fresh diagnostics-hashes gate follows; initial diagnostics proof remains retained. Full typecheck and final process audit will repeat because a new helper was added.

Gate submitted `diagnostics-hashes`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py env RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/evidence-targets/diagnostics-hashes node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-diagnostics.test.ts`. Log `.retest/evidence-targets/logs/diagnostics-hashes.log`.
Gate completed `diagnostics-hashes`. Exit 0. ℹ tests 1; ℹ pass 1; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0. Log `.retest/evidence-targets/logs/diagnostics-hashes.log`. Results require inspection before another gate.

Gate submitted `types-final-complete`. Exact command `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/evidence-targets/inside.py npm run typecheck`. Log `.retest/evidence-targets/logs/types-final-complete.log`.
Gate completed `types-final-complete`. Exit 0. . Log `.retest/evidence-targets/logs/types-final-complete.log`. Results require inspection before another gate.

Fresh diagnostics-hashes passed 1/1, exit 0, no skips or cancellations. Actual approved image byte hashes, lengths, app/id and capture time delivered to the judge exactly matched the saved screenshot references and HTML paths. The observation adapter delegated the original request and answer unchanged. No declared secret bytes or red secret scene were found, and no forwarded frame occupied the withheld interval. Artifacts diagnostics-hashes/{flood,flood-summary.json,judge-image-hashes.jsonl,judge-calls.jsonl,observations/*/decode.json}; log logs/diagnostics-hashes.log. Exact recorded facts follow.
```json
{
  "console": {
    "state": "partial",
    "reason": "1991 messages over the attempt's limits were dropped",
    "entries": 10,
    "errors": 0,
    "warnings": 0,
    "runtimeErrors": 0,
    "handledLater": 0,
    "dropped": 1991,
    "truncated": 0,
    "bytes": 13101
  },
  "judgeRequests": 2,
  "deliveredImages": [
    {
      "requestId": "8lt02xw6ww:evaluation-1",
      "images": [
        {
          "id": "e1",
          "app": "web",
          "bytes": 3067,
          "sha256": "dc61735cd1b8260a48cc3753c368dd228b98e44ad89524e96541318b12878d43",
          "capturedAt": "2026-10-06T10:19:08.303Z"
        }
      ]
    },
    {
      "requestId": "8lt02xw6ww:evaluation-2",
      "images": [
        {
          "id": "e1",
          "app": "web",
          "bytes": 2747,
          "sha256": "51722eb6e4f4acee36381f8b22463bb3fe84c7801a8765df18187fc8c107d722",
          "capturedAt": "2026-10-06T10:19:09.419Z"
        }
      ]
    }
  ],
  "decode": [
    {
      "identity": {
        "runId": "6f54d9e5-3e32-4173-a7d5-a0f145f69b32",
        "testId": "flood.retest.ts > bounded secret diagnostics while recording",
        "attemptId": "8lt02xw6ww",
        "app": "web",
        "sessionId": "8lt02xw6ww:web"
      },
      "probe": {
        "programs": [],
        "stream_groups": [],
        "streams": [
          {
            "codec_name": "h264",
            "width": 320,
            "height": 240,
            "nb_read_frames": "18"
          }
        ],
        "format": {
          "duration": "1.800000"
        }
      },
      "decodedFrames": 18,
      "samples": [
        {
          "frameId": "2",
          "videoFrame": 0,
          "meanAbsolutePixelError": 0.15787760416666666
        },
        {
          "frameId": "4",
          "videoFrame": 11,
          "meanAbsolutePixelError": 0.65234375
        },
        {
          "frameId": "5",
          "videoFrame": 17,
          "meanAbsolutePixelError": 0.65234375
        }
      ],
      "captureCadencePerSecond": 2.4224028661870713,
      "cadenceMethod": "forwarded intervals / elapsed time between first and last forwarded capture timestamps; secret withholding remains in that elapsed span",
      "recording": {
        "recordingId": "8lt02xw6ww-1-1",
        "sequence": 1,
        "testId": "flood.retest.ts > bounded secret diagnostics while recording",
        "attemptId": "8lt02xw6ww",
        "app": "web",
        "sessionId": "8lt02xw6ww:web",
        "source": "chromium",
        "mode": "screencast",
        "capture": {
          "clockMapping": {
            "timestamp": "run-arrival",
            "targetClock": "not-used",
            "imageRead": "previous-acknowledgement-to-arrival"
          },
          "achievedFps": 2.98
        },
        "frames": {
          "delivered": 5,
          "sent": 5,
          "dropped": 0,
          "notSent": 0,
          "withheld": 0,
          "refused": 0
        },
        "withheld": {
          "stretches": 1,
          "durationUs": 591368
        },
        "stoppedBy": "attempt_ended",
        "path": "artifacts/8lt02xw6ww/web-1fszmh3anyupd/recording-1.mp4",
        "status": "partial",
        "gaps": [
          {
            "code": "capture_gaps",
            "message": "The capture reported 1 stretch in which it could hand over no frame.",
            "app": "web",
            "sessionId": "8lt02xw6ww:web"
          },
          {
            "code": "pixels_withheld",
            "message": "The pixel capture policy withheld 0 frames over 1 stretch while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.",
            "app": "web",
            "sessionId": "8lt02xw6ww:web"
          }
        ],
        "media": {
          "received": 5,
          "shown": 4,
          "superseded": 1,
          "dropped": 0,
          "outOfOrder": 0,
          "outOfRange": 0,
          "undecodable": 0,
          "duplicate": 0,
          "unprocessed": 0
        },
        "captureGaps": 2,
        "clock": {
          "capture": "run_us",
          "timestamp": "host-arrival",
          "videoZeroUs": 1375811,
          "durationUs": 1800000,
          "shortened": [],
          "shortenedCount": 0
        },
        "finalizeMs": 68,
        "video": {
          "codec": "h264",
          "container": "mp4",
          "width": 320,
          "height": 240,
          "fps": 10,
          "outputFrames": 18,
          "durationUs": 1800000,
          "placedBy": "link"
        }
      }
    }
  ]
}
```

Final full `npm run typecheck` passed exit 0 under the shared lock: TypeScript 6 project, TypeScript 7 project and TypeScript 6 example. Log logs/types-final-complete.log. It includes all ten new evidence integration files and the Step 0 unit correction. The final metadata-only process audit follows; no target remains queued.

Repeated final process audit `python3 .retest/evidence-targets/process-audit.py > .retest/evidence-targets/logs/process-audit.log` returned exit 0. The previous 553-reading audit remains in process-audit-before-hashes.json and its matching log. Current recorded identities and readings:
```json
{"recordedReadings": 569, "present": [], "noSignalsSent": true}
```
No signal was sent. This query includes the last diagnostics gate, its decoder and all earlier registered process identities.

Final record step: rewrote proofs/evidence.md and evidence-targets-state.md with the completed target counts, exact refusal, measured capture facts, artifact/log locations, and unverified capabilities first. Updated this report summary to the final diagnostics hash gate, all ten integration files, final full typecheck, and 569-reading process audit. Earlier failures and commands remain in the step record. No further target or heavy command is queued. Final scoped whitespace verification follows.

Final scoped whitespace check passed across all 14 owned files: ten new evidence integration files, the unit file and three records. `git diff --check -- tests/unit/native-processes.test.ts` returned exit 0. Facts are final-files-check.json. No target, process cleanup or heavy command remains queued. This lane is closed with the failures and unverified capabilities recorded, not with an all-target capability claim.
