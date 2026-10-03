//! Reads the client's messages and runs its recordings.
//!
//! Standard input is read on a thread of its own and handed over through a small bounded channel, so the loop
//! here wakes at least every `REAP_INTERVAL` and reports a recording that ended, or whose thread failed, without
//! waiting for the client's next message. The loop never waits on an encoder, so a slow recording cannot hold up
//! another, a finish or a shutdown. Shutting down, and the input ending, stop every unfinished recording, let
//! finishing ones complete within their deadlines, and wait for each `ended` before `bye`, so the process leaves
//! no encoder behind.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::encoder::{self, Capabilities, Codec, EncoderFailure};
use crate::protocol::{
    self, Bye, EndStatus, Envelope, ErrorCode, ErrorReply, FinishRecording, FrameHeader, Hello,
    Incoming, MAX_ID_CHARACTERS, ReadError, Refusal, Reply, StartRecording,
};
use crate::recording::{self, Recording, RecordingPlan};
use crate::replies::Replies;

const DEFAULT_QUEUE_FRAMES: usize = 60;
const DEFAULT_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_QUEUE_FRAMES: usize = 10_000;
const MAX_QUEUE_BYTES: usize = 1024 * 1024 * 1024;
const MAX_SIDE: u32 = 8192;
const MAX_FPS: u32 = 120;
const MAX_DEADLINE_MS: u64 = 10 * 60 * 1000;
const DEFAULT_MAX_GAP_MS: u64 = 10_000;
const DEFAULT_MAX_DURATION_MS: u64 = 30 * 60 * 1000;
const MAX_DURATION_MS: u64 = 4 * 60 * 60 * 1000;
const DEFAULT_STALL_MS: u64 = 10_000;
const STALL_RANGE_MS: std::ops::RangeInclusive<u64> = 100..=600_000;
/// How many recordings may run at once.
const MAX_RECORDINGS: usize = 16;
/// How many ended recording ids are remembered, so their late frames are ignored and their ids not reused.
/// Older ones are forgotten: a late frame for one is then answered `unknown_recording`.
const REMEMBERED_ENDINGS: usize = 4096;
/// How often the loop looks for recordings that have ended, when no message arrives.
const REAP_INTERVAL: Duration = Duration::from_millis(50);
/// Messages read ahead of the loop. A full channel stops the reader, and the client's pipe fills behind it.
const READ_AHEAD: usize = 16;

/// How the process was told to run.
#[derive(Debug, Clone)]
pub struct Config {
    /// The encoder program, found on `PATH` when it has no slash.
    pub ffmpeg: PathBuf,
}

/// Why the process stopped reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// A shutdown message, or the input ended between messages.
    Clean,
    /// The input broke the framing.
    Violation,
}

impl Outcome {
    pub fn exit_code(self) -> u8 {
        match self {
            Outcome::Clean => 0,
            Outcome::Violation => 2,
        }
    }
}

// What the reader thread hands over: a message, or why there are no more.
enum Input {
    Message(Envelope),
    Ended(Option<ReadError>),
}

/// Serves one client until it shuts the process down or its input ends.
pub fn serve(input: impl Read + Send + 'static, replies: Replies, config: &Config) -> Outcome {
    let mut server = Server {
        ffmpeg: config.ffmpeg.clone(),
        probe: Probe::begin(config.ffmpeg.clone()),
        recordings: HashMap::new(),
        ended: EndedIds::default(),
        replies,
    };
    server.replies.send(&Reply::Hello(Hello {
        protocol: protocol::PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        ffmpeg: config.ffmpeg.to_string_lossy().into_owned(),
    }));
    let messages = read_in_background(input);
    let outcome = loop {
        server.reap();
        let envelope = match messages.recv_timeout(REAP_INTERVAL) {
            Ok(Input::Message(envelope)) => envelope,
            Err(RecvTimeoutError::Timeout) => continue,
            Ok(Input::Ended(None)) | Err(RecvTimeoutError::Disconnected) => break Outcome::Clean,
            Ok(Input::Ended(Some(error))) => {
                server.error(
                    ErrorCode::ProtocolViolation,
                    None,
                    format!("{error}; the media process is shutting down"),
                );
                break Outcome::Violation;
            }
        };
        match protocol::parse_request(envelope) {
            Ok(Incoming::Start(start)) => server.start(start),
            Ok(Incoming::Frame(header, bytes)) => server.frame(&header, bytes),
            Ok(Incoming::Finish(finish)) => server.finish(&finish),
            Ok(Incoming::Shutdown) => break Outcome::Clean,
            Err(Refusal {
                message,
                recording_id,
            }) => server.error(ErrorCode::InvalidMessage, recording_id, message),
        }
    };
    server.shut_down();
    outcome
}

