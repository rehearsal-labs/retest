Changes by file:

- `src/native/macos-app.ts`: retained the exact system-owner matcher and limited the overlay exclusion to an open runner session. Other covering windows and the pointer still count.
- `src/native/png.ts`: documented the TaskDesk pixel measurement and its limits.
- `tests/unit/native-macos-app.test.ts`: added overlay acceptance, another-owner refusal and disposed-session coverage.
- `tests/unit/native-fake-tools.ts`: added an owned fake window process.
- `tests/integration/native-macos-lifecycle.test.ts`: uses and asserts the requested window frame.
- `docs/plans/public-beta/proofs/native.md`: recorded measurements, checks and the remaining blocker.

Commands and results, with logs under `/tmp/retest-native-overlay/`:

| Command | Result | Log |
|---|---|---|
| `node --conditions=retest-source --test tests/unit/native-macos-app.test.ts` | 27 passed | `unit-macos-app.log` |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` | 202 passed, no skips | `native-unit.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/native-macos-lifecycle.test.ts` | 7 passed | `macos-integration.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source proofs/native/lifecycle.ts --only macos` | 10 steps passed | `macos-proof.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Failed with 18 errors outside the changed files | `typecheck.log` |
| Locked TaskDesk comparison | Completed | `comparison-final.log`, `pixel-comparison.log` |

The full production capture still refuses on this Mac because Wispr Flow overlaps TaskDesk. That window was left alone. The runner PNG and the same TaskDesk window after the runner closed matched all **208,000 pixels** in the static region, with opaque alpha in both. The independent baseline was a native-tool JPEG decoded to RGBA. A larger region also matched all 624,000 decoded pixels between the tool’s captures.

Unverified: an uncovered full production capture, pixels outside those regions, lossless baseline detail at text edges, another Mac and a clean project typecheck. The second compiler and examples check were not reached. No benchmark ran; the fixture service and owned app/runner processes were cleaned up. The preliminary screenshot-tool selection launched TaskDesk outside the lock; that launch was recorded and closed before the comparison.

Every repository file changed:

- `src/native/macos-app.ts`
- `src/native/png.ts`
- `tests/unit/native-macos-app.test.ts`
- `tests/unit/native-fake-tools.ts`
- `tests/integration/native-macos-lifecycle.test.ts`
- `docs/plans/public-beta/proofs/native.md`
- [docs/plans/public-beta/codex/build-native-overlay-report.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/build-native-overlay-report.md)

The report contains the same findings, full commands and log paths.