# Media client and runner boundary fixes

The [finding-by-finding report](../codex/phase-4/fix-client-runner-report.md) records failing-first evidence, exact commands, counts, log paths and final verification limits.

Replies are bound to the requested recording identity and output. Frame jobs require the requested recording id and interval. A mismatch fails the protocol and leaves unavailable recording evidence with the reason, while preserving the application's outcome. EOF with an unfinished protocol reply is a failure even after a child exit of zero.

The client bounds complete messages, pending requests and its queue of control writes. It drains admitted writes before closing stdin. Frames drop at pressure; refused jobs name the bound. Abandoned starts keep request identity and output within the pending cap. Parser failure discards all retained bytes and stops further consumption.

One setup budget covers discovery, startup and readiness. Shutdown has a cleanup budget and cancellation stops its wait while naming dispatched work whose outcome remains unknown. Late startup processes are closed before use. The run signal stops every running capture source at once. An in-flight screenshot is reconciled and discarded on arrival.

Recording records carry source clock mapping, achieved cadence and latency. Current timestamps are host arrivals, with target paint time unused. Restart cadence includes withheld intervals. These are additive schemaVersion-1 fields; older strict readers refuse records containing them. Recording-off runs with declared secrets still emit withholding events and save no failure screenshot during that stretch.

The real-media client suite passed 32/32 with the original assertions, including frame saturation/finish ordering and owned cleanup. Broad units passed all client/runner checks; four install units remain blocked by another lane's changed Rust manifest and stale pinned source hash. All 11 Chrome recording integration checks and scoped strict TypeScript 6.0.3 and 7.0.2 checks by path passed. Final units passed 245/249; the four unchanged install checks still fail on the stale manifest pin. No benchmark was run and no new platform capability is claimed.
