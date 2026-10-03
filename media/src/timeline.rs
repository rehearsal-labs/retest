//! Places timestamped frames on a constant-rate video.
//!
//! Captures arrive whenever the page could be read, never on a fixed beat, while a video shows one frame per
//! tick. Each frame stays on screen from its own moment until the next frame's, as Playwright's recorder does,
//! so the video keeps the timing of the capture. Time zero is the first frame's timestamp; a frame's moment is
//! its timestamp rounded to the nearest tick. A pause longer than the maximum gap is shortened to it, so one
//! long wait, or a frame stamped on another clock, cannot make the video hold one frame for hours; every
//! shortening is reported so video time still maps back to the capture clock.

/// Where a new frame goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    /// The first frame: it starts the video.
    First,
    /// The new frame falls on the same tick as the frame on screen and replaces it.
    Supersedes,
    /// The frame on screen fills `repeat` ticks, then the new frame takes over.
    Advances { repeat: u64 },
}

#[derive(Debug)]
pub struct Timeline {
    fps: u64,
    max_gap_us: u64,
    origin_us: Option<u64>,
    last_us: u64,
    // Capture time taken out of the video by shortened gaps so far.
    shortened_us: u64,
    // The tick of the frame on screen, which is not yet written.
    held_tick: u64,
}

impl Timeline {
    pub fn new(fps: u32, max_gap_us: u64) -> Self {
        Timeline {
            fps: u64::from(fps.max(1)),
            max_gap_us,
            origin_us: None,
            last_us: 0,
            shortened_us: 0,
            held_tick: 0,
        }
    }

    /// Places a frame, and says by how much the pause before it was shortened, zero when it was not. Timestamps
    /// must not go backwards; the caller refuses one that does.
    pub fn place(&mut self, timestamp_us: u64) -> (Placement, u64) {
        if self.origin_us.is_none() {
            self.origin_us = Some(timestamp_us);
            self.last_us = timestamp_us;
            self.held_tick = 0;
            return (Placement::First, 0);
        }
        let shortened = timestamp_us
            .saturating_sub(self.last_us)
            .saturating_sub(self.max_gap_us);
        self.shortened_us += shortened;
        self.last_us = timestamp_us;
        let tick = self.tick(timestamp_us);
        if tick <= self.held_tick {
            return (Placement::Supersedes, shortened);
        }
        let repeat = tick - self.held_tick;
        self.held_tick = tick;
        (Placement::Advances { repeat }, shortened)
    }

    /// How many ticks the last frame fills: until `end_timestamp_us` when it is later, and at least one, with the
    /// end moved back to `limit_us` or the maximum gap after the last frame, whichever is earlier. Says whether
    /// it was moved. Zero ticks when no frame was placed.
    pub fn finish(&self, end_timestamp_us: Option<u64>, limit_us: u64) -> (u64, bool) {
        if self.origin_us.is_none() {
            return (0, false);
        }
        let Some(end) = end_timestamp_us else {
            return (1, false);
        };
        let latest = limit_us.min(self.last_us.saturating_add(self.max_gap_us));
        let clipped = end > latest;
        let end_tick = self.tick(end.min(latest));
        (end_tick.saturating_sub(self.held_tick).max(1), clipped)
    }

    /// The first frame's timestamp: video time zero.
    pub fn origin_us(&self) -> Option<u64> {
        self.origin_us
    }

    /// The length of `frames` ticks in microseconds.
    pub fn duration_us(&self, frames: u64) -> u64 {
        let micros = u128::from(frames) * 1_000_000 / u128::from(self.fps);
        u64::try_from(micros).unwrap_or(u64::MAX)
    }

    /// The most ticks a recording of `duration_us` can fill: every tick it covers, and the last frame's own.
    pub fn ticks_within(&self, duration_us: u64) -> u64 {
        let ticks = u128::from(duration_us) * u128::from(self.fps) / 1_000_000;
        u64::try_from(ticks).unwrap_or(u64::MAX).saturating_add(1)
    }

