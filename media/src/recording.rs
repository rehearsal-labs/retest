//! One recording: its queue, its owned encoder processes, the thread that feeds one to the other, and a
//! watchdog.
//!
//! The encoder writes to a `.partial` file. Only an encoder that exits successfully makes it the video, through
//! a hard link that fails rather than replace anything at the path, or, on a filesystem without hard links, a copy
//! into a file created only if nothing is there, so a file at the recording's path is always its own finished
//! container. Every recording ends with exactly one `ended` reply: when the client finishes it, when its encoder dies
//! or stalls, when finishing outlasts its deadline, or when the process shuts down before the recording was
//! finished. The reply's payload is the frame map, and its `evidence` names what the video lacks.
//!
//! What a recording keeps beyond its thread, its ledger, its kept frames and its live slot, is `RecordingData`,
//! which the server holds until the recording is released, so frame sequences can be asked of it after it ends.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::encoder::{self, Capabilities, Codec, EncoderFailure, Input, StderrTail};
use crate::frame;
use crate::ledger::{Fate, Ledger, Stored};
use crate::place::{self, Placed, partial_path_of};
use crate::process_ownership::Ownership;
use crate::protocol::{
    EncoderExit, EndStatus, Ended, Evidence, FrameCounts, FrameFormat, FrameHeader, Gap,
    MAX_LISTED_GAPS, MAX_PAYLOAD_BYTES, RecordingIdentity, Reply, Started,
};
use crate::queue::{FrameQueue, Pop, Push, QueuedFrame};
use crate::replies::Replies;
use crate::store::FrameStore;
use crate::timeline::{Placement, Timeline};

/// How often an idle encoder thread checks that its encoder is still running.
const IDLE_CHECK: Duration = Duration::from_millis(100);
/// How long an encoder that broke its pipe, or was told to stop, gets to confirm its exit.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// How often the watchdog looks at the deadline and the stall clock.
const WATCH_INTERVAL: Duration = Duration::from_millis(20);
/// How often the watchdog tries again to stop an encoder a stop did not reach, while the encoder thread waits on it.
const STOP_RETRY: Duration = Duration::from_secs(1);
/// What a stopped recording's thread may take beyond its deadline and stall limit: the bounded waits for the
/// encoder's exit, its cleanup and its stderr, with room for slow process readings.
const STOPPED_THREAD_GRACE: Duration = Duration::from_secs(10);
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
    pub input: Input,
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

/// The newest frame of a watched recording, as it arrived.
#[derive(Debug, Clone)]
pub struct LatestFrame {
    pub frame_id: Arc<str>,
    pub capture_us: u64,
    pub format: FrameFormat,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct LiveState {
    pub latest: Option<LatestFrame>,
    /// Frames offered since the recording began, so a view can count those it never showed.
    pub arrived: u64,
    /// The recording takes no more frames.
    pub closed: bool,
}

/// Where the input reader leaves a watched recording's newest frame for its live view. Nothing is copied here
/// unless a view is watching, and a view that falls behind only finds a newer frame.
#[derive(Debug, Default)]
pub struct LiveSlot {
    pub watched: AtomicBool,
    pub state: Mutex<LiveState>,
    pub changed: Condvar,
}

impl LiveSlot {
    fn offer(&self, header: &FrameHeader, bytes: &[u8]) {
        if !self.watched.load(Ordering::Acquire) {
            return;
        }
        let mut state = lock(&self.state);
        state.latest = Some(LatestFrame {
            frame_id: Arc::from(header.frame_id.as_str()),
            capture_us: header.timestamp_us,
            format: header.format,
            bytes: bytes.to_vec(),
        });
        state.arrived += 1;
        drop(state);
        self.changed.notify_all();
    }

    pub fn close(&self) {
        lock(&self.state).closed = true;
        self.changed.notify_all();
    }
}

/// What a recording keeps that outlives its thread.
#[derive(Debug)]
pub struct RecordingData {
    pub id: String,
    pub identity: RecordingIdentity,
    /// The output path the start named, without its extension.
    pub output: PathBuf,
    pub fps: u32,
    pub ledger: Mutex<Ledger>,
    pub store: Option<FrameStore>,
    pub live: LiveSlot,
    /// Set once the recording's `ended` reply has gone out.
    pub ended: AtomicBool,
    /// Release belongs to this retained data, even after the bounded remembered-id list forgets its id.
    pub released: AtomicBool,
    /// The capture time of the newest kept frame, so a reader knows how far the kept frames reach.
    pub stored_through_us: AtomicU64,
    pub has_stored: AtomicBool,
}

impl RecordingData {
    pub fn new(
        id: String,
        identity: RecordingIdentity,
        output: PathBuf,
        fps: u32,
        store: Option<FrameStore>,
    ) -> Self {
        RecordingData {
            id,
            identity,
            output,
            fps,
            ledger: Mutex::new(Ledger::default()),
            store,
            live: LiveSlot::default(),
            ended: AtomicBool::new(false),
            released: AtomicBool::new(false),
            stored_through_us: AtomicU64::new(0),
            has_stored: AtomicBool::new(false),
        }
    }

