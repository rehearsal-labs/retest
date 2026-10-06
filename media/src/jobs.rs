//! Thumbnails and frame sequences: image work that answers one request each, on a small pool of workers, so the
//! loop that reads the client's messages never decodes an image itself.
//!
//! The pool has `WORKERS` threads and a queue of `QUEUED_JOBS`; a request that finds the queue full is answered
//! `busy` at once. Every job is bounded by its limits: one image of at most 16384 pixels a side and 256 MiB of
//! decoding for a thumbnail, at most 64 frames for a sequence. A shutdown answers jobs still queued `stopped` and
//! waits for those running.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use crate::frame::{self, FitRequest, ImageFailure, STILL_MAX_DECODE_BYTES, STILL_MAX_SIDE};
use crate::ledger::{Entry, Fate, MAX_MAPPED_FRAMES};
use crate::place::{self, copying_path_of, partial_path_of};
use crate::protocol::{
    ErrorCode, ErrorReply, FrameFormat, FrameSequence, FramesRequest, Omitted, Reply,
    SequenceFrame, Stretch, StretchLosses, Thumbnail, ThumbnailRequest,
};
use crate::recording::RecordingData;
use crate::replies::Replies;

const WORKERS: usize = 2;
const QUEUED_JOBS: usize = 16;
/// How many stretches a frame sequence lists; `stretches_found` counts them all.
const LISTED_STRETCHES: usize = 64;
pub const DEFAULT_SEQUENCE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_SEQUENCE_QUALITY: u8 = 80;
const DEFAULT_THUMBNAIL_QUALITY: u8 = 85;
/// A recording's kept frame may be as large as a recording's frame; a sequence decodes at most 64 of them.
const SEQUENCE_MAX_SIDE: u32 = 16_384;
const SEQUENCE_MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;
/// The most bytes the returned frames may take in a sequence's header, leaving room under the 64 KiB header limit
/// for the rest of it. Three ids of 128 multi-byte characters a frame would carry 64 frames past the limit.
const FRAME_HEADERS_BYTES: usize = 48 * 1024;

pub enum Job {
    Thumbnail(ThumbnailRequest, Vec<u8>),
    Frames(FramesRequest, Arc<RecordingData>),
}

pub struct Jobs {
    sender: Option<SyncSender<Job>>,
    workers: Vec<JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
    /// Thumbnail outputs a job is writing, so a `leftovers` request leaves their `.partial` alone.
    pub thumbnails: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Jobs {
    pub fn start(replies: &Replies) -> Jobs {
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUED_JOBS);
        let receiver = Arc::new(Mutex::new(receiver));
        let stopping = Arc::new(AtomicBool::new(false));
        let thumbnails = Arc::new(Mutex::new(HashSet::new()));
        // A worker that cannot start leaves the others; with none, every job waits in the queue until shutdown
        // answers it `stopped`, and a full queue answers `busy`.
        let workers = (0..WORKERS)
            .filter_map(|index| {
                let receiver = Arc::clone(&receiver);
                let replies = replies.clone();
                let stopping = Arc::clone(&stopping);
                let thumbnails = Arc::clone(&thumbnails);
                thread::Builder::new()
                    .name(format!("jobs {index}"))
                    .spawn(move || work(&receiver, &replies, &stopping, &thumbnails))
                    .ok()
            })
            .collect();
        Jobs {
            sender: Some(sender),
            workers,
            stopping,
            thumbnails,
        }
    }

    /// Queues a job, or hands it back when the queue is full.
    pub fn submit(&self, job: Job) -> Result<(), Box<Job>> {
        match self.sender.as_ref() {
            Some(sender) => sender.try_send(job).map_err(|error| match error {
                TrySendError::Full(job) | TrySendError::Disconnected(job) => Box::new(job),
            }),
            None => Err(Box::new(job)),
        }
    }

