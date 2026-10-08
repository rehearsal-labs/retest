# Identity lane record: one record identity, capture onto the media protocol, the parent's command lanes

The handoff's item on unified events and screenshots and on capture adapters for the media process ([release-0.1.0.md](../release-0.1.0.md), native sessions and the cross-platform flow), with the bounded media job in [plan.md](../plan.md) section 8 and the media process in [media.md](media.md), plus the gap the [resources lane](resources.md) found in the parent's command handling. Written 4 October 2026 and revised the same day after a review that reported fifteen findings; [Review findings](#review-findings-and-what-showed-each-fixed) lists them. A test on real Chrome is marked Chrome, one with the real media process media, one against the fake browser and real test file processes fake, and a pure unit unit.

## One identity on every record

`src/protocol/identity.ts` defines `RecordIdentity`: `testId`, `attemptId`, `app`, `sessionId`, and `observationId` where the record rests on a look, by the id the parent gave that look when it served it to the test file's process. A record carries a key only when its writer knows it; none is derived or made up at the reader. Events keep naming the app in `session`, as every event always has; renaming it would break every reader for no gain, so the identity's doc comment and the guide say so instead.

What each record carries now:

| Record | Before this lane | Added |
| --- | --- | --- |
| `action.completed`, `action.failed` | `testId`, `attemptId`, `session` | `sessionId` |
| `navigation` | `testId`, `attemptId`, `session` | `sessionId` |
| `observation` | all five | nothing |
| `assertion.passed`, `assertion.failed` | `testId`, `attemptId`, `session`, `observationId` | `sessionId` on a locator or page assertion: the session that served the look it names, or, when it names none, the session of the app the parent judged it on; a value assertion has none. An assertion naming an app the test does not have is now a protocol violation, so no session id is made up for it |
| `host_check.passed`, `host_check.failed` | `testId`, `attemptId`, `session` | `sessionId` of the page it read; a check of an app the test lacks read no page and names none |
| `state.saved`, `state.restored` | `testId`, `attemptId`, `app` | `sessionId` in the schema; written on `state.saved` only, since `RunSession` writes `state.restored` |
| `evidence.captured` | `testId`, `attemptId`, `session`, `sessionId`, `capturedAt` | `capturedElapsedMs`, `source`, `observationId` (schema only: the parent's look id for a capture it served as a look, never a native session's own reference id) |
| `evidence.failed` | `testId`, `attemptId`, `session`, `sessionId` | `source` |
| a screenshot in `result.json` | `app` (config runs), `sessionId`, `attemptId`, `capturedAt` | `capturedElapsedMs`, `source`, `observationId` (schema only) |
| a diagnostics record | `testId`, `attemptId`, `app`, `sessionId`, `target` | nothing; its type is `DiagnosticIdentity`, the shared identity without `observationId` (a diagnostic rests on no look) plus `target` |
| an AI check's evidence record | `app`, `sessionId`, `attemptId`, `capturedAt` | `testId`, `capturedElapsedMs`, `source` |

Every other event type carries the attempt's `testId` and `attemptId` or nothing: none of them comes from one session. `tests/unit/protocol-identity.test.ts` pins the identity keys of every event type against the published JSON Schema, including the `resource.acquired` and `lease.taken` events the resources lane added while this lane ran (unit).

### Public type names

`@rehearsal-labs/retest/protocol` exported `RecordIdentity` before this lane as a diagnostics record's identity: `testId`, `attemptId`, `app`, `sessionId`, `target?`. That name keeps that shape, as an alias of `DiagnosticIdentity`, so a consumer typed against it compiles unchanged. The shared identity is published as `SessionRecordIdentity`, and `DiagnosticIdentity` under its own name. Inside the source tree the shared shape is `RecordIdentity` in `src/protocol/identity.ts`, as the lane's brief named it. A compile-time check in the unit test fails if the published `RecordIdentity` gains or loses a key.

### What took a capture

`source` is `chromium` for a Chromium page's capture over the DevTools protocol, an Electron window's included, or a native session's own source name, `executor-screen`, `simulator-display` or `window-crop`, exactly as `src/native/session.ts` names them; a compile-time check in the unit test fails if the native names drift from the protocol's. A runtime whose capture Retest does not take over the DevTools protocol gets no `source` rather than a wrong one (`screenshotSource` in `src/runner/test-pages.ts`). The fake browser's runtime says it is Chromium, so fake runs record `chromium` too; that is the fake's claim.

### The run's clock on a screenshot

`capturedAt` was already the wall-clock time a capture came back. `capturedElapsedMs` is the same moment on the run's clock, the monotonic milliseconds since the run started that every event's `elapsedMs` counts, so a screenshot falls between the events around it whatever the wall clock did.

The writers of screenshots (`src/runner/test-pages.ts`, `src/evaluation/evidence.ts`) do not hold the run's clock: it lives in `RunSession`, which is the resources lane's file. The run store, which every one of them holds and through which every event passes, reads the clock off the events it writes (`RunStore.elapsedMs()`): each written event places the clock's zero at `now - elapsedMs`, and the store keeps the earliest such zero, since each event is stamped a moment before it is written. It agrees with the event log to the millisecond the log rounds to, plus the moment between stamping and writing the quickest event, and never goes back (unit, with a bound measured from the test's own scheduling). Every screenshot's `capturedElapsedMs` lies between its attempt's `test.started` and `test.finished`, and at or before its own event's `elapsedMs` (fake, Chrome).

