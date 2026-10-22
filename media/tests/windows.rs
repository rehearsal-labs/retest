//! The media process on Windows as a client sees it, with the host's ffmpeg.
//!
//! The Unix suite in `process.rs` drives the process through a shell-script stand-in for ffmpeg; this one drives the
//! real encoder, and a batch file that runs ffmpeg for the codec questions and hangs in a child process instead of
//! encoding, so a deadline and a shutdown have a launch and a process beneath it to end. A case that needs ffmpeg fails
//! when no ffmpeg executable exists, so a machine missing the prerequisite fails loudly; setting
//! RETEST_MEDIA_TEST_NO_FFMPEG skips those cases by name instead.

#![cfg(windows)]

use std::fs;
use std::io::{Cursor, Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const WAIT: Duration = Duration::from_secs(15);

struct Scratch {
    folder: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Scratch {
        let folder = std::env::temp_dir().join(format!(
            "retest-media-windows-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("the scratch folder is created");
        Scratch { folder }
    }

    fn output(&self, name: &str) -> String {
        self.folder.join(name).to_string_lossy().into_owned()
    }

    // A batch file that answers the codec questions through ffmpeg and, asked to encode, runs `encode` instead.
    fn wrapper(&self, name: &str, ffmpeg: &Path, encode: &str) -> PathBuf {
        let path = self.folder.join(format!("{name}.cmd"));
        let body = format!(
            "@echo off\r\nif \"%~1\"==\"-hide_banner\" if \"%~2\"==\"-loglevel\" goto encode\r\n\"{}\" %*\r\nexit /b %errorlevel%\r\n:encode\r\n{encode}\r\n",
            ffmpeg.display()
        );
        fs::write(&path, body).expect("the wrapper is written");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

// The executable the colour test in `frame.rs` finds: RETEST_FFMPEG, or `ffmpeg.exe` on PATH. None only when it is
// absent and RETEST_MEDIA_TEST_NO_FFMPEG asks for the case to be skipped.
fn host_ffmpeg(case: &str) -> Option<PathBuf> {
    let requested = std::env::var_os("RETEST_FFMPEG").unwrap_or_else(|| "ffmpeg.exe".into());
    let path = Path::new(&requested);
    let candidates: Vec<PathBuf> = if path.components().count() > 1 {
        vec![path.to_owned()]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|folder| folder.join(path))
            .collect()
    };
    let found = candidates.into_iter().find(|candidate| candidate.is_file());
    if found.is_none() {
        assert!(
            std::env::var_os("RETEST_MEDIA_TEST_NO_FFMPEG").is_some(),
            "{case} needs ffmpeg with libx264 and the mp4 muxer, and {} is absent; install it, or set RETEST_MEDIA_TEST_NO_FFMPEG to skip the cases that need it",
            path.display()
        );
        writeln!(
            std::io::stderr().lock(),
            "SKIP {case}: ffmpeg executable {} is absent and RETEST_MEDIA_TEST_NO_FFMPEG is set",
            path.display()
        )
        .expect("report the named prerequisite skip");
    }
    found
}

struct Media {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: Receiver<(Value, Vec<u8>)>,
    frames_sent: u64,
}

fn identity() -> Value {
    json!({ "runId": "run-1", "attemptId": "a1", "testId": "tests/x.retest.ts > saves", "app": "web", "sessionId": "a1:web" })
}

impl Media {
    // Starts the process with the environment Retest's client gives it on Windows, plus `extra`.
    fn spawn(ffmpeg: &Path, extra: &[(&str, &str)]) -> Media {
        let mut command = Command::new(env!("CARGO_BIN_EXE_retest-media"));
        command.env_clear().env("LC_ALL", "C");
        for name in ["PATH", "SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.envs(extra.iter().copied());
        command
            .arg("--ffmpeg")
            .arg(ffmpeg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
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
            frames_sent: 0,
        };
        let hello = media.next();
        assert_eq!(hello["type"], "hello", "{hello}");
        media
    }

    fn send(&mut self, header: &Value, payload: &[u8]) {
        let header = serde_json::to_vec(header).expect("serialises");
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin
            .write_all(&envelope(&header, payload))
            .expect("the process reads its input");
        stdin.flush().expect("flushes");
    }

    #[track_caller]
    fn start(&mut self, id: &str, output: &str, extra: &Value) -> Value {
        let mut header = json!({ "type": "start", "recordingId": id, "identity": identity(), "width": 64, "height": 48, "fps": 10, "output": output, "deadlineMs": 10_000 });
        if let (Some(header), Some(extra)) = (header.as_object_mut(), extra.as_object()) {
            header.extend(extra.clone());
        }
        self.send(&header, &[]);
        self.next()
    }

    fn frame(&mut self, id: &str, timestamp_us: u64, bytes: &[u8]) {
        self.frames_sent += 1;
        let frame_id = format!("f{}", self.frames_sent);
        self.send(&json!({ "type": "frame", "recordingId": id, "frameId": frame_id, "timestampUs": timestamp_us, "format": "png" }), bytes);
    }

    #[track_caller]
    fn next(&mut self) -> Value {
        self.replies.recv_timeout(WAIT).expect("a reply arrives").0
    }

    // The next reply of a type, passing over any other.
    #[track_caller]
    fn next_of(&mut self, kind: &str) -> Value {
        loop {
            let reply = self.next();
            if reply["type"] == kind {
                return reply;
            }
        }
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
    let mut header = vec![0u8; header_length];
    stdout.read_exact(&mut header).ok()?;
    let mut payload = vec![0u8; payload_length];
    stdout.read_exact(&mut payload).ok()?;
    Some((
        serde_json::from_slice(&header).expect("a reply is JSON"),
        payload,
    ))
}

fn png(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(colour)))
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encodes");
    bytes.into_inner()
}

// A process opened by pid, so this test can tell later whether that very process is still running.
struct Watched(OwnedHandle);

impl Watched {
    fn open(pid: u32) -> Option<Watched> {
        // SAFETY: OpenProcess takes plain values and returns a new handle, or null.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        // SAFETY: a non-null handle from OpenProcess is valid and owned by nothing else.
        (!handle.is_null()).then(|| Watched(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }

    fn exited(&self) -> bool {
        // SAFETY: the handle is live and has SYNCHRONIZE; a zero timeout only reads the state.
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_OBJECT_0 }
    }
}

// Every process a snapshot lists beneath `root`, by parent pid, with its executable's name, each opened while it is
// listed.
fn descendants(root: u32) -> Vec<(String, Watched)> {
    // SAFETY: CreateToolhelp32Snapshot takes plain values.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE, "a process snapshot");
    // SAFETY: the snapshot handle is valid and owned by nothing else.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut links = Vec::new();
    // SAFETY: the entry's size is set and the snapshot is live.
    let mut listed = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
    while listed {
        let length = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..length]).to_lowercase();
        links.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
        // SAFETY: as above.
        listed = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    let mut found = vec![root];
    let mut named = Vec::new();
    loop {
        let before = found.len();
        for (pid, parent, name) in &links {
            if found.contains(parent) && !found.contains(pid) {
                found.push(*pid);
                named.push((*pid, name.clone()));
            }
        }
        if found.len() == before {
            break;
        }
    }
    named
        .into_iter()
        .filter_map(|(pid, name)| Watched::open(pid).map(|watched| (name, watched)))
        .collect()
}

// Waits until a process named `name` runs beneath `root`, and returns every process beneath it then.
fn wait_for_descendant(root: u32, name: &str) -> Vec<(String, Watched)> {
    let deadline = Instant::now() + WAIT;
    loop {
        let found = descendants(root);
        if found.iter().any(|(each, _)| each == name) {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "{name} never ran beneath the wrapper"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

// Asserts that `name` was among `beneath` and that every process there has exited.
fn assert_all_exited(beneath: &[(String, Watched)], name: &str, when: &str) {
    assert!(
        beneath.iter().any(|(each, _)| each == name),
        "{name} was watched"
    );
    for (each, watched) in beneath {
        assert!(
            watched.exited(),
            "{each} beneath the wrapper outlived {when}"
        );
    }
}

fn encoder_pid(started: &Value) -> u32 {
    started["encoderPid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .unwrap_or_else(|| panic!("no encoder pid in {started}"))
}

#[test]
fn greets_and_says_bye_without_an_encoder() {
    let scratch = Scratch::new("greeting");
    let mut media = Media::spawn(&scratch.folder.join("no-ffmpeg.exe"), &[]);
    media.send(&json!({ "type": "ready" }), &[]);
    let ready = media.next();
    assert_eq!(ready["type"], "ready", "{ready}");
    assert_ne!(ready["encoder"]["state"], "ready", "{ready}");
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 0 }));
    assert!(media.exit().success());
}

#[test]
fn records_a_video_with_the_host_ffmpeg_and_leaves_no_encoder() {
    let Some(ffmpeg) = host_ffmpeg("records_a_video_with_the_host_ffmpeg_and_leaves_no_encoder")
    else {
        return;
    };
    let scratch = Scratch::new("record");
    let mut media = Media::spawn(&ffmpeg, &[]);
    let output = scratch.output("recording-1");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(started["type"], "started", "{started}");
    assert_eq!(started["path"], format!("{output}.mp4"));
    let encoder = Watched::open(encoder_pid(&started)).expect("the encoder is running");
    for (index, colour) in [[200, 40, 40], [40, 200, 40], [40, 40, 200]]
        .iter()
        .enumerate()
    {
        media.frame("r", index as u64 * 100_000, &png(64, 48, *colour));
    }
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 400_000 }),
        &[],
    );
    let ended = media.next_of("ended");
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["placedBy"], "link", "{ended}");
    let video = fs::read(format!("{output}.mp4")).expect("the video is in place");
    assert_eq!(&video[4..8], b"ftyp", "an MP4 container");
    assert!(!Path::new(&format!("{output}.mp4.partial")).exists());
    assert!(encoder.exited(), "the encoder has exited");
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next_of("bye")["stopped"], 0);
    assert!(media.exit().success());
}

