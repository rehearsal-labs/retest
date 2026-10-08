# Browser archive pins and Linux checks

This pass uses only the founder-authorized browser archives, Rust image and crates. No benchmark runs here. Existing executable, file and licence pins stay unchanged when bytes differ. Logs are under `.retest/pin-checksums/`; exact helper source is retained in `execution-scripts.log`. Linux build output is under `.retest/linux-build/`.

The initial table has no Linux Firefox or WebKit pin. Their authorized archives are recorded separately, without a Linux browser execution claim.

## Current result

All six authorized publisher archives were downloaded once, measured, compared and deleted. Their total size was 812,121,829 bytes. Every existing Mac executable, pinned-file and licence checksum matched; no mismatch was overwritten. The four existing browser archive pins now have measured sizes and SHA-256 values. Linux Firefox and WebKit remain archive observations beside the source pin table because neither has an implemented Retest pin.

| Check | Result | Evidence |
| --- | --- | --- |
| Current Mac install, list, verify, repeat and doctor, all three browsers | all 15 CLI commands exit 0; each archive requested once from the local mirror; records match pins | `.retest/pin-checksums/mac-current/` |
| Required nine WebKit notices in install output | failed: 0 of 9 after concurrent CLI output changes; separate proof exit 1 | `mac-current/results.json`, `webkit-install.log` |
| Linux GNU x64 release build | passed; 1,630,000 bytes, SHA-256 `4fb5a0a9945010e6c8f50cdae099450f51d6741e53ab745fb83a99074af7664a` | `.retest/linux-build/logs/cargo-build-release.log` |
| Linux full Cargo test | failed: 97 unit cases passed, 1 failed; process target not executed by Cargo after that failure | `cargo-test.log`, exit 101 |
| Linux compiled process-test target, unchanged, default parallel mode | failed: 51 passed, 4 failed, none ignored or filtered | `process-target.log`, exit 101 |
| Linux install lock, regular-file reader and live `/proc` start reading | passed: 28 passed, none failed, one existing macOS-only skip | `node-unit-tests.log`, exit 0 |
| Host builds unit files | 101 passed, none failed or skipped | `.retest/pin-checksums/units-all-builds.log` |
| Owner-updated CLI install unit file | 12 passed, none failed or skipped | `.retest/pin-checksums/cli-install-owner-update.log` |
| Typecheck | passed both installed TypeScript versions and the example | `.retest/pin-checksums/typecheck-final.log`, exit 0 |
| Cleanup | six original archives and temporary app/Node copies deleted; all three containers removed; no recorded task process remains | `.retest/pin-checksums/cleanup-final.json`, `.retest/linux-build/logs/removed-containers-final.json` |

The Linux runs used Docker amd64 emulation on this arm64 Mac. Real Linux encoding, a physical x64 host, Linux browser installation, a real wall-clock step, cross-namespace lock contention and power-loss durability remain unverified. No ffmpeg, ffprobe, npm package or extra browser archive was downloaded. The Rust image lacked Node, so the explicitly authorized official Node fallback supplied its binary to the same Rust container for the requested unit tests. No benchmark ran, no other builder's process was ended, and no commit or publication was made.

The WebKit terminal-output requirement is unresolved within this lane's file ownership. The other builder's short-message and no-hash assertions are preserved in the shared integration file; the separate current proof still requires all nine notices and reports failure. Its earlier 16/16 integration pass belongs to the tree before those concurrent changes. The original brief remains the requirement until the founder answers the pending clarification.

## Publisher downloads

### chromium, mac-arm64

Address: `https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip`. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/chromium-mac-arm64-chrome-mac-arm64.zip`. Size: 190970181 bytes. SHA-256: `930e2a2c15addbaca1fe9b07bfa520667bced556d7988707186819cb4279ef3b`. Download exit 0. Command and publisher redirect are in `.retest/pin-checksums/download-chromium-mac-arm64.log`.

### chromium, linux-x64

Address: `https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/linux64/chrome-linux64.zip`. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/chromium-linux-x64-chrome-linux64.zip`. Size: 195836009 bytes. SHA-256: `8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a`. Download exit 0. Command and publisher redirect are in `.retest/pin-checksums/download-chromium-linux-x64.log`.

### firefox, mac-arm64

Address: `https://archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg`. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/firefox-mac-arm64-Firefox 133.0.3.dmg`. Size: 154008053 bytes. SHA-256: `9ceb4fa2120228f287e6c654cef7898b4cce0a659270056276b8884581267d3b`. Download exit 0. Command and publisher redirect are in `.retest/pin-checksums/download-firefox-mac-arm64.log`.

### webkit, mac-arm64

Address: `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip`. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/webkit-mac-arm64-webkit-mac-26-arm64.zip`. Size: 81853194 bytes. SHA-256: `f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7`. Download exit 0. Command and publisher redirect are in `.retest/pin-checksums/download-webkit-mac-arm64.log`.

### firefox, linux-x64

