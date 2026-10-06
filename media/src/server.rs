//! Reads the client's messages and runs its recordings, live views and image jobs.
//!
//! Standard input is read on a thread of its own and handed over through a small bounded channel, so the loop
//! here wakes at least every `REAP_INTERVAL` and reports a recording that ended, or whose thread failed, without
//! waiting for the client's next message. The loop never waits on an encoder, an image or the client reading its
//! pipe: recordings feed their encoders on threads of their own, thumbnails and frame sequences run on the job
//! pool, live views on threads of their own, and replies are written by the reply thread. A start that arrives
//! before the encoder probe has answered waits in a queue while the loop goes on. Shutting down, and the input
//! ending, stop every unfinished recording, let finishing ones complete within their deadlines, answer every live
//! view, job and waiting start, remove kept frames, and wait for each `ended` before `bye`, so the process leaves no
//! encoder behind.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::encoder::{self, Capabilities, Codec, EncoderFailure, Input};
use crate::jobs::{self, Job, Jobs};
use crate::live::{MAX_LIVE_FPS, ViewRequest, Watch};
use crate::place::{copying_path_of, partial_path_of};
use crate::protocol::{
    self, BuildIdentity, Bye, CaptureGapRequest, EncoderProbe, EndStatus, Envelope, ErrorCode,
    ErrorReply, FinishRecording, FrameHeader, FramesRequest, Hello, Incoming, LeftoverFile,
    Leftovers, LeftoversRequest, MAX_FRAME_ID_CHARACTERS, MAX_ID_CHARACTERS,
    MAX_IDENTITY_CHARACTERS, MAX_PATH_BYTES, ReadError, ReadyReply, RecordingRequest, Refusal,
    Released, Reply, StartRecording, ThumbnailRequest, WatchEnded, WatchRequest,
};
use crate::recording::{self, Recording, RecordingData, RecordingPlan};
use crate::replies::Replies;
use crate::store::{DEFAULT_STORE_BYTES, FrameStore, MAX_STORE_BYTES, store_path_of};

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
/// The widest or tallest image a thumbnail, a frame sequence or a live view may ask for.
const MAX_OUTPUT_SIDE: u32 = 4096;
/// The most frames one frame sequence returns, and the most bytes of images it may carry.
const MAX_SEQUENCE_FRAMES: usize = 64;
const MAX_SEQUENCE_BYTES: usize = 48 * 1024 * 1024;
/// How many recordings may run at once, starts waiting for the probe among them.
const MAX_RECORDINGS: usize = 16;
/// How many ended recordings keep their frames for frame sequences. When one more ends, the oldest is released.
const RETAINED_RECORDINGS: usize = 64;
/// How many ended recording ids are remembered, so their late frames are ignored and their ids not reused.
/// Older ones are forgotten: a late frame for one is then answered `unknown_recording`.
const REMEMBERED_ENDINGS: usize = 4096;
/// How often the loop looks for recordings that have ended, and for the probe's answer, when no message arrives.
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

/// How this binary was built, from what its build script recorded.
pub fn build_identity() -> BuildIdentity {
    BuildIdentity {
        revision: option_env!("RETEST_MEDIA_REVISION").map(str::to_owned),
        dirty: option_env!("RETEST_MEDIA_DIRTY").map(|dirty| dirty == "true"),
        target: env!("RETEST_MEDIA_TARGET").to_owned(),
        profile: env!("RETEST_MEDIA_PROFILE").to_owned(),
    }
}

// What the reader thread hands over: a message, or why there are no more.
enum Received {
    Message(Envelope),
    Ended(Option<ReadError>),
}

/// Serves one client until it shuts the process down or its input ends.
pub fn serve(input: impl Read + Send + 'static, replies: Replies, config: &Config) -> Outcome {
    let mut server = Server {
        ffmpeg: config.ffmpeg.clone(),
        probe: Probe::begin(config.ffmpeg.clone()),
        recordings: HashMap::new(),
        pending: VecDeque::new(),
        pending_watches: Vec::new(),
        readies: 0,
        retained: VecDeque::new(),
        watches: HashMap::new(),
        ended: RememberedIds::default(),
        released: RememberedIds::default(),
        jobs: Jobs::start(&replies),
        replies,
    };
    // The greeting does not wait for the probe: a start waits for it instead, so no recording begins on an encoder
    // the process has not asked, and `ready` answers once it has.
    server.replies.send(&Reply::Hello(Hello {
        protocol: protocol::PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        build: build_identity(),
        ffmpeg: config.ffmpeg.to_string_lossy().into_owned(),
        encoder: server.probe.state(),
    }));
    let messages = read_in_background(input, server.replies.clone());
    let outcome = loop {
        server.reap();
        server.answer_probe();
        let envelope = match messages.recv_timeout(REAP_INTERVAL) {
            Ok(Received::Message(envelope)) => envelope,
            Err(RecvTimeoutError::Timeout) => continue,
            Ok(Received::Ended(None)) | Err(RecvTimeoutError::Disconnected) => {
                break Outcome::Clean;
            }
            Ok(Received::Ended(Some(error))) => {
                server.error(
                    ErrorCode::ProtocolViolation,
                    &Refusal {
                        message: format!("{error}; the media process is shutting down"),
                        request: None,
                        recording_id: None,
                        request_id: None,
                    },
                );
                break Outcome::Violation;
            }
        };
        match protocol::parse_request(envelope) {
            Ok(Incoming::Ready) => server.ready(),
            Ok(Incoming::Start(start)) => server.start(start),
            Ok(Incoming::Frame(header, bytes)) => server.frame(&header, bytes),
            Ok(Incoming::CaptureGap(gap)) => server.capture_gap(gap),
            Ok(Incoming::Finish(finish)) => server.finish(&finish),
            Ok(Incoming::Thumbnail(request, bytes)) => server.thumbnail(request, bytes),
            Ok(Incoming::Frames(request)) => server.frames(request),
            Ok(Incoming::Watch(request)) => server.watch(&request),
            Ok(Incoming::Unwatch(request)) => server.unwatch(&request),
            Ok(Incoming::Release(request)) => server.release(&request),
            Ok(Incoming::Leftovers(request)) => server.leftovers(&request),
            Ok(Incoming::Shutdown) => break Outcome::Clean,
            Err(refusal) => server.error(ErrorCode::InvalidMessage, &refusal),
        }
    };
    server.replies.input_closed();
    server.shut_down();
    outcome
}

