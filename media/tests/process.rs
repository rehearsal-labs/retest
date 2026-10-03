//! The media process as a client sees it, with a fake encoder in place of ffmpeg.
//!
//! The fake answers the codec question as ffmpeg does, then copies the raw frames it is sent into the output
//! file, fails, hangs or reads slowly, as `FAKE_MODE` says. A copied file shows exactly which pixels the process
//! wrote and in what order, which no real codec would. Real encoding is proven with ffmpeg by `proofs/media`.

#![cfg(unix)]

use std::fs;
use std::io::{Cursor, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(10);

const FAKE_ENCODER: &str = r#"#!/bin/sh
for argument; do last="$argument"; done
case "$*" in
  -encoders)
    echo "ffmpeg version fake-1 Copyright (c) nobody" >&2
    echo "Encoders:"
    echo " ------"
    case "${FAKE_ENCODERS:-libx264}" in *libx264*) echo " V....D libx264               fake H.264" ;; esac
    case "${FAKE_ENCODERS:-libx264}" in *libvpx*) echo " V....D libvpx                fake VP8" ;; esac
    exit 0 ;;
  *-formats*)
    echo "Formats:"
    echo " ---"
    case "${FAKE_FORMATS:-rawvideo mp4 webm}" in *rawvideo*) echo " DE  rawvideo        raw video" ;; esac
    case "${FAKE_FORMATS:-rawvideo mp4 webm}" in *mp4*) echo "  E  mp4             MP4" ;; esac
    case "${FAKE_FORMATS:-rawvideo mp4 webm}" in *webm*) echo "  E  webm            WebM" ;; esac
    exit 0 ;;
esac
echo "$@" > "$last.args"
case "${FAKE_MODE:-copy}" in
  copy) exec cat > "$last" ;;
  slow) sleep 1; exec cat > "$last" ;;
  fail) head -c 1 > /dev/null; echo "fake: cannot encode this" >&2; exit 3 ;;
  hang) exec sleep 60 ;;
esac
"#;

const NOT_FFMPEG: &str = "#!/bin/sh\necho \"notffmpeg: unknown option $1\" >&2\nexit 1\n";

// A wrapper that runs the fake as a child rather than replacing itself with it, as `/usr/bin/time` or a shell
// script without `exec` does, so the encoder's pid is the wrapper's and the real work is a grandchild.
const FORKING_WRAPPER: &str = "#!/bin/sh\n\"$FAKE_ENCODER_PATH\" \"$@\"\n";

