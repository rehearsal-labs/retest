//! The media process as a client sees it, with a fake encoder in place of ffmpeg.
//!
//! The fake answers the codec questions as ffmpeg does, then copies the frames it is sent into the output file,
//! fails, hangs, reads slowly or prints a line first, as `FAKE_MODE` says. A copied file shows exactly which pixels
//! or images the process wrote and in what order, which no real codec would. Real encoding is proven with ffmpeg by
//! `proofs/media`.

#![cfg(unix)]

use std::fs;
use std::io::{Cursor, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(10);
static NEXT_FAKE: AtomicU64 = AtomicU64::new(1);

const FAKE_ENCODER: &str = r#"#!/bin/sh
for argument; do last="$argument"; done
case "$*" in
  -encoders)
    if [ -n "$FAKE_PROBE_SLEEP" ]; then sleep "$FAKE_PROBE_SLEEP"; fi
    echo "ffmpeg version fake-1 Copyright (c) nobody" >&2
    echo "Encoders:"
    echo " ------"
    case "${FAKE_ENCODERS:-libx264}" in *libx264*) echo " V....D libx264               fake H.264" ;; esac
    case "${FAKE_ENCODERS:-libx264}" in *libvpx*) echo " V....D libvpx                fake VP8" ;; esac
    exit 0 ;;
  *-formats*)
    echo "Formats:"
    echo " ---"
    case "${FAKE_FORMATS:-rawvideo mp4 webm image2pipe}" in *rawvideo*) echo " DE  rawvideo        raw video" ;; esac
    case "${FAKE_FORMATS:-rawvideo mp4 webm image2pipe}" in *mp4*) echo "  E  mp4             MP4" ;; esac
    case "${FAKE_FORMATS:-rawvideo mp4 webm image2pipe}" in *webm*) echo "  E  webm            WebM" ;; esac
    case "${FAKE_FORMATS:-rawvideo mp4 webm image2pipe}" in *image2pipe*) echo " DE  image2pipe      piped image2 sequence" ;; esac
    exit 0 ;;
  *-decoders*)
    echo "Decoders:"
    echo " ------"
    case "${FAKE_DECODERS:-png mjpeg}" in *png*) echo " VF..D. png                  PNG" ;; esac
    case "${FAKE_DECODERS:-png mjpeg}" in *mjpeg*) echo " VF..D. mjpeg                MJPEG" ;; esac
    exit 0 ;;
esac
echo "$@" > "$last.args"
case "${FAKE_MODE:-copy}" in
  copy) exec cat > "$last" ;;
  noisy) echo "fake: one frame could not be read" >&2; exec cat > "$last" ;;
  slow) sleep 1; exec cat > "$last" ;;
  fail) head -c 1 > /dev/null; echo "fake: cannot encode this" >&2; exit 3 ;;
  hang) sleep 60; while :; do :; done ;;
  exec-sleep) sleep 0.3; exec sleep 600 ;;
esac
"#;

const NOT_FFMPEG: &str = "#!/bin/sh\necho \"notffmpeg: unknown option $1\" >&2\nexit 1\n";

#[test]
fn encoder_environment_excludes_parent_judge_variables() {
    let scratch = Scratch::new("encoder-environment");
    let marker = scratch.output("environment");
    let script = format!(
        "#!/bin/sh\n/usr/bin/env > '{marker}'\n{body}",
        body = FAKE_ENCODER.strip_prefix("#!/bin/sh\n").unwrap()
    );
    let encoder = scratch.script("environment-ffmpeg", &script);
    let mut media = Media::spawn(
        &encoder,
        &[(
            "RETEST_SYNTHETIC_MEDIA_JUDGE_KEY",
            "synthetic-fixture-value",
        )],
    );
    media.send(&json!({"type":"ready"}), &[]);
    let ready = media.next();
    assert_eq!(ready["encoder"]["state"], "ready");
    media.send(&json!({"type":"shutdown"}), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
    let environment = fs::read_to_string(marker).expect("the fake encoder prints its environment");
    assert!(
        !environment
            .lines()
            .any(|line| line.starts_with("RETEST_SYNTHETIC_MEDIA_JUDGE_KEY=")),
        "the judge variable must not reach the encoder"
    );
    assert!(environment.lines().any(|line| line.starts_with("PATH=")));
}

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
    replies: Receiver<(Value, Vec<u8>)>,
    hello: Value,
    /// While set, nothing reads the process's output, as a client that has stopped reading.
    paused: Arc<AtomicBool>,
    frames_sent: u64,
}

fn identity() -> Value {
    json!({ "runId": "run-1", "attemptId": "a1", "testId": "tests/x.retest.ts > saves", "app": "web", "sessionId": "a1:web" })
}

impl Media {
    fn spawn(ffmpeg: &Path, environment: &[(&str, &str)]) -> Media {
        // Fake behavior belongs to the fixture script, not the production encoder environment.
        let settings: String = environment
            .iter()
            .filter(|(name, _)| name.starts_with("FAKE_"))
            .map(|(name, value)| format!("export {name}='{}'\n", value.replace('\'', "'\\''")))
            .collect();
        let configured = ffmpeg.with_file_name(format!(
            "configured-{}-{}",
            NEXT_FAKE.fetch_add(1, Ordering::Relaxed),
            ffmpeg.file_name().unwrap().to_string_lossy()
        ));
        let executable = if settings.is_empty() {
            ffmpeg
        } else {
            let body = fs::read_to_string(ffmpeg).expect("the fixture script can be read");
            fs::write(
                &configured,
                format!(
                    "#!/bin/sh\n{settings}{}",
                    body.strip_prefix("#!/bin/sh\n").unwrap()
                ),
            )
            .expect("the configured fixture is written");
            fs::set_permissions(&configured, fs::Permissions::from_mode(0o755))
                .expect("the fixture is executable");
            &configured
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_retest-media"));
        command.env_clear().env("PATH", "/usr/bin:/bin");
        command
            .arg("--ffmpeg")
            .arg(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (name, value) in environment {
            if !name.starts_with("FAKE_") {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().expect("the media process starts");
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let (sender, replies) = mpsc::channel();
        let paused = Arc::new(AtomicBool::new(false));
        let reading = Arc::clone(&paused);
        thread::spawn(move || {
            loop {
                while reading.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(5));
                }
                let Some(reply) = read_reply(&mut stdout) else {
                    return;
                };
                if sender.send(reply).is_err() {
                    return;
                }
            }
        });
        let mut media = Media {
            child,
            stdin,
            replies,
            hello: Value::Null,
            paused,
            frames_sent: 0,
        };
        let hello = media.next();
        assert_eq!(hello["type"], "hello", "{hello}");
        media.hello = hello;
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

    #[track_caller]
    fn start(&mut self, id: &str, output: &str, extra: &Value) -> Value {
        self.send_start(id, output, extra);
        self.next()
    }

    fn send_start(&mut self, id: &str, output: &str, extra: &Value) {
        let mut header = json!({ "type": "start", "recordingId": id, "identity": identity(), "width": 4, "height": 2, "fps": 10, "output": output, "deadlineMs": 5000 });
        if let (Some(header), Some(extra)) = (header.as_object_mut(), extra.as_object()) {
            header.extend(extra.clone());
        }
        self.send(&header, &[]);
    }

    // Sends a frame with an id of its own: `f1`, `f2`, and so on, in the order sent.
    fn frame(&mut self, id: &str, timestamp_us: u64, format: &str, bytes: &[u8]) {
        self.frames_sent += 1;
        let frame_id = format!("f{}", self.frames_sent);
        self.frame_with_id(id, &frame_id, timestamp_us, format, bytes);
    }

    fn frame_with_id(
        &mut self,
        id: &str,
        frame_id: &str,
        timestamp_us: u64,
        format: &str,
        bytes: &[u8],
    ) {
        self.send(&json!({ "type": "frame", "recordingId": id, "frameId": frame_id, "timestampUs": timestamp_us, "format": format }), bytes);
    }

    #[track_caller]
    fn next(&mut self) -> Value {
        self.next_with_payload().0
    }

    #[track_caller]
    fn next_with_payload(&mut self) -> (Value, Vec<u8>) {
        self.replies.recv_timeout(WAIT).expect("a reply arrives")
    }

    // The next reply of a type, with every reply before it.
    #[track_caller]
    fn next_of(&mut self, kind: &str) -> ((Value, Vec<u8>), Vec<Value>) {
        let mut before = Vec::new();
        loop {
            let reply = self.next_with_payload();
            if reply.0["type"] == kind {
                return (reply, before);
            }
            before.push(reply.0);
        }
    }

    fn quiet_for(&mut self, duration: Duration) {
        if let Ok((reply, _)) = self.replies.recv_timeout(duration) {
            panic!("expected no reply, received {reply}");
        }
    }

    fn pause_reading(&self, paused: bool) {
        self.paused.store(paused, Ordering::Release);
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

fn read_reply(stdout: &mut impl Read) -> Option<(Value, Vec<u8>)> {
    let mut prefix = [0u8; 8];
    stdout.read_exact(&mut prefix).ok()?;
    let header_length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let payload_length = u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]) as usize;
    assert!(
        header_length <= 64 * 1024,
        "a reply header of {header_length} bytes"
    );
    let mut header = vec![0u8; header_length];
    stdout.read_exact(&mut header).ok()?;
    let mut payload = vec![0u8; payload_length];
    stdout.read_exact(&mut payload).ok()?;
    let header: Value = serde_json::from_slice(&header).expect("a reply is JSON");
    let carries = ["ended", "frames", "live"].contains(&header["type"].as_str().unwrap_or(""));
    assert!(
        carries || payload.is_empty(),
        "only an ending, a frame sequence or a live frame carries bytes: {header}"
    );
    Some((header, payload))
}

fn jpeg(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(colour)))
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .expect("encodes");
    bytes.into_inner()
}

// The frame map an ending carries as its payload.
fn frame_map(payload: &[u8]) -> Vec<Value> {
    serde_json::from_slice::<Vec<Value>>(payload).expect("the frame map is a JSON array")
}

fn png(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(colour)))
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encodes");
    bytes.into_inner()
}