### Compatibility

`schemaVersion` stays 1 and every field is optional, so a reader built from this tree reads older run folders. A reader built before this lane refuses a run folder written by it: every version 1 object refuses unknown keys, and every attempt that acts, navigates, looks or fails with a screenshot now writes `sessionId`, `source` or `capturedElapsedMs`. Reasoned from the schemas, not run. `node scripts/write-schemas.ts` regenerated `dist/schemas/event-v1.schema.json` and `dist/schemas/result-v1.schema.json`; the `evidence.captured` option lists `capturedElapsedMs`, `source` (an enum of the four names) and `observationId`, and `schemaVersion` is still `const: 1`.

### The rebuild

A result rebuilt from the events of a finished run equals `result.json` file for file and field for field, the new fields included, in the cases these tests compare: `store-rebuild-result.test.ts` compares whole `files` for a failure run without a config and for a two-app config run (fake), `runner-session-evidence.test.ts` asserts the new fields on a screenshot and its rebuilt copy (fake), and `record-identity.test.ts` deletes `result.json` and compares the test `inspect --json` rebuilds with the one `result.json` held (Chrome).

Corrected in the review fix round: until then a host check, or a host AI check, that a result lists as `not_run` had no event when it was never reached (after a body that failed, for a skipped test, for a test that never ran, and for an attempt that ended before its checks), so the rebuild dropped it and the sentence above was not true for those cases. Now `test.finished` lists such host checks in `hostChecksNotRun`, each with its app, and the parent writes an `evaluation.finished` with the verdict `not_run` for each such host AI check. `tests/unit/store-rebuild-not-run-checks.test.ts` compares the whole rebuilt result with `result.json` for the three cases (fake), and fails three of its four tests with the new event fields removed. `schemaVersion` stays 1; a reader built before this change refuses a run folder whose `test.finished` carries `hostChecksNotRun`, since version 1 objects refuse unknown keys (reasoned from the schema; the test shows the reader built now validates the field).

Also in that round, a check that failed on a look the parent served is written with the parent's own failure first when the process sent another class: `not_found`, `ambiguous` or `check_failed` from that look, the process's class kept in `details.also`, and a class that would make the test ours (`session_lost`, `setup_failed`, `unsupported`, `outcome_unknown` and the other classes that give `error`) is never counted as one the parent saw unless the parent saw that loss itself (`tests/unit/runner-parent-look-verdict.test.ts`, every such class forged against a real mismatching look, fake page and stand-in native tree). And `firefox` and `webkit` joined the capture source names, for a page those engines captured through their own protocol (`browsingContext.captureScreenshot` and `Page.snapshotRect`); a reader built before that refuses a folder carrying either name, as the enum refuses unknown values (reasoned from the schema).