Address: `https://archive.mozilla.org/pub/firefox/releases/133.0.3/linux-x86_64/en-US/firefox-133.0.3.tar.bz2`. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/firefox-linux-x64-firefox-133.0.3.tar.bz2`. Size: 89495132 bytes. SHA-256: `43713e238d0153fdbf1ab46dd76c6b01ab83fae197b5dc3a95087f51907ba44d`. Download exit 0. Command and publisher redirect are in `.retest/pin-checksums/download-firefox-linux-x64.log`.

### WebKit, Linux x64

Address: `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-debian-13.zip`. This is Playwright's Debian 13 x64 archive name, read from the cached publisher registry. There was no Linux WebKit pin to compare. Cache file: `/Users/dragon/Library/Caches/retest-proofs/downloads/webkit-linux-x64-webkit-debian-13.zip`. Download exit 0. Size: 99959260 bytes. SHA-256: `6c402e84b829a5f0bdee7c86dd0725a21ace8801340542d6422deb0f3a40c4eb`. Exact command and publisher redirect: `.retest/pin-checksums/download-webkit-linux-x64.log`.

## Checks inside chromium, mac-arm64

| Kind | Path | Existing SHA-256 | Observed SHA-256 | Comparison |
| --- | --- | --- | --- | --- |
| executable | `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` | `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a` | `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a` | matches |
| published licence | `chrome-mac-arm64/ABOUT` | `34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb` | `34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb` | matches |
| published licence | `chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/153.0.8010.12/Libraries/WidevineCdm/LICENSE` | `20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386` | `20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386` | matches |

## Checks inside chromium, linux-x64

| Kind | Path | Existing SHA-256 | Observed SHA-256 | Comparison |
| --- | --- | --- | --- | --- |
| executable | `chrome-linux64/chrome` | not pinned | `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e` | first observation |
| newly inspected licence | `chrome-linux64/ABOUT` | not pinned | `34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb` | first observation |
| newly inspected licence | `chrome-linux64/WidevineCdm/LICENSE` | not pinned | `20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386` | first observation |

Gate command `node .retest/pin-checksums/compare.mjs`: attempt 1, exit 1, log `.retest/pin-checksums/comparison-1.log`.

## Firefox disk-image mapping and failed installer unpack

The real image holds a top-level `Firefox.app`. The pin mapping `{ format: "dmg", app: "Firefox.app" }` and executable `Firefox.app/Contents/MacOS/firefox` are correct. A direct system attach, `ditto` copy and detach succeeded, recorded in `.retest/pin-checksums/firefox-image-probe.log`. The installed app comparison uses that direct copy.

The earlier `unpackArchive` failed after a successful attach: no app was present at the mount when it checked. The cause was not established. Its detach then reported no such path. This is retained as a finding in `.retest/pin-checksums/comparison-1.log`, not a successful install. The process helper reconciles recorded descendants; whether that explains the image helper lifetime is unverified. No unpacker or process-ownership code was changed.

## Checks inside firefox, mac-arm64

| Kind | Path | Existing SHA-256 | Observed SHA-256 | Comparison |
| --- | --- | --- | --- | --- |
| executable | `Firefox.app/Contents/MacOS/firefox` | `363eae026f4f5b3a8549f6a9c96a269754094ef12afc5f02cdffbcb4bcbf389c` | `363eae026f4f5b3a8549f6a9c96a269754094ef12afc5f02cdffbcb4bcbf389c` | matches |
| published licence | `Firefox.app/Contents/Resources/omni.ja` | `1ecdc0a4f6de9f562b24417cdaff4d2f17474d51572e65bbc4c7489cf4025c38` | `1ecdc0a4f6de9f562b24417cdaff4d2f17474d51572e65bbc4c7489cf4025c38` | matches |
| about:license text from proof | `omni.ja:chrome/toolkit/content/global/license.html` | `82eca7b84e696cc405a87a441b0b8df9c677a103e2f5bdbaebd642e282a79b00` | `82eca7b84e696cc405a87a441b0b8df9c677a103e2f5bdbaebd642e282a79b00` | matches |

## Checks inside webkit, mac-arm64

| Kind | Path | Existing SHA-256 | Observed SHA-256 | Comparison |
| --- | --- | --- | --- | --- |
| executable | `Playwright.app/Contents/MacOS/Playwright` | `7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f` | `7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f` | matches |
| pinned file | `protocol.json` | `5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c` | `5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c` | matches |
| published licence | `WebInspectorUI.framework/Versions/A/Resources/External/CodeMirror/LICENSE` | `168a4becc968f5001e2ee2e0291b6e4daabafc1894a11ade1e11d56e96096e07` | `168a4becc968f5001e2ee2e0291b6e4daabafc1894a11ade1e11d56e96096e07` | matches |
| published licence | `WebInspectorUI.framework/Versions/A/Resources/External/three.js/LICENSE` | `551f06ddc3dc36b56610aa23db680826ba9d9a02e8f89f7bec05d7fa27401a2b` | `551f06ddc3dc36b56610aa23db680826ba9d9a02e8f89f7bec05d7fa27401a2b` | matches |
| published licence | `WebInspectorUI.framework/Versions/A/Resources/External/Esprima/LICENSE` | `94bcb9959136723aa4fb36e1a6c4d5c662a2369978cfae344dabfb83ae619e79` | `94bcb9959136723aa4fb36e1a6c4d5c662a2369978cfae344dabfb83ae619e79` | matches |
| published licence | `WebInspectorUI.framework/Versions/A/Resources/External/CSSDocumentation/LICENSE` | `b5179f780ec212a434efcc989a2295a140deb0bdb17182d2bf9c5f6f1f1a01c4` | `b5179f780ec212a434efcc989a2295a140deb0bdb17182d2bf9c5f6f1f1a01c4` | matches |
| Retest-supplied notice | `licenses/WebKit-LGPL-2.1.txt` | `b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe` | `b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe` | matches |
| Retest-supplied notice | `licenses/WebKit-BSD-2-Clause.txt` | `9508673c7ddfdd28d574d536ef2e8a98d38ca1597f9c5a86a247d2210dd45942` | `9508673c7ddfdd28d574d536ef2e8a98d38ca1597f9c5a86a247d2210dd45942` | matches |
| Retest-supplied notice | `licenses/ANGLE-LICENSE.txt` | `bf4da21bd20bcfb5b60b7ecc67fa864a79be049e21d6178076887f178dd6c71a` | `bf4da21bd20bcfb5b60b7ecc67fa864a79be049e21d6178076887f178dd6c71a` | matches |
| Retest-supplied notice | `licenses/WebRTC-LICENSE.txt` | `ab00a482b6a3902e40211b43c5d0441962ea99b6cc7c25c0f243fa270b78d482` | `ab00a482b6a3902e40211b43c5d0441962ea99b6cc7c25c0f243fa270b78d482` | matches |
| Retest-supplied notice | `licenses/BoringSSL-LICENSE.txt` | `046ec2a8cf1915f1f354489a2031532f78dc3e023f3a5be4751c9938c73b4920` | `046ec2a8cf1915f1f354489a2031532f78dc3e023f3a5be4751c9938c73b4920` | matches |
| Retest-supplied notice | `licenses/abseil-cpp-LICENSE.txt` | `34cb75d73943f10a7f9a3b0e3e7bf8ef271065eedcb0d47481e7c831b637aeae` | `34cb75d73943f10a7f9a3b0e3e7bf8ef271065eedcb0d47481e7c831b637aeae` | matches |
| Retest-supplied notice | `licenses/libvpx-LICENSE.txt` | `b80a23ff7619a3b5c150cf718b43af5a5b9a2339ff019c562c9938d91303d08c` | `b80a23ff7619a3b5c150cf718b43af5a5b9a2339ff019c562c9938d91303d08c` | matches |
| Retest-supplied notice | `licenses/swiftCompatibilitySpan-LICENSE.txt` | `99d47dad251d8d1e0ce2f26d019f2a8cfd5ca66263084b6f2cf452a86f89b7f2` | `99d47dad251d8d1e0ce2f26d019f2a8cfd5ca66263084b6f2cf452a86f89b7f2` | matches |
| Retest-supplied notice | `licenses/SOURCE.txt` | `81ea2bf2f192ef3e1975007d5323468f31ccfaa7a2a4353af124fd9f3e7ea270` | `81ea2bf2f192ef3e1975007d5323468f31ccfaa7a2a4353af124fd9f3e7ea270` | matches |

## Checks inside firefox, linux-x64

No executable, file or licence checksum exists for this platform in the current pin table. The archive listing is retained in the logs.

## Checks inside webkit, linux-x64

No executable, file or licence checksum exists for this platform in the current pin table. The archive listing is retained in the logs.

## Pin and test updates

All existing Mac executable, pinned-file and published licence checksums match the downloaded archives. All nine Retest-supplied WebKit notice files match their existing pins. None of those checksums changed. The Firefox `omni.ja` extraction prints a central-directory warning and exits 2, but the bytes emitted for `license.html` hash to the same full SHA-256 as the installed public app. The raw warning and status are in `.retest/pin-checksums/firefox-licence-extraction.log`; the `omni.ja` archive itself matches the existing pin exactly.

`src/browser/builds.ts` now records the measured archive size and SHA-256 for all four existing browser archive pins. Linux Chrome also gains its newly inspected executable, `ABOUT` and Widevine licence checksums. The Linux Firefox and WebKit archives have no corresponding pin. Their checksums are recorded in this report and the proof.

The assigned tests now require the real Mac pins to pass `pinRefusal`, and keep missing-checksum refusal coverage with an intentionally unpinned fixture. The new real-archive integration cases require a local fixture directory explicitly, never fetch a publisher, check executable, file and notice records, require successful CLI install/list/verify/doctor, and check that a repeated install fetches nothing. A new real-archive case is skipped by name when the external fixture directory is not supplied; existing tests were not skipped or weakened.

`python3 .retest/pin-checksums/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/builds-pins.test.ts tests/unit/builds-install.test.ts tests/unit/builds-doctor.test.ts tests/unit/builds-webkit-notices.test.ts tests/unit/builds-process-start.test.ts`: exit 0, 49 passed, none failed, cancelled or skipped. Log `.retest/pin-checksums/units-first.log`.

The first local-mirror integration gate attempt exited 75 before launching tests. Log `.retest/pin-checksums/install-browsers-first.log`. The queued retries keep the shared lock's holder untouched.

`tests/unit/cli-install.test.ts` is outside the assigned files and still contains assertions that these real pins lack a checksum. Its owner must update those historical real-pin expectations while retaining refusal coverage with an intentionally unpinned fixture. No change to that file is made here.
Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 1, exit 75, log `.retest/pin-checksums/install-browsers-1.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 2, exit 75, log `.retest/pin-checksums/install-browsers-2.log`.

`python3 .retest/pin-checksums/guard.py node --conditions=retest-source --test --test-concurrency=1 'tests/unit/builds-*.test.ts'`: exit 0, 101 passed, none failed, cancelled or skipped. Log `.retest/pin-checksums/units-all-builds.log`.