#[test]
fn odd_height_screenshot_frames_finish_without_loss_inside_their_budget() {
    // Firefox on this host captures 1366 by 683; the H.264 canvas needs an even height.
    // Exercise the real decode/resize/queue/finalization lifecycle without a browser or codec.
    let scratch = Scratch::new("odd-height-screenshots");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("screenshots");
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 1366, "height": 682, "fps": 10, "deadlineMs": 5000 }),
    );
    let screenshot = png(1366, 683, [30, 50, 70]);
    for index in 0..24u64 {
        media.frame("r", index * 100_000, "png", &screenshot);
    }
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 2_400_000 }),
        &[],
    );
    let (ended, payload) = media.next_with_payload();
    eprintln!("odd-height screenshot ending: {ended}");
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["evidence"]["status"], "complete", "{ended}");
    assert_eq!(ended["frames"]["received"], 24);
    assert_eq!(ended["frames"]["shown"], 24);
    assert_eq!(ended["frames"]["resized"], 24);
    assert_eq!(ended["frames"]["dropped"], 0);
    assert_eq!(ended["frames"]["unprocessed"], 0);
    assert_eq!(ended["outputFrames"], 24);
    let map = frame_map(&payload);
    assert_eq!(map.len(), 24);
    assert!(map.iter().all(|entry| entry["fate"] == "shown"));
    let video = fs::read(format!("{output}.mp4")).expect("finalized output is readable");
    let frame_bytes = 1366 * 682 * 3;
    assert_eq!(video.len(), 24 * frame_bytes);
    for frame in video.chunks_exact(frame_bytes) {
        let row = &frame[341 * 1366 * 3..342 * 1366 * 3];
        assert_eq!(&row[..3], &[0, 0, 0], "left padding");
        assert_eq!(&row[row.len() - 3..], &[0, 0, 0], "right padding");
        assert_eq!(&row[683 * 3..684 * 3], &[30, 50, 70], "source pixels");
    }
    assert!(!alive(&started));
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
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
        "duplicate",
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
    let (hello, _) = read_reply(&mut stdout).expect("a greeting");
    assert_eq!(hello["protocol"], 2);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        hello["build"]["target"]
            .as_str()
            .is_some_and(|target| target.contains('-')),
        "{hello}"
    );
    assert_eq!(
        hello["build"]["profile"], "debug",
        "cargo test runs the debug build"
    );
    let mut stdin = child.stdin.take().expect("piped");
    stdin
        .write_all(&envelope(br#"{"type":"ready"}"#, &[]))
        .expect("asks for readiness");
    let ready = read_reply(&mut stdout).expect("a readiness answer").0;
    assert_eq!(ready["type"], "ready");
    if hello["encoder"]["state"] != "probing" {
        assert_eq!(
            hello["encoder"], ready["encoder"],
            "a completed greeting agrees with readiness"
        );
    }
    assert_eq!(
        ready["encoder"],
        json!({ "state": "ready", "version": "ffmpeg version fake-1", "codec": "h264", "container": "mp4", "encoder": "libx264", "encodedInput": ["png", "jpeg"], "probeMs": ready["encoder"]["probeMs"] }),
        "readiness waited for the probe"
    );
    stdin
        .write_all(&envelope(br#"{"type":"shutdown"}"#, &[]))
        .expect("writes");
    assert_eq!(
        read_reply(&mut stdout).expect("a bye").0,
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
    let mut media = Media::spawn(
        &scratch.fake(),
        &[
            ("FAKE_ENCODERS", "none"),
            ("RETEST_MEDIA_TEST_FAIL_SELECTION_ONCE", "1"),
        ],
    );
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
fn concurrent_fast_probes_keep_the_missing_codec_result_and_clean_exit() {
    let workers: Vec<_> = (0..16)
        .map(|index| {
            thread::spawn(move || {
                let scratch = Scratch::new(&format!("fast-no-codec-{index}"));
                let mut media = Media::spawn(&scratch.fake(), &[("FAKE_ENCODERS", "none")]);
                let ended = media.start("r", &scratch.output("unavailable"), &json!({}));
                assert_eq!(ended["status"], "encoder_unavailable", "{ended}");
                assert!(ended["message"].as_str().is_some_and(|message| message.contains("lacks H.264 (libx264 and the mp4 muxer) or VP8 (libvpx and the webm muxer)")), "{ended}");
                assert_eq!(ended["evidence"]["status"], "unavailable", "{ended}");
                media.send(&json!({ "type": "shutdown" }), &[]);
                assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
                assert!(media.exit().success());
            })
        })
        .collect();
    let failed = workers
        .into_iter()
        .map(|worker| worker.join())
        .filter(Result::is_err)
        .count();
    assert_eq!(
        failed, 0,
        "every owned fast probe must retain its result and finish cleanup"
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
fn slow_or_stuck_file_finalization_is_deadline_exceeded_with_the_partial_named() {
    for (name, delay) in [("slow-finalize", "1000"), ("stuck-finalize", "600000")] {
        let scratch = Scratch::new(name);
        let mut media = Media::spawn(
            &scratch.fake(),
            &[
                ("RETEST_MEDIA_TEST_FINALIZE_DELAY_MS", delay),
                ("RETEST_MEDIA_TEST_NO_HARD_LINKS", "1"),
            ],
        );
        let output = scratch.output(name);
        media.start("r", &output, &json!({ "deadlineMs": 400 }));
        media.frame("r", 0, "png", &png(4, 2, [7, 7, 7]));
        let finished = Instant::now();
        media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
        let ended = media
            .replies
            .recv_timeout(Duration::from_secs(2))
            .expect("finalization cannot hold the ending")
            .0;
        assert_eq!(ended["status"], "deadline_exceeded", "{name}: {ended}");
        assert_eq!(ended["partialPath"], format!("{output}.mp4.partial"));
        assert!(Path::new(&format!("{output}.mp4.partial")).exists());
        assert!(
            !Path::new(&format!("{output}.mp4")).exists(),
            "no late completed artifact"
        );
        assert!(finished.elapsed() < Duration::from_secs(2));
        media.send(&json!({ "type": "shutdown" }), &[]);
        assert_eq!(media.next()["type"], "bye");
        assert!(media.exit().success());
    }
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
    assert_eq!(started["type"], "started", "{started}");
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
    assert_eq!(started["type"], "started", "{started}");
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
    // Once the running encoder has created its `.partial` file, both reasons hold; the running recording is named.
    let partial = format!("{shared}.mp4.partial");
    let deadline = Instant::now() + WAIT;
    while !Path::new(&partial).exists() {
        assert!(
            Instant::now() < deadline,
            "the encoder never created {partial}"
        );
        thread::sleep(Duration::from_millis(10));
    }
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
fn an_encoder_no_stop_can_reach_holds_no_shutdown_forever_and_gets_no_made_up_ending() {
    let scratch = Scratch::new("unstoppable");
    let mut media = Media::spawn(
        &scratch.fake(),
        &[
            ("FAKE_MODE", "hang"),
            ("RETEST_MEDIA_TEST_REFUSE_STOPS", "1"),
        ],
    );
    let started = media.start(
        "r",
        &scratch.output("unstoppable"),
        &json!({ "width": 320, "height": 240, "stallMs": 300, "deadlineMs": 500 }),
    );
    assert_eq!(started["type"], "started", "{started}");
    // More raw bytes than the pipe holds, to an encoder that reads none: the encoder thread waits in its write.
    let frame = png(320, 240, [1, 2, 3]);
    media.frame("r", 0, "png", &frame);
    media.frame("r", 100_000, "png", &frame);
    media.quiet_for(Duration::from_millis(1500));
    let asked = Instant::now();
    media.send(&json!({ "type": "shutdown" }), &[]);
    let mut before = Vec::new();
    let bye = loop {
        let (reply, _) = media
            .replies
            .recv_timeout(Duration::from_secs(25))
            .expect("bye arrives although the encoder could not be stopped");
        if reply["type"] == "bye" {
            break reply;
        }
        before.push(reply);
    };
    assert!(
        asked.elapsed() < Duration::from_secs(20),
        "bye after {:?}",
        asked.elapsed()
    );
    assert!(
        before.iter().all(|reply| reply["type"] != "ended"),
        "an ending was made up for a recording that never ended: {before:?}"
    );
    assert_eq!(bye["stopped"], 0);
    let encoder = started["encoderPid"].as_i64().unwrap_or(0);
    assert!(
        alive(&started),
        "the encoder was stopped after all, so the test did not refuse the stop"
    );
    assert!(media.exit().success());
    // The client reclaims what the process could not stop; here the test does.
    Command::new("kill")
        .args(["-KILL", &format!("-{encoder}")])
        .status()
        .expect("the encoder group is killed");
    let deadline = Instant::now() + WAIT;
    while group_alive(&started) {
        assert!(
            Instant::now() < deadline,
            "the encoder group outlived the test"
        );
        thread::sleep(Duration::from_millis(10));
    }
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

// Asks for the frames of `id` between two capture times, as a frame sequence request does.
fn frames_request(request_id: &str, id: &str, from_us: u64, to_us: u64, extra: &Value) -> Value {
    let mut header = json!({ "type": "frames", "requestId": request_id, "recordingId": id, "fromUs": from_us, "toUs": to_us, "maxFrames": 8, "maxWidth": 64, "maxHeight": 64 });
    if let (Some(header), Some(extra)) = (header.as_object_mut(), extra.as_object()) {
        header.extend(extra.clone());
    }
    header
}

// Asks for frames until `available` reaches `count`, since the encoder thread keeps each frame a moment after it
// arrives.
fn frames_once_kept(media: &mut Media, id: &str, count: u64, request: Value) -> (Value, Vec<u8>) {
    let deadline = Instant::now() + WAIT;
    loop {
        media.send(&request, &[]);
        let (reply, _) = media.next_of("frames");
        if reply.0["available"].as_u64() >= Some(count) {
            return reply;
        }
        assert!(
            Instant::now() < deadline,
            "{id} kept only {} of {count} frames",
            reply.0["available"]
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn decoded_size(bytes: &[u8], format: ImageFormat) -> (u32, u32) {
    let image = image::load_from_memory_with_format(bytes, format).expect("an image");
    (image.width(), image.height())
}

#[test]
fn the_ending_maps_every_frame_by_id_to_video_time_and_names_duplicates() {
    let scratch = Scratch::new("frame-map");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("frame-map");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(started["identity"], identity());
    assert_eq!(started["route"], "decoded");
    assert_eq!(started["framesPath"], format!("{output}.frames"));
    let (red, green, blue) = ([255, 0, 0], [0, 255, 0], [0, 0, 255]);
    media.frame_with_id("r", "f1", 1_000_000, "png", &png(4, 2, red));
    // On the same tick as f1 at 10 fps, so f1 is superseded.
    media.frame_with_id("r", "f2", 1_020_000, "png", &png(4, 2, green));
    media.frame_with_id("r", "f3", 1_300_000, "png", &png(4, 2, blue));
    media.frame_with_id("r", "f3", 1_400_000, "png", &png(4, 2, red));
    media.frame_with_id("r", "f5", 1_500_000, "png", b"not a png");
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 1_600_000 }),
        &[],
    );
    let (ended, payload) = media.next_with_payload();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["identity"], identity());
    assert_eq!(ended["frames"]["received"], 5);
    assert_eq!(ended["frames"]["shown"], 2);
    assert_eq!(ended["frames"]["superseded"], 1);
    assert_eq!(ended["frames"]["duplicate"], 1);
    assert_eq!(ended["frames"]["undecodable"], 1);
    assert_counts_add_up(&ended["frames"]);
    assert_eq!(
        ended["evidence"],
        json!({ "status": "partial", "reasons": ["frames_undecodable", "frames_duplicate"] })
    );
    assert_eq!(ended["frameMapEntries"], 5);
    assert_eq!(ended["frameMapOmitted"], 0);
    assert_eq!(
        frame_map(&payload),
        vec![
            json!({ "frameId": "f1", "captureUs": 1_000_000, "fate": "superseded" }),
            json!({ "frameId": "f2", "captureUs": 1_020_000, "fate": "shown", "videoUs": 0, "outputFrames": 3 }),
            json!({ "frameId": "f3", "captureUs": 1_300_000, "fate": "shown", "videoUs": 300_000, "outputFrames": 3 }),
            json!({ "frameId": "f3", "captureUs": 1_400_000, "fate": "duplicate" }),
            json!({ "frameId": "f5", "captureUs": 1_500_000, "fate": "undecodable" }),
        ]
    );
    let written = fs::read(format!("{output}.mp4")).expect("the video is written");
    let colours: Vec<[u8; 3]> = written
        .chunks(4 * 2 * 3)
        .map(|frame| [frame[0], frame[1], frame[2]])
        .collect();
    assert_eq!(
        colours,
        vec![green, green, green, blue, blue, blue],
        "the frame map says what the video holds"
    );
}

#[test]
fn a_sequence_names_capture_gaps_omitted_after_the_retained_list_fills() {
    let scratch = Scratch::new("gap-overflow");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    media.start("overflow", &scratch.output("overflow"), &json!({}));
    for index in 0..1024u64 {
        media.send(&json!({ "type": "captureGap", "recordingId": "overflow", "fromUs": index, "toUs": index + 1, "reason": "capture_failed" }), &[]);
    }
    let image = png(4, 4, [30, 40, 50]);
    media.frame("overflow", 2_000_000, "png", &image);
    media.send(&json!({ "type": "captureGap", "recordingId": "overflow", "fromUs": 2_100_000, "toUs": 2_200_000, "reason": "capture_failed" }), &[]);
    media.frame("overflow", 2_300_000, "png", &image);
    media.send(
        &json!({ "type": "finish", "recordingId": "overflow", "endTimestampUs": 2_400_000 }),
        &[],
    );
    assert_eq!(media.next()["type"], "ended");
    media.send(
        &frames_request(
            "overflow-frames",
            "overflow",
            2_000_000,
            2_300_000,
            &json!({ "minGapUs": 1 }),
        ),
        &[],
    );
    let sequence = media.next();
    assert_eq!(sequence["status"], "ok");
    assert_eq!(sequence["available"], 2);
    assert_eq!(sequence["frames"].as_array().unwrap().len(), 2);
    assert_eq!(
        sequence["captureGapsOmitted"], 1,
        "the omitted gap may overlap this interval: {sequence}"
    );
    assert!(
        sequence["message"]
            .as_str()
            .is_some_and(|message| message.contains("capture gaps omitted")),
        "older readers must also see the missing-evidence warning: {sequence}"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
}

#[test]
fn capture_gaps_are_named_in_the_ending_and_make_the_evidence_partial() {
    let scratch = Scratch::new("capture-gaps");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    media.start("r", &scratch.output("capture-gaps"), &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [1, 1, 1]));
    media.send(&json!({ "type": "captureGap", "recordingId": "r", "fromUs": 100_000, "toUs": 900_000, "reason": "capture_failed" }), &[]);
    media.send(&json!({ "type": "captureGap", "recordingId": "r", "fromUs": 1, "toUs": 2, "reason": "Free text with spaces" }), &[]);
    let refused = media.next();
    assert_eq!(
        (
            refused["code"].as_str(),
            refused["request"].as_str(),
            refused["recordingId"].as_str()
        ),
        (Some("invalid_message"), Some("captureGap"), Some("r")),
        "{refused}"
    );
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 1_000_000 }),
        &[],
    );
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(
        ended["captureGaps"],
        json!([{ "fromUs": 100_000, "toUs": 900_000, "reason": "capture_failed" }])
    );
    assert_eq!(ended["captureGapsReported"], 1);
    assert_eq!(
        ended["evidence"],
        json!({ "status": "partial", "reasons": ["capture_gaps"] })
    );
}

#[test]
fn a_start_before_the_probe_answers_waits_without_holding_the_loop() {
    let scratch = Scratch::new("slow-probe");
    let spawned = Instant::now();
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_PROBE_SLEEP", "3")]);
    let greeted = spawned.elapsed();
    assert_eq!(
        media.hello["encoder"],
        json!({ "state": "probing" }),
        "{}",
        media.hello
    );
    // The greeting no longer waits for the probe, which sleeps three seconds here; a start waits for it instead.
    assert!(
        greeted < Duration::from_secs(1),
        "greeted after {greeted:?}"
    );
    media.send_start("r", &scratch.output("slow-probe"), &json!({}));
    media.send(&json!({ "type": "ready" }), &[]);
    let asked = Instant::now();
    media.send(&json!({ "type": "leftovers", "requestId": "q1", "output": scratch.output("elsewhere"), "remove": false }), &[]);
    let leftovers = media.next();
    assert_eq!(
        leftovers["type"], "leftovers",
        "the loop answered while the start waited: {leftovers}"
    );
    assert!(
        asked.elapsed() < Duration::from_millis(500),
        "answered after {:?}",
        asked.elapsed()
    );
    let ready = media.next();
    assert_eq!(ready["type"], "ready", "{ready}");
    assert_eq!(ready["encoder"]["state"], "ready");
    assert!(
        ready["encoder"]["probeMs"]
            .as_u64()
            .is_some_and(|ms| ms >= 3000),
        "{ready}"
    );
    let started = media.next();
    assert_eq!(
        started["type"], "started",
        "the waiting start began once the probe answered: {started}"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["status"], "stopped");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 1 }));
}

#[test]
fn a_shutdown_while_the_probe_runs_ends_the_waiting_start_stopped() {
    let scratch = Scratch::new("probe-shutdown");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_PROBE_SLEEP", "3")]);
    media.send_start("r", &scratch.output("probe-shutdown"), &json!({}));
    media.send(&json!({ "type": "shutdown" }), &[]);
    let ended = media.next();
    assert_eq!(
        (ended["type"].as_str(), ended["status"].as_str()),
        (Some("ended"), Some("stopped")),
        "{ended}"
    );
    assert_eq!(
        ended["evidence"],
        json!({ "status": "unavailable", "reasons": ["stopped"] })
    );
    assert_eq!(ended["identity"], identity());
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
}

#[test]
fn frames_are_returned_from_a_running_and_an_ended_recording_until_released() {
    let scratch = Scratch::new("sequence");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("sequence");
    media.start("r", &output, &json!({}));
    let (red, green, blue) = ([250, 0, 0], [0, 250, 0], [0, 0, 250]);
    media.frame_with_id("r", "f1", 0, "png", &png(4, 2, red));
    media.frame_with_id("r", "f2", 100_000, "png", &png(4, 2, green));
    media.frame_with_id("r", "f3", 200_000, "png", &png(4, 2, blue));
    let (running, images) = frames_once_kept(
        &mut media,
        "r",
        3,
        frames_request(
            "q1",
            "r",
            0,
            200_000,
            &json!({ "maxFrames": 2, "maxWidth": 2, "maxHeight": 2, "format": "png" }),
        ),
    );
    assert_eq!(running["status"], "ok", "{running}");
    assert_eq!(running["recording"], "running");
    assert_eq!(
        (
            running["inInterval"].as_u64(),
            running["available"].as_u64()
        ),
        (Some(3), Some(3))
    );
    assert_eq!(
        running["omitted"],
        json!({ "byCount": 1, "byBytes": 0, "undecodable": 0 }),
        "two of three, chosen evenly"
    );
    let returned = running["frames"].as_array().expect("frames");
    let ids: Vec<&str> = returned
        .iter()
        .filter_map(|frame| frame["frameId"].as_str())
        .collect();
    assert_eq!(ids, ["f1", "f2"]);
    assert_eq!(returned[0]["fate"], "shown");
    assert_eq!(
        (
            returned[0]["width"].as_u64(),
            returned[0]["height"].as_u64(),
            returned[0]["sourceWidth"].as_u64()
        ),
        (Some(2), Some(1), Some(4))
    );
    let first_length = returned[0]["byteLength"].as_u64().expect("a length") as usize;
    let first = image::load_from_memory_with_format(&images[..first_length], ImageFormat::Png)
        .expect("a png")
        .to_rgb8();
    assert_eq!(
        first.get_pixel(0, 0).0,
        red,
        "the first frame is the red one, fitted"
    );
    assert_eq!(
        images.len() as u64,
        returned
            .iter()
            .filter_map(|frame| frame["byteLength"].as_u64())
            .sum::<u64>()
    );
    // A later stretch with no frame is named, and nothing about the screen is claimed for it.
    media.send(&frames_request("q2", "r", 0, 2_000_000, &json!({})), &[]);
    let (wide, _) = media.next_of("frames");
    assert_eq!(
        wide.0["stretches"],
        json!([{ "fromUs": 200_000, "toUs": 2_000_000, "lost": { "dropped": 0, "undecodable": 0, "outOfOrder": 0, "outOfRange": 0, "duplicate": 0, "queued": 0, "notStored": 0 }, "captureGaps": [] }])
    );
    assert_eq!(wide.0["stretchesFound"], 1);
    media.send(&json!({ "type": "release", "recordingId": "r" }), &[]);
    let refused = media.next();
    assert_eq!(
        (refused["code"].as_str(), refused["request"].as_str()),
        (Some("recording_running"), Some("release")),
        "{refused}"
    );
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 300_000 }),
        &[],
    );
    assert_eq!(media.next_of("ended").0.0["status"], "ok");
    media.send(&frames_request("q3", "r", 0, 200_000, &json!({})), &[]);
    let (ended, _) = media.next_of("frames");
    assert_eq!(
        (ended.0["recording"].as_str(), ended.0["available"].as_u64()),
        (Some("ended"), Some(3)),
        "{}",
        ended.0
    );
    let fates: Vec<&str> = ended.0["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .filter_map(|frame| frame["fate"].as_str())
        .collect();
    assert_eq!(fates, ["shown", "shown", "shown"]);
    assert!(Path::new(&format!("{output}.frames")).exists());
    media.send(&json!({ "type": "release", "recordingId": "r" }), &[]);
    let released = media.next();
    assert_eq!(
        released,
        json!({ "type": "released", "recordingId": "r", "reason": "requested", "removed": [format!("{output}.frames")] })
    );
    assert!(
        !Path::new(&format!("{output}.frames")).exists(),
        "the kept frames are gone"
    );
    media.send(&frames_request("q4", "r", 0, 200_000, &json!({})), &[]);
    assert_eq!(media.next()["status"], "released");
    media.send(&frames_request("q5", "nobody", 0, 1, &json!({})), &[]);
    let unknown = media.next();
    assert_eq!(
        (unknown["code"].as_str(), unknown["requestId"].as_str()),
        (Some("unknown_recording"), Some("q5")),
        "{unknown}"
    );
}