    pub fn ledger(&self) -> MutexGuard<'_, Ledger> {
        lock(&self.ledger)
    }

    /// The capture time of the newest kept frame, if any frame was kept.
    pub fn stored_through(&self) -> Option<u64> {
        self.has_stored
            .load(Ordering::Acquire)
            .then(|| self.stored_through_us.load(Ordering::Acquire))
    }
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
    /// When the encoder thread saw the encoder exit. Cleanup runs after it and is not the encoder's time.
    exited_at: Option<Instant>,
}

impl Ending {
    fn complete(&mut self, deadline: Duration) {
        // A delayed watchdog or an encoder that has already exited cannot turn a late completion into success, and
        // the cleanup after an exit in time cannot turn it into a missed deadline.
        let at = self.exited_at.unwrap_or_else(Instant::now);
        if self.reason.is_none()
            && self
                .finished_at
                .is_some_and(|finished| at.saturating_duration_since(finished) >= deadline)
        {
            self.reason = Some(StopReason::Deadline);
        }
        self.done = true;
    }
}

// Counts the input reader keeps as frames arrive.
#[derive(Debug, Default)]
struct Receipt {
    received: u64,
    out_of_order: u64,
    out_of_range: u64,
    duplicate: u64,
    bytes_received: u64,
    first_timestamp_us: Option<u64>,
    last_timestamp_us: Option<u64>,
}