The outside-scope historical CLI tests were also run without edits: `python3 .retest/pin-checksums/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-install.test.ts`. Exit 1, 8 passed, 4 failed, none skipped. Log `.retest/pin-checksums/cli-install-historical-expectations.log`. The four failures are the old missing-checksum listing, JSON listing, install-refusal and hand-filled-cache expectations. The real pins now have checksums, so those expectations need their owner's update. They are not counted as a green check.
Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 3, exit 75, log `.retest/pin-checksums/install-browsers-3.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 4, exit 75, log `.retest/pin-checksums/install-browsers-4.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 5, exit 75, log `.retest/pin-checksums/install-browsers-5.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 6, exit 1, log `.retest/pin-checksums/install-browsers-6.log`.

## First real browser CLI run

The queued integration acquired the gate on attempt 6. Attempts 1 through 5 exited 75 without launching tests. The actual run exited 1, with one case passed and three cases failed. Log `.retest/pin-checksums/install-browsers-6.log`.

All three real browser installs succeeded. Each local archive request occurred exactly once; each executable, pinned-file and licence record matched its pin. List, whole-tree verify and repeat install also succeeded for all three. Firefox copied only `Firefox.app`, and its successful CLI install supersedes the failed standalone unpack as installation evidence. The initial helper-related unpack failure remains a recorded observation; its cause was not established.

The three test cases failed at doctor because this lane's generated config put `baseUrl` inside a target. Retest correctly refused it as app-level data. The fixture now puts `baseUrl` on the app; no doctor assertion changed. The failed attempt's separate logs are retained under `.retest/pin-checksums/install-cli/`, including every install, list, verify, repeat and doctor result. The rerun uses a fresh log folder.
Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-final node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 1, exit 1, log `.retest/pin-checksums/install-browsers-final-1.log`.

The second fixture pass used an app URL with no server. Doctor correctly reported that the app did not answer while its browser and installed-build rows passed. The fixture now serves a real readiness response at `/doctor-app` on its own local server and requires exactly one readiness request plus the one original archive request. This keeps doctor exit 0 and all archive no-refetch assertions. The prior logs remain under `.retest/pin-checksums/install-cli-final/`; the corrected run will use `.retest/pin-checksums/install-cli-complete/`.
Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 1, exit 75, log `.retest/pin-checksums/install-browsers-complete-1.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 2, exit 75, log `.retest/pin-checksums/install-browsers-complete-2.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 3, exit 75, log `.retest/pin-checksums/install-browsers-complete-3.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 4, exit 75, log `.retest/pin-checksums/install-browsers-complete-4.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 5, exit 75, log `.retest/pin-checksums/install-browsers-complete-5.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 6, exit 75, log `.retest/pin-checksums/install-browsers-complete-6.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 7, exit 75, log `.retest/pin-checksums/install-browsers-complete-7.log`.

Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 8, exit 75, log `.retest/pin-checksums/install-browsers-complete-8.log`.

## Concurrent integration work

The integration builder's current report records two edits to this lane's install test. It requires real local browser archives on macOS instead of skipping the new cases when a variable is absent, and it gives the stand-in mounts an owned temporary root. Those changes are preserved. This supersedes the earlier note about an optional real-archive fixture skip. The integration builder has staged its own verified local copies for its full-list run and records that it will remove them afterwards; this lane will delete only its original six downloads and its own temporary copy.

The other builder's compiler caught a narrowed `refusal?.lead` assertion in the assigned pin unit test. The prior assertion already proves the whole refusal is undefined, so TypeScript treats its optional member as unreachable. The lead assertion now calls `pinRefusal(webkit)` afresh and still requires undefined. No assertion was removed or weakened. The helper-lifetime explanation of the first Firefox unpack remains a hypothesis, not an established cause; the subsequent real CLI disk-image installs succeed.
Gate command `env RETEST_TEST_BROWSER_ARCHIVES=/Users/dragon/Library/Caches/retest-proofs/downloads RETEST_TEST_INSTALL_LOGS=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/pin-checksums/install-cli-complete node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern=installing the three pinned browsers|what retest install refuses tests/integration/install.test.ts`: attempt 9, exit 75, log `.retest/pin-checksums/install-browsers-complete-9.log`.

## Passing real archive install run

The integration builder ran the current complete install test file through the shared gate using its own size- and SHA-256-verified local copies of these exact downloads. Command: `lockf -t 0 /tmp/retest-heavy-gate.lock sh .retest/integration-leftovers/dispatch.sh env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/install.test.ts`. The dispatcher supplies its staged fixture folder through `RETEST_TEST_BROWSER_ARCHIVES` and sets npm offline. Its staging ledger is `.retest/integration-leftovers/logs/staged-archives.json` and shows all three digests equal the downloads and pins.

Result: exit 0, 16 passed, none failed, cancelled or skipped. Log `.retest/integration-leftovers/logs/install-final.log`. Each browser's case ran real CLI `install <engine>`, `install --list --json`, `install --list --verify`, a repeat install and `doctor`. Every command exited 0. It required exactly one archive request, no archive request from list/verify/repeat/doctor, and one successful app readiness request. Firefox installed only `Firefox.app`. WebKit printed all nine supplied notices and their exact SHA-256 values, retained every published and supplied notice in its record, verified the installed tree, and printed the notices again in doctor. Earlier raw CLI output is retained under this lane's two install log folders.

This passing complete-file run includes the stronger mandatory local-fixture rule and mount-point isolation from the integration builder. The assigned pin unit file also passes after the assertion-preserving narrowing correction: 10 passed, none failed or skipped, log `.retest/pin-checksums/pins-narrowing-final.log`.

This lane's idle duplicate queue was stopped only after recording its exact pid and command and proving it had no running command child. Log `.retest/pin-checksums/duplicate-queue-stopped.log`. The complete gate's holder was left untouched. There is no reason to repeat the passing install suite while the full browser list runs.
Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 1, exit 75, log `.retest/pin-checksums/checks-and-linux-1.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 2, exit 75, log `.retest/pin-checksums/checks-and-linux-2.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 3, exit 75, log `.retest/pin-checksums/checks-and-linux-3.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 4, exit 75, log `.retest/pin-checksums/checks-and-linux-4.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 5, exit 75, log `.retest/pin-checksums/checks-and-linux-5.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 6, exit 75, log `.retest/pin-checksums/checks-and-linux-6.log`.

The copied Firefox app also reports `Version=133.0.3` and `BuildID=20241209150345` in `Contents/Resources/application.ini`, matching the pin. Log `.retest/pin-checksums/firefox-application-identity.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 7, exit 75, log `.retest/pin-checksums/checks-and-linux-7.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 8, exit 75, log `.retest/pin-checksums/checks-and-linux-8.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 9, exit 75, log `.retest/pin-checksums/checks-and-linux-9.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 10, exit 75, log `.retest/pin-checksums/checks-and-linux-10.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 11, exit 75, log `.retest/pin-checksums/checks-and-linux-11.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 12, exit 75, log `.retest/pin-checksums/checks-and-linux-12.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 13, exit 75, log `.retest/pin-checksums/checks-and-linux-13.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 14, exit 75, log `.retest/pin-checksums/checks-and-linux-14.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 15, exit 75, log `.retest/pin-checksums/checks-and-linux-15.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 16, exit 75, log `.retest/pin-checksums/checks-and-linux-16.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 17, exit 75, log `.retest/pin-checksums/checks-and-linux-17.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 18, exit 75, log `.retest/pin-checksums/checks-and-linux-18.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 19, exit 75, log `.retest/pin-checksums/checks-and-linux-19.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 20, exit 75, log `.retest/pin-checksums/checks-and-linux-20.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 21, exit 75, log `.retest/pin-checksums/checks-and-linux-21.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 22, exit 75, log `.retest/pin-checksums/checks-and-linux-22.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 23, exit 75, log `.retest/pin-checksums/checks-and-linux-23.log`.

The proof now states that the real WebKit archive has a checksum and is installable. Its earlier notice section had retained the historical checksum-refusal wording; that stale current claim is corrected. Linux Chrome installation and browser execution remain explicitly unverified.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 24, exit 75, log `.retest/pin-checksums/checks-and-linux-24.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 25, exit 75, log `.retest/pin-checksums/checks-and-linux-25.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 26, exit 75, log `.retest/pin-checksums/checks-and-linux-26.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 27, exit 75, log `.retest/pin-checksums/checks-and-linux-27.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 28, exit 75, log `.retest/pin-checksums/checks-and-linux-28.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 29, exit 75, log `.retest/pin-checksums/checks-and-linux-29.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 30, exit 75, log `.retest/pin-checksums/checks-and-linux-30.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 31, exit 75, log `.retest/pin-checksums/checks-and-linux-31.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 32, exit 75, log `.retest/pin-checksums/checks-and-linux-32.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 33, exit 75, log `.retest/pin-checksums/checks-and-linux-33.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 34, exit 75, log `.retest/pin-checksums/checks-and-linux-34.log`.

## Concurrent CLI changes after the passing install file

Another builder has updated the formerly stale `tests/unit/cli-install.test.ts`. A fresh diagnostic run, without editing that file, passed all 12 cases with no failures or skips. Command `python3 .retest/pin-checksums/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-install.test.ts`; log `.retest/pin-checksums/cli-install-owner-update.log`. This supersedes the four historical expectation failures for that file.

The current CLI production files also changed outside this lane. `src/cli/install/report.ts` now renders one short licence message; `src/cli/commands/install.ts` filters the detailed notice events, and `src/cli/commands/doctor.ts` filters their detail from terminal rows. The broader integration run has reported the real WebKit case failed. At that checkpoint its complete failure summary was not yet available; the completed exit and log are recorded below. The earlier isolated 16/16 file pass remains evidence for its earlier production tree, not a passing claim for the concurrent terminal changes. This lane retains the exact nine-notice assertions required by the founder brief. No assertion is weakened to accept hidden notices, and no outside-owned CLI production file is edited.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 35, exit 75, log `.retest/pin-checksums/checks-and-linux-35.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 36, exit 75, log `.retest/pin-checksums/checks-and-linux-36.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 37, exit 75, log `.retest/pin-checksums/checks-and-linux-37.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 38, exit 75, log `.retest/pin-checksums/checks-and-linux-38.log`.