    /// Answers queued jobs `stopped`, waits for running ones, and ends the workers.
    pub fn shut_down(&mut self, replies: &Replies) {
        // Running workers may be waiting to queue a reply; shutdown must release that wait before joining them.
        replies.input_closed();
        self.stopping.store(true, Ordering::Release);
        drop(self.sender.take());
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn work(
    receiver: &Mutex<Receiver<Job>>,
    replies: &Replies,
    stopping: &AtomicBool,
    thumbnails: &Mutex<HashSet<PathBuf>>,
) {
    loop {
        let job = {
            let receiver = receiver
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            receiver.recv()
        };
        let Ok(job) = job else {
            return;
        };
        let stopped = stopping.load(Ordering::Acquire);
        let (kind, request_id, recording_id, thumbnail) = match &job {
            Job::Thumbnail(request, _) => (
                "thumbnail",
                request.request_id.clone(),
                None,
                Some(thumbnail_path(request)),
            ),
            Job::Frames(request, _) => (
                "frames",
                request.request_id.clone(),
                Some(request.recording_id.clone()),
                None,
            ),
        };
        // A job that fails inside the process is still answered, so its caller never waits for nothing, and the worker
        // goes on to the next job.
        let answer = panic::catch_unwind(AssertUnwindSafe(|| answer(job, stopped)));
        if let Some(path) = thumbnail {
            thumbnails
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&path);
        }
        match answer {
            Ok(Answer::Thumbnail(reply)) => replies.send(&Reply::Thumbnail(reply)),
            Ok(Answer::Frames(sequence, payload)) => {
                replies.send_with_payload(&Reply::Frames(sequence), &payload);
            }
            Err(failure) => replies.send(&Reply::Error(ErrorReply {
                code: ErrorCode::JobFailed,
                request: Some(kind),
                recording_id,
                request_id: Some(request_id),
                message: format!(
                    "the {kind} request failed inside the media process: {}",
                    panic_message(&*failure)
                ),
            })),
        }
    }
}

enum Answer {
    Thumbnail(Thumbnail),
    Frames(Box<FrameSequence>, Vec<u8>),
}

fn answer(job: Job, stopped: bool) -> Answer {
    fail_if_a_test_asks(&job);
    match job {
        Job::Thumbnail(request, bytes) => Answer::Thumbnail(if stopped {
            thumbnail_status(
                &request,
                "stopped",
                "the media process shut down first".to_owned(),
            )
        } else {
            thumbnail(&request, &bytes)
        }),
        Job::Frames(request, data) => {
            let (sequence, payload) = if stopped {
                (
                    sequence_status(
                        &request,
                        &data,
                        "stopped",
                        "the media process shut down first",
                    ),
                    Vec::new(),
                )
            } else {
                frame_sequence(&request, &data)
            };
            Answer::Frames(Box::new(sequence), payload)
        }
    }
}

// What a panic said, when it said it in words.
fn panic_message(failure: &(dyn std::any::Any + Send)) -> String {
    failure
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| failure.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "it gave no reason".to_owned())
}

// A test sets this to a request id to prove that a job failing inside the process is still answered. Release builds
// have no hook.
#[cfg(debug_assertions)]
fn fail_if_a_test_asks(job: &Job) {
    let request_id = match job {
        Job::Thumbnail(request, _) => &request.request_id,
        Job::Frames(request, _) => &request.request_id,
    };
    if std::env::var("RETEST_MEDIA_TEST_JOB_PANIC").is_ok_and(|asked| &asked == request_id) {
        panic!("RETEST_MEDIA_TEST_JOB_PANIC asked job {request_id} to fail");
    }
}

#[cfg(not(debug_assertions))]
fn fail_if_a_test_asks(_: &Job) {}

/// Answers a job the server could not queue.
pub fn busy(job: Job, replies: &Replies) {
    let message = "the media process has as many images to make as it queues";
    match job {
        Job::Thumbnail(request, _) => replies.send(&Reply::Thumbnail(thumbnail_status(
            &request,
            "busy",
            message.to_owned(),
        ))),
        Job::Frames(request, data) => replies.send(&Reply::Frames(Box::new(sequence_status(
            &request, &data, "busy", message,
        )))),
    }
}

