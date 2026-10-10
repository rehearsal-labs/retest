//! The process's output: one reply at a time, whole, from whichever thread has one.
//!
//! Replies are written by a separate thread. Normal replies have count and byte bounds, a bounded admission
//! wait, and an EOF/shutdown escape. Replies dropped under pressure are counted. A live frame takes its recording's
//! newest slot instead. Shutdown bounds the writer wait and reports reply loss or an unknown blocking write through
//! stderr and exit status, because a blocked stdout cannot reliably carry its own failure.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::protocol::{Reply, encode_reply};

/// Replies other than live frames that may wait unwritten before a sender waits for room.
const QUEUED_REPLIES: usize = 1024;
const ADMISSION_WAIT: Duration = Duration::from_millis(100);
const WRITER_CLOSE_WAIT: Duration = Duration::from_millis(500);

/// Duplicating stdout keeps a blocked writer away from Rust's global stdout shutdown flush.
pub fn stdout_pipe() -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    // SAFETY: F_DUPFD_CLOEXEC creates a separately owned descriptor, atomically closed on child exec. File
    // closes only this duplicate, and encoder descendants cannot retain the media reply pipe.
    let fd = unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: this newly duplicated descriptor is valid and has no other Rust owner.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReplyClose {
    pub replies_dropped: u64,
    pub writer_blocked: bool,
    pub in_flight_unknown: u64,
}
/// The bytes those replies may hold. A frame sequence carries up to 48 MiB and an ending's frame map up to 64 MiB,
/// so a count alone would let a client that stopped reading make the process hold tens of gigabytes.
const QUEUED_REPLY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
struct State {
    queue: VecDeque<Vec<u8>>,
    /// The bytes of the replies in `queue`.
    queued_bytes: usize,
    /// The waiting live frame of each watched recording, by recording id, in the order they were offered.
    live: Vec<(String, Vec<u8>)>,
    closed: bool,
    /// The pipe broke: the client is gone, and nothing more is written or kept.
    broken: bool,
    input_closed: bool,
    dropped: u64,
    in_flight: bool,
}

struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    room: Condvar,
    max_bytes: usize,
}

