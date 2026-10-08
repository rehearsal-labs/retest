Retest Phase 4 second read: media, recording and capture

This review covers the requested media process, protocol-2 client, runner recording lifecycle and capture sources. I read README.md, docs/architecture.md, the five named lane reports, common.md, the Phase 4 release requirements and the relevant guide sections. Findings below distinguish reproduced behavior from conclusions drawn from code.

No source, test, configuration or existing report was edited. This requested review file is the sole workspace write. Unit tests used in-memory browser and media stand-ins and temporary test fixtures. I started no browser, simulator, app, media process, ffmpeg or benchmark.

I compared SHA-256 snapshots during the review. `tests/unit/native-processes.test.ts` and `tsconfig.build.json` changed under me, so I excluded them from conclusions. The build configuration later matched its initial hash; that does not erase the observed change. New evidence-targets handover documents also appeared and are outside this review. The reviewed core source files and the unit files behind the findings below retained their initial hashes.

Findings follow, most severe first. P1 means a release-blocking evidence, pixel-policy, termination or resource-bound defect. P2 means a narrower correctness or verification defect.

1. **P1. Capture-gap overflow can turn missing evidence into a complete frame sequence.** [media/src/ledger.rs:158](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/ledger.rs:158), [media/src/jobs.rs:424](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/jobs.rs:424), [src/evaluation/frames.ts:313](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/evaluation/frames.ts:313).

   The ledger counts every capture gap but retains only the first 1024. A frame sequence reads only that retained list and never reports that gap information was omitted. Its omission warning concerns frame-map overflow, which is a separate counter.

   Concrete input: report 1024 gaps outside a later requested interval, then report a `capture_failed` gap between two successfully kept frames in that interval. Request just those two frames after both are placed. The 1025th gap has vanished from the sequence. With `minGapUs: 1`, evaluation sees a stretch with zero losses and no capture-gap reason; `missingParts` returns nothing and the evidence becomes `complete`. A presence judgment can then count as a pass. The recording's eventual ending remains partial because its total gap count survives, but that does not repair the earlier evaluation.

   Confidence: high from the Rust data flow. A pure TypeScript probe confirmed that the resulting gap-free sequence has no missing reasons. I did not run a Rust overflow reproduction. The ledger unit at [media/src/ledger.rs:358](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/ledger.rs:358) checks bounded retention and the ending count, not preservation of uncertainty in later sequences.

2. **P1. Validly framed replies can attach another attempt's video or frames to the requested recording.** [src/media/client.ts:519](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:519), [src/media/client.ts:830](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:830), [src/media/client.ts:847](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:847), [src/media/client.ts:865](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:865), [src/runner/run-media.ts:510](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:510).

   Pending starts retain the promise, without the requested identity or output. `started` and `ended` are accepted by recording id; jobs are accepted by request id and reply kind. The client does not compare the returned recording identity, video path or frame-sequence recording id with the request.

   Concrete reply: for a start belonging to attempt A, send an `ended` with A's recording id, B's identity and B's existing nonempty video path inside the same run folder. The runner's artifact check passes because the file exists and is a safe reference. `endedRecording` stamps A's identity onto it and can label it complete. Likewise, a `frames` reply with the expected request id and interval but another recording id passes client dispatch and evaluation's interval checks.

   Confidence: high. A pure probe confirmed that `endedRecording` relabels foreign identity and a foreign path as complete under the caller's attempt. The process-level hostile-reply case was inspected, not launched. This is a semantic binding failure; schema validation and file existence do not establish provenance.

3. **P1. The earliestUs fix assumes a later frame was captured after the previous host delivery.** [src/browser/capture.ts:174](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/capture.ts:174), [src/browser/capture.ts:187](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/capture.ts:187), [src/browser/webkit/capture.ts:172](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/webkit/capture.ts:172), [src/browser/webkit/capture.ts:186](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/webkit/capture.ts:186), [src/media/capture.ts:864](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/capture.ts:864).

   Both screencasts acknowledge an arriving frame before cadence delivery, then assign the next arriving frame's lower capture bound from the previous delivery time. An acknowledgement allows capture to advance while the acknowledged frame is still waiting for its delivery tick.

   Concrete interleaving: B arrives and is acknowledged at run time 110, C is captured during withholding at 155, the stretch closes at 160, B is handed over at 200, and delayed C arrives at 210. C receives `earliestUs: 200`. A direct `recordSource` consumer with `CaptureSuspension` sees no overlap with 150..160 and sends C. The bytes can have been read before the claimed lower bound.

   Confidence: high about the unsafe bound and acknowledgement/delivery ordering, medium about reproducing that delay on a real target. No target was launched. The current runner's `PolicedSource` uses source-start time for every frame and therefore protects its delivery route against this narrowed bound. The unit at [tests/unit/browser-capture.test.ts:74](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/browser-capture.test.ts:74) verifies the assigned numbers; it does not establish the remote capture-time ordering that makes them safe. The closeout report's passing Chrome gates establish those observed runs, not this ordering guarantee.