#[test]
fn a_filesystem_without_hard_links_still_finalizes_by_copy() {
    let Some(ffmpeg) = host_ffmpeg("a_filesystem_without_hard_links_still_finalizes_by_copy")
    else {
        return;
    };
    let scratch = Scratch::new("no-links");
    let mut media = Media::spawn(&ffmpeg, &[("RETEST_MEDIA_TEST_NO_HARD_LINKS", "1")]);
    let output = scratch.output("no-links");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(started["type"], "started", "{started}");
    media.frame("r", 0, &png(64, 48, [7, 8, 9]));
    media.send(
        &json!({ "type": "finish", "recordingId": "r", "endTimestampUs": 200_000 }),
        &[],
    );
    let ended = media.next_of("ended");
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_eq!(ended["placedBy"], "copy", "{ended}");
    assert!(fs::metadata(format!("{output}.mp4")).is_ok_and(|file| file.len() > 0));
    assert!(!Path::new(&format!("{output}.mp4.partial")).exists());
    assert!(!Path::new(&format!("{output}.mp4.copying")).exists());
}

#[test]
fn the_encoder_inherits_only_its_variables() {
    let Some(ffmpeg) = host_ffmpeg("the_encoder_inherits_only_its_variables") else {
        return;
    };
    let scratch = Scratch::new("environment");
    let marker = scratch.folder.join("environment.txt");
    let wrapper = scratch.wrapper(
        "environment-ffmpeg",
        &ffmpeg,
        &format!(
            "set > \"{}\"\r\n\"{}\" %*",
            marker.display(),
            ffmpeg.display()
        ),
    );
    let mut media = Media::spawn(
        &wrapper,
        &[(
            "RETEST_SYNTHETIC_MEDIA_JUDGE_KEY",
            "synthetic-fixture-value",
        )],
    );
    let output = scratch.output("environment");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(started["type"], "started", "{started}");
    media.frame("r", 0, &png(64, 48, [1, 2, 3]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    assert_eq!(media.next_of("ended")["status"], "ok");
    let environment = fs::read_to_string(&marker).expect("the encoder printed its environment");
    let names: Vec<String> = environment
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(name, _)| name.to_ascii_uppercase())
        .collect();
    assert!(
        !names
            .iter()
            .any(|name| name == "RETEST_SYNTHETIC_MEDIA_JUDGE_KEY"),
        "the judge variable must not reach the encoder"
    );
    for name in ["PATH", "SYSTEMROOT"] {
        assert!(
            names.iter().any(|listed| listed == name),
            "{name}: {names:?}"
        );
    }
}

#[test]
fn a_deadline_ends_the_wrapper_and_the_process_beneath_it() {
    let Some(ffmpeg) = host_ffmpeg("a_deadline_ends_the_wrapper_and_the_process_beneath_it") else {
        return;
    };
    let scratch = Scratch::new("deadline");
    let wrapper = scratch.wrapper("hanging-ffmpeg", &ffmpeg, "ping -n 600 127.0.0.1 >nul");
    let mut media = Media::spawn(&wrapper, &[]);
    let output = scratch.output("deadline");
    // Frames this small fit in the pipe the hanging wrapper never reads.
    let started = media.start(
        "r",
        &output,
        &json!({ "width": 4, "height": 2, "deadlineMs": 1000 }),
    );
    assert_eq!(started["type"], "started", "{started}");
    let launch = Watched::open(encoder_pid(&started)).expect("the wrapper is running");
    let beneath = wait_for_descendant(encoder_pid(&started), "ping.exe");
    media.frame("r", 0, &png(4, 2, [7, 7, 7]));
    let finished = Instant::now();
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next_of("ended");
    assert_eq!(ended["status"], "deadline_exceeded", "{ended}");
    assert!(
        finished.elapsed() < Duration::from_secs(5),
        "ended after {:?}",
        finished.elapsed()
    );
    assert!(launch.exited(), "the wrapper outlived the deadline");
    assert_all_exited(&beneath, "ping.exe", "the deadline");
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next_of("bye")["stopped"], 0);
    assert!(media.exit().success());
}