#[derive(Clone)]
pub struct Replies {
    inner: Arc<Inner>,
    writer: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl Replies {
    /// Starts the thread that writes to `output`.
    pub fn new(output: Box<dyn Write + Send>) -> io::Result<Self> {
        Self::holding(output, QUEUED_REPLY_BYTES)
    }

    fn holding(mut output: Box<dyn Write + Send>, max_bytes: usize) -> io::Result<Self> {
        let inner = Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            room: Condvar::new(),
            max_bytes,
        });
        let writing = Arc::clone(&inner);
        let writer = thread::Builder::new()
            .name("replies".to_owned())
            .spawn(move || writing.write_all(&mut *output))?;
        Ok(Replies {
            inner,
            writer: Arc::new(Mutex::new(Some(writer))),
        })
    }

    /// Queues `reply`. A client that stopped reading is gone; its input closing is what ends the process, so a
    /// broken pipe is not an error here.
    pub fn send(&self, reply: &Reply) {
        self.send_with_payload(reply, &[]);
    }

    pub fn send_with_payload(&self, reply: &Reply, payload: &[u8]) {
        let message = encode_reply(reply, payload);
        let mut state = self.inner.lock();
        let until = Instant::now() + ADMISSION_WAIT;
        // A reply larger than the whole budget still goes once the queue is empty.
        while !state.broken
            && !state.closed
            && (state.queue.len() >= QUEUED_REPLIES
                || (!state.queue.is_empty()
                    && state.queued_bytes + message.len() > self.inner.max_bytes))
        {
            if state.input_closed || state.dropped > 0 || Instant::now() >= until {
                state.dropped += 1;
                return;
            }
            state = match self
                .inner
                .room
                .wait_timeout(state, until.saturating_duration_since(Instant::now()))
            {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        if state.broken || state.closed {
            state.dropped += 1;
            return;
        }
        state.queued_bytes += message.len();
        state.queue.push_back(message);
        drop(state);
        self.inner.changed.notify_all();
    }

    /// Offers a recording's newest live frame, and says whether it replaced one the client had not been sent.
    pub fn offer_live(&self, recording_id: &str, reply: &Reply, payload: &[u8]) -> bool {
        let message = encode_reply(reply, payload);
        let mut state = self.inner.lock();
        if state.broken || state.closed {
            return false;
        }
        let replaced = match state.live.iter_mut().find(|(id, _)| id == recording_id) {
            Some(slot) => {
                slot.1 = message;
                true
            }
            None => {
                state.live.push((recording_id.to_owned(), message));
                false
            }
        };
        drop(state);
        self.inner.changed.notify_all();
        replaced
    }

    /// Takes back a recording's live frame that was not written yet, and says whether there was one.
    pub fn withdraw_live(&self, recording_id: &str) -> bool {
        let mut state = self.inner.lock();
        let before = state.live.len();
        state.live.retain(|(id, _)| id != recording_id);
        before != state.live.len()
    }

    /// Releases any admission wait as soon as EOF or shutdown is known, independently of the command channel.
    pub fn input_closed(&self) {
        self.inner.lock().input_closed = true;
        self.inner.room.notify_all();
    }

    pub fn dropped(&self) -> u64 {
        self.inner.lock().dropped
    }

    /// Drains replies for a bounded interval. A pipe write still blocked then has an unknown delivery outcome;
    /// it is detached so process exit can terminate it, and its reason is reported outside stdout.
    pub fn close(&self) -> ReplyClose {
        let mut state = self.inner.lock();
        state.closed = true;
        state.input_closed = true;
        state.live.clear();
        drop(state);
        self.inner.changed.notify_all();
        self.inner.room.notify_all();
        let writer = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let mut blocked = false;
        if let Some(writer) = writer {
            let until = Instant::now() + WRITER_CLOSE_WAIT;
            while !writer.is_finished() && Instant::now() < until {
                thread::sleep(Duration::from_millis(5));
            }
            if writer.is_finished() {
                let _ = writer.join();
            } else {
                blocked = true;
            }
        }
        let mut state = self.inner.lock();
        let in_flight_unknown = u64::from(blocked && state.in_flight);
        if blocked {
            state.dropped += state.queue.len() as u64;
            state.queue.clear();
            state.queued_bytes = 0;
            state.broken = true;
        }
        ReplyClose {
            replies_dropped: state.dropped,
            writer_blocked: blocked,
            in_flight_unknown,
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_all(&self, output: &mut dyn Write) {
        loop {
            let mut state = self.lock();
            while state.queue.is_empty() && state.live.is_empty() && !state.closed {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            let normal = !state.queue.is_empty();
            let message = match state.queue.pop_front() {
                Some(message) => {
                    state.queued_bytes -= message.len();
                    message
                }
                None if !state.live.is_empty() => state.live.remove(0).1,
                None => return,
            };
            state.in_flight = true;
            drop(state);
            self.room.notify_all();
            if output
                .write_all(&message)
                .and_then(|()| output.flush())
                .is_err()
            {
                let mut state = self.lock();
                state.broken = true;
                state.in_flight = false;
                state.dropped += state.queue.len() as u64 + u64::from(normal);
                state.queue.clear();
                state.queued_bytes = 0;
                state.live.clear();
                drop(state);
                self.room.notify_all();
                return;
            }
            self.lock().in_flight = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Bye, read_envelope};

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("lock").extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn bye(stopped: u64) -> Reply {
        Reply::Bye(Bye {
            stopped,
            replies_dropped: None,
        })
    }

    #[test]
    fn the_writer_stdout_descriptor_is_closed_when_an_encoder_executes() {
        use std::os::fd::AsRawFd;
        let output = stdout_pipe().expect("stdout duplicate");
        // FD_CLOEXEC is the kernel property that prevents a lingering encoder from retaining the media pipe.
        // SAFETY: F_GETFD observes the flags on this live, owned descriptor and does not mutate it.
        let flags = unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0, "descriptor flags are readable");
        assert_ne!(
            flags & libc::FD_CLOEXEC,
            0,
            "an encoder child must never inherit the reply pipe"
        );
    }

    #[test]
    fn replies_are_written_whole_and_in_order() {
        let output = Shared::default();
        let replies = Replies::new(Box::new(output.clone())).expect("starts");
        for stopped in 0..50 {
            replies.send(&bye(stopped));
        }
        replies.close();
        let written = output.0.lock().expect("lock").clone();
        let mut reader = written.as_slice();
        for stopped in 0..50u64 {
            let envelope = read_envelope(&mut reader).expect("a whole reply");
            let value: serde_json::Value = serde_json::from_slice(&envelope.header).expect("json");
            assert_eq!(value["stopped"], stopped);
        }
        assert!(reader.is_empty());
    }

    // A pipe whose reader has not read yet: every write waits until the test opens it.
    #[derive(Clone, Default)]
    struct Gated {
        open: Arc<(Mutex<bool>, Condvar)>,
        writing: Arc<(Mutex<bool>, Condvar)>,
        written: Shared,
    }

    impl Write for Gated {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let (writing, started) = &*self.writing;
            *writing.lock().expect("lock") = true;
            started.notify_all();
            let (open, opened) = &*self.open;
            let mut open = open.lock().expect("lock");
            while !*open {
                open = opened.wait(open).expect("wait");
            }
            self.written.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Gated {
        fn wait_for_write(&self) {
            let (writing, started) = &*self.writing;
            let (writing, _) = started
                .wait_timeout_while(
                    writing.lock().expect("lock"),
                    Duration::from_secs(5),
                    |writing| !*writing,
                )
                .expect("wait");
            assert!(*writing, "the writer reached the blocked pipe");
        }
    }

    fn types(written: &[u8]) -> Vec<String> {
        let mut reader = written;
        let mut seen = Vec::new();
        while let Ok(envelope) = read_envelope(&mut reader) {
            let value: serde_json::Value = serde_json::from_slice(&envelope.header).expect("json");
            seen.push(format!(
                "{}{}",
                value["type"].as_str().unwrap_or(""),
                value["stopped"]
            ));
        }
        seen
    }

    #[test]
    fn a_live_frame_waits_behind_other_replies_and_a_newer_one_replaces_it() {
        let gated = Gated::default();
        let replies = Replies::new(Box::new(gated.clone())).expect("starts");
        // The writer takes the first reply and waits in its write; everything after it queues.
        replies.send(&bye(0));
        gated.wait_for_write();
        assert!(
            !replies.offer_live("r", &bye(100), &[]),
            "the slot was empty"
        );
        assert!(
            replies.offer_live("r", &bye(101), &[]),
            "a newer live frame replaces the waiting one"
        );
        replies.send(&bye(1));
        let (open, opened) = &*gated.open;
        *open.lock().expect("lock") = true;
        opened.notify_all();
        replies.close();
        let written = gated.written.0.lock().expect("lock").clone();
        assert_eq!(
            types(&written),
            ["bye0", "bye1"],
            "close lets a waiting live frame go"
        );
    }

    #[test]
    fn the_newest_waiting_live_frame_is_delivered_with_its_payload() {
        let gated = Gated::default();
        let replies = Replies::new(Box::new(gated.clone())).expect("starts");
        replies.send(&bye(0));
        gated.wait_for_write();
        assert!(!replies.offer_live("r", &bye(100), b"old"));
        assert!(replies.offer_live("r", &bye(101), b"new"));
        replies.send(&bye(1));
        let (open, opened) = &*gated.open;
        *open.lock().expect("lock") = true;
        opened.notify_all();
        let deadline = Instant::now() + Duration::from_secs(5);
        while types(&gated.written.0.lock().expect("lock")).len() < 3 {
            assert!(
                Instant::now() < deadline,
                "the replacement was never written"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        replies.close();
        let written = gated.written.0.lock().expect("lock").clone();
        assert_eq!(types(&written), ["bye0", "bye1", "bye101"]);
        let mut reader = written.as_slice();
        let first = read_envelope(&mut reader).expect("first reply");
        let second = read_envelope(&mut reader).expect("second reply");
        let newest = read_envelope(&mut reader).expect("newest live frame");
        assert!(first.payload.is_empty());
        assert!(second.payload.is_empty());
        assert_eq!(newest.payload, b"new");
        assert!(reader.is_empty());
    }

    #[test]
    fn a_waiting_live_frame_is_written_once_nothing_else_waits() {
        let gated = Gated::default();
        let replies = Replies::new(Box::new(gated.clone())).expect("starts");
        replies.send(&bye(0));
        gated.wait_for_write();
        replies.offer_live("r", &bye(100), &[]);
        replies.send(&bye(1));
        let (open, opened) = &*gated.open;
        *open.lock().expect("lock") = true;
        opened.notify_all();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while types(&gated.written.0.lock().expect("lock")).len() < 3 {
            assert!(
                std::time::Instant::now() < deadline,
                "the live frame was never written"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        replies.close();
        let written = gated.written.0.lock().expect("lock").clone();
        assert_eq!(types(&written), ["bye0", "bye1", "bye100"]);
        assert!(!replies.withdraw_live("r"));
    }

    #[test]
    fn a_sender_waits_once_the_queued_replies_hold_their_bytes() {
        let gated = Gated::default();
        let budget = 4096;
        let replies = Replies::holding(Box::new(gated.clone()), budget).expect("starts");
        // The writer takes the first reply and waits in its write; the next two pass the budget between them.
        replies.send(&bye(0));
        gated.wait_for_write();
        let half = vec![7u8; budget / 2 + 1];
        replies.send_with_payload(&bye(1), &half);
        let sending = {
            let replies = replies.clone();
            let half = half.clone();
            std::thread::spawn(move || replies.send_with_payload(&bye(2), &half))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !sending.is_finished(),
            "a reply past the byte budget was queued while the client read nothing"
        );
        let (open, opened) = &*gated.open;
        *open.lock().expect("lock") = true;
        opened.notify_all();
        sending.join().expect("sent");
        // One reply larger than the whole budget is not held back forever.
        replies.send_with_payload(&bye(3), &vec![1u8; budget * 2]);
        replies.close();
        let written = gated.written.0.lock().expect("lock").clone();
        assert_eq!(types(&written), ["bye0", "bye1", "bye2", "bye3"]);
    }

    #[test]
    fn a_broken_pipe_drops_what_is_queued_and_sending_never_waits() {
        let replies = Replies::new(Box::new(Broken)).expect("starts");
        for stopped in 0..(QUEUED_REPLIES as u64 * 3) {
            replies.send(&bye(stopped));
        }
        replies.close();
    }
}