// Counts and facts the encoder thread keeps.
#[derive(Debug, Default)]
struct Progress {
    shown: u64,
    superseded: u64,
    /// Frames past the last video frame the recording's duration allows.
    out_of_range: u64,
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
    data: Arc<RecordingData>,
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
        data: Arc<RecordingData>,
        ffmpeg: &Path,
        capabilities: &Capabilities,
        replies: Replies,
    ) -> Result<Recording, EncoderFailure> {
        let arguments = encoder::encode_arguments(
            plan.codec,
            plan.input,
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
            let _ = encoder::wait_until(
                &mut child,
                &mut ownership,
                Instant::now() + EXIT_GRACE,
                &mut problems,
            );
            problems.extend(ownership.cleanup(&mut child, EXIT_GRACE));
            return Err(EncoderFailure {
                message: format!(
                    "encoder launch ownership was unknown; cleanup failed: {}",
                    problems.join("; ")
                ),
                exit: None,
            });
        }
        let (Some(stdin), Some(stderr)) = (child.stdin.take(), child.stderr.take()) else {
            problems.extend(ownership.stop(&mut child));
            let _ = encoder::wait_until(
                &mut child,
                &mut ownership,
                Instant::now() + EXIT_GRACE,
                &mut problems,
            );
            problems.extend(ownership.cleanup(&mut child, EXIT_GRACE));
            return Err(EncoderFailure {
                message: format!(
                    "the encoder's pipes could not be opened{}",
                    cleanup_suffix(&problems)
                ),
                exit: None,
            });
        };
        let tail = StderrTail::default();
        let stderr_thread = tail.follow(stderr);
        let (route, encoded_format) = match plan.input {
            Input::Raw => ("decoded", None),
            Input::Images(format) => ("encoded", Some(format)),
        };
        let started = Started {
            recording_id: plan.id.clone(),
            identity: data.identity.clone(),
            codec: plan.codec.name().to_owned(),
            container: plan.codec.container().to_owned(),
            encoder: plan.codec.encoder().to_owned(),
            encoder_version: capabilities.version.clone(),
            encoder_pid,
            path: plan.path.to_string_lossy().into_owned(),
            route: route.to_owned(),
            encoded_format,
            frames_path: data
                .store
                .as_ref()
                .map(|store| store.path().to_string_lossy().into_owned()),
            frame_store_bytes: data.store.as_ref().map(FrameStore::max_bytes),
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
            data,
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
                message: shared
                    .cleanup_message(format!("the recording's watchdog could not start: {error}")),
                exit: None,
            });
        }
        replies.send(&Reply::Started(Box::new(started)));
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
                    message: shared
                        .cleanup_message(format!("the encoder thread could not start: {error}")),
                    exit: None,
                })
            }
        }
    }

    /// Where the finished video will be.
    pub fn path(&self) -> &Path {
        &self.shared.plan.path
    }

    pub fn data(&self) -> &Arc<RecordingData> {
        &self.shared.data
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

    /// Takes a frame from the input. The counts, the ledger and the push happen under one lock, so a frame that
    /// arrives as the recording ends is either counted and accounted for, or not counted at all.
    pub fn receive(&self, header: &FrameHeader, bytes: Vec<u8>) {
        let plan = &self.shared.plan;
        let data = &self.shared.data;
        let mut receipt = lock(&self.shared.receipt);
        let timestamp = header.timestamp_us;
        let length = bytes.len() as u64;
        let mut ledger = data.ledger();
        let out_of_order = receipt
            .last_timestamp_us
            .is_some_and(|last| timestamp < last);
        let out_of_range = !out_of_order
            && receipt
                .first_timestamp_us
                .is_some_and(|first| timestamp - first > plan.max_duration_us);
        let refused = if out_of_order {
            Some(Fate::OutOfOrder)
        } else if out_of_range {
            Some(Fate::OutOfRange)
        } else {
            None
        };
        // A frame the queue would refuse is not part of the recording, so it is neither counted nor recorded.
        if !self.shared.queue.accepts() {
            return;
        }
        let admitted = ledger.admit(header, refused.unwrap_or(Fate::Queued));
        if admitted.duplicate || refused.is_some() {
            receipt.received += 1;
            receipt.bytes_received += length;
            receipt.duplicate += u64::from(admitted.duplicate);
            receipt.out_of_order += u64::from(!admitted.duplicate && out_of_order);
            receipt.out_of_range += u64::from(!admitted.duplicate && out_of_range);
            return;
        }
        data.live.offer(header, &bytes);
        let frame = QueuedFrame {
            timestamp_us: timestamp,
            format: header.format,
            bytes,
            place: admitted.place,
        };
        match self.shared.queue.push(frame) {
            // The queue closed since it was asked: the frame is taken back out of the ledger and not counted.
            Push::Refused => {
                ledger.retract(admitted.place);
                return;
            }
            Push::TooLarge => ledger.set_fate(admitted.place, Fate::Dropped),
            Push::Queued { dropped } => {
                for place in dropped {
                    ledger.set_fate(place, Fate::Dropped);
                }
            }
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

    /// Waits for a stopped recording's thread as `join` does, but no longer than its deadline, its stall limit and
    /// the bounded waits after them. A thread still running then is blocked on an encoder no stop could reach: it
    /// is left to the process's exit and `None` says so. No ending is made up for it; the client, which sees the
    /// recording never ended, stops the encoder it recorded and names the file left.
    pub fn join_within_bound(self, replies: &Replies) -> Option<EndStatus> {
        let plan = &self.shared.plan;
        let end = Instant::now() + plan.deadline + plan.stall + STOPPED_THREAD_GRACE;
        while !self.thread_done() {
            if Instant::now() >= end {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
        Some(self.join(replies))
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
                "the recording failed inside the media process; its frame counts are lost"
                    .to_owned(),
            );
            let data = &self.shared.data;
            data.ended.store(true, Ordering::Release);
            data.live.close();
            replies.send(&Reply::Ended(Box::new(ended_before_start(
                &self.shared.plan.id,
                &data.identity,
                EndStatus::EncoderFailed,
                message,
                None,
            ))));
        }
        EndStatus::EncoderFailed
    }
}

impl Shared {
    // Watches for a missed deadline or a stalled write. Only recorded processes with a freshly verified
    // identity are stopped; an unreadable status is unknown and is retained as a cleanup failure. A stop that did
    // not reach the encoder, such as one whose process reading failed, is tried again while the recording is not
    // done, since the encoder thread may be waiting on a write the encoder will never take.
    fn watch(&self) {
        let mut ending = lock(&self.ending);
        let mut stopped_at: Option<Instant> = None;
        while !ending.done {
            if stopped_at.is_none_or(|at| at.elapsed() >= STOP_RETRY)
                && let Some(reason) = self.overdue(&ending)
            {
                if ending.reason.is_none() {
                    ending.reason = Some(reason);
                }
                if ending.exited_at.is_none() {
                    self.stop_encoder();
                }
                stopped_at = Some(Instant::now());
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
        self.close_queue();
    }

    // Notes that the encoder thread saw the encoder exit, so neither the watchdog nor the deadline counts the
    // cleanup that follows.
    fn note_exit(&self) {
        let mut ending = lock(&self.ending);
        ending.exited_at.get_or_insert_with(Instant::now);
    }

    // Ends the queue, recording the frames still in it as never processed.
    fn close_queue(&self) {
        let left = self.queue.close();
        if left.is_empty() {
            return;
        }
        let mut ledger = self.data.ledger();
        for place in left {
            ledger.set_fate(place, Fate::Unprocessed);
        }
    }

    // Ends a recording whose threads could not start or failed. An uncertain cleanup keeps its partial file.
    fn abandon(&self) {
        self.mark_done();
        self.stop_encoder();
        let _ = self.wait_for_encoder(Some(EXIT_GRACE));
        self.finish_cleanup();
        self.close_queue();
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
        if every_stop_refused_for_a_test() {
            return self.note_cleanup(vec!["a test refused every encoder stop".to_owned()]);
        }
        // The child before the ownership, as `encoder_status` takes them.
        let mut child = lock(&self.child);
        let problems = lock(&self.ownership).stop(&mut child);
        drop(child);
        self.note_cleanup(problems);
    }

    fn finish_cleanup(&self) {
        let mut child = lock(&self.child);
        let problems = lock(&self.ownership).cleanup(&mut child, EXIT_GRACE);
        drop(child);
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
                self.note_cleanup(vec![
                    "the encoder exit could not be read; completion is unknown".to_owned(),
                ]);
                true
            }
        }
    }

    fn encoder_status(&self) -> Option<ExitStatus> {
        match lock(&self.child).try_wait() {
            Ok(None) => {
                self.capture_encoder();
                None
            }
            Ok(status) => status,
            Err(_) => {
                self.note_cleanup(vec![
                    "the encoder exit could not be read; completion is unknown".to_owned(),
                ]);
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
            if lock(&self.cleanup_problems)
                .iter()
                .any(|problem| problem.starts_with("the encoder exit could not be read"))
            {
                return None;
            }
            if let Some(stopped_at) = stopped_at {
                if Instant::now().duration_since(stopped_at) >= EXIT_GRACE {
                    self.note_cleanup(vec![
                        "the encoder did not confirm an exit after cleanup".to_owned(),
                    ]);
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
        ending.complete(self.plan.deadline);
        let snapshot = Ending {
            done: true,
            reason: ending.reason,
            finished_at: ending.finished_at,
            exited_at: ending.exited_at,
        };
        drop(ending);
        self.ending_changed.notify_all();
        snapshot
    }

    fn stop_requested(&self) -> bool {
        lock(&self.ending).reason.is_some()
    }

    // Keeps a frame's bytes in the store, when frames are kept and there is room, and records where.
    fn keep(&self, queued: &QueuedFrame, source_width: u32, source_height: u32) {
        let Some(store) = self.data.store.as_ref() else {
            return;
        };
        let Ok(length) = u32::try_from(queued.bytes.len()) else {
            return;
        };
        let Ok(offset) = store.append(&queued.bytes) else {
            return;
        };
        self.data.ledger().keep(
            queued.place,
            Stored {
                offset,
                length,
                format: queued.format,
                width: source_width,
                height: source_height,
            },
        );
        self.data
            .stored_through_us
            .fetch_max(queued.timestamp_us, Ordering::AcqRel);
        self.data.has_stored.store(true, Ordering::Release);
    }
}

fn cleanup_suffix(problems: &[String]) -> String {
    if problems.is_empty() {
        String::new()
    } else {
        format!(
            "; cleanup failed or completion is unknown: {}",
            problems.join("; ")
        )
    }
}

// A test sets this to stand for a stop the ownership rule refuses, such as one of an encoder whose readable command
// changed, so it can show that such an encoder holds no shutdown forever. Release builds have no hook.
#[cfg(debug_assertions)]
fn every_stop_refused_for_a_test() -> bool {
    std::env::var_os("RETEST_MEDIA_TEST_REFUSE_STOPS").is_some()
}

#[cfg(not(debug_assertions))]
fn every_stop_refused_for_a_test() -> bool {
    false
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

// A frame the encoder thread took: what it writes to the encoder, and where it is in the ledger.
struct Held {
    bytes: Vec<u8>,
    place: Option<usize>,
}

// What a frame becomes on the recording's route: raw pixels, or an image converted to the route's format, or, when
// `bytes` is `None`, the image exactly as it came.
struct Prepared {
    bytes: Option<Vec<u8>>,
    resized: bool,
    source_width: u32,
    source_height: u32,
}

fn prepare(plan: &RecordingPlan, queued: &QueuedFrame) -> Result<Prepared, String> {
    match plan.input {
        Input::Raw => {
            frame::decode(&queued.bytes, queued.format, plan.width, plan.height).map(|pixels| {
                Prepared {
                    bytes: Some(pixels.rgb),
                    resized: pixels.resized,
                    source_width: pixels.source_width,
                    source_height: pixels.source_height,
                }
            })
        }
        Input::Images(route) => {
            let ready =
                frame::for_route(&queued.bytes, queued.format, route, plan.width, plan.height)?;
            Ok(Prepared {
                bytes: ready.bytes,
                resized: ready.resized,
                source_width: ready.source_width,
                source_height: ready.source_height,
            })
        }
    }
}

// The encoder thread: takes frames in order, readies them for the route, keeps them, places them on the timeline
// and writes them.
fn feed_encoder(
    shared: &Shared,
    stdin: ChildStdin,
    stderr_thread: JoinHandle<Result<(), String>>,
    replies: &Replies,
) -> EndStatus {
    let plan = &shared.plan;
    let data = &shared.data;
    let mut stdin = Some(stdin);
    let mut progress = Progress::default();
    let mut timeline = Timeline::new(plan.fps, plan.max_gap_us);
    let max_output_frames = timeline.ticks_within(plan.max_duration_us);
    // The frame on screen, written once the next frame or the end says how long it stays.
    let mut held: Option<Held> = None;
    let flow = loop {
        if shared.stop_requested() {
            break Flow::Interrupted;
        }
        match shared.queue.pop(IDLE_CHECK) {
            Pop::Frame(queued) => {
                fail_if_a_test_asks();
                #[cfg(debug_assertions)]
                if progress.first_timestamp_us.is_none()
                    && std::env::var_os("RETEST_MEDIA_TEST_HOLD_FIRST_FRAME").is_some()
                {
                    thread::sleep(Duration::from_millis(300));
                }
                let Ok(prepared) = prepare(plan, &queued) else {
                    progress.undecodable += 1;
                    data.ledger().set_fate(queued.place, Fate::Undecodable);
                    continue;
                };
                shared.keep(&queued, prepared.source_width, prepared.source_height);
                data.ledger().set_fate(queued.place, Fate::Taken);
                // Kept already; the bytes now move to the encoder's side without another copy.
                let bytes = prepared.bytes.unwrap_or(queued.bytes);
                progress.resized += u64::from(prepared.resized);
                let (placement, shortened) = timeline.place(queued.timestamp_us);
                if shortened > 0 {
                    progress.note_gap(queued.timestamp_us, shortened);
                }
                match (placement, held.as_ref()) {
                    (Placement::First, _) => {
                        progress.first_timestamp_us = Some(queued.timestamp_us);
                        progress.frames_before_first =
                            shared.queue.dropped() + progress.undecodable;
                    }
                    (Placement::Advances { repeat }, Some(previous)) => {
                        let write = FrameWrite {
                            shared,
                            bytes: &previous.bytes,
                            repeat,
                            max_output_frames,
                        };
                        let at = progress.output_frames;
                        let Ok(written) = write.to(stdin.as_mut(), &mut progress) else {
                            progress.unprocessed += 1;
                            data.ledger().set_fate(previous.place, Fate::Unprocessed);
                            held = Some(Held {
                                bytes,
                                place: queued.place,
                            });
                            break Flow::WriteFailed;
                        };
                        place_written(&mut progress, data, previous.place, at, written);
                    }
                    (Placement::Supersedes, Some(previous)) => {
                        progress.superseded += 1;
                        data.ledger().set_fate(previous.place, Fate::Superseded);
                    }
                    _ => {}
                }
                held = Some(Held {
                    bytes,
                    place: queued.place,
                });
            }
            Pop::Finished { end_timestamp_us } => {
                let Some(last) = held.take() else {
                    break Flow::NoFrames;
                };
                let limit = timeline
                    .origin_us()
                    .unwrap_or(0)
                    .saturating_add(plan.max_duration_us);
                let (repeat, clipped) = timeline.finish(end_timestamp_us, limit);
                progress.end_clipped |= clipped;
                let write = FrameWrite {
                    shared,
                    bytes: &last.bytes,
                    repeat,
                    max_output_frames,
                };
                let at = progress.output_frames;
                let Ok(written) = write.to(stdin.as_mut(), &mut progress) else {
                    held = Some(last);
                    break Flow::WriteFailed;
                };
                place_written(&mut progress, data, last.place, at, written);
                break Flow::Closed;
            }
            Pop::Closed => break Flow::Interrupted,
            Pop::Idle if shared.encoder_status().is_some() => break Flow::EncoderExited,
            Pop::Idle => {}
        }
    };
    if let Some(held) = held {
        progress.unprocessed += 1;
        data.ledger().set_fate(held.place, Fate::Unprocessed);
    }
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
    if status.is_some() {
        shared.note_exit();
    }
    // Recorded descendants retain their launch identities after their parent exits. A group number alone
    // never authorizes cleanup, and a reader that remains open makes completion unknown.
    shared.finish_cleanup();
    match encoder::join_within(stderr_thread, STDERR_GRACE) {
        Some(Ok(())) => {}
        Some(Err(error)) => shared.note_cleanup(vec![error]),
        None => shared.note_cleanup(vec![
            "the encoder stderr did not close; cleanup completion is unknown".to_owned(),
        ]),
    }
    shared.close_queue();
    // The watchdog remains active while the supervised file worker runs. Only file completion, or its bounded
    // failure, ends finalization. Encoder cleanup itself is accounted separately from the exit time.
    let ending = {
        let ending = lock(&shared.ending);
        Ending {
            done: false,
            reason: ending.reason,
            finished_at: ending.finished_at,
            exited_at: ending.exited_at,
        }
    };
    let (ended, frame_map) = conclude(shared, flow, status, &ending, progress);
    shared.mark_done();
    let end_status = ended.status;
    shared.over.store(true, Ordering::Release);
    data.ended.store(true, Ordering::Release);
    data.live.close();
    replies.send_with_payload(&Reply::Ended(Box::new(ended)), &frame_map);
    // Hold only the return from the worker, after every recording operation and the ending, to exercise the
    // client's right to release an ended recording before the server happens to join its thread.
    #[cfg(debug_assertions)]
    if std::env::var_os("RETEST_MEDIA_TEST_HOLD_ENDED_THREAD").is_some() {
        thread::sleep(Duration::from_millis(300));
    }
    end_status
}

// Records where a frame went once its writes are done. A frame no video frame holds, because the recording already
// has as many video frames as its longest duration allows, lies past the end of the video: it is out of range, and
// the end is clipped, never `shown`.
fn place_written(
    progress: &mut Progress,
    data: &RecordingData,
    place: Option<usize>,
    at: u64,
    written: u64,
) {
    if written == 0 {
        progress.out_of_range += 1;
        progress.end_clipped = true;
        data.ledger().set_fate(place, Fate::OutOfRange);
    } else {
        progress.shown += 1;
        data.ledger().show(place, at, written);
    }
}

// One frame's bytes, written `repeat` times, never past the recording's most output frames.
struct FrameWrite<'a> {
    shared: &'a Shared,
    bytes: &'a [u8],
    repeat: u64,
    max_output_frames: u64,
}

impl FrameWrite<'_> {
    // Writes and says how many video frames were written.
    fn to(&self, stdin: Option<&mut ChildStdin>, progress: &mut Progress) -> io::Result<u64> {
        let stdin = stdin.ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        let room = self
            .max_output_frames
            .saturating_sub(progress.output_frames);
        let writes = self.repeat.min(room);
        for _ in 0..writes {
            *lock(&self.shared.writing_since) = Some(Instant::now());
            let written = stdin.write_all(self.bytes);
            *lock(&self.shared.writing_since) = None;
            written?;
            progress.output_frames += 1;
            progress.bytes_to_encoder += self.bytes.len() as u64;
        }
        Ok(writes)
    }
}

fn conclude(
    shared: &Shared,
    flow: Flow,
    status: Option<ExitStatus>,
    ending: &Ending,
    progress: Progress,
) -> (Ended, Vec<u8>) {
    let plan = &shared.plan;
    let encoder_exit = EncoderExit {
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(encoder::signal_of),
        stderr: shared.tail.lines(),
        lines: shared.tail.printed(),
    };
    let described = status.map_or_else(|| "an unknown status".to_owned(), encoder::describe_status);
    let mut kept_partial = None;
    let mut placed_by = None;
    let problems = lock(&shared.cleanup_problems).clone();
    let (mut end_status, mut message) = match (ending.reason, flow) {
        (Some(StopReason::Deadline), _) => {
            if status.is_some_and(|status| status.success()) {
                kept_partial = Some(plan.partial_path().to_string_lossy().into_owned());
            }
            let message = format!(
                "finishing took longer than {} ms; encoder cleanup was requested",
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
        (None, Flow::Closed)
            if status.is_some_and(|status| status.success()) && problems.is_empty() =>
        {
            let placed = place_video(plan, ending.finished_at);
            kept_partial = placed.kept_partial;
            placed_by = placed.placed_by;
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
            placed_by = None;
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
        out_of_range: receipt.out_of_range + progress.out_of_range,
        undecodable: progress.undecodable,
        duplicate: receipt.duplicate,
        unprocessed: progress.unprocessed + shared.queue.unprocessed(),
        resized: progress.resized,
    };
    // An encoder that failed or was stopped says how; one that printed while it wrote a video says what it printed.
    let encoder_ran = !matches!(
        end_status,
        EndStatus::Ok | EndStatus::NoFrames | EndStatus::OutputFailed
    ) || shared.tail.printed() > 0;
    let ledger = shared.data.ledger();
    let frame_map = ledger.frame_map(plan.fps, MAX_PAYLOAD_BYTES as usize);
    let (capture_gaps, capture_gaps_reported) = ledger.listed_capture_gaps();
    let frame_map_omitted = ledger.omitted() + frame_map.cut;
    drop(ledger);
    let evidence = evidence_of(&EvidenceFacts {
        status: end_status,
        frames: &frames,
        capture_gaps_reported,
        gaps_shortened: progress.gaps_shortened,
        end_clipped: progress.end_clipped,
        frame_map_omitted,
        encoder_lines: shared.tail.printed(),
    });
    let timeline = Timeline::new(plan.fps, plan.max_gap_us);
    let ended = Ended {
        recording_id: plan.id.clone(),
        identity: shared.data.identity.clone(),
        status: end_status,
        message,
        path: (end_status == EndStatus::Ok).then(|| plan.path.to_string_lossy().into_owned()),
        partial_path: kept_partial,
        placed_by: placed_by.map(Placed::name),
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
        queue: shared.queue.stats(),
        capture_gaps,
        capture_gaps_reported,
        evidence,
        frame_map_entries: frame_map.listed,
        frame_map_omitted,
        encoder: encoder_ran.then_some(encoder_exit),
        finalize_ms: ending.finished_at.map(|at| millis(at.elapsed())),
    };
    (ended, frame_map.json)
}

/// The facts a recording's evidence is judged from.
pub struct EvidenceFacts<'a> {
    pub status: EndStatus,
    pub frames: &'a FrameCounts,
    pub capture_gaps_reported: u64,
    pub gaps_shortened: u64,
    pub end_clipped: bool,
    pub frame_map_omitted: u64,
    pub encoder_lines: u64,
}

/// Names what a recording's video lacks. Superseded frames are no loss: the frame rate shows one frame per tick.
/// Lines the encoder printed while writing a video it then finished are named too, since at its log level ffmpeg
/// prints only errors, such as an image it could not decode.
pub fn evidence_of(facts: &EvidenceFacts<'_>) -> Evidence {
    let frames = facts.frames;
    let losses = [
        (frames.dropped > 0, "frames_dropped"),
        (frames.undecodable > 0, "frames_undecodable"),
        (frames.out_of_order > 0, "frames_out_of_order"),
        (frames.out_of_range > 0, "frames_out_of_range"),
        (frames.duplicate > 0, "frames_duplicate"),
        (frames.unprocessed > 0, "frames_unprocessed"),
        (facts.capture_gaps_reported > 0, "capture_gaps"),
        (facts.gaps_shortened > 0, "gaps_shortened"),
        (facts.end_clipped, "end_clipped"),
        (facts.frame_map_omitted > 0, "frame_map_truncated"),
        (
            facts.status == EndStatus::Ok && facts.encoder_lines > 0,
            "encoder_reported_errors",
        ),
    ];
    let mut reasons: Vec<&'static str> = Vec::new();
    if facts.status != EndStatus::Ok {
        reasons.push(facts.status.code());
    }
    reasons.extend(
        losses
            .iter()
            .filter(|(lost, _)| *lost)
            .map(|(_, reason)| *reason),
    );
    let status = match (facts.status, reasons.is_empty()) {
        (EndStatus::Ok, true) => "complete",
        (EndStatus::Ok, false) => "partial",
        _ => "unavailable",
    };
    Evidence { status, reasons }
}

struct PlacedVideo {
    status: EndStatus,
    message: String,
    kept_partial: Option<String>,
    placed_by: Option<Placed>,
}

// Puts the finished file at the recording's path, never replacing a file that appeared there since the start: then
// the video stays at its `.partial`, named in the reply.
fn place_video(plan: &RecordingPlan, finished_at: Option<Instant>) -> PlacedVideo {
    let partial = plan.partial_path();
    let deadline = finished_at.unwrap_or_else(Instant::now) + plan.deadline;
    let result = finalize_within(&partial, &plan.path, deadline);
    match result {
        Ok(place::Finalization::Placed(placed)) => {
            // Every file operation, including removing the original, and the child's exit have completed
            // within the finish budget. No filesystem call on this thread can hold up this successful ending.
            PlacedVideo {
                status: EndStatus::Ok,
                message: "the video is written".to_owned(),
                kept_partial: None,
                placed_by: Some(placed),
            }
        }
        Ok(place::Finalization::Missing(message)) => PlacedVideo {
            status: EndStatus::OutputFailed,
            message,
            kept_partial: None,
            placed_by: None,
        },
        Ok(place::Finalization::Failed(message)) => PlacedVideo {
            status: EndStatus::OutputFailed,
            message,
            kept_partial: Some(partial.to_string_lossy().into_owned()),
            placed_by: None,
        },
        Err(error) => PlacedVideo {
            status: if error.kind() == io::ErrorKind::TimedOut {
                EndStatus::DeadlineExceeded
            } else {
                EndStatus::OutputFailed
            },
            message: format!(
                "file finalization failed for {}: {error}; partial location: {}; publication or source removal may be unknown if the worker was interrupted during a filesystem call",
                plan.path.display(),
                partial.display()
            ),
            kept_partial: Some(partial.to_string_lossy().into_owned()),
            placed_by: None,
        },
    }
}

/// Filesystem calls can block without a cooperative cancellation point. A child owns that work, while this thread
/// owns the finish deadline and can stop its unreaped child through the Child handle. Timeout names the partial
/// and the publication path; a filesystem operation already dispatched can have an unknown outcome.
fn finalize_within(
    partial: &Path,
    path: &Path,
    deadline: Instant,
) -> io::Result<place::Finalization> {
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the finish deadline expired before file finalization",
        ));
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--finalize-file")
        .arg(partial)
        .arg(path)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(debug_assertions)]
    for name in [
        "RETEST_MEDIA_TEST_NO_HARD_LINKS",
        "RETEST_MEDIA_TEST_KILL_DURING_COPY",
        "RETEST_MEDIA_TEST_FINALIZE_DELAY_MS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn()?;
    loop {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "the finish deadline expired during file finalization; {}",
                    stop_finalizer(&mut child)
                ),
            ));
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "the finalizer exit could not be read: {error}; {}",
                        stop_finalizer(&mut child)
                    ),
                ));
            }
        };
        match status {
            Some(status) => {
                #[cfg(debug_assertions)]
                if std::env::var_os("RETEST_MEDIA_TEST_KILL_DURING_COPY").is_some()
                    && encoder::signal_of(status) == Some(9)
                {
                    // The existing crash regression models a kill of the entire media process mid-copy.
                    // SAFETY: this process sends SIGKILL only to itself.
                    unsafe {
                        libc::kill(libc::getpid(), libc::SIGKILL);
                    }
                }
                if !status.success() {
                    return Err(io::Error::other(format!(
                        "the file finalizer ended with {}",
                        encoder::describe_status(status)
                    )));
                }
                let mut bytes = Vec::new();
                child
                    .stdout
                    .take()
                    .ok_or_else(|| io::Error::other("the file finalizer has no result pipe"))?
                    .take(16 * 1024)
                    .read_to_end(&mut bytes)?;
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "file finalization completed after the finish deadline",
                    ));
                }
                return serde_json::from_slice(&bytes).map_err(io::Error::other);
            }
            None => thread::sleep(Duration::from_millis(5)),
        }
    }
}

