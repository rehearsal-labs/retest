//! A live view: the newest frame of one recording, fitted and encoded as JPEG, at most so many a second, for one
//! watcher.
//!
//! Each view has a thread of its own. The input reader leaves the newest frame in the recording's live slot only
//! while a view watches; the view's thread takes it when its turn comes, encodes it and offers it to the reply writer,
//! which keeps one live frame per recording and writes it only when nothing else waits. Frames that came and were
//! replaced before the view's turn are counted `skipped`; live frames replaced before the client read them are
//! counted `dropped`. Neither touches the recording's queue, encoder or kept frames.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::frame::{self, FitRequest, ImageFailure, STILL_MAX_DECODE_BYTES, STILL_MAX_SIDE};
use crate::protocol::{FrameFormat, LiveFrame, Reply, WatchEnded};
use crate::recording::{LatestFrame, RecordingData};
use crate::replies::Replies;

/// The most live frames a second a view may ask for.
pub const MAX_LIVE_FPS: u32 = 30;
const DEFAULT_QUALITY: u8 = 70;
/// How long a view waits for a frame before it looks again at why it might stop.
const IDLE_WAIT: Duration = Duration::from_millis(100);

/// What a view was asked for.
#[derive(Debug, Clone, Copy)]
pub struct ViewRequest {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub quality: Option<u8>,
}

/// A running view, owned by the server.
pub struct Watch {
    stop: Arc<Mutex<Option<&'static str>>>,
    data: Arc<RecordingData>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug, Default)]
struct Totals {
    offered: u64,
    skipped: u64,
    dropped: u64,
    failed: u64,
}

impl Watch {
    /// Starts the view's thread. The recording's live slot fills from now on.
    pub fn begin(
        data: Arc<RecordingData>,
        request: ViewRequest,
        replies: Replies,
    ) -> std::io::Result<Watch> {
        let stop = Arc::new(Mutex::new(None));
        // Frames that arrived before the view began are not counted as skipped by it.
        let seen = lock(&data.live.state).arrived;
        data.live.watched.store(true, Ordering::Release);
        let thread = {
            let stop = Arc::clone(&stop);
            let data = Arc::clone(&data);
            thread::Builder::new()
                .name(format!("live {}", data.id))
                .spawn(move || show(&data, request, seen, &stop, &replies))
        };
        match thread {
            Ok(thread) => Ok(Watch {
                stop,
                data,
                thread: Some(thread),
            }),
            Err(error) => {
                data.live.watched.store(false, Ordering::Release);
                Err(error)
            }
        }
    }

    /// Ends the view with `reason`, and waits for its thread, which sends `watchEnded`. Bounded by one frame's
    /// encoding.
    pub fn end(mut self, reason: &'static str) {
        self.stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert(reason);
        self.data.live.changed.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn show(
    data: &RecordingData,
    request: ViewRequest,
    mut seen: u64,
    stop: &Mutex<Option<&'static str>>,
    replies: &Replies,
) {
    let interval = Duration::from_secs(1) / request.max_fps.clamp(1, MAX_LIVE_FPS);
    let fit = FitRequest {
        max_width: request.max_width,
        max_height: request.max_height,
        format: FrameFormat::Jpeg,
        quality: request.quality.unwrap_or(DEFAULT_QUALITY),
        max_side: STILL_MAX_SIDE,
        max_decode_bytes: STILL_MAX_DECODE_BYTES,
    };
    let mut totals = Totals::default();
    let mut failure = None;
    let mut last_offer: Option<Instant> = None;
    let reason = loop {
        let next = match next_frame(data, stop, interval, last_offer, seen) {
            Ok(next) => next,
            Err(reason) => break reason,
        };
        totals.skipped += next.arrived - seen - 1;
        seen = next.arrived;
        last_offer = Some(Instant::now());
        let fitted = match frame::fit(&next.frame.bytes, next.frame.format, fit) {
            Ok(fitted) => fitted,
            Err(error) => {
                totals.failed += 1;
                let reason = match error {
                    ImageFailure::Undecodable(_) => "undecodable",
                    ImageFailure::TooLarge(_) => "too_large",
                };
                // One bounded message names the last refused frame; the total counts every refusal.
                failure = Some(format!("live frame {} is {reason}", next.frame.frame_id));
                continue;
            }
        };
        totals.offered += 1;
        let live = Reply::Live(LiveFrame {
            recording_id: data.id.clone(),
            frame_id: next.frame.frame_id.to_string(),
            capture_us: next.frame.capture_us,
            width: fitted.width,
            height: fitted.height,
            format: FrameFormat::Jpeg,
            sequence: totals.offered,
            skipped: totals.skipped,
            dropped: totals.dropped,
            byte_length: fitted.bytes.len() as u64,
        });
        totals.dropped += u64::from(replies.offer_live(&data.id, &live, &fitted.bytes));
    };
    data.live.watched.store(false, Ordering::Release);
    lock(&data.live.state).latest = None;
    // A live frame still waiting would otherwise reach the client after the view's end.
    totals.dropped += u64::from(replies.withdraw_live(&data.id));
    replies.send(&Reply::WatchEnded(WatchEnded {
        recording_id: data.id.clone(),
        reason,
        message: failure,
        sent: totals.offered - totals.dropped,
        skipped: totals.skipped,
        dropped: totals.dropped,
        failed: totals.failed,
    }));
}

struct Next {
    frame: LatestFrame,
    arrived: u64,
}

// Waits for a frame newer than `seen` whose turn has come, or says why the view ends.
fn next_frame(
    data: &RecordingData,
    stop: &Mutex<Option<&'static str>>,
    interval: Duration,
    last_offer: Option<Instant>,
    seen: u64,
) -> Result<Next, &'static str> {
    let mut state = lock(&data.live.state);
    loop {
        if let Some(reason) = *lock(stop) {
            return Err(reason);
        }
        if state.closed {
            return Err("recording_ended");
        }
        let wait = last_offer.map_or(Duration::ZERO, |at| interval.saturating_sub(at.elapsed()));
        if wait.is_zero()
            && state.arrived > seen
            && let Some(frame) = state.latest.take()
        {
            return Ok(Next {
                frame,
                arrived: state.arrived,
            });
        }
        let timeout = if wait.is_zero() { IDLE_WAIT } else { wait };
        state = match data.live.changed.wait_timeout(state, timeout) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        };
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