struct Scratch {
    folder: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Scratch {
        let folder =
            std::env::temp_dir().join(format!("retest-media-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("the scratch folder is created");
        Scratch { folder }
    }

    fn script(&self, name: &str, body: &str) -> PathBuf {
        let path = self.folder.join(name);
        fs::write(&path, body).expect("the script is written");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("the script is executable");
        path
    }

    fn fake(&self) -> PathBuf {
        self.script("fake-ffmpeg", FAKE_ENCODER)
    }

    fn output(&self, name: &str) -> String {
        self.folder.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

struct Media {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: Receiver<Value>,
}

impl Media {
    fn spawn(ffmpeg: &Path, environment: &[(&str, &str)]) -> Media {
        let mut command = Command::new(env!("CARGO_BIN_EXE_retest-media"));
        command
            .arg("--ffmpeg")
            .arg(ffmpeg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (name, value) in environment {
            command.env(name, value);
        }
        let mut child = command.spawn().expect("the media process starts");
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let (sender, replies) = mpsc::channel();
        thread::spawn(move || {
            while let Some(reply) = read_reply(&mut stdout) {
                if sender.send(reply).is_err() {
                    return;
                }
            }
        });
        let mut media = Media {
            child,
            stdin,
            replies,
        };
        let hello = media.next();
        assert_eq!(hello["type"], "hello", "{hello}");
        media
    }

    fn send(&mut self, header: &Value, payload: &[u8]) {
        let header = serde_json::to_vec(header).expect("serialises");
        self.send_raw(&envelope(&header, payload));
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin.write_all(bytes).expect("the process reads its input");
        stdin.flush().expect("flushes");
    }

    fn start(&mut self, id: &str, output: &str, extra: &Value) -> Value {
        let mut header = json!({ "type": "start", "recordingId": id, "width": 4, "height": 2, "fps": 10, "output": output, "deadlineMs": 5000 });
        if let (Some(header), Some(extra)) = (header.as_object_mut(), extra.as_object()) {
            header.extend(extra.clone());
        }
        self.send(&header, &[]);
        self.next()
    }

    fn frame(&mut self, id: &str, timestamp_us: u64, format: &str, bytes: &[u8]) {
        self.send(&json!({ "type": "frame", "recordingId": id, "timestampUs": timestamp_us, "format": format }), bytes);
    }

    fn next(&mut self) -> Value {
        self.replies.recv_timeout(WAIT).expect("a reply arrives")
    }

    fn quiet_for(&mut self, duration: Duration) {
        if let Ok(reply) = self.replies.recv_timeout(duration) {
            panic!("expected no reply, received {reply}");
        }
    }

    fn close_input(&mut self) {
        drop(self.stdin.take());
    }

    fn exit(mut self) -> ExitStatus {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .expect("the process can be waited for")
            {
                return status;
            }
            assert!(Instant::now() < deadline, "the media process did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Media {
    // Encoders run in groups of their own, so a test that ends without a shutdown asks for one, letting the
    // process stop its encoders, before the process is killed.
    fn drop(&mut self) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(&envelope(br#"{"type":"shutdown"}"#, &[]));
        }
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn envelope(header: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(header);
    bytes.extend_from_slice(payload);
    bytes
}

fn read_reply(stdout: &mut impl Read) -> Option<Value> {
    let mut prefix = [0u8; 8];
    stdout.read_exact(&mut prefix).ok()?;
    let header_length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let payload_length = u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]);
    assert_eq!(payload_length, 0, "replies carry no payload");
    let mut header = vec![0u8; header_length];
    stdout.read_exact(&mut header).ok()?;
    Some(serde_json::from_slice(&header).expect("a reply is JSON"))
}

fn png(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(colour)))
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encodes");
    bytes.into_inner()
}

// Whether a process the media process started still exists. It reaps its encoders, so a gone one is not a zombie.
fn alive(started: &Value) -> bool {
    let pid = started["encoderPid"]
        .as_u64()
        .unwrap_or_else(|| panic!("no encoder pid in {started}"));
    pid_alive(&pid.to_string())
}

fn pid_alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

// Whether any process is left in the encoder's group, whose id is its pid.
fn group_alive(started: &Value) -> bool {
    let group = started["encoderPid"].as_i64().unwrap_or(0) as libc::pid_t;
    // SAFETY: kill(2) with signal 0 only checks that the group exists; it takes plain integers.
    unsafe { libc::kill(-group, 0) == 0 }
}

// The children of a process, as pgrep lists them.
fn children_of(started: &Value) -> Vec<String> {
    let pid = started["encoderPid"].to_string();
    let output = Command::new("pgrep")
        .args(["-P", &pid])
        .output()
        .expect("pgrep runs");
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn wait_for_children(started: &Value) -> Vec<String> {
    let deadline = Instant::now() + WAIT;
    loop {
        let children = children_of(started);
        if !children.is_empty() {
            return children;
        }
        assert!(Instant::now() < deadline, "the wrapper started no child");
        thread::sleep(Duration::from_millis(10));
    }
}

fn assert_counts_add_up(frames: &Value) {
    let count = |name: &str| {
        frames[name]
            .as_u64()
            .unwrap_or_else(|| panic!("{name} is a count in {frames}"))
    };
    let parts = [
        "outOfRange",
        "shown",
        "superseded",
        "dropped",
        "outOfOrder",
        "undecodable",
        "unprocessed",
    ];
    assert_eq!(
        count("received"),
        parts.iter().map(|name| count(name)).sum::<u64>(),
        "{frames}"
    );
}

#[test]
fn greets_with_its_protocol_and_version_then_says_bye() {
    let scratch = Scratch::new("greeting");
    let mut command = Command::new(env!("CARGO_BIN_EXE_retest-media"));
    let mut child = command
        .arg("--ffmpeg")
        .arg(scratch.fake())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("starts");
    let mut stdout = child.stdout.take().expect("piped");
    let hello = read_reply(&mut stdout).expect("a greeting");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        hello["target"]
            .as_str()
            .is_some_and(|target| target.contains('-')),
        "{hello}"
    );
    let mut stdin = child.stdin.take().expect("piped");
    stdin
        .write_all(&envelope(br#"{"type":"shutdown"}"#, &[]))
        .expect("writes");
    assert_eq!(
        read_reply(&mut stdout).expect("a bye"),
        json!({ "type": "bye", "stopped": 0 })
    );
    assert!(child.wait().expect("exits").success());
}

#[test]
fn each_frame_is_held_until_the_next_and_its_pixels_reach_the_encoder_in_order() {
    let scratch = Scratch::new("timeline");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("timeline");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(
        (
            started["type"].as_str(),
            started["codec"].as_str(),
            started["container"].as_str()
        ),
        (Some("started"), Some("h264"), Some("mp4"))
    );
    assert_eq!(started["path"], format!("{output}.mp4"));
    media.frame("r", 1_000_000, "png", &png(4, 2, [255, 0, 0]));
    media.frame("r", 1_100_000, "png", &png(4, 2, [0, 255, 0]));
    // Twice the size, so the process scales it down to the recording's 4 by 2.
    media.frame("r", 1_400_000, "png", &png(8, 4, [0, 0, 255]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 1_600_000 }),
        &[],
    );
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["path"], format!("{output}.mp4"));
    assert_eq!(ended["frames"]["received"], 3);
    assert_eq!(ended["frames"]["shown"], 3);
    assert_eq!(ended["frames"]["resized"], 1);
    assert_eq!(ended["outputFrames"], 6);
    assert_eq!(ended["durationUs"], 600_000);
    assert_eq!(ended["bytesToEncoder"], 6 * 4 * 2 * 3);
    assert_counts_add_up(&ended["frames"]);
    let written = fs::read(format!("{output}.mp4")).expect("the video is at its path");
    let frames: Vec<[u8; 3]> = written
        .chunks(4 * 2 * 3)
        .map(|frame| [frame[0], frame[1], frame[2]])
        .collect();
    let (red, green, blue) = ([255, 0, 0], [0, 255, 0], [0, 0, 255]);
    assert_eq!(frames, vec![red, green, green, green, blue, blue]);
    assert!(
        !Path::new(&format!("{output}.mp4.partial")).exists(),
        "the partial file became the video"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
}

#[test]
fn late_and_unreadable_frames_are_counted_not_shown() {
    let scratch = Scratch::new("counts");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("counts");
    media.start("r", &output, &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [9, 9, 9]));
    media.frame("r", 200_000, "png", b"these bytes are not a png");
    media.frame("r", 100_000, "png", &png(4, 2, [9, 9, 9]));
    media.frame("r", 300_000, "jpeg", &png(4, 2, [9, 9, 9]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["received"], 4);
    assert_eq!(ended["frames"]["shown"], 1);
    assert_eq!(
        ended["frames"]["undecodable"], 2,
        "garbage, and a png sent as jpeg"
    );
    assert_eq!(ended["frames"]["outOfOrder"], 1);
    assert_counts_add_up(&ended["frames"]);
}

#[test]
fn vp8_in_webm_is_chosen_when_libx264_is_missing() {
    let scratch = Scratch::new("vp8");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_ENCODERS", "libvpx")]);
    let output = scratch.output("vp8");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(
        (
            started["codec"].as_str(),
            started["container"].as_str(),
            started["encoder"].as_str()
        ),
        (Some("vp8"), Some("webm"), Some("libvpx"))
    );
    assert_eq!(started["path"], format!("{output}.webm"));
    assert_eq!(started["encoderVersion"], "ffmpeg version fake-1");
    media.frame("r", 0, "png", &png(4, 2, [1, 2, 3]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    assert_eq!(media.next()["status"], "ok");
    let arguments = fs::read_to_string(format!("{output}.webm.partial.args"))
        .expect("the fake wrote its arguments");
    assert!(
        arguments.contains("-c:v libvpx") && arguments.contains("-f webm"),
        "{arguments}"
    );
}

#[test]
fn an_encoder_with_neither_codec_is_unavailable() {
    let scratch = Scratch::new("unavailable");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_ENCODERS", "none")]);
    let ended = media.start("r", &scratch.output("unavailable"), &json!({}));
    assert_eq!(
        (ended["type"].as_str(), ended["status"].as_str()),
        (Some("ended"), Some("encoder_unavailable")),
        "{ended}"
    );
    let message = ended["message"].as_str().unwrap_or_default();
    assert!(
        message
            .contains("lacks H.264 (libx264 and the mp4 muxer) or VP8 (libvpx and the webm muxer)"),
        "{ended}"
    );
}

#[test]
fn an_encoder_that_cannot_read_raw_frames_is_unavailable_before_any_frame() {
    let scratch = Scratch::new("no-raw");
    let mut media = Media::spawn(
        &scratch.fake(),
        &[
            ("FAKE_ENCODERS", "libx264 libvpx"),
            ("FAKE_FORMATS", "mp4 webm"),
        ],
    );
    let ended = media.start("r", &scratch.output("no-raw"), &json!({}));
    assert_eq!(ended["status"], "encoder_unavailable", "{ended}");
    assert!(
        ended["message"]
            .as_str()
            .is_some_and(|message| message.ends_with("it lacks the rawvideo demuxer")),
        "{ended}"
    );
}

#[test]
fn h264_without_its_muxer_falls_to_vp8() {
    let scratch = Scratch::new("no-mp4");
    let mut media = Media::spawn(
        &scratch.fake(),
        &[
            ("FAKE_ENCODERS", "libx264 libvpx"),
            ("FAKE_FORMATS", "rawvideo webm"),
        ],
    );
    let started = media.start("r", &scratch.output("no-mp4"), &json!({}));
    assert_eq!(started["codec"], "vp8", "{started}");
}

#[test]
fn a_program_that_is_not_ffmpeg_fails_with_its_exit_code_and_last_lines() {
    let scratch = Scratch::new("not-ffmpeg");
    let mut media = Media::spawn(&scratch.script("notffmpeg", NOT_FFMPEG), &[]);
    let ended = media.start("r", &scratch.output("not-ffmpeg"), &json!({}));
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert_eq!(ended["encoder"]["exitCode"], 1);
    assert_eq!(
        ended["encoder"]["stderr"],
        json!(["notffmpeg: unknown option -encoders"])
    );
    assert!(
        ended["message"]
            .as_str()
            .is_some_and(|message| message.contains("did not answer as ffmpeg")),
        "{ended}"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
}

#[test]
fn a_missing_encoder_fails_to_start() {
    let scratch = Scratch::new("missing");
    let mut media = Media::spawn(Path::new("/no/such/ffmpeg"), &[]);
    let ended = media.start("r", &scratch.output("missing"), &json!({}));
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert!(
        ended["message"]
            .as_str()
            .is_some_and(|message| message.contains("could not be started")),
        "{ended}"
    );
    assert!(
        ended.get("encoder").is_none(),
        "nothing ran, so there is no exit to report: {ended}"
    );
}

#[test]
fn an_encoder_that_dies_mid_recording_ends_it_at_once() {
    let scratch = Scratch::new("dies");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "fail")]);
    let output = scratch.output("dies");
    media.start("r", &output, &json!({}));
    for index in 0..5 {
        media.frame("r", index * 100_000, "png", &png(4, 2, [5, 5, 5]));
    }
    let ended = media.next();
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert_eq!(ended["encoder"]["exitCode"], 3);
    assert_eq!(
        ended["encoder"]["stderr"],
        json!(["fake: cannot encode this"])
    );
    assert_counts_add_up(&ended["frames"]);
    // Late frames and a finish for an ended recording are ignored, not answered.
    media.frame("r", 900_000, "png", &png(4, 2, [5, 5, 5]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    media.quiet_for(Duration::from_millis(300));
    assert!(
        !Path::new(&format!("{output}.mp4.partial")).exists(),
        "the failed file was removed"
    );
    assert!(!Path::new(&format!("{output}.mp4")).exists());
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
}

#[test]
fn finishing_past_the_deadline_stops_the_encoder() {
    let scratch = Scratch::new("deadline");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "hang")]);
    let output = scratch.output("deadline");
    let started = media.start("r", &output, &json!({ "deadlineMs": 200 }));
    media.frame("r", 0, "png", &png(4, 2, [7, 7, 7]));
    let finished = Instant::now();
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    let waited = finished.elapsed();
    assert_eq!(ended["status"], "deadline_exceeded", "{ended}");
    assert_eq!(ended["encoder"]["signal"], 9);
    assert!(
        waited >= Duration::from_millis(200) && waited < Duration::from_secs(3),
        "ended after {waited:?}"
    );
    assert!(!alive(&started), "the encoder was stopped");
    assert!(!Path::new(&format!("{output}.mp4.partial")).exists());
}

#[test]
fn shutdown_stops_every_running_recording_and_leaves_no_encoder() {
    let scratch = Scratch::new("shutdown");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "hang")]);
    let (first, second) = (scratch.output("first"), scratch.output("second"));
    let started = [
        media.start("a", &first, &json!({})),
        media.start("b", &second, &json!({})),
    ];
    media.frame("a", 0, "png", &png(4, 2, [1, 1, 1]));
    media.frame("b", 0, "png", &png(4, 2, [2, 2, 2]));
    media.send(&json!({ "type": "shutdown" }), &[]);
    let replies = [media.next(), media.next(), media.next()];
    let stopped: Vec<&str> = replies
        .iter()
        .filter(|reply| reply["status"] == "stopped")
        .filter_map(|reply| reply["recordingId"].as_str())
        .collect();
    assert_eq!(stopped.len(), 2, "{replies:?}");
    assert_eq!(replies[2], json!({ "type": "bye", "stopped": 2 }));
    assert!(media.exit().success());
    for (output, started) in [&first, &second].into_iter().zip(&started) {
        assert!(!alive(started), "an encoder outlived the process");
        assert!(!Path::new(&format!("{output}.mp4.partial")).exists());
    }
}

#[test]
fn the_input_ending_shuts_the_process_down() {
    let scratch = Scratch::new("input-ends");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "hang")]);
    let output = scratch.output("input-ends");
    let started = media.start("r", &output, &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [3, 3, 3]));
    media.close_input();
    assert_eq!(media.next()["status"], "stopped");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 1 }));
    assert!(media.exit().success());
    assert!(!alive(&started), "the encoder outlived the process");
}

