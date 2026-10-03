# Console and network output in Retest 0.1.0

3 October 2026. Console and network diagnostics are required in Release 1. This document defines their output, capture limits and verification. Follow the [five-phase handoff](release-0.1.0.md) for implementation order. This is a plan, not a claim that current Retest captures these records.

Every result contains diagnostic capture status and links to the captured records. Capture runs for passing and failing tests. JSONL and HTML expose the same data; terminal output shows a bounded summary and artifact location. Rehearsal keeps the diagnostics with its other evidence.

## Browser console and runtime errors

Capture console log, debug, info, warning and error messages from the test-owned page. Preserve other console types when available rather than reclassifying them as errors. Include a bounded, redacted text representation of arguments, timestamp, target/app/session/attempt identity and source URL/line/column when supplied by the engine. Keep uncaught JavaScript exceptions and their available stack frames as a separate runtime-error record.

Subscribe before the first navigation and keep capture active through the attempt's defined end. Record the scope, including whether worker, service-worker or embedded-frame messages are covered. Page diagnostics are the required Release 1 minimum. A backend cannot claim complete worker coverage unless exercised. Do not recursively inspect arbitrary page objects, invoke getters or retain browser object handles just to serialize a message.

## Browser network records

| Record | Required data |
| --- | --- |
| Request | Stable request ID, method, sanitized URL, resource type when available, app/page/frame identity and start time |
| Response | Correlated request ID, HTTP status, safe content-type metadata, response time and available transferred-size/cache information |
| Completion | End time and measured duration, with unavailable timing fields left absent |
| Transport failure | Correlated request ID, cancellation/transport error reason and failure time |
| Redirect | Each visible request/response hop and its relationship to the next hop |
| Interrupted request | Last observed state and an explicit pending/incomplete reason when the test, app or collector ends |

Collect ordinary navigation, fetch/XHR and resource traffic observed within the declared test-owned scope on Chromium, Firefox and WebKit. An HTTP 404 or 500 is a response with that status. It is distinct from a transport failure. This follows the semantics documented in [Playwright's request lifecycle](https://playwright.dev/docs/api/class-request); Retest must retain the distinction in its own drivers.

Record whether requests came from an observed cache or service worker only when the backend supplies that fact. Missing fields do not become zero durations, zero bytes or a claim that a cache was not used. Timing correlation does not prove a particular click caused a request, especially when background traffic overlaps steps.

Release 1 captures metadata. Request/response bodies and unrestricted headers are outside its default contract. Preserve a small declared allowlist of useful safe metadata. Authorization, cookies, Set-Cookie and other secret-bearing headers are excluded. Sanitize URL credentials, queries, fragments and token-bearing paths before writing an event. Apply the existing host secret redactor to console text, errors and stacks before persistence, then cap the sanitized output.

Network observation does not introduce route mocking, network assertions, request/response wait APIs, HAR replay or an API-request fixture. Those remain Release 2. WebSocket message payloads, arbitrary process-wide native traffic capture and transparent TLS interception are also outside 0.1.0.

## Native diagnostics

Native apps do not expose a browser console or browser network domain. Use declared native sources and retain their identity and limits.

The initial native log source is test-owned process output or an app-scoped executor log stream when the selected backend exposes one. Preserve stdout/stderr or supplied severity instead of pretending native lines are JavaScript console messages. An OS log subscription, if used, must be filtered to the owned app/process and tested on the stated platform. Never collect the whole machine's logs.

For native HTTP metadata, provide a typed app-supplied diagnostic source feeding the same sanitized request/response schema. The app emits versioned events through a host-controlled channel with session and request identity. Build this source into the original iOS/macOS fixture apps and verify it on both real targets. The public contract lets a customer supply an equivalent adapter without requiring a proprietary SDK.

That source needs app instrumentation. An arbitrary unmodified native app may have no network source, and its result must say `unavailable` with that reason. Test execution still works; the report cannot suggest it observed traffic it never saw. Instrumented/native and browser diagnostic records share the report timeline, with their provenance visible. Network capture without app changes is a separate future backend decision.

## Limits, outcomes and report behavior

The parent owns collectors. Drivers emit observations into versioned records; the run store writes bounded diagnostic artifacts. A collector never supplies a test verdict or app action. Freeze a capture scope per attempt, with explicit start/end markers, record/byte caps and counters for dropped/truncated data. Scope collectors to test contexts so pooled browsers and file workers cannot mix records from separate tests.

Every target has separate log and network capture states: complete within the declared scope, partial, unavailable or explicitly disabled. Zero captured messages with complete capture is distinguishable from unavailable capture. A buffer overflow or lost subscription marks the data partial and records the count/reason. Crash, cancellation and disconnect preserve the data already captured. Detach listeners during bounded cleanup and do not let pending background requests keep a test alive indefinitely.

Console errors and HTTP error responses are diagnostic observations by default. A test can legitimately exercise either. Do not fail every test merely because one appeared. A declared strict policy can require no matching runtime errors or network failures; the parent enforces that policy independently of generated source. Diagnostic loss has its own evidence status and cannot replace an earlier application failure. A declared required capture policy must keep the result from passing when capture is incomplete.

The HTML report shows searchable console/error entries and a request table with method, sanitized URL, status, duration and failure reason. Selecting an entry relates it to its app and capture time in the action/check timeline. The report handles warnings, truncation and missing capture explicitly, and escapes all app-origin text. Portable relative paths link the machine-readable artifacts from result JSON. Do not dump unrestricted log contents into application logs or terminal output.

AI evaluators may receive an explicitly selected, redacted subset of diagnostics as additional evidence. They do not automatically receive every console line or request. Preserve diagnostic record IDs when the judge cites them. An inference from a log is not evidence of a visible UI result; keep screenshot and state checks when the requirement needs them. See [AI evaluation](ai-evaluation.md).

## Verification and Rehearsal

Use original browser fixtures that emit each required console level, throw an uncaught error, navigate, make successful fetches, return deliberate 404/500 responses, redirect, fail a transport and leave a request pending. Exercise all three engines. Check actual correlation, sanitization and reported scope rather than event counts alone.

Test two simultaneous isolated web contexts and repeated pooled runs. Inject collector disconnect, app crash, cancellation, oversized messages and record overflow. Verify no records cross attempts, no listener survives cleanup and reports distinguish empty from missing data. Include secrets in query strings, headers, messages and stack/source URLs; inspect the saved JSONL/JSON/HTML and any evaluator payload. Expected HTTP errors must not silently become test failures.

Exercise iOS and macOS fixture logs and instrumented request metadata through their declared native sources. Also run a native app without a source and verify the honest unavailable status. The browser matrix and native source matrix form separate support claims.

In Rehearsal, carry diagnostic artifacts through the runner evidence manifest, upload them before discarding sessions, and expose them under the same workspace/discovery access rules and signed-link lifecycle. Do not relay logs through the live frame channel. Keep the worker's durable run recovery and attempt fencing. A late event from a replaced attempt cannot enter the new attempt's records. Verify discovery, passing runs, intended failures and interrupted runs with the pinned Retest candidate.

Measure capture on/off overhead and peak buffer use. Do not promise zero overhead. The release gate requires readable, bounded, correctly scoped diagnostics from every browser and the declared native fixture sources, plus explicit status for missing native sources.