/// The path a thumbnail is written to: its output with the format's extension.
pub fn thumbnail_path(request: &ThumbnailRequest) -> PathBuf {
    let mut path = Path::new(&request.output).as_os_str().to_owned();
    path.push(".");
    path.push(request.format.extension());
    PathBuf::from(path)
}

pub fn thumbnail_status(
    request: &ThumbnailRequest,
    status: &'static str,
    message: String,
) -> Thumbnail {
    Thumbnail {
        request_id: request.request_id.clone(),
        status,
        message,
        path: None,
        width: None,
        height: None,
        source_width: None,
        source_height: None,
        byte_length: None,
        placed_by: None,
    }
}

fn thumbnail(request: &ThumbnailRequest, bytes: &[u8]) -> Thumbnail {
    let path = thumbnail_path(request);
    let partial = partial_path_of(&path);
    let copying = copying_path_of(&path);
    if let Some(taken) = [&path, &partial, &copying]
        .into_iter()
        .find(|taken| taken.symlink_metadata().is_ok())
    {
        return thumbnail_status(
            request,
            "output_in_use",
            format!("a file is already at {}", taken.display()),
        );
    }
    let fit = FitRequest {
        max_width: request.max_width,
        max_height: request.max_height,
        format: request.format,
        quality: request.quality.unwrap_or(DEFAULT_THUMBNAIL_QUALITY),
        max_side: STILL_MAX_SIDE,
        max_decode_bytes: STILL_MAX_DECODE_BYTES,
    };
    let fitted = match frame::fit(bytes, request.source_format, fit) {
        Ok(fitted) => fitted,
        Err(ImageFailure::TooLarge(message)) => {
            return thumbnail_status(request, "too_large", message);
        }
        Err(ImageFailure::Undecodable(message)) => {
            return thumbnail_status(
                request,
                "undecodable",
                format!("the thumbnail image is undecodable: {message}"),
            );
        }
    };
    if let Err(error) = write_new(&partial, &fitted.bytes) {
        let status = if error.kind() == io::ErrorKind::AlreadyExists {
            "output_in_use"
        } else {
            "output_failed"
        };
        return thumbnail_status(
            request,
            status,
            format!(
                "the thumbnail could not be written at {}: {error}",
                partial.display()
            ),
        );
    }
    match place::place(&partial, &path) {
        Ok(placed) => Thumbnail {
            path: Some(path.to_string_lossy().into_owned()),
            width: Some(fitted.width),
            height: Some(fitted.height),
            source_width: Some(fitted.source_width),
            source_height: Some(fitted.source_height),
            byte_length: Some(fitted.bytes.len() as u64),
            placed_by: Some(placed.name()),
            ..thumbnail_status(request, "ok", "the thumbnail is written".to_owned())
        },
        Err(error) => {
            // The `.partial` is this job's own; a thumbnail is cheap to make again, so it is not left behind.
            let _ = fs::remove_file(&partial);
            thumbnail_status(
                request,
                "output_failed",
                format!(
                    "the thumbnail could not be put at {}: {error}",
                    path.display()
                ),
            )
        }
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let written = file.write_all(bytes);
    if written.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
    }
    written
}

/// A frame sequence that returns no frames, with why.
pub fn sequence_status(
    request: &FramesRequest,
    data: &RecordingData,
    status: &'static str,
    message: &str,
) -> FrameSequence {
    FrameSequence {
        request_id: request.request_id.clone(),
        recording_id: request.recording_id.clone(),
        status,
        message: Some(message.to_owned()),
        recording: if data.ended.load(Ordering::Acquire) {
            "ended"
        } else {
            "running"
        },
        from_us: request.from_us,
        to_us: request.to_us,
        stored_through_us: data.stored_through(),
        in_interval: 0,
        available: 0,
        frames: Vec::new(),
        omitted: Omitted::default(),
        stretches: Vec::new(),
        stretches_found: 0,
        capture_gaps_omitted: None,
    }
}

