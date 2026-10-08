# Rust frame-to-video path and the media process protocol: proof record

3 October 2026. Release 0.1.0, Phase 1 item 8 ([release-0.1.0.md](../release-0.1.0.md)), section 8 of [plan.md](../plan.md), and "Evidence and Rehearsal scope" in [releases.md](../releases.md). Revised the same day after a review that reported thirteen findings; [Review findings and what showed each fixed](#review-findings-and-what-showed-each-fixed) lists them. Revised again after a cross-lane review traced the cancellation paths and made ten claims; [Cross-lane review: ten claims about cancellation](#cross-lane-review-ten-claims-about-cancellation) says which held and what changed.

## Result

`retest-media`, a Rust process, turned 88 real Chrome screenshots of the task app, taken over three seconds while one key was typed on every tick, into a 3.0 second H.264 MP4 through the host's ffmpeg. Each of the 90 decoded video frames matches the one screenshot its timestamp maps to better than it matches every other screenshot whose pixels differ. With libx264 hidden, the same screenshots became a VP8 WebM that passes the same check. The proof also ran these failure cases, each ending in a reply that names what happened, with no process left behind:

- an encoder that is not ffmpeg
- ffmpeg killed mid-recording
- ffmpeg stopped behind a forking wrapper, then a missed finishing deadline
- a missed deadline
- the media process itself killed
- a shutdown with one recording running and another finishing

Every claim below was shown by a command whose output was read.

The process protocol is length-prefixed JSON headers with raw binary frame payloads, over standard input and output. Packaging is laid out as options with their costs at the end, without a decision.

## How to run it

From the Retest root, with Node 24.12 or later, Rust (image 0.25.10 declares 1.88 as its minimum; built here with 1.98.1), ffmpeg and Google Chrome:

```sh
cargo build --release --manifest-path media/Cargo.toml
cargo test --manifest-path media/Cargo.toml
cargo clippy --manifest-path media/Cargo.toml --all-targets -- -D warnings
node --conditions=retest-source --test "proofs/media/**/*.test.ts"
node --conditions=retest-source proofs/media/run.ts
node_modules/.bin/tsc -p proofs/media/tsconfig.json
node_modules/typescript-7/bin/tsc -p proofs/media/tsconfig.json
```

Environment variables:

- `RETEST_MEDIA_BINARY` names another media binary.
- `RETEST_FFMPEG` names another ffmpeg.
- `RETEST_TEST_BROWSER` names another Chrome.
- `RETEST_MEDIA_PROOF_OUT` names the artifact folder; the default is a new folder in the temporary directory.

The tests and the proof fail at once, naming the build command, when the binary is missing or older than its sources, and say when cargo is not on `PATH`. They name ffmpeg when it is missing. The root `tsconfig.json` covers `src/media/` but not `proofs/`, so `proofs/media/tsconfig.json` extends it unchanged.

## Files

| File | What it is |
| --- | --- |
| `media/Cargo.toml`, `media/Cargo.lock` | Package and binary `retest-media` 0.1.0, edition 2024, Apache-2.0; release profile with LTO, one codegen unit, stripped; Unix only |
| `media/src/main.rs` | Arguments (`--ffmpeg <path>`, `--version`), standard input and output, exit code |
| `media/src/protocol.rs` | Framing, every message type, limits; 9 unit tests |
| `media/src/server.rs` | Input reader thread, the loop that reaps recordings, start checks, output-path checks, recording limit, remembered endings, shutdown, background encoder probe; 3 unit tests |
| `media/src/recording.rs` | One recording: encoder process group, encoder thread, watchdog for deadline and stalls, `.partial` file and no-clobber link, the one `ended` reply. In debug builds only, `RETEST_MEDIA_TEST_PANIC` makes the encoder thread fail on its first frame, for one test |
| `media/src/queue.rs` | Bounded frame queue, oldest frame dropped first; 7 unit tests |
| `media/src/timeline.rs` | Timestamps to a constant frame rate, long gaps shortened, the end clipped; 8 unit tests |
| `media/src/frame.rs` | PNG and JPEG decoding, fit-and-centre resizing; 4 unit tests |
| `media/src/encoder.rs` | ffmpeg probe with bounded reads, route choice, arguments, process-group spawn and kill, bounded thread joins, a stderr tail that clips lines as they arrive; 8 unit tests |
| `media/src/replies.rs` | One reply at a time from any thread |
| `media/tests/process.rs` | 25 tests of the built binary with a fake encoder script |
| `src/media/protocol.ts` | Message types, reply schemas, framing, an incremental reply reader |
| `src/media/client.ts` | `MediaProcess` and `Recording`: spawn in its own process group, greeting, recordings with answer timeouts, frames, a bounded pipe, the process's limits checked before sending, close that waits for the encoders a dead process left, and a hold on Node only while a recording runs or a start is unanswered |
| `proofs/media/run.ts` | The proof |
| `proofs/media/client.test.ts` | 25 client tests against the built binary and real ffmpeg |
| `proofs/media/support.ts`, `png.ts` | Prerequisite checks, ffprobe, whole-video decoding, brightness comparison, pixel identity, `/usr/bin/time` parsing, process and group checks, frames until the encoder begins its file; a PNG reader and writer on `node:zlib` |
| `proofs/media/stubborn-process.ts` | A stand-in that greets and then misbehaves in one chosen way: never answers or exits; answers a start 300 ms late with a `sleep` as its encoder and never ends it; or closes its input and stays alive. Used only for the client's own handling of a forced stop, an answer timeout, a late answer, a broken pipe and a version check |
| `proofs/media/recording-child.ts` | A process that records through the client as a test run would, for the tests of a signal ending it mid-recording and of a forgotten `close` |
| `proofs/media/tsconfig.json` | Typecheck config for the proof files |

The TypeScript client imports Retest's schema builder and `describeExit`, and nothing from the browser layer. The proof imports `launchBrowser`, the task-app fixture and the test browser path. Nothing under `src/` outside `src/media/` was edited.

## Environment

| Fact | Value | Shown by |
| --- | --- | --- |
| System | macOS, Darwin 27.0.0, arm64 | `uname` |
| Node.js | 24.12.0 | `node --version` |
| Rust | rustc and cargo 1.98.1 from Homebrew, first on `PATH`. rustup's default toolchain here is 1.81.0 and cannot build the crate: Cargo 1.81 stops with "feature `edition2024` is required". image 0.25.10 declares Rust 1.88 as its minimum | `rustc --version`, `~/.cargo/bin/cargo build --release --target-dir /tmp/retest-media-rust181` |
| ffmpeg | 9.0.2, Homebrew, `/opt/homebrew/bin/ffmpeg` | `ffmpeg -version` |
| Browser | Google Chrome 154.0.8037.93, headless | the proof's summary |

## The protocol, version 1

### Framing

Every message in both directions is:

```text
[header length: u32 big-endian][payload length: u32 big-endian][header: UTF-8 JSON object][payload: bytes]
```

Only a `frame` has a payload: the PNG or JPEG bytes exactly as the capture produced them, never base64. A frame's byte length is the prefix's payload length, so a header that cannot be parsed costs that one message and never the stream's framing. Headers are at most 64 KiB and payloads at most 64 MiB.

- A longer prefix, or a stream that ends inside a message, is a protocol violation. The process replies `error` with `protocol_violation`, ends every recording and exits with code 2.
- A header that is not a valid request gets `error` with `invalid_message`, and the process reads the next message. The reply carries the header's `recordingId` whenever it names one, even when the rest of the header is unreadable, so a client waiting on that recording hears the refusal.
- Unknown header fields are refused on every message.

### Client to process

| Message | Fields | What the process does |
| --- | --- | --- |
| `start` | `recordingId`, `width`, `height`, `fps`, `output`, `deadlineMs`, and optionally `queueFrames` (default 60), `queueBytes` (64 MiB), `maxGapMs` (10 000), `maxDurationMs` (1 800 000), `stallMs` (10 000) | Checks the request, picks a route from the encoder probe, starts one ffmpeg for the recording and replies `started`. It replies `ended` instead when the encoder cannot record, and `error` for a bad request. See the start rules below the table |
| `frame` + bytes | `recordingId`, `timestampUs` (whole microseconds on any monotonic clock the client keeps), `format` (`png` or `jpeg`) | Counts the frame. It refuses the frame as out of order when its timestamp is earlier than the last, and as out of range when it is more than `maxDurationMs` after the recording's first frame; otherwise it queues it. Frames for a recording that is finishing or has ended are ignored without reply; frames for an id never started get `error` with `unknown_recording` |
| `finish` | `recordingId`, optional `endTimestampUs` | Takes every queued frame and holds the last one until `endTimestampUs`, moved back to at most `maxGapMs` after the last frame and `maxDurationMs` after the first. Then it closes ffmpeg's input and waits for the container, all within `deadlineMs` of this message, and replies `ended` |
| `shutdown` | none | Ends every unfinished recording `stopped` and lets every finishing recording complete within its deadline. Then it replies `bye` and exits 0. Standard input ending between messages does the same |

Start rules:

- `output` is an absolute path without an extension; the process adds `.mp4` or `.webm`.
- Width and height must be even, from 2 to 8192, as 4:2:0 video needs. `fps` is 1 to 120, `deadlineMs` 1 to 600 000, `maxDurationMs` up to 4 hours, `maxGapMs` at most `maxDurationMs`, `stallMs` 100 to 600 000.
- A file already at the video path or at its `.partial`, or a running recording writing that path, refuses the start with `error` `output_in_use`, naming the path or the recording.
- At most 16 recordings run at once; another is refused with `too_many_recordings`.

### Process to client

| Message | Fields |
| --- | --- |
| `hello` | `protocol` (1), `version` (crate version, `0.1.0`), `target` (`macos-aarch64`), `ffmpeg` (the encoder path as given). Sent as soon as the process runs |
| `started` | `recordingId`, `codec` (`h264` or `vp8`), `container` (`mp4` or `webm`), `encoder` (`libx264` or `libvpx`), `encoderVersion`, `encoderPid` (also the encoder's process group, which every stop signals), `path`, `width`, `height`, `fps`, and the effective `queueFrames`, `queueBytes`, `maxGapMs`, `maxDurationMs`, `stallMs`. Always sent before the same recording's `ended` |
| `ended` | Exactly one per recording, whether or not the client finished it. Fields are listed below the table |
| `error` | `code`: `invalid_message`, `invalid_start`, `unknown_recording`, `duplicate_recording`, `output_in_use`, `too_many_recordings`, `protocol_violation`; optional `recordingId`; `message` |
| `bye` | `stopped`: recordings the shutdown ended. The last message |

`ended` carries:

- `recordingId`, `status`, `message`.
- `path`, only when `ok`; `partialPath`, only when `output_failed` kept the video.
- `frames`, `outputFrames`, `durationUs`, `bytesReceived`, `bytesToEncoder`.
- `firstTimestampUs`, `framesBeforeFirst`, `gaps`, `gapsShortened`, `endClipped`.
- `encoder` (`exitCode`, `signal` and the last 20 `stderr` lines) when the encoder ran and failed or was stopped.
- `finalizeMs` after a finish.

`status` is one of:

| Status | Meaning |
| --- | --- |
| `ok` | The container is written and at `path` |
| `no_frames` | No frame could be shown, so there is no video |
| `encoder_unavailable` | The encoder runs but lacks a complete route; the message names what is missing |
| `encoder_failed` | The encoder could not start, did not answer as ffmpeg, exited without writing the video, or took longer than `stallMs` to accept a frame and was stopped |
| `deadline_exceeded` | Finishing outlasted `deadlineMs`; the encoder's group was killed |
| `stopped` | Shutdown, or the input ending, came before the recording was finished |
| `output_failed` | The encoder exited 0 but its file was missing or empty, or could not be linked into place; a finished video is kept at `partialPath` |

`frames` counts:

- `received`
- `shown`: written to the encoder, and in the video when the recording ends `ok`
- `superseded`: replaced by a later frame on the same tick
- `dropped`: let go by the full queue
- `outOfOrder`
- `outOfRange`
- `undecodable`
- `unprocessed`: still waiting when the recording ended early
- `resized`

`received` is the sum of every count except `resized`. Every `ended` in the tests and the proof was checked against that sum.

Video time maps back to the capture clock. The video starts at the capture timestamp `firstTimestampUs`. A frame captured at `t` appears at `t - firstTimestampUs`, less the `shortenedByUs` of every gap up to it, rounded to the nearest frame interval. `gaps` lists the first 64 shortened gaps as `{ captureUs, shortenedByUs }`, and `gapsShortened` counts them all. `framesBeforeFirst` counts frames received before the first one in the video that are not in it, dropped by the queue or undecodable. Phase 4 has to carry this mapping into the report, so that a video moment names the capture moment and step it shows.

### Behaviour behind the messages

- **Timing.** Time zero is the first decodable frame's timestamp. A frame's tick is its timestamp rounded to the nearest frame interval. Each frame stays on screen until the next frame's tick, as Playwright's recorder does. When two frames fall on one tick, the later one is shown.
- **Gaps and range.** A pause longer than `maxGapMs` is shortened to it in the video and reported, so a long wait, or a frame stamped on another clock, cannot make the process write a held frame thousands of times. A frame more than `maxDurationMs` after the recording's first frame is refused, and the encoder is never sent more than one recording's maximum duration of frames.
- **Queue.** Each recording has one bounded queue, by frame count and bytes, and the input reader never waits for an encoder. When the queue is full, the oldest queued frame is dropped and counted, so the end of a recording, where a test failed, is kept. A single frame larger than `queueBytes` is dropped itself. The client also bounds its pipe: a frame sent while more than `maxPendingBytes` (default 32 MiB) waits unwritten is dropped in the client and counted in `traffic.framesDropped`.
- **Input.** Standard input is read on its own thread into a channel of 16 messages. The loop wakes at least every 50 ms, so a recording that ended, or whose thread failed, is reported without waiting for the client's next message. One exception: the first `start` waits on the loop for the background probe, so an ffmpeg that hangs on `-encoders` or `-formats` holds the loop, and every message behind that start, until the probe gives up on it: 10 s per listing plus 2 s for each of its two readers, 28 s at most for the two listings. Nothing can be recording yet when that happens.
- **Decoding.** The process decodes each frame once with the `image` crate and writes raw RGB to ffmpeg (`-f rawvideo -pix_fmt rgb24`). A frame of another size is scaled to fit with its proportions kept and centred on black.
- **Output.** ffmpeg writes `<path>.partial` with `-n`, so it never overwrites. Only an exit of 0 with a non-empty file links it to `<path>`, with a hard link, which fails rather than replace anything; the `.partial` is then removed. Starts are refused while either path exists. A file at `path` is therefore that recording's finished container. A link that fails keeps the `.partial` and names it.
- **Process groups.** Each ffmpeg leads a process group of its own. A deadline, a stall, a shutdown or a failed recording kills the whole group, so a wrapper script and the real ffmpeg behind it both go. After the encoder exits, the group is killed once more, to reach anything it left running, and the recording is marked done at that moment, so neither the watchdog nor a shutdown signals the group again while the encoder's stderr reader is joined, for at most one second. See [Not shown](#not-shown-and-what-phase-4-still-needs) for what a group id can mean once its last member is gone.
- **Watchdog.** One watchdog thread per recording, for its whole life. It kills the encoder's group when finishing outlasts `deadlineMs`, or when a single frame write has waited longer than `stallMs`.
- **Encoder failure.** An encoder that dies is noticed by the next failed write, or within 100 ms while idle, and the recording ends `encoder_failed` at once, without waiting for `finish`.
- **Shutdown.** Unfinished recordings are stopped. Finishing ones complete within their deadline, so `finish` followed at once by `close()` still yields the video.
- **The client.** The client starts the process as the leader of a new process group. `record(start, timeoutMs)` and `finish(timeoutMs, endTimestampUs?)` reject when no answer comes in time. A start answered after its timeout is kept as a recording the client finishes at once, so its encoder is known and stopped like any other if the process then dies; a second start with that id is refused until the process ends it. Requests and frames after `close()` begins, after the process ended, or after the pipe to it broke are refused: `not_sent` for frames, a rejection for starts that says which. A frame reported `sent` was handed to the pipe; one still in the pipe when the process dies is lost, and the process's own `received` count is the record of what reached it. What the process could not read, or would end over, is refused before sending with `RangeError`: a fractional frame rate, a fractional or negative timestamp, an empty id or one over 200 characters, a frame over 64 MiB. The errors the process sends for no waiting request are kept to the newest 64.

  **Lifecycle.** The process holds Node open only while a recording runs or a start is unanswered; `record`, `finish` and `close` hold it while they wait. A `close` forgotten on an idle process does not keep Node alive. When Node exits, however it exits, the media process reads the end of its input and shuts itself down. Every running recording ends `stopped`, its encoder group is killed and its `.partial` removed, then `bye`. A signal that ends Node does the same, because the media process and each encoder are in groups of their own and a terminal's signal does not reach them. There is no exit hook. The end of the input is the hook, and it is the same path a `shutdown` takes.

  If the media process dies, every waiting start rejects with how it ended. Every running recording's encoder gets one second to finish its file, since its input has closed. Then, if anything is left in its process group, the group is killed and waited for: a wrapper whose leader exited while a child lingers is reached too. An empty group is not signalled, since its id could by then name a process that is not ours. The recording rejects with `MediaRecordingLostError`, naming the `.partial` it left, if any, and saying whether the encoder exited on its own, its group was killed, or both. The file is kept for the caller to judge. A `close` that has to kill the process waits for these reclaims before it returns, so nothing of the process outlives the call. The client never makes up an `ended`.
- **Bounds.** The process keeps:
  - at most 16 running recordings, each with a queue of at most 10 000 frames and 1 GiB, 60 frames and 64 MiB unless the start asks for more;
  - 16 messages read ahead of the loop, each up to 64 MiB of frame bytes;
  - one decoded frame per encoder thread, up to 8192 by 8192 pixels, plus the decoder's own buffers;
  - the last 4096 ended ids; a late frame for a forgotten one gets `unknown_recording`;
  - 20 stderr lines of at most 300 characters each, clipped as they arrive;
  - 1 MiB of each probe listing; the rest is read and discarded.

  Added up at the limits, one client can have the process hold about 26 GiB: 16 queues of 1 GiB, 16 read-ahead frames of 64 MiB, and the decode buffers. The defaults are 60 frames and 64 MiB a queue, and a client that asks for more is asking for the memory. The client keeps 32 MiB of unwritten frames in its pipe and 64 errors; nothing else of it grows with traffic.
- **Probe.** At startup a background thread runs `ffmpeg -encoders` (its banner gives the version) and `ffmpeg -hide_banner -formats`, each in its own process group with a 10 second limit. A route needs the `rawvideo` demuxer, plus libx264 with the mp4 muxer or libvpx with the webm muxer.

## Encoder choice and ffmpeg's license on this machine

| Fact | Value | Shown by |
| --- | --- | --- |
| Configuration | `--enable-gpl --enable-version3 ... --enable-libx264 ... --enable-libvpx --enable-libx265 --enable-videotoolbox`, shared libraries | `ffmpeg -version` |
| License | GNU GPL version 3 or later | `ffmpeg -L` |
| Encoders present | `libx264`, `libx264rgb`, `h264_videotoolbox`, `libvpx`, `libvpx-vp9` | `ffmpeg -encoders` |
| Formats used | `rawvideo` demux, `mp4` mux, `webm` mux | `ffmpeg -formats` |
| Route chosen | H.264 in MP4: `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -f mp4` | `started.codec` in the proof |
| VP8 route | Playwright's settings: `-c:v libvpx -qmin 0 -qmax 50 -crf 8 -deadline realtime -speed 8 -b:v 1M -threads 1 -pix_fmt yuv420p -f webm` | the VP8 step of the proof |
| Installed size | 52 MB in the Homebrew cellar, 14 formula dependencies (x264, x265, libvpx, svt-av1, dav1d and others) | `du -sh`, `brew deps ffmpeg` |

`retest-media` does not link ffmpeg; it runs the host's ffmpeg as a separate program. Nothing in this proof ships ffmpeg.

## Crates and licenses

All from crates.io, pinned in `media/Cargo.lock`. Shown by `cargo tree -e normal --format "{p} | {l}"`.

| Crate | Version | License | Role |
| --- | --- | --- | --- |
| image | 0.25.10 | MIT OR Apache-2.0 | Decoding and resizing; features `png` and `jpeg` only |
| libc | 0.2.190 | MIT OR Apache-2.0 | `kill(2)` on a process group, the one call std does not offer; one `unsafe` block in `encoder.rs` |
| png | 0.18.1 | MIT OR Apache-2.0 | PNG codec under `image` |
| zune-jpeg, zune-core | 0.5.15, 0.5.3 | MIT OR Apache-2.0 OR Zlib | JPEG decoder under `image` |
| moxcms, pxfm | 0.8.1, 0.1.30 | BSD-3-Clause OR Apache-2.0 | Colour profiles under `image` |
| fdeflate, flate2, miniz_oxide (0.8.9 and 0.9.1), adler2, simd-adler32, crc32fast | 0.3.7, 1.1.10, -, 2.0.1, 0.3.10, 1.5.2 | MIT OR Apache-2.0, with Zlib or 0BSD options; simd-adler32 MIT | Deflate and checksums under `png` |
| bytemuck, byteorder-lite, num-traits, bitflags, cfg-if | 1.25.2, 0.1.0, 0.2.19, 2.13.2, 1.0.5 | Zlib OR Apache-2.0 OR MIT; Unlicense OR MIT; MIT OR Apache-2.0 (last three) | Support crates under `image` |
| serde, serde_core | 1.0.229 | MIT OR Apache-2.0 | Message types |
| serde_json, itoa, memchr, zmij | 1.0.151, 1.0.18, 2.8.3, 1.0.23 | MIT OR Apache-2.0; MIT OR Apache-2.0; Unlicense OR MIT; MIT | JSON |
| serde_derive, syn, quote, proc-macro2, unicode-ident | 1.0.229, 3.0.6, 1.0.47, 1.0.107, 1.0.26 | MIT OR Apache-2.0; unicode-ident also Unicode-3.0 | Build time only (derive macro) |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | Build time only (num-traits build script) |

No npm dependency was added. The test fakes need nothing beyond `sh`, `cat`, `head`, `sleep` and `pgrep`.

## What was shown

### `cargo test`: 39 unit tests, 25 process tests

Log `/tmp/retest-media-cargo-test.log`, and `/tmp/retest-fable-media-cargo.log` after the cross-lane revision: `test result: ok. 39 passed` and `test result: ok. 25 passed`.

**Framing and messages.**
- Frames round trip with their bytes untouched.
- A message split into 1, 3 or 7 byte reads is read whole.
- An end inside a message is truncation; an end between messages is a close.
- Lengths over the limits are refused before reading.
- A bad header costs one message, and the next one reads.
- Payloads are allowed only on frames.
- Unknown types are refused, and unknown fields on `start`, `finish` and `shutdown`. The `shutdown` case failed first, since a field-less message accepted any field, and was fixed.
- A refusal names the recording its header names.

**Queue.** A full queue drops the oldest frame. The byte limit holds with the count. A frame larger than the byte limit is dropped itself. Finishing hands over queued frames first. Closing counts what was left. An idle wait wakes for a frame.

**Timeline.**
- Frames hold until the next one, and the later of two frames on one tick is shown.
- The last frame holds until the end timestamp.
- A five-second pause on a one-second maximum is shortened by four seconds.
- A wall-clock timestamp holds the last frame for the maximum gap only.
- The end is clipped.
- 90 frames a thirtieth apart make 90 ticks.

**Probe and routes.**
- Encoder and format listings are read by column; the legend and audio encoders are excluded.
- H.264 is chosen before VP8.
- A codec without its muxer, or without raw input, is no route.
- A line with no end, 10 MiB long, is kept as one 300-character line.

**The built binary.** These run against a fake encoder that copies the raw frames it is sent into the output file, so a test reads exactly which pixels were written and in what order. Earlier cases (still passing):
- Frames at 1.0, 1.1 and 1.4 s, ending at 1.6 s, at 10 fps give red, then green three times, then a double-size blue frame scaled down, twice.
- Late and unreadable frames are counted, not shown.
- VP8 in WebM is chosen without libx264, and when libx264 lacks its mp4 muxer.
- `encoder_unavailable` without either codec, and without the rawvideo demuxer.
- A program that is not ffmpeg ends `encoder_failed`, with exit code 1 and its stderr line.
- A missing encoder fails to start.
- An encoder that exits 3 mid-recording ends the recording at once.
- Finishing past a 200 ms deadline ends `deadline_exceeded`.
- Shutdown with two recordings running ends both `stopped`.
- Standard input ending shuts the process down.
- Bad messages get their error codes, and an oversized prefix ends the process with code 2.
- A queue of two with a slow encoder drops at least 10 of 20 frames.

Added in the revision:
- A fake behind a forking shell wrapper, its child stopped with SIGSTOP, finishing with a 300 ms deadline, ends `deadline_exceeded` within 3 s. The stopped grandchild and the whole group are gone, and `bye` follows.
- Shutdown behind the same wrapper leaves no group member.
- A file already at the video path, a leftover `.partial`, and a second recording on a running recording's path are each refused `output_in_use`, with the path or the recording named. The existing file is untouched.
- A file that appears at the path during a recording ends it `output_failed`, with the other file untouched and the 24-byte video kept at the named `partialPath`.
- A start with `fps: 29.97`, and a frame with `timestampUs: 1.5`, are refused `invalid_message` with their `recordingId`.
- A wall-clock frame is refused `outOfRange`. A five-second pause on a one-second maximum is listed in `gaps`. `firstTimestampUs` and `framesBeforeFirst` are right after an undecodable first frame. A 600-second end is clipped. The written file is red for ten frames, then green for ten.
- An encoder that reads nothing, sent 230 kB frames with `stallMs: 300`, is stopped as stalled within 3 s, before any finish.
- With `RETEST_MEDIA_TEST_PANIC` set, the recording whose thread panicked ends within 2 s without another message, and its encoder group is gone.
- `finish` followed at once by `shutdown` ends `ok`, with `bye` `stopped: 0`.
- The 17th concurrent recording is refused `too_many_recordings`.

`cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` pass (logs `/tmp/retest-media-clippy.log`, `/tmp/retest-media-fmt.log`; clippy again after the cross-lane revision in `/tmp/retest-fable-media-clippy.log`).

### Client tests: 25 of 25

Run with `node --conditions=retest-source --test "proofs/media/**/*.test.ts"` (log `/tmp/retest-fable-media-client.log`), against the release binary and real ffmpeg except where a stand-in is named.

Where a test breaks something mid-recording, it first sends frames until the recording's `.partial` appears, which is ffmpeg writing its container header and so proof that frames reached it; with x264 that takes as many frames as its lookahead holds, about 20 ms here. No test sleeps to let frames arrive. The two cases that say the encoder "exited on its own" still rest on ffmpeg finishing a tiny file inside the client's one-second grace, which is a fixed choice.

- The greeting has protocol 1 and version 0.1.0; `close` exits 0 with `bye`.
- Three timestamped PNG frames become an 8-frame, 0.8 s H.264 video whose decoded frames 1, 3 and 6 are red, green and blue.
- `/bin/cat` as the encoder ends the recording `encoder_failed` with exit code 1.
- A missing binary rejects; an odd width rejects with `invalid_start`.
- Frames after `finish` are refused in the client, and two finishes give one ending.
- ffmpeg killed with SIGKILL once it has begun its file ends the recording before `finish`, with signal 9, and the file it had begun is removed.
- The media process killed alone leaves the recording rejected with `MediaRecordingLostError`. The message says the encoder exited on its own, and it names the `.partial` ffmpeg finished; the encoder and its group are gone.
- The media process killed while its encoder never exits leaves the recording rejected naming the encoder group the client killed, and the group is gone before the rejection. The encoder is a wrapper that runs ffmpeg and then sleeps 30 s, and the `.partial` ffmpeg finished is named. A stopped ffmpeg cannot model this: when its parent died, the kernel sent the orphaned stopped group SIGHUP and it died at once, which the first version of this test showed by finding the encoder "exited on its own" with no file.
- The media process killed while its encoder is a wrapper that leaves a `sleep` in its group and then becomes ffmpeg: the leader exits on its own, and the message says so and that the group was killed; the `sleep` and the group are gone.
- A forced close: the media process is stopped with SIGSTOP, so `close(300)` kills it. Before `close` returns, the recording is rejected naming the encoder group the client killed and the `.partial` ffmpeg finished, and the encoder, behind the lingering wrapper, is gone. The `.partial` is kept.
- A start and a finish sent to a stopped process, which is then killed: the start rejects "ended with signal SIGKILL" and the finish rejects with `MediaRecordingLostError`.
- After `close()` begins, a frame is `not_sent` and the process received only the earlier one; a start rejects "closing". The recording ends `stopped`, its encoder group is gone and no `.partial` is left. After exit, a start rejects "has ended with exit code 0".
- A child Node process recording through the client is sent SIGTERM mid-recording. The media process, the encoder and its group, and the `.partial` are all gone within the test's wait, with no code of the client involved after the signal.
- A child Node process that records, finishes `ok` and returns without `close()` exits on its own with code 0, and the media process goes with it.
- The stand-in answers a start 300 ms after the client gave up on it at 50 ms, with a `sleep` as the encoder. A second start with the id is refused "already started", and when the stand-in is killed the `sleep` is gone within 2.5 s.
- The stand-in closes its input and stays alive. The first frame is `sent`, since nothing can know yet; after the write fails the next frame is `not_sent`, one frame is counted, and a start rejects naming the broken pipe with `EPIPE`.
- A 201-character id and a 70 000-character id are refused with `RangeError` before anything is written; a 200-character id of two-byte characters starts. A frame of 64 MiB plus one byte throws `RangeError` from both `Recording.frame` and `sendFrame`, and the recording goes on to end `ok`.
- 70 frames for unknown ids bring 70 `unknown_recording` errors, of which the newest 64 are kept.
- A start with `fps: 29.97`, a frame with `timestampUs: 1.5` and a finish with `-1` are refused with `RangeError` before anything is sent.
- A start the stand-in never answers rejects after 200 ms. A finish on a recording whose ffmpeg is stopped rejects after 200 ms, and its `ended` arrives later, `deadline_exceeded`.
- A second recording on the first one's output is refused `output_in_use`, naming recording `r`.
- 40 frames of about 786 kB sent in one go, with a 1 MiB pipe bound, are partly dropped in the client, and the process read exactly the frames that were sent.
- The stand-in is killed by `close(300)` with SIGKILL, and one greeting with protocol 2 is refused.

Of the nine tests added in the cross-lane revision, seven fail against the client as it was before it (log `/tmp/retest-fable-media-client-before.log`: the forked child was left running, `close` returned before the rejection, the forgetful child was still running after 5 s, the late start's `sleep` outlived the stand-in, `sent` after the pipe broke, the long id reached the process, 70 errors kept). The signal test and the pending start and finish test pass against both: they show what the record claimed and no test had tried.

### The proof: `node --conditions=retest-source proofs/media/run.ts`

Final run of the lane: log `/tmp/retest-media-proof-run.log`, summary `/tmp/retest-media-proof/summary.json`, exit 0. The steps and measurements below are from that run. The proof was run again after the cross-lane revision and passed every check, with nothing left behind: log `/tmp/retest-fable-media-proof.log`, which names its summary.

1. **Live recording.** Chrome launched through `src/browser/launch.ts`, headless, with an 800 by 600 viewport, on the task app's `/`.
   - For three seconds a screenshot was asked for on every tick of 1/30 s, at most two at once, while one key per tick was typed into the title field through Retest's `press`. Each frame was stamped when it was asked for and streamed in that order. The media process ran under `/usr/bin/time`, and its ffmpeg behind a `/usr/bin/time` wrapper that forks it.
   - 88 screenshots were sent; two ticks were skipped because two screenshots were still in flight. 90 keys were typed.
   - Density was asserted: at least 80 screenshots, the first at time zero, no pause longer than three ticks. The largest pause was 74.6 ms and the last screenshot came at 2967 ms.
   - `finish(30 000, 3 000 000)` ended `ok` in 13 ms. 88 received, 88 shown, nothing superseded, dropped, refused or out of order. `firstTimestampUs` equals the first screenshot's timestamp.
2. **The artifact, by ffprobe with `-count_frames`.** `mov,mp4,m4a,3gp,3g2,mj2`, `h264`, 800 by 600, `yuv420p`, 30/1, 3.000 s, 90 frames decoded, 18,296 bytes. The frame count and duration hold by construction, because the end timestamp sets how many frames are written. They show the container is whole and holds what was written; that the video keeps the capture's timing is what step 3 shows.
3. **Every frame against its own screenshot.**
   - **Method.** All 90 frames were decoded to PNG in one ffmpeg call. The area where any screenshot differs from the first is the title field, 320 by 54 pixels at (40, 179), found from the screenshots themselves. Inside it, each decoded frame was compared with every screenshot, counting pixels whose brightness differs by more than 48 of 255. Brightness is used because 4:2:0 video keeps colour per 2 by 2 block, and the field's blue focus ring smears in colour while text keeps its shape. The screenshot a frame should show is the last one whose tick is at or before it.
   - **Assertion.** That screenshot must match the frame better than every screenshot that differs from it in any pixel.
   - **What it resolves.** Each frame is pinned to one screenshot, up to screenshots with identical pixels, which no comparison could tell apart. 3 of the 90 frames had such a twin, at most one tick away; every other frame was told apart from its neighbours one tick either side.
   - **Margins.** The right screenshot differed from its frame by at most 5 pixels; any other screenshot by at least 29.

   | Video frame | Time | Screenshot it should show | Keys typed by then | Differs from it | Differs from the nearest other |
   | --- | --- | --- | --- | --- | --- |
   | 0 | 0.000 s | 0, taken at 0.000 s | 0 to 1 | 0 | 739 |
   | 15 | 0.500 s | 13, at 0.500 s | 15 to 17 | 0 | 49 |
   | 45 | 1.500 s | 43, at 1.500 s | 45 to 47 | 0 | 50 |
   | 75 | 2.500 s | 73, at 2.501 s | 75 to 76 | 0 | 1410 |
   | 89 | 2.967 s | 87, at 2.967 s | 89 to 90 | 3 | 504 |

   "15 to 17" means key presses overlapped that screenshot. Decoded frames are in `h264-frames/` in the artifact folder, and the sampled screenshots are `h264-screenshot-N.png`.
4. **VP8.** The same 88 screenshots, with their timestamps, were replayed into a process whose ffmpeg is the real one with `libx264` filtered out of its encoder list (`ffmpeg-without-libx264.sh`). `started` named `vp8`, `webm`, `libvpx`; `ended` was `ok`, finalized in 159 ms. ffprobe read `matroska,webm`, `vp8`, 3.000 s, 90 frames, 63,218 bytes. All 90 frames passed the same check: at most 12 differing pixels for the right screenshot, at least 29 for any other. This step is a replay, not a live capture.
5. **An encoder that is not ffmpeg:** `--ffmpeg /bin/cat`. `ended`: `encoder_failed`, "/bin/cat did not answer as ffmpeg: asking for its encoders ended with exit code 1", `exitCode` 1, with stderr `/bin/cat: illegal option -- c` and `usage: cat [-belnstuv] [file ...]`. `close` exited 0 with `bye`.
6. **ffmpeg killed mid-recording.** A live capture of 1.5 s; at 767.1 ms the proof sent SIGKILL to `encoderPid`. `ended` arrived 10.7 ms later, before `finish`: `encoder_failed`, signal 9, 23 received, 21 shown, 2 unprocessed. The 22 frames captured after it were refused in the client, and `finish()` returned the same `ended`. No file is left. Across six runs the reply came 9.5 to 18.6 ms after the kill.
7. **ffmpeg stopped behind a forking wrapper.** The wrapper is `'<ffmpeg>' "$@"`, without `exec`, so `encoderPid` is the shell (pid 321) and ffmpeg is its child (336). The proof stopped ffmpeg with SIGSTOP and finished with `deadlineMs: 300`. `ended` arrived 321.9 ms after the finish: `deadline_exceeded`, the shell's signal 9, 50 shown and 38 unprocessed. The encoder's group was empty and ffmpeg gone when `ended` arrived, and `close` exited 0 with `bye`. The reviewer's run of the same setup against the earlier code got no `ended` and no `bye`.
8. **Deadline.** The 88 screenshots were replayed at once into a recording with `deadlineMs: 50`, then `finish`. `ended` came after 83 ms (60 to 83 ms across six runs): `deadline_exceeded`, signal 9, 80 shown and 8 unprocessed. No file is left.
9. **The media process killed on its own.** The 88 screenshots were replayed without a finish, then, once the recording's `.partial` existed, the media process alone got SIGKILL. The recording rejected with `MediaRecordingLostError`: "the media process ended with signal SIGKILL; recording orphaned did not end: its encoder exited on its own, and it left …/recording-orphaned.mp4.partial". ffprobe reads that `.partial` as a 2.97 s H.264 video of 89 frames, which ffmpeg wrote when its input ended. The encoder and its group are gone.
10. **Shutdown with a recording running:** 10 frames, then `close`. `ended`: `stopped`, 10 received, 10 unprocessed; `bye` with `stopped: 1`; exit 0.
11. **Close while finishing:** all screenshots, then `finish` and at once `close()`, without waiting. `ended`: `ok`, 90 output frames, which ffprobe decodes; `bye` with `stopped: 0`. The review found the earlier code ended this `stopped`.
12. **Nothing left.** None of the 20 media process ids or 19 encoder ids is alive. Every encoder group and Chrome's process group are empty. Every `close` in the proof checks exit 0, no signal, no forced kill, and that the media process's own group, which never holds an encoder, is empty; the encoder groups are checked here, at the end.

### Playwright's ffmpeg build

Playwright's own ffmpeg is cached on this machine at `~/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac`. It is 2,580,312 bytes, static (links only system libraries and frameworks), version `n7.0.1-playwright-build-1011`, LGPL 2.1 or later. It is configured with `--disable-everything` plus the `image2pipe` demuxer, the mjpeg decoder, `libvpx` VP8 and the `webm` muxer.

Pointed at it, `retest-media` replies `encoder_unavailable`: "ffmpeg-mac (ffmpeg version n7.0.1-playwright-build-1011) cannot record: it lacks the rawvideo demuxer". That was shown in log `/tmp/retest-media-playwright-ffmpeg.log`, from a one-off `node --input-type=module -e` script using `src/media/client.ts`, rerun against the revised binary. Before the format probe existed, the same build was chosen for VP8 and failed only at finish, with exit code 234 and "Unknown input format: 'rawvideo'".

## Review findings and what showed each fixed

The reviewer's reproduction scripts in `/tmp/retest-media-review-exp/` were rerun against the revision after adapting them to the new `record` and `finish` signatures (copies and log in `/tmp/retest-media-fix-check/`, `/tmp/retest-media-fix-check.log`).

| # | Finding | Now | Shown by |
| --- | --- | --- | --- |
| 1 | Deadline and shutdown killed only the encoder's direct child; behind a forking wrapper no `ended` and no `bye` came | ffmpeg leads its own group, and every stop kills the group; the stderr join is bounded at 1 s; `encoderPid` is the signalled group | Process tests for a forking deadline and a forking shutdown; proof step 7; reviewer script e: `deadline_exceeded` after 306 ms, `bye` 1 ms after close |
| 2 | Two recordings on one path, or an earlier file, broke "nothing is at this path until ok" | Starts refused `output_in_use` while the path or its `.partial` exists or a running recording writes it; ffmpeg `-n`; a no-clobber hard link; a failed link keeps and names the `.partial` | Process tests for output in use and a file that appears mid-recording; client test; reviewer script c refused |
| 3 | `record()` never settled after exit; no timeouts | Every pending start and finish settles on exit; `record(start, timeoutMs)`, `finish(timeoutMs, end?)` | Client tests for an ended or closing process, for no answer in time, and for a start and a finish pending at the moment of exit; reviewer script a rejects at once |
| 4 | `fps: 29.97` left `record()` pending; a fractional timestamp was lost while reported `sent` | The process's refusal carries the `recordingId`; the client refuses non-integers with `RangeError` | Unit test for refusal ids; process test for unreadable starts; client test for unreadable numbers; reviewer script i |
| 5 | A wall-clock timestamp made the process write 6,814 frames, 9.8 GB, in 3 s | Frames past `maxDurationMs` refused; gaps over `maxGapMs` shortened and reported; output capped at the maximum duration; a stall watchdog during recording | Timeline unit tests; process tests for gaps and range and for a stalled encoder; reviewer script d: media process CPU 0.01 s over the same 3 s, nothing written |
| 6 | A dead media process orphaned its encoder and left an unnamed playable `.partial` | The client gives the encoder 1 s, kills its group, and rejects with `MediaRecordingLostError` naming the `.partial`; the earlier claim that the client's group kill "also reaches" ffmpeg was false and is withdrawn | Client tests for the media process dying, with a finishing encoder and with one that never exits; proof step 9; reviewer script b |
| 7 | A frame sent after `close()` began was reported `sent` | `not_sent` | Client test; reviewer script f: `not_sent`, process received 1 |
| 8 | Frame count and duration held by construction; the order check tolerated shifts of several ticks | A key on every tick; capture density asserted; all 90 frames checked against the one screenshot their timestamp maps to, tolerating only pixel-identical twins (3 frames, at most 1 tick apart); count and duration called container checks | Proof steps 1 to 4 |
| 9 | A panicked recording was reported only on the next message | stdin read on its own thread; the loop reaps every 50 ms | Process test for a panicking thread, through the debug-only hook |
| 10 | Unbounded recordings, ended ids, stderr lines and probe reads | 16 recordings, 4096 remembered ids, lines clipped as read, 1 MiB per listing | Process test for the recording limit; unit tests for the ended set and the endless line |
| 11 | `ended` could not map video time to capture time | `firstTimestampUs`, `framesBeforeFirst`, `gaps`, `gapsShortened`, `endClipped`; Phase 4 must carry the mapping into reports | Process test for gaps and range; proof step 1 checks `firstTimestampUs` |
| 12 | `stop` killed a finishing encoder; a failed rename deleted a finished `.partial` | Finishing recordings complete within their deadline on shutdown; `output_failed` keeps and names the `.partial` | Process tests for shutdown while finishing and for a file that appears; proof step 11 |
| 13 | The start time stopped at the greeting, but the first `started` waits on the probe | Both reported | Measurements below; reviewer script h |

## Cross-lane review: ten claims about cancellation

A read-only trace of the cancellation paths made ten claims. Each was checked against the code before anything changed. Where a test is named, it fails against the client as it was and passes now, unless the row says otherwise.

| # | Claim | Checked | What changed | Shown by |
| --- | --- | --- | --- | --- |
| 1 | The child is spawned detached with nothing to let Node exit; a forgotten `close` keeps Node alive forever | True: `spawn` with `detached: true`, no `unref`, no exit handling. The media process itself already shut down on the end of its input, so Node's exit, by any route, was already enough; only the hang was real | The child and its three pipes are let go of while no recording runs and no start is unanswered, and held again while one is. No exit hook: closing the input is the hook, and it is `shutdown`'s own path. Recorded under Lifecycle | The forgotten `close` test (hung 5 s before); the SIGTERM test, which passes against both |
| 2 | A forced `close` returns before the encoders of lost recordings are stopped, leaving a wedged encoder and an unnamed `.partial` | True: the exit handler started each reclaim with `void` and `close` resolved on the exit | `close` waits for every reclaim after the exit, forced or not | The forced close test: `close` returned before the rejection and with the encoder alive before |
| 3 | After the media process dies, the encoder group is killed only when its leader is still alive, so a leader that exits on the end of its input leaves a forked child behind; the record claimed the group is killed | True: `reclaim` signalled the group only if the leader was alive | After the grace the group is killed whenever anything is left in it, and waited for; the message says which happened | The forked child test: "exited on its own" with the `sleep` alive before |
| 4 | `kill(-pgid)` is sent at several places after the group may be empty, so a reused id could be killed; the record argued only one case | True at every place named. Two were pointless: the client's kill of the media process's own group after it was reaped, and the kill when a greeting fails because the process has already exited. The rest cannot be made safe without pidfd | The pointless kills are gone; the process marks a recording done before its stderr wait, so the watchdog and a shutdown stop signalling then; the client never signals a group that no longer answers a signal. Every remaining window is listed under Not shown | Code reading; `cargo test` and the client tests still pass. No test can show the window closed |
| 5 | The client accepts any id length and frame size, but the process refuses ids over 200 characters and frames over 64 MiB, and an id long enough to carry the header past 64 KiB is a protocol violation that ends every recording | True: `check_start` refuses a 201-character id with `invalid_start`, which is clean; a 70 000-character id makes a header over 64 KiB, which `read_envelope` refuses as `HeaderTooLarge`, a violation, and the process exits 2. A frame over 64 MiB is `PayloadTooLarge`, the same | The client refuses both with `RangeError` before writing; the limits are exported as `MAX_ID_CHARACTERS` and `MAX_FRAME_BYTES`. A unit case for the 201-character id joins the process's start checks | The limits test: the 201-character id reached the process before |
| 6 | A `started` arriving after the client's timeout only sends `finish` and is never recorded, so a process that then dies leaves that encoder unreclaimed | True: `#started` returned after `sendFinish` for an abandoned id | A late `started` becomes a recording the client finishes at once and keeps until its `Ended`; a second start with the id is refused meanwhile | The late start test, through the stand-in's `late-start` mode: the `sleep` outlived the stand-in before |
| 7 | Stdin errors are discarded and `writableEnded` is checked but not `destroyed`, so after EPIPE and before `close` a frame is `sent` and counted; the record said frames after the process ended are `not_sent` | True: the pipe's error handler was empty and `#unavailable` did not look at `destroyed`. A frame handed to the pipe before any write has failed can still be lost, and nothing on this side can know that in time | The first error on the pipe is kept and named by every later refusal; a destroyed pipe counts as unavailable. The record now says what `sent` means | The broken pipe test, through the stand-in's `close-input` mode: `sent` after EPIPE before |
| 8 | The process's bounds add up to about 26 GiB from one client, and the read-ahead was missing from the Bounds list; the client's `errors` grows without bound | True on both counts | The client keeps the newest 64 errors. The Bounds list names every limit and the sum | The errors test: 70 kept before. The bounds are read from `server.rs` |
| 9 | The first start joins the probe on the loop, so a hung ffmpeg blocks input for up to about 28 s, against the record's "wakes at least every 50 ms" | True: `Probe::capabilities` joins the probe thread from `Server::start` | Nothing in code; the Input bullet now says it | Code reading |
| 10 | The record claimed more than the tests showed: every pending start and finish settles on exit (no test with one pending at exit); every close checks an empty process group (only the media process's own); the ended-or-closing test asserted only one received frame; the dies tests rested on sleeps | True on each point | A test with a start and a finish pending when the process is killed; step 12 says whose group each `close` checks; the ended-or-closing test also asserts `stopped`, an empty encoder group and no `.partial`; the dies tests and proof step 9 wait for the encoder's file instead of sleeping, on the default H.264 route, which with x264 means sending frames until its lookahead fills | The tests named; the proof's step 9 |

Four paths the trace named as untested now have a test each: a signal to Node mid-recording, a write to a dead process's pipe, a stalled media process, and a reclaim through a forced close.

## Measurements

From the final proof run unless stated. These are single-machine numbers for a three-second, 800 by 600 page with one key typed per tick, and support no speed claim.

| Measure | Value | How |
| --- | --- | --- |
| Process start, spawn to greeting | median 2.2 ms, min 2.0, max 4.4, over 10 starts | `performance.now()` around `MediaProcess.start` |
| Process start, spawn to the first `started` | median 53.2 ms, min 50.7, max 61.5, over the same 10. The first start waits for the background probe, two ffmpeg runs. Reviewer script h measured 51.4 to 53.8 ms over 7 more | `performance.now()` to `record()` resolving |
| Frame bytes, Chrome to Node | 14,767 bytes of PNG per frame on average; as base64 over the DevTools pipe that is 19,692 bytes (computed, not measured) | `bytesReceived / received` |
| Frame bytes, Node to the media process | the PNG bytes plus an 82-byte prefix and header; 1,299,450 frame bytes and 7,424 header bytes for the recording | client `traffic` |
| Frame bytes, media process to ffmpeg | 1,440,000 bytes of raw RGB per output frame, 43.2 MB/s at 30 fps, 129.6 MB for the recording | `bytesToEncoder` |
| Copies of a frame's bytes in user space | Node's stream writes the screenshot buffer it was given. The media process reads it through a 256 KiB read buffer into one frame buffer, decodes it once into a 1.44 MB RGB buffer, and writes that buffer once per output frame | the code; not profiled |
| Media process CPU, own | 0.06 s for the recording | `ps -o time=` on its pid after `ended` |
| Media process memory | peak 11.1 MB resident, sampled every 50 ms; peak memory footprint 10.1 MB | `ps -o rss=`; `/usr/bin/time -l` |
| ffmpeg for the recording | 3.02 s real, 0.19 s user, 0.08 s system, 167.9 MB maximum resident, 156.0 MB peak footprint | `/usr/bin/time -l -a` around ffmpeg |
| ffmpeg probes | two runs, 0.02 s real and 0.01 s user each | same |
| Media process with its reaped children | 3.45 s real, 0.27 s user, 0.12 s system; its maximum resident figure, 167.9 MB, is ffmpeg's | `/usr/bin/time -l` around the media process |
| Finalization, finish to `ended` | 13 ms H.264, 159 ms VP8 | `finalizeMs` |
| Artifact size | 18,296 bytes H.264 MP4, 63,218 bytes VP8 WebM, both 3.0 s | `stat`, ffprobe |
| Release binary | 967,792 bytes, Mach-O arm64, links `/usr/lib/libSystem.B.dylib` and `/usr/lib/libiconv.2.dylib` | `ls -l`, `otool -L` |
| Release build | 20.9 s wall, 32.2 s user, for the first release build with crates already downloaded, before the revision | `time cargo build --release` |

## Packaging: options and their costs

No decision is taken here. Measured facts are marked; everything else is a cost to weigh.

### The media binary

| Option | What it is | Costs and evidence |
| --- | --- | --- |
| Prebuilt binaries inside the one npm package | `@rehearsal-labs/retest` carries `retest-media` for each supported platform, chosen at run time | About 0.97 MB per platform on macOS arm64 (measured); Linux x64 not built. Every install downloads every platform's binary. CI must build each target natively or cross-compile, and macOS signing and notarization of a binary shipped in a tarball is unexamined. Keeps one package and zero third-party npm dependencies |
| Optional platform packages | `@rehearsal-labs/retest-media-darwin-arm64` and `-linux-x64` as `optionalDependencies` with `os` and `cpu`, the pattern esbuild uses | npm installs only the matching binary. More packages to publish in lockstep. Installs with `--omit=optional`, or lockfiles made on another platform, can leave the binary out, so a missing binary must be a clear setup error. AGENTS.md allows another package once a real binary distribution need exists; this would be one. The packages are first party |
| Build on install | `cargo build` from a postinstall script or an explicit command | Needs Rust 1.88 or later on every host: rustup's default 1.81 on this machine fails on edition 2024 (shown). 21 s cold build here, plus crates.io access at install. Install scripts are often disabled (`--ignore-scripts`) and are a supply-chain concern. Least release work |

### ffmpeg on a clean host

| Option | What it is | Costs and evidence |
| --- | --- | --- |
| Declared prerequisite, like Chrome | The host installs ffmpeg; Retest takes `--ffmpeg` or a path setting; `doctor` runs the same probe | Homebrew's ffmpeg is GPLv3 with libx264, 52 MB with 14 formula dependencies (measured). What a Linux distribution's ffmpeg contains was not checked. A build that cannot record is named at `start`, with what it lacks (shown with Playwright's build). Retest ships no codec and carries no codec license |
| Bundled minimal build, as Playwright does | Retest builds and ships its own static ffmpeg per platform | Playwright's VP8-only build is 2.58 MB and LGPL 2.1 (measured), but lacks the `rawvideo` demuxer this protocol needs (shown). Retest would need its own configuration: `rawvideo`, libvpx and the webm muxer can stay LGPL; adding libx264 makes the build GPL 2.0 or later, with its distribution obligations. Costs a build pipeline per platform, license notices, and security updates for codec libraries |
| Platform encoders | VideoToolbox on macOS, through ffmpeg (`h264_videotoolbox` is in Homebrew's build) or directly | Not exercised. Would differ by platform and still need a Linux route |

A cheaper pipe is possible but unmeasured: sending PNG frames on to ffmpeg's `image2pipe` would carry about 0.4 MB/s instead of 43.2 MB/s. It would move decoding into ffmpeg, need one image format per recording, and move resizing to an ffmpeg filter.

## After the Phase 2 review

Recorded on 5 October 2026 on the tree with Phase 3 uncommitted on top of `b59eed5`, on macOS 27.0.1, arm64. No `cargo test` had been recorded since commit `9b38691` changed `recording.rs`, `encoder.rs` and `process_ownership.rs`, and in its default parallel mode it was red.

- **An unreadable command is no difference.** `process_ownership.rs` compared the exact command, so an encoder read as `(ffmpeg)` while it exits was "changed identity and left alone", which turned a recording with no frames into `encoder_failed`. It now takes the same rule as `src/shared/process-ownership.ts`: pid and start identify a process; a command in the kernel's short form, at most 16 characters in parentheses or 15 in brackets, is unreadable and never a mismatch; two readable commands that differ are still refused; a record taken while the command was unreadable keeps the first readable one. `stop` reads and signals through functions a test can give, so its decision is tested on given readings.
- **Why the forking-wrapper tests lost their child.** Right after a start, a shell script's arguments cannot be read for a moment: a tight `KERN_PROCARGS2` loop on 200 launches of a `#!/bin/sh` wrapper met `EIO` 7800 times and `EINVAL` 48 times, and `ps` then prints the name in parentheses. When the encoder probe's first reading landed there, the wrapper's record never matched again, its child was never recorded, and the child counted as a group member of unknown launch, so the probe refused the encoder. The tests never checked that the start succeeded, so a refused start read as "the wrapper started no child" after ten seconds. The rule above is the fix; both tests now also assert the start was answered `started`. In the default parallel mode the pair failed 11 of 20 runs on the old rule, every failure "launch ownership is unknown", and 0 of 20 with the fix.
- **One answer for an output path in use.** `server.rs` asked for files before running recordings, so a second start at the path of a running recording was refused either as "a file is already at ….mp4.partial" or as "recording c is writing ….mp4", by whether the encoder had opened its file yet. It now asks for the running recording first. The test waits until the encoder has created its `.partial` file, when both reasons hold: the old order failed it 3 of 3 times, the new one passed 5 of 5.
- One existing assertion changed, because it held the old rule: `zombies_have_exited_even_when_ps_changes_their_command` asserted that a live reading and a zombie reading of `(ffmpeg)` do not match. Under the rule they match; the zombie state, which the test still asserts, is what keeps a zombie from a signal.

| Command | Result |
| --- | --- |
| `cargo test --bin retest-media process_ownership` | 7 passed (`/tmp/retest-lane-c-t3-on.log`); with the rule taken out, 3 failed (`/tmp/retest-lane-c-t3-off.log`) |
| `cargo test --test process forking`, 20 runs each | old rule: 11 of 20 failed (`/tmp/retest-lane-c-forking-old-*.log`); with the fix: 0 of 20 (`/tmp/retest-lane-c-forking-fixed-*.log`) |
| `cargo test --test process an_output_path_in_use` | old order 3 of 3 failed (`/tmp/retest-lane-c-inuse-off-*.log`), new order 5 of 5 passed (`/tmp/retest-lane-c-inuse-on-*.log`) |
| `cargo test`, three runs in a row, default parallel mode | each run 46 unit and 25 process tests passed (`/tmp/retest-lane-c-cargo-1.log` to `-3.log`) |

## Not shown, and what Phase 4 still needs

- Linux x64: the crate was neither built nor run on Linux.
- Only a screenshot loop was captured. Chrome's screencast, and Firefox, WebKit, iOS and macOS capture, were not connected.
- Protocol version 1 identifies a frame by recording id and timestamp only. Section 8 of plan.md asks for run, test, app, session, action and frame ids; adding them is a protocol version change.
- The video-to-capture mapping is in `ended`; no report uses it yet.
- Thumbnails, pixel redaction and a capture policy are not implemented.
- `src/browser/browser.ts` still ends Chrome's process group at once; flushing a recording before closing the browser is untouched.
- These were not done: a runner that restarts a crashed media process, recording on and off comparisons, and copy or IPC profiling.
- The VP8 route was shown by replaying live screenshots, not by a live capture.
- Finalising uses a hard link. On a filesystem without hard links, every recording would end `output_failed`, with its video kept at the `.partial`; no such filesystem was tried.
- A process group's id stays reserved while any member lives, and is free once the last one is gone. Every place that signals a group after its leader may have exited has a window in which the id could name a process that is not ours, and no call on macOS or Linux without pidfd closes it: the process's kill after the encoder exits (`recording.rs`, `feed_encoder`), the watchdog and a shutdown if they fire in the same instant, and the client's kill of an encoder group that still answered a signal a moment before. The useless cases are gone: the client no longer signals the media process's own group after it is reaped, and the process marks a recording done before the stderr wait so nothing signals the group again then. Reuse inside the remaining windows was not tested and cannot be ruled out.
- The one-second grace before the client kills an orphaned encoder's group is a fixed choice. The two client tests that say the encoder "exited on its own" rest on ffmpeg finishing a tiny file inside it.
- A forced `close`, or a media process that dies, leaves a lost recording's `.partial` on disk, named in the rejection, so a later start at that output is refused `output_in_use` until the caller removes or moves it. Phase 4's runner has to own that file.
- The first `start` waits on the loop for the probe; an ffmpeg that hangs there holds the process's input for up to 28 s. Not exercised; no recording can be running yet when it happens.
- The 10 s default stall limit and the 30 minute default duration were exercised only through shorter values set in tests.
- The client's one-second grace for an encoder whose media process died is a fixed choice, not measured against slow disks.
- ffmpeg uses its default thread count; its 156 MB peak footprint was measured, not tuned.


## Protocol 2 and the media client

The earlier sections describe the older processor. The processor and client now speak protocol 2. No runtime npm package or new crate was added. The processor still runs the host's ffmpeg as a separate program. The tested host is macOS arm64; Linux x64 remains unverified.

The source contract is in `src/media/protocol.ts` and `src/media/client.ts`. The client methods and required identity fields described in `../codex/phase-4/media-client-v2.md` are unchanged by the resumed work.

- Every start and ending carries run, attempt, test, app and session identity. Every input frame has a frame id, with optional action and observation ids. `ended.frameMap` names each retained frame's capture time, fate and video placement. Duplicate ids are counted. Map omissions are counted rather than hidden.
- The greeting names the binary version, source revision when known, dirty state, target triple, build profile and encoder probe state. A greeting may say `probing`; `ready()` returns the finished probe. Starts waiting for the probe leave the input loop free to answer other commands. The client rejects another protocol version with the binary's name and the matching build command.
- A thumbnail command resizes a PNG or JPEG, never enlarges it, and names failures. Frame sequences return bounded timestamped images from running or ended recordings, until release. Their count and byte caps, undecodable images and stretches without frames are explicit. A running sequence can contain a `pending` frame, whose placement has not finished. Sampling never proves that a fleeting event was absent.
- One watcher per recording receives resized newest JPEG frames, with skipped, dropped and failed totals. The live reply slot can replace an unsent live frame. A slow reader loses live frames without changing the recording's frame queue.
- Endings carry queue peaks and saturation, capture gaps, encoder diagnostics and a separate evidence status. `complete`, `partial` and `unavailable` describe evidence; the media process supplies no application verdict.
- Completed outputs use a no-clobber hard link, or a no-clobber synced copy when links are unavailable. The copy path is exercised with the debug hook `RETEST_MEDIA_TEST_NO_HARD_LINKS`, not on a mounted filesystem without links. `leftovers(output, { remove })` lists or removes a lost recording's partial video and frame store, and refuses an output still in use.
- Shutdown names stopped recordings and outstanding jobs, ends live views and removes retained frame stores. The client reclaims recorded encoder processes after a worker crash and removes kept frames. A lost partial video is named and left for its owner to inspect or remove.

The limits include recording and frame identity bounds of 512 and 128 characters, 64 KiB headers, 64 MiB input payloads, at most 16 active recordings, 64 retained ended recordings, 64 frames per sequence and 48 MiB per sequence response. Requested image sides are at most 4096. Kept frames default to a 512 MiB disk store per recording and stop storing when its bound is reached. The existing queue, recording clock, duration and encoder deadlines remain enforced.

### Files and the resumed fixes

The Rust implementation is in `media/src/{protocol,server,recording,encoder,frame,queue,replies}.rs`, with `jobs.rs` for thumbnails and sequences, `store.rs` for retained encoded images, `ledger.rs` for frame identity and missing stretches, `live.rs` for watchers, and `place.rs` for finalization. `media/build.rs` records build identity. `allocations.rs` is enabled only by the measuring feature. The production release build leaves that feature out.

The resumed work updates `proofs/media/run.ts` for recording identity and frame ids, checks the ending's frame map, saves the complete captured input, and independently decodes and checks frame order for the close-while-finishing video and the crash partial. `proofs/media/compare-routes.ts` replays that input through both routes.

Client and process tests now request readiness before requiring a finished probe. Their required ready or failed states, codec lists and build checks are retained. The running-sequence test waits for the earlier frames' shown placements before checking the same exact fates. The lingering-encoder fixture keeps its recorded shell alive around its waiting child; it no longer deliberately changes the shell's readable command. Process and group absence assertions remain in place. No existing deadline or density assertion was relaxed.

`media/src/process_ownership.rs` reads pid, parent and group links for discovery, then full identities only for relevant processes. Before each signal it reads that recorded pid's full identity again. An unsuccessful selected query proves absence only when a successful fresh discovery also finds it absent. The ownership decisions are unchanged: pid and start identify the recorded launch, unreadable commands are not mismatches, changed readable commands are refused, and a group number never grants signal authority. Tests retain every original ownership assertion and additionally check descendant selection, unknown group members and failed discovery.

### The two routes on the same saved input

The completed comparison is `/tmp/retest-media-resume/routes-complete/results.json`, with each replay's result, allocation counts, ffmpeg timing output and decoded images in its route folder. The command was:

```sh
cargo build --release --locked --offline --features allocation-counts \
  --manifest-path media/Cargo.toml \
  --target-dir /tmp/retest-media-resume/measuring-target
RETEST_MEDIA_BINARY=/tmp/retest-media-resume/measuring-target/release/retest-media \
  node --conditions=retest-source proofs/media/compare-routes.ts \
  /tmp/retest-media-resume/proof-final /tmp/retest-media-resume/routes-complete
```

Log `/tmp/retest-media-resume/routes-complete.log`, exit 0. The input is 89 actual Chrome PNG screenshots, 800 by 600, totaling 1,313,351 bytes. Their concatenated SHA-256 is `d2705bf2375b3731e7f08b578dc5d31c147840252c24dde483b1da9291b4ff34`. They were saved by the main recording in the proof attempt whose log is `proof-final.log`. That attempt passed the main H.264 and VP8 whole-decode and order checks, then failed its encoder-kill timing assertion on the earlier metadata implementation. The comparison uses the rebuilt processor's metadata reads. It does not treat the incomplete proof attempt as a passing proof.

The script runs three replays per route, alternating route order. Each replay uses the same bytes, timestamps, paced delivery, output size, cadence, queue bounds, retained-frame setting and host ffmpeg. Both routes create H.264 MP4. ffprobe decodes and counts every frame; a separate full ffmpeg decode compares every output frame with its expected screenshot and every differing alternative. All six replays passed 90 frame comparisons and reported complete evidence. No media process or encoder group remained after the comparison.

These are single-machine measurements on a shared host, not a speed claim. The Rust measuring build counts heap allocation requests, including reallocations, across the process's whole lifetime. Media CPU is its own `ps` CPU change across the recording. Media RSS is sampled; ffmpeg CPU and maximum RSS come from `/usr/bin/time -l`. The media process's timing wrapper includes reaped children and is not used as its own CPU or peak memory. Sampling can miss short peaks, so the ffmpeg maximum below uses its independent timing result.

| Measure, median of three | Decoded RGB route | Encoded PNG route |
| --- | ---: | ---: |
| Node to media image bytes | 1,313,351 | 1,313,351 |
| Node to media request headers and prefixes | 10,173 | 10,195 |
| Media to ffmpeg bytes | 129,600,000 | 1,325,840 |
| Rust heap allocation requests | 3,550 | 3,222 |
| Rust bytes allocated, cumulative | 173,639,386 | 22,147,696 |
| Rust live allocation bytes at peak | 3,498,074 | 683,057 |
| Media own CPU, seconds | 0.05 | 0.01 |
| ffmpeg user plus system CPU, seconds | 0.27 | 0.31 |
| Combined CPU, seconds | 0.32 | 0.33 |
| Media sampled peak RSS, bytes | 10,289,152 | 4,554,752 |
| ffmpeg maximum RSS, bytes | 166,952,960 | 189,988,864 |

Combined CPU ranged from 0.30 to 0.33 for decoded and 0.32 to 0.34 for encoded. The CPU precision and shared host do not support a general performance conclusion. Decoded remains the default because this input used less ffmpeg peak memory and comparable total CPU. Encoded remains available through `encodedFormat`, for callers choosing the smaller image pipe. One encoder input format is fixed for that recording. Matching frames at the output size pass through unchanged; another size or format is decoded, fitted and converted to the selected format. This comparison measured PNG without resizing. It does not establish a default for JPEG workloads or another machine.

The code path moves each received encoded payload into the recording queue and held frame without cloning it, on both routes. The decoded route additionally materializes a raw RGB buffer per processed screenshot; the matching encoded route uses the received image buffer. These copy observations are from the code and the measured allocation and pipe counts. Codec-internal, kernel and ffmpeg allocation or copy counts were not traced. The measurement is not a claim about all copies in the complete application run.

### Linux x64 attempt

`docker/linux/run.sh` and its Dockerfile were read. That script builds a browser image and would use downloads; this attempt uses only the image already installed. Docker is running on arm64, and `retest-linux:dev` is Linux arm64. Its tool check printed `aarch64` and found none of Cargo, rustc or ffmpeg. No image or toolchain was downloaded, and nothing was installed system-wide.

The exact x64 attempt was:

```sh
docker run --rm --pull never --platform linux/amd64 --init --cap-drop ALL \
  --security-opt seccomp=docker/linux/chromium-seccomp.json \
  --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media,dst=/media,readonly \
  retest-linux:dev sh -c 'uname -m; cargo build --locked --offline --manifest-path /media/Cargo.toml --target-dir /tmp/retest-media-target && cargo test --locked --offline --manifest-path /media/Cargo.toml --target-dir /tmp/retest-media-target'
```

Exit 125, `/tmp/retest-media-resume/linux.log`. Docker refused the installed arm64 image for the requested amd64 platform. The build and tests therefore did not execute. The installed image's tool check is `/tmp/retest-media-resume/linux-tools.log`, exit 127. Linux x64 is unverified; this is not a cross-compilation or emulation pass.

### Completion and cleanup corrections

The continuation checked the saved logs before accepting any gate result. `/tmp/retest-media-resume/proof-complete.log` failed because a recording whose finishing work exceeded its deadline still returned `ok` after its encoder had exited. `/tmp/retest-media-resume/client-complete.log` failed because forced cleanup stopped encoder descendants while stopping the worker, but the later lost-recording message claimed they had exited on their own. Neither run is a passing proof or client gate.

`Ending::complete` now checks the deadline independently of the watchdog and preserves an earlier stop reason. The watchdog records an overdue deadline even if the encoder already exited. The proof deliberately stops its own encoder before the existing deadline case, keeping that case a certain missed deadline when encoding gets cheaper. The fake hanging encoder keeps its shell alive after its child is stopped, so the existing leader-signal assertion still tests a kill. Deadline, density, frame-order and process-absence assertions are retained.

The client records when forced cleanup began. A recording whose encoder is gone afterwards says its recorded processes were stopped or exited during forced cleanup. It no longer attributes that ending to an independent exit. The forced-close test still requires rejection before close returns, the named partial file, and no encoder or group remaining.

The first Rust check in `/tmp/retest-media-finish/cargo-first-failure.log` failed two existing cleanup time bounds. Cleanup repeated metadata queries after a complete snapshot had proved every relevant pid absent. An owner now retires immediately on that proof of absence, and a retired owner cannot read or signal those pids again. Failed or unreadable discovery never proves absence. Launch ancestry, pid and start checks, readable-command refusals and unknown-process refusals are unchanged. The encoder status check also avoids ancestry discovery after the child has confirmed its exit; final cleanup still checks recorded descendants and unknown members.

The final three default-parallel `cargo test --locked --offline --manifest-path media/Cargo.toml` runs each passed 80 unit and 40 process tests. Logs `/tmp/retest-media-finish/cargo-1.log`, `cargo-2.log` and `cargo-3.log`. The added unit tests cover late completion, preservation of an earlier stop reason, and refusal to read or signal a retired pid. `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings` and the same command with `--features allocation-counts` passed, logs `clippy.log` and `clippy-measuring.log` in that folder. Formatting and the production release build passed there too, logs `fmt.log` and `build.log`.

`media/Cargo.toml` declares Rust 1.88, matching the locked image dependency's minimum. The minimum toolchain itself was not exercised; these builds used the installed toolchain.

The source's running-sequence result already included one type addition that the interface note omitted. `SequenceFrame.fate` is `'shown' | 'superseded' | 'pending'`. A pending image was captured and kept but has no completed video placement yet. This corrects the earlier statement that every documented client type was unchanged. Method signatures and parameters are unchanged. The client test requires the newest running frame to be pending and the ended sequence's frames to have shown placements. The lane report asks for that correction to the interface note.

### Measurement with the final processor

The Rust cleanup change affected process allocations, so both routes were measured again with the final processor. This adds a measurement to the earlier one rather than replacing it. The input is the same saved 89 Chrome PNGs and the same input hash recorded above. No browser is started by this replay. Both routes still use the same image bytes, timestamps, paced delivery, image size, cadence, queue settings, retained-frame setting and host ffmpeg, in alternating order.

```sh
cargo build --release --locked --offline --features allocation-counts \
  --manifest-path media/Cargo.toml \
  --target-dir /tmp/retest-media-finish/measuring-target
RETEST_MEDIA_BINARY=/tmp/retest-media-finish/measuring-target/release/retest-media \
  node --conditions=retest-source proofs/media/compare-routes.ts \
  /tmp/retest-media-resume/proof-final /tmp/retest-media-finish/routes
```

Both commands exited 0. Logs `/tmp/retest-media-finish/build-measuring.log` and `/tmp/retest-media-finish/routes.log`. Full results, independent ffmpeg timing output, allocation counts and decoded images are under `/tmp/retest-media-finish/routes/`, with `results.json` as the index. The measuring binary's SHA-256 is `9494770bda42954b9a29e4e178c4df9106efd3a64a932b04afc0a4a1cd70dd8b`, checked against the file. The production build has no allocation-counting feature.

All six recordings reported complete evidence, passed independent ffprobe counts and a whole decode, and passed every-frame order comparisons for all 90 output frames. The comparison asserted no media process or encoder group remained. The earlier input came from a proof attempt that completed the main H.264 and VP8 order checks but later failed a separate failure-case check; that attempt is still not a passing whole proof.

| Measure, median of three on this machine | Decoded RGB | Encoded PNG |
| --- | ---: | ---: |
| Node to media image bytes | 1,313,351 | 1,313,351 |
| Request headers and prefixes | 10,164 | 10,186 |
| Media to ffmpeg bytes | 129,600,000 | 1,325,840 |
| Rust heap allocation requests | 2,781 | 2,456 |
| Rust cumulative allocation bytes | 170,284,753 | 18,792,975 |
| Rust live allocation bytes at peak | 3,497,907 | 633,827 |
| Media own CPU, seconds | 0.06 | 0.01 |
| ffmpeg user plus system CPU, seconds | 0.26 | 0.31 |
| Combined CPU, seconds | 0.32 | 0.32 |
| Media sampled peak RSS, bytes | 10,420,224 | 4,276,224 |
| ffmpeg maximum RSS, bytes | 166,739,968 | 189,333,504 |

Combined CPU ranged from 0.31 to 0.33 on decoded and 0.32 to 0.34 on encoded. Decoded remains the default, with comparable combined CPU and less ffmpeg peak memory for this input. Encoded remains available through `encodedFormat` when a caller chooses its smaller image pipe. These are single-machine measurements on a shared host, not a speed claim or a JPEG result. The copy observations and measurement limitations described above still apply; codec-internal, kernel and ffmpeg copy counts were not traced.

### Targeted client metadata and the unit gate

The whole unit command encountered the shared metadata reader's output limit. The client now discovers pid, parent and group links first, then reads full identities only for its media launch, relevant descendants and groups. `OwnedProcessGroup` still performs every ownership decision and fresh identity check before a signal. Failed discovery still fails the operation. The caller included to make an absent-pid query succeed is removed from the snapshot and grants no ownership. Stale selection entries are pruned after successful discovery. Unrelated application arguments no longer fill the media client's metadata response. No shared ownership, browser or native file was edited.

`npm run test:unit`, launched through `/tmp/retest-media-finish/unit-gate.ts`, reached the external gate limit and exited 124. Its log reports 3542 tests, 3360 passed, 177 failed, 5 cancelled, 0 skipped. Every named failed or cancelled test is outside the lane's files, including browser and native ownership, diagnostics, evaluation, CLI and runner work in progress. This is not a passing unit gate. Log `/tmp/retest-media-finish/unit.log`.

The initial unit guard could not read ownership because the shared reader's whole-host argument query exceeded its limit. Cleanup then used targeted reads under the verified stable wrapper that launched this unit command. Only its recorded descendants were signaled, with fresh identity checks. `/tmp/retest-media-finish/unit-cleanup.log` confirms the recorded unit processes stopped, with no ownership or read problem. The unit wrapper's last message reflected its failed whole-host query and could not itself confirm absence; the later targeted confirmation is the cleanup result. No other worker was signaled.

`npm run test:types` exited 1 with the unexpected undefined-recording error at `src/evaluation/frames.ts:97` on TypeScript 6.0.3 and 7.0.2. Log `/tmp/retest-media-finish/types.log`. That file belongs to another lane and was left untouched.

### Proof coverage and scoped TypeScript checks

The proof now compares the VP8 and close-while-finishing durations with their reported endings. It requires the crash partial to contain playable frames with a matching duration, and requires every whole-decode order check to cover all frames counted by ffprobe. These add assertions to the existing frame-order, density, deadline and process-absence checks. They do not turn an earlier failed proof into a pass.

The final media client and protocol passed these scoped compiler commands, each with exit 0:

```sh
node_modules/typescript/bin/tsc -p /tmp/retest-media-finish/tsconfig-media.json
node_modules/typescript-7/bin/tsc -p /tmp/retest-media-finish/tsconfig-media.json
node_modules/typescript/bin/tsc -p proofs/media/tsconfig.json
node_modules/typescript-7/bin/tsc -p proofs/media/tsconfig.json
```

Logs `/tmp/retest-media-finish/media-types-6.log`, `media-types-7.log`, `media-proof-types-6.log` and `media-proof-types-7.log`. The temporary config includes only `src/media/client.ts` and `src/media/protocol.ts`, with the repository's strict compiler options. The media proof config includes this lane's proof files and the media source types. These scoped checks are distinct from the required whole-tree scripts and do not claim those scripts passed.

### Required gates and remaining verification

The final client tests, Chrome proof and combined typechecks could not launch under the shared lock. Each of five blocking attempts used:

```sh
lockf -t 540 /tmp/retest-heavy-gate.lock sh /tmp/retest-media-finish/gates.sh
```

Each exited 75 before executing the script. Logs `/tmp/retest-media-finish/lock-wait.log`, `lock-wait-second.log`, `lock-wait-third.log`, `lock-wait-fourth.log` and `lock-wait-fifth.log`. The last error is also preserved as `gates.log`. Another worker's agent integration command last held the lock, with Chrome descendants still present. That command and its descendants were left untouched. No command launched by this continuation remains running.

| Required command | Result available from disk | Log |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path media/Cargo.toml`, three consecutive default-parallel runs | Each exit 0, 80 unit and 40 process tests | `/tmp/retest-media-finish/cargo-{1,2,3}.log` |
| `cargo clippy --locked --offline --manifest-path media/Cargo.toml --all-targets -- -D warnings` | Exit 0; measuring feature also passed | `/tmp/retest-media-finish/clippy.log`, `clippy-measuring.log` |
| `node --conditions=retest-source --test 'proofs/media/**/*.test.ts'` | Final rerun blocked before execution; the earlier run passed 31 and failed 1 | `/tmp/retest-media-resume/client-complete.log`, exit 1 |
| `node --conditions=retest-source proofs/media/run.ts` | Final rerun blocked before execution; the earlier run failed its deadline case | `/tmp/retest-media-resume/proof-complete.log`, exit 1 |
| `npm run test:unit` | External gate exit 124, 3360 passed, 177 failed, 5 cancelled, 0 skipped; named failures outside this lane | `/tmp/retest-media-finish/unit.log` |
| `npm run test:types` | Exit 1, undefined recordings in the evaluation lane on both compilers | `/tmp/retest-media-finish/types.log` |
| `npm run typecheck` | Earlier tree exit 2 in evaluation files; final rerun blocked before execution | `/tmp/retest-media-resume/typecheck.log` |
| `npm run typecheck:proofs` | Earlier tree exit 0; final combined rerun blocked before execution. Final scoped media-proof checks passed on both compilers | `/tmp/retest-media-resume/typecheck-proofs.log`, `/tmp/retest-media-finish/media-proof-types-{6,7}.log` |

The earlier whole-tree typecheck errors were in `fixtures/evaluation-corpus/runner/score.ts:93` and `:117`, `src/evaluation/frames.ts:90` and `:97`, and `tests/unit/evaluation-frames.test.ts:334`. Those files belong to other lanes and were left untouched. The earlier whole proof's deadline failure and the earlier client's forced-close failure were corrected as described above, but their final required execution gates have not run. No passing whole Chrome proof is claimed.

The retained gate script runs the client command above, then launches the exact proof through `/tmp/retest-media-finish/bounded-proof.ts` with `RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-finish/proof`, then the three npm type commands. The external proof guard records only its launch descendants and fails on an external limit or uncertain cleanup; it changes no assertion. The orchestrator needs a clean lock handoff to execute those final gates. A direct proof retry can use:

```sh
lockf -t 540 /tmp/retest-heavy-gate.lock \
  env RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-final-proof \
  node --conditions=retest-source proofs/media/run.ts
```

Most important unverified items are the final client and whole Chrome execution gates, a passing whole-unit and type-fixture gate across the other lanes, and Linux x64. Also unverified are the declared minimum Rust toolchain, copy finalization on a real filesystem without hard links, JPEG route measurements, other machines, codec-internal and kernel copy counts, ffmpeg allocation counts, native capture and recording, and the runner's full evidence pipeline. The six successful PNG route replays and final Rust checks remain the results described above.

## After the restart

Recorded on 5 October 2026 after the Mac's restart, on macOS arm64 with Node 24.12.0, Homebrew's Rust 1.98.1, ffmpeg 9.0.2 and Google Chrome 154.0.8037.93. The protocol 2 client tests and the Chrome proof ran for the first time, a read of the lane's diff and an outside reading of the crate found faults, and each fault was fixed with a test. The lane report, `../codex/phase-4/media-process-report.md`, has the same section with every command, log and open item.

### What changed

- The client refuses an output path longer than `MAX_PATH_BYTES` (4096 UTF-8 bytes) before writing, for starts, thumbnails and leftovers. A path long enough to carry a header past 64 KiB was a protocol violation that ended every recording.
- The client's reply reader joins a reply's chunks once. It joined them on every chunk, which copied 19.4 GB and held Node for 1.5 s for one 48 MiB reply arriving in 64 KiB chunks.
- The process keeps every reply within the limits the client enforces. An ending's frame map stops at the 64 MiB payload limit and counts the rest in `frameMapOmitted`, which makes the evidence `partial` with `frame_map_truncated`. A frame sequence's frame list stays within 48 KiB of header, and frames it leaves out are counted in `omitted.byBytes`. Ids of 128 multi-byte characters could pass either limit before, and the client then ended the process.
- The reply writer's queue is bounded by bytes, 256 MiB, as well as by count.
- A finish is judged late by when the encoder exited, not by when its cleanup ended, so cleanup cannot turn a video finished in time into `deadline_exceeded` and remove it.
- The watchdog retries a stop that did not reach the encoder once a second instead of giving up after one try. A shutdown waits for a stopped recording's thread no longer than its deadline, its stall limit and ten seconds more. A recording still blocked then gets no made-up ending: the process says `bye`, and the client reclaims it as lost.
- A kept frame of an ended recording that never reached a video is `unprocessed` in a frame sequence, as in the frame map. It was called `pending`.
- `leftovers` compares outputs by their resolved folder, so the same output named through a symbolic link is in use too. It removed a running recording's `.mp4.partial` and kept frames through such a link before.
- Frame sequences search only the 64 stretches they list for lost frames and count the rest, so a tiny `minGapUs` over a long recording no longer costs kept frames times arrived frames.
- A frame sequence whose interval reaches past the 200 000 frames a recording lists says from when, in its `message`.
- The proof now checks the protocol 2 features on the real Chrome recording; see below.

### What was shown

| Command | Result | Log |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path media/Cargo.toml`, three runs in a row, default parallel mode | each 85 unit and 42 process tests passed | `/tmp/retest-media-restart/cargo-{1,2,3}.log` |
| `cargo clippy ... --all-targets -- -D warnings`, without and with `--features allocation-counts` | exit 0 both | `clippy-final.log`, `clippy-measuring-final.log` |
| `node --conditions=retest-source --test "proofs/media/**/*.test.ts"`, under the lock | 32 of 32 passed | `client-final.log` |
| `RETEST_MEDIA_PROOF_OUT=/tmp/retest-media-restart/proof-final node --conditions=retest-source proofs/media/run.ts`, under the lock | every check passed | `proof-final.log`, summary `/tmp/retest-media-restart/proof-final/summary.json` |
| `node --conditions=retest-source --test tests/unit/media-protocol.test.ts` | 5 of 5 passed | `unit-media-protocol-final.log` |

The logs are in `/tmp/retest-media-restart/`. The proof's main recording, with a live view watching it the whole time:

- 90 screenshots in 3 s, none skipped, the largest pause 35.8 ms. `ended` was `ok` with evidence `complete`: 90 received, 90 shown, nothing dropped, refused or unprocessed. ffprobe read H.264, 800 by 600, `yuv420p`, 3.000 s, 90 frames.
- All 90 decoded frames matched the screenshot their timestamp maps to: at most 5 differing pixels for it, at least 29 for any other. For every one of the 90, the frame map named that same screenshot, and no video frame was claimed twice.
- The live view sent 30 JPEG frames of 200 by 150, at most its 10 a second, skipped 58 and dropped none. Each was one of the screenshots sent, in order. The recording's counts above are with the view running.
- The kept frames of the ended recording came back as 64 of the 90, with 26 counted as left out by the cap. At full size each was byte for byte the PNG that was sent, and its fate agreed with the frame map. The 20 stretches of 34 ms or more between screenshots were exactly the ones worked out from the timestamps, each with nothing lost. Four frames fitted to 200 by 200 decoded at 200 by 150.
- A thumbnail of the first screenshot was a 200 by 150 PNG with the screenshot's mean brightness, 253.2.
- The shutdown removed the kept frames.

The other steps passed as before:

- VP8: 90 of 90 frames matched, and the frame map agreed with all 90.
- Close while finishing: `ok`, 90 frames, the frame map agreed with all 90.
- The crash partial: 7 frames, 0.23 s, every frame matched.
- `/bin/cat`: `encoder_failed`.
- ffmpeg killed at 767 ms: `encoder_failed`, ended 38 ms later.
- The forking wrapper: `deadline_exceeded` 480 ms after the finish.
- The missed deadline: `deadline_exceeded`.
- Shutdown with a recording running: `stopped`.
- None of 20 media processes or 19 encoders was left, and the browser's group was empty.

These new tests fail against the code without their fixes, each run in a scratch copy outside the repository:

- The reply reader's copy test copied 19,402,784,934 bytes for a reply of 50,331,814 (`unit-media-protocol-old-reader.log`).
- The reply queue's byte test (`cargo-replies-without-byte-bound.log`).
- The sequence with the longest ids: the test's reader refused the header. The ended recording's fates were `["shown", "shown", "shown", "shown", "pending"]`. Without the bounded shutdown, no `bye` came within 25 s (`cargo-new-process-tests-without-fixes.log`). That run left its fake encoder group, which was then killed by its pid group.
- The symlinked leftovers: the running recording's files were listed and removed (`cargo-alias-without-fix.log`).

### Bounds after these changes

The v1 list above still holds, with these additions:

- Replies waiting to be written: 1024 and 256 MiB, plus one live frame per watched recording.
- An ending's frame map: 200 000 entries and 64 MiB.
- A frame sequence: 64 frames, 48 MiB of images, 48 KiB of frame headers and 64 listed stretches.
- Kept frames: 512 MiB a recording unless asked, at most 8 GiB.
- Ledgers stay in memory for running recordings and for up to 64 ended recordings until released. Each holds up to 200 000 entries with ids of up to 128 characters, so retained ledgers can reach gigabytes at their limits.

### Measured on this machine

These are single-machine measurements from the final proof, not speed claims:

- Spawn to greeting: median 67.6 ms over 10 starts. Protocol 1 took 2.2 ms; the greeting now waits up to 2 s for the encoder probe.
- Spawn to the first `started`: median 473 ms. Protocol 1 took 53.2 ms. Where the extra time goes was not profiled. Each start now reads the process table for ownership, in the media process and in the client.
- Media process CPU for the main recording: 0.13 s, including the live view's 30 JPEG encodings. Sampled peak RSS: 16.2 MB.

### Linux x64

Not built and not tested. The machine has no x86_64 Linux standard library for either Rust: Homebrew's 1.98.1 and rustup's toolchain carry only `aarch64-apple-darwin`. `cargo check --target x86_64-unknown-linux-gnu --offline` stops at "can't find crate for `core`" (`linux-cross-check.log`). There is no cross linker either. Docker was running during this session. The repository's image `retest-linux:dev` is linux/arm64 and has no cargo, rustc or ffmpeg (`linux-tools.log`), and no amd64 image with Rust is on the machine. Building either way needs downloads this lane was not given. With them, either of these would do it:

```sh
# In the brief's container route: an amd64 Rust image, emulated on this Mac.
docker run --rm --platform linux/amd64 --init --cap-drop ALL \
  --mount type=bind,src="$PWD/media",dst=/media,readonly \
  rust:1-trixie sh -c 'uname -m && cargo test --locked --manifest-path /media/Cargo.toml --target-dir /tmp/target'
# A cross build only, which cannot run the tests here:
rustup target add x86_64-unknown-linux-gnu   # plus a linker, for example cargo-zigbuild with zig
cargo zigbuild --release --target x86_64-unknown-linux-gnu --manifest-path media/Cargo.toml
```

By reading, the crate uses only POSIX calls and `ps` columns that Linux's procps also prints. That is not a build.

### Not shown

- Linux x64, as above.
- A filesystem without hard links, which is still shown only through the debug hook. A process killed during the copy into place leaves a partial copy at the video's path. This is written into `Started`'s documentation and is not fixed (`media/src/place.rs:75`).
- A stop the ownership rule refuses, shown only through a debug hook. On a real host this is an exec wrapper whose readable command changed after its first reading.
- On the encoded route, a frame ffmpeg cannot decode is still counted `shown` (`media/src/frame.rs:139`). The evidence becomes `partial` only through ffmpeg's error lines.
- The deadline fix was shown by unit tests only, not with an encoder exiting just inside its deadline.

## Second pass

Recorded on 6 October 2026 on the same machine. Five open faults are closed, a stop the ownership rule refused is now reached, and the copy fallback no longer writes into the video's path. Start-up was profiled and changed. Each fault has a test that failed against the code before its fix. The commands, logs and numbers are in the "Second pass" section of `../codex/phase-4/media-process-report.md`; the logs are in `/tmp/retest-media-restart/second/`.

- **Encoded route.** A frame handed to ffmpeg undecoded is still decoded once, and a frame that cannot be decoded is counted `undecodable` and never sent. It was counted `shown`.
- **Failed jobs.** A thumbnail or frame sequence that panics inside the process is answered with an `error` of code `job_failed`, the worker goes on, and its thumbnail output is no longer held. No reply came before.
- **Live view during the probe.** A live view asked for while its recording waits for the encoder probe begins with the recording. It was told the recording was over.
- **Kept frames.** A frame-sequence reader takes the kept-frames file the store itself opened, never its path again, so a new recording's file at the same output cannot be read as the old one's.
- **Duration cap.** A frame past the last video frame the recording's duration allows is `out_of_range`, with the end clipped. It was `shown` with no video frame.
- **The launch is stopped through its child handle.** `Ownership::stop` and `cleanup` stop the launch through the child handle it was spawned as, whatever its command now reads as. Every process found by pid keeps the identity check. An exec wrapper that became a program reading no input was left wedged before.
- **Copy fallback.** A filesystem without hard links gets its copy at `<path>.copying`, synced, then renamed to the path with a rename that refuses to replace a file: `renamex_np` with `RENAME_EXCL` on macOS, `renameat2` with `RENAME_NOREPLACE` on Linux. Where the filesystem cannot rename that way, the path is checked and then renamed. A process killed mid-copy leaves the `.copying` file and nothing at the path. `leftovers` lists and removes it, and a start refuses while it is there.
- **Start-up.**
  - The greeting no longer waits for the encoder probe; a start waits for it, as before.
  - The client reads the process table twice less at each `started`, since `groupFor` already reads it for the worker and the encoder's group.
  - Medians of 15 runs on a quiet lock:
    - raw spawn to greeting went from 52.1 to 1.7 ms;
    - a start sent at once now takes 81.1 ms instead of 25.3, since it waits for the probe;
    - through the client, record to `started` went from 394 to 281 ms, and spawn to greeting stayed at about 69 ms.
  - The proof's spawn to first `started` went from 473 to 360 ms, median of 10.

On the final binary these all passed:

- `cargo test`, three runs in a row: 88 unit and 48 process tests each time.
- clippy with and without the measuring feature, and fmt.
- The client tests: 32 of 32.
- The Chrome proof: complete evidence, all 90 frames checked against the frame map, 22 stretches checked, nothing left behind.

What is still not shown:

- Linux x64.
- The copy fallback on a real filesystem without hard links. It is shown through the debug hook, and the exclusive rename was shown on APFS by a unit test.
- The encoded route's cost after its new decode. The media CPU figures for that route in the measurements above came before the decode was added and no longer hold.