The broader integration run has now completed with exit 1. Its WebKit failure is the exact required notice-output assertion in `tests/integration/install.test.ts`: actual 0, expected 9. Log `.retest/integration-leftovers/logs/integration-browsers-final.log`, exit record `.retest/integration-leftovers/logs/integration-browsers-final.exit`. Source inspection identifies the concurrent CLI filter that suppresses these nine detailed events. This is a current unmet requirement, not a checksum mismatch. The downloaded bytes and notice files still match their pins.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 39, exit 75, log `.retest/pin-checksums/checks-and-linux-39.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 40, exit 75, log `.retest/pin-checksums/checks-and-linux-40.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 41, exit 75, log `.retest/pin-checksums/checks-and-linux-41.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 42, exit 75, log `.retest/pin-checksums/checks-and-linux-42.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 43, exit 75, log `.retest/pin-checksums/checks-and-linux-43.log`.

## Conflicting concurrent notice assertion edit

A later concurrent edit to `tests/integration/install.test.ts` replaces this lane's exact nine-notice install-output assertion with an exact single short-message assertion and an assertion that notice hashes are absent. It adds strong record and `licences webkit` checks, but it no longer requires all nine notices in install output or doctor. This lane did not make that replacement. The current test and this brief now have incompatible output requirements. A clarification was sent to the founder through the asynchronous input tool; Linux work continues independently while the answer is pending. The separate current Mac proof preserves every nine-notice requirement, runs all requested CLI commands even if those output checks fail, and records an overall failure when a required notice is hidden. No outside-owned CLI production file is changed here.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 44, exit 75, log `.retest/pin-checksums/checks-and-linux-44.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 45, exit 75, log `.retest/pin-checksums/checks-and-linux-45.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 46, exit 75, log `.retest/pin-checksums/checks-and-linux-46.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 47, exit 75, log `.retest/pin-checksums/checks-and-linux-47.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 48, exit 75, log `.retest/pin-checksums/checks-and-linux-48.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 49, exit 75, log `.retest/pin-checksums/checks-and-linux-49.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 50, exit 75, log `.retest/pin-checksums/checks-and-linux-50.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 51, exit 75, log `.retest/pin-checksums/checks-and-linux-51.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 52, exit 75, log `.retest/pin-checksums/checks-and-linux-52.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 53, exit 75, log `.retest/pin-checksums/checks-and-linux-53.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 54, exit 75, log `.retest/pin-checksums/checks-and-linux-54.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 55, exit 75, log `.retest/pin-checksums/checks-and-linux-55.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 56, exit 75, log `.retest/pin-checksums/checks-and-linux-56.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 57, exit 75, log `.retest/pin-checksums/checks-and-linux-57.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 58, exit 75, log `.retest/pin-checksums/checks-and-linux-58.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 59, exit 75, log `.retest/pin-checksums/checks-and-linux-59.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 60, exit 75, log `.retest/pin-checksums/checks-and-linux-60.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 61, exit 75, log `.retest/pin-checksums/checks-and-linux-61.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 62, exit 75, log `.retest/pin-checksums/checks-and-linux-62.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 63, exit 75, log `.retest/pin-checksums/checks-and-linux-63.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 64, exit 75, log `.retest/pin-checksums/checks-and-linux-64.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 65, exit 75, log `.retest/pin-checksums/checks-and-linux-65.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 66, exit 75, log `.retest/pin-checksums/checks-and-linux-66.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 67, exit 75, log `.retest/pin-checksums/checks-and-linux-67.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 68, exit 75, log `.retest/pin-checksums/checks-and-linux-68.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 69, exit 75, log `.retest/pin-checksums/checks-and-linux-69.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 70, exit 75, log `.retest/pin-checksums/checks-and-linux-70.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 71, exit 75, log `.retest/pin-checksums/checks-and-linux-71.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 72, exit 75, log `.retest/pin-checksums/checks-and-linux-72.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 73, exit 75, log `.retest/pin-checksums/checks-and-linux-73.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 74, exit 75, log `.retest/pin-checksums/checks-and-linux-74.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 75, exit 75, log `.retest/pin-checksums/checks-and-linux-75.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 76, exit 75, log `.retest/pin-checksums/checks-and-linux-76.log`.

Container setup uses the workspace numeric uid and gid, 501:20, with every capability dropped, so the permission-refusal unit cases run without root privilege. This also keeps mounted build outputs writable and owned by this workspace without chmod or chown of the repository. The Cargo download cache is container-local `/tmp/retest-pin-cargo` and is removed with the container. The read-only input mounts, default parallel Rust tests and explicit GNU x64 target remain required. Actual user and mounts were checked through Docker inspection and `id`; their logs appear below.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 77, exit 75, log `.retest/pin-checksums/checks-and-linux-77.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 78, exit 75, log `.retest/pin-checksums/checks-and-linux-78.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 79, exit 75, log `.retest/pin-checksums/checks-and-linux-79.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 80, exit 75, log `.retest/pin-checksums/checks-and-linux-80.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 81, exit 75, log `.retest/pin-checksums/checks-and-linux-81.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 82, exit 75, log `.retest/pin-checksums/checks-and-linux-82.log`.

The two authorized Linux archive observations without Retest pins are also retained as address, measured size and full SHA-256 comments beside the table in `src/browser/builds.ts`. All six archive hashes are therefore recorded in that source file. The compiled pin set remains unchanged for Linux Firefox and WebKit; no unsupported installer format, export or compatibility claim is added.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 83, exit 75, log `.retest/pin-checksums/checks-and-linux-83.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 84, exit 75, log `.retest/pin-checksums/checks-and-linux-84.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 85, exit 75, log `.retest/pin-checksums/checks-and-linux-85.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 86, exit 75, log `.retest/pin-checksums/checks-and-linux-86.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 87, exit 75, log `.retest/pin-checksums/checks-and-linux-87.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 88, exit 75, log `.retest/pin-checksums/checks-and-linux-88.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 89, exit 75, log `.retest/pin-checksums/checks-and-linux-89.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 90, exit 75, log `.retest/pin-checksums/checks-and-linux-90.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 91, exit 75, log `.retest/pin-checksums/checks-and-linux-91.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 92, exit 75, log `.retest/pin-checksums/checks-and-linux-92.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 93, exit 75, log `.retest/pin-checksums/checks-and-linux-93.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 94, exit 75, log `.retest/pin-checksums/checks-and-linux-94.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 95, exit 75, log `.retest/pin-checksums/checks-and-linux-95.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 96, exit 75, log `.retest/pin-checksums/checks-and-linux-96.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 97, exit 75, log `.retest/pin-checksums/checks-and-linux-97.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 98, exit 75, log `.retest/pin-checksums/checks-and-linux-98.log`.