/// The kept frames of a recording whose capture times lie in the request's interval, at most `max_frames` chosen
/// evenly over it, each fitted to the request, with the stretches that had no kept frame.
pub fn frame_sequence(request: &FramesRequest, data: &RecordingData) -> (FrameSequence, Vec<u8>) {
    let Some(store) = data.store.as_ref() else {
        return (
            sequence_status(request, data, "not_kept", "the recording keeps no frames"),
            Vec::new(),
        );
    };
    let reader = match store.reader() {
        Ok(reader) => reader,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return (
                sequence_status(
                    request,
                    data,
                    "released",
                    "the recording's kept frames were removed",
                ),
                Vec::new(),
            );
        }
        Err(error) => {
            return (
                sequence_status(
                    request,
                    data,
                    "store_failed",
                    &format!("the kept frames could not be read: {error}"),
                ),
                Vec::new(),
            );
        }
    };
    let recording = if data.ended.load(Ordering::Acquire) {
        "ended"
    } else {
        "running"
    };
    let (entries, capture_gaps, unlisted_from, gaps_omitted) = {
        let ledger = data.ledger();
        let entries: Vec<Entry> = ledger
            .entries()
            .iter()
            .filter(|entry| (request.from_us..=request.to_us).contains(&entry.capture_us))
            .cloned()
            .collect();
        let gaps: Vec<(u64, u64, String)> = ledger
            .capture_gaps()
            .iter()
            .filter(|gap| gap.from_us <= request.to_us && gap.to_us >= request.from_us)
            .map(|gap| (gap.from_us, gap.to_us, gap.reason.clone()))
            .collect();
        let unlisted_from = ledger
            .first_omitted_us()
            .filter(|from| *from <= request.to_us);
        (
            entries,
            gaps,
            unlisted_from,
            ledger.capture_gaps_omitted(request.from_us, request.to_us),
        )
    };
    let mut available: Vec<&Entry> = entries
        .iter()
        .filter(|entry| entry.stored.is_some())
        .collect();
    available.sort_by_key(|entry| entry.capture_us);
    let times: Vec<u64> = available.iter().map(|entry| entry.capture_us).collect();
    let chosen = choose_evenly(&times, request.from_us, request.to_us, request.max_frames);
    let mut omitted = Omitted {
        by_count: (available.len() - chosen.len()) as u64,
        ..Omitted::default()
    };
    let format = request.format.unwrap_or(FrameFormat::Jpeg);
    let fit = FitRequest {
        max_width: request.max_width,
        max_height: request.max_height,
        format,
        quality: request.quality.unwrap_or(DEFAULT_SEQUENCE_QUALITY),
        max_side: SEQUENCE_MAX_SIDE,
        max_decode_bytes: SEQUENCE_MAX_DECODE_BYTES,
    };
    let max_bytes = request.max_bytes.unwrap_or(DEFAULT_SEQUENCE_BYTES);
    let mut payload = Vec::new();
    let mut frames = Vec::new();
    let mut frame_headers: usize = 0;
    let mut unreadable = false;
    for index in chosen {
        let entry = available[index];
        let Some(stored) = entry.stored else {
            continue;
        };
        let Ok(bytes) = reader.read(stored.offset, stored.length) else {
            unreadable = true;
            omitted.undecodable += 1;
            continue;
        };
        let Ok(fitted) = frame::fit(&bytes, stored.format, fit) else {
            omitted.undecodable += 1;
            continue;
        };
        let frame = SequenceFrame {
            frame_id: entry.frame_id.to_string(),
            action_id: entry.action_id.as_deref().map(str::to_owned),
            observation_id: entry.observation_id.as_deref().map(str::to_owned),
            capture_us: entry.capture_us,
            // A kept frame is taken by the encoder thread; only the ending makes one `unprocessed`, so a frame of an
            // ended recording is never `pending`.
            fate: match entry.fate {
                Fate::Shown => "shown",
                Fate::Superseded => "superseded",
                Fate::Unprocessed => "unprocessed",
                _ => "pending",
            },
            source_width: fitted.source_width,
            source_height: fitted.source_height,
            width: fitted.width,
            height: fitted.height,
            format,
            byte_length: fitted.bytes.len() as u64,
        };
        // Its place in the header's list, with the comma before it.
        let header_bytes = serde_json::to_vec(&frame).map_or(usize::MAX, |bytes| bytes.len() + 1);
        if payload.len() + fitted.bytes.len() > max_bytes
            || frame_headers.saturating_add(header_bytes) > FRAME_HEADERS_BYTES
        {
            omitted.by_bytes += 1;
            continue;
        }
        frame_headers += header_bytes;
        payload.extend_from_slice(&fitted.bytes);
        frames.push(frame);
    }
    let min_gap = request
        .min_gap_us
        .unwrap_or_else(|| 2_000_000 / u64::from(data.fps.max(1)));
    let (listed_stretches, stretches_found) = stretches(&StretchFacts {
        from_us: request.from_us,
        to_us: request.to_us,
        kept: &times,
        entries: &entries,
        capture_gaps: &capture_gaps,
        min_gap_us: min_gap,
        listed: LISTED_STRETCHES,
    });
    let mut message = kept_frames_note(unreadable, store.failure(), unlisted_from);
    if gaps_omitted > 0 {
        let note = format!(
            "{gaps_omitted} capture gaps omitted from the recording's retained list; this interval may overlap them"
        );
        message =
            Some(message.map_or_else(|| note.clone(), |message| format!("{message}; {note}")));
    }
    let sequence = FrameSequence {
        request_id: request.request_id.clone(),
        recording_id: request.recording_id.clone(),
        status: "ok",
        message,
        recording,
        from_us: request.from_us,
        to_us: request.to_us,
        stored_through_us: data.stored_through(),
        in_interval: entries.len() as u64,
        available: available.len() as u64,
        frames,
        omitted,
        stretches: listed_stretches,
        stretches_found,
        capture_gaps_omitted: (gaps_omitted > 0).then_some(gaps_omitted),
    };
    (sequence, payload)
}