#[test]
fn an_ended_recording_can_be_released_before_its_worker_returns() {
    let scratch = Scratch::new("ended-worker-release");
    let mut media = Media::spawn(
        &scratch.fake(),
        &[("RETEST_MEDIA_TEST_HOLD_ENDED_THREAD", "1")],
    );
    let output = scratch.output("recording");
    media.start("r", &output, &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [1, 2, 3]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next_of("ended").0.0;
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["evidence"]["status"], "complete", "{ended}");
    media.send(&json!({ "type": "release", "recordingId": "r" }), &[]);
    let released = media.next();
    assert_eq!(
        released,
        json!({ "type": "released", "recordingId": "r", "reason": "requested", "removed": [format!("{output}.frames")] })
    );
    assert!(!Path::new(&format!("{output}.frames")).exists());
    media.send(&frames_request("q1", "r", 0, 100_000, &json!({})), &[]);
    assert_eq!(media.next()["status"], "released");
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
}

#[test]
fn a_recording_that_keeps_no_frames_says_so_and_leaves_no_file() {
    let scratch = Scratch::new("not-kept");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("not-kept");
    let started = media.start("r", &output, &json!({ "keepFrames": false }));
    assert!(started.get("framesPath").is_none(), "{started}");
    media.frame("r", 0, "png", &png(4, 2, [1, 1, 1]));
    media.send(&frames_request("q1", "r", 0, 10, &json!({})), &[]);
    let running = media.next();
    assert_eq!(
        (running["status"].as_str(), running["recording"].as_str()),
        (Some("not_kept"), Some("running")),
        "{running}"
    );
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    assert_eq!(media.next()["status"], "ok");
    media.send(&frames_request("q2", "r", 0, 10, &json!({})), &[]);
    let ended = media.next();
    assert_eq!(
        (ended["status"].as_str(), ended["recording"].as_str()),
        (Some("not_kept"), Some("ended")),
        "{ended}"
    );
    assert!(!Path::new(&format!("{output}.frames")).exists());
}