4. **P1. Withholding prevents retention but does not prevent all pixel capture.** [src/runner/policed-source.ts:81](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/policed-source.ts:81), [src/runner/run-media.ts:358](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:358), [src/native/capture.ts:59](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/native/capture.ts:59), [src/browser/capture.ts:174](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/capture.ts:174), [src/browser/webkit/capture.ts:172](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/browser/webkit/capture.ts:172).

   `PolicedSource.withhold()` only suspends the sender. Chromium and WebKit keep their streams running, acknowledge frames and construct image buffers during the stretch. Screenshot loops check suspension before starting a grab, but the selected native route awaits its target check before requesting the image and does not recheck withholding at that boundary.

   Concrete native interleaving: a permitted tick enters `checkTarget`; secret entry suspends capture while that check is pending; the check returns and line 64 requests pixels during the stretch. A stand-in probe observed exactly one image request with withholding active. For a Mac `window-crop`, withholding another session affects the shared display policy, but `AttemptRecorder.withhold` only suspends the named session. The Mac source continues requesting pixels and relies on the delivery judge to discard them.

   Confidence: high. The native dispatch race was reproduced without a native process. The screencast and shared-display routes are direct code observations. I found no retained secret image through the current runner's conservative delivery checks in the checks I ran. That is narrower than the requested invariant that pixels are not captured during a withheld stretch, and narrower than the guide's "withholds every capture" wording at [docs/guide.md:1526](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/guide.md:1526).

5. **P1. Run cancellation does not stop an already running screenshot loop from issuing new captures.** [src/runner/policed-source.ts:133](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/policed-source.ts:133), [src/runner/run-media.ts:421](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:421), [src/runner/run-media.ts:446](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:446), [src/runner/run-session.ts:1058](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-session.ts:1058).

   The run signal is checked only before a source start. The recorder passes a separate controller to `recordSource`; that controller is aborted by recorder finish, rather than by the run signal. A started browser screenshot loop continues until execution reconciliation and diagnostics finish reach recorder finish.

   Concrete interleaving: start a Firefox-style loop, abort the run signal, leave reconciliation or diagnostics pending, and let subsequent ticks occur. The pure probe counted one capture at cancellation and five total before explicit stop. These were new grab calls, not reconciliation of a dispatched grab.

   Confidence: high, reproduced with in-memory source options. Native cancellation has its additional session guard; this finding specifically establishes the browser loop path. The recording-runner report's claim that new capture commands stop after run cancellation at [docs/plans/public-beta/codex/phase-4/recording-runner-report.md:88](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/recording-runner-report.md:88) exceeds the pre-start cancellation test.

6. **P1. Media discovery or start can hold runner startup and shutdown indefinitely.** [src/runner/run-media.ts:133](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:133), [src/runner/run-media.ts:154](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:154), [src/runner/run-media.ts:157](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-media.ts:157).

   `close()` awaits `#starting` without a bound. The starting promise directly awaits discovery and the supplied starter; only the later encoder-readiness promise is wrapped by `bounded`.

   Concrete input: discovery returns a promise that never settles. Start an acquisition and then cancel/close. No media process has started, but close never reaches cleanup. A pure probe with that discovery stayed pending beyond its configured start and close budgets. The normal discover route also awaits filesystem discovery and cache inspection without an outer runner deadline.

   Confidence: high, reproduced. The passing test for an encoder probe that never answers covers a later phase and cannot prove this startup bound.