`npm run typecheck`: exit 0, log `.retest/pin-checksums/typecheck-final.log`.

Current Mac proof `chromium` `install chromium`: exit 0, signal null, log `.retest/pin-checksums/mac-current/chromium-install.log`.

Current Mac proof `chromium` `install --list --json`: exit 0, signal null, log `.retest/pin-checksums/mac-current/chromium-list.log`.

Current Mac proof `chromium` `install --list --verify`: exit 0, signal null, log `.retest/pin-checksums/mac-current/chromium-verify.log`.

Current Mac proof `chromium` `install chromium`: exit 0, signal null, log `.retest/pin-checksums/mac-current/chromium-repeat.log`.

Current Mac proof `chromium` `doctor`: exit 0, signal null, log `.retest/pin-checksums/mac-current/chromium-doctor.log`.

Current Mac proof `chromium` facts, with every required notice check preserved:

```json
{
  "engine": "chromium",
  "commandExits": [
    0,
    0,
    0,
    0,
    0
  ],
  "requests": [
    "/storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip",
    "/doctor-app"
  ],
  "archiveAndNoticesMatchPin": true,
  "requiredInstallNotices": 0,
  "printedInstallNotices": 0,
  "printedDoctorNotices": 0,
  "passed": true
}
```

Current Mac proof `firefox` `install firefox`: exit 0, signal null, log `.retest/pin-checksums/mac-current/firefox-install.log`.

Current Mac proof `firefox` `install --list --json`: exit 0, signal null, log `.retest/pin-checksums/mac-current/firefox-list.log`.

Current Mac proof `firefox` `install --list --verify`: exit 0, signal null, log `.retest/pin-checksums/mac-current/firefox-verify.log`.

Current Mac proof `firefox` `install firefox`: exit 0, signal null, log `.retest/pin-checksums/mac-current/firefox-repeat.log`.

Current Mac proof `firefox` `doctor`: exit 0, signal null, log `.retest/pin-checksums/mac-current/firefox-doctor.log`.

Current Mac proof `firefox` facts, with every required notice check preserved:

```json
{
  "engine": "firefox",
  "commandExits": [
    0,
    0,
    0,
    0,
    0
  ],
  "requests": [
    "/archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg",
    "/doctor-app"
  ],
  "archiveAndNoticesMatchPin": true,
  "requiredInstallNotices": 0,
  "printedInstallNotices": 0,
  "printedDoctorNotices": 0,
  "passed": true
}
```

Current Mac proof `webkit` `install webkit`: exit 0, signal null, log `.retest/pin-checksums/mac-current/webkit-install.log`.

Current Mac proof `webkit` `install --list --json`: exit 0, signal null, log `.retest/pin-checksums/mac-current/webkit-list.log`.

Current Mac proof `webkit` `install --list --verify`: exit 0, signal null, log `.retest/pin-checksums/mac-current/webkit-verify.log`.

Current Mac proof `webkit` `install webkit`: exit 0, signal null, log `.retest/pin-checksums/mac-current/webkit-repeat.log`.

Current Mac proof `webkit` `doctor`: exit 0, signal null, log `.retest/pin-checksums/mac-current/webkit-doctor.log`.

Current Mac proof `webkit` facts, with every required notice check preserved:

```json
{
  "engine": "webkit",
  "commandExits": [
    0,
    0,
    0,
    0,
    0
  ],
  "requests": [
    "/cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip",
    "/doctor-app"
  ],
  "archiveAndNoticesMatchPin": true,
  "requiredInstallNotices": 9,
  "printedInstallNotices": 0,
  "printedDoctorNotices": 0,
  "passed": false
}
```

Current Mac proof selected CLI and pin files unchanged during its commands: true. Hash snapshots `.retest/pin-checksums/mac-current/cli-source-start.json` and `cli-source-end.json`. Its temporary home, installed trees and local server were removed.

`node --conditions=retest-source .retest/pin-checksums/mac-current.mjs`: exit 1, log `.retest/pin-checksums/mac-current.log`.

## Files read from the Linux archives without existing pins

These are first observations, with no existing Linux Firefox or WebKit executable or licence pin to compare. Firefox's `omni.ja` is its published licence-page archive. The WebKit archive lists no separate licence text files; this pass does not assert that the Mac component notices establish the Linux build's notices.

| Engine | Path | Size in bytes | SHA-256 | Comparison |
| --- | --- | ---: | --- | --- |
| firefox | `firefox/firefox` | 5432 | `c28d8a95b95f9ee6054a702327a60f1ac5f12859dd543f3627b4be6b097325a7` | no Linux pin |
| firefox | `firefox/firefox-bin` | 903384 | `e7dad7b8ebde4106cc168293c229328b88a2e78354a97dc3c900628b845a8e3a` | no Linux pin |
| firefox | `firefox/omni.ja` | 36278848 | `13358e19b0fa1546ca007135a595bf42690afda17107a1c43f6c18499427d5d5` | no Linux pin |
| webkit | `minibrowser-gtk/bin/MiniBrowser` | 150400 | `4cddbcda702762149ca3bd8c79c2c78984a496181ac7d8281b8cf6090df7de50` | no Linux pin |
| webkit | `minibrowser-wpe/bin/MiniBrowser` | 44616 | `66b2efbf7e24084a4be32fa65f890f2c885b4cf2beaee757c98de1f650020a17` | no Linux pin |
| webkit | `protocol.json` | 259618 | `5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c` | matches the Mac pin's shared protocol |

Exact extraction argv and hashes are in `.retest/pin-checksums/linux-archive-files.json`. No Linux browser was launched.

`node .retest/pin-checksums/linux-archives.mjs`: exit 0, log `.retest/pin-checksums/linux-archive-files.log`.

## Linux x64 Rust build

Docker was already running and was not started or restarted. The media crate and repository are bind-mounted read-only. Only the output folder is writable. Tests use the default parallel mode and the explicit `x86_64-unknown-linux-gnu` target. No codec or operating-system package is downloaded.

`docker pull --platform linux/amd64 rust:1-trixie`: exit 0, log `.retest/linux-build/logs/rust-pull.log`.

Rust image address `docker.io/library/rust:1-trixie`, inspected uncompressed size 1664966244 bytes, image ID `sha256:73cdc6244792c9cbdb24999b60ff327b0b6d1999ab61be75f99e852e7b220ff5`, digests `['rust@sha256:15ad267e7a4cb2dce5905c90c76765adb6714945c5ea6d7c82673897a5e4067b']`, architecture amd64. Inspect log `.retest/linux-build/logs/rust-image-inspect.json`.

`docker run --detach --pull never --platform linux/amd64 --init --cap-drop ALL --user 501:20 --env CARGO_HOME=/tmp/retest-pin-cargo --name retest-pin-checksums-rust --cidfile /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/logs/rust-container.id --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media,dst=/media,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest,dst=/repo,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build,dst=/out rust:1-trixie sleep infinity`: exit 0, log `.retest/linux-build/logs/rust-container-start.log`.

Owned Rust container `43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e` runs `sleep infinity` under Docker init while commands execute. Its id is recorded before any stop.

Actual Docker inspection confirms both input mounts read-only and the output writable. Numeric user 501:20, container VM pid 73571, command `sleep infinity`, inspection `.retest/linux-build/logs/rust-container-inspect.json`.

`docker exec 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e sh /repo/.retest/pin-checksums/linux-rust.sh`: exit 101, log `.retest/linux-build/logs/rust-container-build.log`.

`.retest/linux-build/logs/uname.log`

```text
x86_64
```

`.retest/linux-build/logs/identity.log`

```text
uid=501 gid=20(dialout) groups=20(dialout)
```