// Reads messages on a thread of its own. The thread ends with the input; when the loop has stopped listening it
// ends at its next message, or with the process.
fn read_in_background(mut input: impl Read + Send + 'static) -> Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(READ_AHEAD);
    let reader = thread::Builder::new()
        .name("input".to_owned())
        .spawn(move || {
            loop {
                let input = match protocol::read_envelope(&mut input) {
                    Ok(envelope) => Input::Message(envelope),
                    Err(ReadError::Closed) => Input::Ended(None),
                    Err(error) => Input::Ended(Some(error)),
                };
                let last = matches!(input, Input::Ended(_));
                if sender.send(input).is_err() || last {
                    return;
                }
            }
        });
    if let Err(error) = reader {
        // Without a reader there is no input; the loop sees a closed channel and shuts down cleanly. Writing
        // why is the one thing left to do, on the stream a client keeps for the process's own failures.
        eprintln!("retest-media: the input reader could not start: {error}");
    }
    receiver
}

struct Server {
    ffmpeg: PathBuf,
    probe: Probe,
    recordings: HashMap<String, Recording>,
    ended: EndedIds,
    replies: Replies,
}

impl Server {
    fn start(&mut self, start: StartRecording) {
        let id = start.recording_id.clone();
        if self.recordings.contains_key(&id) || self.ended.contains(&id) {
            return self.error(
                ErrorCode::DuplicateRecording,
                Some(id),
                "a recording with this id already started".to_owned(),
            );
        }
        if self.recordings.len() >= MAX_RECORDINGS {
            let message = format!("{MAX_RECORDINGS} recordings are already running");
            return self.error(ErrorCode::TooManyRecordings, Some(id), message);
        }
        let checked = match check_start(&start) {
            Ok(checked) => checked,
            Err(message) => return self.error(ErrorCode::InvalidStart, Some(id), message),
        };
        let capabilities = match self.probe.capabilities().clone() {
            Ok(capabilities) => capabilities,
            Err(failure) => return self.end_before_start(&id, EndStatus::EncoderFailed, failure),
        };
        let Some(codec) = Codec::choose(&capabilities) else {
            let message = format!(
                "{} ({}) cannot record: it lacks {}",
                self.ffmpeg.display(),
                capabilities.version,
                capabilities.missing()
            );
            return self.end_before_start(
                &id,
                EndStatus::EncoderUnavailable,
                EncoderFailure {
                    message,
                    exit: None,
                },
            );
        };
        let mut path = checked.output.into_os_string();
        path.push(".");
        path.push(codec.container());
        let path = PathBuf::from(path);
        if let Some(message) = self.output_in_use(&path) {
            return self.error(ErrorCode::OutputInUse, Some(id), message);
        }
        let plan = RecordingPlan {
            id: id.clone(),
            width: start.width,
            height: start.height,
            fps: start.fps,
            codec,
            path,
            deadline: Duration::from_millis(start.deadline_ms),
            queue_frames: checked.queue_frames,
            queue_bytes: checked.queue_bytes,
            max_gap_us: checked.max_gap_ms * 1000,
            max_duration_us: checked.max_duration_ms * 1000,
            stall: Duration::from_millis(checked.stall_ms),
        };
        match Recording::start(plan, &self.ffmpeg, &capabilities, self.replies.clone()) {
            Ok(recording) => {
                self.recordings.insert(id, recording);
            }
            Err(failure) => self.end_before_start(&id, EndStatus::EncoderFailed, failure),
        }
    }