    fn tick(&self, timestamp_us: u64) -> u64 {
        let origin = self.origin_us.unwrap_or(timestamp_us);
        let elapsed = u128::from(
            timestamp_us
                .saturating_sub(origin)
                .saturating_sub(self.shortened_us),
        );
        let tick = (elapsed * u128::from(self.fps) + 500_000) / 1_000_000;
        u64::try_from(tick).unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_LIMIT: u64 = u64::MAX;

    #[test]
    fn each_frame_holds_until_the_next_one() {
        let mut timeline = Timeline::new(10, 10_000_000);
        assert_eq!(timeline.place(1_000_000), (Placement::First, 0));
        assert_eq!(
            timeline.place(1_100_000),
            (Placement::Advances { repeat: 1 }, 0)
        );
        assert_eq!(
            timeline.place(1_400_000),
            (Placement::Advances { repeat: 3 }, 0)
        );
        assert_eq!(timeline.finish(None, NO_LIMIT), (1, false));
        assert_eq!(timeline.origin_us(), Some(1_000_000));
    }

    #[test]
    fn a_frame_on_the_same_tick_replaces_the_one_on_screen() {
        let mut timeline = Timeline::new(10, 10_000_000);
        timeline.place(0);
        assert_eq!(timeline.place(40_000), (Placement::Supersedes, 0));
        assert_eq!(
            timeline.place(60_000),
            (Placement::Advances { repeat: 1 }, 0)
        );
        assert_eq!(timeline.place(140_000), (Placement::Supersedes, 0));
    }

    #[test]
    fn the_last_frame_stays_until_the_end_timestamp() {
        let mut timeline = Timeline::new(30, 10_000_000);
        timeline.place(0);
        timeline.place(2_000_000);
        assert_eq!(timeline.finish(Some(3_000_000), NO_LIMIT), (30, false));
        assert_eq!(timeline.finish(Some(1_000_000), NO_LIMIT), (1, false));
        assert_eq!(timeline.duration_us(90), 3_000_000);
    }

    #[test]
    fn a_long_pause_is_shortened_to_the_maximum_gap() {
        let mut timeline = Timeline::new(10, 1_000_000);
        timeline.place(0);
        // Five seconds after the first frame, on a timeline whose longest gap is one second.
        assert_eq!(
            timeline.place(5_000_000),
            (Placement::Advances { repeat: 10 }, 4_000_000)
        );
        // Later frames keep their spacing from there.
        assert_eq!(
            timeline.place(5_300_000),
            (Placement::Advances { repeat: 3 }, 0)
        );
    }

    #[test]
    fn a_frame_on_another_clock_holds_the_last_frame_for_the_maximum_gap_only() {
        let mut timeline = Timeline::new(30, 10_000_000);
        timeline.place(0);
        let (placement, shortened) = timeline.place(1_759_000_000_000_000);
        assert_eq!(placement, Placement::Advances { repeat: 300 });
        assert_eq!(shortened, 1_759_000_000_000_000 - 10_000_000);
    }

    #[test]
    fn the_end_is_clipped_to_the_limit_and_to_the_gap_after_the_last_frame() {
        let mut timeline = Timeline::new(10, 1_000_000);
        timeline.place(0);
        assert_eq!(timeline.finish(Some(60_000_000), NO_LIMIT), (10, true));
        assert_eq!(timeline.finish(Some(60_000_000), 500_000), (5, true));
        assert_eq!(timeline.finish(Some(800_000), NO_LIMIT), (8, false));
    }

    #[test]
    fn ninety_frames_a_thirtieth_apart_make_ninety_ticks() {
        let mut timeline = Timeline::new(30, 10_000_000);
        let mut ticks = 0;
        for index in 0..90u64 {
            match timeline.place(5_000_000 + index * 1_000_000 / 30).0 {
                Placement::First => {}
                Placement::Advances { repeat } => ticks += repeat,
                Placement::Supersedes => panic!("frame {index} superseded"),
            }
        }
        ticks += timeline.finish(None, NO_LIMIT).0;
        assert_eq!(ticks, 90);
        assert_eq!(timeline.ticks_within(3_000_000), 91);
    }

    #[test]
    fn an_empty_timeline_has_nothing_to_finish() {
        assert_eq!(Timeline::new(30, 1).finish(Some(10), NO_LIMIT), (0, false));
    }
}