#[test]
fn bad_messages_are_answered_and_a_broken_stream_ends_the_process() {
    let scratch = Scratch::new("errors");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("errors");
    media.send_raw(&envelope(b"{not json", &[]));
    assert_eq!(media.next()["code"], "invalid_message");
    media.frame("nobody", 0, "png", &png(4, 2, [0, 0, 0]));
    let unknown = media.next();
    assert_eq!(
        (unknown["code"].as_str(), unknown["recordingId"].as_str()),
        (Some("unknown_recording"), Some("nobody"))
    );
    assert_eq!(
        media.start("odd", &output, &json!({ "width": 5 }))["code"],
        "invalid_start"
    );
    assert_eq!(media.start("r", &output, &json!({}))["type"], "started");
    assert_eq!(
        media.start("r", &output, &json!({}))["code"],
        "duplicate_recording"
    );
    let mut oversized = Vec::new();
    oversized.extend_from_slice(&(1u32 << 30).to_be_bytes());
    oversized.extend_from_slice(&0u32.to_be_bytes());
    media.send_raw(&oversized);
    assert_eq!(media.next()["code"], "protocol_violation");
    assert_eq!(media.next()["status"], "stopped");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 1 }));
    assert_eq!(media.exit().code(), Some(2));
}

#[test]
fn a_full_queue_drops_the_oldest_frames_and_counts_them() {
    let scratch = Scratch::new("queue");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "slow")]);
    let output = scratch.output("queue");
    // A 320 by 240 frame is 230 400 raw bytes, more than a pipe holds, so the first write blocks while the slow
    // encoder sleeps, and the reader keeps taking frames into a queue of two.
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 320, "height": 240, "fps": 30, "queueFrames": 2, "deadlineMs": 20_000 }),
    );
    assert_eq!(started["queueFrames"], 2);
    let frame = png(320, 240, [40, 80, 120]);
    for index in 0..20u64 {
        media.frame("r", index * 33_333, "png", &frame);
    }
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    let dropped = ended["frames"]["dropped"].as_u64().unwrap_or(0);
    assert!(
        dropped >= 10,
        "a queue of two dropped only {dropped} of 20: {ended}"
    );
    assert_counts_add_up(&ended["frames"]);
    let written = fs::metadata(format!("{output}.mp4"))
        .expect("the video is written")
        .len();
    assert_eq!(
        written,
        ended["outputFrames"].as_u64().unwrap_or(0) * 320 * 240 * 3
    );
}