`.retest/linux-build/logs/rustc-version.log`

```text
rustc 1.99.0 (b940084d7 2026-09-28)
binary: rustc
commit-hash: b940084d7eb6a299eb4bfeb8e34901bc051e7ac4
commit-date: 2026-09-28
host: x86_64-unknown-linux-gnu
release: 1.99.0
LLVM version: 23.1.1
```

`.retest/linux-build/logs/cargo-version.log`

```text
cargo 1.99.0 (5f94df478 2026-08-27)
```

`.retest/linux-build/logs/rustup-toolchain.log`

```text
1.99.0-x86_64-unknown-linux-gnu (default)
```

`.retest/linux-build/logs/rustup-targets.log`

```text
x86_64-unknown-linux-gnu
```

`.retest/linux-build/logs/tools.log`

```text
node: missing
ps: /usr/bin/ps
mkfifo: /usr/bin/mkfifo
cc: /usr/bin/cc
ld: /usr/bin/ld
ffmpeg: missing
ffprobe: missing
```

`.retest/linux-build/logs/cargo-test.exit`

```text
101
```

`.retest/linux-build/logs/cargo-build-release.exit`

```text
0
```

`.retest/linux-build/logs/binary-sha256.log`

```text
4fb5a0a9945010e6c8f50cdae099450f51d6741e53ab745fb83a99074af7664a  /out/target/x86_64-unknown-linux-gnu/release/retest-media
```

`.retest/linux-build/logs/binary-size.log`

```text
1630000 bytes
```

`.retest/linux-build/logs/binary-file.log`

```text
/out/target/x86_64-unknown-linux-gnu/release/retest-media: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, BuildID[sha1]=cad5d677686d9bf77f763ab160c8f1f0c7d8dd09, stripped
```

`docker exec 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e sh -c if command -v node; then exit 0; else exit 3; fi`: exit 3, log `.retest/linux-build/logs/rust-node-probe.log`.

The Rust image has no Node. The founder instruction explicitly permits the official Node image for this case. The fallback image is used only to supply its Node binary; all three requested unit files run in the same Rust container as the media build, on amd64 Linux. No npm package is installed.

`docker pull --platform linux/amd64 node:24-trixie-slim`: exit 0, log `.retest/linux-build/logs/node-pull.log`.

Node fallback image address `docker.io/library/node:24-trixie-slim`, inspected uncompressed size 234189506 bytes, image ID `sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f`, digests `['node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66']`, architecture amd64. Inspect log `.retest/linux-build/logs/node-image-inspect.json`.

`docker run --rm --pull never --platform linux/amd64 --init --cap-drop ALL --user 501:20 --name retest-pin-checksums-node --cidfile /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/logs/node-container.id --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media,dst=/media,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest,dst=/repo,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build,dst=/out node:24-trixie-slim sh /repo/.retest/pin-checksums/copy-node.sh`: exit 0, log `.retest/linux-build/logs/node-binary-copy.log`.

`docker exec 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e /out/tools/node /repo/.retest/pin-checksums/crate-ledger.mjs`: exit 0, log `.retest/linux-build/logs/crate-ledger.log`.

## Crates downloaded for the Linux build

The ledger reads the container cache after the locked build and checks every archive against Cargo.lock. The registry addresses below are the canonical static archive paths derived from name and version; Cargo network redirects were not captured. Cache files are removed with the container. Ledger `.retest/linux-build/logs/crate-downloads.json`.

| Crate | Version | Registry archive address | Size in bytes | SHA-256 | New download |
| --- | --- | --- | ---: | --- | --- |
| adler2 | 2.0.1 | `https://static.crates.io/crates/adler2/adler2-2.0.1.crate` | 13366 | `320119579fcad9c21884f5c4861d16174d0e06250625266f50fe6898340abefa` | True |
| autocfg | 1.5.1 | `https://static.crates.io/crates/autocfg/autocfg-1.5.1.crate` | 18911 | `f2032f911046de80f0a198e0901378627c33f59ea0ac00e363d481118bd70a53` | True |
| bitflags | 2.13.2 | `https://static.crates.io/crates/bitflags/bitflags-2.13.2.crate` | 51678 | `3ded4057c258ba199e2d26386d3af3780957ecaee6c4ef4041c6b4b8b97c0b06` | True |
| bytemuck | 1.25.2 | `https://static.crates.io/crates/bytemuck/bytemuck-1.25.2.crate` | 54075 | `95832e849adfb21180ccb6826a99da14e5d266ae5c2e668e1602cf234f153797` | True |
| byteorder-lite | 0.1.0 | `https://static.crates.io/crates/byteorder-lite/byteorder-lite-0.1.0.crate` | 15909 | `8f1fe948ff07f4bd06c30984e69f5b4899c516a3ef74f34df92a2df2ab535495` | True |
| cfg-if | 1.0.5 | `https://static.crates.io/crates/cfg-if/cfg-if-1.0.5.crate` | 9578 | `4e7648175b45a9a48536d676f68d918270699102aa8dab5496df06904c914600` | True |
| crc32fast | 1.5.2 | `https://static.crates.io/crates/crc32fast/crc32fast-1.5.2.crate` | 48100 | `01a7799fd6b852db0e61728dde9a204c423b44d689dbd432522543614b490e78` | True |
| fdeflate | 0.3.7 | `https://static.crates.io/crates/fdeflate/fdeflate-0.3.7.crate` | 27188 | `1e6853b52649d4ac5c0bd02320cddc5ba956bdb407c4b75a2c6b75bf51500f8c` | True |
| flate2 | 1.1.10 | `https://static.crates.io/crates/flate2/flate2-1.1.10.crate` | 80244 | `6e634e2e0ebac1ee034020da1ca582e17ffe4e0f5e985823721e168928136dcb` | True |
| image | 0.25.10 | `https://static.crates.io/crates/image/image-0.25.10.crate` | 303647 | `85ab80394333c02fe689eaf900ab500fbd0c2213da414687ebf995a65d5a6104` | True |
| itoa | 1.0.18 | `https://static.crates.io/crates/itoa/itoa-1.0.18.crate` | 15935 | `8f42a60cbdf9a97f5d2305f08a87dc4e09308d1276d28c869c684d7777685682` | True |
| libc | 0.2.190 | `https://static.crates.io/crates/libc/libc-0.2.190.crate` | 853678 | `ce5d3ddc6d3fa000eb1536d85e147bfe31aacaba692ed6a876f95cb7c855be78` | True |
| memchr | 2.8.3 | `https://static.crates.io/crates/memchr/memchr-2.8.3.crate` | 99165 | `cf8baf1c55e62ffcace7a9f06f4bd9cd3f0c4beb022d3b367256b91b87513d98` | True |
| miniz_oxide | 0.8.9 | `https://static.crates.io/crates/miniz_oxide/miniz_oxide-0.8.9.crate` | 67132 | `1fa76a2c86f704bdb222d66965fb3d63269ce38518b83cb0575fca855ebb6316` | True |
| miniz_oxide | 0.9.1 | `https://static.crates.io/crates/miniz_oxide/miniz_oxide-0.9.1.crate` | 70519 | `b63fbc4a50860e98e7b2aa7804ded1db5cbc3aff9193adaff57a6931bf7c4b4c` | True |
| moxcms | 0.8.1 | `https://static.crates.io/crates/moxcms/moxcms-0.8.1.crate` | 188252 | `bb85c154ba489f01b25c0d36ae69a87e4a1c73a72631fc6c0eb6dde34a73e44b` | True |
| num-traits | 0.2.19 | `https://static.crates.io/crates/num-traits/num-traits-0.2.19.crate` | 51631 | `071dfc062690e90b734c0b2273ce72ad0ffa95f0c74596bc250dcfd960262841` | True |
| png | 0.18.1 | `https://static.crates.io/crates/png/png-0.18.1.crate` | 125800 | `60769b8b31b2a9f263dae2776c37b1b28ae246943cf719eb6946a1db05128a61` | True |
| proc-macro2 | 1.0.107 | `https://static.crates.io/crates/proc-macro2/proc-macro2-1.0.107.crate` | 59588 | `985e7ec9bb745e6ce6535b544d84d6cd6f7ad8bd711c398938ae983b91a766d9` | True |
| pxfm | 0.1.30 | `https://static.crates.io/crates/pxfm/pxfm-0.1.30.crate` | 879463 | `d55d956fa96f5ec02be2e13af0e20391a5aa83d6a074e3ad368959d0fab299ea` | True |
| quote | 1.0.47 | `https://static.crates.io/crates/quote/quote-1.0.47.crate` | 31622 | `1fbf4db142a473a8d80c26bbf18454ed458bf8d26c8219c331daecfdbd079001` | True |
| serde | 1.0.229 | `https://static.crates.io/crates/serde/serde-1.0.229.crate` | 83669 | `4148590afebada386688f18773da617792bf2ef03ffc1e4cbd2b1d45b023e0ba` | True |
| serde_core | 1.0.229 | `https://static.crates.io/crates/serde_core/serde_core-1.0.229.crate` | 63100 | `67dca2c9c51e58a4791a4b1ed58308b39c64224d349a935ab5039aa360942a48` | True |
| serde_derive | 1.0.229 | `https://static.crates.io/crates/serde_derive/serde_derive-1.0.229.crate` | 59864 | `e7a5d71263a5a7d47b41f6b3f06ba276f10cc18b0931f1799f710578e2309348` | True |
| serde_json | 1.0.151 | `https://static.crates.io/crates/serde_json/serde_json-1.0.151.crate` | 156556 | `c841b55ecdae098c80dcae9cf767f6f8a0c2cdb3416bbef72181df4d0fe73f14` | True |
| simd-adler32 | 0.3.10 | `https://static.crates.io/crates/simd-adler32/simd-adler32-0.3.10.crate` | 18760 | `3a219298ac11a56ea9a6d2120044824d6f01aeb034955e7af7bc16858527deea` | True |
| syn | 3.0.6 | `https://static.crates.io/crates/syn/syn-3.0.6.crate` | 313821 | `8593e8e72159ed2257d083c7a454a85cbf854f37a0966d8d483aff8c8a3ebcee` | True |
| unicode-ident | 1.0.26 | `https://static.crates.io/crates/unicode-ident/unicode-ident-1.0.26.crate` | 48425 | `d245f478577f809a851594d02313b640fb437e0bb33866753cff937863096954` | True |
| zlib-rs | 0.6.8 | `https://static.crates.io/crates/zlib-rs/zlib-rs-0.6.8.crate` | 215857 | `b268e58e7c693d7c271f93ffc4ba3b380412554231c85bf61ca7af91042a4112` | True |
| zmij | 1.0.23 | `https://static.crates.io/crates/zmij/zmij-1.0.23.crate` | 28612 | `29666d0abbfad1e3dc4dcf6144730dd3a3ab225bbbdac83319345b1b44ccfc1b` | True |
| zune-core | 0.5.3 | `https://static.crates.io/crates/zune-core/zune-core-0.5.3.crate` | 30419 | `d56377fd46368984a170bc5aac5567e52ca5da874caa60bea39fcbca78fb658b` | True |
| zune-jpeg | 0.5.15 | `https://static.crates.io/crates/zune-jpeg/zune-jpeg-0.5.15.crate` | 88879 | `27bc9d5b815bc103f142aa054f561d9187d191692ec7c2d1e2b4737f8dbd7296` | True |