### One real run, joined

`tests/integration/record-identity.test.ts` runs `retest run` on real Chrome with the fake judge: the test visits the diagnostics page, saves a task, runs an AI check on a screenshot, then fails a text check. From that one run it checks that the failure screenshot in `result.json` and its event, every action, navigation, look, the failed assertion and both diagnostics markers, every line of the diagnostics artifact, and the AI check's screenshot record carry the same `testId`, `attemptId`, `app` and `sessionId`; that both screenshots say `chromium` and a run-clock time within the attempt; that `inspect --test --json` gives the same test, the same events and diagnostics lines naming the session; that `inspect --test` prints `screenshot <path>  chromium, session <id>`; and the rebuild above (Chrome).

Screenshots are pixels. Text redaction never reaches them, as before; the guide's new section says so beside the identity table.

## Capture onto the media input protocol

### The interface

`src/media/capture.ts` defines `FrameSource`: `name` (a `CaptureSourceName`), the session's `identity`, `availability()`, `start({ fps, clock, deliver, ended, timeoutMs })` and `stop(timeoutMs)`. Its doc comment is the contract every source keeps:

- `availability` answers at once and sends nothing; a source that cannot capture says `available: false` with the reason, and its `start` answers `ok: false` with one too.
- Frames delivered before `start` resolves wait; capture counts as begun, and frames are recorded, only once it resolves `ok: true`.
- Each frame carries the source's identity, a timestamp from the run's clock in whole microseconds taken when the frame reached Retest, and bytes as the target encoded them. Its `observationId` is the parent's look id for that capture, as `RunningTest#serve` numbers looks, when the parent served the capture to the test file's process as a look, and none otherwise.
- `stop` resolves within its time whatever the target does, may be called before or during `start`, counts every frame that arrives before it resolves, and nothing is delivered after it.
- No frame between two times never means nothing appeared on the page: a source sends frames when it can, a screencast when Chrome chooses to, and some paints never arrive. This sentence is in the `CaptureMode` doc comment, where the recording work will read it.
- Stats: `mode`, `requestedFps`, `delivered`, `superseded`, `dropped`, `skippedTicks` for a loop, `startedAtUs` and `stoppedAtUs` on the run's clock, `achievedFps` over that whole time (at most one frame over that time above the request, since the first frame goes at once), first and last timestamps, `endedEarly`, and a few `problems`.

`recordSource(source, mediaProcess, options)` feeds one source into one recording:

- It refuses, by name and before anything starts, a `finishTimeoutMs` shorter than `deadlineMs`.
- It asks `availability` first and starts no recording for a source that cannot capture, or whose `availability` throws.
- It starts the recording with `MediaProcess.record`. Unless `limits.maxGapMs` is given, the gap a frame may be held for is the recording's whole `maxDurationMs` (30 minutes by default, the media process's own), so a still page is held for as long as it stood still rather than shortened to 10 s; a caller who sets a shorter gap gets it, and `ended.gaps` lists what was shortened.
- It starts the capture. A `start` or `stop` that throws at once, rejects, or does not answer in time is named and the recording is still finished; nothing throws out of `recordSource` and no abort listener is left behind.
- Each frame is checked before `Recording.frame` sends it: from the source's own session (test, attempt, app, session); whole microseconds from 0; on the recording's clock, meaning no later than the clock reads when the frame comes and no earlier than the moment capture was asked to start, which refuses a frame stamped on another clock however orderly its own timestamps are; not empty; at most `MAX_FRAME_BYTES`; never earlier than the frame before; within `maxDurationMs` of the first frame. `microsecondsSince` no longer clamps a reading before its start to 0: it is negative, and refused.
- Frames wait until the capture's start answers, at most 16; once it answers `ok: true` they go in order, and when it does not, none is sent, so an `unavailable` report never sits beside frames sent or a written video.
- It stops on its signal, when the source ends, or when the recording ends first; then finishes the recording with the last frame held until the moment capture stopped.
- The report is a frozen copy: `status` (`unavailable`, `not_started`, `ended` with the process's own `Ended`, or `lost`), `stoppedBy`, the start reply, the source's stats, and a tally in which every frame delivered while the recording took frames is counted once (`sent`, `dropped` by the client's full pipe, `notSent`, or refused by reason). A frame a source delivers after the report is returned, as after a stop that did not answer in time, is counted nowhere and changes nothing the caller holds; the report's problems say so.

Unit: 22 tests with a fake source and a fake media process.

Protocol version 1 carries a recording id and a timestamp per frame, no identity, so the identity is checked in `recordSource` and reported beside the process's reply, not sent. Carrying it into the protocol is the protocol version change [media.md](media.md) already names.

### What a native source must implement

Written in `FrameSource`'s doc comment, against what `src/native/session.ts` exposes today: a `screenshot-loop` over `NativeAppSession.capture(timeoutMs, { source, signal })`, named by the capture source it uses from the driver's `captureSources`, never presented as a live stream. A frame's `observationId` is the look id `RunningTest` gave that capture when it served it to the test file's process, or none; never the capture's `reference.observationId`, which the native session numbers for itself from `o1` for each session object, so joining on it beside `sessionId` would land on a different look. Its timestamp is when `capture` answered, on the run's clock. A capture takes its turn in the session's one request queue, so a tick that comes while the previous capture or an action still holds the session is counted in `skippedTicks`, never as a frame. A failed capture is counted in `dropped` with its failure among `problems`; a lost or disposed session ends capture through `ended`. The native lane builds it.

### The Chromium adapter

`src/browser/capture.ts`, `ChromiumFrameSource`, reached through `ChromiumPage.frameSource(identity, options)`: `Page.startScreencast` on the page's own DevTools session, so it captures that page alone.

A page supplies its own identity. `ChromiumPage.identify(session)` names the session a page is, as the runner holds it (`SessionIdentity`: its id and the run, test, attempt and app that hold it); an id that is not the attempt's and the app's, or a second, different identity, throws. `frameSource(identity)` compares the caller's identity with the page's own, and a page not yet named, or named as another session, gives a source that is unavailable and says which session the page is, so page A is never recorded as session B (Chrome: a page named `capture1:web` asked for `capture1:phone` is unavailable and `recordSource` starts no recording; a page never named records nothing). Nothing in the runner calls `identify` yet: `RunSession` builds each page's session identity, and the wiring that records runs calls it there.

The screencast was chosen over a `Page.captureScreenshot` loop. A probe on Google Chrome 154.0.8037.93 headless (`Browser.getVersion` in `/tmp/retest-identity-probe/screencast.log`; the script is under `/tmp/retest-identity-probe/`, outside the repository) showed: one frame 13 ms after the start; none more in 1.5 s on a still page; 20 frames while the page's background changed 20 times, 100 ms apart; none in the 0.5 s after `Page.stopScreencast`. That shows frames come while the page paints and none while it stands still. It does not show a frame for every paint: Chrome holds back the next frame until the last is acknowledged, and in the kept run below Chrome sent 51 frames for a page typed into every 100 ms while the adapter handed over 30 under a 10-a-second cadence. The doc comments and the guide say only what is known: frames arrive when Chrome chooses to send them, some paints are never delivered, and no frame between two times does not mean nothing appeared.

Every frame is acknowledged as it arrives, kept or not. Bytes come out of the protocol's base64 as Chrome encoded them, JPEG by default or PNG, and are never decoded. Each is stamped with the run's clock on arrival. At most one frame is handed over per `1/fps` of the run's clock: a frame that comes sooner waits, a newer one replaces it and the older is counted `superseded`, and the waiting frame is handed over when its turn comes or when capture stops. A waiting frame keeps the time it arrived, so two frames handed over one turn apart can carry timestamps closer than `1/fps`; the media process then shows the later on that tick and counts the other as superseded (4 of 30 in the kept run). Frames Chrome sends while the stop is on its way are still offered and counted, so every frame Chrome sends is counted once, delivered, superseded or dropped; the integration test asserts that equality against the frames counted on the wire. A stop waits for Chrome's answer only as long as it was given, by a timer of its own, so even a session that never answers cannot hold it. The session detaching ends capture with `endedEarly`; a blocked session or a gone page is `unavailable` by name. Unit: 13 tests with a fake session.

### The proof on real Chrome and the real media process

`tests/integration/capture-chromium.test.ts` uses `media/target/release/retest-media` (built 3 October 2026; no source is newer than the binary, so it was not rebuilt) with `/opt/homebrew/bin/ffmpeg` 9.0.2, and Chrome 154.0.8037.93 headless (the browser harness's line in each integration log) through the gated transport so the screencast is counted on the wire. Four tests, each leaving no media process, no encoder process group and no `.partial` file, with the browser's process group checked gone by the harness (Chrome, media):

1. Three seconds of the task app while a field is filled every 100 ms, recorded at 10 frames a second into 800 by 600. The kept run (`RETEST_CAPTURE_PROOF_OUT=~/Library/Caches/retest-proofs/identity`):
   - Chrome sent 51 frames, all counted: 30 handed over, 21 superseded, 0 dropped. Capture ran from 80 239 µs to 3 040 986 µs on the run's clock, 10.13 frames a second over that time. Every frame carries `{ testId: 'tests/integration/capture-chromium.test.ts > records', attemptId: 'capture1', app: 'web', sessionId: 'capture1:web' }`, starts with the JPEG marker `FF D8`, and timestamps never go back.
   - `recordSource` sent all 30: 0 dropped, 0 not sent, 0 refused.
   - The media process's start reply: 800 by 600, 10 frames a second, h264 through libx264, `maxGapMs` and `maxDurationMs` 1 800 000. Its `ended`: status `ok`, `frames` received 30, shown 26, superseded 4, dropped 0, out of order 0, out of range 0, undecodable 0, unprocessed 0, resized 30; `outputFrames` 30, `durationUs` 3 000 000. The test asserts the size, the cadence, frames in the video and a duration from this reply, and that the process received every frame sent.
   - `ffprobe -v error -count_frames -show_entries format=duration:stream=codec_name,width,height,nb_read_frames` on `chrome-screencast.mp4` printed one h264 stream, 800 by 600, 30 frames read, 3.0 s (`/tmp/retest-identity-ffprobe.log`). Nothing is claimed about how it looks, its size or how long anything took.
   - After `close`: no forced kill, `bye` with 0 stopped, the encoder's group and the media process gone, and Chrome sent no screencast frame while the page was typed into again for 0.5 s.
2. The media process closed mid-capture: the recording ended `stopped` with no video claimed, capture stopped because the recording ended first, every delivered frame was sent, Chrome sent no frame while the page kept painting afterwards, and the output folder was empty.
3. The page closed mid-capture: capture ended with `The page's session ended: the target detached.`, and the frames that came before were finished into a video, status `ok`.
4. A page recorded only as the session it was named, as above.

The process's counts added up in each (`received` is the sum of every count but `resized`), and so did the tally.

## The parent's command lanes

`RunningTest` keeps the test file's process's lanes in the parent. An action goes to an app only while no command and no AI check that captures that app runs there; a look (`observe`, `observePage`), or an AI check that captures the app, only while no action does. Looks and such checks may overlap, and two apps each take their own action at once. An AI check holds each app it captures, by its screenshot and recording evidence, the test's first app when it names none, as `test.evaluate` holds them in the test file's process, from when it arrives until its answer is sent; a check of text alone holds nothing. What is refused is answered with `concurrent_commands`, naming both pieces of work, with `details.running` and `details.next` as the child's own refusal has, and the failure goes on the parent's observed list, so the test fails whatever the process claims. A refused action is written as its own `action.failed` event, so `inspect` shows it at its line; a refused look has no event type of its own, and a refused AI check, like every AI check the parent refuses, is its answer and the test's failure. A command sent under the id of one still in flight is a protocol violation.

Unit (fake): an action during an action, a look during an action and an action during a look are refused and never reach the page, and the refused action is an `action.failed` event; an action during an AI check that captures its app is refused and goes once the check has answered; an AI check during an action on its app is refused before the judge is asked; looks overlap each other and an AI check, and a check of text alone holds nothing; two apps act at once; a duplicate in-flight id ends the test `test_error`; an assertion naming an app the test does not have ends it `test_error` and writes no assertion. Fake: a real test file process forging two clicks at once (`tests/support/files/forged-concurrent.retest.ts`) heard the first answered and the second refused, the page took one click, and the test ended `failed` with `concurrent_commands`. Chrome: a real test file process forging an AI check on a screenshot of its app, held for 1.5 s by the fake judge, then a click on that app (`tests/integration/command-lanes.test.ts`) had the click refused and written as `action.failed`, the check ran and passed, and the test ended `failed` with `concurrent_commands`, exit 1.

## Review findings and what showed each fixed

Each fix was reverted on its own with the rest in place, its test run, and the file put back (`/tmp/retest-identity-probe/mutate.py`, one log per line under `/tmp/retest-identity-probe/mutations/`).

| # | Finding | Fix | Reverted, its test |
| --- | --- | --- | --- |
| 1 | The native contract told a frame to carry the native session's own look id, which names a different look | The contract, the frame's and screenshot reference's doc comments and this record say the frame carries the parent's look id from `RunningTest#serve`, or none | documentation |
| 2 | "One frame per paint" was not shown, and the adapter superseded 21 of 51 frames | Reworded in `CaptureMode`, the adapter's doc comment, the guide and this record to what is known | documentation |
| 3 | The parent's lanes ignored `evaluate` | An AI check holds each app it captures; an action there is refused during it, and it is refused during an action | both directions fail `runner-command-lanes` (1 failure each) |
| 4 | Frames sent while a stop was on its way were acknowledged and not counted | Offered and counted until the stop answers; the integration check is now an equality with the wire count | `browser-capture` fails 1 |
| 5 | A synchronous throw from `start` or `stop` escaped `recordSource` | Every call into the source is guarded, the recording is finished, the abort listener removed | `media-capture` fails 1 |
| 6 | A still page was said to be held, but the media process shortened gaps over 10 s; the stats had no capture start or stop; the achieved cadence was first to last frame | Gap limit defaults to the recording's whole duration; `startedAtUs`, `stoppedAtUs`; cadence over the whole capture; the guide says what the video does on a still page | `media-capture` fails 1 |
| 7 | A frame on another clock was never refused, and a reading before the start became 0 | Frames are checked against the recording's clock (`clock` refusal); no clamp | each fails `media-capture` 1 |
| 8 | A start that timed out could still send frames, giving `unavailable` beside a written file; `finishTimeoutMs < deadlineMs` was allowed | Frames wait for the start's answer and are never sent when it fails; the short wait is refused by name | `media-capture` fails 1 for the first; the second hangs until the test runner cancels it after 60 s, because nothing refuses and nothing stops it |
| 9 | The report was the live tally | A frozen copy; deliveries after it are counted nowhere. The test that relied on the old behaviour was changed on purpose and says so in a comment | `media-capture` fails 1 |
| 10 | An assertion's session id came from an app the test may not have | Refused as a protocol violation | `runner-command-lanes` fails 1 |
| 11 | `frameSource` stamped frames with any identity | The page names its own session through `identify`, and a caller's identity that does not match gives an unavailable source | Chrome test fails 1 |
| 12 | A refused concurrent command left no event | A refused action is its `action.failed` event | `runner-command-lanes` fails 2 |
| 13 | The public `RecordIdentity` changed shape under its name | The old name keeps the old shape; the shared one is `SessionRecordIdentity` | a compile-time check in `protocol-identity.test.ts`, run by the typecheck |
| 14 | Weak tests | The after-close check types into the page first; the never-answering stop uses a session that never answers, and the adapter now bounds the stop itself; `m2-state` asserts `state.restored` names no session | reverting the stop's own bound hangs the new test until it is cancelled after 60 s |
| 15 | Facts in this record with no log behind them | Chrome's version now comes from `Browser.getVersion` and the harness's log line; the video's size, frames and duration from the process's reply, asserted, and from a logged ffprobe command; the Chrome ended after the flake is accounted for below | documentation |

### The Chrome this lane ended during the first integration run

The integration suite stopped growing its log during `tests/integration/diagnostics-collector.test.ts`, whose failed test left its browser running. `ps` showed the file's test process, 7371, as a child of 3087, the `node --test --test-concurrency=1 tests/integration/**/*.test.ts` process that this lane's `lockf … npm run test:integration` had started; 7371's arguments named `tests/integration/diagnostics-collector.test.ts`; and Chrome 7445 was a child of 7371 that led its own process group, with the profile folder `retest-profile-7371-…` that Retest names after the process that launched it. This lane sent SIGTERM to process group 7445 only. 7371 then exited and the suite went on. Two other node test processes running at the time, 3744 and 3747, were another session's (their arguments named native tests and a `/tmp/retest-native-…` folder, and their parent was not this lane's); they were left alone.

## Files

New: `src/protocol/identity.ts`, `src/media/capture.ts`, `src/browser/capture.ts`, `tests/unit/protocol-identity.test.ts`, `tests/unit/media-capture.test.ts`, `tests/unit/browser-capture.test.ts`, `tests/unit/runner-command-lanes.test.ts`, `tests/unit/store-rebuild-result.test.ts`, `tests/support/files/forged-concurrent.retest.ts`, `tests/integration/capture-chromium.test.ts`, `tests/integration/record-identity.test.ts`, `tests/integration/command-lanes.test.ts`, this record.

Changed: `src/protocol/events.ts`, `src/protocol/evidence.ts`, `src/protocol/result.ts`, `src/protocol/diagnostics.ts`, `src/protocol/evaluation.ts`, `src/protocol/index.ts`, `src/runner/running-test.ts`, `src/runner/observations.ts`, `src/runner/test-pages.ts`, `src/runner/run-host-checks.ts`, `src/store/run-store.ts`, `src/store/rebuild-result.ts`, `src/evaluation/evidence.ts`, `src/browser/page.ts` (`identify`, `frameSource` and a comparison helper only), `src/cli/inspect/test-timeline.ts` (the screenshot line only), `src/diagnostics/attempt.ts` and `src/diagnostics/session-capture.ts` (the identity type's new name only), `tests/unit/diagnostics-capture.test.ts` (the same), `tests/unit/runner-session-evidence.test.ts` (its exact screenshot entry now includes `capturedElapsedMs` and `source`), `tests/integration/m2-state.test.ts` (a state event's allowed keys include `sessionId`, the saved state's session is asserted, and a restored state's absence of one), `docs/guide.md` (a section after the run folder). No dependency, script or environment change.

## Verification

Run on 4 October 2026 on the founder's Mac, with other lanes' work landing in the same tree meanwhile.

| Command | Result | Log |
| --- | --- | --- |
| each of this lane's unit files alone, after the review fixes | protocol identity 9, media capture 22, Chromium source 13, command lanes 11, rebuild and run clock 7; and the existing files this lane touched, `runner-observations` 24, `protocol-entry` 8, `runner-session-evidence` 13, `diagnostics-capture` 18: all pass | `/tmp/retest-identity-probe/unit-final-*.log` |
| one revert per fix, as in the table above | 15 of the 16 logs record a failure: 12 a failing test, 2 a test the runner cancelled after it hung, and 1 (`13-public-name.log`) a compile error. The revert in `8-nothing-sent-after-a-failed-start.log` passed all 22 `media-capture` tests, so no test covered the cap on frames held before a start. That test was added in the review fix round: `media-capture` "at most sixteen frames wait for the capture's start…" fails with the cap removed and with it raised to 17 | `/tmp/retest-identity-probe/mutations/`, `/tmp/retest-identity-held/toggle-identity-8-no-cap.log`, `/tmp/retest-identity-held/toggle-identity-8-cap-17.log` |
| `npm run test:unit`, during the review fixes | 2371 tests, 2324 pass, 47 fail. Two failures were this lane's and are fixed: `protocol-entry.test.ts` allows only export lines in `src/protocol/index.ts`, where a comment had been added, and `runner-observations.test.ts` expected the judge's message for an assertion naming an app the test does not have, which is now refused before any look is judged. That case's expectation was changed to the new refusal, and the judge's own cross-app case is now covered with two apps the test has, in `runner-command-lanes.test.ts`. The other 45 were in `src/native/**` and `src/runner/resources.ts` work in progress (a module missing an export, `EROFS` from `resources.ts`). `native-desktop-lock.test.ts` hung for 16 minutes in this run and in another session's run at once; this lane ended its own run's process of that file and the two `lockf` lock holders it had started, and left the other session's alone | `/tmp/retest-identity-unit-4.log` |
| the same suite after the fixes, `node --conditions=retest-source --test --test-timeout=120000 "tests/unit/**/*.test.ts"` | 2457 tests, 2434 pass, 23 fail, all 23 in `native-desktop-lock`, `native-macos-app` and `native-ios-simulator`, the native lane's files; the first two hung with their `lockf` holders open after their tests, and this lane ended its own run's two processes of them and the holders they had started | `/tmp/retest-identity-unit-5.log` |
| `npm run test:types` | 208 expected errors matched on TypeScript 6.0.3 and 7.0.2 | `/tmp/retest-identity-types-3.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | clean on 6.0.3, 7.0.2 and the examples project, after the last source edit | `/tmp/retest-identity-typecheck-5.log` |
| the same typecheck's compiler with the published `RecordIdentity` pointed at the new shape | fails in `protocol-identity.test.ts`, as the compatibility check should | `/tmp/retest-identity-probe/mutations/13-public-name.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1` on `capture-chromium`, `record-identity`, `command-lanes` and `m2-state` | 9 of 9 pass | `/tmp/retest-identity-integration-2.log` |
| the full `npm run test:integration` before the review | 441 tests, 422 pass, 6 fail, 11 cancelled, 2 skipped; one failure was this lane's (`m2-state` listed a state event's exact keys), fixed; the others were other lanes' work in progress or a collector cleanup flake, and passed alone afterwards | `/tmp/retest-identity-integration-1.log`, `/tmp/retest-identity-int-*.log` |
| `node scripts/write-schemas.ts` | wrote both schemas | `/tmp/retest-identity-write-schemas-2.log` |

The kept proof is `~/Library/Caches/retest-proofs/identity/chrome-screencast.mp4`, with the full report, every frame's identity, timestamp and size included, in `chrome-screencast-report.json` beside it.

## Not shown

- Electron's screencast: an Electron window is a Chromium page session, but none was captured.
- No native source exists; its contract is written, against `NativeAppSession` as it stands, for the native lane.
- A JavaScript dialog makes the page's session refuse commands, acknowledgements included, which may stop Chrome's screencast until the dialog closes; the refusal is named in `problems`, but this was not exercised on real Chrome.
- Nothing in a run records yet: `recordSource`, `identify` and `frameSource` are reached from tests only. The runner reaching a page's frame source needs `frameSource` on the session contract (`src/browser/contract.ts`) and a call to `identify` where `RunSession` builds each page's session.
- `capturedElapsedMs` is read off the events, not handed from `RunSession`.
- `state.restored` names no session, since `RunSession` writes it.
- A frame's size is Chrome's, so the media process scaled every frame to the recording's 800 by 600 (`resized` 30); choosing `maxWidth` and `maxHeight` to match is left to the work that records runs.
- The older reader's refusal is reasoned from the schemas, not run.
- Linux: nothing here ran on Linux; the capture tests skip by name off macOS when the media binary or ffmpeg is missing.

## For other lanes

- Resources lane, `src/runner/run-session.ts`: call `page.identify(session)` on each Chromium page where its session identity is built; pass `elapsedMs: () => elapsedMs(this.#start)` in `#pagesContext` if the inferred clock is not wanted; write `sessionId: formatSessionId(attemptId, app)` on `state.restored`, and then drop the absence check in `tests/integration/m2-state.test.ts`.
- Session contract, `src/browser/contract.ts`: add `frameSource(identity)` to `WebSession` so the runner can reach a page's capture through `OwnedPage`.
- Media protocol: frames carry a recording id only; the identity `recordSource` checks travels in its report until the protocol carries it.