#[test]
fn frames_of_a_recording_whose_encoder_died_are_still_returned() {
    let scratch = Scratch::new("died-frames");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "fail")]);
    media.start("r", &scratch.output("died-frames"), &json!({}));
    for index in 0..5 {
        media.frame("r", index * 100_000, "png", &png(4, 2, [5, 5, 5]));
    }
    let ended = media.next_of("ended").0.0;
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert_eq!(ended["evidence"]["status"], "unavailable");
    media.send(&frames_request("q1", "r", 0, 1_000_000, &json!({})), &[]);
    let frames = media.next_of("frames").0.0;
    assert_eq!(frames["status"], "ok", "{frames}");
    assert!(
        frames["available"].as_u64().is_some_and(|kept| kept >= 1),
        "the frames taken before the encoder died are kept: {frames}"
    );
    assert_eq!(frames["recording"], "ended");
    let returned = frames["frames"].as_array().expect("frames");
    let fates: Vec<&str> = returned
        .iter()
        .map(|frame| frame["fate"].as_str().unwrap_or(""))
        .collect();
    assert!(
        fates
            .iter()
            .all(|fate| ["shown", "superseded", "unprocessed"].contains(fate)),
        "an ended recording has no pending frame: {fates:?}"
    );
    // The frame the encoder was given last never reached a video: it is named as such, not as still to come.
    assert_eq!(fates.last(), Some(&"unprocessed"), "{frames}");
}

