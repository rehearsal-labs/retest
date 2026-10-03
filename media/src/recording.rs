//! One recording: its queue, its encoder's process group, the thread that feeds one to the other, and a
//! watchdog.
//!
//! The encoder writes to a `.partial` file. Only an encoder that exits successfully makes it the video, through
//! a hard link that fails rather than replace anything at the path, so a file at the recording's path is always
//! its own finished container. Every recording ends with exactly one `ended` reply: when the client finishes it,
//! when its encoder dies or stalls, when finishing outlasts its deadline, or when the process shuts down before
//! the recording was finished.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::encoder::{self, Capabilities, Codec, EncoderFailure, StderrTail};
use crate::frame;
use crate::protocol::{
    EncoderExit, EndStatus, Ended, FrameCounts, FrameHeader, Gap, MAX_LISTED_GAPS, Reply, Started,
};
use crate::queue::{FrameQueue, Pop, Push, QueuedFrame};
use crate::replies::Replies;
use crate::timeline::{Placement, Timeline};

/// How often an idle encoder thread checks that its encoder is still running.
const IDLE_CHECK: Duration = Duration::from_millis(100);
/// How long an encoder that broke its pipe, or was told to stop, gets to exit before its group is killed.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// How often the watchdog looks at the deadline and the stall clock.
const WATCH_INTERVAL: Duration = Duration::from_millis(20);
/// How long the encoder's stderr reader may go on once the encoder's group is gone.
const STDERR_GRACE: Duration = Duration::from_secs(1);

/// Everything a recording needs, checked by the server.
#[derive(Debug, Clone)]
pub struct RecordingPlan {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    /// Where the finished video goes.
    pub path: PathBuf,
    pub deadline: Duration,
    pub queue_frames: usize,
    pub queue_bytes: usize,
    pub max_gap_us: u64,
    pub max_duration_us: u64,
    pub stall: Duration,
}

impl RecordingPlan {
    /// Where the encoder writes until the video is finished.
    pub fn partial_path(&self) -> PathBuf {
        partial_path_of(&self.path)
    }
}

/// The `.partial` file beside a video path.
pub fn partial_path_of(path: &Path) -> PathBuf {
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    PathBuf::from(partial)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Deadline,
    Shutdown,
    Stalled,
}

#[derive(Debug, Default)]
struct Ending {
    done: bool,
    reason: Option<StopReason>,
    finished_at: Option<Instant>,
}

// Counts the input reader keeps as frames arrive.
#[derive(Debug, Default)]
struct Receipt {
    received: u64,
    out_of_order: u64,
    out_of_range: u64,
    bytes_received: u64,
    first_timestamp_us: Option<u64>,
    last_timestamp_us: Option<u64>,
}

// Counts and facts the encoder thread keeps.
#[derive(Debug, Default)]
struct Progress {
    shown: u64,
    superseded: u64,
    undecodable: u64,
    resized: u64,
    unprocessed: u64,
    output_frames: u64,
    bytes_to_encoder: u64,
    first_timestamp_us: Option<u64>,
    frames_before_first: u64,
    gaps: Vec<Gap>,
    gaps_shortened: u64,
    end_clipped: bool,
}

