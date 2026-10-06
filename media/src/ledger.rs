//! What became of each frame of a recording, by its id, and where its bytes were kept.
//!
//! The input reader admits each frame and records frames it refuses; the encoder thread records what it did with
//! each frame it took; the queue's drops and leftovers are recorded where they happen. The ledger answers the frame
//! map in `ended` and the frame sequences asked of a running or ended recording. It holds at most
//! `MAX_MAPPED_FRAMES` frames; later frames are still recorded in the video and counted, but not listed or kept.

use std::collections::HashSet;
use std::sync::Arc;

use crate::protocol::{CaptureGap, FrameFormat, FrameHeader, FrameMapEntry, MAX_LISTED_GAPS};

/// How many frames a recording's ledger lists.
pub const MAX_MAPPED_FRAMES: usize = 200_000;
/// How many capture gaps a recording keeps; later ones are counted only.
const MAX_KEPT_CAPTURE_GAPS: usize = 1024;

/// What became of a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// Waiting in the queue for the encoder thread.
    Queued,
    /// Taken by the encoder thread and on screen, until the next frame or the end says how long.
    Taken,
    Shown,
    Superseded,
    Dropped,
    OutOfOrder,
    OutOfRange,
    Undecodable,
    Duplicate,
    Unprocessed,
}

impl Fate {
    /// The name the frame map gives it. A frame still queued or taken when the ledger is read at the end was never
    /// written, which is what `unprocessed` means.
    pub fn final_name(self) -> &'static str {
        match self {
            Fate::Shown => "shown",
            Fate::Superseded => "superseded",
            Fate::Dropped => "dropped",
            Fate::OutOfOrder => "out_of_order",
            Fate::OutOfRange => "out_of_range",
            Fate::Undecodable => "undecodable",
            Fate::Duplicate => "duplicate",
            Fate::Queued | Fate::Taken | Fate::Unprocessed => "unprocessed",
        }
    }
}

/// Where a frame's bytes are in the frame store, and what they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stored {
    pub offset: u64,
    pub length: u32,
    pub format: FrameFormat,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub frame_id: Arc<str>,
    pub action_id: Option<Box<str>>,
    pub observation_id: Option<Box<str>>,
    pub capture_us: u64,
    pub fate: Fate,
    /// The first video frame showing it, for a shown frame.
    pub video_frame: Option<u64>,
    /// How many video frames show it.
    pub output_frames: u64,
    pub stored: Option<Stored>,
}

/// A recording's ledger.
#[derive(Debug, Default)]
pub struct Ledger {
    entries: Vec<Entry>,
    ids: HashSet<Arc<str>>,
    omitted: u64,
    /// The capture time of the first frame the full ledger did not list.
    first_omitted_us: Option<u64>,
    capture_gaps: Vec<CaptureGap>,
    capture_gaps_reported: u64,
    /// Conservative bounds of all gaps whose details did not fit.
    omitted_gap_bounds: Option<(u64, u64)>,
}

impl Ledger {
    /// Records a frame as it arrives, with `fate`, unless the ledger is full, and returns its place. A frame whose id
    /// the ledger has seen is recorded `Duplicate` whatever `fate` was asked, and the answer says so.
    pub fn admit(&mut self, header: &FrameHeader, fate: Fate) -> Admitted {
        let duplicate = self.ids.contains(header.frame_id.as_str());
        let fate = if duplicate { Fate::Duplicate } else { fate };
        if self.entries.len() >= MAX_MAPPED_FRAMES {
            self.omitted += 1;
            self.first_omitted_us.get_or_insert(header.timestamp_us);
            return Admitted {
                place: None,
                duplicate,
            };
        }
        let frame_id: Arc<str> = Arc::from(header.frame_id.as_str());
        if !duplicate {
            self.ids.insert(Arc::clone(&frame_id));
        }
        self.entries.push(Entry {
            frame_id,
            action_id: header.action_id.as_deref().map(Box::from),
            observation_id: header.observation_id.as_deref().map(Box::from),
            capture_us: header.timestamp_us,
            fate,
            video_frame: None,
            output_frames: 0,
            stored: None,
        });
        Admitted {
            place: Some(self.entries.len() - 1),
            duplicate,
        }
    }

    /// Takes back the frame just admitted at `place`, when it was not taken after all.
    pub fn retract(&mut self, place: Option<usize>) {
        let Some(place) = place else {
            return;
        };
        if place + 1 != self.entries.len() {
            return;
        }
        if let Some(entry) = self.entries.pop()
            && entry.fate != Fate::Duplicate
        {
            self.ids.remove(&entry.frame_id);
        }
    }

    pub fn set_fate(&mut self, place: Option<usize>, fate: Fate) {
        if let Some(entry) = place.and_then(|place| self.entries.get_mut(place)) {
            entry.fate = fate;
        }
    }

    /// Marks a frame shown from `video_frame` for `output_frames` frames.
    pub fn show(&mut self, place: Option<usize>, video_frame: u64, output_frames: u64) {
        if let Some(entry) = place.and_then(|place| self.entries.get_mut(place)) {
            entry.fate = Fate::Shown;
            entry.video_frame = Some(video_frame);
            entry.output_frames = output_frames;
        }
    }