#[test]
fn a_sequence_of_frames_with_the_longest_ids_stays_within_the_header_limit() {
    let scratch = Scratch::new("long-ids");
    // Admit the whole burst while the worker is still preparing its first frame. The header requirement must
    // hold independently of which platform schedules that worker first.
    let mut media = Media::spawn(
        &scratch.fake(),
        &[("RETEST_MEDIA_TEST_HOLD_FIRST_FRAME", "1")],
    );
    let started = media.start(
        "r",
        &scratch.output("long-ids"),
        &json!({ "queueFrames": 64 }),
    );
    assert_eq!(started["type"], "started", "{started}");
    // Each id at its 128-character limit, three bytes a character: 64 such frames would carry the header past 64 KiB.
    let step = "語".repeat(128);
    let image = png(4, 2, [9, 9, 9]);
    for index in 0..64u64 {
        let frame_id = format!("{index:02}{}", "語".repeat(126));
        media.send(&json!({ "type": "frame", "recordingId": "r", "frameId": frame_id, "actionId": step, "observationId": step, "timestampUs": index * 100_000, "format": "png" }), &image);
    }
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next_of("ended").0.0;
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["received"], 64, "{ended}");
    assert_eq!(ended["frames"]["shown"], 64, "{ended}");
    assert_eq!(ended["frames"]["dropped"], 0, "{ended}");
    assert_eq!(ended["evidence"]["status"], "complete", "{ended}");
    media.send(
        &frames_request("q1", "r", 0, 10_000_000, &json!({ "maxFrames": 64 })),
        &[],
    );
    // The test's reader refuses a header past 64 KiB, as the client does, so a reply arriving is the first check.
    let (sequence, payload) = media.next_of("frames").0;
    assert_eq!(sequence["status"], "ok", "{sequence}");
    assert_eq!(sequence["available"], 64, "{ended}; {sequence}");
    let returned = sequence["frames"].as_array().expect("frames").len() as u64;
    assert!(returned > 0 && returned < 64, "{returned} frames returned");
    assert_eq!(sequence["omitted"]["byBytes"].as_u64(), Some(64 - returned));
    let named: usize = sequence["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .map(|frame| frame["byteLength"].as_u64().unwrap_or(0) as usize)
        .sum();
    assert_eq!(named, payload.len());
}

fn header_readable_undecodable_jpeg() -> Vec<u8> {
    let whole = jpeg(32, 24, [70, 80, 90]);
    let scan = whole
        .windows(2)
        .position(|bytes| bytes == [0xff, 0xda])
        .expect("JPEG scan header");
    let mut cut = whole;
    // The dimensions and scan header are readable, but the scan asks for Huffman tables that are absent.
    cut[scan + 6] = 0x33;
    assert_eq!(
        image::ImageReader::with_format(Cursor::new(&cut), ImageFormat::Jpeg)
            .into_dimensions()
            .expect("header dimensions"),
        (32, 24)
    );
    assert!(
        image::load_from_memory_with_format(&cut, ImageFormat::Jpeg).is_err(),
        "the fixture must be undecodable"
    );
    cut
}

#[test]
fn header_readable_undecodable_images_are_refused_as_thumbnails() {
    let scratch = Scratch::new("undecodable-thumbnails");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let whole = png(32, 24, [70, 80, 90]);
    let cut_png = whole[..whole.len() - 20].to_vec();
    assert_eq!(
        image::ImageReader::with_format(Cursor::new(&cut_png), ImageFormat::Png)
            .into_dimensions()
            .expect("PNG header dimensions"),
        (32, 24)
    );
    assert!(image::load_from_memory_with_format(&cut_png, ImageFormat::Png).is_err());
    for (format, bytes, extension) in [
        ("png", cut_png, "png"),
        ("jpeg", header_readable_undecodable_jpeg(), "jpg"),
    ] {
        let output = scratch.output(format);
        media.send(&json!({ "type": "thumbnail", "requestId": format, "sourceFormat": format, "output": output, "maxWidth": 64, "maxHeight": 64, "format": format }), &bytes);
        let reply = media.next();
        assert_eq!(reply["status"], "undecodable", "{format}: {reply}");
        assert!(
            reply["message"]
                .as_str()
                .is_some_and(|message| message.contains("undecodable")),
            "{reply}"
        );
        assert!(reply.get("path").is_none());
        assert!(!Path::new(&format!("{output}.{extension}")).exists());
    }
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["type"], "bye");
    assert!(media.exit().success());
}

#[test]
fn a_header_readable_undecodable_live_frame_is_refused_and_named() {
    let scratch = Scratch::new("undecodable-live");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    media.start(
        "r",
        &scratch.output("r"),
        &json!({ "width": 32, "height": 24 }),
    );
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 64, "maxHeight": 64, "maxFps": 30 }), &[]);
    assert_eq!(media.next()["type"], "watching");
    media.frame_with_id(
        "r",
        "broken-jpeg",
        0,
        "jpeg",
        &header_readable_undecodable_jpeg(),
    );
    thread::sleep(Duration::from_millis(200));
    media.send(&json!({ "type": "unwatch", "recordingId": "r" }), &[]);
    let ((ended, _), before) = media.next_of("watchEnded");
    assert!(
        before.iter().all(|reply| reply["type"] != "live"),
        "undecodable bytes must never reach a watcher: {before:?}"
    );
    assert_eq!(ended["sent"], 0);
    assert_eq!(ended["failed"], 1);
    assert!(
        ended["message"].as_str().is_some_and(
            |message| message.contains("undecodable") && message.contains("broken-jpeg")
        ),
        "refusal must name the frame: {ended}"
    );
    media.send(&json!({ "type": "shutdown" }), &[]);
    media.next_of("bye");
    assert!(media.exit().success());
}

#[test]
fn a_thumbnail_is_fitted_never_enlarged_and_failures_are_named() {
    let scratch = Scratch::new("thumbnail");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("shot");
    let request = |id: &str, output: &str, max: u32, format: &str| json!({ "type": "thumbnail", "requestId": id, "sourceFormat": "png", "output": output, "maxWidth": max, "maxHeight": max, "format": format });
    media.send(
        &request("q1", &output, 20, "jpeg"),
        &png(40, 30, [200, 100, 50]),
    );
    let made = media.next();
    assert_eq!(made["status"], "ok", "{made}");
    assert_eq!(made["path"], format!("{output}.jpg"));
    assert_eq!(
        (
            made["width"].as_u64(),
            made["height"].as_u64(),
            made["sourceWidth"].as_u64(),
            made["sourceHeight"].as_u64()
        ),
        (Some(20), Some(15), Some(40), Some(30))
    );
    assert_eq!(made["placedBy"], "link");
    let written = fs::read(format!("{output}.jpg")).expect("written");
    assert_eq!(
        written.len() as u64,
        made["byteLength"].as_u64().unwrap_or(0)
    );
    assert_eq!(decoded_size(&written, ImageFormat::Jpeg), (20, 15));
    assert!(!Path::new(&format!("{output}.jpg.partial")).exists());
    media.send(
        &request("q2", &output, 20, "jpeg"),
        &png(40, 30, [200, 100, 50]),
    );
    assert_eq!(media.next()["status"], "output_in_use");
    let small = png(10, 10, [9, 9, 9]);
    media.send(&request("q3", &scratch.output("small"), 100, "png"), &small);
    let untouched = media.next();
    assert_eq!(
        (untouched["status"].as_str(), untouched["width"].as_u64()),
        (Some("ok"), Some(10)),
        "never enlarged: {untouched}"
    );
    assert_eq!(
        fs::read(format!("{}.png", scratch.output("small"))).expect("written"),
        small,
        "a fitting image in its own format is written as it came"
    );
    media.send(
        &request("q4", &scratch.output("garbage"), 20, "png"),
        b"not an image",
    );
    assert_eq!(media.next()["status"], "undecodable");
    media.send(
        &request("q5", &scratch.output("wide"), 20, "png"),
        &png(20_000, 1, [1, 2, 3]),
    );
    let wide = media.next();
    assert_eq!(wide["status"], "too_large", "{wide}");
    media.send(&request("q6", "relative/path", 20, "png"), &small);
    let refused = media.next();
    assert_eq!(
        (
            refused["code"].as_str(),
            refused["request"].as_str(),
            refused["requestId"].as_str()
        ),
        (Some("invalid_message"), Some("thumbnail"), Some("q6")),
        "{refused}"
    );
}