#[test]
fn a_deadline_kills_the_whole_group_behind_a_forking_wrapper() {
    let scratch = Scratch::new("forking-deadline");
    let fake = scratch.fake();
    let wrapper = scratch.script("forking-ffmpeg", FORKING_WRAPPER);
    let fake_path = fake.to_string_lossy().into_owned();
    let mut media = Media::spawn(
        &wrapper,
        &[("FAKE_MODE", "hang"), ("FAKE_ENCODER_PATH", &fake_path)],
    );
    let output = scratch.output("forking-deadline");
    let started = media.start("r", &output, &json!({ "deadlineMs": 300 }));
    media.frame("r", 0, "png", &png(4, 2, [7, 7, 7]));
    // The real work is the wrapper's child; stop it, as a wedged encoder would be.
    let children = wait_for_children(&started);
    for child in &children {
        Command::new("kill")
            .args(["-STOP", child])
            .status()
            .expect("kill runs");
    }
    let finished = Instant::now();
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "deadline_exceeded", "{ended}");
    assert!(
        finished.elapsed() < Duration::from_secs(3),
        "ended after {:?}",
        finished.elapsed()
    );
    assert!(
        !group_alive(&started),
        "a process of the encoder's group outlived the deadline"
    );
    assert!(
        children.iter().all(|child| !pid_alive(child)),
        "the stopped grandchild survived"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
}

