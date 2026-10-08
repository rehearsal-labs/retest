# Licence wording

Implemented the short install messages, one licence line per pin in the plain list, structured notice detail in JSON, `retest licences` and the short doctor notice row. The focused check ran 180 tests successfully, with final changed-output and cancellation checks also passing. The existing notice checks and refusal rules stay in place. Full project typechecking remains unverified because all 14 attempts found the shared heavy gate busy.

Read the repository instructions, README, architecture, common rules, release invariants, native decisions, notice report and install guide before editing. The shared tree already contains other builders' work. The pin table, integration install tests and `builds-*` unit tests are read-only in this task.

Initial command: `node --conditions=retest-source src/cli/main.ts install --list`, exit 0. Log: `.retest/licence-wording/logs/initial-list.log`. The WebKit row prints every notice path and checksum, followed by source and patches pointers. The pin table changed during the read to carry archive checksums; no archive was downloaded in this task.

No benchmark, upstream download, commit, stash, reset or revert ran. The existing mirror refusal unit test uses only its local stand-in response. Check results and exact CLI output captures are recorded below.

The installer keeps its detailed verification events. The terminal dispatcher suppresses those events and prints the short message once, including for a refused install. This required an anchored edit to `src/cli/commands/install.ts`. JSON gains `licences` and `sourceCode`; the strict media list validator in `src/cli/install/media-report.ts` validates them. Neither edit changes notice checks or archive refusal rules. Doctor keeps its internal detailed rows for the unchanged notice tests and renders their verified status in plain words.

`retest licences` reads installed notices or shipped pinned copies. An installed missing or changed notice never falls back to a bundled copy. Archive-only notice texts unavailable before installation are named, the available bundled texts still print, and the command exits 2 for incomplete output. Source and patches pointers come last. Firefox's notice page is read from the checksum-verified local `omni.ja` through the host unzip tool using a private copy, which is removed before the command returns.

- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-licence-wording.test.ts tests/unit/cli-licences.test.ts tests/unit/cli-doctor-licence-wording.test.ts tests/unit/cli-help.test.ts`: exit 0, 26 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/focused-first.log`.
- `python3 .retest/licence-wording/guard.py lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`: exit 75; the shared gate was busy and npm did not start. Log `.retest/licence-wording/logs/typecheck-attempt-1.log`. No holder was interrupted.

The guard checks `pgrep -f 'benchmarks/[r]un.ts'` before starting a command and records each command's child pid and arguments in `.retest/licence-wording/processes.txt`.

- Typecheck attempts 2 and 3 used the same guarded lock command and each exited 75 without starting npm. Logs `.retest/licence-wording/logs/typecheck-attempt-2.log` and `.retest/licence-wording/logs/typecheck-attempt-3.log`.
- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-doctor.test.ts tests/unit/cli-run.test.ts tests/unit/builds-webkit-notices.test.ts tests/unit/builds-doctor.test.ts tests/unit/builds-doctor-native.test.ts tests/unit/builds-install.test.ts tests/unit/builds-pins.test.ts tests/unit/builds-record.test.ts tests/unit/builds-installed.test.ts`: exit 0, 125 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/existing-notice-checks.log`. The `builds-*` files were not edited.
- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-install.test.ts`: exit 0, 12 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/cli-install-moved-detail.log`.

The old CLI output tests in `tests/unit/cli-install.test.ts` now assert the short list wording and retain their nine-notice and source-pointer checks in the JSON and `licences` outputs. The other builder's new archive checksums make a hand-written Chromium record damaged rather than unverifiable; this test still requires exit 2, rejects the archive checksum, names the folder and never labels it installed. Missing-checksum refusal remains covered by the unchanged installer and pin tests. The guide edit replaces only the old install-notice bullet with two sentences.

- Typecheck attempts 4, 5 and 6 used the same guarded lock command and exited 75 without starting npm. Logs `.retest/licence-wording/logs/typecheck-attempt-4.log`, `.retest/licence-wording/logs/typecheck-attempt-5.log` and `.retest/licence-wording/logs/typecheck-attempt-6.log`. Attempts 7 through 14 were queued by `python3 .retest/licence-wording/queue-typecheck.py`, with a separate log per attempt. All exited 75 before npm started.
- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-licences.test.ts`: exit 0, 10 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/licences-with-firefox.log`. The host unzip printed the full page from a locally created stand-in Firefox notice archive. A real installed Firefox notice archive remains unverified.
- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-licence-wording.test.ts tests/unit/cli-licences.test.ts tests/unit/cli-doctor-licence-wording.test.ts tests/unit/cli-help.test.ts tests/unit/cli-install.test.ts tests/unit/cli-doctor.test.ts tests/unit/cli-run.test.ts tests/unit/builds-webkit-notices.test.ts tests/unit/builds-doctor.test.ts tests/unit/builds-doctor-native.test.ts tests/unit/builds-install.test.ts tests/unit/builds-pins.test.ts tests/unit/builds-record.test.ts tests/unit/builds-installed.test.ts tests/unit/media-install.test.ts`: exit 0, 180 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/focused-final.log`. This includes the media list validator and the existing notice refusal checks.

- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-licences.test.ts tests/unit/cli-doctor-licence-wording.test.ts tests/unit/cli-install.test.ts`: exit 0, 25 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/final-label-and-cancellation.log`. This checks the final source-pointer label, one missing-file mention in doctor and cancellation before any notice read or output.

The complete WebKit capture includes the original checksum-pinned `SOURCE.txt` bytes. That historical text still describes an unpinned archive; the other builder has since supplied the archive checksum in the pin table. This task does not rewrite a notice or its checksum. The structured list records the current archive pin and source pointers.

- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-licences.test.ts`: exit 0, 11 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/licences-platform-selection.log`. Notice discovery lists all pinned platforms; reading prefers the current platform's pin and can read shipped notices of another pinned platform without claiming that its browser runs here.

The JSON capture contains 6 browser/executor rows plus media. Notice counts are Chromium 2, Firefox 1, WebKit 13, Electron 2, WebDriverAgent 3 and macOS executor 4. All 13 WebKit paths, identifiers and pinned notice checksums and both source pointers remain in JSON. The empty-cache WebKit command prints all 9 shipped texts, names the 4 archive-only texts, and exits 2. The real installed macOS executor command prints all 4 notice texts and exits 0. The plain list has 6 short licence lines, and the install capture has one message per named engine.

- `python3 .retest/licence-wording/guard.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/cli-doctor-licence-wording.test.ts`: exit 0, 2 passed, 0 failed, 0 cancelled, 0 skipped. Log `.retest/licence-wording/logs/doctor-missing-once.log`. The missing notice appears exactly once in the terminal row.

All implementation and output checks above are complete. The full project typecheck could not start because the other builder's integration gate held the shared lock. No full integration suite, benchmark, real browser install or native execution was started by this task. The exact checked native notice texts do not establish a new platform compatibility claim.

The exact command for each typecheck attempt was `python3 .retest/licence-wording/guard.py lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`. The remaining busy-gate logs are `.retest/licence-wording/logs/typecheck-attempt-7.log`, `.retest/licence-wording/logs/typecheck-attempt-8.log`, `.retest/licence-wording/logs/typecheck-attempt-9.log`, `.retest/licence-wording/logs/typecheck-attempt-10.log`, `.retest/licence-wording/logs/typecheck-attempt-11.log`, `.retest/licence-wording/logs/typecheck-attempt-12.log`, `.retest/licence-wording/logs/typecheck-attempt-13.log`, `.retest/licence-wording/logs/typecheck-attempt-14.log`. No holder was interrupted.

The owned queue was stopped only after `pgrep -P 35225` showed no command child and `ps -p 35225 -o args=` matched the recorded queue program. Its identity is in `.retest/licence-wording/queue-process.json`; SIGTERM ended only that recorded queue, with exit 143. Stop log `.retest/licence-wording/logs/queue-stop.log`. Every launched test and CLI command finished; nothing from this task remains running.

## Exact CLI outputs

The install capture uses deliberately empty build folders in a private cache so every install refuses before any download or native build. The list capture uses an empty private cache. Doctor reads a configured path that does not exist, so its target row fails while its bundled notice row verifies. Reading the real installed macOS executor notices starts no native app. No new browser or native execution claim follows from these captures.

Command: `python3 .retest/licence-wording/guard.py env HOME=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home NO_COLOR=1 node --conditions=retest-source src/cli/main.ts install webkit electron webdriveragent mac2`. Exit 2. Log `.retest/licence-wording/logs/install-notices.log`.

```text
  WebKit is open source. Its licence notices are kept with the build in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/webkit-26.6-mac-arm64/build/licenses; `retest licences webkit` prints them.
  ✗ webkit           WebKit (Playwright build) 26.6 (build 2359) is in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/webkit-26.6-mac-arm64, but not as recorded: /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/webkit-26.6-mac-arm64 holds no build.json, so nothing records what is in it. Remove /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/webkit-26.6-mac-arm64 and run the install again.
  Electron is open source; its licence notices are kept with the build, and `retest licences electron` prints them.
  ✗ electron         Electron 44.5.1 is in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/electron-44.5.1-mac-arm64, but not as recorded: /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/electron-44.5.1-mac-arm64 holds no build.json, so nothing records what is in it. Remove /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/browsers/electron-44.5.1-mac-arm64 and run the install again.
  WebDriverAgent is open source; its licence notices are kept with the build, and `retest licences webdriveragent` prints them.
  ✗ webdriveragent   WebDriverAgent 16.13.6 is in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/webdriveragent-16.13.6-3449697de4a09b74, but not as recorded: /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/webdriveragent-16.13.6-3449697de4a09b74 holds no build.json, so nothing records a finished build in it. Remove /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/webdriveragent-16.13.6-3449697de4a09b74 to build it again; a macOS runner built again needs its permissions granted again.
  The macOS executor is open source; its licence notices are kept with the build, and `retest licences mac2` prints them.
  ✗ mac2             WebDriverAgentMac (appium-mac2-driver) 4.3.6 is in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/mac2-4.3.6-9ddf0bb088d8682c, but not as recorded: /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/mac2-4.3.6-9ddf0bb088d8682c holds no build.json, so nothing records a finished build in it. Remove /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/damaged-home/Library/Caches/retest/native-executors/mac2-4.3.6-9ddf0bb088d8682c to build it again; a macOS runner built again needs its permissions granted again.
```

Command: `python3 .retest/licence-wording/guard.py env HOME=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home NO_COLOR=1 node --conditions=retest-source src/cli/main.ts install --list`. Exit 0. Log `.retest/licence-wording/logs/list.log`.