#[test]
fn a_live_view_sends_the_newest_frame_and_ends_with_the_recording() {
    let scratch = Scratch::new("live");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    media.start(
        "r",
        &scratch.output("live"),
        &json!({ "width": 64, "height": 48, "fps": 30 }),
    );
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 32, "maxHeight": 32, "maxFps": 30 }), &[]);
    assert_eq!(
        media.next(),
        json!({ "type": "watching", "recordingId": "r", "maxWidth": 32, "maxHeight": 32, "maxFps": 30 })
    );
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 32, "maxHeight": 32, "maxFps": 30 }), &[]);
    let twice = media.next();
    assert_eq!(
        (twice["code"].as_str(), twice["request"].as_str()),
        (Some("already_watched"), Some("watch")),
        "{twice}"
    );
    let mut sent = Vec::new();
    for index in 0..10u64 {
        let id = format!("live-{index}");
        media.frame_with_id(
            "r",
            &id,
            index * 50_000,
            "png",
            &png(64, 48, [index as u8 * 20, 0, 0]),
        );
        sent.push(id);
        thread::sleep(Duration::from_millis(50));
    }
    media.send(&json!({ "type": "unwatch", "recordingId": "r" }), &[]);
    let ((ended_view, _), lives) = media.next_of("watchEnded");
    assert_eq!(ended_view["reason"], "unwatched", "{ended_view}");
    assert!(!lives.is_empty(), "no live frame came");
    let mut sequence = 0;
    for live in &lives {
        assert_eq!(live["type"], "live", "{live}");
        assert!(
            sent.iter().any(|id| live["frameId"] == id.as_str()),
            "{live}"
        );
        assert_eq!(
            (
                live["width"].as_u64(),
                live["height"].as_u64(),
                live["format"].as_str()
            ),
            (Some(32), Some(24), Some("jpeg"))
        );
        assert!(live["sequence"].as_u64() > Some(sequence), "{live}");
        sequence = live["sequence"].as_u64().unwrap_or(0);
    }
    assert_eq!(
        ended_view["sent"].as_u64(),
        Some(lives.len() as u64),
        "{ended_view}"
    );
    media.send(&json!({ "type": "unwatch", "recordingId": "r" }), &[]);
    assert_eq!(media.next()["code"], "not_watched");
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 16, "maxHeight": 16, "maxFps": 5 }), &[]);
    assert_eq!(media.next()["type"], "watching");
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let mut seen = Vec::new();
    while seen.len() < 2 {
        let reply = media.next();
        if reply["type"] == "ended" || reply["type"] == "watchEnded" {
            seen.push(reply);
        }
    }
    let view = seen
        .iter()
        .find(|reply| reply["type"] == "watchEnded")
        .expect("the view ended");
    assert_eq!(view["reason"], "recording_ended");
    let recording = seen
        .iter()
        .find(|reply| reply["type"] == "ended")
        .expect("the recording ended");
    assert_eq!(recording["status"], "ok");
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 16, "maxHeight": 16, "maxFps": 5 }), &[]);
    let late = media.next();
    assert_eq!(
        late["reason"], "recording_ended",
        "an ended recording's view ends as it begins: {late}"
    );
}

// A picture whose JPEG is tens of kilobytes, so a few live frames fill the pipe of a client that stopped reading.
fn busy_png(width: u32, height: u32, seed: u32) -> Vec<u8> {
    let image = RgbImage::from_fn(width, height, |x, y| {
        let value = x.wrapping_mul(7919) ^ y.wrapping_mul(104_729) ^ seed.wrapping_mul(31);
        Rgb([value as u8, (value >> 8) as u8, (value >> 16) as u8])
    });
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encodes");
    bytes.into_inner()
}

#[test]
fn unread_stdout_and_a_full_normal_reply_queue_cannot_hold_eof_or_shutdown() {
    let scratch = Scratch::new("reply-pressure");
    let error_path = scratch.folder.join("stderr.log");
    let mut child = Command::new(env!("CARGO_BIN_EXE_retest-media"))
        .arg("--ffmpeg")
        .arg(scratch.fake())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            fs::File::create(&error_path).expect("stderr file"),
        ))
        .spawn()
        .expect("media starts");
    let mut output = child.stdout.take().expect("stdout");
    assert_eq!(read_reply(&mut output).expect("hello").0["type"], "hello");
    // Holding the pipe open without reading it exercises the blocking writer, rather than a broken pipe.
    let mut input = child.stdin.take().expect("stdin");
    let (sent, completed) = mpsc::channel();
    let sending = thread::spawn(move || {
        let request = envelope(br#"{"type":"ready"}"#, &[]);
        let result = (0..6000).try_for_each(|_| input.write_all(&request));
        drop(input);
        let _ = sent.send(result.is_ok());
    });
    let start = Instant::now();
    let input_closed = completed
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or(false);
    let status = loop {
        if let Some(status) = child.try_wait().expect("status") {
            break Some(status);
        }
        if start.elapsed() >= Duration::from_secs(5) {
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    if status.is_none() {
        child.kill().expect("stop only this unreaped media child");
        child.wait().expect("reap");
    }
    sending.join().expect("sender ends when media exits");
    drop(output);
    assert!(
        input_closed,
        "reply pressure prevented the client from closing stdin"
    );
    let status = status.expect("media must exit while stdout remains unread");
    assert_eq!(
        status.code(),
        Some(2),
        "lost replies cannot be a clean exit"
    );
    let errors = fs::read_to_string(error_path).expect("stderr");
    let report: Value = errors
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["type"] == "mediaReplyFailure")
        .expect("structured reply-loss report");
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["reason"], "stdout_blocked");
    assert!(
        report["repliesDropped"]
            .as_u64()
            .is_some_and(|count| count > 0),
        "{report}"
    );
    assert_eq!(
        report["inFlightUnknown"], 1,
        "the blocking pipe write has an unknown delivery outcome"
    );
}

#[test]
fn a_client_that_stops_reading_costs_live_frames_not_the_recording() {
    let scratch = Scratch::new("slow-watcher");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("slow-watcher");
    media.start(
        "r",
        &output,
        &json!({ "width": 320, "height": 240, "fps": 10, "queueFrames": 100 }),
    );
    media.send(&json!({ "type": "watch", "recordingId": "r", "maxWidth": 320, "maxHeight": 240, "maxFps": 30, "quality": 95 }), &[]);
    assert_eq!(media.next()["type"], "watching");
    media.pause_reading(true);
    for index in 0..30u64 {
        media.frame(
            "r",
            index * 100_000,
            "png",
            &busy_png(320, 240, index as u32),
        );
        thread::sleep(Duration::from_millis(40));
    }
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 3_000_000 }),
        &[],
    );
    // The encoder writes the video while nobody reads the replies.
    let video = format!("{output}.mp4");
    let deadline = Instant::now() + WAIT;
    while !Path::new(&video).exists() {
        assert!(
            Instant::now() < deadline,
            "the video was not written while the client did not read"
        );
        thread::sleep(Duration::from_millis(20));
    }
    media.pause_reading(false);
    let mut ended = Value::Null;
    let mut view = Value::Null;
    while ended.is_null() || view.is_null() {
        let reply = media.next();
        match reply["type"].as_str() {
            Some("ended") => ended = reply,
            Some("watchEnded") => view = reply,
            _ => {}
        }
    }
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["received"], 30);
    assert_eq!(
        ended["frames"]["dropped"], 0,
        "the recording lost no frame to the watcher"
    );
    assert_eq!(ended["outputFrames"], 30);
    assert_eq!(ended["evidence"]["status"], "complete");
    assert_eq!(
        fs::metadata(&video).expect("written").len(),
        30 * 320 * 240 * 3
    );
    assert_eq!(view["reason"], "recording_ended");
    assert!(
        view["dropped"].as_u64().is_some_and(|dropped| dropped > 0),
        "live frames the client never read were dropped: {view}"
    );
}

