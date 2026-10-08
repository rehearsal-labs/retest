I've paused. Nothing of mine is running and I'm not holding the gate lock. The last full typecheck of my files was stopped while it waited for the lock, so they are not type-checked yet. I have only confirmed that each edited file parses.

**Done:**
- **D-12:** `src/diagnostics/session-capture.ts` now classifies an unreadable event by the kind of record it feeds, using a table of each engine's event names. An event name it doesn't know marks both kinds partial. New unit cases cover Chrome's `Page.frameDetached` and an unknown name. Both pass.
- **D-7:** in `tests/unit/diagnostics-engines.test.ts`, the cannot-start case now asserts that a collector was made and holds no listener. The listener count is checked after a lost connection and after stop, on all three engines. The unit file passes 31 of 32.
- **D-8:** the same unit file asserts the time on a message. It fails on WebKit only, which puts its own clock on a message WebKit sent without a timestamp. That failure is the WebKit collector finding, as intended.

**Edited but never run:**
- **D-1, D-2, D-3, D-5, D-6, D-11** are all in `tests/integration/diagnostics-engines.test.ts`:
  - each page area is its own subtest; a frame or worker record must carry its true label, and the scope must agree with what was captured;
  - exact `pending === 1`, exact page fetch counts, the exact four-argument message text and the `dir` getter text;
  - the secret checks now require a record holding `{{token}}`, one holding `{{password}}` from the object, and the Chrome case's other positive checks;
  - a strict-policy case and a deliberately failing test now run on every engine;
  - the stopped run asserts the network state and the pooled runs assert the console state.
- **D-9:** each live gate in `tests/integration/evaluation-ai-sdk.test.ts`, Azure included, now has a screenshot check with a false requirement that must come back `fail`.

**Not started:**
- **D-4:** rewrite the guide's "Per engine" section and the record so they name exactly what ran per engine, and call the Firefox getter an open driver defect whose cause was not traced.
- **D-10:** goes to the WebKit fix lane; I only need to drop "Honest" from finding 8 in the record.
- **D-13:** correct "5 of its 13 checks" and the claim that the fake judge got the same bytes (it is compared by size and dimensions only).
- The "After the review" section of my report.

**Next:**
1. Run the scoped typecheck under the lock.
2. Run Chrome to green and fix any assertion I generalised wrongly there.
3. Run WebKit and Firefox and list each new failing assertion as a driver finding: engine, assertion, and what the engine actually sent.
4. Then D-4, D-10, D-13 and the report section.