    // Why a video path cannot be used: a file at it or at its `.partial`, or a running recording writing it.
    // Each is named, so the client can choose another path.
    fn output_in_use(&self, path: &Path) -> Option<String> {
        let partial = recording::partial_path_of(path);
        for taken in [path, partial.as_path()] {
            if taken.symlink_metadata().is_ok() {
                return Some(format!("a file is already at {}", taken.display()));
            }
        }
        self.recordings
            .iter()
            .find(|(_, recording)| recording.path() == path)
            .map(|(other, _)| format!("recording {other} is writing {}", path.display()))
    }

    fn frame(&mut self, header: &FrameHeader, bytes: Vec<u8>) {
        match self.recordings.get(&header.recording_id) {
            Some(recording) if !recording.closed_to_frames() => recording.receive(header, bytes),
            // Frames after a finish, or racing an end the client has not read yet, are not part of the recording.
            Some(_) => {}
            None if self.ended.contains(&header.recording_id) => {}
            None => self.error(
                ErrorCode::UnknownRecording,
                Some(header.recording_id.clone()),
                "no recording has this id".to_owned(),
            ),
        }
    }

    fn finish(&mut self, finish: &FinishRecording) {
        match self.recordings.get_mut(&finish.recording_id) {
            Some(recording) => recording.finish(finish.end_timestamp_us),
            None if self.ended.contains(&finish.recording_id) => {}
            None => self.error(
                ErrorCode::UnknownRecording,
                Some(finish.recording_id.clone()),
                "no recording has this id".to_owned(),
            ),
        }
    }

    // Joins recordings whose threads have returned, so their ids move to the ended set, and sends the `ended` of
    // any whose thread failed before sending its own.
    fn reap(&mut self) {
        let done: Vec<String> = self
            .recordings
            .iter()
            .filter(|(_, recording)| recording.thread_done())
            .map(|(id, _)| id.clone())
            .collect();
        for id in done {
            if let Some(recording) = self.recordings.remove(&id) {
                recording.join(&self.replies);
                self.ended.insert(id);
            }
        }
    }

    fn shut_down(&mut self) {
        for recording in self.recordings.values() {
            recording.stop();
        }
        let mut stopped = 0;
        for (id, recording) in self.recordings.drain() {
            stopped += u64::from(recording.join(&self.replies) == EndStatus::Stopped);
            self.ended.insert(id);
        }
        self.probe.wait();
        self.replies.send(&Reply::Bye(Bye { stopped }));
    }

    fn end_before_start(&mut self, id: &str, status: EndStatus, failure: EncoderFailure) {
        self.ended.insert(id.to_owned());
        self.replies
            .send(&Reply::Ended(recording::ended_before_start(
                id,
                status,
                failure.message,
                failure.exit,
            )));
    }

    fn error(&self, code: ErrorCode, recording_id: Option<String>, message: String) {
        self.replies.send(&Reply::Error(ErrorReply {
            code,
            recording_id,
            message,
        }));
    }
}