#[test]
fn leftovers_are_listed_and_removed_so_a_start_at_that_output_can_go_on() {
    let scratch = Scratch::new("leftovers");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("lost");
    fs::write(format!("{output}.mp4.partial"), b"half a video").expect("written");
    fs::write(format!("{output}.frames"), b"kept frames").expect("written");
    fs::create_dir(format!("{output}.webm.partial")).expect("created");
    assert_eq!(
        media.start("r", &output, &json!({}))["code"],
        "output_in_use"
    );
    media.send(
        &json!({ "type": "leftovers", "requestId": "q1", "output": output, "remove": false }),
        &[],
    );
    let listed = media.next();
    assert_eq!(listed["status"], "ok", "{listed}");
    assert_eq!(
        listed["files"],
        json!([
            { "path": format!("{output}.mp4.partial"), "kind": "video_partial", "byteLength": 12 },
            { "path": format!("{output}.frames"), "kind": "frame_store", "byteLength": 11 },
        ])
    );
    assert_eq!(
        listed["skipped"],
        json!([format!("{output}.webm.partial")]),
        "a folder is left alone"
    );
    assert_eq!(listed["removed"], false);
    assert!(Path::new(&format!("{output}.mp4.partial")).exists());
    media.send(
        &json!({ "type": "leftovers", "requestId": "q2", "output": output, "remove": true }),
        &[],
    );
    let removed = media.next();
    assert_eq!(removed["removed"], true, "{removed}");
    assert!(!Path::new(&format!("{output}.mp4.partial")).exists());
    assert!(!Path::new(&format!("{output}.frames")).exists());
    assert!(Path::new(&format!("{output}.webm.partial")).is_dir());
    assert_eq!(
        media.start("r", &output, &json!({}))["type"],
        "started",
        "the output is free again"
    );
    media.send(
        &json!({ "type": "leftovers", "requestId": "q3", "output": output, "remove": true }),
        &[],
    );
    let busy = media.next();
    assert_eq!(busy["status"], "in_use", "{busy}");
    assert!(
        Path::new(&format!("{output}.frames")).exists(),
        "a running recording's kept frames are not touched"
    );
    // The same output named through a symbolic link to its folder is the same output.
    let alias = scratch.folder.join("alias");
    std::os::unix::fs::symlink(&scratch.folder, &alias).expect("linked");
    let aliased = alias.join("lost").to_string_lossy().into_owned();
    media.send(
        &json!({ "type": "leftovers", "requestId": "q5", "output": aliased, "remove": true }),
        &[],
    );
    let busy = media.next();
    assert_eq!(busy["status"], "in_use", "{busy}");
    assert!(
        Path::new(&format!("{output}.frames")).exists(),
        "a running recording's kept frames are not touched through another name"
    );
    media.send(
        &json!({ "type": "leftovers", "requestId": "q4", "output": "relative", "remove": true }),
        &[],
    );
    assert_eq!(media.next()["status"], "invalid");
}

#[test]
fn a_filesystem_without_hard_links_still_finalizes_by_copy() {
    let scratch = Scratch::new("no-links");
    let mut media = Media::spawn(&scratch.fake(), &[("RETEST_MEDIA_TEST_NO_HARD_LINKS", "1")]);
    let output = scratch.output("no-links");
    media.start("r", &output, &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [7, 8, 9]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 200_000 }),
        &[],
    );
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["placedBy"], "copy");
    let written = fs::read(format!("{output}.mp4")).expect("the video is in place");
    assert_eq!(
        written,
        [7u8, 8, 9].repeat(4 * 2 * 2),
        "two frames of the one colour, copied whole"
    );
    assert!(
        !Path::new(&format!("{output}.mp4.partial")).exists(),
        "the partial went once the copy was whole"
    );
    let thumbnail = scratch.output("thumb");
    media.send(&json!({ "type": "thumbnail", "requestId": "q1", "sourceFormat": "png", "output": thumbnail, "maxWidth": 8, "maxHeight": 8, "format": "png" }), &png(4, 2, [1, 2, 3]));
    let made = media.next();
    assert_eq!(
        (made["status"].as_str(), made["placedBy"].as_str()),
        (Some("ok"), Some("copy")),
        "{made}"
    );
}

#[test]
fn the_encoded_route_hands_matching_images_over_untouched() {
    let scratch = Scratch::new("encoded");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("encoded");
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 8, "height": 6, "encodedFormat": "jpeg" }),
    );
    assert_eq!(
        (started["route"].as_str(), started["encodedFormat"].as_str()),
        (Some("encoded"), Some("jpeg")),
        "{started}"
    );
    let matching = jpeg(8, 6, [200, 0, 0]);
    media.frame("r", 0, "jpeg", &matching);
    media.frame("r", 100_000, "png", &png(8, 6, [0, 200, 0]));
    media.frame("r", 200_000, "jpeg", &jpeg(16, 12, [0, 0, 200]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 300_000 }),
        &[],
    );
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["shown"], 3);
    assert_eq!(ended["frames"]["resized"], 1);
    let written = fs::read(format!("{output}.mp4")).expect("written");
    assert_eq!(
        &written[..matching.len()],
        matching.as_slice(),
        "the matching JPEG reached the encoder byte for byte"
    );
    assert_eq!(
        &written[matching.len()..matching.len() + 2],
        &[0xFF, 0xD8],
        "the PNG became a JPEG"
    );
    assert_eq!(ended["bytesToEncoder"].as_u64(), Some(written.len() as u64));
    let arguments = fs::read_to_string(format!("{output}.mp4.partial.args"))
        .expect("the fake wrote its arguments");
    assert!(
        arguments.contains("-f image2pipe -c:v mjpeg") && arguments.contains("-fps_mode cfr"),
        "{arguments}"
    );
    let mut without = Media::spawn(&scratch.fake(), &[("FAKE_DECODERS", "png")]);
    without.send(&json!({ "type": "ready" }), &[]);
    let ready = without.next();
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["encoder"]["encodedInput"], json!(["png"]));
    let decoded = without.start(
        "s",
        &scratch.output("decoded"),
        &json!({ "encodedFormat": "jpeg" }),
    );
    assert_eq!(
        decoded["route"], "decoded",
        "an encoder that cannot read JPEG undecoded records decoded, and says so"
    );
    assert!(decoded.get("encodedFormat").is_none());
}

#[test]
fn an_encoder_that_prints_while_it_writes_leaves_partial_evidence() {
    let scratch = Scratch::new("noisy");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "noisy")]);
    media.start("r", &scratch.output("noisy"), &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [3, 3, 3]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next();
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(
        ended["evidence"],
        json!({ "status": "partial", "reasons": ["encoder_reported_errors"] })
    );
    assert_eq!(
        ended["encoder"]["stderr"],
        json!(["fake: one frame could not be read"])
    );
    assert_eq!(ended["encoder"]["lines"], 1);
}

#[test]
fn ids_with_control_characters_are_refused() {
    let scratch = Scratch::new("ids");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let mut bad = identity();
    bad["testId"] = json!("line one\nline two");
    let refused = media.start("r", &scratch.output("ids"), &json!({ "identity": bad }));
    assert_eq!(
        (refused["code"].as_str(), refused["request"].as_str()),
        (Some("invalid_start"), Some("start")),
        "{refused}"
    );
    media.start("s", &scratch.output("ids-ok"), &json!({}));
    media.frame_with_id("s", "f\u{7}", 0, "png", &png(4, 2, [0, 0, 0]));
    let frame = media.next();
    assert_eq!(
        (frame["code"].as_str(), frame["request"].as_str()),
        (Some("invalid_message"), Some("frame")),
        "{frame}"
    );
    media.send(&json!({ "type": "finish", "recordingId": "s" }), &[]);
    let ended = media.next();
    assert_eq!(
        ended["frames"]["received"], 0,
        "a refused frame is not part of the recording"
    );
}

// Kills an encoder's whole group when a test ends, passing or not, so a stop the test proves missing leaves nothing.
struct GroupGuard(libc::pid_t);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if self.0 > 1 {
            // SAFETY: kill(2) on the group of an encoder this test's media process started and named.
            unsafe { libc::kill(-self.0, libc::SIGKILL) };
        }
    }
}

#[test]
fn an_encoded_frame_that_cannot_be_decoded_is_counted_undecodable_not_shown() {
    let scratch = Scratch::new("encoded-broken");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let output = scratch.output("encoded-broken");
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 8, "height": 6, "encodedFormat": "png" }),
    );
    assert_eq!(started["route"], "encoded", "{started}");
    let whole = png(8, 6, [200, 0, 0]);
    // Its header and size are whole, but its image data stops short, as a capture cut off mid-write would leave it.
    let cut = whole[..whole.len() - 20].to_vec();
    media.frame_with_id("r", "whole", 0, "png", &whole);
    media.frame_with_id("r", "cut", 100_000, "png", &cut);
    media.frame_with_id("r", "after", 200_000, "png", &png(8, 6, [0, 200, 0]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 300_000 }),
        &[],
    );
    let (ended, payload) = media.next_of("ended").0;
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["frames"]["undecodable"], 1, "{ended}");
    assert_eq!(ended["frames"]["shown"], 2, "{ended}");
    let map = frame_map(&payload);
    let fate = |id: &str| {
        map.iter()
            .find(|entry| entry["frameId"] == id)
            .map(|entry| entry["fate"].clone())
    };
    assert_eq!(fate("cut"), Some(json!("undecodable")), "{map:?}");
    assert_eq!(fate("whole"), Some(json!("shown")));
    assert_eq!(fate("after"), Some(json!("shown")));
    assert_counts_add_up(&ended["frames"]);
}

