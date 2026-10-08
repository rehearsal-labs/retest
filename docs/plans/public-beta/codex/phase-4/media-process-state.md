Paused. Nothing of mine is running and I hold no lock (the gate lock belongs to another session's `lockf`, pid 97676).

**What builds:**
- The crate builds. `cargo test` passed three runs in a row: 75 unit and 40 process tests each time (logs `/tmp/retest-media-v2/cargo-all-{1,2,3}.log`).
- `cargo clippy --all-targets -- -D warnings` is clean, with and without the `allocation-counts` feature.
- `src/media/protocol.ts` and `src/media/client.ts` typecheck alone on TypeScript 6 and 7, and so do the four proof files I updated.
- The release binary on disk, `media/target/release/retest-media`, now speaks **protocol 2**.

**Done on both the Rust and client side:**
- **1, identity:** run, attempt, test, app and session ids on every recording; a frame id on every frame; the frame map in `ended`.
- **2, greeting and readiness:** the greeting carries the build identity and the encoder probe's result; a `ready` request answers once the probe ends; a start sent during the probe waits without holding the input loop; a binary of another protocol is refused by name with what to install.
- **3, thumbnails;** **4, frame sequences** with the stretches that had no frame; **5, live view**, where a client that stops reading costs live frames and not the recording.
- **7, queues and endings:** queue statistics, capture gaps and an evidence summary in `ended`; finalizing by copy where hard links are missing, shown only through a debug hook; a `leftovers` command that lists and removes what a lost recording left.
- **8, shutdown:** waiting starts, live views and jobs all get a named answer; kept frames are removed; when the media process dies, the client removes its kept-frames file. The ownership rule is unchanged. I only merged nested `if`s in `process_ownership.rs` because clippy now flags them.

**Half done:**
- **Client tests:** `proofs/media/client.test.ts` is rewritten for protocol 2 with new cases, but has **not been run**. Three of its existing message patterns already failed against the client at HEAD; I updated them to the current wording and kept every process and group assertion.
- **The proof script:** `proofs/media/run.ts` is still on the protocol 1 shapes. `npm run typecheck:proofs` therefore fails there with 17 errors, all a missing `identity` or `frameId`.
- **6, encoded frames:** the encoded route is built and tested with the fake encoder. The comparison against the decoded route has not been measured, so the default is not chosen yet.

**Not started:**
- **9, Linux:** Docker is running, but the existing image is arm64 and has neither Rust nor ffmpeg.
- The media record in `proofs/media.md` and the lane report.

**Broken outside my files** (already sent to you): `src/media/capture.ts` and `tests/unit/media-capture.test.ts` need the new required `identity`, `frameId` and `Ended` fields.

**Next, when resumed:**
1. Fix `run.ts`.
2. Run the client tests and the proof under the lock.
3. Measure the two routes and choose the default.
4. Try Linux x64 in the container, or record it unverified with the reason.
5. Run the remaining gates, then write the record and the report.