// Why the kept frames may lack frames the interval held: some could not be read back, the store stopped taking
// frames after a write failed or it was removed, or the recording had listed as many frames as it lists, so later
// ones are in neither `in_interval` nor any stretch.
fn kept_frames_note(
    unreadable: bool,
    failure: Option<String>,
    unlisted_from: Option<u64>,
) -> Option<String> {
    let mut notes = Vec::new();
    if unreadable {
        notes.push("some kept frames could not be read back".to_owned());
    }
    notes.extend(failure);
    if let Some(from) = unlisted_from {
        notes.push(format!(
            "the recording lists at most {MAX_MAPPED_FRAMES} frames; frames captured from {from} us on were counted in its ending but are neither listed nor kept, so this interval may hold frames it does not name"
        ));
    }
    (!notes.is_empty()).then(|| notes.join("; "))
}

/// Chooses at most `max` of the sorted `times`: all of them when there are no more, otherwise the interval is cut
/// into `max` equal parts and, from each part that holds any, the time nearest its middle is taken. Never repeats
/// a frame and never makes one up.
pub fn choose_evenly(times: &[u64], from_us: u64, to_us: u64, max: usize) -> Vec<usize> {
    if times.len() <= max {
        return (0..times.len()).collect();
    }
    let span = u128::from(to_us.saturating_sub(from_us));
    let parts = max.max(1) as u128;
    let mut chosen = Vec::with_capacity(max);
    for part in 0..parts {
        let low = u128::from(from_us) + span * part / parts;
        let high = u128::from(from_us) + span * (part + 1) / parts;
        let middle = (low + high) / 2;
        let last = part + 1 == parts;
        let nearest = times
            .iter()
            .enumerate()
            .filter(|(_, time)| {
                let time = u128::from(**time);
                time >= low && (time < high || (last && time <= high))
            })
            .min_by_key(|(_, time)| u128::from(**time).abs_diff(middle))
            .map(|(index, _)| index);
        if let Some(index) = nearest {
            chosen.push(index);
        }
    }
    chosen
}

/// What the stretches without a kept frame are worked out from.
pub struct StretchFacts<'a> {
    pub from_us: u64,
    pub to_us: u64,
    /// The capture times of the kept frames in the interval, sorted.
    pub kept: &'a [u64],
    /// Every frame of the recording that reached the process inside the interval.
    pub entries: &'a [Entry],
    pub capture_gaps: &'a [(u64, u64, String)],
    pub min_gap_us: u64,
    /// How many stretches to list; the rest are only counted.
    pub listed: usize,
}