7. **P1. File finalization runs after the Rust deadline watchdog has been disabled.** [media/src/recording.rs:1007](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/recording.rs:1007), [media/src/recording.rs:1117](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/recording.rs:1117), [media/src/place.rs:93](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/place.rs:93), [media/src/recording.rs:587](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/recording.rs:587).

   The encoder thread calls `mark_done()` before `conclude` places the video. The watchdog exits when ending is done and already stops considering a missed finish deadline once encoder exit is known. Copying, syncing and renaming the final file have no deadline checks.

   Concrete interleaving: ffmpeg exits successfully before the finish deadline, then the copy fallback blocks in a filesystem read, write or `sync_all`. The recording thread can remain stuck, or later emit `ok` after the finish deadline. The client/runner can time out and force the worker down, but that is an outer rescue rather than deadline-bound container/file finalization.

   Confidence: high from control flow. Slow or stuck filesystem finalization was not exercised. Existing deadline tests stall the encoder; the kill-during-copy test exercises abrupt death, not a deadline during finalization. Phase 4 explicitly requires completion to wait for file/container finalization under a deadline.

8. **P1. A full Rust reply queue can prevent stdin EOF or shutdown from being handled.** [media/src/replies.rs:80](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/replies.rs:80), [media/src/replies.rs:132](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/replies.rs:132), [media/src/jobs.rs:95](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/jobs.rs:95), [media/src/server.rs:953](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/server.rs:953).

   Non-live replies wait on a condition variable when the queue is full. The writer performs blocking pipe writes. Neither that wait nor writer/worker joins has a timeout or an input-closed escape.

   Concrete client behavior: keep stdout open without reading it, fill the 1024-reply or 256 MiB queue with normal replies, and close stdin. The main server can already be blocked queuing an error/readiness reply, so it cannot observe the reader's EOF. Shutdown can also wait for a job blocked queuing its reply. An unfinished encoder has no finish deadline until finish/shutdown is processed and can remain waiting alongside the worker.

   Confidence: high from blocking calls; no process saturation test was run. The existing slow-watcher process test at [media/tests/process.rs:1738](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/tests/process.rs:1738) fills the live path and resumes reading before shutdown. It does not fill the normal reply queue. The Node client's ownership-based forced close limits the ordinary runner path, but the Rust process's own EOF/shutdown guarantee remains unsupported.

9. **P1. Client buffering is bounded only for frames, and a poisoned parser can also retain unlimited input.** [src/media/client.ts:540](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:540), [src/media/client.ts:655](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:655), [src/media/client.ts:763](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:763), [src/media/client.ts:526](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:526), [src/media/protocol.ts:777](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/protocol.ts:777).

   `maxPendingBytes` is checked only by `sendFrame`. Thumbnail payloads and control requests call `stdin.write` without admission limits or waiting for drain. Pending jobs/readiness/starts have no concurrency cap; timed-out starts accumulate in an uncapped abandoned set.

   Concrete load: while the worker stops consuming stdin, issue concurrent thumbnails with permitted large images. Node queues every payload even after its writable high-water mark is crossed. Rust's bounded job queue cannot bound data still buffered in the client.

   Separately, an oversized reply prefix stays at the front of `ReplyReader` after it throws. Each later chunk is appended before the same exception. The stdout listener continues calling it after failure. A pure probe retained 2,097,160 bytes behind an already rejected prefix, with growth on every chunk. If ownership cleanup cannot stop the worker, this can continue.

   Confidence: high. The poisoned-parser accumulation was reproduced. I did not send a payload flood to a real or stand-in media process.

10. **P1, conditional filesystem path. The checked-rename fallback can overwrite a foreign completed recording.** [media/src/place.rs:108](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/place.rs:108), [media/src/place.rs:119](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/place.rs:119).

    When hard links and exclusive rename are unavailable, the fallback checks that the final path is absent and then calls ordinary `fs::rename`. Another producer can create the final file between those operations; rename replaces it and this producer reports successful copy placement.

    Confidence: high for the race, conditional on reaching that fallback. The media-process report correctly admits it at [docs/plans/public-beta/codex/phase-4/media-process-report.md:320](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/media-process-report.md:320). The tested APFS exclusive-rename route does not cover it, and the function's "never replacing" contract is stronger than its implementation. Normal runner attempts use distinct paths; this is not evidence of ordinary retry overwriting.

11. **P2. A header-readable but undecodable image can still be reported as a successful thumbnail or live frame.** [media/src/frame.rs:244](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/frame.rs:244), [media/src/jobs.rs:288](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/jobs.rs:288), [media/src/live.rs:121](/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/src/live.rs:121).

    `frame::fit` returns original bytes without decoding when format and dimensions already fit. Thumbnail and live routes use it directly; the live slot receives input before encoder decoding.

    Concrete input: a PNG/JPEG with intact dimension headers and broken image data, already within the requested size and in the requested format. The thumbnail route can write those bytes and return `status: ok`; a live view can offer them and count them sent. The recording route's new `for_route` decode correctly rejects the same class of frame, but that validation is not shared by these routes.

    Confidence: high from the fast path, not runtime-reproduced in Rust. The existing encoded-frame regression checks recording fate, not matching-format thumbnail/live validation. I found no analogous unvalidated `shown` assignment in the reviewed recording route.