// Reads messages on a thread of its own. The thread ends with the input; when the loop has stopped listening it
// ends at its next message, or with the process.
fn read_in_background(
    mut input: impl Read + Send + 'static,
    replies: Replies,
) -> Receiver<Received> {
    let (sender, receiver) = mpsc::sync_channel(READ_AHEAD);
    let reader = thread::Builder::new()
        .name("input".to_owned())
        .spawn(move || {
            loop {
                let input = match protocol::read_envelope(&mut input) {
                    Ok(envelope) => Received::Message(envelope),
                    Err(ReadError::Closed) => Received::Ended(None),
                    Err(error) => Received::Ended(Some(error)),
                };
                let last = matches!(input, Received::Ended(_));
                if last {
                    replies.input_closed();
                }
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

// A start checked and waiting for the encoder probe to answer.
struct PendingStart {
    start: StartRecording,
    checked: CheckedStart,
}

struct Server {
    ffmpeg: PathBuf,
    probe: Probe,
    recordings: HashMap<String, Recording>,
    pending: VecDeque<PendingStart>,
    /// Live views asked for recordings still waiting for the probe; each begins once its recording does.
    pending_watches: Vec<WatchRequest>,
    /// `ready` requests waiting for the probe's answer.
    readies: u64,
    /// Ended recordings whose frames are kept, oldest first.
    retained: VecDeque<Arc<RecordingData>>,
    watches: HashMap<String, Watch>,
    ended: RememberedIds,
    released: RememberedIds,
    jobs: Jobs,
    replies: Replies,
}

impl Server {
    fn ready(&mut self) {
        if self.probe.finished() {
            self.replies.send(&Reply::Ready(ReadyReply {
                encoder: self.probe.state(),
            }));
        } else {
            self.readies += 1;
        }
    }

    // Once the probe has answered: answers the `ready` requests and begins the starts that waited for it, in order.
    fn answer_probe(&mut self) {
        if !self.probe.poll() {
            return;
        }
        for _ in 0..std::mem::take(&mut self.readies) {
            self.replies.send(&Reply::Ready(ReadyReply {
                encoder: self.probe.state(),
            }));
        }
        while let Some(pending) = self.pending.pop_front() {
            self.begin(pending.start, pending.checked);
        }
        // Each recording has begun or ended now, so each waiting view is answered for what it truly found.
        for request in std::mem::take(&mut self.pending_watches) {
            self.watch(&request);
        }
    }

    fn known(&self, id: &str) -> bool {
        self.recordings.contains_key(id)
            || self
                .pending
                .iter()
                .any(|pending| pending.start.recording_id == id)
            || self.retained.iter().any(|data| data.id == id)
            || self.ended.contains(id)
    }

    fn start(&mut self, start: StartRecording) {
        let id = start.recording_id.clone();
        let refuse = |code: ErrorCode, message: String| {
            (
                code,
                Refusal {
                    message,
                    request: Some("start"),
                    recording_id: Some(id.clone()),
                    request_id: None,
                },
            )
        };
        let refusal = if self.known(&id) {
            Some(refuse(
                ErrorCode::DuplicateRecording,
                "a recording with this id already started".to_owned(),
            ))
        } else if self.recordings.len() + self.pending.len() >= MAX_RECORDINGS {
            Some(refuse(
                ErrorCode::TooManyRecordings,
                format!("{MAX_RECORDINGS} recordings are already running"),
            ))
        } else {
            None
        };
        if let Some((code, refusal)) = refusal {
            return self.error(code, &refusal);
        }
        let checked = match check_start(&start) {
            Ok(checked) => checked,
            Err(message) => {
                return self.error(
                    ErrorCode::InvalidStart,
                    &refuse(ErrorCode::InvalidStart, message).1,
                );
            }
        };
        if self.probe.finished() {
            self.begin(start, checked);
        } else {
            self.pending.push_back(PendingStart { start, checked });
        }
    }

    fn begin(&mut self, start: StartRecording, checked: CheckedStart) {
        let id = start.recording_id.clone();
        let capabilities = match self.probe.answer() {
            Some(Ok(capabilities)) => capabilities.clone(),
            Some(Err(failure)) => {
                let failure = failure.clone();
                return self.end_before_start(&start, EndStatus::EncoderFailed, failure);
            }
            None => {
                let failure = EncoderFailure {
                    message: "the encoder could not be asked what it can do".to_owned(),
                    exit: None,
                };
                return self.end_before_start(&start, EndStatus::EncoderFailed, failure);
            }
        };
        let Some(codec) = Codec::choose(&capabilities) else {
            let message = format!(
                "{} ({}) cannot record: it lacks {}",
                self.ffmpeg.display(),
                capabilities.version,
                capabilities.missing()
            );
            return self.end_before_start(
                &start,
                EndStatus::EncoderUnavailable,
                EncoderFailure {
                    message,
                    exit: None,
                },
            );
        };
        // The encoded route is taken only when the encoder can read that format undecoded; `started` says which.
        let input = match start.encoded_format {
            Some(format) if capabilities.encoded_input().contains(&format) => Input::Images(format),
            _ => Input::Raw,
        };
        let mut path = checked.output.clone().into_os_string();
        path.push(".");
        path.push(codec.container());
        let path = PathBuf::from(path);
        if let Some(message) = self.output_in_use(&path) {
            return self.error(
                ErrorCode::OutputInUse,
                &Refusal {
                    message,
                    request: Some("start"),
                    recording_id: Some(id),
                    request_id: None,
                },
            );
        }
        let store = match checked.store_bytes {
            None => None,
            Some(bytes) => {
                let store_path = store_path_of(&checked.output);
                match FrameStore::create(store_path.clone(), bytes) {
                    Ok(store) => Some(store),
                    Err(error) => {
                        let (code, message) = if error.kind() == std::io::ErrorKind::AlreadyExists {
                            (
                                ErrorCode::OutputInUse,
                                format!("a file is already at {}", store_path.display()),
                            )
                        } else {
                            (
                                ErrorCode::InvalidStart,
                                format!(
                                    "the kept frames could not be created at {}: {error}",
                                    store_path.display()
                                ),
                            )
                        };
                        return self.error(
                            code,
                            &Refusal {
                                message,
                                request: Some("start"),
                                recording_id: Some(id),
                                request_id: None,
                            },
                        );
                    }
                }
            }
        };
        let data = Arc::new(RecordingData::new(
            id.clone(),
            start.identity.clone(),
            checked.output.clone(),
            start.fps,
            store,
        ));
        let plan = RecordingPlan {
            id: id.clone(),
            width: start.width,
            height: start.height,
            fps: start.fps,
            codec,
            input,
            path,
            deadline: Duration::from_millis(start.deadline_ms),
            queue_frames: checked.queue_frames,
            queue_bytes: checked.queue_bytes,
            max_gap_us: checked.max_gap_ms * 1000,
            max_duration_us: checked.max_duration_ms * 1000,
            stall: Duration::from_millis(checked.stall_ms),
        };
        match Recording::start(
            plan,
            Arc::clone(&data),
            &self.ffmpeg,
            &capabilities,
            self.replies.clone(),
        ) {
            Ok(recording) => {
                self.recordings.insert(id, recording);
            }
            Err(failure) => {
                if let Some(store) = data.store.as_ref() {
                    store.remove();
                }
                self.end_before_start(&start, EndStatus::EncoderFailed, failure);
            }
        }
    }

    // Why a video path cannot be used: a running recording writing it, or a file at it or at its `.partial`. Each is
    // named, so the client can choose another path. The running recording is asked first: its encoder creates the
    // `.partial` file at a moment of its own, so asking the files first would answer either way for the same request.
    fn output_in_use(&self, path: &Path) -> Option<String> {
        if let Some((other, _)) = self
            .recordings
            .iter()
            .find(|(_, recording)| recording.path() == path)
        {
            return Some(format!("recording {other} is writing {}", path.display()));
        }
        let partial = partial_path_of(path);
        let copying = copying_path_of(path);
        [path, partial.as_path(), copying.as_path()]
            .into_iter()
            .find(|taken| taken.symlink_metadata().is_ok())
            .map(|taken| format!("a file is already at {}", taken.display()))
    }

    fn frame(&mut self, header: &FrameHeader, bytes: Vec<u8>) {
        let invalid = protocol::invalid_id("frame id", &header.frame_id, MAX_FRAME_ID_CHARACTERS)
            .or_else(|| {
                header
                    .action_id
                    .as_deref()
                    .and_then(|id| protocol::invalid_id("action id", id, MAX_FRAME_ID_CHARACTERS))
            })
            .or_else(|| {
                header.observation_id.as_deref().and_then(|id| {
                    protocol::invalid_id("observation id", id, MAX_FRAME_ID_CHARACTERS)
                })
            });
        if let Some(message) = invalid {
            let refusal = Refusal {
                message,
                request: Some("frame"),
                recording_id: Some(header.recording_id.clone()),
                request_id: None,
            };
            return self.error(ErrorCode::InvalidMessage, &refusal);
        }
        match self.recordings.get(&header.recording_id) {
            Some(recording) if !recording.closed_to_frames() => recording.receive(header, bytes),
            // Frames after a finish, or racing an end the client has not read yet, are not part of the recording.
            Some(_) => {}
            None if self.ended.contains(&header.recording_id)
                || self
                    .retained
                    .iter()
                    .any(|data| data.id == header.recording_id) => {}
            None => self.unknown(&header.recording_id, "frame"),
        }
    }

    fn capture_gap(&mut self, gap: CaptureGapRequest) {
        if gap.to_us < gap.from_us || !protocol::is_reason_code(&gap.reason) {
            let message = "a capture gap needs its end at or after its start and a reason of lower-case letters, digits and underscores".to_owned();
            let refusal = Refusal {
                message,
                request: Some("captureGap"),
                recording_id: Some(gap.recording_id.clone()),
                request_id: None,
            };
            return self.error(ErrorCode::InvalidMessage, &refusal);
        }
        match self.recordings.get(&gap.recording_id) {
            Some(recording) if !recording.closed_to_frames() => recording
                .data()
                .ledger()
                .note_capture_gap(protocol::CaptureGap {
                    from_us: gap.from_us,
                    to_us: gap.to_us,
                    reason: gap.reason,
                }),
            Some(_) => {}
            None if self.ended.contains(&gap.recording_id)
                || self.retained.iter().any(|data| data.id == gap.recording_id) => {}
            None => self.unknown(&gap.recording_id, "captureGap"),
        }
    }

    fn finish(&mut self, finish: &FinishRecording) {
        match self.recordings.get_mut(&finish.recording_id) {
            Some(recording) => recording.finish(finish.end_timestamp_us),
            None if self.ended.contains(&finish.recording_id)
                || self
                    .retained
                    .iter()
                    .any(|data| data.id == finish.recording_id) => {}
            None => self.unknown(&finish.recording_id, "finish"),
        }
    }

    fn thumbnail(&mut self, request: ThumbnailRequest, bytes: Vec<u8>) {
        let problem =
            protocol::invalid_id("request id", &request.request_id, MAX_FRAME_ID_CHARACTERS)
                .or_else(|| check_output(&request.output).err())
                .or_else(|| output_size("thumbnail", request.max_width, request.max_height))
                .or_else(|| quality(request.quality));
        if let Some(message) = problem {
            let refusal = Refusal {
                message,
                request: Some("thumbnail"),
                recording_id: None,
                request_id: Some(request.request_id.clone()),
            };
            return self.error(ErrorCode::InvalidMessage, &refusal);
        }
        let path = jobs::thumbnail_path(&request);
        self.jobs
            .thumbnails
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path.clone());
        if let Err(job) = self.jobs.submit(Job::Thumbnail(request, bytes)) {
            self.jobs
                .thumbnails
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&path);
            jobs::busy(*job, &self.replies);
        }
    }

    fn frames(&mut self, request: FramesRequest) {
        let problem =
            protocol::invalid_id("request id", &request.request_id, MAX_FRAME_ID_CHARACTERS)
                .or_else(|| {
                    (request.to_us < request.from_us)
                        .then(|| "the interval ends before it starts".to_owned())
                })
                .or_else(|| {
                    (!(1..=MAX_SEQUENCE_FRAMES).contains(&request.max_frames)).then(|| {
                        format!("a frame sequence takes 1 to {MAX_SEQUENCE_FRAMES} frames")
                    })
                })
                .or_else(|| {
                    request
                        .max_bytes
                        .filter(|bytes| !(1..=MAX_SEQUENCE_BYTES).contains(bytes))
                        .map(|_| {
                            format!("a frame sequence carries 1 to {MAX_SEQUENCE_BYTES} bytes")
                        })
                })
                .or_else(|| output_size("frame sequence", request.max_width, request.max_height))
                .or_else(|| quality(request.quality));
        if let Some(message) = problem {
            let refusal = Refusal {
                message,
                request: Some("frames"),
                recording_id: Some(request.recording_id.clone()),
                request_id: Some(request.request_id.clone()),
            };
            return self.error(ErrorCode::InvalidMessage, &refusal);
        }
        let data = self
            .recordings
            .get(&request.recording_id)
            .map(|recording| Arc::clone(recording.data()))
            .or_else(|| {
                self.retained
                    .iter()
                    .find(|data| data.id == request.recording_id)
                    .cloned()
            });
        if let Some(data) = data {
            if let Err(job) = self.jobs.submit(Job::Frames(request, data)) {
                jobs::busy(*job, &self.replies);
            }
            return;
        }
        if self.ended.contains(&request.recording_id) {
            let (status, message) = if self.released.contains(&request.recording_id) {
                ("released", "the recording's kept frames were removed")
            } else {
                ("not_kept", "the recording keeps no frames")
            };
            let gone = RecordingData::new(
                request.recording_id.clone(),
                empty_identity(),
                PathBuf::new(),
                1,
                None,
            );
            gone.ended.store(true, std::sync::atomic::Ordering::Release);
            let reply = jobs::sequence_status(&request, &gone, status, message);
            return self.replies.send(&Reply::Frames(Box::new(reply)));
        }
        let refusal = Refusal {
            message: "no recording has this id".to_owned(),
            request: Some("frames"),
            recording_id: Some(request.recording_id),
            request_id: Some(request.request_id),
        };
        self.error(ErrorCode::UnknownRecording, &refusal);
    }

    fn watch(&mut self, request: &WatchRequest) {
        let refusal = |code: ErrorCode, message: String| {
            (
                code,
                Refusal {
                    message,
                    request: Some("watch"),
                    recording_id: Some(request.recording_id.clone()),
                    request_id: None,
                },
            )
        };
        let problem = output_size("live view", request.max_width, request.max_height)
            .or_else(|| {
                (!(1..=MAX_LIVE_FPS).contains(&request.max_fps))
                    .then(|| format!("a live view sends 1 to {MAX_LIVE_FPS} frames a second"))
            })
            .or_else(|| quality(request.quality));
        if let Some(message) = problem {
            let (code, refusal) = refusal(ErrorCode::InvalidMessage, message);
            return self.error(code, &refusal);
        }
        // A recording still waiting for the probe has not begun; its view waits with it rather than being told the
        // recording is over.
        if self
            .pending
            .iter()
            .any(|pending| pending.start.recording_id == request.recording_id)
        {
            if self
                .pending_watches
                .iter()
                .any(|waiting| waiting.recording_id == request.recording_id)
            {
                let (code, refusal) = refusal(
                    ErrorCode::AlreadyWatched,
                    "the recording already has a live view".to_owned(),
                );
                return self.error(code, &refusal);
            }
            return self.pending_watches.push(request.clone());
        }
        let running = self
            .recordings
            .get(&request.recording_id)
            .filter(|recording| !recording.closed_to_frames());
        let Some(recording) = running else {
            if self.recordings.contains_key(&request.recording_id)
                || self.known(&request.recording_id)
            {
                // A recording that is finishing or over has no newest frame to come; the view ends as it begins.
                return self.replies.send(&Reply::WatchEnded(WatchEnded {
                    recording_id: request.recording_id.clone(),
                    reason: "recording_ended",
                    message: Some("the recording is finishing or over".to_owned()),
                    sent: 0,
                    skipped: 0,
                    dropped: 0,
                    failed: 0,
                }));
            }
            return self.unknown(&request.recording_id, "watch");
        };
        if self.watches.contains_key(&request.recording_id) {
            let (code, refusal) = refusal(
                ErrorCode::AlreadyWatched,
                "the recording already has a live view".to_owned(),
            );
            return self.error(code, &refusal);
        }
        let view = ViewRequest {
            max_width: request.max_width,
            max_height: request.max_height,
            max_fps: request.max_fps,
            quality: request.quality,
        };
        match Watch::begin(Arc::clone(recording.data()), view, self.replies.clone()) {
            Ok(watch) => {
                self.watches.insert(request.recording_id.clone(), watch);
                self.replies.send(&Reply::Watching(protocol::Watching {
                    recording_id: request.recording_id.clone(),
                    max_width: request.max_width,
                    max_height: request.max_height,
                    max_fps: request.max_fps,
                }));
            }
            Err(error) => self.replies.send(&Reply::WatchEnded(WatchEnded {
                recording_id: request.recording_id.clone(),
                reason: "failed",
                message: Some(format!("the live view could not start: {error}")),
                sent: 0,
                skipped: 0,
                dropped: 0,
                failed: 0,
            })),
        }
    }

    fn unwatch(&mut self, request: &RecordingRequest) {
        if let Some(position) = self
            .pending_watches
            .iter()
            .position(|waiting| waiting.recording_id == request.recording_id)
        {
            self.pending_watches.remove(position);
            return self.end_unbegun_watch(&request.recording_id, "unwatched");
        }
        match self.watches.remove(&request.recording_id) {
            Some(watch) => watch.end("unwatched"),
            None => {
                let refusal = Refusal {
                    message: "the recording has no live view".to_owned(),
                    request: Some("unwatch"),
                    recording_id: Some(request.recording_id.clone()),
                    request_id: None,
                };
                self.error(ErrorCode::NotWatched, &refusal);
            }
        }
    }

    fn release(&mut self, request: &RecordingRequest) {
        let id = &request.recording_id;
        // The worker publishes its ending before returning. Its store and ledger are settled then, even if the
        // server has not joined the thread yet. Keep supervising that thread, but honor the client's release now.
        if let Some(recording) = self.recordings.get(id)
            && recording.is_over()
        {
            let data = Arc::clone(recording.data());
            self.let_go(&data, "requested");
            return;
        }
        if self.recordings.contains_key(id)
            || self
                .pending
                .iter()
                .any(|pending| &pending.start.recording_id == id)
        {
            let refusal = Refusal {
                message: "the recording is still running; release it once it has ended".to_owned(),
                request: Some("release"),
                recording_id: Some(id.clone()),
                request_id: None,
            };
            return self.error(ErrorCode::RecordingRunning, &refusal);
        }
        if let Some(position) = self.retained.iter().position(|data| &data.id == id) {
            if let Some(data) = self.retained.remove(position) {
                self.let_go(&data, "requested");
            }
            return;
        }
        if self.ended.contains(id) {
            return self.replies.send(&Reply::Released(Released {
                recording_id: id.clone(),
                reason: "requested",
                removed: Vec::new(),
            }));
        }
        self.unknown(id, "release");
    }

    // Removes an ended recording's kept frames and says so.
    fn let_go(&mut self, data: &RecordingData, reason: &'static str) {
        data.released
            .store(true, std::sync::atomic::Ordering::Release);
        let removed = data
            .store
            .as_ref()
            .filter(|store| store.remove())
            .map(|store| vec![store.path().to_string_lossy().into_owned()])
            .unwrap_or_default();
        self.released.insert(data.id.clone());
        self.replies.send(&Reply::Released(Released {
            recording_id: data.id.clone(),
            reason,
            removed,
        }));
    }

    fn leftovers(&mut self, request: &LeftoversRequest) {
        let reply = |status: &'static str, message: Option<String>| Leftovers {
            request_id: request.request_id.clone(),
            status,
            message,
            output: request.output.clone(),
            files: Vec::new(),
            removed: false,
            skipped: Vec::new(),
        };
        let output = Path::new(&request.output);
        if !output.is_absolute()
            || request.output.ends_with('/')
            || request.output.len() > MAX_PATH_BYTES
        {
            let message = format!(
                "the output must be an absolute file path without its extension, at most {MAX_PATH_BYTES} bytes"
            );
            return self
                .replies
                .send(&Reply::Leftovers(reply("invalid", Some(message))));
        }
        if let Some(user) = self.output_user(output) {
            return self.replies.send(&Reply::Leftovers(reply(
                "in_use",
                Some(format!("{user} uses this output")),
            )));
        }
        let mut found = reply("ok", None);
        let candidates = [
            ("mp4.partial", "video_partial"),
            ("webm.partial", "video_partial"),
            ("mp4.copying", "video_partial"),
            ("webm.copying", "video_partial"),
            ("frames", "frame_store"),
            ("png.partial", "thumbnail_partial"),
            ("jpg.partial", "thumbnail_partial"),
            ("png.copying", "thumbnail_partial"),
            ("jpg.copying", "thumbnail_partial"),
        ];
        for (suffix, kind) in candidates {
            let mut path = output.as_os_str().to_owned();
            path.push(".");
            path.push(suffix);
            let path = PathBuf::from(path);
            match path.symlink_metadata() {
                Ok(metadata) if metadata.is_file() => found.files.push(LeftoverFile {
                    path: path.to_string_lossy().into_owned(),
                    kind,
                    byte_length: metadata.len(),
                }),
                Ok(_) => found.skipped.push(path.to_string_lossy().into_owned()),
                Err(_) => {}
            }
        }
        if request.remove {
            let failures: Vec<String> = found
                .files
                .iter()
                .filter_map(|file| {
                    fs::remove_file(&file.path)
                        .err()
                        .map(|error| format!("{}: {error}", file.path))
                })
                .collect();
            found.removed = failures.is_empty();
            if !failures.is_empty() {
                found.message = Some(format!(
                    "not every file could be removed: {}",
                    failures.join("; ")
                ));
            }
        }
        self.replies.send(&Reply::Leftovers(found));
    }

    // What of this process uses an output: a running, waiting or retained recording, or a thumbnail being written.
    // The output may be named another way than its user named it, through a symbolic link or `..`.
    fn output_user(&self, output: &Path) -> Option<String> {
        if let Some(data) = self
            .recordings
            .values()
            .map(|recording| recording.data())
            .find(|data| same_output(&data.output, output))
        {
            return Some(format!("recording {}", data.id));
        }
        if let Some(pending) = self
            .pending
            .iter()
            .find(|pending| same_output(&pending.checked.output, output))
        {
            return Some(format!("recording {}", pending.start.recording_id));
        }
        if let Some(data) = self
            .retained
            .iter()
            .find(|data| same_output(&data.output, output))
        {
            return Some(format!(
                "ended recording {}, whose frames are kept,",
                data.id
            ));
        }
        let thumbnails = self
            .jobs
            .thumbnails
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let written = thumbnails
            .iter()
            .any(|path| same_output(&path.with_extension(""), output));
        written.then(|| "a thumbnail being written".to_owned())
    }

    // Joins recordings whose threads have returned, so their ids move to the ended set, ends their live views, and
    // keeps their frames for frame sequences.
    fn reap(&mut self) {
        let done: Vec<String> = self
            .recordings
            .iter()
            .filter(|(_, recording)| recording.thread_done())
            .map(|(id, _)| id.clone())
            .collect();
        for id in done {
            if let Some(watch) = self.watches.remove(&id) {
                watch.end("recording_ended");
            }
            if let Some(recording) = self.recordings.remove(&id) {
                let data = Arc::clone(recording.data());
                recording.join(&self.replies);
                self.keep_ended(data);
                self.ended.insert(id);
            }
        }
    }

    fn keep_ended(&mut self, data: Arc<RecordingData>) {
        if data.store.is_none() || data.released.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        self.retained.push_back(data);
        while self.retained.len() > RETAINED_RECORDINGS {
            if let Some(oldest) = self.retained.pop_front() {
                self.let_go(&oldest, "limit");
            }
        }
    }

    fn shut_down(&mut self) {
        let message = "the media process shut down before the recording started".to_owned();
        while let Some(pending) = self.pending.pop_front() {
            self.end_before_start(
                &pending.start,
                EndStatus::Stopped,
                EncoderFailure {
                    message: message.clone(),
                    exit: None,
                },
            );
        }
        for request in std::mem::take(&mut self.pending_watches) {
            self.end_unbegun_watch(&request.recording_id, "shutdown");
        }
        for (_, watch) in self.watches.drain() {
            watch.end("shutdown");
        }
        for recording in self.recordings.values() {
            recording.stop();
        }
        let mut stopped = 0;
        let running: Vec<(String, Recording)> = self.recordings.drain().collect();
        for (id, recording) in running {
            let data = Arc::clone(recording.data());
            // A recording whose encoder no stop could reach is left unended rather than holding the shutdown forever.
            let ended = recording.join_within_bound(&self.replies);
            stopped += u64::from(ended == Some(EndStatus::Stopped));
            self.keep_ended(data);
            self.ended.insert(id);
        }
        // Jobs may still read kept frames, so they end before the frames are removed. The removal is not announced
        // one recording at a time: `bye` says every kept frame is gone.
        self.jobs.shut_down(&self.replies);
        while let Some(data) = self.retained.pop_front() {
            if let Some(store) = data.store.as_ref() {
                store.remove();
            }
        }
        self.probe.wait();
        for _ in 0..std::mem::take(&mut self.readies) {
            self.replies.send(&Reply::Ready(ReadyReply {
                encoder: self.probe.state(),
            }));
        }
        let dropped = self.replies.dropped();
        self.replies.send(&Reply::Bye(Bye {
            stopped,
            replies_dropped: (dropped > 0).then_some(dropped),
        }));
    }

    // Ends a live view that never began, having sent nothing.
    fn end_unbegun_watch(&self, recording_id: &str, reason: &'static str) {
        self.replies.send(&Reply::WatchEnded(WatchEnded {
            recording_id: recording_id.to_owned(),
            reason,
            message: None,
            sent: 0,
            skipped: 0,
            dropped: 0,
            failed: 0,
        }));
    }

    fn end_before_start(
        &mut self,
        start: &StartRecording,
        status: EndStatus,
        failure: EncoderFailure,
    ) {
        self.ended.insert(start.recording_id.clone());
        self.replies
            .send(&Reply::Ended(Box::new(recording::ended_before_start(
                &start.recording_id,
                &start.identity,
                status,
                failure.message,
                failure.exit,
            ))));
    }

    fn unknown(&self, recording_id: &str, request: &'static str) {
        let refusal = Refusal {
            message: "no recording has this id".to_owned(),
            request: Some(request),
            recording_id: Some(recording_id.to_owned()),
            request_id: None,
        };
        self.error(ErrorCode::UnknownRecording, &refusal);
    }

    fn error(&self, code: ErrorCode, refusal: &Refusal) {
        self.replies.send(&Reply::Error(ErrorReply {
            code,
            request: refusal.request,
            recording_id: refusal.recording_id.clone(),
            request_id: refusal.request_id.clone(),
            message: refusal.message.clone(),
        }));
    }
}

// Whether two outputs name the same file: the same spelling, or the same file name in the same folder once the
// folders' symbolic links and `..` are resolved.
fn same_output(one: &Path, other: &Path) -> bool {
    let canonical = |path: &Path| -> Option<PathBuf> {
        Some(path.parent()?.canonicalize().ok()?.join(path.file_name()?))
    };
    one == other || canonical(one).is_some_and(|one| canonical(other) == Some(one))
}

fn empty_identity() -> protocol::RecordingIdentity {
    protocol::RecordingIdentity {
        run_id: String::new(),
        attempt_id: String::new(),
        test_id: String::new(),
        app: String::new(),
        session_id: String::new(),
    }
}

fn output_size(what: &str, width: u32, height: u32) -> Option<String> {
    let fits = |side: u32| (1..=MAX_OUTPUT_SIDE).contains(&side);
    (!fits(width) || !fits(height)).then(|| {
        format!(
            "a {what} is 1 to {MAX_OUTPUT_SIDE} pixels each way; it asked for {width} by {height}"
        )
    })
}

fn quality(quality: Option<u8>) -> Option<String> {
    quality
        .filter(|quality| !(1..=100).contains(quality))
        .map(|quality| format!("quality is 1 to 100; it is {quality}"))
}

// The ids of recordings that have ended, the oldest forgotten past `REMEMBERED_ENDINGS`.
#[derive(Default)]
struct RememberedIds {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl RememberedIds {
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

#[derive(Debug, Clone)]
struct CheckedStart {
    output: PathBuf,
    queue_frames: usize,
    queue_bytes: usize,
    max_gap_ms: u64,
    max_duration_ms: u64,
    stall_ms: u64,
    /// The most bytes of kept frames, or `None` when frames are not kept.
    store_bytes: Option<u64>,
}

fn check_start(start: &StartRecording) -> Result<CheckedStart, String> {
    if let Some(problem) =
        protocol::invalid_id("recording id", &start.recording_id, MAX_ID_CHARACTERS)
    {
        return Err(problem);
    }
    let identity = &start.identity;
    for (name, id) in [
        ("run id", &identity.run_id),
        ("attempt id", &identity.attempt_id),
        ("test id", &identity.test_id),
        ("app", &identity.app),
        ("session id", &identity.session_id),
    ] {
        if let Some(problem) = protocol::invalid_id(name, id, MAX_IDENTITY_CHARACTERS) {
            return Err(problem);
        }
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
    let store_bytes = if start.keep_frames == Some(false) {
        None
    } else {
        let bytes = start.frame_store_bytes.unwrap_or(DEFAULT_STORE_BYTES);
        in_range("kept frames' size", bytes, 1..=MAX_STORE_BYTES, "bytes")?;
        Some(bytes)
    };
    Ok(CheckedStart {
        output: check_output(&start.output)?,
        queue_frames,
        queue_bytes,
        max_gap_ms,
        max_duration_ms,
        stall_ms,
        store_bytes,
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
    if !path.is_absolute() || output.ends_with('/') || output.len() > MAX_PATH_BYTES {
        return Err(format!(
            "the output must be an absolute file path without its extension, at most {MAX_PATH_BYTES} bytes; it is {}",
            output.chars().take(200).collect::<String>()
        ));
    }
    match path.parent() {
        Some(folder) if folder.is_dir() => Ok(path.to_path_buf()),
        _ => Err(format!("the output's folder does not exist: {output}")),
    }
}

// The encoder's answer to what it can do, asked once in the background as the process starts. Nothing waits for it
// but a shutdown, which waits for it to end so no encoder of it is left running; the loop polls it.
struct Probe {
    running: Option<JoinHandle<Result<Capabilities, EncoderFailure>>>,
    answer: Option<Result<Capabilities, EncoderFailure>>,
    began: Instant,
    took_ms: u64,
}

impl Probe {
    fn begin(ffmpeg: PathBuf) -> Probe {
        let began = Instant::now();
        match thread::Builder::new()
            .name("probe".to_owned())
            .spawn(move || encoder::probe(&ffmpeg))
        {
            Ok(running) => Probe {
                running: Some(running),
                answer: None,
                began,
                took_ms: 0,
            },
            Err(error) => Probe {
                running: None,
                answer: Some(Err(EncoderFailure {
                    message: format!("the encoder could not be asked what it can do: {error}"),
                    exit: None,
                })),
                began,
                took_ms: 0,
            },
        }
    }

    /// Takes the answer if the probe has ended, and says whether it has.
    fn poll(&mut self) -> bool {
        if self.running.as_ref().is_some_and(JoinHandle::is_finished) {
            self.wait();
        }
        self.finished()
    }

    fn finished(&self) -> bool {
        self.answer.is_some()
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
            self.took_ms = u64::try_from(self.began.elapsed().as_millis()).unwrap_or(u64::MAX);
        }
    }

    fn answer(&self) -> Option<&Result<Capabilities, EncoderFailure>> {
        self.answer.as_ref()
    }

    /// The probe's answer as the protocol says it.
    fn state(&self) -> EncoderProbe {
        let probe_ms = self.took_ms;
        match &self.answer {
            None => EncoderProbe::Probing,
            Some(Err(failure)) => EncoderProbe::Failed {
                message: failure.message.clone(),
                exit: failure.exit.clone(),
                probe_ms,
            },
            Some(Ok(capabilities)) => match Codec::choose(capabilities) {
                Some(codec) => EncoderProbe::Ready {
                    version: capabilities.version.clone(),
                    codec: codec.name().to_owned(),
                    container: codec.container().to_owned(),
                    encoder: codec.encoder().to_owned(),
                    encoded_input: capabilities.encoded_input(),
                    probe_ms,
                },
                None => EncoderProbe::Unavailable {
                    version: capabilities.version.clone(),
                    missing: capabilities.missing(),
                    message: format!(
                        "the encoder cannot record: it lacks {}",
                        capabilities.missing()
                    ),
                    probe_ms,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RecordingIdentity;

    fn identity() -> RecordingIdentity {
        RecordingIdentity {
            run_id: "run".into(),
            attempt_id: "a1".into(),
            test_id: "tests/x.retest.ts > saves".into(),
            app: "web".into(),
            session_id: "a1:web".into(),
        }
    }

    fn start(output: &str) -> StartRecording {
        StartRecording {
            recording_id: "r".to_owned(),
            identity: identity(),
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
            keep_frames: None,
            frame_store_bytes: None,
            encoded_format: None,
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
        assert_eq!(
            checked.store_bytes,
            Some(DEFAULT_STORE_BYTES),
            "frames are kept unless asked not to be"
        );
        let unkept = check_start(&StartRecording {
            keep_frames: Some(false),
            ..start(&output)
        })
        .expect("accepted");
        assert_eq!(unkept.store_bytes, None);
    }

    #[test]
    fn starts_the_encoder_cannot_honour_are_refused() {
        let output = std::env::temp_dir()
            .join("recording")
            .to_string_lossy()
            .into_owned();
        let with_identity = |identity: RecordingIdentity| StartRecording {
            identity,
            ..start(&output)
        };
        let cases: Vec<(&str, StartRecording)> = vec![
            (
                "id past the limit",
                StartRecording {
                    recording_id: "x".repeat(MAX_ID_CHARACTERS + 1),
                    ..start(&output)
                },
            ),
            (
                "id with a control character",
                StartRecording {
                    recording_id: "r\u{7}".to_owned(),
                    ..start(&output)
                },
            ),
            (
                "empty run id",
                with_identity(RecordingIdentity {
                    run_id: String::new(),
                    ..identity()
                }),
            ),
            (
                "test id past the limit",
                with_identity(RecordingIdentity {
                    test_id: "t".repeat(MAX_IDENTITY_CHARACTERS + 1),
                    ..identity()
                }),
            ),
            (
                "session id with a newline",
                with_identity(RecordingIdentity {
                    session_id: "a1\nweb".into(),
                    ..identity()
                }),
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
            (
                "kept frames past their limit",
                StartRecording {
                    frame_store_bytes: Some(MAX_STORE_BYTES + 1),
                    ..start(&output)
                },
            ),
            ("relative output", start("recording")),
            ("missing folder", start("/no/such/folder/recording")),
            (
                "output path too long",
                start(&format!("/{}", "x".repeat(MAX_PATH_BYTES))),
            ),
        ];
        for (name, case) in cases {
            assert!(check_start(&case).is_err(), "{name} was accepted");
        }
    }

    #[test]
    fn the_ended_set_forgets_its_oldest_ids() {
        let mut ended = RememberedIds::default();
        for index in 0..=REMEMBERED_ENDINGS {
            ended.insert(index.to_string());
        }
        assert!(!ended.contains("0"));
        assert!(ended.contains("1"));
        assert!(ended.contains(&REMEMBERED_ENDINGS.to_string()));
        assert_eq!(ended.order.len(), REMEMBERED_ENDINGS);
    }

    #[test]
    fn the_build_names_its_target_and_profile() {
        let build = build_identity();
        assert!(build.target.contains('-'), "{build:?}");
        assert_eq!(
            build.profile,
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        );
    }
}