```text

  Pinned builds for macOS arm64, in /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest

  chromium         Chrome for Testing 153.0.8010.12               - not installed · npx retest install chromium
                                                                    BSD and Widevine, notices kept with the build
  firefox          Firefox 133.0.3 (build 20241209150345)         - not installed · npx retest install firefox
                                                                    MPL 2.0, notices kept with the build
  webkit           WebKit (Playwright build) 26.6 (build 2359)    - not installed · npx retest install webkit
                                                                    LGPL 2.1 and BSD, notices kept with the build
  electron         Electron 44.5.1                                - not installed · npx retest install electron
                                                                    MIT and BSD, notices kept with the build
  webdriveragent   WebDriverAgent 16.13.6                         - not installed · npx retest install webdriveragent
                                                                    BSD and Apache 2.0, notices kept with the build
  mac2             WebDriverAgentMac (appium-mac2-driver) 4.3.6   - not installed · npx retest install mac2
                                                                    Apache 2.0 and BSD, notices kept with the build

  Nothing was downloaded.

  media            retest-media 0.1.0, protocol 2, aarch64-apple-darwin
                   missing
                   /Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/media/media-0.1.0-aarch64-apple-darwin/retest-media
                   Run npx retest install media.
```

Command: `python3 .retest/licence-wording/guard.py env HOME=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home NO_COLOR=1 node --conditions=retest-source src/cli/main.ts install --list --json`. Exit 0. Log `.retest/licence-wording/logs/list-json.log`.

<details>
<summary>Complete captured output</summary>

```text
{
  "schemaVersion": 1,
  "platform": "mac-arm64",
  "cache": {
    "browsers": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/browsers",
    "executors": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/native-executors"
  },
  "builds": [
    {
      "engine": "chromium",
      "title": "Chrome for Testing",
      "version": "153.0.8010.12",
      "platform": "mac-arm64",
      "source": "https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip",
      "pinnedSha256": "930e2a2c15addbaca1fe9b07bfa520667bced556d7988707186819cb4279ef3b",
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/browsers/chromium-153.0.8010.12-mac-arm64",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "chrome-mac-arm64/ABOUT",
            "title": "the build's notice, which names chrome://credits, where the licences compiled into the browser are listed",
            "licence": "BSD-3-Clause and the licences at chrome://credits",
            "sha256": "34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb",
            "published": true
          },
          {
            "path": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/153.0.8010.12/Libraries/WidevineCdm/LICENSE",
            "title": "the licence of Google's Widevine module",
            "licence": "LicenseRef-Widevine",
            "sha256": "20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386",
            "published": true
          }
        ]
      },
      "install": {
        "command": "npx retest install chromium"
      }
    },
    {
      "engine": "firefox",
      "title": "Firefox",
      "version": "133.0.3",
      "build": "20241209150345",
      "platform": "mac-arm64",
      "source": "https://archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg",
      "pinnedSha256": "9ceb4fa2120228f287e6c654cef7898b4cce0a659270056276b8884581267d3b",
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/browsers/firefox-133.0.3-mac-arm64",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "Firefox.app/Contents/Resources/omni.ja",
            "title": "the archive that holds Firefox's about:license page, chrome/toolkit/content/global/license.html",
            "licence": "MPL-2.0 and the licences at about:license",
            "sha256": "1ecdc0a4f6de9f562b24417cdaff4d2f17474d51572e65bbc4c7489cf4025c38",
            "published": true
          }
        ]
      },
      "install": {
        "command": "npx retest install firefox"
      }
    },
    {
      "engine": "webkit",
      "title": "WebKit (Playwright build)",
      "version": "26.6",
      "build": "2359",
      "platform": "mac-arm64",
      "source": "https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip",
      "pinnedSha256": "f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7",
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/browsers/webkit-26.6-mac-arm64",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "WebInspectorUI.framework/Versions/A/Resources/External/CodeMirror/LICENSE",
            "title": "the licence of CodeMirror, in the Web Inspector",
            "licence": "MIT",
            "sha256": "168a4becc968f5001e2ee2e0291b6e4daabafc1894a11ade1e11d56e96096e07",
            "published": true
          },
          {
            "path": "WebInspectorUI.framework/Versions/A/Resources/External/three.js/LICENSE",
            "title": "the licence of three.js, in the Web Inspector",
            "licence": "MIT",
            "sha256": "551f06ddc3dc36b56610aa23db680826ba9d9a02e8f89f7bec05d7fa27401a2b",
            "published": true
          },
          {
            "path": "WebInspectorUI.framework/Versions/A/Resources/External/Esprima/LICENSE",
            "title": "the licence of Esprima, in the Web Inspector",
            "licence": "BSD-2-Clause",
            "sha256": "94bcb9959136723aa4fb36e1a6c4d5c662a2369978cfae344dabfb83ae619e79",
            "published": true
          },
          {
            "path": "WebInspectorUI.framework/Versions/A/Resources/External/CSSDocumentation/LICENSE",
            "title": "the licence of CSSDocumentation, in the Web Inspector",
            "licence": "MIT",
            "sha256": "b5179f780ec212a434efcc989a2295a140deb0bdb17182d2bf9c5f6f1f1a01c4",
            "published": true
          },
          {
            "path": "licenses/WebKit-LGPL-2.1.txt",
            "bundled": "webkit/WebKit-LGPL-2.1.txt",
            "sha256": "b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe",
            "title": "WebKit's LGPL-2.1 licence text",
            "licence": "LGPL-2.1",
            "published": false
          },
          {
            "path": "licenses/WebKit-BSD-2-Clause.txt",
            "bundled": "webkit/WebKit-BSD-2-Clause.txt",
            "sha256": "9508673c7ddfdd28d574d536ef2e8a98d38ca1597f9c5a86a247d2210dd45942",
            "title": "WebKit's BSD-2-Clause licence text",
            "licence": "BSD-2-Clause",
            "published": false
          },
          {
            "path": "licenses/ANGLE-LICENSE.txt",
            "bundled": "webkit/ANGLE-LICENSE.txt",
            "sha256": "bf4da21bd20bcfb5b60b7ecc67fa864a79be049e21d6178076887f178dd6c71a",
            "title": "the notice of ANGLE, in libANGLE-shared.dylib",
            "licence": "BSD-3-Clause",
            "published": false
          },
          {
            "path": "licenses/WebRTC-LICENSE.txt",
            "bundled": "webkit/WebRTC-LICENSE.txt",
            "sha256": "ab00a482b6a3902e40211b43c5d0441962ea99b6cc7c25c0f243fa270b78d482",
            "title": "the notice of WebRTC, in libwebrtc.dylib",
            "licence": "BSD-3-Clause",
            "published": false
          },
          {
            "path": "licenses/BoringSSL-LICENSE.txt",
            "bundled": "webkit/BoringSSL-LICENSE.txt",
            "sha256": "046ec2a8cf1915f1f354489a2031532f78dc3e023f3a5be4751c9938c73b4920",
            "title": "the notice of BoringSSL, in libwebrtc.dylib",
            "licence": "Apache-2.0 AND OpenSSL AND ISC AND BSD-3-Clause",
            "published": false
          },
          {
            "path": "licenses/abseil-cpp-LICENSE.txt",
            "bundled": "webkit/abseil-cpp-LICENSE.txt",
            "sha256": "34cb75d73943f10a7f9a3b0e3e7bf8ef271065eedcb0d47481e7c831b637aeae",
            "title": "the notice of abseil-cpp, in libwebrtc.dylib",
            "licence": "Apache-2.0",
            "published": false
          },
          {
            "path": "licenses/libvpx-LICENSE.txt",
            "bundled": "webkit/libvpx-LICENSE.txt",
            "sha256": "b80a23ff7619a3b5c150cf718b43af5a5b9a2339ff019c562c9938d91303d08c",
            "title": "the notice of libvpx, in libwebrtc.dylib",
            "licence": "BSD-3-Clause",
            "published": false
          },
          {
            "path": "licenses/swiftCompatibilitySpan-LICENSE.txt",
            "bundled": "webkit/swiftCompatibilitySpan-LICENSE.txt",
            "sha256": "99d47dad251d8d1e0ce2f26d019f2a8cfd5ca66263084b6f2cf452a86f89b7f2",
            "title": "the notice of the Swift compatibility library, libswiftCompatibilitySpan.dylib",
            "licence": "Apache-2.0 WITH Swift-exception",
            "published": false
          },
          {
            "path": "licenses/SOURCE.txt",
            "bundled": "webkit/SOURCE.txt",
            "sha256": "81ea2bf2f192ef3e1975007d5323468f31ccfaa7a2a4353af124fd9f3e7ea270",
            "title": "where the WebKit revision and the Playwright patches that built this revision are published",
            "licence": "LGPL-2.1",
            "published": false
          }
        ]
      },
      "sourceCode": {
        "repository": "https://github.com/WebKit/WebKit",
        "revision": "4d05d732e5a84f32675bef4cc135a2e7a9269a87",
        "patches": "https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit"
      },
      "install": {
        "command": "npx retest install webkit"
      }
    },
    {
      "engine": "electron",
      "title": "Electron",
      "version": "44.5.1",
      "platform": "mac-arm64",
      "source": "https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip",
      "pinnedSha256": "1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c",
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/browsers/electron-44.5.1-mac-arm64",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "LICENSE",
            "title": "Electron's licence",
            "licence": "MIT",
            "sha256": "5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d",
            "published": true
          },
          {
            "path": "LICENSES.chromium.html",
            "title": "the licences of Chromium and the libraries compiled into it",
            "licence": "BSD-3-Clause and the licences it lists",
            "sha256": "a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535",
            "published": true
          }
        ]
      },
      "install": {
        "command": "npx retest install electron"
      }
    },
    {
      "engine": "webdriveragent",
      "title": "WebDriverAgent",
      "version": "16.13.6",
      "platform": "mac-arm64",
      "source": "https://github.com/appium/WebDriverAgent@9d1d17ddb59e6097ddc3324b23ca9f4174507b12",
      "pinnedSha256": null,
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/native-executors/webdriveragent-16.13.6-3449697de4a09b74",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "licenses/WebDriverAgent-LICENSE.txt",
            "title": "the licence of WebDriverAgent",
            "licence": "BSD-3-Clause",
            "sha256": "d9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4",
            "published": true
          },
          {
            "path": "licenses/Apache-2.0-LICENSE.txt",
            "title": "the licence of appium-mac2-driver",
            "licence": "Apache-2.0",
            "sha256": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
            "published": true
          },
          {
            "path": "licenses/FBHTTPStatusCodes-NOTICE.txt",
            "title": "the header of WebDriverAgentLib/Routing/FBHTTPStatusCodes.h, compiled into the build",
            "licence": "Apache-2.0",
            "published": true
          }
        ]
      },
      "install": {
        "command": "npx retest install webdriveragent"
      }
    },
    {
      "engine": "mac2",
      "title": "WebDriverAgentMac (appium-mac2-driver)",
      "version": "4.3.6",
      "platform": "mac-arm64",
      "source": "https://github.com/appium/appium-mac2-driver@f38257191fa9f273a684f6a9c8c2b16d1272bd09",
      "pinnedSha256": null,
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/native-executors/mac2-4.3.6-9ddf0bb088d8682c",
      "problems": [],
      "licences": {
        "inspected": true,
        "files": [
          {
            "path": "licenses/appium-mac2-driver-LICENSE.txt",
            "title": "the licence of appium-mac2-driver",
            "licence": "Apache-2.0",
            "sha256": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
            "published": true
          },
          {
            "path": "licenses/WebDriverAgent-LICENSE.txt",
            "title": "the licence of WebDriverAgent",
            "licence": "BSD-3-Clause",
            "sha256": "d9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4",
            "published": true
          },
          {
            "path": "licenses/FBHTTPStatusCodes-NOTICE.txt",
            "title": "the header of WebDriverAgentMac/WebDriverAgentLib/Routing/FBHTTPStatusCodes.h, compiled into the build",
            "licence": "Apache-2.0",
            "published": true
          },
          {
            "path": "licenses/appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt",
            "title": "the BSD header appium-mac2-driver keeps from WebDriverAgent, with the files that carry it",
            "licence": "BSD-3-Clause",
            "published": true
          }
        ]
      },
      "install": {
        "command": "npx retest install mac2"
      }
    },
    {
      "engine": "media",
      "title": "retest-media",
      "version": "0.1.0",
      "protocol": 2,
      "target": "aarch64-apple-darwin",
      "platform": "mac-arm64",
      "source": "shipped crate source",
      "pinnedSha256": null,
      "sourceDigest": "ba7d170a845abf3f6c9338b0c1b370f79294d67c223b195c586207afbeb20bff",
      "state": "missing",
      "folder": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/media/media-0.1.0-aarch64-apple-darwin",
      "executablePath": "/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home/Library/Caches/retest/media/media-0.1.0-aarch64-apple-darwin/retest-media",
      "problems": [],
      "install": {
        "command": "npx retest install media",
        "prebuiltRefused": "No published prebuilt checksum is pinned."
      }
    }
  ]
}
```