    pub fn keep(&mut self, place: Option<usize>, stored: Stored) {
        if let Some(entry) = place.and_then(|place| self.entries.get_mut(place)) {
            entry.stored = Some(stored);
        }
    }

    pub fn note_capture_gap(&mut self, gap: CaptureGap) {
        self.capture_gaps_reported += 1;
        if self.capture_gaps.len() < MAX_KEPT_CAPTURE_GAPS {
            self.capture_gaps.push(gap);
        } else {
            self.omitted_gap_bounds = Some(match self.omitted_gap_bounds {
                Some((from, to)) => (from.min(gap.from_us), to.max(gap.to_us)),
                None => (gap.from_us, gap.to_us),
            });
        }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn capture_gaps(&self) -> &[CaptureGap] {
        &self.capture_gaps
    }

    /// Counts omitted gap details if this interval may overlap any of them. The count is across the recording,
    /// since the bounded ledger cannot assign each omitted gap to an interval.
    pub fn capture_gaps_omitted(&self, from_us: u64, to_us: u64) -> u64 {
        if self
            .omitted_gap_bounds
            .is_some_and(|(from, to)| from <= to_us && to >= from_us)
        {
            self.capture_gaps_reported - self.capture_gaps.len() as u64
        } else {
            0
        }
    }

    /// The capture gaps an `ended` lists, and how many were reported in all.
    pub fn listed_capture_gaps(&self) -> (Vec<CaptureGap>, u64) {
        let listed = self
            .capture_gaps
            .iter()
            .take(MAX_LISTED_GAPS)
            .cloned()
            .collect();
        (listed, self.capture_gaps_reported)
    }

    pub fn omitted(&self) -> u64 {
        self.omitted
    }

    /// From what capture time on frames arrived that the ledger could not list, if any did.
    pub fn first_omitted_us(&self) -> Option<u64> {
        self.first_omitted_us
    }

    /// The frame map as `ended` carries it: a JSON array, one entry per listed frame, in the order frames arrived,
    /// no longer than `max_bytes`. Ids of up to 128 characters, four bytes each, can make 200 000 entries larger than a
    /// reply's payload may be, so the map stops at the first entry that would pass `max_bytes` and counts the rest.
    pub fn frame_map(&self, fps: u32, max_bytes: usize) -> FrameMap {
        let fps = u64::from(fps.max(1));
        let mut json = b"[".to_vec();
        let mut listed = 0u64;
        for entry in &self.entries {
            let shown = entry.fate == Fate::Shown;
            let mapped = FrameMapEntry {
                frame_id: &entry.frame_id,
                capture_us: entry.capture_us,
                fate: entry.fate.final_name(),
                video_us: entry
                    .video_frame
                    .filter(|_| shown)
                    .map(|frame| frame.saturating_mul(1_000_000) / fps),
                output_frames: shown.then_some(entry.output_frames),
            };
            let Ok(bytes) = serde_json::to_vec(&mapped) else {
                break;
            };
            // The separator before it and the closing bracket after it must fit too.
            if json.len() + usize::from(listed > 0) + bytes.len() + 1 > max_bytes {
                break;
            }
            if listed > 0 {
                json.push(b',');
            }
            json.extend_from_slice(&bytes);
            listed += 1;
        }
        json.push(b']');
        FrameMap {
            cut: self.entries.len() as u64 - listed,
            json,
            listed,
        }
    }
}

/// A frame map as `ended` carries it: the JSON, how many entries it lists, and how many listed frames it left out
/// to stay within its size.
#[derive(Debug)]
pub struct FrameMap {
    pub json: Vec<u8>,
    pub listed: u64,
    pub cut: u64,
}

/// Where an arriving frame was recorded, and whether its id had been seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admitted {
    pub place: Option<usize>,
    pub duplicate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(frame_id: &str, timestamp_us: u64) -> FrameHeader {
        FrameHeader {
            recording_id: "r".into(),
            frame_id: frame_id.into(),
            action_id: Some("a1".into()),
            observation_id: None,
            timestamp_us,
            format: FrameFormat::Png,
        }
    }

    #[test]
    fn a_reused_id_is_a_duplicate() {
        let mut ledger = Ledger::default();
        let first = ledger.admit(&header("f1", 0), Fate::Queued);
        let again = ledger.admit(&header("f1", 10), Fate::Queued);
        assert_eq!(
            first,
            Admitted {
                place: Some(0),
                duplicate: false
            }
        );
        assert_eq!(
            again,
            Admitted {
                place: Some(1),
                duplicate: true
            }
        );
        assert_eq!(ledger.entries()[1].fate, Fate::Duplicate);
    }

