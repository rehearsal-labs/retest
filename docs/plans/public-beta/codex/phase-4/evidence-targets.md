Lane "evidence-targets": the Phase 4 verification bullets on the real targets. Starts only after the media-process, capture-sources, recording-runner, artifacts-policy and HTML report lanes have landed. Read docs/plans/public-beta/codex/phase-4/common.md first; it binds this lane. Then read those five lanes' records under docs/plans/public-beta/proofs/ ({media,capture-sources,recording,artifacts-policy,html-report}.md) and the Phase 2 and Phase 3 flow records (reference-flow.md, reference-flow-engines.md).

This lane writes tests and a record, not product code. A defect it finds is a finding for the owning lane, with file, line and scenario; it never edits src/** and never edits an assertion to get green.

Deliver tests/integration/evidence-*.test.ts and the record docs/plans/public-beta/proofs/evidence.md, showing on the real targets:
1. A normal pass and an expected assertion failure each produce valid screenshots and a playable recording on all five targets: Chrome, Firefox, WebKit, the iOS simulator and a macOS app. Each file is inspected independently (ffprobe and a whole decode: duration against the test's own time, frame count, frame order, finalization), and a sample of decoded frames is matched to the screen state the timeline says was showing. A file's existence proves nothing.
2. The cross-platform flow with recording on, once with each web engine: evidence from each of the three apps, each recording tied to its app, session and attempt, the timeline of each app laid over its own recording, and the broken-sync variant failing at the desk's check with the evidence showing the stale state.
3. Cancellation, an encoder failure, a media process crash, a capture loss, queue saturation and shutdown each either finalize usable evidence or report incomplete evidence with its reason; no orphan process and no partial file left to block the next run; the application outcome unchanged in every case.
4. Reports name dropped, withheld and missing media and keep the observed outcome; with evidence required, a run with a missing artifact ends with the evidence ending, never quietly; terminal, JSONL and HTML agree on each of these runs.
5. A diagnostics flood stays bounded and sanitized with recording on; AI checks and the HTML report read the same approved evidence references.
6. The pixel policy on a real secret fill: the frames of the withheld stretch are absent from the file (decode and look), the stretch is recorded as withheld, and the secret's pixels appear in no screenshot, thumbnail, frame sequence or report.

Record per target: the capture mode used, the measured cadence, drops and gaps, the artifact paths, and everything that could not be exercised here as unverified with the reason (for example a macOS capture refused by another app's always-on-top window).

Files you own: tests/integration/evidence-*.test.ts (new), docs/plans/public-beta/proofs/evidence.md. Everything runs under the lock; the flows take the desktop and the simulator.