</details>

Command: `python3 .retest/licence-wording/guard.py node --conditions=retest-source src/cli/main.ts licences`. Exit 0. Log `.retest/licence-wording/logs/licences-list.log`.

```text
Licence notices are kept with these pinned builds:
  chromium (mac-arm64)  Chrome for Testing 153.0.8010.12: BSD and Widevine, notices kept with the build
  chromium (linux-x64)  Chrome for Testing 153.0.8010.12: BSD and Widevine, notices kept with the build
  firefox (mac-arm64)  Firefox 133.0.3 (build 20241209150345): MPL 2.0, notices kept with the build
  webkit (mac-arm64)  WebKit (Playwright build) 26.6 (build 2359): LGPL 2.1 and BSD, notices kept with the build
  electron (mac-arm64)  Electron 44.5.1: MIT and BSD, notices kept with the build
  webdriveragent (mac-arm64)  WebDriverAgent 16.13.6: BSD and Apache 2.0, notices kept with the build
  mac2 (mac-arm64)  WebDriverAgentMac (appium-mac2-driver) 4.3.6: Apache 2.0 and BSD, notices kept with the build
Run `retest licences <engine>` to read them.
```

Command: `python3 .retest/licence-wording/guard.py node --conditions=retest-source src/cli/main.ts help licences`. Exit 0. Log `.retest/licence-wording/logs/licences-help.log`.

```text
Usage
  retest licences [engine]

With no engine, lists the pinned builds that carry licence notices.
Name an engine to print its notice texts, followed by its source and any patches pointers.
Reads the installed build, or the notices shipped with Retest when the build is not installed.
Checks the notice bytes before printing them. Missing or changed files are named.
If a notice ships only in the build, install that build to read it here. Nothing is downloaded.

Options
  -h, --help                Show this help

Exit codes: 0 all notice texts are available, 2 a notice cannot be read or the engine is unknown, 130 interrupted, 143 stopped by SIGTERM.
```

Command: `python3 .retest/licence-wording/guard.py env HOME=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home node --conditions=retest-source src/cli/main.ts licences webkit`. Exit 2. Log `.retest/licence-wording/logs/licences-webkit.log`.

<details>
<summary>Complete captured output</summary>