12. **P2. Truncated stdout is not classified as a protocol failure at EOF.** [src/media/protocol.ts:790](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/protocol.ts:790), [src/media/client.ts:442](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:442), [src/media/client.ts:647](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/media/client.ts:647).

    `ReplyReader` exposes pending bytes but has no end-of-stream check, and the child's close handler never examines them.

    Concrete reply: after a valid greeting and settled work, write only part of a reply prefix/header/payload and exit with code zero. With no requests left, `close()` can return code zero, `forced: false` and no bye rather than a truncation error. Active recordings are still rejected on exit, so the narrower defect is accepting a malformed terminal stream as clean closure.

    Confidence: high from the close path. A pure reader probe retained a three-byte prefix without an error; the process-level close was not launched.

13. **P2. Capture clock provenance is discarded before recording events/results are built.** [src/runner/policed-source.ts:185](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/policed-source.ts:185), [src/runner/evidence-status.ts:207](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/evidence-status.ts:207), [src/protocol/recording.ts:106](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/protocol/recording.ts:106).

    `PolicedSource.#combined` reconstructs stats without `clockMapping`, achieved cadence or capture latency. `RecordingClock` then records `run_us` and video timing without saying that capture timestamps are host arrivals and target paint time was unused.

    Concrete run: record a native screenshot loop whose source explicitly reports request-to-arrival uncertainty. Its final recording record has the same capture-clock label as a pushed screencast, with no persisted read-window mapping. A report consumer cannot recover that distinction from recording events.

    Confidence: high from field construction. The capture-sources report already identifies this unfinished handoff. Native paint-to-run-clock mapping remains unverified; an arrival timestamp should not imply that proof.

14. **P2. Two recording-off tests require the obsolete, unsafe secret-screenshot behavior.** [tests/unit/runner-recording.test.ts:97](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/runner-recording.test.ts:97), [tests/unit/runner-recording.test.ts:119](/Users/dragon/Documents/Projects/Gruvi/Products/retest/tests/unit/runner-recording.test.ts:119), [src/runner/run-session.ts:400](/Users/dragon/Documents/Projects/Gruvi/Products/retest/src/runner/run-session.ts:400).

    The test config declares secrets. The latest constructor activates the pixel policy for those declarations even when recording is off. One test still expects no withholding events; another expects a failure screenshot after secret entry.

    Both failed in this review: actual withholding events were `capture.withheld` and `capture.resumed`, and the secret failure had zero screenshots rather than one. Restoring their old expected behavior would reopen the recording-off pixel route. The guide and evaluation closeout describe the current conservative behavior, while older recording-runner report statements about off-run screenshot behavior are stale.

    Confidence: high, executed against unchanged test and source files. These are verification defects, not a request to weaken the secret guard.

What I checked and found sound:

- The runner exposes a finished video path only after checking a safe portable reference to a nonempty artifact. The missing-file unit passed and retained the test's pass while marking its recording unavailable. This checks existence and safe reads, not independent container decodability or provenance.
- Recording failure is separate from the test's observed outcome. Unit cases for missing media, encoder refusal, process loss, capture refusal and required evidence preserved test verdicts. Required evidence produced a separate run failure. Interrupted fake runs finished recordings before media close and retained exit 130.
- Distinct attempts of the same test retained distinct recordings. The normal runner's artifact path includes attempt identity and recording sequence. I found no ordinary retry-path overwrite in this route.
- Failure and evaluation screenshots consult pixel policy before dispatch and again over the request-to-arrival span before saving/sending bytes. Evaluation tests withheld both pre-dispatch and overlapping captures. A declared-secret run activates that policy with recording off. This does not make a dispatched capture undoable.
- Source identity refusals precede capture; native sources also bind launch generation and check target processes before and after pixels. FrameSender refuses mismatched identity, invalid clocks, empty/oversized frames and out-of-order delivery. These checks do not resolve the reply-binding finding.
- Rust recording's encoded route now actually decodes matching images before admitting them to the encoder. Frames given no output frame at the duration cap become out-of-range rather than shown. Kept-frame reads use duplicated handles to the store's own file rather than reopening its path.
- Rust frame queues have frame and byte caps, the job channel has a fixed count, active recordings and retained frame stores have caps, and live views retain a newest slot. Losses are counted. These caps do not bound the Node queues or guarantee progress under saturated normal replies.
- Rust cleanup uses the launched Child handle for its root and freshly checked ownership for descendants. The Node ownership units passed for reused PIDs and failed metadata reads without authorizing a signal. Cleanup uncertainty is reported. I did not independently prove that a real process was gone.
- Hard-link finalization is exclusive, and the normal copy route creates and syncs a separate `.copying` file before exclusive rename. A killed copy cannot expose its unfinished bytes at the final path on that route. The unsupported-exclusive-rename fallback is the exception above.
- An unfinished recording rebuilds as unavailable, and a missing result always rebuilds as an incomplete error run. Retention removal failures undo the claim that an artifact was removed. Recording/result reconstruction comparisons passed in the selected units.
- The real capture proof helper decodes output and requires every decoded frame to have a mapped source state, rather than passing on file existence alone. The capture report preserves iOS ambiguity and the macOS refusal instead of calling them five verified targets. I read the retained capture verification JSON, the pixel proof JSON and the five fixed-Chrome result records. I also checked the three retained media-process test logs; each records 88 unit and 48 process tests passing. Those are the builders' historical executions, not new runs by this reviewer.