#[test]
fn a_shutdown_ends_the_wrapper_and_the_process_beneath_it() {
    let Some(ffmpeg) = host_ffmpeg("a_shutdown_ends_the_wrapper_and_the_process_beneath_it") else {
        return;
    };
    let scratch = Scratch::new("shutdown");
    let wrapper = scratch.wrapper("hanging-ffmpeg", &ffmpeg, "ping -n 600 127.0.0.1 >nul");
    let mut media = Media::spawn(&wrapper, &[]);
    let started = media.start("r", &scratch.output("shutdown"), &json!({}));
    assert_eq!(started["type"], "started", "{started}");
    let launch = Watched::open(encoder_pid(&started)).expect("the wrapper is running");
    let beneath = wait_for_descendant(encoder_pid(&started), "ping.exe");
    media.send(&json!({ "type": "shutdown" }), &[]);
    assert_eq!(media.next()["status"], "stopped");
    assert_eq!(media.next(), json!({ "type": "bye", "stopped": 1 }));
    assert!(media.exit().success());
    assert!(launch.exited(), "the wrapper outlived the process");
    assert_all_exited(&beneath, "ping.exe", "the media process");
}

#[test]
fn a_process_left_running_by_a_wrapper_that_exited_is_ended_with_the_recording() {
    let Some(ffmpeg) =
        host_ffmpeg("a_process_left_running_by_a_wrapper_that_exited_is_ended_with_the_recording")
    else {
        return;
    };
    let scratch = Scratch::new("orphan");
    // `start /b` leaves ping running once the wrapper has encoded and exited, so ping's parent is gone before the
    // recording ends; only the encoder's job still ties ping to it.
    let wrapper = scratch.wrapper(
        "orphaning-ffmpeg",
        &ffmpeg,
        &format!(
            "start /b ping -n 600 127.0.0.1 >nul 2>nul\r\n\"{}\" %*",
            ffmpeg.display()
        ),
    );
    let mut media = Media::spawn(&wrapper, &[]);
    let output = scratch.output("orphan");
    let started = media.start("r", &output, &json!({}));
    assert_eq!(started["type"], "started", "{started}");
    let beneath = wait_for_descendant(encoder_pid(&started), "ping.exe");
    media.frame("r", 0, &png(64, 48, [9, 9, 9]));
    media.send(&json!({ "type": "finish", "recordingId": "r" }), &[]);
    let ended = media.next_of("ended");
    assert_eq!(ended["status"], "ok", "{ended}");
    assert_all_exited(&beneath, "ping.exe", "the recording");
    assert!(Path::new(&format!("{output}.mp4")).is_file());
}