#[test]
fn a_shutdown_kills_the_whole_group_behind_a_forking_wrapper() {
    let scratch = Scratch::new("forking-shutdown");
    let fake = scratch.fake();
    let wrapper = scratch.script("forking-ffmpeg", FORKING_WRAPPER);
    let fake_path = fake.to_string_lossy().into_owned();
    let mut media = Media::spawn(
        &wrapper,
        &[("FAKE_MODE", "hang"), ("FAKE_ENCODER_PATH", &fake_path)],
    );
    let started = media.start("r", &scratch.output("forking-shutdown"), &json!({}));
    let children = wait_for_children(&started);
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["status"], "stopped");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 1 }));
    assert!(media.exit().success());
    assert!(!group_alive(&started));
    assert!(children.iter().all(|child| !pid_alive(child)));
}

#[test]
fn an_output_path_in_use_is_refused_by_name() {
    let scratch = Scratch::new("output-in-use");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let existing = scratch.output("existing");
    fs::write(format!("{existing}.mp4"), b"an earlier run's video").expect("writes");
    let refused = media.start("a", &existing, &json!({}));
    assert_eq!(refused["code"], "output_in_use", "{refused}");
    assert_eq!(
        refused["message"],
        format!("a file is already at {existing}.mp4")
    );
    let leftover = scratch.output("leftover");
    fs::write(format!("{leftover}.mp4.partial"), b"half a video").expect("writes");
    assert_eq!(
        media.start("b", &leftover, &json!({}))["code"],
        "output_in_use"
    );
    let shared = scratch.output("shared");
    assert_eq!(media.start("c", &shared, &json!({}))["type"], "started");
    let second = media.start("d", &shared, &json!({}));
    assert_eq!(second["code"], "output_in_use");
    assert_eq!(
        second["message"],
        format!("recording c is writing {shared}.mp4")
    );
    assert_eq!(
        fs::read(format!("{existing}.mp4")).expect("still there"),
        b"an earlier run's video"
    );
}

