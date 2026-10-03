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