Checks executed here:

```sh
node --conditions=retest-source --test --test-reporter=spec tests/unit/media-protocol.test.ts tests/unit/media-policy.test.ts tests/unit/media-capture.test.ts tests/unit/browser-capture.test.ts tests/unit/firefox-capture.test.ts tests/unit/webkit-capture.test.ts tests/unit/screenshot-loop-capture.test.ts tests/unit/runner-evidence-status.test.ts tests/unit/runner-policed-source.test.ts tests/unit/config-recording.test.ts
```

Exit 0; 144 tests passed, none failed, skipped or cancelled.

```sh
node --conditions=retest-source --test --test-reporter=spec tests/unit/runner-media-lifecycle.test.ts tests/unit/runner-recording.test.ts tests/unit/runner-media-leftovers.test.ts tests/unit/media-ownership.test.ts tests/unit/evaluation-frames.test.ts
```

Exit 1; 110 tests, 108 passed and the two obsolete recording-off assertions above failed. None skipped or cancelled. Browser and media implementations in this gate are in-memory stand-ins; the runner's ordinary Node test-file children and metadata reads ran.

```sh
node node_modules/typescript/bin/tsc -p .retest/recording-runner/tsconfig.json --noEmit --incremental false
node node_modules/typescript-7/bin/tsc -p .retest/recording-runner/tsconfig.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p proofs/media/tsconfig.json --noEmit --incremental false
node node_modules/typescript-7/bin/tsc -p proofs/media/tsconfig.json --noEmit --incremental false
```

All four exited 0. These are scoped checks with the existing strict configurations, not a whole-tree build or typecheck.

Three successful inline Node assertion probes exercised the native preflight withholding race plus post-cancellation loop requests; malformed/truncated reply buffering plus evidence relabeling and missing-parts classification; and unresolved-discovery shutdown. They wrote no files and launched no platform/media processes. An earlier version of the first probe failed because its screenshot-loop stand-in omitted required availability/timeout options; the corrected probe asserted a successful start before measuring cancellation. That fixture failure is not a product finding.

The required benchmark process checks were empty before unit execution. No lock, benchmark, build, schema generation, download, commit or publication ran.

What I could not verify:

- Real browser timing for the earliestUs interleaving, native withholding dispatch, real screenshot-loop cancellation, Rust queue saturation, a stalled final copy, or a client payload flood. The matching findings state where certainty comes from code or stand-ins.
- Actual media/encoder cleanup, actual CLI exit status and timeout behavior, playable output and independent decodes on the current tree. The user's restrictions exclude those executions. Historical logs and passing fake units do not supply that new proof.
- Successful macOS capture/recording, native every-paint timing, Linux x64, a real filesystem without hard links or exclusive rename, and the native end-to-end encoded-frame route. The reports retain these limitations. I did not bypass the covering-window refusal or infer native support from browser/mocks.
- A whole-tree unit run, whole-tree typecheck, installed binary/source equivalence, clean-host installation, HTML seeking/playback, live-provider accuracy or prompt-injection resistance. The scoped compiler results cannot stand in for them.
- Files observed changing during this review. I did not diagnose or repair those changes.