fn stop_finalizer(child: &mut Child) -> String {
    let stopped = child.kill();
    let reaped = Instant::now() + EXIT_GRACE;
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < reaped {
        thread::sleep(Duration::from_millis(10));
    }
    let known = matches!(child.try_wait(), Ok(Some(_)));
    format!(
        "worker stop: {}; exit confirmed: {known}",
        stopped.map_or_else(|error| error.to_string(), |()| "requested".to_owned())
    )
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
    identity: &RecordingIdentity,
    status: EndStatus,
    message: String,
    exit: Option<EncoderExit>,
) -> Ended {
    let frames = FrameCounts::default();
    let evidence = evidence_of(&EvidenceFacts {
        status,
        frames: &frames,
        capture_gaps_reported: 0,
        gaps_shortened: 0,
        end_clipped: false,
        frame_map_omitted: 0,
        encoder_lines: 0,
    });
    Ended {
        recording_id: recording_id.to_owned(),
        identity: identity.clone(),
        status,
        message,
        path: None,
        partial_path: None,
        placed_by: None,
        frames,
        first_timestamp_us: None,
        frames_before_first: 0,
        gaps: Vec::new(),
        gaps_shortened: 0,
        end_clipped: false,
        output_frames: 0,
        duration_us: 0,
        bytes_received: 0,
        bytes_to_encoder: 0,
        queue: Default::default(),
        capture_gaps: Vec::new(),
        capture_gaps_reported: 0,
        evidence,
        frame_map_entries: 0,
        frame_map_omitted: 0,
        encoder: exit,
        finalize_ms: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_after_the_deadline_fails_even_without_a_watchdog_stop() {
        let deadline = Duration::from_millis(50);
        let mut ending = Ending {
            finished_at: Some(Instant::now() - deadline - deadline),
            ..Ending::default()
        };
        ending.complete(deadline);
        assert!(ending.done);
        assert_eq!(ending.reason, Some(StopReason::Deadline));
    }

    #[test]
    fn an_encoder_that_exited_in_time_is_not_late_because_cleanup_took_long() {
        let deadline = Duration::from_millis(80);
        let now = Instant::now();
        let mut in_time = Ending {
            finished_at: Some(now - Duration::from_millis(500)),
            exited_at: Some(now - Duration::from_millis(440)),
            ..Ending::default()
        };
        in_time.complete(deadline);
        assert_eq!(in_time.reason, None, "the exit came 60 ms after the finish");
        let mut late = Ending {
            finished_at: Some(now - Duration::from_millis(500)),
            exited_at: Some(now - Duration::from_millis(400)),
            ..Ending::default()
        };
        late.complete(deadline);
        assert_eq!(
            late.reason,
            Some(StopReason::Deadline),
            "the exit came 100 ms after the finish"
        );
    }

    #[test]
    fn completion_preserves_an_earlier_stop_reason() {
        let deadline = Duration::from_millis(50);
        let mut ending = Ending {
            reason: Some(StopReason::Shutdown),
            finished_at: Some(Instant::now() - deadline - deadline),
            ..Ending::default()
        };
        ending.complete(deadline);
        assert!(ending.done);
        assert_eq!(ending.reason, Some(StopReason::Shutdown));
    }

    fn facts(status: EndStatus, frames: &FrameCounts) -> EvidenceFacts<'_> {
        EvidenceFacts {
            status,
            frames,
            capture_gaps_reported: 0,
            gaps_shortened: 0,
            end_clipped: false,
            frame_map_omitted: 0,
            encoder_lines: 0,
        }
    }

    #[test]
    fn a_whole_video_is_complete_and_superseded_frames_lose_nothing() {
        let frames = FrameCounts {
            received: 4,
            shown: 3,
            superseded: 1,
            ..Default::default()
        };
        assert_eq!(
            evidence_of(&facts(EndStatus::Ok, &frames)),
            Evidence {
                status: "complete",
                reasons: vec![]
            }
        );
    }

    #[test]
    fn a_video_missing_frames_is_partial_and_says_why() {
        let frames = FrameCounts {
            received: 6,
            shown: 2,
            dropped: 1,
            undecodable: 1,
            duplicate: 1,
            unprocessed: 1,
            ..Default::default()
        };
        let evidence = evidence_of(&EvidenceFacts {
            capture_gaps_reported: 2,
            encoder_lines: 1,
            ..facts(EndStatus::Ok, &frames)
        });
        assert_eq!(evidence.status, "partial");
        assert_eq!(
            evidence.reasons,
            vec![
                "frames_dropped",
                "frames_undecodable",
                "frames_duplicate",
                "frames_unprocessed",
                "capture_gaps",
                "encoder_reported_errors"
            ]
        );
    }

    #[test]
    fn no_video_is_unavailable_and_names_its_ending_first() {
        let frames = FrameCounts {
            received: 3,
            unprocessed: 3,
            ..Default::default()
        };
        let evidence = evidence_of(&facts(EndStatus::Stopped, &frames));
        assert_eq!(
            evidence,
            Evidence {
                status: "unavailable",
                reasons: vec!["stopped", "frames_unprocessed"]
            }
        );
        let printed = evidence_of(&EvidenceFacts {
            encoder_lines: 4,
            ..facts(EndStatus::EncoderFailed, &FrameCounts::default())
        });
        assert_eq!(
            printed.reasons,
            vec!["encoder_failed"],
            "lines from a failed encoder are its failure, already named"
        );
    }
}