/// The first `listed` stretches of the interval between kept frames, and before the first and after the last, at
/// least `min_gap_us` long or overlapping a known capture gap, with what became of the frames inside each and gaps overlapping
/// it, and how many such stretches there are in all. With no kept frame at all, the whole interval is one stretch,
/// however short. Only listed stretches are searched for losses: with a small `min_gap_us` over a long recording,
/// searching every stretch would cost kept frames times arrived frames.
pub fn stretches(facts: &StretchFacts<'_>) -> (Vec<Stretch>, u64) {
    let mut bounds = Vec::with_capacity(facts.kept.len() + 2);
    bounds.push(facts.from_us);
    bounds.extend_from_slice(facts.kept);
    bounds.push(facts.to_us);
    let nothing_kept = facts.kept.is_empty();
    let pairs = bounds.len() - 1;
    let mut found = Vec::new();
    let mut count = 0u64;
    for (index, pair) in bounds.windows(2).enumerate() {
        let (from_us, to_us) = (pair[0], pair[1]);
        let has_capture_gap = facts
            .capture_gaps
            .iter()
            .any(|(gap_from, gap_to, _)| *gap_from <= to_us && *gap_to >= from_us);
        if !nothing_kept
            && to_us.saturating_sub(from_us) < facts.min_gap_us.max(1)
            && !has_capture_gap
        {
            continue;
        }
        count += 1;
        if found.len() >= facts.listed {
            continue;
        }
        let last = index + 1 == pairs;
        let mut lost = StretchLosses::default();
        for entry in facts.entries.iter().filter(|entry| entry.stored.is_none()) {
            let inside = entry.capture_us >= from_us
                && (entry.capture_us < to_us || (last && entry.capture_us <= to_us));
            if !inside {
                continue;
            }
            match entry.fate {
                Fate::Dropped => lost.dropped += 1,
                Fate::Undecodable => lost.undecodable += 1,
                Fate::OutOfOrder => lost.out_of_order += 1,
                Fate::OutOfRange => lost.out_of_range += 1,
                Fate::Duplicate => lost.duplicate += 1,
                Fate::Queued | Fate::Unprocessed => lost.queued += 1,
                Fate::Taken | Fate::Shown | Fate::Superseded => lost.not_stored += 1,
            }
        }
        let mut reasons: Vec<String> = Vec::new();
        for (gap_from, gap_to, reason) in facts.capture_gaps {
            if *gap_from <= to_us && *gap_to >= from_us && !reasons.contains(reason) {
                reasons.push(reason.clone());
            }
        }
        found.push(Stretch {
            from_us,
            to_us,
            lost,
            capture_gaps: reasons,
        });
    }
    (found, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::Stored;
    use std::sync::Arc as StdArc;

    #[test]
    fn every_frame_is_chosen_when_there_are_few_enough() {
        assert_eq!(choose_evenly(&[1, 2, 3], 0, 10, 5), vec![0, 1, 2]);
    }

    #[test]
    fn more_frames_are_chosen_evenly_over_the_interval_never_twice() {
        // A burst at the start and a few frames later: an even choice by time reaches the later ones too.
        let times: Vec<u64> = (0..50).chain([500, 700, 900]).collect();
        let chosen = choose_evenly(&times, 0, 1000, 4);
        let picked: Vec<u64> = chosen.iter().map(|&index| times[index]).collect();
        // Quarters of the interval, each giving the frame nearest its middle; the second quarter holds none.
        assert_eq!(picked, vec![49, 700, 900]);
        let mut unique = chosen.clone();
        unique.dedup();
        assert_eq!(unique.len(), chosen.len());
    }

    #[test]
    fn empty_parts_give_no_frame_rather_than_a_made_up_one() {
        let times: Vec<u64> = (0..10).collect();
        assert_eq!(
            choose_evenly(&times, 0, 1000, 3).len(),
            1,
            "every frame lies in the first third"
        );
    }

    fn entry(capture_us: u64, fate: Fate, stored: bool) -> Entry {
        Entry {
            frame_id: StdArc::from(format!("f{capture_us}").as_str()),
            action_id: None,
            observation_id: None,
            capture_us,
            fate,
            video_frame: None,
            output_frames: 0,
            stored: stored.then_some(Stored {
                offset: 0,
                length: 1,
                format: FrameFormat::Png,
                width: 1,
                height: 1,
            }),
        }
    }

    #[test]
    fn stretches_name_what_arrived_inside_them_and_the_gaps_the_client_reported() {
        let entries = vec![
            entry(100, Fate::Shown, true),
            entry(200, Fate::Dropped, false),
            entry(300, Fate::Undecodable, false),
            entry(900, Fate::Shown, true),
        ];
        let gaps = vec![(400, 600, "capture_failed".to_owned())];
        let (found, count) = stretches(&StretchFacts {
            from_us: 0,
            to_us: 1000,
            kept: &[100, 900],
            entries: &entries,
            capture_gaps: &gaps,
            min_gap_us: 150,
            listed: LISTED_STRETCHES,
        });
        assert_eq!(count, 1);
        assert_eq!(
            found.len(),
            1,
            "only the long stretch between the kept frames: {found:?}"
        );
        assert_eq!((found[0].from_us, found[0].to_us), (100, 900));
        assert_eq!(
            found[0].lost,
            StretchLosses {
                dropped: 1,
                undecodable: 1,
                ..StretchLosses::default()
            }
        );
        assert_eq!(found[0].capture_gaps, vec!["capture_failed".to_owned()]);
    }

    #[test]
    fn short_capture_gaps_survive_the_quiet_threshold_and_count_when_unlisted() {
        let gaps = vec![(120, 130, "pixels_withheld".to_owned())];
        let facts = StretchFacts {
            from_us: 0,
            to_us: 1000,
            kept: &[100, 150, 900],
            entries: &[],
            capture_gaps: &gaps,
            min_gap_us: 600,
            listed: 1,
        };
        let (found, count) = stretches(&facts);
        assert_eq!(
            count, 2,
            "the short known gap and the long quiet stretch both count"
        );
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].from_us, found[0].to_us), (100, 150));
        assert_eq!(found[0].capture_gaps, vec!["pixels_withheld".to_owned()]);
        let (unlisted, count) = stretches(&StretchFacts { listed: 0, ..facts });
        assert!(unlisted.is_empty());
        assert_eq!(
            count, 2,
            "bounds may omit a known gap from the list, never from the count"
        );
    }

    #[test]
    fn with_nothing_kept_the_whole_interval_is_one_stretch() {
        let entries = vec![entry(5, Fate::Queued, false)];
        let (found, count) = stretches(&StretchFacts {
            from_us: 0,
            to_us: 10,
            kept: &[],
            entries: &entries,
            capture_gaps: &[],
            min_gap_us: 1_000_000,
            listed: LISTED_STRETCHES,
        });
        assert_eq!((found.len(), count), (1, 1));
        assert_eq!(found[0].lost.queued, 1);
    }

    #[test]
    fn stretches_past_the_listed_ones_are_counted_without_searching_their_losses() {
        let kept: Vec<u64> = (1..=200).map(|index| index * 10).collect();
        let entries: Vec<Entry> = kept
            .iter()
            .map(|&at| entry(at, Fate::Shown, true))
            .collect();
        let (found, count) = stretches(&StretchFacts {
            from_us: 0,
            to_us: 2000,
            kept: &kept,
            entries: &entries,
            capture_gaps: &[],
            min_gap_us: 1,
            listed: 3,
        });
        // From 0 to the first kept frame, then between each pair of the 200; the last frame sits at the end.
        assert_eq!(count, 200);
        assert_eq!(
            found
                .iter()
                .map(|stretch| (stretch.from_us, stretch.to_us))
                .collect::<Vec<_>>(),
            vec![(0, 10), (10, 20), (20, 30)]
        );
    }
}
