//! One recording: its queue, its owned encoder processes, the thread that feeds one to the other, and a
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
use crate::process_ownership::Ownership;
use crate::protocol::{
    EncoderExit, EndStatus, Ended, FrameCounts, FrameHeader, Gap, MAX_LISTED_GAPS, Reply, Started,
};
use crate::queue::{FrameQueue, Pop, Push, QueuedFrame};
use crate::replies::Replies;
use crate::timeline::{Placement, Timeline};

/// How often an idle encoder thread checks that its encoder is still running.
const IDLE_CHECK: Duration = Duration::from_millis(100);
/// How long an encoder that broke its pipe, or was told to stop, gets to confirm its exit.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// How often the watchdog looks at the deadline and the stall clock.
const WATCH_INTERVAL: Duration = Duration::from_millis(20);
/// How long the encoder's stderr reader may go on after cleanup.
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
    ownership: Mutex<Ownership>,
    cleanup_problems: Mutex<Vec<String>>,
    last_capture: Mutex<Instant>,
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
        let encoder_pid = child.id();
        let mut ownership = Ownership::new(encoder_pid);
        let mut problems = ownership.capture();
        if !problems.is_empty() {
            drop(child.stdin.take());
            let _ = encoder::wait_until(&mut child, &mut ownership, Instant::now() + EXIT_GRACE, &mut problems);
            problems.extend(ownership.cleanup(EXIT_GRACE));
            return Err(EncoderFailure {
                message: format!("encoder launch ownership was unknown; cleanup failed: {}", problems.join("; ")),
                exit: None,
            });
        }
        let (Some(stdin), Some(stderr)) = (child.stdin.take(), child.stderr.take()) else {
            problems.extend(ownership.stop());
            let _ = encoder::wait_until(&mut child, &mut ownership, Instant::now() + EXIT_GRACE, &mut problems);
            problems.extend(ownership.cleanup(EXIT_GRACE));
            return Err(EncoderFailure {
                message: format!("the encoder's pipes could not be opened{}", cleanup_suffix(&problems)),
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
            encoder_pid,
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
            ownership: Mutex::new(ownership),
            cleanup_problems: Mutex::new(Vec::new()),
            last_capture: Mutex::new(Instant::now()),
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
                message: shared.cleanup_message(format!("the recording's watchdog could not start: {error}")),
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
                    message: shared.cleanup_message(format!("the encoder thread could not start: {error}")),
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
    /// recording's deadline, after which the watchdog stops verified encoder processes.
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
    /// `ended` reply stops recorded encoder processes and reports any unknown cleanup.
    pub fn join(mut self, replies: &Replies) -> EndStatus {
        let status = self.thread.take().and_then(|thread| thread.join().ok());
        if let Some(status) = status {
            return status;
        }
        self.shared.abandon();
        if !self.is_over() {
            self.shared.over.store(true, Ordering::Release);
            let message = self.shared.cleanup_message(
                "the recording failed inside the media process; its frame counts are lost".to_owned()
            );
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
    // Watches for a missed deadline or a stalled write. Only recorded processes with a freshly verified
    // identity are stopped; an unreadable status is unknown and is retained as a cleanup failure.
    fn watch(&self) {
        let mut ending = lock(&self.ending);
        while !ending.done {
            if let Some(reason) = self.overdue(&ending) {
                if ending.reason.is_none() && self.encoder_running() {
                    ending.reason = Some(reason);
                }
                self.stop_encoder();
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
            self.stop_encoder();
        }
        drop(ending);
        self.queue.close();
    }

    // Ends a recording whose threads could not start or failed. An uncertain cleanup keeps its partial file.
    fn abandon(&self) {
        self.mark_done();
        self.stop_encoder();
        let _ = self.wait_for_encoder(Some(EXIT_GRACE));
        self.finish_cleanup();
        self.queue.close();
        if lock(&self.cleanup_problems).is_empty() {
            let _ = fs::remove_file(self.plan.partial_path());
        }
    }

    fn note_cleanup(&self, problems: Vec<String>) {
        let mut kept = lock(&self.cleanup_problems);
        for problem in problems {
            if !kept.contains(&problem) {
                kept.push(problem);
            }
        }
    }

    fn capture_encoder(&self) {
        let mut captured = lock(&self.last_capture);
        if captured.elapsed() < IDLE_CHECK {
            return;
        }
        *captured = Instant::now();
        drop(captured);
        let problems = lock(&self.ownership).capture();
        self.note_cleanup(problems);
    }

    fn stop_encoder(&self) {
        let problems = lock(&self.ownership).stop();
        self.note_cleanup(problems);
    }

    fn finish_cleanup(&self) {
        let problems = lock(&self.ownership).cleanup(EXIT_GRACE);
        self.note_cleanup(problems);
    }

    fn cleanup_message(&self, message: String) -> String {
        format!("{message}{}", cleanup_suffix(&lock(&self.cleanup_problems)))
    }

    fn encoder_running(&self) -> bool {
        match lock(&self.child).try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => false,
            Err(_) => {
                self.note_cleanup(vec!["the encoder exit could not be read; completion is unknown".to_owned()]);
                true
            }
        }
    }

    fn encoder_status(&self) -> Option<ExitStatus> {
        self.capture_encoder();
        match lock(&self.child).try_wait() {
            Ok(status) => status,
            Err(_) => {
                self.note_cleanup(vec!["the encoder exit could not be read; completion is unknown".to_owned()]);
                None
            }
        }
    }

    // A failed status reading ends the wait. After a stop, the exit grace is bounded and no numeric group
    // or unbounded Child::wait can turn an unanswered cleanup into success.
    fn wait_for_encoder(&self, limit: Option<Duration>) -> Option<ExitStatus> {
        let start = Instant::now();
        let limit = limit.unwrap_or(self.plan.deadline.saturating_add(EXIT_GRACE));
        let mut stopped_at = None;
        loop {
            if let Some(status) = self.encoder_status() {
                return Some(status);
            }
            if lock(&self.cleanup_problems).iter().any(|problem| problem.starts_with("the encoder exit could not be read")) {
                return None;
            }
            if let Some(stopped_at) = stopped_at {
                if Instant::now().duration_since(stopped_at) >= EXIT_GRACE {
                    self.note_cleanup(vec!["the encoder did not confirm an exit after cleanup".to_owned()]);
                    return None;
                }
            } else if start.elapsed() >= limit {
                self.stop_encoder();
                stopped_at = Some(Instant::now());
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

fn cleanup_suffix(problems: &[String]) -> String {
    if problems.is_empty() {
        String::new()
    } else {
        format!("; cleanup failed or completion is unknown: {}", problems.join("; "))
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
    stderr_thread: JoinHandle<Result<(), String>>,
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
            shared.stop_encoder();
            shared.wait_for_encoder(Some(EXIT_GRACE))
        }
        Flow::WriteFailed | Flow::EncoderExited | Flow::Interrupted => {
            shared.wait_for_encoder(Some(EXIT_GRACE))
        }
    };
    // Recorded descendants retain their launch identities after their parent exits. A group number alone
    // never authorizes cleanup, and a reader that remains open makes completion unknown.
    shared.finish_cleanup();
    let ending = shared.mark_done();
    match encoder::join_within(stderr_thread, STDERR_GRACE) {
        Some(Ok(())) => {}
        Some(Err(error)) => shared.note_cleanup(vec![error]),
        None => shared.note_cleanup(vec!["the encoder stderr did not close; cleanup completion is unknown".to_owned()]),
    }
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
    let problems = lock(&shared.cleanup_problems).clone();
    let (mut end_status, mut message) = match (ending.reason, flow) {
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
        (None, Flow::Closed) if status.is_some_and(|status| status.success()) && problems.is_empty() => {
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
    if !problems.is_empty() {
        if end_status == EndStatus::Ok || end_status == EndStatus::NoFrames {
            end_status = EndStatus::EncoderFailed;
        }
        message.push_str(&cleanup_suffix(&problems));
        if plan.partial_path().exists() {
            kept_partial = Some(plan.partial_path().to_string_lossy().into_owned());
        }
    }
    if end_status != EndStatus::Ok && kept_partial.is_none() && problems.is_empty() {
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