#[test]
fn a_file_that_appears_at_the_path_is_kept_and_so_is_the_video() {
    let scratch = Scratch::new("appears");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("appears");
    media.start("r", &output, &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [9, 9, 9]));
    fs::write(format!("{output}.mp4"), b"someone else's file").expect("writes");
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "output_failed", "{ended}");
    assert_eq!(ended["partialPath"], format!("{output}.mp4.partial"));
    assert!(ended.get("path").is_none());
    assert_eq!(
        fs::read(format!("{output}.mp4")).expect("left alone"),
        b"someone else's file"
    );
    assert_eq!(
        fs::read(format!("{output}.mp4.partial"))
            .expect("kept")
            .len(),
        4 * 2 * 3
    );
}

#[test]
fn a_start_that_cannot_be_read_is_refused_with_its_recording_id() {
    let scratch = Scratch::new("unreadable-start");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let refused = media.start("ntsc", &scratch.output("ntsc"), &json!({ "fps": 29.97 }));
    assert_eq!(
        (refused["code"].as_str(), refused["recordingId"].as_str()),
        (Some("invalid_message"), Some("ntsc")),
        "{refused}"
    );
    media.start("r", &scratch.output("r"), &json!({}));
    media.send(
        &json!({ "type": "frame", "recordingId": "r", "timestampUs": 1.5, "format": "png" }),
        &png(4, 2, [0, 0, 0]),
    );
    let lost = media.next();
    assert_eq!(
        (lost["code"].as_str(), lost["recordingId"].as_str()),
        (Some("invalid_message"), Some("r")),
        "{lost}"
    );
}

