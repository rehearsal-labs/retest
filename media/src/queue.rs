//! The bounded queue between the input reader and a recording's encoder.
//!
//! The reader never waits for an encoder: a full queue lets its oldest frame go and counts it. The newest
//! frames stay because the end of a recording, where a test failed, is the part worth keeping. Memory is bounded
//! by frame count and by bytes, whichever is reached first.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use crate::protocol::FrameFormat;

/// A frame as it arrived, still in its own format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedFrame {
    pub timestamp_us: u64,
    pub format: FrameFormat,
    pub bytes: Vec<u8>,
}

/// What the encoder takes next.
#[derive(Debug, PartialEq, Eq)]
pub enum Pop {
    Frame(QueuedFrame),
    /// Every frame is taken and the client finished the recording.
    Finished {
        end_timestamp_us: Option<u64>,
    },
    /// The recording is over; any frames left were counted as unprocessed.
    Closed,
    /// Nothing arrived within the wait.
    Idle,
}

/// What a push did.
#[derive(Debug, PartialEq, Eq)]
pub enum Push {
    /// The frame is queued; `dropped` older frames made room for it.
    Queued { dropped: u64 },
    /// The frame alone is larger than the byte limit, so it was dropped.
    TooLarge,
    /// The recording is finishing or over and takes no more frames.
    Refused,
}

#[derive(Debug, Default)]
struct State {
    frames: VecDeque<QueuedFrame>,
    bytes: usize,
    dropped: u64,
    unprocessed: u64,
    finish: Option<Option<u64>>,
    closed: bool,
}

/// One recording's frames on their way to its encoder.
#[derive(Debug)]
pub struct FrameQueue {
    max_frames: usize,
    max_bytes: usize,
    state: Mutex<State>,
    ready: Condvar,
}

impl FrameQueue {
    /// A queue holding at most `max_frames` frames and `max_bytes` bytes; both must be at least one.
    pub fn new(max_frames: usize, max_bytes: usize) -> Self {
        FrameQueue {
            max_frames: max_frames.max(1),
            max_bytes: max_bytes.max(1),
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
        }
    }

    pub fn push(&self, frame: QueuedFrame) -> Push {
        let mut state = self.lock();
        if state.closed || state.finish.is_some() {
            return Push::Refused;
        }
        if frame.bytes.len() > self.max_bytes {
            state.dropped += 1;
            return Push::TooLarge;
        }
        let mut dropped = 0;
        while state.frames.len() >= self.max_frames
            || state.bytes + frame.bytes.len() > self.max_bytes
        {
            let Some(oldest) = state.frames.pop_front() else {
                break;
            };
            state.bytes -= oldest.bytes.len();
            dropped += 1;
        }
        state.dropped += dropped;
        state.bytes += frame.bytes.len();
        state.frames.push_back(frame);
        drop(state);
        self.ready.notify_one();
        Push::Queued { dropped }
    }

    /// Marks the recording finished: the encoder takes what is queued, then `Pop::Finished`.
    pub fn finish(&self, end_timestamp_us: Option<u64>) {
        let mut state = self.lock();
        if state.finish.is_none() {
            state.finish = Some(end_timestamp_us);
        }
        drop(state);
        self.ready.notify_one();
    }

    /// Ends the queue now. Frames still in it are counted as unprocessed and freed.
    pub fn close(&self) {
        let mut state = self.lock();
        if !state.closed {
            state.closed = true;
            state.unprocessed += state.frames.len() as u64;
            state.frames.clear();
            state.bytes = 0;
        }
        drop(state);
        self.ready.notify_all();
    }

    /// Takes the next frame, waiting up to `wait` for one.
    pub fn pop(&self, wait: Duration) -> Pop {
        let mut state = self.lock();
        let mut waited = false;
        loop {
            if state.closed {
                return Pop::Closed;
            }
            if let Some(frame) = state.frames.pop_front() {
                state.bytes -= frame.bytes.len();
                return Pop::Frame(frame);
            }
            if let Some(end_timestamp_us) = state.finish {
                return Pop::Finished { end_timestamp_us };
            }
            if waited {
                return Pop::Idle;
            }
            state = match self.ready.wait_timeout(state, wait) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
            waited = true;
        }
    }

    pub fn dropped(&self) -> u64 {
        self.lock().dropped
    }