impl Progress {
    fn note_gap(&mut self, capture_us: u64, shortened_by_us: u64) {
        self.gaps_shortened += 1;
        if self.gaps.len() < MAX_LISTED_GAPS {
            self.gaps.push(Gap {
                capture_us,
                shortened_by_us,
            });
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    /// Every frame went to the encoder and its input was closed.
    Closed,
    NoFrames,
    WriteFailed,
    EncoderExited,
    Interrupted,
}

struct Shared {
    plan: RecordingPlan,
    queue: FrameQueue,
    child: Mutex<Child>,
    /// The encoder's process group, whose id is the encoder's pid.
    group: u32,
    ending: Mutex<Ending>,
    ending_changed: Condvar,
    receipt: Mutex<Receipt>,
    /// When the encoder thread began a write it has not finished: the watchdog's stall clock.
    writing_since: Mutex<Option<Instant>>,
    over: AtomicBool,
    tail: StderrTail,
}

/// A running recording, owned by the server.
pub struct Recording {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<EndStatus>>,
    finishing: bool,
}

impl Recording {
    /// Starts the recording's encoder, its watchdog and the thread that feeds it, and sends `started`. It goes
    /// out before the feeding thread runs, so a client always reads `started` before the same recording's
    /// `ended`.
    pub fn start(
        plan: RecordingPlan,
        ffmpeg: &Path,
        capabilities: &Capabilities,
        replies: Replies,
    ) -> Result<Recording, EncoderFailure> {
        let arguments = encoder::encode_arguments(
            plan.codec,
            plan.width,
            plan.height,
            plan.fps,
            &plan.partial_path(),
        );
        let mut child = encoder::spawn_in_group(ffmpeg, &arguments, Stdio::piped(), Stdio::null())
            .map_err(|error| EncoderFailure {
                message: format!("{} could not be started: {error}", ffmpeg.display()),
                exit: None,
            })?;
        let group = child.id();
        let (Some(stdin), Some(stderr)) = (child.stdin.take(), child.stderr.take()) else {
            encoder::kill_group(group);
            let _ = child.wait();
            return Err(EncoderFailure {
                message: "the encoder's pipes could not be opened".to_owned(),
                exit: None,
            });
        };
        let tail = StderrTail::default();
        let stderr_thread = tail.follow(stderr);
        let started = Started {
            recording_id: plan.id.clone(),
            codec: plan.codec.name().to_owned(),
            container: plan.codec.container().to_owned(),
            encoder: plan.codec.encoder().to_owned(),
            encoder_version: capabilities.version.clone(),
            encoder_pid: group,
            path: plan.path.to_string_lossy().into_owned(),
            width: plan.width,
            height: plan.height,
            fps: plan.fps,
            queue_frames: plan.queue_frames,
            queue_bytes: plan.queue_bytes,
            max_gap_ms: plan.max_gap_us / 1000,
            max_duration_ms: plan.max_duration_us / 1000,
            stall_ms: millis(plan.stall),
        };
        let shared = Arc::new(Shared {
            queue: FrameQueue::new(plan.queue_frames, plan.queue_bytes),
            plan,
            child: Mutex::new(child),
            group,
            ending: Mutex::new(Ending::default()),
            ending_changed: Condvar::new(),
            receipt: Mutex::new(Receipt::default()),
            writing_since: Mutex::new(None),
            over: AtomicBool::new(false),
            tail,
        });
        let watcher = Arc::clone(&shared);
        let watchdog = thread::Builder::new()
            .name(format!("watchdog {}", shared.plan.id))
            .spawn(move || watcher.watch());
        if let Err(error) = watchdog {
            shared.abandon();
            return Err(EncoderFailure {
                message: format!("the recording's watchdog could not start: {error}"),
                exit: None,
            });
        }
        replies.send(&Reply::Started(started));
        let worker = Arc::clone(&shared);
        let thread = thread::Builder::new()
            .name(format!("encoder {}", shared.plan.id))
            .spawn(move || feed_encoder(&worker, stdin, stderr_thread, &replies));
        match thread {
            Ok(thread) => Ok(Recording {
                shared,
                thread: Some(thread),
                finishing: false,
            }),
            Err(error) => {
                shared.abandon();
                Err(EncoderFailure {
                    message: format!("the encoder thread could not start: {error}"),
                    exit: None,
                })
            }
        }
    }

    /// Where the finished video will be.
    pub fn path(&self) -> &Path {
        &self.shared.plan.path
    }

    /// Whether the recording takes no more frames: it is finishing or has ended.
    pub fn closed_to_frames(&self) -> bool {
        self.finishing || self.is_over()
    }

    /// Whether the `ended` reply has gone out.
    pub fn is_over(&self) -> bool {
        self.shared.over.load(Ordering::Acquire)
    }

    /// Whether the recording's thread has returned, having sent `ended`, or failed without sending it.
    pub fn thread_done(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// Takes a frame from the input. The counts and the push happen under one lock, so a frame that arrives as
    /// the recording ends is either counted and accounted for, or not counted at all.
    pub fn receive(&self, header: &FrameHeader, bytes: Vec<u8>) {
        let plan = &self.shared.plan;
        let mut receipt = lock(&self.shared.receipt);
        let timestamp = header.timestamp_us;
        let length = bytes.len() as u64;
        let out_of_order = receipt
            .last_timestamp_us
            .is_some_and(|last| timestamp < last);
        let out_of_range = !out_of_order
            && receipt
                .first_timestamp_us
                .is_some_and(|first| timestamp - first > plan.max_duration_us);
        if out_of_order || out_of_range {
            receipt.received += 1;
            receipt.bytes_received += length;
            receipt.out_of_order += u64::from(out_of_order);
            receipt.out_of_range += u64::from(out_of_range);
            return;
        }
        let frame = QueuedFrame {
            timestamp_us: timestamp,
            format: header.format,
            bytes,
        };
        if self.shared.queue.push(frame) == Push::Refused {
            return;
        }
        receipt.received += 1;
        receipt.bytes_received += length;
        receipt.first_timestamp_us.get_or_insert(timestamp);
        receipt.last_timestamp_us = Some(timestamp);
    }

    /// Finishes the recording: the encoder takes every queued frame and writes the container, all within the
    /// recording's deadline, after which the watchdog stops the encoder's group.
    pub fn finish(&mut self, end_timestamp_us: Option<u64>) {
        if self.finishing {
            return;
        }
        self.finishing = true;
        lock(&self.shared.ending).finished_at = Some(Instant::now());
        self.shared.queue.finish(end_timestamp_us);
    }

    /// Stops the recording for a shutdown. A recording that is finishing is left to finish within its deadline,
    /// so a video already on its way is not thrown away; any other ends `stopped`. Its thread then sends `ended`.
    pub fn stop(&self) {
        if !self.finishing {
            self.shared.stop(StopReason::Shutdown);
        }
    }

    /// Waits for the recording's thread and returns how the recording ended. A thread that failed before its
    /// `ended` reply leaves the encoder's group killed and an `ended` reply that says so.
    pub fn join(mut self, replies: &Replies) -> EndStatus {
        let status = self.thread.take().and_then(|thread| thread.join().ok());
        if let Some(status) = status {
            return status;
        }
        self.shared.abandon();
        if !self.is_over() {
            self.shared.over.store(true, Ordering::Release);
            let message =
                "the recording failed inside the media process; its frame counts are lost"
                    .to_owned();
            replies.send(&Reply::Ended(ended_before_start(
                &self.shared.plan.id,
                EndStatus::EncoderFailed,
                message,
                None,
            )));
        }
        EndStatus::EncoderFailed
    }
}

impl Shared {
    // Watches for a missed finishing deadline and a stalled write until the recording is done. Acting kills the
    // encoder's whole group, which also breaks any write blocked on it; a reason is recorded only while the
    // encoder still runs, since one that already exited ends by its own status.
    fn watch(&self) {
        let mut ending = lock(&self.ending);
        while !ending.done {
            if let Some(reason) = self.overdue(&ending) {
                if ending.reason.is_none() && self.encoder_running() {
                    ending.reason = Some(reason);
                }
                encoder::kill_group(self.group);
                return;
            }
            ending = match self.ending_changed.wait_timeout(ending, WATCH_INTERVAL) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    fn overdue(&self, ending: &Ending) -> Option<StopReason> {
        if ending
            .finished_at
            .is_some_and(|at| at.elapsed() >= self.plan.deadline)
        {
            return Some(StopReason::Deadline);
        }
        let writing = *lock(&self.writing_since);
        writing
            .is_some_and(|since| since.elapsed() >= self.plan.stall)
            .then_some(StopReason::Stalled)
    }

    fn stop(&self, reason: StopReason) {
        let mut ending = lock(&self.ending);
        if !ending.done {
            if ending.reason.is_none() && self.encoder_running() {
                ending.reason = Some(reason);
            }
            encoder::kill_group(self.group);
        }
        drop(ending);
        self.queue.close();
    }

    // Ends a recording whose threads could not start or failed: its watchdog stops, its encoder's group is
    // killed, and its unfinished file goes.
    fn abandon(&self) {
        self.mark_done();
        encoder::kill_group(self.group);
        let _ = lock(&self.child).wait();
        self.queue.close();
        let _ = fs::remove_file(self.plan.partial_path());
    }

    fn encoder_running(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }

    fn encoder_status(&self) -> Option<ExitStatus> {
        lock(&self.child).try_wait().ok().flatten()
    }

    // Waits for the encoder to exit. With a `limit`, kills its group once the limit passes; without one, the
    // watchdog or a shutdown is what stops it.
    fn wait_for_encoder(&self, limit: Option<Duration>) -> Option<ExitStatus> {
        let start = Instant::now();
        loop {
            if let Some(status) = self.encoder_status() {
                return Some(status);
            }
            if limit.is_some_and(|limit| start.elapsed() >= limit) {
                encoder::kill_group(self.group);
                return lock(&self.child).wait().ok();
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn mark_done(&self) -> Ending {
        let mut ending = lock(&self.ending);
        ending.done = true;
        let snapshot = Ending {
            done: true,
            reason: ending.reason,
            finished_at: ending.finished_at,
        };
        drop(ending);
        self.ending_changed.notify_all();
        snapshot
    }

    fn stop_requested(&self) -> bool {
        lock(&self.ending).reason.is_some()
    }
}

// A test sets this to prove a recording whose thread fails still ends promptly. Release builds have no hook.
#[cfg(debug_assertions)]
fn fail_if_a_test_asks() {
    if std::env::var_os("RETEST_MEDIA_TEST_PANIC").is_some() {
        panic!("RETEST_MEDIA_TEST_PANIC asked the encoder thread to fail");
    }
}

#[cfg(not(debug_assertions))]
fn fail_if_a_test_asks() {}

// The encoder thread: takes frames in order, decodes them, places them on the timeline and writes them.
fn feed_encoder(
    shared: &Shared,
    stdin: ChildStdin,
    stderr_thread: JoinHandle<()>,
    replies: &Replies,
) -> EndStatus {
    let plan = &shared.plan;
    let mut stdin = Some(stdin);
    let mut progress = Progress::default();
    let mut timeline = Timeline::new(plan.fps, plan.max_gap_us);
    let max_output_frames = timeline.ticks_within(plan.max_duration_us);
    // The frame on screen, written once the next frame or the end says how long it stays.
    let mut held: Option<Vec<u8>> = None;
    let flow = loop {
        if shared.stop_requested() {
            break Flow::Interrupted;
        }
        match shared.queue.pop(IDLE_CHECK) {
            Pop::Frame(queued) => {
                fail_if_a_test_asks();
                let Ok(pixels) =
                    frame::decode(&queued.bytes, queued.format, plan.width, plan.height)
                else {
                    progress.undecodable += 1;
                    continue;
                };
                progress.resized += u64::from(pixels.resized);
                let (placement, shortened) = timeline.place(queued.timestamp_us);
                if shortened > 0 {
                    progress.note_gap(queued.timestamp_us, shortened);
                }
                match (placement, held.as_deref()) {
                    (Placement::First, _) => {
                        progress.first_timestamp_us = Some(queued.timestamp_us);
                        progress.frames_before_first =
                            shared.queue.dropped() + progress.undecodable;
                    }
                    (Placement::Advances { repeat }, Some(previous)) => {
                        let write = FrameWrite {
                            shared,
                            pixels: previous,
                            repeat,
                            max_output_frames,
                        };
                        if write.to(stdin.as_mut(), &mut progress).is_err() {
                            progress.unprocessed += 1;
                            break Flow::WriteFailed;
                        }
                        progress.shown += 1;
                    }
                    (Placement::Supersedes, Some(_)) => progress.superseded += 1,
                    _ => {}
                }
                held = Some(pixels.rgb);
            }
            Pop::Finished { end_timestamp_us } => {
                let Some(last) = held.as_deref() else {
                    break Flow::NoFrames;
                };
                let limit = timeline
                    .origin_us()
                    .unwrap_or(0)
                    .saturating_add(plan.max_duration_us);
                let (repeat, clipped) = timeline.finish(end_timestamp_us, limit);
                progress.end_clipped = clipped;
                let write = FrameWrite {
                    shared,
                    pixels: last,
                    repeat,
                    max_output_frames,
                };
                if write.to(stdin.as_mut(), &mut progress).is_err() {
                    break Flow::WriteFailed;
                }
                progress.shown += 1;
                held = None;
                break Flow::Closed;
            }
            Pop::Closed => break Flow::Interrupted,
            Pop::Idle if shared.encoder_status().is_some() => break Flow::EncoderExited,
            Pop::Idle => {}
        }
    };
    progress.unprocessed += u64::from(held.is_some());
    // Closing the encoder's input is what tells it to write the container.
    drop(stdin.take());
    let status = match flow {
        Flow::Closed => shared.wait_for_encoder(None),
        Flow::NoFrames => {
            encoder::kill_group(shared.group);
            shared.wait_for_encoder(Some(EXIT_GRACE))
        }
        Flow::WriteFailed | Flow::EncoderExited | Flow::Interrupted => {
            shared.wait_for_encoder(Some(EXIT_GRACE))
        }
    };
    // Anything the encoder left running goes with it. The group's id stays reserved while any member lives, so
    // this reaches only the encoder's own processes, and once they are gone its stderr closes. The recording is
    // marked done before the stderr wait, so neither the watchdog nor a shutdown signals the group again once
    // it may be empty and its id free for another process.
    encoder::kill_group(shared.group);
    let ending = shared.mark_done();
    let _ = encoder::join_within(stderr_thread, STDERR_GRACE);
    shared.queue.close();
    let ended = conclude(shared, flow, status, &ending, progress);
    let end_status = ended.status;
    shared.over.store(true, Ordering::Release);
    replies.send(&Reply::Ended(ended));
    end_status
}

// One frame's pixels, written `repeat` times, never past the recording's most output frames.
struct FrameWrite<'a> {
    shared: &'a Shared,
    pixels: &'a [u8],
    repeat: u64,
    max_output_frames: u64,
}

impl FrameWrite<'_> {
    fn to(&self, stdin: Option<&mut ChildStdin>, progress: &mut Progress) -> io::Result<()> {
        let stdin = stdin.ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        let room = self
            .max_output_frames
            .saturating_sub(progress.output_frames);
        for _ in 0..self.repeat.min(room) {
            *lock(&self.shared.writing_since) = Some(Instant::now());
            let written = stdin.write_all(self.pixels);
            *lock(&self.shared.writing_since) = None;
            written?;
            progress.output_frames += 1;
            progress.bytes_to_encoder += self.pixels.len() as u64;
        }
        Ok(())
    }
}

fn conclude(
    shared: &Shared,
    flow: Flow,
    status: Option<ExitStatus>,
    ending: &Ending,
    progress: Progress,
) -> Ended {
    let plan = &shared.plan;
    let encoder_exit = EncoderExit {
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(encoder::signal_of),
        stderr: shared.tail.lines(),
    };
    let described = status.map_or_else(|| "an unknown status".to_owned(), encoder::describe_status);
    let mut kept_partial = None;
    let (end_status, message) = match (ending.reason, flow) {
        (Some(StopReason::Deadline), _) => {
            let message = format!(
                "finishing took longer than {} ms; the encoder was stopped",
                plan.deadline.as_millis()
            );
            (EndStatus::DeadlineExceeded, message)
        }
        (Some(StopReason::Stalled), _) => {
            let message = format!(
                "the encoder took more than {} ms to accept a frame and was stopped",
                plan.stall.as_millis()
            );
            (EndStatus::EncoderFailed, message)
        }
        (Some(StopReason::Shutdown), _) => (
            EndStatus::Stopped,
            "the media process shut down before the recording was finished".to_owned(),
        ),
        (None, Flow::NoFrames) => (
            EndStatus::NoFrames,
            "no frame could be shown, so there is no video".to_owned(),
        ),
        (None, Flow::Closed) if status.is_some_and(|status| status.success()) => {
            let placed = place_video(plan);
            kept_partial = placed.kept_partial;
            (placed.status, placed.message)
        }
        (None, Flow::Closed) => (
            EndStatus::EncoderFailed,
            format!("the encoder ended with {described} while writing the video"),
        ),
        (None, Flow::WriteFailed | Flow::EncoderExited) => (
            EndStatus::EncoderFailed,
            format!("the encoder ended with {described} during the recording"),
        ),
        (None, Flow::Interrupted) => (
            EndStatus::EncoderFailed,
            format!("the encoder ended with {described} before the recording finished"),
        ),
    };
    if end_status != EndStatus::Ok && kept_partial.is_none() {
        let _ = fs::remove_file(plan.partial_path());
    }
    let receipt = lock(&shared.receipt);
    let frames = FrameCounts {
        received: receipt.received,
        shown: progress.shown,
        superseded: progress.superseded,
        dropped: shared.queue.dropped(),
        out_of_order: receipt.out_of_order,
        out_of_range: receipt.out_of_range,
        undecodable: progress.undecodable,
        unprocessed: progress.unprocessed + shared.queue.unprocessed(),
        resized: progress.resized,
    };
    let encoder_ran = !matches!(
        end_status,
        EndStatus::Ok | EndStatus::NoFrames | EndStatus::OutputFailed
    );
    let timeline = Timeline::new(plan.fps, plan.max_gap_us);
    Ended {
        recording_id: plan.id.clone(),
        status: end_status,
        message,
        path: (end_status == EndStatus::Ok).then(|| plan.path.to_string_lossy().into_owned()),
        partial_path: kept_partial,
        frames,
        first_timestamp_us: progress.first_timestamp_us,
        frames_before_first: progress.frames_before_first,
        gaps: progress.gaps,
        gaps_shortened: progress.gaps_shortened,
        end_clipped: progress.end_clipped,
        output_frames: progress.output_frames,
        duration_us: timeline.duration_us(progress.output_frames),
        bytes_received: receipt.bytes_received,
        bytes_to_encoder: progress.bytes_to_encoder,
        encoder: encoder_ran.then_some(encoder_exit),
        finalize_ms: ending.finished_at.map(|at| millis(at.elapsed())),
    }
}

struct Placed {
    status: EndStatus,
    message: String,
    kept_partial: Option<String>,
}

// Puts the finished file at the recording's path. A hard link never replaces a file, so one that appeared at the
// path since the start is left alone and the video stays at its `.partial`, named in the reply.
fn place_video(plan: &RecordingPlan) -> Placed {
    let partial = plan.partial_path();
    let failed = |message: String, kept_partial: Option<String>| Placed {
        status: EndStatus::OutputFailed,
        message,
        kept_partial,
    };
    match fs::metadata(&partial) {
        Ok(metadata) if metadata.len() > 0 => {}
        Ok(_) => {
            return failed(
                "the encoder exited successfully but wrote an empty file".to_owned(),
                None,
            );
        }
        Err(error) => {
            return failed(
                format!("the encoder exited successfully but its file is missing: {error}"),
                None,
            );
        }
    }
    match fs::hard_link(&partial, &plan.path) {
        Ok(()) => {
            let _ = fs::remove_file(&partial);
            Placed {
                status: EndStatus::Ok,
                message: "the video is written".to_owned(),
                kept_partial: None,
            }
        }
        Err(error) => {
            let kept = partial.to_string_lossy().into_owned();
            let message = format!(
                "the video could not be put at {}: {error}; it is kept at {kept}",
                plan.path.display()
            );
            failed(message, Some(kept))
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An `ended` reply for a recording whose encoder never started, or whose counts were lost.
pub fn ended_before_start(
    recording_id: &str,
    status: EndStatus,
    message: String,
    exit: Option<EncoderExit>,
) -> Ended {
    Ended {
        recording_id: recording_id.to_owned(),
        status,
        message,
        path: None,
        partial_path: None,
        frames: FrameCounts::default(),
        first_timestamp_us: None,
        frames_before_first: 0,
        gaps: Vec::new(),
        gaps_shortened: 0,
        end_clipped: false,
        output_frames: 0,
        duration_us: 0,
        bytes_received: 0,
        bytes_to_encoder: 0,
        encoder: exit,
        finalize_ms: None,
    }
}