```text
Licence notices for WebKit (Playwright build) 26.6 (build 2359) (mac-arm64)

--- licenses/WebKit-LGPL-2.1.txt (LGPL-2.1) ---
                  GNU LESSER GENERAL PUBLIC LICENSE
                       Version 2.1, February 1999

 Copyright (C) 1991, 1999 Free Software Foundation, Inc.
 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

[This is the first released version of the Lesser GPL.  It also counts
 as the successor of the GNU Library Public License, version 2, hence
 the version number 2.1.]

                            Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
Licenses are intended to guarantee your freedom to share and change
free software--to make sure the software is free for all its users.

  This license, the Lesser General Public License, applies to some
specially designated software packages--typically libraries--of the
Free Software Foundation and other authors who decide to use it.  You
can use it too, but we suggest you first think carefully about whether
this license or the ordinary General Public License is the better
strategy to use in any particular case, based on the explanations below.

  When we speak of free software, we are referring to freedom of use,
not price.  Our General Public Licenses are designed to make sure that
you have the freedom to distribute copies of free software (and charge
for this service if you wish); that you receive source code or can get
it if you want it; that you can change the software and use pieces of
it in new free programs; and that you are informed that you can do
these things.

  To protect your rights, we need to make restrictions that forbid
distributors to deny you these rights or to ask you to surrender these
rights.  These restrictions translate to certain responsibilities for
you if you distribute copies of the library or if you modify it.

  For example, if you distribute copies of the library, whether gratis
or for a fee, you must give the recipients all the rights that we gave
you.  You must make sure that they, too, receive or can get the source
code.  If you link other code with the library, you must provide
complete object files to the recipients, so that they can relink them
with the library after making changes to the library and recompiling
it.  And you must show them these terms so they know their rights.

  We protect your rights with a two-step method: (1) we copyright the
library, and (2) we offer you this license, which gives you legal
permission to copy, distribute and/or modify the library.

  To protect each distributor, we want to make it very clear that
there is no warranty for the free library.  Also, if the library is
modified by someone else and passed on, the recipients should know
that what they have is not the original version, so that the original
author's reputation will not be affected by problems that might be
introduced by others.


  Finally, software patents pose a constant threat to the existence of
any free program.  We wish to make sure that a company cannot
effectively restrict the users of a free program by obtaining a
restrictive license from a patent holder.  Therefore, we insist that
any patent license obtained for a version of the library must be
consistent with the full freedom of use specified in this license.

  Most GNU software, including some libraries, is covered by the
ordinary GNU General Public License.  This license, the GNU Lesser
General Public License, applies to certain designated libraries, and
is quite different from the ordinary General Public License.  We use
this license for certain libraries in order to permit linking those
libraries into non-free programs.

  When a program is linked with a library, whether statically or using
a shared library, the combination of the two is legally speaking a
combined work, a derivative of the original library.  The ordinary
General Public License therefore permits such linking only if the
entire combination fits its criteria of freedom.  The Lesser General
Public License permits more lax criteria for linking other code with
the library.

  We call this license the "Lesser" General Public License because it
does Less to protect the user's freedom than the ordinary General
Public License.  It also provides other free software developers Less
of an advantage over competing non-free programs.  These disadvantages
are the reason we use the ordinary General Public License for many
libraries.  However, the Lesser license provides advantages in certain
special circumstances.

  For example, on rare occasions, there may be a special need to
encourage the widest possible use of a certain library, so that it becomes
a de-facto standard.  To achieve this, non-free programs must be
allowed to use the library.  A more frequent case is that a free
library does the same job as widely used non-free libraries.  In this
case, there is little to gain by limiting the free library to free
software only, so we use the Lesser General Public License.

  In other cases, permission to use a particular library in non-free
programs enables a greater number of people to use a large body of
free software.  For example, permission to use the GNU C Library in
non-free programs enables many more people to use the whole GNU
operating system, as well as its variant, the GNU/Linux operating
system.

  Although the Lesser General Public License is Less protective of the
users' freedom, it does ensure that the user of a program that is
linked with the Library has the freedom and the wherewithal to run
that program using a modified version of the Library.

  The precise terms and conditions for copying, distribution and
modification follow.  Pay close attention to the difference between a
"work based on the library" and a "work that uses the library".  The
former contains code derived from the library, whereas the latter must
be combined with the library in order to run.


                  GNU LESSER GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License Agreement applies to any software library or other
program which contains a notice placed by the copyright holder or
other authorized party saying it may be distributed under the terms of
this Lesser General Public License (also called "this License").
Each licensee is addressed as "you".

  A "library" means a collection of software functions and/or data
prepared so as to be conveniently linked with application programs
(which use some of those functions and data) to form executables.

  The "Library", below, refers to any such software library or work
which has been distributed under these terms.  A "work based on the
Library" means either the Library or any derivative work under
copyright law: that is to say, a work containing the Library or a
portion of it, either verbatim or with modifications and/or translated
straightforwardly into another language.  (Hereinafter, translation is
included without limitation in the term "modification".)

  "Source code" for a work means the preferred form of the work for
making modifications to it.  For a library, complete source code means
all the source code for all modules it contains, plus any associated
interface definition files, plus the scripts used to control compilation
and installation of the library.

  Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running a program using the Library is not restricted, and output from
such a program is covered only if its contents constitute a work based
on the Library (independent of the use of the Library in a tool for
writing it).  Whether that is true depends on what the Library does
and what the program that uses the Library does.

  1. You may copy and distribute verbatim copies of the Library's
complete source code as you receive it, in any medium, provided that
you conspicuously and appropriately publish on each copy an
appropriate copyright notice and disclaimer of warranty; keep intact
all the notices that refer to this License and to the absence of any
warranty; and distribute a copy of this License along with the
Library.

  You may charge a fee for the physical act of transferring a copy,
and you may at your option offer warranty protection in exchange for a
fee.


  2. You may modify your copy or copies of the Library or any portion
of it, thus forming a work based on the Library, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) The modified work must itself be a software library.

    b) You must cause the files modified to carry prominent notices
    stating that you changed the files and the date of any change.

    c) You must cause the whole of the work to be licensed at no
    charge to all third parties under the terms of this License.

    d) If a facility in the modified Library refers to a function or a
    table of data to be supplied by an application program that uses
    the facility, other than as an argument passed when the facility
    is invoked, then you must make a good faith effort to ensure that,
    in the event an application does not supply such function or
    table, the facility still operates, and performs whatever part of
    its purpose remains meaningful.

    (For example, a function in a library to compute square roots has
    a purpose that is entirely well-defined independent of the
    application.  Therefore, Subsection 2d requires that any
    application-supplied function or table used by this function must
    be optional: if the application does not supply it, the square
    root function must still compute square roots.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Library,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Library, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote
it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Library.

In addition, mere aggregation of another work not based on the Library
with the Library (or with a work based on the Library) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may opt to apply the terms of the ordinary GNU General Public
License instead of this License to a given copy of the Library.  To do
this, you must alter all the notices that refer to this License, so
that they refer to the ordinary GNU General Public License, version 2,
instead of to this License.  (If a newer version than version 2 of the
ordinary GNU General Public License has appeared, then you can specify
that version instead if you wish.)  Do not make any other change in
these notices.


  Once this change is made in a given copy, it is irreversible for
that copy, so the ordinary GNU General Public License applies to all
subsequent copies and derivative works made from that copy.

  This option is useful when you wish to copy part of the code of
the Library into a program that is not a library.

  4. You may copy and distribute the Library (or a portion or
derivative of it, under Section 2) in object code or executable form
under the terms of Sections 1 and 2 above provided that you accompany
it with the complete corresponding machine-readable source code, which
must be distributed under the terms of Sections 1 and 2 above on a
medium customarily used for software interchange.

  If distribution of object code is made by offering access to copy
from a designated place, then offering equivalent access to copy the
source code from the same place satisfies the requirement to
distribute the source code, even though third parties are not
compelled to copy the source along with the object code.

  5. A program that contains no derivative of any portion of the
Library, but is designed to work with the Library by being compiled or
linked with it, is called a "work that uses the Library".  Such a
work, in isolation, is not a derivative work of the Library, and
therefore falls outside the scope of this License.

  However, linking a "work that uses the Library" with the Library
creates an executable that is a derivative of the Library (because it
contains portions of the Library), rather than a "work that uses the
library".  The executable is therefore covered by this License.
Section 6 states terms for distribution of such executables.

  When a "work that uses the Library" uses material from a header file
that is part of the Library, the object code for the work may be a
derivative work of the Library even though the source code is not.
Whether this is true is especially significant if the work can be
linked without the Library, or if the work is itself a library.  The
threshold for this to be true is not precisely defined by law.

  If such an object file uses only numerical parameters, data
structure layouts and accessors, and small macros and small inline
functions (ten lines or less in length), then the use of the object
file is unrestricted, regardless of whether it is legally a derivative
work.  (Executables containing this object code plus portions of the
Library will still fall under Section 6.)

  Otherwise, if the work is a derivative of the Library, you may
distribute the object code for the work under the terms of Section 6.
Any executables containing that work also fall under Section 6,
whether or not they are linked directly with the Library itself.


  6. As an exception to the Sections above, you may also combine or
link a "work that uses the Library" with the Library to produce a
work containing portions of the Library, and distribute that work
under terms of your choice, provided that the terms permit
modification of the work for the customer's own use and reverse
engineering for debugging such modifications.

  You must give prominent notice with each copy of the work that the
Library is used in it and that the Library and its use are covered by
this License.  You must supply a copy of this License.  If the work
during execution displays copyright notices, you must include the
copyright notice for the Library among them, as well as a reference
directing the user to the copy of this License.  Also, you must do one
of these things:

    a) Accompany the work with the complete corresponding
    machine-readable source code for the Library including whatever
    changes were used in the work (which must be distributed under
    Sections 1 and 2 above); and, if the work is an executable linked
    with the Library, with the complete machine-readable "work that
    uses the Library", as object code and/or source code, so that the
    user can modify the Library and then relink to produce a modified
    executable containing the modified Library.  (It is understood
    that the user who changes the contents of definitions files in the
    Library will not necessarily be able to recompile the application
    to use the modified definitions.)

    b) Use a suitable shared library mechanism for linking with the
    Library.  A suitable mechanism is one that (1) uses at run time a
    copy of the library already present on the user's computer system,
    rather than copying library functions into the executable, and (2)
    will operate properly with a modified version of the library, if
    the user installs one, as long as the modified version is
    interface-compatible with the version that the work was made with.

    c) Accompany the work with a written offer, valid for at
    least three years, to give the same user the materials
    specified in Subsection 6a, above, for a charge no more
    than the cost of performing this distribution.

    d) If distribution of the work is made by offering access to copy
    from a designated place, offer equivalent access to copy the above
    specified materials from the same place.

    e) Verify that the user has already received a copy of these
    materials or that you have already sent this user a copy.

  For an executable, the required form of the "work that uses the
Library" must include any data and utility programs needed for
reproducing the executable from it.  However, as a special exception,
the materials to be distributed need not include anything that is
normally distributed (in either source or binary form) with the major
components (compiler, kernel, and so on) of the operating system on
which the executable runs, unless that component itself accompanies
the executable.

  It may happen that this requirement contradicts the license
restrictions of other proprietary libraries that do not normally
accompany the operating system.  Such a contradiction means you cannot
use both them and the Library together in an executable that you
distribute.


  7. You may place library facilities that are a work based on the
Library side-by-side in a single library together with other library
facilities not covered by this License, and distribute such a combined
library, provided that the separate distribution of the work based on
the Library and of the other library facilities is otherwise
permitted, and provided that you do these two things:

    a) Accompany the combined library with a copy of the same work
    based on the Library, uncombined with any other library
    facilities.  This must be distributed under the terms of the
    Sections above.

    b) Give prominent notice with the combined library of the fact
    that part of it is a work based on the Library, and explaining
    where to find the accompanying uncombined form of the same work.

  8. You may not copy, modify, sublicense, link with, or distribute
the Library except as expressly provided under this License.  Any
attempt otherwise to copy, modify, sublicense, link with, or
distribute the Library is void, and will automatically terminate your
rights under this License.  However, parties who have received copies,
or rights, from you under this License will not have their licenses
terminated so long as such parties remain in full compliance.

  9. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Library or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Library (or any work based on the
Library), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Library or works based on it.

  10. Each time you redistribute the Library (or any work based on the
Library), the recipient automatically receives a license from the
original licensor to copy, distribute, link with or modify the Library
subject to these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties with
this License.


  11. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Library at all.  For example, if a patent
license would not permit royalty-free redistribution of the Library by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Library.

If any portion of this section is held invalid or unenforceable under any
particular circumstance, the balance of the section is intended to apply,
and the section as a whole is intended to apply in other circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  12. If the distribution and/or use of the Library is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Library under this License may add
an explicit geographical distribution limitation excluding those countries,
so that distribution is permitted only in or among countries not thus
excluded.  In such case, this License incorporates the limitation as if
written in the body of this License.

  13. The Free Software Foundation may publish revised and/or new
versions of the Lesser General Public License from time to time.
Such new versions will be similar in spirit to the present version,
but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Library
specifies a version number of this License which applies to it and
"any later version", you have the option of following the terms and
conditions either of that version or of any later version published by
the Free Software Foundation.  If the Library does not specify a
license version number, you may choose any version ever published by
the Free Software Foundation.


  14. If you wish to incorporate parts of the Library into other free
programs whose distribution conditions are incompatible with these,
write to the author to ask for permission.  For software which is
copyrighted by the Free Software Foundation, write to the Free
Software Foundation; we sometimes make exceptions for this.  Our
decision will be guided by the two goals of preserving the free status
of all derivatives of our free software and of promoting the sharing
and reuse of software generally.

                            NO WARRANTY

  15. BECAUSE THE LIBRARY IS LICENSED FREE OF CHARGE, THERE IS NO
WARRANTY FOR THE LIBRARY, TO THE EXTENT PERMITTED BY APPLICABLE LAW.
EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR
OTHER PARTIES PROVIDE THE LIBRARY "AS IS" WITHOUT WARRANTY OF ANY
KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE
LIBRARY IS WITH YOU.  SHOULD THE LIBRARY PROVE DEFECTIVE, YOU ASSUME
THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

  16. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY
AND/OR REDISTRIBUTE THE LIBRARY AS PERMITTED ABOVE, BE LIABLE TO YOU
FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE
LIBRARY (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A
FAILURE OF THE LIBRARY TO OPERATE WITH ANY OTHER SOFTWARE), EVEN IF
SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

                     END OF TERMS AND CONDITIONS


           How to Apply These Terms to Your New Libraries

  If you develop a new library, and you want it to be of the greatest
possible use to the public, we recommend making it free software that
everyone can redistribute and change.  You can do so by permitting
redistribution under these terms (or, alternatively, under the terms of the
ordinary General Public License).

  To apply these terms, attach the following notices to the library.  It is
safest to attach them to the start of each source file to most effectively
convey the exclusion of warranty; and each file should have at least the
"copyright" line and a pointer to where the full notice is found.

    <one line to give the library's name and a brief idea of what it does.>
    Copyright (C) <year>  <name of author>

    This library is free software; you can redistribute it and/or
    modify it under the terms of the GNU Lesser General Public
    License as published by the Free Software Foundation; either
    version 2.1 of the License, or (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
    Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public
    License along with this library; if not, write to the Free Software
    Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA

Also add information on how to contact you by electronic and paper mail.

You should also get your employer (if you work as a programmer) or your
school, if any, to sign a "copyright disclaimer" for the library, if
necessary.  Here is a sample; alter the names:

  Yoyodyne, Inc., hereby disclaims all copyright interest in the
  library `Frob' (a library for tweaking knobs) written by James Random Hacker.

  <signature of Ty Coon>, 1 April 1990
  Ty Coon, President of Vice

That's all there is to it!