`docker exec 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e sh /repo/.retest/pin-checksums/linux-node.sh /out/tools/node`: exit 0, log `.retest/linux-build/logs/linux-unit-tests.log`.

`.retest/linux-build/logs/node-version.log`

```text
v24.21.0
```

`.retest/linux-build/logs/node-platform.json`

```text
{"platform":"linux","arch":"x64","versions":{"node":"24.21.0","acorn":"8.18.0","ada":"4.0.0","amaro":"1.1.11","ares":"1.34.8","brotli":"1.2.0","cldr":"48.0","icu":"78.3","llhttp":"9.4.3","merve":"1.2.2","modules":"137","napi":"10","nbytes":"0.1.4","ncrypto":"0.0.1","nghttp2":"1.70.0","nghttp3":"","ngtcp2":"","openssl":"3.5.8","simdjson":"4.6.7","simdutf":"6.4.0","sqlite":"3.53.4","tz":"2026c","undici":"7.29.1","unicode":"17.0","uv":"1.52.1","uvwasi":"0.0.23","v8":"13.6.233.17-node.53","zlib":"1.3.2.1-motley-8002e91","zstd":"1.5.7"}}
```

`.retest/linux-build/logs/node-unit-tests.exit`

```text
0
```

`docker stop 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e`: exit 0, log `.retest/linux-build/logs/rust-container-stop.log`.

`docker rm 43c16d97325f8ca0292087aaa3b4d9086c128669df250766daf6deeb3af3987e`: exit 0, log `.retest/linux-build/logs/rust-container-remove.log`.

Both named containers were removed; `.retest/linux-build/logs/containers-after.log` has no matching container. Docker itself was left running.

`python3 .retest/pin-checksums/linux-build.py`: exit 101, log `.retest/pin-checksums/linux-build.log`.

Gate command `python3 .retest/pin-checksums/checks-and-linux.py`: attempt 99, exit 1, log `.retest/pin-checksums/checks-and-linux-99.log`.

The independent process-harness follow-up first attempted `python3 .retest/pin-checksums/guard.py lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/pin-checksums/linux-followup.py`. Exit 75 before launching a container, log `.retest/pin-checksums/linux-followup-gate.log`. It queued with the same shared gate and benchmark guard; the later single-file exemption and owned queue stop are recorded below.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 1, exit 75, log `.retest/pin-checksums/linux-followup-1.log`.

## First Linux results

The container executed Linux amd64 programs through Docker on this arm64 Mac. This is a real Linux kernel and x64 executable run under emulation, not a physical x64 host proof.

| Exact command inside the first Rust container | Result | Log |
| --- | --- | --- |
| `cargo test --locked --manifest-path /media/Cargo.toml --target-dir /out/target --target x86_64-unknown-linux-gnu` | exit 101; 97 unit tests passed, 1 failed, none ignored or filtered; Cargo did not run the process target after that failure | `.retest/linux-build/logs/cargo-test.log` |
| `cargo build --release --locked --manifest-path /media/Cargo.toml --target-dir /out/target --target x86_64-unknown-linux-gnu` | exit 0; ELF x86-64 GNU/Linux release binary | `.retest/linux-build/logs/cargo-build-release.log` |
| `/out/tools/node --conditions=retest-source --test --test-concurrency=1 tests/unit/builds-lock.test.ts tests/unit/regular-file.test.ts tests/unit/builds-process-start.test.ts` | exit 0; 28 passed, none failed or cancelled, 1 existing macOS-only slow-ps cancellation case skipped | `.retest/linux-build/logs/node-unit-tests.log` |

The live `/proc` case passed, including this process's boot-tick start, an exited PID, the boot id and PID namespace. The install-lock race and permission refusals passed as non-root UID 501. The regular-file tests passed with Linux filesystem APIs. This supersedes the earlier fix report's "not run on Linux" limitations for these exercised cases. A real wall-clock step, a separate namespace competing for a shared lock, power-loss durability, a Linux browser install and real Linux encoding remain unverified.

Release binary `.retest/linux-build/target/x86_64-unknown-linux-gnu/release/retest-media`: 1,630,000 bytes, SHA-256 `4fb5a0a9945010e6c8f50cdae099450f51d6741e53ab745fb83a99074af7664a`. Toolchain `rustc 1.99.0`, `cargo 1.99.0`, LLVM 23.1.1, host/target `x86_64-unknown-linux-gnu`; Node v24.21.0, `process.platform=linux`, `process.arch=x64`. Complete tool versions and binary identity are in `.retest/linux-build/logs/`.