    pub fn unprocessed(&self) -> u64 {
        self.lock().unprocessed
    }

    // A thread that panicked holding the lock leaves counts that are still worth reporting.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(timestamp_us: u64, size: usize) -> QueuedFrame {
        QueuedFrame {
            timestamp_us,
            format: FrameFormat::Png,
            bytes: vec![0; size],
        }
    }

    fn timestamps(queue: &FrameQueue) -> Vec<u64> {
        let mut seen = Vec::new();
        while let Pop::Frame(frame) = queue.pop(Duration::ZERO) {
            seen.push(frame.timestamp_us);
        }
        seen
    }

    #[test]
    fn a_full_queue_lets_the_oldest_frame_go() {
        let queue = FrameQueue::new(3, 1 << 20);
        for timestamp in 0..3 {
            assert_eq!(
                queue.push(frame(timestamp, 10)),
                Push::Queued { dropped: 0 }
            );
        }
        assert_eq!(queue.push(frame(3, 10)), Push::Queued { dropped: 1 });
        assert_eq!(queue.push(frame(4, 10)), Push::Queued { dropped: 1 });
        assert_eq!(queue.dropped(), 2);
        assert_eq!(timestamps(&queue), vec![2, 3, 4]);
    }

    #[test]
    fn the_byte_limit_holds_as_well_as_the_count() {
        let queue = FrameQueue::new(100, 100);
        assert_eq!(queue.push(frame(0, 40)), Push::Queued { dropped: 0 });
        assert_eq!(queue.push(frame(1, 40)), Push::Queued { dropped: 0 });
        assert_eq!(
            queue.push(frame(2, 60)),
            Push::Queued { dropped: 1 },
            "40 + 60 fills the 100 bytes exactly"
        );
        assert_eq!(queue.push(frame(3, 90)), Push::Queued { dropped: 2 });
        assert_eq!(timestamps(&queue), vec![3]);
        assert_eq!(queue.dropped(), 3);
    }

    #[test]
    fn a_frame_larger_than_the_byte_limit_is_dropped_itself() {
        let queue = FrameQueue::new(10, 100);
        queue.push(frame(0, 50));
        assert_eq!(queue.push(frame(1, 101)), Push::TooLarge);
        assert_eq!(queue.dropped(), 1);
        assert_eq!(timestamps(&queue), vec![0]);
    }

    #[test]
    fn finishing_hands_over_the_queued_frames_first() {
        let queue = FrameQueue::new(10, 1000);
        queue.push(frame(0, 1));
        queue.push(frame(1, 1));
        queue.finish(Some(99));
        assert_eq!(queue.push(frame(2, 1)), Push::Refused);
        assert!(matches!(
            queue.pop(Duration::ZERO),
            Pop::Frame(QueuedFrame {
                timestamp_us: 0,
                ..
            })
        ));
        assert!(matches!(
            queue.pop(Duration::ZERO),
            Pop::Frame(QueuedFrame {
                timestamp_us: 1,
                ..
            })
        ));
        assert_eq!(
            queue.pop(Duration::ZERO),
            Pop::Finished {
                end_timestamp_us: Some(99)
            }
        );
    }

    #[test]
    fn closing_counts_what_was_left_and_refuses_more() {
        let queue = FrameQueue::new(10, 1000);
        queue.push(frame(0, 1));
        queue.push(frame(1, 1));
        queue.close();
        assert_eq!(queue.unprocessed(), 2);
        assert_eq!(queue.pop(Duration::ZERO), Pop::Closed);
        assert_eq!(queue.push(frame(2, 1)), Push::Refused);
        queue.close();
        assert_eq!(queue.unprocessed(), 2);
    }

    #[test]
    fn an_empty_queue_waits_then_says_idle() {
        let queue = FrameQueue::new(1, 1);
        assert_eq!(queue.pop(Duration::from_millis(5)), Pop::Idle);
    }

    #[test]
    fn a_waiting_encoder_wakes_for_a_frame() {
        let queue = std::sync::Arc::new(FrameQueue::new(4, 1000));
        let producer = std::sync::Arc::clone(&queue);
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            producer.push(frame(7, 1));
        });
        let popped = queue.pop(Duration::from_secs(5));
        thread.join().expect("the producer ran");
        assert!(matches!(
            popped,
            Pop::Frame(QueuedFrame {
                timestamp_us: 7,
                ..
            })
        ));
    }
}