// The ids of recordings that have ended, the oldest forgotten past `REMEMBERED_ENDINGS`.
#[derive(Default)]
struct EndedIds {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl EndedIds {
    fn insert(&mut self, id: String) {
        if !self.ids.insert(id.clone()) {
            return;
        }
        self.order.push_back(id);
        while self.order.len() > REMEMBERED_ENDINGS {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }
}

struct CheckedStart {
    output: PathBuf,
    queue_frames: usize,
    queue_bytes: usize,
    max_gap_ms: u64,
    max_duration_ms: u64,
    stall_ms: u64,
}

fn check_start(start: &StartRecording) -> Result<CheckedStart, String> {
    let id_length = start.recording_id.chars().count();
    if id_length == 0 || id_length > MAX_ID_CHARACTERS {
        return Err(format!(
            "the recording id must have 1 to {MAX_ID_CHARACTERS} characters"
        ));
    }
    for (name, side) in [("width", start.width), ("height", start.height)] {
        if !(2..=MAX_SIDE).contains(&side) || side % 2 != 0 {
            return Err(format!(
                "the {name} must be an even number from 2 to {MAX_SIDE}, as 4:2:0 video needs; it is {side}"
            ));
        }
    }
    if !(1..=MAX_FPS).contains(&start.fps) {
        return Err(format!(
            "the frame rate must be from 1 to {MAX_FPS}; it is {}",
            start.fps
        ));
    }
    in_range("deadline", start.deadline_ms, 1..=MAX_DEADLINE_MS, "ms")?;
    let queue_frames = start.queue_frames.unwrap_or(DEFAULT_QUEUE_FRAMES);
    in_range("queue", queue_frames, 1..=MAX_QUEUE_FRAMES, "frames")?;
    let queue_bytes = start.queue_bytes.unwrap_or(DEFAULT_QUEUE_BYTES);
    in_range("queue", queue_bytes, 1..=MAX_QUEUE_BYTES, "bytes")?;
    let max_duration_ms = start.max_duration_ms.unwrap_or(DEFAULT_MAX_DURATION_MS);
    in_range(
        "maximum duration",
        max_duration_ms,
        1..=MAX_DURATION_MS,
        "ms",
    )?;
    let max_gap_ms = start
        .max_gap_ms
        .unwrap_or(DEFAULT_MAX_GAP_MS.min(max_duration_ms));
    in_range("maximum gap", max_gap_ms, 1..=max_duration_ms, "ms")?;
    let stall_ms = start.stall_ms.unwrap_or(DEFAULT_STALL_MS);
    in_range("stall limit", stall_ms, STALL_RANGE_MS, "ms")?;
    Ok(CheckedStart {
        output: check_output(&start.output)?,
        queue_frames,
        queue_bytes,
        max_gap_ms,
        max_duration_ms,
        stall_ms,
    })
}

fn in_range<T: PartialOrd + std::fmt::Display>(
    name: &str,
    value: T,
    range: std::ops::RangeInclusive<T>,
    unit: &str,
) -> Result<(), String> {
    if range.contains(&value) {
        return Ok(());
    }
    Err(format!(
        "the {name} must be from {} to {} {unit}; it is {value}",
        range.start(),
        range.end()
    ))
}

fn check_output(output: &str) -> Result<PathBuf, String> {
    let path = Path::new(output);
    if !path.is_absolute() || output.ends_with('/') {
        return Err(format!(
            "the output must be an absolute file path without its extension; it is {output}"
        ));
    }
    match path.parent() {
        Some(folder) if folder.is_dir() => Ok(path.to_path_buf()),
        _ => Err(format!("the output's folder does not exist: {output}")),
    }
}

// The encoder's answer to what it can do, asked once in the background as the process starts, so the first
// recording seldom waits for it.
struct Probe {
    running: Option<JoinHandle<Result<Capabilities, EncoderFailure>>>,
    answer: Option<Result<Capabilities, EncoderFailure>>,
}

impl Probe {
    fn begin(ffmpeg: PathBuf) -> Probe {
        match thread::Builder::new()
            .name("probe".to_owned())
            .spawn(move || encoder::probe(&ffmpeg))
        {
            Ok(running) => Probe {
                running: Some(running),
                answer: None,
            },
            Err(error) => Probe {
                running: None,
                answer: Some(Err(EncoderFailure {
                    message: format!("the encoder could not be asked what it can do: {error}"),
                    exit: None,
                })),
            },
        }
    }