#[test]
fn a_job_that_fails_inside_the_process_is_answered_with_an_error_and_holds_nothing() {
    let scratch = Scratch::new("job-panic");
    let mut media = Media::spawn(&scratch.fake(), &[("RETEST_MEDIA_TEST_JOB_PANIC", "boom")]);
    let output = scratch.output("shot");
    let thumbnail = |request_id: &str| json!({ "type": "thumbnail", "requestId": request_id, "sourceFormat": "png", "output": output, "maxWidth": 4, "maxHeight": 4, "format": "png" });
    media.send(&thumbnail("boom"), &png(8, 6, [1, 2, 3]));
    let failed = media.next();
    assert_eq!(
        (
            failed["type"].as_str(),
            failed["code"].as_str(),
            failed["request"].as_str(),
            failed["requestId"].as_str()
        ),
        (
            Some("error"),
            Some("job_failed"),
            Some("thumbnail"),
            Some("boom")
        ),
        "{failed}"
    );
    media.send(
        &json!({ "type": "leftovers", "requestId": "q1", "output": output, "remove": false }),
        &[],
    );
    assert_eq!(
        media.next()["status"],
        "ok",
        "the failed thumbnail no longer marks its output in use"
    );
    media.send(&thumbnail("q2"), &png(8, 6, [1, 2, 3]));
    assert_eq!(media.next()["status"], "ok");
    // A frame sequence that fails is answered the same way.
    media.start("r", &scratch.output("recording"), &json!({}));
    media.frame("r", 0, "png", &png(4, 2, [5, 5, 5]));
    media.send(&frames_request("boom", "r", 0, 1_000_000, &json!({})), &[]);
    let failed = media.next_of("error").0.0;
    assert_eq!(
        (failed["code"].as_str(), failed["request"].as_str()),
        (Some("job_failed"), Some("frames")),
        "{failed}"
    );
}

#[test]
fn a_live_view_asked_for_before_the_probe_answers_begins_with_the_recording() {
    let scratch = Scratch::new("watch-probe");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_PROBE_SLEEP", "3")]);
    media.send_start("r", &scratch.output("watch-probe"), &json!({}));
    media.send(
        &json!({ "type": "watch", "recordingId": "r", "maxWidth": 4, "maxHeight": 4, "maxFps": 30 }),
        &[],
    );
    let started = media.next();
    assert_eq!(
        started["type"], "started",
        "the view was answered before the recording began: {started}"
    );
    let watching = media.next();
    assert_eq!(watching["type"], "watching", "{watching}");
    media.frame("r", 0, "png", &png(4, 2, [9, 9, 9]));
    let live = media.next_of("live").0.0;
    assert_eq!(live["recordingId"], "r", "{live}");
}

#[test]
fn a_frame_past_the_last_frame_the_video_may_hold_is_not_called_shown() {
    let scratch = Scratch::new("duration-cap");
    let mut media = Media::spawn(&scratch.fake(), &[]);
    let started = media.start(
        "r",
        &scratch.output("duration-cap"),
        &json!({ "maxDurationMs": 250, "maxGapMs": 250 }),
    );
    assert_eq!(started["type"], "started", "{started}");
    // Ten frames a second for 250 ms is three video frames, at 0, 100 and 200 ms. A frame captured at 250 ms is within
    // the duration but rounds to a fourth.
    media.frame_with_id("r", "first", 0, "png", &png(4, 2, [1, 1, 1]));
    media.frame_with_id("r", "second", 100_000, "png", &png(4, 2, [2, 2, 2]));
    media.frame_with_id("r", "at-the-cap", 250_000, "png", &png(4, 2, [3, 3, 3]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 250_000 }),
        &[],
    );
    let (ended, payload) = media.next_of("ended").0;
    assert_eq!(ended["status"], "ok", "{ended}");
    let map = frame_map(&payload);
    let shown: Vec<&Value> = map
        .iter()
        .filter(|entry| entry["fate"] == "shown")
        .collect();
    assert!(
        shown
            .iter()
            .all(|entry| entry["outputFrames"].as_u64().unwrap_or(0) > 0),
        "a frame in no video frame is called shown: {map:?}"
    );
    assert_eq!(ended["frames"]["shown"].as_u64(), Some(shown.len() as u64));
    let placed: u64 = shown
        .iter()
        .map(|entry| entry["outputFrames"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(Some(placed), ended["outputFrames"].as_u64(), "{map:?}");
    assert_eq!(map[2]["fate"], "out_of_range", "{map:?}");
    assert!(
        ended["evidence"]["reasons"]
            .as_array()
            .is_some_and(|reasons| reasons.contains(&json!("end_clipped"))),
        "{ended}"
    );
    assert_counts_add_up(&ended["frames"]);
}

#[test]
fn an_encoder_whose_command_changed_is_still_stopped_through_its_child_handle() {
    let scratch = Scratch::new("exec-wedge");
    let mut media = Media::spawn(&scratch.fake(), &[("FAKE_MODE", "exec-sleep")]);
    let started = media.start(
        "r",
        &scratch.output("exec-wedge"),
        &json!({ "width": 320, "height": 240, "stallMs": 300 }),
    );
    assert_eq!(started["type"], "started", "{started}");
    let _cleanup = GroupGuard(started["encoderPid"].as_i64().unwrap_or(0) as libc::pid_t);
    // The encoder is read as the fake's shell script; after 300 ms it becomes `sleep`, another program's readable
    // command, which reads no input.
    thread::sleep(Duration::from_millis(700));
    let frame = png(320, 240, [1, 2, 3]);
    media.frame("r", 0, "png", &frame);
    media.frame("r", 100_000, "png", &frame);
    let sent = Instant::now();
    let (ended, _) = media
        .replies
        .recv_timeout(Duration::from_secs(5))
        .expect("the stalled encoder was stopped and the recording ended");
    assert_eq!(ended["type"], "ended", "{ended}");
    assert_eq!(ended["status"], "encoder_failed", "{ended}");
    assert!(
        ended["message"].as_str().is_some_and(|message| message
            .starts_with("the encoder took more than 300 ms to accept a frame and was stopped")),
        "{ended}"
    );
    assert!(
        sent.elapsed() < Duration::from_secs(3),
        "{:?}",
        sent.elapsed()
    );
    assert!(!group_alive(&started), "the encoder outlived its stop");
}

#[test]
fn a_process_killed_while_copying_its_video_into_place_leaves_nothing_at_the_video_path() {
    let scratch = Scratch::new("copy-kill");
    let output = scratch.output("copied");
    {
        let mut media = Media::spawn(
            &scratch.fake(),
            &[
                ("RETEST_MEDIA_TEST_NO_HARD_LINKS", "1"),
                ("RETEST_MEDIA_TEST_KILL_DURING_COPY", "1"),
            ],
        );
        let started = media.start("r", &output, &json!({ "width": 320, "height": 240 }));
        assert_eq!(started["type"], "started", "{started}");
        // Three raw frames of 230 400 bytes: more than one chunk of the copy.
        let frame = png(320, 240, [4, 5, 6]);
        media.frame("r", 0, "png", &frame);
        media.frame("r", 100_000, "png", &frame);
        media.send(
            &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 300_000 }),
            &[],
        );
        assert!(
            !media.exit().success(),
            "the process was to be killed in its copy"
        );
    }
    assert!(
        !Path::new(&format!("{output}.mp4")).exists(),
        "a partial copy was left at the video's path"
    );
    assert!(Path::new(&format!("{output}.mp4.partial")).exists());
    // The next process lists what the killed one left and removes it, so the output can be used again.
    let mut media = Media::spawn(&scratch.fake(), &[]);
    media.send(
        &json!({ "type": "leftovers", "requestId": "q1", "output": output, "remove": true }),
        &[],
    );
    let removed = media.next();
    assert_eq!(removed["removed"], true, "{removed}");
    let kinds: Vec<(String, String)> = removed["files"]
        .as_array()
        .expect("files")
        .iter()
        .map(|file| {
            let path = file["path"].as_str().unwrap_or("");
            (
                path.trim_start_matches(output.as_str()).to_owned(),
                file["kind"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    assert!(
        kinds.contains(&(".mp4.copying".to_owned(), "video_partial".to_owned())),
        "{removed}"
    );
    assert!(!Path::new(&format!("{output}.mp4.copying")).exists());
    assert_eq!(media.start("r", &output, &json!({}))["type"], "started");
}