#[test]
fn a_frame_on_another_clock_is_refused_and_a_long_pause_is_shortened() {
    let scratch = Scratch::new("gaps");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("gaps");
    media.start(
        "r",
        &output,
        &json!({ "maxGapMs": 1000, "maxDurationMs": 60_000 }),
    );
    media.frame("r", 2_000_000, "png", b"not a png");
    media.frame("r", 3_000_000, "png", &png(4, 2, [255, 0, 0]));
    // Wall-clock microseconds, far past the recording's sixty seconds.
    media.frame("r", 1_759_000_000_000_000, "png", &png(4, 2, [0, 0, 255]));
    // Five seconds after the red frame: the pause is shortened to the one-second maximum.
    media.frame("r", 8_000_000, "png", &png(4, 2, [0, 255, 0]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 600_000_000 }),
        &[],
    );
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["outOfRange"], 1);
    assert_eq!(ended["frames"]["undecodable"], 1);
    assert_eq!(ended["firstTimestampUs"], 3_000_000);
    assert_eq!(ended["framesBeforeFirst"], 1);
    assert_eq!(
        ended["gaps"],
        json!([{ "captureUs": 8_000_000, "shortenedByUs": 4_000_000 }])
    );
    assert_eq!(ended["gapsShortened"], 1);
    assert_eq!(ended["endClipped"], true);
    assert_counts_add_up(&ended["frames"]);
    // At 10 fps: red for the one-second gap, then green for the one-second clip after it.
    let written = fs::read(format!("{output}.mp4")).expect("the video is written");
    let colours: Vec<u8> = written.chunks(4 * 2 * 3).map(|frame| frame[1]).collect();
    assert_eq!(colours, [vec![0; 10], vec![255; 10]].concat());
}

#[test]
fn an_encoder_that_stops_taking_frames_is_stopped_while_recording() {
    let scratch = Scratch::new("stall");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "hang")]);
    let output = scratch.output("stall");
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 320, "height": 240, "stallMs": 300 }),
    );
    // One raw frame is 230 400 bytes, more than the pipe holds, and the encoder reads none of it.
    let frame = png(320, 240, [1, 2, 3]);
    media.frame("r", 0, "png", &frame);
    media.frame("r", 100_000, "png", &frame);
    let sent = Instant::now();
    let ended = media.next();
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert_eq!(
        ended["message"],
        "the encoder took more than 300 ms to accept a frame and was stopped"
    );
    assert!(
        sent.elapsed() < Duration::from_secs(3),
        "ended after {:?}",
        sent.elapsed()
    );
    assert!(!group_alive(&started));
    assert_counts_add_up(&ended["frames"]);
}

#[test]
fn a_recording_whose_thread_fails_ends_without_another_message() {
    let scratch = Scratch::new("panic");
    let mut media = Media::spawn(
        &scratch.fake(),
        &[("FAKE_MODE", "hang"), ("RETEST_MEDIA_TEST_PANIC", "1")],
    );
    let started = media.start("r", &scratch.output("panic"), &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [1, 1, 1]));
    let sent = Instant::now();
    let ended = media.next();
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert_eq!(
        ended["message"],
        "the recording failed inside the media process; its frame counts are lost"
    );
    assert!(
        sent.elapsed() < Duration::from_secs(2),
        "ended after {:?}",
        sent.elapsed()
    );
    assert!(!group_alive(&started));
}

#[test]
fn a_shutdown_lets_a_finishing_recording_complete() {
    let scratch = Scratch::new("finishing");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "slow")]);
    let output = scratch.output("finishing");
    media.start("r", &output, &json!({ "deadlineMs": 5000 }));
    media.frame("r", 0, "png", &png(4, 2, [4, 4, 4]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    media.send(&json!({ "type": "shutdown" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
    assert!(Path::new(&format!("{output}.mp4")).exists());
}

#[test]
fn recordings_past_the_limit_are_refused() {
    let scratch = Scratch::new("limit");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    for index in 0..16 {
        let started = media.start(
            &format!("r{index}"),
            &scratch.output(&format!("r{index}")),
            &json!({}),
        );
        assert_eq!(started["type"], "started", "{started}");
    }
    let refused = media.start("r16", &scratch.output("r16"), &json!({}));
    assert_eq!(refused["code"], "too_many_recordings", "{refused}");
}