    fn capabilities(&mut self) -> &Result<Capabilities, EncoderFailure> {
        self.wait();
        self.answer.get_or_insert_with(|| {
            Err(EncoderFailure {
                message: "the encoder could not be asked what it can do".to_owned(),
                exit: None,
            })
        })
    }

    // The probe ends on its own within its timeouts, so waiting for it leaves no encoder running at exit.
    fn wait(&mut self) {
        if let Some(running) = self.running.take() {
            let failed = || {
                Err(EncoderFailure {
                    message: "asking the encoder what it can do failed inside the media process"
                        .to_owned(),
                    exit: None,
                })
            };
            self.answer = Some(running.join().unwrap_or_else(|_| failed()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(output: &str) -> StartRecording {
        StartRecording {
            recording_id: "r".to_owned(),
            width: 800,
            height: 600,
            fps: 30,
            output: output.to_owned(),
            deadline_ms: 1000,
            queue_frames: None,
            queue_bytes: None,
            max_gap_ms: None,
            max_duration_ms: None,
            stall_ms: None,
        }
    }

    #[test]
    fn a_sound_start_takes_the_defaults() {
        let output = std::env::temp_dir()
            .join("recording")
            .to_string_lossy()
            .into_owned();
        let checked = check_start(&start(&output)).expect("accepted");
        assert_eq!(
            (checked.queue_frames, checked.queue_bytes),
            (DEFAULT_QUEUE_FRAMES, DEFAULT_QUEUE_BYTES)
        );
        assert_eq!(
            (
                checked.max_gap_ms,
                checked.max_duration_ms,
                checked.stall_ms
            ),
            (
                DEFAULT_MAX_GAP_MS,
                DEFAULT_MAX_DURATION_MS,
                DEFAULT_STALL_MS
            )
        );
    }

    #[test]
    fn starts_the_encoder_cannot_honour_are_refused() {
        let output = std::env::temp_dir()
            .join("recording")
            .to_string_lossy()
            .into_owned();
        let cases: [(&str, StartRecording); 11] = [
            (
                "id past the limit",
                StartRecording {
                    recording_id: "x".repeat(MAX_ID_CHARACTERS + 1),
                    ..start(&output)
                },
            ),
            (
                "odd width",
                StartRecording {
                    width: 801,
                    ..start(&output)
                },
            ),
            (
                "zero height",
                StartRecording {
                    height: 0,
                    ..start(&output)
                },
            ),
            (
                "no frame rate",
                StartRecording {
                    fps: 0,
                    ..start(&output)
                },
            ),
            (
                "no deadline",
                StartRecording {
                    deadline_ms: 0,
                    ..start(&output)
                },
            ),
            (
                "empty queue",
                StartRecording {
                    queue_frames: Some(0),
                    ..start(&output)
                },
            ),
            (
                "gap past the duration",
                StartRecording {
                    max_gap_ms: Some(2000),
                    max_duration_ms: Some(1000),
                    ..start(&output)
                },
            ),
            (
                "duration past four hours",
                StartRecording {
                    max_duration_ms: Some(MAX_DURATION_MS + 1),
                    ..start(&output)
                },
            ),
            (
                "stall limit too short",
                StartRecording {
                    stall_ms: Some(10),
                    ..start(&output)
                },
            ),
            ("relative output", start("recording")),
            ("missing folder", start("/no/such/folder/recording")),
        ];
        for (name, case) in cases {
            assert!(check_start(&case).is_err(), "{name} was accepted");
        }
    }

    #[test]
    fn the_ended_set_forgets_its_oldest_ids() {
        let mut ended = EndedIds::default();
        for index in 0..=REMEMBERED_ENDINGS {
            ended.insert(index.to_string());
        }
        assert!(!ended.contains("0"));
        assert!(ended.contains("1"));
        assert!(ended.contains(&REMEMBERED_ENDINGS.to_string()));
        assert_eq!(ended.order.len(), REMEMBERED_ENDINGS);
    }
}