--- licenses/WebKit-BSD-2-Clause.txt (BSD-2-Clause) ---
/*
 * Copyright (C) 2014-2021 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS''
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

Additional WebKit copyright and licence notices retained from the cached Chromium notice bundle:

(WebKit doesn't distribute an explicit license.  This LICENSE is derived from
license text in the source.)

Copyright (c) 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005,
2006, 2007 Alexander Kellett, Alexey Proskuryakov, Alex Mathews, Allan
Sandfeld Jensen, Alp Toker, Anders Carlsson, Andrew Wellington, Antti
Koivisto, Apple Inc., Arthur Langereis, Baron Schwartz, Bjoern Graf,
Brent Fulgham, Cameron Zwarich, Charles Samuels, Christian Dywan,
Collabora Ltd., Cyrus Patel, Daniel Molkentin, Dave Maclachlan, David
Smith, Dawit Alemayehu, Dirk Mueller, Dirk Schulze, Don Gibson, Enrico
Ros, Eric Seidel, Frederik Holljen, Frerich Raabe, Friedmann Kleint,
George Staikos, Google Inc., Graham Dennis, Harri Porten, Henry Mason,
Hiroyuki Ikezoe, Holger Hans Peter Freyther, IBM, James G. Speth, Jan
Alonzo, Jean-Loup Gailly, John Reis, Jonas Witt, Jon Shier, Jonas
Witt, Julien Chaffraix, Justin Haygood, Kevin Ollivier, Kevin Watters,
Kimmo Kinnunen, Kouhei Sutou, Krzysztof Kowalczyk, Lars Knoll, Luca
Bruno, Maks Orlovich, Malte Starostik, Mark Adler, Martin Jones,
Marvin Decker, Matt Lilek, Michael Emmel, Mitz Pettel, mozilla.org,
Netscape Communications Corporation, Nicholas Shanks, Nikolas
Zimmermann, Nokia, Oliver Hunt, Opened Hand, Paul Johnston, Peter
Kelly, Pioneer Research Center USA, Rich Moore, Rob Buis, Robin Dunn,
Ronald Tschalär, Samuel Weinig, Simon Hausmann, Staikos Computing
Services Inc., Stefan Schimanski, Symantec Corporation, The Dojo
Foundation, The Karbon Developers, Thomas Boyer, Tim Copperfield,
Tobias Anton, Torben Weis, Trolltech, University of Cambridge, Vaclav
Slavik, Waldo Bastian, Xan Lopez, Zack Rusin

The terms and conditions vary from file to file, but are one of:

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

*OR*

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.
3. Neither the name of Apple Computer, Inc. ("Apple") nor the names of
   its contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY APPLE COMPUTER, INC. ``AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE COMPUTER, INC. OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY

OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


                  GNU LIBRARY GENERAL PUBLIC LICENSE
                       Version 2, June 1991

 Copyright (C) 1991 Free Software Foundation, Inc.
 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

[This is the first released version of the library GPL.  It is
 numbered 2 because it goes with version 2 of the ordinary GPL.]

                            Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
Licenses are intended to guarantee your freedom to share and change
free software--to make sure the software is free for all its users.

  This license, the Library General Public License, applies to some
specially designated Free Software Foundation software, and to any
other libraries whose authors decide to use it.  You can use it for
your libraries, too.

  When we speak of free software, we are referring to freedom, not
price.  Our General Public Licenses are designed to make sure that you
have the freedom to distribute copies of free software (and charge for
this service if you wish), that you receive source code or can get it
if you want it, that you can change the software or use pieces of it
in new free programs; and that you know you can do these things.

  To protect your rights, we need to make restrictions that forbid
anyone to deny you these rights or to ask you to surrender the rights.
These restrictions translate to certain responsibilities for you if
you distribute copies of the library, or if you modify it.

  For example, if you distribute copies of the library, whether gratis
or for a fee, you must give the recipients all the rights that we gave
you.  You must make sure that they, too, receive or can get the source
code.  If you link a program with the library, you must provide
complete object files to the recipients so that they can relink them
with the library, after making changes to the library and recompiling
it.  And you must show them these terms so they know their rights.

  Our method of protecting your rights has two steps: (1) copyright
the library, and (2) offer you this license which gives you legal
permission to copy, distribute and/or modify the library.

  Also, for each distributor's protection, we want to make certain
that everyone understands that there is no warranty for this free
library.  If the library is modified by someone else and passed on, we
want its recipients to know that what they have is not the original
version, so that any problems introduced by others will not reflect on
the original authors' reputations.


  Finally, any free program is threatened constantly by software
patents.  We wish to avoid the danger that companies distributing free
software will individually obtain patent licenses, thus in effect
transforming the program into proprietary software.  To prevent this,
we have made it clear that any patent must be licensed for everyone's
free use or not licensed at all.

  Most GNU software, including some libraries, is covered by the ordinary
GNU General Public License, which was designed for utility programs.  This
license, the GNU Library General Public License, applies to certain
designated libraries.  This license is quite different from the ordinary
one; be sure to read it in full, and don't assume that anything in it is
the same as in the ordinary license.

  The reason we have a separate public license for some libraries is that
they blur the distinction we usually make between modifying or adding to a
program and simply using it.  Linking a program with a library, without
changing the library, is in some sense simply using the library, and is
analogous to running a utility program or application program.  However, in
a textual and legal sense, the linked executable is a combined work, a
derivative of the original library, and the ordinary General Public License
treats it as such.

  Because of this blurred distinction, using the ordinary General
Public License for libraries did not effectively promote software
sharing, because most developers did not use the libraries.  We
concluded that weaker conditions might promote sharing better.

  However, unrestricted linking of non-free programs would deprive the
users of those programs of all benefit from the free status of the
libraries themselves.  This Library General Public License is intended to
permit developers of non-free programs to use free libraries, while
preserving your freedom as a user of such programs to change the free
libraries that are incorporated in them.  (We have not seen how to achieve
this as regards changes in header files, but we have achieved it as regards
changes in the actual functions of the Library.)  The hope is that this
will lead to faster development of free libraries.

  The precise terms and conditions for copying, distribution and
modification follow.  Pay close attention to the difference between a
"work based on the library" and a "work that uses the library".  The
former contains code derived from the library, while the latter only
works together with the library.

  Note that it is possible for a library to be covered by the ordinary
General Public License rather than by this special one.


                  GNU LIBRARY GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License Agreement applies to any software library which
contains a notice placed by the copyright holder or other authorized
party saying it may be distributed under the terms of this Library
General Public License (also called "this License").  Each licensee is
addressed as "you".

  A "library" means a collection of software functions and/or data
prepared so as to be conveniently linked with application programs
(which use some of those functions and data) to form executables.

  The "Library", below, refers to any such software library or work
which has been distributed under these terms.  A "work based on the
Library" means either the Library or any derivative work under
copyright law: that is to say, a work containing the Library or a
portion of it, either verbatim or with modifications and/or translated
straightforwardly into another language.  (Hereinafter, translation is
included without limitation in the term "modification".)

  "Source code" for a work means the preferred form of the work for
making modifications to it.  For a library, complete source code means
all the source code for all modules it contains, plus any associated
interface definition files, plus the scripts used to control compilation
and installation of the library.

  Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running a program using the Library is not restricted, and output from
such a program is covered only if its contents constitute a work based
on the Library (independent of the use of the Library in a tool for
writing it).  Whether that is true depends on what the Library does
and what the program that uses the Library does.

  1. You may copy and distribute verbatim copies of the Library's
complete source code as you receive it, in any medium, provided that
you conspicuously and appropriately publish on each copy an
appropriate copyright notice and disclaimer of warranty; keep intact
all the notices that refer to this License and to the absence of any
warranty; and distribute a copy of this License along with the
Library.

  You may charge a fee for the physical act of transferring a copy,
and you may at your option offer warranty protection in exchange for a
fee.


  2. You may modify your copy or copies of the Library or any portion
of it, thus forming a work based on the Library, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) The modified work must itself be a software library.

    b) You must cause the files modified to carry prominent notices
    stating that you changed the files and the date of any change.

    c) You must cause the whole of the work to be licensed at no
    charge to all third parties under the terms of this License.

    d) If a facility in the modified Library refers to a function or a
    table of data to be supplied by an application program that uses
    the facility, other than as an argument passed when the facility
    is invoked, then you must make a good faith effort to ensure that,
    in the event an application does not supply such function or
    table, the facility still operates, and performs whatever part of
    its purpose remains meaningful.

    (For example, a function in a library to compute square roots has
    a purpose that is entirely well-defined independent of the
    application.  Therefore, Subsection 2d requires that any
    application-supplied function or table used by this function must
    be optional: if the application does not supply it, the square
    root function must still compute square roots.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Library,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Library, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote
it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Library.

In addition, mere aggregation of another work not based on the Library
with the Library (or with a work based on the Library) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may opt to apply the terms of the ordinary GNU General Public
License instead of this License to a given copy of the Library.  To do
this, you must alter all the notices that refer to this License, so
that they refer to the ordinary GNU General Public License, version 2,
instead of to this License.  (If a newer version than version 2 of the
ordinary GNU General Public License has appeared, then you can specify
that version instead if you wish.)  Do not make any other change in
these notices.


  Once this change is made in a given copy, it is irreversible for
that copy, so the ordinary GNU General Public License applies to all
subsequent copies and derivative works made from that copy.

  This option is useful when you wish to copy part of the code of
the Library into a program that is not a library.

  4. You may copy and distribute the Library (or a portion or
derivative of it, under Section 2) in object code or executable form
under the terms of Sections 1 and 2 above provided that you accompany
it with the complete corresponding machine-readable source code, which
must be distributed under the terms of Sections 1 and 2 above on a
medium customarily used for software interchange.

  If distribution of object code is made by offering access to copy
from a designated place, then offering equivalent access to copy the
source code from the same place satisfies the requirement to
distribute the source code, even though third parties are not
compelled to copy the source along with the object code.

  5. A program that contains no derivative of any portion of the
Library, but is designed to work with the Library by being compiled or
linked with it, is called a "work that uses the Library".  Such a
work, in isolation, is not a derivative work of the Library, and
therefore falls outside the scope of this License.

  However, linking a "work that uses the Library" with the Library
creates an executable that is a derivative of the Library (because it
contains portions of the Library), rather than a "work that uses the
library".  The executable is therefore covered by this License.
Section 6 states terms for distribution of such executables.

  When a "work that uses the Library" uses material from a header file
that is part of the Library, the object code for the work may be a
derivative work of the Library even though the source code is not.
Whether this is true is especially significant if the work can be
linked without the Library, or if the work is itself a library.  The
threshold for this to be true is not precisely defined by law.

  If such an object file uses only numerical parameters, data
structure layouts and accessors, and small macros and small inline
functions (ten lines or less in length), then the use of the object
file is unrestricted, regardless of whether it is legally a derivative
work.  (Executables containing this object code plus portions of the
Library will still fall under Section 6.)

  Otherwise, if the work is a derivative of the Library, you may
distribute the object code for the work under the terms of Section 6.
Any executables containing that work also fall under Section 6,
whether or not they are linked directly with the Library itself.


  6. As an exception to the Sections above, you may also compile or
link a "work that uses the Library" with the Library to produce a
work containing portions of the Library, and distribute that work
under terms of your choice, provided that the terms permit
modification of the work for the customer's own use and reverse
engineering for debugging such modifications.

  You must give prominent notice with each copy of the work that the
Library is used in it and that the Library and its use are covered by
this License.  You must supply a copy of this License.  If the work
during execution displays copyright notices, you must include the
copyright notice for the Library among them, as well as a reference
directing the user to the copy of this License.  Also, you must do one
of these things:

    a) Accompany the work with the complete corresponding
    machine-readable source code for the Library including whatever
    changes were used in the work (which must be distributed under
    Sections 1 and 2 above); and, if the work is an executable linked
    with the Library, with the complete machine-readable "work that
    uses the Library", as object code and/or source code, so that the
    user can modify the Library and then relink to produce a modified
    executable containing the modified Library.  (It is understood
    that the user who changes the contents of definitions files in the
    Library will not necessarily be able to recompile the application
    to use the modified definitions.)

    b) Accompany the work with a written offer, valid for at
    least three years, to give the same user the materials
    specified in Subsection 6a, above, for a charge no more
    than the cost of performing this distribution.

    c) If distribution of the work is made by offering access to copy
    from a designated place, offer equivalent access to copy the above
    specified materials from the same place.

    d) Verify that the user has already received a copy of these
    materials or that you have already sent this user a copy.

  For an executable, the required form of the "work that uses the
Library" must include any data and utility programs needed for
reproducing the executable from it.  However, as a special exception,
the source code distributed need not include anything that is normally
distributed (in either source or binary form) with the major
components (compiler, kernel, and so on) of the operating system on
which the executable runs, unless that component itself accompanies
the executable.

  It may happen that this requirement contradicts the license
restrictions of other proprietary libraries that do not normally
accompany the operating system.  Such a contradiction means you cannot
use both them and the Library together in an executable that you
distribute.


  7. You may place library facilities that are a work based on the
Library side-by-side in a single library together with other library
facilities not covered by this License, and distribute such a combined
library, provided that the separate distribution of the work based on
the Library and of the other library facilities is otherwise
permitted, and provided that you do these two things:

    a) Accompany the combined library with a copy of the same work
    based on the Library, uncombined with any other library
    facilities.  This must be distributed under the terms of the
    Sections above.

    b) Give prominent notice with the combined library of the fact
    that part of it is a work based on the Library, and explaining
    where to find the accompanying uncombined form of the same work.

  8. You may not copy, modify, sublicense, link with, or distribute
the Library except as expressly provided under this License.  Any
attempt otherwise to copy, modify, sublicense, link with, or
distribute the Library is void, and will automatically terminate your
rights under this License.  However, parties who have received copies,
or rights, from you under this License will not have their licenses
terminated so long as such parties remain in full compliance.

  9. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Library or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Library (or any work based on the
Library), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Library or works based on it.

  10. Each time you redistribute the Library (or any work based on the
Library), the recipient automatically receives a license from the
original licensor to copy, distribute, link with or modify the Library
subject to these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties to
this License.


  11. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Library at all.  For example, if a patent
license would not permit royalty-free redistribution of the Library by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Library.

If any portion of this section is held invalid or unenforceable under any
particular circumstance, the balance of the section is intended to apply,
and the section as a whole is intended to apply in other circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  12. If the distribution and/or use of the Library is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Library under this License may add
an explicit geographical distribution limitation excluding those countries,
so that distribution is permitted only in or among countries not thus
excluded.  In such case, this License incorporates the limitation as if
written in the body of this License.

  13. The Free Software Foundation may publish revised and/or new
versions of the Library General Public License from time to time.
Such new versions will be similar in spirit to the present version,
but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Library
specifies a version number of this License which applies to it and
"any later version", you have the option of following the terms and
conditions either of that version or of any later version published by
the Free Software Foundation.  If the Library does not specify a
license version number, you may choose any version ever published by
the Free Software Foundation.


  14. If you wish to incorporate parts of the Library into other free
programs whose distribution conditions are incompatible with these,
write to the author to ask for permission.  For software which is
copyrighted by the Free Software Foundation, write to the Free
Software Foundation; we sometimes make exceptions for this.  Our
decision will be guided by the two goals of preserving the free status
of all derivatives of our free software and of promoting the sharing
and reuse of software generally.

                            NO WARRANTY

  15. BECAUSE THE LIBRARY IS LICENSED FREE OF CHARGE, THERE IS NO
WARRANTY FOR THE LIBRARY, TO THE EXTENT PERMITTED BY APPLICABLE LAW.
EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR
OTHER PARTIES PROVIDE THE LIBRARY "AS IS" WITHOUT WARRANTY OF ANY
KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE
LIBRARY IS WITH YOU.  SHOULD THE LIBRARY PROVE DEFECTIVE, YOU ASSUME
THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

  16. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY
AND/OR REDISTRIBUTE THE LIBRARY AS PERMITTED ABOVE, BE LIABLE TO YOU
FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE
LIBRARY (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A
FAILURE OF THE LIBRARY TO OPERATE WITH ANY OTHER SOFTWARE), EVEN IF
SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

                     END OF TERMS AND CONDITIONS

                  GNU LESSER GENERAL PUBLIC LICENSE
                       Version 2.1, February 1999

 Copyright (C) 1991, 1999 Free Software Foundation, Inc.
 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

[This is the first released version of the Lesser GPL.  It also counts
 as the successor of the GNU Library Public License, version 2, hence
 the version number 2.1.]

                            Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
Licenses are intended to guarantee your freedom to share and change
free software--to make sure the software is free for all its users.

  This license, the Lesser General Public License, applies to some
specially designated software packages--typically libraries--of the
Free Software Foundation and other authors who decide to use it.  You
can use it too, but we suggest you first think carefully about whether
this license or the ordinary General Public License is the better
strategy to use in any particular case, based on the explanations below.

  When we speak of free software, we are referring to freedom of use,
not price.  Our General Public Licenses are designed to make sure that
you have the freedom to distribute copies of free software (and charge
for this service if you wish); that you receive source code or can get
it if you want it; that you can change the software and use pieces of
it in new free programs; and that you are informed that you can do
these things.

  To protect your rights, we need to make restrictions that forbid
distributors to deny you these rights or to ask you to surrender these
rights.  These restrictions translate to certain responsibilities for
you if you distribute copies of the library or if you modify it.

  For example, if you distribute copies of the library, whether gratis
or for a fee, you must give the recipients all the rights that we gave
you.  You must make sure that they, too, receive or can get the source
code.  If you link other code with the library, you must provide
complete object files to the recipients, so that they can relink them
with the library after making changes to the library and recompiling
it.  And you must show them these terms so they know their rights.

  We protect your rights with a two-step method: (1) we copyright the
library, and (2) we offer you this license, which gives you legal
permission to copy, distribute and/or modify the library.

  To protect each distributor, we want to make it very clear that
there is no warranty for the free library.  Also, if the library is
modified by someone else and passed on, the recipients should know
that what they have is not the original version, so that the original
author's reputation will not be affected by problems that might be
introduced by others.


  Finally, software patents pose a constant threat to the existence of
any free program.  We wish to make sure that a company cannot
effectively restrict the users of a free program by obtaining a
restrictive license from a patent holder.  Therefore, we insist that
any patent license obtained for a version of the library must be
consistent with the full freedom of use specified in this license.

  Most GNU software, including some libraries, is covered by the
ordinary GNU General Public License.  This license, the GNU Lesser
General Public License, applies to certain designated libraries, and
is quite different from the ordinary General Public License.  We use
this license for certain libraries in order to permit linking those
libraries into non-free programs.

  When a program is linked with a library, whether statically or using
a shared library, the combination of the two is legally speaking a
combined work, a derivative of the original library.  The ordinary
General Public License therefore permits such linking only if the
entire combination fits its criteria of freedom.  The Lesser General
Public License permits more lax criteria for linking other code with
the library.

  We call this license the "Lesser" General Public License because it
does Less to protect the user's freedom than the ordinary General
Public License.  It also provides other free software developers Less
of an advantage over competing non-free programs.  These disadvantages
are the reason we use the ordinary General Public License for many
libraries.  However, the Lesser license provides advantages in certain
special circumstances.

  For example, on rare occasions, there may be a special need to
encourage the widest possible use of a certain library, so that it becomes
a de-facto standard.  To achieve this, non-free programs must be
allowed to use the library.  A more frequent case is that a free
library does the same job as widely used non-free libraries.  In this
case, there is little to gain by limiting the free library to free
software only, so we use the Lesser General Public License.

  In other cases, permission to use a particular library in non-free
programs enables a greater number of people to use a large body of
free software.  For example, permission to use the GNU C Library in
non-free programs enables many more people to use the whole GNU
operating system, as well as its variant, the GNU/Linux operating
system.

  Although the Lesser General Public License is Less protective of the
users' freedom, it does ensure that the user of a program that is
linked with the Library has the freedom and the wherewithal to run
that program using a modified version of the Library.

  The precise terms and conditions for copying, distribution and
modification follow.  Pay close attention to the difference between a
"work based on the library" and a "work that uses the library".  The
former contains code derived from the library, whereas the latter must
be combined with the library in order to run.


                  GNU LESSER GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License Agreement applies to any software library or other
program which contains a notice placed by the copyright holder or
other authorized party saying it may be distributed under the terms of
this Lesser General Public License (also called "this License").
Each licensee is addressed as "you".

  A "library" means a collection of software functions and/or data
prepared so as to be conveniently linked with application programs
(which use some of those functions and data) to form executables.

  The "Library", below, refers to any such software library or work
which has been distributed under these terms.  A "work based on the
Library" means either the Library or any derivative work under
copyright law: that is to say, a work containing the Library or a
portion of it, either verbatim or with modifications and/or translated
straightforwardly into another language.  (Hereinafter, translation is
included without limitation in the term "modification".)

  "Source code" for a work means the preferred form of the work for
making modifications to it.  For a library, complete source code means
all the source code for all modules it contains, plus any associated
interface definition files, plus the scripts used to control compilation
and installation of the library.

  Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running a program using the Library is not restricted, and output from
such a program is covered only if its contents constitute a work based
on the Library (independent of the use of the Library in a tool for
writing it).  Whether that is true depends on what the Library does
and what the program that uses the Library does.

  1. You may copy and distribute verbatim copies of the Library's
complete source code as you receive it, in any medium, provided that
you conspicuously and appropriately publish on each copy an
appropriate copyright notice and disclaimer of warranty; keep intact
all the notices that refer to this License and to the absence of any
warranty; and distribute a copy of this License along with the
Library.

  You may charge a fee for the physical act of transferring a copy,
and you may at your option offer warranty protection in exchange for a
fee.


  2. You may modify your copy or copies of the Library or any portion
of it, thus forming a work based on the Library, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) The modified work must itself be a software library.

    b) You must cause the files modified to carry prominent notices
    stating that you changed the files and the date of any change.

    c) You must cause the whole of the work to be licensed at no
    charge to all third parties under the terms of this License.

    d) If a facility in the modified Library refers to a function or a
    table of data to be supplied by an application program that uses
    the facility, other than as an argument passed when the facility
    is invoked, then you must make a good faith effort to ensure that,
    in the event an application does not supply such function or
    table, the facility still operates, and performs whatever part of
    its purpose remains meaningful.

    (For example, a function in a library to compute square roots has
    a purpose that is entirely well-defined independent of the
    application.  Therefore, Subsection 2d requires that any
    application-supplied function or table used by this function must
    be optional: if the application does not supply it, the square
    root function must still compute square roots.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Library,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Library, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote
it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Library.

In addition, mere aggregation of another work not based on the Library
with the Library (or with a work based on the Library) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may opt to apply the terms of the ordinary GNU General Public
License instead of this License to a given copy of the Library.  To do
this, you must alter all the notices that refer to this License, so
that they refer to the ordinary GNU General Public License, version 2,
instead of to this License.  (If a newer version than version 2 of the
ordinary GNU General Public License has appeared, then you can specify
that version instead if you wish.)  Do not make any other change in
these notices.


  Once this change is made in a given copy, it is irreversible for
that copy, so the ordinary GNU General Public License applies to all
subsequent copies and derivative works made from that copy.

  This option is useful when you wish to copy part of the code of
the Library into a program that is not a library.

  4. You may copy and distribute the Library (or a portion or
derivative of it, under Section 2) in object code or executable form
under the terms of Sections 1 and 2 above provided that you accompany
it with the complete corresponding machine-readable source code, which
must be distributed under the terms of Sections 1 and 2 above on a
medium customarily used for software interchange.

  If distribution of object code is made by offering access to copy
from a designated place, then offering equivalent access to copy the
source code from the same place satisfies the requirement to
distribute the source code, even though third parties are not
compelled to copy the source along with the object code.

  5. A program that contains no derivative of any portion of the
Library, but is designed to work with the Library by being compiled or
linked with it, is called a "work that uses the Library".  Such a
work, in isolation, is not a derivative work of the Library, and
therefore falls outside the scope of this License.

  However, linking a "work that uses the Library" with the Library
creates an executable that is a derivative of the Library (because it
contains portions of the Library), rather than a "work that uses the
library".  The executable is therefore covered by this License.
Section 6 states terms for distribution of such executables.

  When a "work that uses the Library" uses material from a header file
that is part of the Library, the object code for the work may be a
derivative work of the Library even though the source code is not.
Whether this is true is especially significant if the work can be
linked without the Library, or if the work is itself a library.  The
threshold for this to be true is not precisely defined by law.

  If such an object file uses only numerical parameters, data
structure layouts and accessors, and small macros and small inline
functions (ten lines or less in length), then the use of the object
file is unrestricted, regardless of whether it is legally a derivative
work.  (Executables containing this object code plus portions of the
Library will still fall under Section 6.)

  Otherwise, if the work is a derivative of the Library, you may
distribute the object code for the work under the terms of Section 6.
Any executables containing that work also fall under Section 6,
whether or not they are linked directly with the Library itself.


  6. As an exception to the Sections above, you may also combine or
link a "work that uses the Library" with the Library to produce a
work containing portions of the Library, and distribute that work
under terms of your choice, provided that the terms permit
modification of the work for the customer's own use and reverse
engineering for debugging such modifications.

  You must give prominent notice with each copy of the work that the
Library is used in it and that the Library and its use are covered by
this License.  You must supply a copy of this License.  If the work
during execution displays copyright notices, you must include the
copyright notice for the Library among them, as well as a reference
directing the user to the copy of this License.  Also, you must do one
of these things:

    a) Accompany the work with the complete corresponding
    machine-readable source code for the Library including whatever
    changes were used in the work (which must be distributed under
    Sections 1 and 2 above); and, if the work is an executable linked
    with the Library, with the complete machine-readable "work that
    uses the Library", as object code and/or source code, so that the
    user can modify the Library and then relink to produce a modified
    executable containing the modified Library.  (It is understood
    that the user who changes the contents of definitions files in the
    Library will not necessarily be able to recompile the application
    to use the modified definitions.)

    b) Use a suitable shared library mechanism for linking with the
    Library.  A suitable mechanism is one that (1) uses at run time a
    copy of the library already present on the user's computer system,
    rather than copying library functions into the executable, and (2)
    will operate properly with a modified version of the library, if
    the user installs one, as long as the modified version is
    interface-compatible with the version that the work was made with.

    c) Accompany the work with a written offer, valid for at
    least three years, to give the same user the materials
    specified in Subsection 6a, above, for a charge no more
    than the cost of performing this distribution.

    d) If distribution of the work is made by offering access to copy
    from a designated place, offer equivalent access to copy the above
    specified materials from the same place.

    e) Verify that the user has already received a copy of these
    materials or that you have already sent this user a copy.

  For an executable, the required form of the "work that uses the
Library" must include any data and utility programs needed for
reproducing the executable from it.  However, as a special exception,
the materials to be distributed need not include anything that is
normally distributed (in either source or binary form) with the major
components (compiler, kernel, and so on) of the operating system on
which the executable runs, unless that component itself accompanies
the executable.

  It may happen that this requirement contradicts the license
restrictions of other proprietary libraries that do not normally
accompany the operating system.  Such a contradiction means you cannot
use both them and the Library together in an executable that you
distribute.


  7. You may place library facilities that are a work based on the
Library side-by-side in a single library together with other library
facilities not covered by this License, and distribute such a combined
library, provided that the separate distribution of the work based on
the Library and of the other library facilities is otherwise
permitted, and provided that you do these two things:

    a) Accompany the combined library with a copy of the same work
    based on the Library, uncombined with any other library
    facilities.  This must be distributed under the terms of the
    Sections above.

    b) Give prominent notice with the combined library of the fact
    that part of it is a work based on the Library, and explaining
    where to find the accompanying uncombined form of the same work.

  8. You may not copy, modify, sublicense, link with, or distribute
the Library except as expressly provided under this License.  Any
attempt otherwise to copy, modify, sublicense, link with, or
distribute the Library is void, and will automatically terminate your
rights under this License.  However, parties who have received copies,
or rights, from you under this License will not have their licenses
terminated so long as such parties remain in full compliance.

  9. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Library or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Library (or any work based on the
Library), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Library or works based on it.

  10. Each time you redistribute the Library (or any work based on the
Library), the recipient automatically receives a license from the
original licensor to copy, distribute, link with or modify the Library
subject to these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties with
this License.


  11. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Library at all.  For example, if a patent
license would not permit royalty-free redistribution of the Library by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Library.

If any portion of this section is held invalid or unenforceable under any
particular circumstance, the balance of the section is intended to apply,
and the section as a whole is intended to apply in other circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  12. If the distribution and/or use of the Library is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Library under this License may add
an explicit geographical distribution limitation excluding those countries,
so that distribution is permitted only in or among countries not thus
excluded.  In such case, this License incorporates the limitation as if
written in the body of this License.

  13. The Free Software Foundation may publish revised and/or new
versions of the Lesser General Public License from time to time.
Such new versions will be similar in spirit to the present version,
but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Library
specifies a version number of this License which applies to it and
"any later version", you have the option of following the terms and
conditions either of that version or of any later version published by
the Free Software Foundation.  If the Library does not specify a
license version number, you may choose any version ever published by
the Free Software Foundation.


  14. If you wish to incorporate parts of the Library into other free
programs whose distribution conditions are incompatible with these,
write to the author to ask for permission.  For software which is
copyrighted by the Free Software Foundation, write to the Free
Software Foundation; we sometimes make exceptions for this.  Our
decision will be guided by the two goals of preserving the free status
of all derivatives of our free software and of promoting the sharing
and reuse of software generally.

                            NO WARRANTY

  15. BECAUSE THE LIBRARY IS LICENSED FREE OF CHARGE, THERE IS NO
WARRANTY FOR THE LIBRARY, TO THE EXTENT PERMITTED BY APPLICABLE LAW.
EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR
OTHER PARTIES PROVIDE THE LIBRARY "AS IS" WITHOUT WARRANTY OF ANY
KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE
LIBRARY IS WITH YOU.  SHOULD THE LIBRARY PROVE DEFECTIVE, YOU ASSUME
THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

  16. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY
AND/OR REDISTRIBUTE THE LIBRARY AS PERMITTED ABOVE, BE LIABLE TO YOU
FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE
LIBRARY (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A
FAILURE OF THE LIBRARY TO OPERATE WITH ANY OTHER SOFTWARE), EVEN IF
SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

                     END OF TERMS AND CONDITIONS

--- licenses/ANGLE-LICENSE.txt (BSD-3-Clause) ---
// Copyright 2018 The ANGLE Project Authors.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
//     Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
//
//     Redistributions in binary form must reproduce the above
//     copyright notice, this list of conditions and the following
//     disclaimer in the documentation and/or other materials provided
//     with the distribution.
//
//     Neither the name of TransGaming Inc., Google Inc., 3DLabs Inc.
//     Ltd., nor the names of their contributors may be used to endorse
//     or promote products derived from this software without specific
//     prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
// FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
// COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
// INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
// BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
// LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
// ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

--- licenses/WebRTC-LICENSE.txt (BSD-3-Clause) ---
Copyright (c) 2011, The WebRTC project authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

--- licenses/BoringSSL-LICENSE.txt (Apache-2.0 AND OpenSSL AND ISC AND BSD-3-Clause) ---
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.


Licenses for support code
-------------------------

Parts of the TLS test suite are under the Go license. This code is not included
in BoringSSL (i.e. libcrypto and libssl) when compiled, however, so
distributing code linked against BoringSSL does not trigger this license:

Copyright (c) 2009 The Go Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Historical OpenSSL and SSLeay notices, retained for the WebKit build:

Copyright © 1999-2019, The OpenSSL Project.

The OpenSSL toolkit stays under a double license, i.e. both the conditions of the
OpenSSL License and the original SSLeay license apply to the toolkit. See below for
the actual license texts.

 Copyright (c) 1998-2019 The OpenSSL Project. All rights reserved.
Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of
conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
conditions and the following disclaimer in the documentation and/or other materials
provided with the distribution.
3. All advertising materials mentioning features or use of this software must display the
following acknowledgment: "This product includes software developed by the OpenSSL
Project for use in the OpenSSL Toolkit. (http://www.openssl.org/)"
4. The names "OpenSSL Toolkit" and "OpenSSL Project" must not be used to endorse
or promote products derived from this software without prior written permission. For
written permission, please contact openssl-core@openssl.org.
5. Products derived from this software may not be called "OpenSSL" nor may
"OpenSSL" appear in their names without prior written permission of the OpenSSL
Project.
6. Redistributions of any form whatsoever must retain the following acknowledgment:
"This product includes software developed by the OpenSSL Project for use in the
OpenSSL Toolkit (http://www.openssl.org/)"
THIS SOFTWARE IS PROVIDED BY THE OpenSSL PROJECT ``AS IS'' AND ANY
EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE OpenSSL
PROJECT OR ITS CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. This
product includes cryptographic software written by Eric Young (eay@cryptsoft.com).
This product includes software written by Tim Hudson (tjh@cryptsoft.com).

Original SSLeay License
Copyright (C) 1995-1998 Eric Young (eay@cryptsoft.com) All rights reserved.
This package is an SSL implementation written by Eric Young (eay@cryptsoft.com).
The implementation was written so as to conform with Netscapes SSL.
This library is free for commercial and non-commercial use as long as the following
conditions are aheared to. The following conditions apply to all code found in this
distribution, be it the RC4, RSA, lhash, DES, etc., code; not just the SSL code. The SSL
documentation included with this distribution is covered by the same copyright terms
except that the holder is Tim Hudson (tjh@cryptsoft.com).
Copyright remains Eric Young's, and as such any Copyright notices in the code are not
to be removed. If this package is used in a product, Eric Young should be given
attribution as the author of the parts of the library used. This can be in the form of a
textual message at program startup or in documentation (online or textual) provided with
the package.
Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:
1. Redistributions of source code must retain the copyright notice, this list of conditions
and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
conditions and the following disclaimer in the documentation and/or other materials
provided with the distribution.
3. All advertising materials mentioning features or use of this software must display the
following acknowledgement: "This product includes cryptographic software written by
Eric Young (eay@cryptsoft.com)" The word 'cryptographic' can be left out if the rouines
from the library being used are not cryptographic related :-).
4. If you include any Windows specific code (or a derivative thereof) from the apps
directory (application code) you must include an acknowledgement: "This product
includes software written by Tim Hudson (tjh@cryptsoft.com)"
THIS SOFTWARE IS PROVIDED BY ERIC YOUNG ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE AUTHOR OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE. The licence and distribution terms for any publically available version or
derivative of this code cannot be changed. i.e. this code cannot simply be copied and
put under another distribution licence [including the GNU Public Licence.]

ISC licence used for new code in BoringSSL
Copyright (c) 2015, Google Inc.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

--- licenses/abseil-cpp-LICENSE.txt (Apache-2.0) ---
Apache License
                           Version 2.0, January 2004
                        https://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       https://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

--- licenses/libvpx-LICENSE.txt (BSD-3-Clause) ---
Copyright (c) 2010, The WebM Project authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google, nor the WebM Project, nor the names
    of its contributors may be used to endorse or promote products
    derived from this software without specific prior written
    permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



Additional IP Rights Grant (Patents)
------------------------------------

"These implementations" means the copyrightable works that implement the WebM
codecs distributed by Google as part of the WebM Project.

Google hereby grants to you a perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable (except as stated in this section) patent license to
make, have made, use, offer to sell, sell, import, transfer, and otherwise
run, modify and propagate the contents of these implementations of WebM, where
such license applies only to those patent claims, both currently owned by
Google and acquired in the future, licensable by Google that are necessarily
infringed by these implementations of WebM. This grant does not include claims
that would be infringed only as a consequence of further modification of these
implementations. If you or your agent or exclusive licensee institute or order
or agree to the institution of patent litigation or any other patent
enforcement activity against any entity (including a cross-claim or
counterclaim in a lawsuit) alleging that any of these implementations of WebM
or any code incorporated within any of these implementations of WebM
constitute direct or contributory patent infringement, or inducement of
patent infringement, then any patent rights granted to you under this License
for these implementations of WebM shall terminate as of the date such
litigation is filed.

--- licenses/swiftCompatibilitySpan-LICENSE.txt (Apache-2.0 WITH Swift-exception) ---
Copyright © 2014-2015 Apple Inc. and the Swift project authors
Licensed under Apache License v2.0 with Runtime Library Exception.
See http://swift.org/LICENSE.txt for license information
See http://swift.org/CONTRIBUTORS.txt for the list of Swift project authors


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

Runtime Library Exception to the Apache 2.0 License
As an exception, if you use this Software to compile your source code and portions of
this Software are embedded into the binary product as a result, you may redistribute
such product without providing attribution as would otherwise be required by Sections
4(a), 4(b) and 4(d) of the License.

--- licenses/SOURCE.txt (LGPL-2.1) ---
WebKit 26.6, Playwright build 2359, macOS arm64

WebKit source revision named by Playwright v1.63.0 UPSTREAM_CONFIG.sh:
https://github.com/WebKit/WebKit/tree/4d05d732e5a84f32675bef4cc135a2e7a9269a87

Playwright patches and build scripts:
https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit
https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/webkit/UPSTREAM_CONFIG.sh
Playwright patches are covered by Apache-2.0:
https://github.com/microsoft/playwright/blob/v1.63.0/LICENSE

The WebKit proof read this revision from the tag's UPSTREAM_CONFIG.sh and
matched pw_run.sh byte for byte. It did not prove the exact source correspondence
of the published build 2359. These pointers retain that distinction.

Notice text provenance, inspected without a new download:
- WebKit-LGPL-2.1.txt: the standard GNU LGPL 2.1 text in the cached
  ms-playwright/ffmpeg-1011/COPYING.LGPLv2.1.
- WebKit-BSD-2-Clause.txt: WKWebView.h's BSD header in the actual cached
  webkit-2359/WebKit.framework/Versions/A/Headers, plus the complete collected
  WebKit copyright and licence entry in Electron 44.5.1 LICENSES.chromium.html.
- ANGLE-LICENSE.txt, WebRTC-LICENSE.txt, abseil-cpp-LICENSE.txt,
  libvpx-LICENSE.txt: each named component's entry in that cached Electron
  LICENSES.chromium.html, with all copyright notices and terms retained.
- BoringSSL-LICENSE.txt: that cached BoringSSL entry, plus the historical
  OpenSSL/SSLeay texts in the installed Xcode Acknowledgments.pdf and the
  standard BoringSSL ISC notice for new code. The legacy ISC notice is
  transcribed, not read from the binary's source checkout.
- swiftCompatibilitySpan-LICENSE.txt: Swift's copyright and source pointer,
  and the Runtime Library Exception, in the installed Xcode Acknowledgments.pdf,
  with the full standard Apache-2.0 text.

Upstream component source and licence locations within the named WebKit revision:
Source/ThirdParty/ANGLE/LICENSE
Source/ThirdParty/libwebrtc/Source/LICENSE
Source/ThirdParty/libwebrtc/Source/third_party/boringssl/src/LICENSE
Source/ThirdParty/libwebrtc/Source/third_party/abseil-cpp/LICENSE
Source/ThirdParty/libwebrtc/Source/third_party/libvpx/source/libvpx/LICENSE
Swift source and licence: https://github.com/swiftlang/swift and https://swift.org/LICENSE.txt

WebKit's archive SHA-256 remains unpinned. Retest refuses to download or install
this pin for that reason. The founder has not authorized an archive download.

Notice texts unavailable:
WebInspectorUI.framework/Versions/A/Resources/External/CodeMirror/LICENSE: notice text is available only with the installed build.
WebInspectorUI.framework/Versions/A/Resources/External/three.js/LICENSE: notice text is available only with the installed build.
WebInspectorUI.framework/Versions/A/Resources/External/Esprima/LICENSE: notice text is available only with the installed build.
WebInspectorUI.framework/Versions/A/Resources/External/CSSDocumentation/LICENSE: notice text is available only with the installed build.
Run `retest install webkit` to install the pinned build.

Source https://github.com/WebKit/WebKit/tree/4d05d732e5a84f32675bef4cc135a2e7a9269a87
Patches https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit
```

</details>

Command: `python3 .retest/licence-wording/guard.py node --conditions=retest-source src/cli/main.ts licences mac2`. Exit 0. Log `.retest/licence-wording/logs/licences-mac2.log`.

<details>
<summary>Complete captured output</summary>

```text
Licence notices for WebDriverAgentMac (appium-mac2-driver) 4.3.6 (mac-arm64)

--- licenses/appium-mac2-driver-LICENSE.txt (Apache-2.0) ---
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

--- licenses/WebDriverAgent-LICENSE.txt (BSD-3-Clause) ---
BSD License

For WebDriverAgent software

Copyright (c) 2015-present, Facebook, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

--- licenses/FBHTTPStatusCodes-NOTICE.txt (Apache-2.0) ---
WebDriverAgentMac/WebDriverAgentLib/Routing/FBHTTPStatusCodes.h (Apache-2.0) is compiled into this build. Its header:

/*
 * Copyright (C) 2013 Neo Visionaries Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

--- licenses/appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt (BSD-3-Clause) ---
91 files of appium-mac2-driver 4.3.6 (f38257191fa9f273a684f6a9c8c2b16d1272bd09) keep this header from WebDriverAgent:

Copyright (c) 2015-present, Facebook, Inc.
All rights reserved.

This source code is licensed under the BSD-style license found in the
LICENSE file in the root directory of this source tree. An additional grant
of patent rights can be found in the PATENTS file in the same directory.

The BSD-style licence it names is WebDriverAgent's, copied beside this notice as WebDriverAgent-LICENSE.txt. Neither repository holds a PATENTS file at its pinned commit.

Files:
  WebDriverAgentMac/IntegrationTests/FBTestMacros.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSExpression+FBFormat.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSExpression+FBFormat.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSPredicate+FBFormat.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSPredicate+FBFormat.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSString+FBXMLSafeString.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/NSString+FBXMLSafeString.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCTIssue+AMPatcher.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCTIssue+AMPatcher.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIApplication+FBW3CActions.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIApplication+FBW3CActions.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIElement+FBClassChain.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIElement+FBClassChain.m
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIElement+FBFind.h
  WebDriverAgentMac/WebDriverAgentLib/Categories/XCUIElement+FBFind.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/AMActionCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/AMActionCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/AMWindowCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/AMWindowCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBCustomCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBCustomCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBDebugCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBDebugCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBElementCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBElementCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBFindElementCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBFindElementCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBScreenshotCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBScreenshotCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBSessionCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBSessionCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBUnknownCommands.h
  WebDriverAgentMac/WebDriverAgentLib/Commands/FBUnknownCommands.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBCommandHandler.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBCommandStatus.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBCommandStatus.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBElementCache.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBElementCache.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBExceptionHandler.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBExceptionHandler.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBExceptions.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBExceptions.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBResponseJSONPayload.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBResponseJSONPayload.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBResponsePayload.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBResponsePayload.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRoute.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRoute.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRouteRequest-Private.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRouteRequest.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRouteRequest.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRuntimeUtils.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBRuntimeUtils.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingContainer.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingContainer.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingPromise.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingPromise.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingRequest.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBScreenRecordingRequest.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBSession-Private.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBSession.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBSession.m
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBWebServer.h
  WebDriverAgentMac/WebDriverAgentLib/Routing/FBWebServer.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBBaseActionsSynthesizer.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBBaseActionsSynthesizer.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBClassChainQueryParser.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBClassChainQueryParser.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBConfiguration.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBConfiguration.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBElementTypeTransformer.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBElementTypeTransformer.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBElementUtils.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBElementUtils.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBErrorBuilder.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBErrorBuilder.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBFailureProofTestCase.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBFailureProofTestCase.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBLogger.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBLogger.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBMacros.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBProtocolHelpers.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBProtocolHelpers.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBRunLoopSpinner.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBRunLoopSpinner.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBW3CActionsHelpers.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBW3CActionsHelpers.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBW3CActionsSynthesizer.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBW3CActionsSynthesizer.m
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBXPath.h
  WebDriverAgentMac/WebDriverAgentLib/Utilities/FBXPath.m

Source https://github.com/appium/appium-mac2-driver/tree/f38257191fa9f273a684f6a9c8c2b16d1272bd09
```

</details>

Command: `python3 .retest/licence-wording/guard.py node --conditions=retest-source src/cli/main.ts licences webkt`. Exit 2. Log `.retest/licence-wording/logs/licences-typo.log`.

```text
error: Unknown engine webkt. Did you mean webkit?
See retest help licences.
```

Command: `python3 .retest/licence-wording/guard.py env HOME=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/licence-wording/empty-home NO_COLOR=1 node --conditions=retest-source src/cli/main.ts doctor --config .retest/licence-wording/doctor.config.ts`. Exit 2. Log `.retest/licence-wording/logs/doctor.log`.

```text

  web      { browser: 'webkit' }    ✗ No WebKit build at /configured/build, the path executablePath gives: nothing is there. Give executablePath the folder of an unpacked Playwright WebKit build 2359 for mac26-arm64, or the executable inside it.   /configured/build
  builds   webkit                   ✓ licence notices present and verified

  1 problem. Fix it and run npx retest doctor again.
```