The failed test is `frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video`, with `input written: Broken pipe` at `media/src/frame.rs:789`. The image's tool probe finds neither ffmpeg nor ffprobe. No encoder or operating-system package is fetched because neither is authorized. The exact spawn-to-broken-pipe mechanism remains unverified; the missing real encoder prerequisite is established. The compiled unit test was then run alone as a separate diagnostic, and the unchanged compiled process-test harness ran independently; their results are recorded below. The full Cargo failure is retained regardless of those results.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 2, exit 75, log `.retest/pin-checksums/linux-followup-2.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 3, exit 75, log `.retest/pin-checksums/linux-followup-3.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 4, exit 75, log `.retest/pin-checksums/linux-followup-4.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 5, exit 75, log `.retest/pin-checksums/linux-followup-5.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 6, exit 75, log `.retest/pin-checksums/linux-followup-6.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 7, exit 75, log `.retest/pin-checksums/linux-followup-7.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 8, exit 75, log `.retest/pin-checksums/linux-followup-8.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 9, exit 75, log `.retest/pin-checksums/linux-followup-9.log`.

Gate command `python3 .retest/pin-checksums/linux-followup.py`: attempt 10, exit 75, log `.retest/pin-checksums/linux-followup-10.log`.

The follow-up uses the common-rules explicit exemption, "unit tests and single files need no lock". This is one compiled Rust process-test file, with an isolated codec diagnostic, using the already cached approved image and existing binaries. There is no image pull, compilation, browser or desktop target. The idle owned queue was stopped after its exact pid, parent and command were recorded and no command child was present; `.retest/pin-checksums/followup-queue-stopped.log`. The benchmark guard remains required. Both test exits are retained, and the command fails if either fails. The active heavy integration holder is untouched.

## Independent Linux process target and codec diagnostic

The full Cargo test retains its failure. Cargo compiled the process-test harness before the failing unit, but did not execute it. This follow-up runs that unchanged compiled harness directly, with default parallel mode and no filter, in the same cached amd64 Rust image. No image or crate is fetched. An exact single codec-test diagnostic runs first and is recorded separately; it is not counted as a full-test result. The first Rust container had already completed its requested Node tests and was removed, so this follow-up has its own recorded container.

Compiled test harness `.retest/linux-build/target/x86_64-unknown-linux-gnu/debug/deps/retest_media-c655b4f03a60b663`, 66007144 bytes, SHA-256 `51e0903b8024d0e4e11b2d7ee13d25fb74fc5226c5e57a093ea01b87678195ba`.

Compiled test harness `.retest/linux-build/target/x86_64-unknown-linux-gnu/debug/deps/process-119988d8a73d813e`, 61215624 bytes, SHA-256 `56001559ae236151b25f330ccc52441c5017892a021adf8c686439fa0e52f0a3`.

`docker run --detach --pull never --platform linux/amd64 --init --cap-drop ALL --user 501:20 --name retest-pin-checksums-process --cidfile /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build/logs/process-container.id --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media,dst=/media,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest,dst=/repo,readonly --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/linux-build,dst=/out sha256:73cdc6244792c9cbdb24999b60ff327b0b6d1999ab61be75f99e852e7b220ff5 sleep infinity`: exit 0, log `.retest/linux-build/logs/process-container-start.log`.

`docker exec aa8ee1ffdcb2cfd8d4518eb7a128cb380923bfa5330c6f19eaf9e1e7ff77b538 sh /repo/.retest/pin-checksums/linux-followup.sh`: exit 101, log `.retest/linux-build/logs/process-target-exec.log`.

`ffmpeg-isolated.exit`: `101`. Logs `.retest/linux-build/logs/ffmpeg-isolated.log` and `process-target.log`.

`process-target.exit`: `101`. Logs `.retest/linux-build/logs/ffmpeg-isolated.log` and `process-target.log`.

`docker stop aa8ee1ffdcb2cfd8d4518eb7a128cb380923bfa5330c6f19eaf9e1e7ff77b538`: exit 0, log `.retest/linux-build/logs/process-container-stop.log`.

`docker rm aa8ee1ffdcb2cfd8d4518eb7a128cb380923bfa5330c6f19eaf9e1e7ff77b538`: exit 0, log `.retest/linux-build/logs/process-container-remove.log`.

All three named containers are removed; `.retest/linux-build/logs/all-containers-after.log` is empty. Docker remains running.

## Download and container cleanup

All six publisher archives were checked again for the recorded size and SHA-256, then deleted. The direct Firefox app copy, its probe mount point, the empty first unpack mount point and the temporary Node binary were removed. Deletion ledger `.retest/pin-checksums/deleted-archives.json`; cache listing `.retest/pin-checksums/download-cache-after.log`; disk-image check `.retest/pin-checksums/disk-images-after.log`. The six original archives are absent, and none is mounted. Container build outputs remain under `.retest/linux-build/target/`, with logs under `.retest/linux-build/logs/` and `.retest/pin-checksums/`. Other builders' staged fixtures and processes were left to their owners.

`docker image rm --no-prune sha256:73cdc6244792c9cbdb24999b60ff327b0b6d1999ab61be75f99e852e7b220ff5`: exit 0, log `.retest/linux-build/logs/rust-image-remove.log`. Only this pass's inspected amd64 image is selected; no force or parent-image pruning is used.

`docker image rm --no-prune sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f`: exit 0, log `.retest/linux-build/logs/node-image-remove.log`. Only this pass's inspected amd64 image is selected; no force or parent-image pruning is used.

## Linux process failures retained

The exact diagnostic command was `/out/target/x86_64-unknown-linux-gnu/debug/deps/retest_media-c655b4f03a60b663 --exact frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video --nocapture`. It failed again with the same broken-pipe write: 0 passed, 1 failed, 97 filtered out, exit 101. This filtered diagnostic does not replace the full Cargo result.

The exact process command was `/out/target/x86_64-unknown-linux-gnu/debug/deps/process-119988d8a73d813e`, working directory `/media`, with no filter or thread-count override. It ran 55 cases: 51 passed, four failed, none ignored, measured or filtered; exit 101. Complete stdout and stderr are retained in `.retest/linux-build/logs/process-target.log`.

| Failed case | Observed assertion |
| --- | --- |
| `a_missing_encoder_fails_to_start` | `/no/such/ffmpeg` correctly used `encoder_failed`, but reported an encoder probe exit 127 rather than the required `could not be started` message and absent encoder details |
| `a_sequence_of_frames_with_the_longest_ids_stays_within_the_header_limit` | frame count 61, expected 64 |
| `an_encoder_with_neither_codec_is_unavailable` | `encoder_failed`, expected `encoder_unavailable`; the message reports an encoder ownership query failure |
| `frames_are_returned_from_a_running_and_an_ended_recording_until_released` | release returned `recording_running`, expected `released` |

No Rust source or process assertion was changed in this lane. These are real Linux findings, not passes or proof that missing ffmpeg explains every failure. The effect of emulation or concurrent host load on these failures has not been established. There is no serial or skipped-test substitute. The full Cargo, codec diagnostic and process target all retain their failing exits.

The follow-up's exact host invocation was `python3 .retest/pin-checksums/guard.py python3 .retest/pin-checksums/linux-followup.py`. It used the documented unit/single-file lock exemption and a benchmark guard; the media compilation and current Mac installs had run sequentially through the shared gate. Every helper's final source is retained in `.retest/pin-checksums/execution-scripts.log` with its path and SHA-256. Temporary executable helper files were removed after completion. Existing logs retain historical helper command paths for replay from that source.

Final cleanup command `python3 .retest/pin-checksums/cleanup.py` exited 0: deleted six original archives totalling 812,121,829 bytes. The download cache is empty; `.retest/pin-checksums/deleted-archives.json` records each deleted path, size and unchanged checksum. Final container and binary checks are in `.retest/linux-build/logs/removed-containers-final.json` and `.retest/pin-checksums/cleanup-final.json`. Other builders' staged copies were left to their owners. The container's crate cache was removed with its container; build outputs and logs remain.

Both newly downloaded amd64 Docker image IDs were removed without force or parent-image pruning. Final absence checks are in `.retest/linux-build/logs/removed-images-final.json`. Docker was never started or restarted. Helper sources were copied verbatim into `.retest/pin-checksums/execution-scripts.log`, then their executable files and two owned bytecode-cache files were removed; ledger `.retest/pin-checksums/removed-helper-files.json`. Only checksum observations, build outputs and logs remain from this pass.
