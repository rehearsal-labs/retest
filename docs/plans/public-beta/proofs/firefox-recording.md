# Firefox recording finish budget

Firefox 133.0.3 on this macOS arm64 host captures 1366 by 683 PNGs through the screenshot loop. The recording proof fits them into a 1366 by 682 canvas for H.264. With the media crate's unoptimized development profile, image processing filled the 60-frame queue and left 22 frames unprocessed when the 20000 ms finish deadline expired. The screenshot source stopped at its three-second bound. Withholding was inactive.

An offline release build from a fresh target directory passed the unchanged recording/decode proof, with complete evidence and a 76 ms finish period. Cargo accepted the existing debug binary as current without rebuilding, and its hash stayed unchanged. The failure reproduced without a browser or real codec in the new odd-height PNG process test.

`media/Cargo.toml` now sets development-profile `opt-level = 1`, retaining debug assertions and symbols. The isolated regression then showed every frame, verified readable finalized pixels and exited cleanly. No deadline, queue bound, fitting rule or assertion changed.

The final fixed debug build passed the full capture gates under the shared lock, each once. Firefox passed 5/5 tests and matched all 82 decoded ticker-video frames. Chrome passed 7/7 and matched all 81. WebKit passed 5/5 and matched all 80. Each ticker recording reported complete evidence, zero dropped frames and zero unprocessed frames. Firefox used the host's recorded `launch-services` route.

Run the capture gates with the installed browser builds, Node 24.12, ffmpeg and ffprobe. Build the media binary explicitly before selecting it with `RETEST_MEDIA_BINARY`. The exact offline Homebrew Rust build, test and locked browser commands, hashes, retained PNGs, MP4s, timings, process records and log paths are in [the investigation report](../codex/phase-4/firefox-recording-report.md).

These are measurements on one host. They do not establish behavior on Linux, another architecture or under arbitrary load. `finalizeMs` includes queue drain, encoder exit and file publication; separate filesystem-publication time was not measured. The finish deadline remains mandatory and its slow/stuck finalization tests remain passing.