    #[test]
    fn the_frame_map_names_each_frame_and_where_it_is_in_the_video() {
        let mut ledger = Ledger::default();
        let shown = ledger.admit(&header("f1", 1_000), Fate::Queued).place;
        let superseded = ledger.admit(&header("f2", 1_010), Fate::Queued).place;
        let dropped = ledger.admit(&header("f3", 1_020), Fate::Queued).place;
        let waiting = ledger.admit(&header("f4", 1_030), Fate::Queued).place;
        ledger.show(shown, 3, 2);
        ledger.set_fate(superseded, Fate::Superseded);
        ledger.set_fate(dropped, Fate::Dropped);
        ledger.set_fate(waiting, Fate::Taken);
        let map = ledger.frame_map(10, usize::MAX);
        assert_eq!((map.listed, map.cut), (4, 0));
        let value: serde_json::Value = serde_json::from_slice(&map.json).expect("json");
        assert_eq!(
            value,
            serde_json::json!([
                { "frameId": "f1", "captureUs": 1000, "fate": "shown", "videoUs": 300_000, "outputFrames": 2 },
                { "frameId": "f2", "captureUs": 1010, "fate": "superseded" },
                { "frameId": "f3", "captureUs": 1020, "fate": "dropped" },
                { "frameId": "f4", "captureUs": 1030, "fate": "unprocessed" },
            ])
        );
    }

    #[test]
    fn a_frame_map_that_would_pass_its_size_lists_what_fits_and_counts_the_rest() {
        let mut ledger = Ledger::default();
        // Ids of 128 four-byte characters: 200 000 of them would make a map larger than the 64 MiB a reply may carry.
        let long = "𝄞".repeat(127);
        for index in 0..10u64 {
            ledger.admit(&header(&format!("{index}{long}"), index), Fate::Queued);
        }
        let whole = ledger.frame_map(10, usize::MAX);
        assert_eq!((whole.listed, whole.cut), (10, 0));
        let limit = whole.json.len() / 2;
        let cut = ledger.frame_map(10, limit);
        assert!(cut.json.len() <= limit, "{} bytes", cut.json.len());
        assert!(cut.listed > 0 && cut.listed < 10, "{} listed", cut.listed);
        assert_eq!(cut.listed + cut.cut, 10);
        let value: Vec<serde_json::Value> = serde_json::from_slice(&cut.json).expect("json");
        assert_eq!(value.len() as u64, cut.listed);
        assert_eq!(
            value[0]["frameId"],
            format!("0{long}"),
            "the first frames to arrive are the ones listed"
        );
        let none = ledger.frame_map(10, 2);
        assert_eq!(
            (none.json.as_slice(), none.listed, none.cut),
            (&b"[]"[..], 0, 10)
        );
    }

    #[test]
    fn a_full_ledger_counts_later_frames_and_says_from_when() {
        let mut ledger = Ledger::default();
        for index in 0..MAX_MAPPED_FRAMES as u64 {
            ledger.admit(&header(&index.to_string(), index), Fate::Queued);
        }
        assert_eq!(ledger.first_omitted_us(), None);
        let past = ledger.admit(&header("past", 5_000_000), Fate::Queued);
        ledger.admit(&header("later", 6_000_000), Fate::Queued);
        assert_eq!(past.place, None);
        assert_eq!(ledger.omitted(), 2);
        assert_eq!(ledger.first_omitted_us(), Some(5_000_000));
    }

    #[test]
    fn omitted_capture_gap_bounds_include_out_of_order_reports_and_exclude_disjoint_intervals() {
        let mut ledger = Ledger::default();
        for index in 0..MAX_KEPT_CAPTURE_GAPS as u64 {
            ledger.note_capture_gap(CaptureGap {
                from_us: index,
                to_us: index + 1,
                reason: "capture_failed".into(),
            });
        }
        ledger.note_capture_gap(CaptureGap {
            from_us: 3_000,
            to_us: 3_100,
            reason: "capture_failed".into(),
        });
        ledger.note_capture_gap(CaptureGap {
            from_us: 2_000,
            to_us: 2_100,
            reason: "pixels_withheld".into(),
        });
        assert_eq!(ledger.capture_gaps_omitted(2_000, 2_100), 2);
        assert_eq!(ledger.capture_gaps_omitted(3_000, 3_100), 2);
        assert_eq!(ledger.capture_gaps_omitted(0, 1_999), 0);
        assert_eq!(ledger.capture_gaps_omitted(3_101, 4_000), 0);
        assert_eq!(
            ledger.capture_gaps_omitted(2_500, 2_600),
            2,
            "the count is conservative because individual details were omitted"
        );
    }

    #[test]
    fn capture_gaps_are_kept_to_a_bound_and_counted() {
        let mut ledger = Ledger::default();
        for index in 0..(MAX_KEPT_CAPTURE_GAPS as u64 + 5) {
            ledger.note_capture_gap(CaptureGap {
                from_us: index,
                to_us: index + 1,
                reason: "capture_failed".into(),
            });
        }
        let (listed, reported) = ledger.listed_capture_gaps();
        assert_eq!(
            (listed.len(), reported),
            (MAX_LISTED_GAPS, MAX_KEPT_CAPTURE_GAPS as u64 + 5)
        );
        assert_eq!(ledger.capture_gaps().len(), MAX_KEPT_CAPTURE_GAPS);
    }
}