#[test]
fn output_names_windows_refuses_are_refused_with_the_recording_id() {
    let scratch = Scratch::new("names");
    let mut media = Media::spawn(&scratch.folder.join("no-ffmpeg.exe"), &[]);
    for name in ["con", "recording:stream"] {
        let refused = media.start("r", &scratch.output(name), &json!({}));
        assert_eq!(refused["code"], "invalid_start", "{refused}");
        assert_eq!(refused["recordingId"], "r", "{refused}");
        assert!(
            refused["message"]
                .as_str()
                .is_some_and(|message| message.contains("Windows")),
            "{refused}"
        );
    }
    media.send(
        &json!({ "type": "leftovers", "requestId": "q1", "output": scratch.output("nul"), "remove": true }),
        &[],
    );
    assert_eq!(media.next()["status"], "invalid");
}

#[test]
fn a_leftover_another_program_holds_open_is_named_and_kept_until_it_is_let_go() {
    let scratch = Scratch::new("leftovers");
    let mut media = Media::spawn(&scratch.folder.join("no-ffmpeg.exe"), &[]);
    let output = scratch.output("lost");
    let partial = format!("{output}.mp4.partial");
    fs::write(&partial, b"half a video").expect("written");
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(&partial)
        .expect("another program opens the leftover");
    media.send(
        &json!({ "type": "leftovers", "requestId": "q1", "output": output, "remove": true }),
        &[],
    );
    let refused = media.next();
    assert_eq!(refused["removed"], false, "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .is_some_and(|message| message.contains(&partial)),
        "{refused}"
    );
    assert!(Path::new(&partial).exists());
    drop(held);
    media.send(
        &json!({ "type": "leftovers", "requestId": "q2", "output": output, "remove": true }),
        &[],
    );
    let removed = media.next();
    assert_eq!(removed["removed"], true, "{removed}");
    assert!(!Path::new(&partial).exists());
}
