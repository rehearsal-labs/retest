# Pinned builds, `retest install` and `doctor`

The pinned browser builds, install and cache inspection, and `doctor` rows of [release-0.1.0.md](../release-0.1.0.md): "Implement explicit installation/cache inspection for pinned browser builds and checksums, and useful doctor diagnostics. Downloads happen only when requested. Keep installed-binary paths usable." Recorded 5 October 2026 on macOS 27.0, arm64, Node 24.12.0.

## Result

- The pinned set is data in `src/browser/builds.ts`: seven pins, Chrome for Testing for macOS arm64 and Linux x64, and Firefox, Playwright's WebKit build, Electron and the two native executors for macOS arm64.
- `retest install <engine...>` downloads only the engines named. It checks the archive's size and SHA-256 before anything reads it, unpacks it into a staging folder, checks the executable, the pinned files and every licence notice the pin names, writes the record, and only then moves the build into place and deletes the archive.
- `retest install --list` reads the cache and nothing else. `--verify` also reads every file of each installed build again and compares the whole with the pin's tree checksum, or with the record's where the pin has none, after a walk that refuses entries no build may hold.
- A folder for a pin `retest install` refuses is never reported as installed and its executable is never handed to a run, whatever its record says: nothing in it is read.
- `doctor` gets `builds` rows from the cache alone, and a native target's row from the executor build in the cache.
- Proven on the real Electron 44.5.1 archive, served by a stand-in mirror on 127.0.0.1 that the integration test runs. The archive came from the cache the Electron proof downloaded it into. Its install, its record, `--list`, `--verify`, a second install that fetched nothing, `doctor`, and a notice removed afterwards all ran through the real command line. The unpacked build read as the same whole-tree checksum as the Electron proof's own unpack.
- Publisher downloads are now recorded for both authorized platforms of Chrome, Firefox and WebKit. All four existing browser archive pins have measured sizes and SHA-256 values. Every existing Mac executable, pinned-file and published licence checksum matches. The nine supplied WebKit notices match their existing pins. Linux Chrome has newly inspected executable and notice checksums. Current commands, findings and logs are in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md).

## The pin table

| Engine | Version or build | Platform | Source | Archive SHA-256 | Executable SHA-256 | Licence files expected inside the build | `retest install` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chromium` | Chrome for Testing 153.0.8010.12 | macOS arm64 | `https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip`, 190,970,181 bytes | `930e2a2c15addbaca1fe9b07bfa520667bced556d7988707186819cb4279ef3b` | `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a` | `chrome-mac-arm64/ABOUT` (`34d078ce…`, names chrome://credits); Widevine's `LICENSE` in the framework (`20de3757…`) | isolated mirror install, list, verify and doctor passed; current result in report |
| `chromium` | Chrome for Testing 153.0.8010.12 | Linux x64 | `https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/linux64/chrome-linux64.zip`, 195,836,009 bytes | `8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a` | `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e` | `chrome-linux64/ABOUT` (`34d078ce…`); `chrome-linux64/WidevineCdm/LICENSE` (`20de3757…`), both inspected from the publisher zip | checksum pinned; Linux install and browser execution unverified |
| `firefox` | Firefox 133.0.3, build 20241209150345 | macOS arm64 | `https://archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg`, 154,008,053 bytes, `Firefox.app` copied out | `9ceb4fa2120228f287e6c654cef7898b4cce0a659270056276b8884581267d3b` | `363eae026f4f5b3a8549f6a9c96a269754094ef12afc5f02cdffbcb4bcbf389c` | `Firefox.app/Contents/Resources/omni.ja` (`1ecdc0a4…`), which holds about:license at `chrome/toolkit/content/global/license.html` (`82eca7b8…`, read with `unzip -p`) | isolated mirror install, list, verify and doctor passed; current result in report |
| `webkit` | Playwright WebKit 26.6, build 2359 | macOS arm64 | `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip`, 81,853,194 bytes | `f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7` | `7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f`, with `protocol.json` `5962bc79…` pinned beside it | the four Web Inspector licences (present); WebKit's LGPL-2.1 and BSD-2-Clause texts, the notices of ANGLE, WebRTC, BoringSSL, abseil-cpp, libvpx and the Swift compatibility library, and a source pointer, supplied by Retest under `licenses/`, each with its SHA-256 in the pin | isolated mirror install, list, verify and doctor passed; current result in report |
| `electron` | Electron 44.5.1 | macOS arm64 | `https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip`, 130,259,261 bytes | `1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c` | `ca7e3290800255f5018160cff99cf6ecc58eae299c66148de1374a70e2715c83` | `LICENSE` (MIT, `5154e165…`), `LICENSES.chromium.html` (`a62dabd1…`); whole tree `f94a2b74…` | installs |
| `webdriveragent` | WebDriverAgent 16.13.6 at `9d1d17ddb59e6097ddc3324b23ca9f4174507b12` | macOS arm64, Xcode 26.5 (17F42) | `https://github.com/appium/WebDriverAgent`, built from a checkout | none: built from source | products checksum recorded per build | `licenses/WebDriverAgent-LICENSE.txt` (`d9910c6b…`), `licenses/Apache-2.0-LICENSE.txt` (`c71d239d…`), `licenses/FBHTTPStatusCodes-NOTICE.txt` | builds from the checkout a native run uses |
| `mac2` | appium-mac2-driver 4.3.6 at `f38257191fa9f273a684f6a9c8c2b16d1272bd09` | macOS arm64, Xcode 26.5 (17F42) | `https://github.com/appium/appium-mac2-driver`, built from a checkout | none: built from source | products checksum recorded per build | `licenses/appium-mac2-driver-LICENSE.txt` (`c71d239d…`), `licenses/WebDriverAgent-LICENSE.txt` (`d9910c6b…`), `licenses/FBHTTPStatusCodes-NOTICE.txt`, `licenses/appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt` | builds from the checkout a native run uses |

Where each fact came from, as each pin's `provenance` says:

- Chrome for Testing: the version, executable and licence checksums were read from the copy Playwright 1.63.0 unpacked as its revision 1243 (`~/Library/Caches/ms-playwright/chromium-1243`). Playwright's `browsers.json` maps revision 1243 to 153.0.8010.12, and its registry fetches Chrome for Testing archives from its own mirror (`cdn.playwright.dev/builds/cft/<version>/…`). The founder-authorized Google publisher downloads now supply both archive checksums. The Mac executable and both notices match the original pins, including `ABOUT`. The Linux executable and its two notices were read from the publisher archive; Linux browser execution remains unverified.
- Firefox: the version, build id, executable and `omni.ja` checksums were read from the en-US Firefox 133.0.3 in `/Applications`, signed by Mozilla (Developer ID 43AQ936H96), which the Firefox proof drove. The founder-authorized Mozilla disk image now supplies its size and checksum. A direct read-only system mount and app copy verified the top-level `Firefox.app` layout and both existing file checksums. The first standalone unpack failed after attach and remains in the current report. Subsequent real CLI disk-image installs, list, verify and doctor pass.
- WebKit: everything comes from the WebKit proof (`proofs/webkit.md`). Playwright deleted the archive after unpacking it, so its checksum was never taken. The executable path assumes the zip holds the build at its root, as Playwright's unpacked folder does. The founder authorized retaining the nine standard notices. Their text sources and checksums are recorded below. The source pointer names WebKit `4d05d732e5a84f32675bef4cc135a2e7a9269a87` and Playwright's `v1.63.0/browser_patches/webkit`; exact binary-to-source correspondence remains unverified. The founder-authorized publisher archive now has its measured size and SHA-256 pinned. The executable, protocol and four published inspector notices match the original pins.
- Electron: the archive's size and checksum come from the Electron proof's download, which matched the release's `SHA256SUMS.txt`. The executable, licence and tree checksums were read from that archive unpacked with `ditto` in `~/Library/Caches/retest-proofs/electron/44.5.1/dist`.
- Native executors: the executor pin in `src/native/executors.ts`. The table reads it rather than copying it.

## WebKit notices retained by the installer

The founder authorized the standard notices and source pointer. Exactly nine files live under `src/cli/install/licences/webkit/`; the pin names their installed `licenses/` paths and their checksums. The four Web Inspector notices stay pinned as published. The install record and JSON list retain every notice, its licence and checksum, plus the source revision and patch pointer. The JSON list keeps its existing schema. A usable pin has `install.command`. Concurrent CLI changes now print one short message and suppress detailed notices in terminal install, list and doctor. The current proof records zero of the nine required detailed install notices. That conflicts with the checksum brief; the output decision is pending and is recorded in the checksum report.

| Installed file | SHA-256 |
| --- | --- |
| `licenses/ANGLE-LICENSE.txt` | `bf4da21bd20bcfb5b60b7ecc67fa864a79be049e21d6178076887f178dd6c71a` |
| `licenses/BoringSSL-LICENSE.txt` | `046ec2a8cf1915f1f354489a2031532f78dc3e023f3a5be4751c9938c73b4920` |
| `licenses/SOURCE.txt` | `81ea2bf2f192ef3e1975007d5323468f31ccfaa7a2a4353af124fd9f3e7ea270` |
| `licenses/WebKit-BSD-2-Clause.txt` | `9508673c7ddfdd28d574d536ef2e8a98d38ca1597f9c5a86a247d2210dd45942` |
| `licenses/WebKit-LGPL-2.1.txt` | `b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe` |
| `licenses/WebRTC-LICENSE.txt` | `ab00a482b6a3902e40211b43c5d0441962ea99b6cc7c25c0f243fa270b78d482` |
| `licenses/abseil-cpp-LICENSE.txt` | `34cb75d73943f10a7f9a3b0e3e7bf8ef271065eedcb0d47481e7c831b637aeae` |
| `licenses/libvpx-LICENSE.txt` | `b80a23ff7619a3b5c150cf718b43af5a5b9a2339ff019c562c9938d91303d08c` |
| `licenses/swiftCompatibilitySpan-LICENSE.txt` | `99d47dad251d8d1e0ce2f26d019f2a8cfd5ca66263084b6f2cf452a86f89b7f2` |

The texts were inspected from existing local public notices, with no download. `SOURCE.txt` records each source: the standard LGPL 2.1 text in cached Playwright ffmpeg; the actual WebKit build's `WKWebView.h` BSD header and Chromium's collected WebKit notices; the named ANGLE, WebRTC, abseil-cpp, libvpx and BoringSSL entries in cached Electron 44.5.1 `LICENSES.chromium.html`; Swift's copyright and runtime exception and the historical OpenSSL/SSLeay texts in installed Xcode `Acknowledgments.pdf`. The historical BoringSSL ISC notice is transcribed. The retained BoringSSL file includes its current Apache notice and the historical OpenSSL and ISC notices.

The pin retains WebKit revision `4d05d732e5a84f32675bef4cc135a2e7a9269a87` and `https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit`, as the WebKit proof read them. The pointer does not prove exact binary-to-source correspondence for build 2359. The authorized publisher archive now has a measured size and SHA-256. With its supplied notices present and matching, the real pin is installable.

The installer reads supplied notices as bounded regular files through non-following descriptors. A missing notice, a changed checksum or an unreadable file refuses the pin by installed path. Before recording a staging build it copies those checked bytes with exclusive creation, then checks every installed notice's bytes. It never replaces a notice an archive supplied. The installed record retains the source pointers and notice checksums, and inspection requires them to match the pin.

The earlier notice implementation and synthetic installation are recorded in [the builder report](../codex/phase-4/report-jump-and-notices-report.md). The current real WebKit archive installation, record, whole-tree verification and doctor checks are recorded in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md).

## The cache and the record

- Browsers and Electron go under `~/Library/Caches/retest/browsers` on macOS, and under `$XDG_CACHE_HOME/retest/browsers` or `~/.cache/retest/browsers` on Linux. Executors go under `…/retest/native-executors`, where the executor build step already keeps them.
- One folder per build, named `<engine>-<version>-<platform>`. It holds the unpacked build in `build/` and the record in `build.json`. The record holds:
  - the engine, version and platform
  - the pinned source, and where the archive was actually fetched, without credentials
  - the archive's size and SHA-256
  - the executable's path and SHA-256, and the pinned files with theirs
  - each licence file with its SHA-256, including notices Retest supplies
  - the pinned source revision and patch pointer when the pin names them
  - the whole tree's checksum, the same `folderChecksum` the executor builds use
  - when it was installed, and by which Retest version
- An executor build's record is its build step's `build.json`.
- Archive `build.json` keeps schema version 1. `sourceCode` is an optional additive field with the repository, revision and patch pointer. An older strict record reader rejects a record carrying that field. The current real WebKit install record includes this field and the pinned archive checksum.
- The executable path is `<folder>/build/<pinned path>`. It does not change while the build is installed, so a target's `executablePath` can name it. `installedExecutable(engine, env)` in `builds.ts` answers that path for an installed, matching build, and nothing for a missing or damaged one. `installedBuild(engine, env)` gives a driver three answers: installed, with the path; missing; or damaged, with a message that names the folder, what is wrong and the fix. The Firefox driver's `src/browser/firefox/executable.ts` asks `installedBuild` for a Firefox target that names no path, and fails setup by name on a damaged build, before it looks in `/Applications`.
- Inspection reads files only. A folder for a pin `retest install` refuses (notices never inspected, notices not published, or no archive checksum) is unverifiable: no install of Retest's could have put it there and checked it against the pin, so its record, which anyone can write, is not even read. Otherwise a build is installed when:
  - its record parses and names the pin
  - its archive checksum, where the pin has one, is the pinned one
  - its tree checksum, where the pin has one, is the pinned one
  - its executable is a regular file that can run and has the recorded and pinned checksum
  - its pinned files and every licence file the pin names are regular files, as recorded and, where the pin has their checksums, as pinned
- Every file is checked with `lstat` before it is read and opened without following a link or waiting on a FIFO, so a link, a FIFO, a socket or a device where a file belongs is named at once. The record is read the same way, for archive and executor builds alike, and one larger than 1 MiB, far past any record Retest writes, is refused unread. The executor build step's own reader (`readBuildRecord` in `src/native/executors.ts`) reads it the same way, through `src/shared/regular-file.ts`. A file swapped for another between its check and its open, as a writer renaming a new copy into place does, is read again up to three times before it is judged. A record is read at most one byte past 1 MiB, from the file that was checked, so one that grows while it is read is refused.
- Anything else is damaged, and each mismatch is named. `--verify` adds a walk of the whole build, which refuses a link leading outside it, a FIFO, socket or device, and a file with a set-user-id or set-group-id bit, and then the whole-tree checksum, compared with the pin's where the pin has one. For an executor build it walks the products for the same entries, links aside, then reads the products' checksum and the `.xctestrun`.
- The whole-tree checksum (`folderChecksum` in `src/native/executors.ts`, shared with the executor builds) leaves out file modes and passes over FIFOs, sockets and devices. That is why `--verify` walks the tree first. Folding modes and those entries into the checksum itself would change every checksum already recorded and pinned, Electron's among them, so it was left as it is; if it is ever changed, every pinned and recorded tree checksum must be taken again in the same change.

## What `retest install` does, in order

1. A pin whose notices nobody inspected, a pin with a required notice neither published nor supplied by Retest, a missing or changed supplied notice, or a pin with no archive checksum is refused. Each missing notice is named. The current WebKit archive checksum is pinned; all nine supplied notices must still match before it may install. So is a mirror address that `RETEST_DOWNLOAD_MIRROR` gives with credentials, a query or a fragment. Nothing is fetched, and the cache is not even made.
2. One install of a build at a time on one machine. The lock is the folder `<cache>/retest/locks/<folder name>.lock`, which holds generations. `<n>.json` holds a random token, the machine and pid namespace, and the pid and start of the installer that holds generation n, with its program; `<n>.<token>.released` says that holder let go. A start is read where nothing can move it afterwards: on Linux the ticks from boot in `/proc/<pid>/stat`, on macOS the second `ps` prints under `TZ=UTC0`. An installer reads the newest generation and makes the next only when that one was let go or its pid has no process. A present process with a mismatching start is never passed over. It makes it by linking a finished, flushed file under the next name, which fails rather than replaces, so exactly one installer makes it; the others read again and are refused, naming the lock and the holder. A start that proves neither, a holder whose start cannot be read, a generation that cannot itself be read, and a generation of another machine or container are never passed over: the refusal says so and what to do. Installs from machines or containers that share a cache are not coordinated: while one of them holds the lock, an install from another is refused. A generation counts as the holder's only while it is still the newest once made, so one made under a number a slow taker read long ago steps back. The taker that made the newest removes the generations before the one before it, so the folder keeps two. A release checks the generation is still its own, by its token, before it marks it let go. This replaced a `lockf` kernel lock, which Linux does not ship.
3. A build already installed as its pin and record say is left alone, and no tool runs for it; an archive a killed install left beside it is deleted. One that is there but does not match is refused, with each problem named and the folder to remove.
4. Staging folders and partial downloads left by installs whose process is gone are removed, those of any build in the downloads folder, and so are those named after a number no process can have. A live installer's are left to it, and so is one whose process the system cannot be asked about. The same holds for the hidden files of the install lock, and only for this machine's: another machine's are left alone.
5. A verified archive kept from an earlier attempt is read once more and used. Anything else under that name is deleted.
6. The download goes to a name of its own, over https, or over http only to this machine, for a stand-in or mirror. Redirects are followed by hand, at most five, and each new address is checked. A declared size other than the pinned one stops it before the body is read. It also stops on a body that outgrows the pin, a server silent for 60 s, an hour in all, or an interrupt. The partial file is removed every time.
7. A SHA-256 other than the pinned one deletes the download unread. Only a match gets the archive's own name. Of every address, only the origin and path are printed or recorded: a redirect's query, such as the signature on a release asset's address, never reaches the terminal or `build.json`.
8. The archive is unpacked into `<folder>.staging-<pid>/build`: with `ditto -x -k` on macOS, with `unzip` on Linux, and from a disk image by `hdiutil attach -nobrowse -readonly`. From an image only the named app is copied, and the image is detached whatever happened, with `-force` if the first detach fails. hdiutil hands an attach to a system helper that outlives it, so after an attach that fails, the images `hdiutil info` lists as mounted on this install's mount point, or attached from its archive with nothing mounted, are detached by their device; after one that was stopped or ran out of time, `hdiutil info` is watched for two seconds for the helper finishing it.
9. Retest copies its supplied notices into the staging build without following or replacing an archive entry. Then the checks. No link may lead outside the build, and it may hold nothing but folders, files and links, and no file with a set-user-id or set-group-id bit. The executable must be there, executable and as pinned, and each pinned file must have its checksum. Every licence file must be a regular file with its checksum, and a missing, changed or other one is named, together with what it is. The whole tree must match the pinned tree checksum where there is one.
10. The record is written into the staging folder, the folder is renamed into place, and the archive is deleted. A failure while unpacking keeps the verified archive for the next attempt. A failed check deletes it.

`RETEST_DOWNLOAD_MIRROR` puts the pinned address's host first under a mirror's address. The checksums apply all the same. A mirror with credentials in it, a query or a fragment, or plain http off this machine, is refused, and the refusal never repeats the address. A query or fragment would also swallow the pinned path put after the mirror's.

The install lock's Linux route reads `/proc` and `/proc/sys/kernel/random/boot_id` and calls nothing macOS has alone; its macOS route reads `ps` and `sysctl kern.bootsessionuuid`. The earlier checks ran on macOS, with Linux parsing and judgements on fixed text and fake readings. Current real Linux results are recorded in the checksum report.

The native executors are built by `ensureExecutorBuild`, with the source and derived-data folders `src/runner/native-pool.ts` uses. So a build `retest install` makes is the one a run finds. Nothing is cloned: without a checkout, the refusal gives the `git clone` and `git checkout` commands.

`retest run` and `retest doctor` never install anything, and `--list` downloads nothing. The pathless `doctor` and `run` integration case still requires no request and no cache write. Earlier explicit browser installs were refused before fetching because checksums were absent. Current explicit installs use the real downloaded archives through the local mirror.

## `doctor` rows

One `builds` row per pinned engine a checked target uses. The rows read the cache alone:

- **Installed, with version and checksum.** The target's configured path, or `RETEST_CHROMIUM` or `RETEST_WEBKIT_BUILD`, lies inside an installed build. The row reads, for example, `Electron 44.5.1, installed by Retest · sha256 1d75703019bb`. "Installed by Retest" is said only of a pin `retest install` installs, whose record names the pin's archive and tree checksums, where the pin has them, and whose executable, pinned files and licence notices read as the pin has them. It is the quick reading; `retest install --list --verify` reads the whole build against the pin.
- **Found at a configured path.** The target names its own binary while a pinned build is installed. The row says the configured path wins.
- When a WebKit target names a build outside the installer cache, an extra notice row checks the supplied notice pin and reports its files, source pointers and install refusal. The target's own row checks the configured build; the notice row makes no installation claim.
- **Found at a configured path in a folder Retest did not install.** The path lies in the folder of a pin `retest install` refuses. The target runs it, and the row says Retest does not install that build and never checked it.
- **Installed, for a target that names no path.** The row names the installed build. A Firefox target then runs it; a Chromium or WebKit target runs it once its path or variable names it.
- **Not installed, with a folder Retest did not install.** A target that names no path, with a folder there for a pin `retest install` refuses: ✗, the folder to remove and the reason the install refuses the build. No run launches it.
- **Missing, with the install command.** A Chromium or WebKit target that names no build has no binary at all when none is installed. Its row gives `npx retest install <engine>`, or the reason that command refuses the build. A Firefox target gets no such row, since its driver then looks in `/Applications`.
- **Damaged.** The row names what no longer matches the record, and the folder to remove. Only a pin `retest install` installs is ever damaged, so its fix, running the install again, is one the install accepts.

Targets doctor refuses for want of a driver get no row. Chrome and Edge get none either: they run the browser the machine has. Without `HOME` there is no row, since there is no cache. A config with no pinned engine prints exactly what it printed before.

A native target is checked as a run drives it: `checkTarget` asks `targetDriver` with its native option, and the target's own row reads the executor its runtime drives, WebDriverAgent for an iOS simulator app and the macOS runner for a macOS app, from the cache alone, then checks that the app bundle is a folder at `appPath`. Nothing is built or started, and what the app holds, the simulator, Xcode and Automation Mode are left to a run:

- built, with the app there: `✓ WebDriverAgent 16.13.6 built in Retest's cache · products sha256 0ddb9244e806, and the app is there; doctor starts neither`, with the build's folder;
- not built: `✗ WebDriverAgent 16.13.6 is not built in Retest's cache`, fix `Run npx retest install webdriveragent to build it from its pinned commit; otherwise the first run builds it.`;
- damaged: what no longer matches its record, fix to remove the folder and install again, and for the macOS runner that its permissions must be granted again;
- built, with no app: `✗ No app at …, the path appPath gives.`, fix `Build the app there, or change the path.`;
- without `HOME`, or on a machine with no executor pin, the row says so.

On this Mac, against the real executor builds and read-only, a config with an iOS simulator target and a macOS target gave both ✓ rows above with the recorded products checksums and exited 0 when `appPath` named an existing bundle, and `✗ No app at …` for both, exit 2, when it named none (`/tmp/retest-fix-install-logs/native-doctor-real.txt`, `native-doctor-real-no-app.txt`, taken again after the Mac's restart). `doctor`'s closing "Ready" then means only that much for a native target.

The old wording, "Retest has no driver for iOS simulator apps yet", came from asking `targetDriver` without its native option while a run asks with it.

## The earlier inspection of this Mac's caches

Read-only, with no download. The logs under `/tmp/retest-builds-lane/` and `/tmp/retest-fix-install/` did not survive the Mac's restart; the last item was taken again afterwards.

- `retest install --list` (`/tmp/retest-builds-lane/real-list.txt`) and `--list --verify --json` (`/tmp/retest-builds-lane/real-list-verify.json`), both exit 0.
  - WebDriverAgent 16.13.6 and appium-mac2-driver 4.3.6 read as installed from their build records, with products checksums `0ddb9244e806…` and `9c87eb50ea06…`. The full verification re-read both products folders (25 MB and 32 MB) and their `.xctestrun` files.
  - Chrome for Testing, Firefox, WebKit and Electron read as not installed: Retest's own cache holds none of them.
- `retest install webdriveragent mac2` printed "was already installed" for both and ran no tool (`/tmp/retest-builds-lane/real-executors.txt`).
- `retest install webkit chromium firefox` exited 2 with the three refusals and fetched nothing (`/tmp/retest-builds-lane/real-refusals.txt`).
- The copies other tools left, held against the pins by a one-off read-only script (`/tmp/retest-builds-lane/real-caches.log`):
  - `ms-playwright/chromium-1243`: the executable matches the pin, and both licence files are present.
  - `ms-playwright/webkit-2359`: the executable and `protocol.json` match, and the four Web Inspector licences are present. All nine notices the pin requires are missing; `find` shows no other licence, notice or copying file in the build.
  - The Electron proof's `dist`: the executable, both licences and the whole tree match.
  - `/Applications/Firefox.app`: the executable and `omni.ja` match.
- After the review's fixes, and again after the record came to be read only as a regular file, `retest install --list --verify --json` on the same cache, read-only, exit 0 (`/tmp/retest-fix-install-logs/real-list-verify.json`): both executors still read as installed with the same products checksums, so their records passed the new check and the walk of their products for FIFOs, sockets, devices and set-id files found none.

## The review's hand-filled cache

The review of this lane wrote a `build.json` by hand beside copies of real builds in a temporary home (`/tmp/retest-review-install/home`): Chrome for Testing, and Playwright's WebKit build with its nine missing notices as empty files, both claiming the archive checksum "not-an-archive". Read-only, through the real command line, by the first fix session; its logs, and the review's home folder, did not survive the Mac's restart. The same scenario is now held by unit tests: `cli-install.test.ts` ("lists a folder Retest did not install for a pin it refuses as not installed…") and `builds-doctor.test.ts` ("never call a build of a pin install refuses installed…"), both of which fail on the old code.

- Before the fixes (`/tmp/retest-fix-install/logs/hand-filled-old.txt`): `install --list --verify` listed WebKit as `✓ installed · archive SHA-256 not-an-archive`, and the damaged Chrome for Testing with the fix "run npx retest install chromium again", which the install refuses. `doctor`'s rows (`hand-filled-doctor-old.txt`) said "installed by Retest · sha256 not-an-archi" for WebKit.
- After (`hand-filled-new.txt`, `hand-filled-doctor-new.txt`): both are `✗ not installed by Retest, and nothing in … was checked`, with the folder to remove and the reason the install refuses each, exit 2. `doctor` names the WebKit path as found in a folder Retest does not install and never checked, and the pathless Chrome for Testing target as not installed, with no run launching that folder.

## Earlier proofs and their results

After the review's fixes, run again after the Mac's restart, logs under `/tmp/retest-fix-install-logs/`:

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/builds-pins.test.ts` | 9 pass | `final-unit-builds-pins.log` |
| `… tests/unit/builds-record.test.ts` (record, inspection with fetch replaced by one that fails the test, executor records, a refused pin's folder, the tree checksum against the pin, set-id files, FIFOs and links, a link, a FIFO or an oversized file where the record belongs) | 26 pass | `final-unit-builds-record.log` |
| `… tests/unit/builds-download.test.ts` (size, length, stall, stop, redirects, address rules) | 8 pass | `final-unit-builds-download.log` |
| `… tests/unit/builds-install.test.ts` (checksum mismatch, refusals before any request, already installed, damaged, the lock held by another process, stale staging and partial downloads, leftovers named after a number no process can have, an archive left beside an installed build, a mirror with a query, the check of an unpacked build with FIFOs, sockets and set-id files, executor install with absent tools) | 18 pass | `final-unit-builds-install.log` |
| `… tests/unit/builds-lock.test.ts` (six processes racing over a lock a gone holder left, three rounds; a killed holder; a holder of three hours and an emptied generation, neither passed over; a second release; a pid reused by a process with another start, and a `ps` that cannot answer; a file where the lock's folder belongs) | 6 pass, and 5 runs in a row | `followup-unit-builds-lock.log`, `followup-lock-repeat-*.log` |
| `… tests/unit/builds-installed.test.ts` (installed, missing and damaged for a driver) | 2 pass | `final-unit-builds-installed.log` |
| `… tests/unit/builds-unpack.test.ts` (a stand-in hdiutil whose attach fails or is stopped while its helper mounts the image) | 2 pass | `final-unit-builds-unpack.log` |
| `… tests/unit/builds-doctor.test.ts` | 10 pass | `final-unit-builds-doctor.log` |
| `… tests/unit/builds-doctor-native.test.ts` | 2 pass | `final-unit-builds-doctor-native.log` |
| `… tests/unit/cli-install.test.ts` (with the line each engine's install prints about how a target runs the build) | 12 pass | `final-unit-cli-install.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/install.test.ts` | 13 pass | `gate-integration-install.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/m2-doctor.test.ts` | 3 pass | `gate-integration-m2-doctor.log` |

Four broken copies of the folder lock were each caught by the test meant for them (`mutant-*.log`): one whose next generation replaces rather than fails let two installers in at once in the first round of the race, three times in three; one that passed over a generation older than a minute took the lock from a live holder of three hours; one that passed over a holder `ps` could not read took that holder's lock; one that let this process past its own holding let it in twice.

Every unit test added for the review's findings, and for the two defects found while checking the fixes, was run on a copy of the code as it stood before the fixes and failed there; the tests that were there before passed on both. The first fix session took that copy before its first edit; it did not survive the Mac's restart, so it was rebuilt from that session's own reads of each file (`/tmp/retest-fix-install-logs/old-run`, logs `old-*.log`), with one function added so that today's Firefox lookup still loads: an `installedBuild` that answers as the old `installedExecutable` did, installed or missing and never damaged. The two integration cases below were run on the old code by the first session only. On the old code: two installers held the lock at once in the first round of the race; a FIFO at a licence path or at the record hung inspection until the test's ten-second limit and the process had to be ended; a link at the record was followed and the build called installed; a staging folder named after a number no process can have made the install throw; the record kept the signed query of a redirect; and a stop 100 ms into the attach of a stand-in image left it mounted, after which every attach of it failed as busy. That last one depends on timing: the stops land in the helper's window only once the image has been attached whole before, which the test does first.

The integration test, on macOS arm64, skipped by name elsewhere:

- The real Electron archive, through the CLI:
  - install, with 130,259,261 bytes verified at the pinned SHA-256
  - the record, whose tree checksum equals the pin's
  - the archive deleted, with no staging folder left, and the newest generation of `<cache>/retest/locks/electron-44.5.1-mac-arm64.lock` let go
  - `--list --json`, then `--list --verify`, then a second install with no request
  - `doctor` showing both the target row and the `builds` row
  - after `LICENSES.chromium.html` was removed: `--list` exit 2, the `doctor` row ✗ with its fix, and the install refused, with no request
- WebKit, Chromium and Firefox refused through the CLI with no request. `doctor` and `run` on a pathless `chromium()` sent no request and wrote nothing to the cache.
- Stand-in builds through `installArchive`, with the real `zip`, `ditto` and `hdiutil`:
  - a zip whose internal links are kept, and whose binary runs from the recorded path
  - a zip without its licence file, refused and named, with the archive deleted
  - a link to `/etc/passwd`, refused
  - an unpacking failure that keeps the verified archive, then a second attempt that uses it with no request
  - an interrupted download that leaves nothing
  - a disk image whose app is copied out, which is detached again, with its mount point removed
  - a download redirected to an address with a signed query, whose record and printed lines keep only the origin and path
  - a 20 MiB stand-in image stopped 40, 60, 80, 100, 120, 150, 200 and 300 ms into its attach, leaving nothing attached and no mount point
  - after the Electron install, the install lock free for another taker

## Licences and sources read

- Playwright 1.63.0 (Apache-2.0), in the Rehearsal checkout's `node_modules`, was read and nothing copied: `browsers.json` and the registry's download paths in `lib/coreBundle.js`. They gave the revision-to-version mapping and the fact that Playwright fetches Chrome for Testing from its own mirror.
- Firefox 133.0.3 (MPL-2.0): `Info.plist`, `application.ini` and the entry list of `omni.ja`, read in the installed app.
- Chrome for Testing 153.0.8010.12: `ABOUT` and Widevine's `LICENSE`, read in the Playwright-installed copy. Widevine's licence forbids redistribution without an agreement with Google. Retest never redistributes a build: `retest install` fetches the publisher's own archive for the user.
- No code was copied from any of them. No npm dependency was added.

## Not verified

1. Publisher checksum manifests were not fetched. Archive hashes are Retest's direct observations, not an independently checked publisher digest.
2. Linux Chrome install, its Linux `unzip` route and Linux browser execution remain unverified. Linux Firefox and WebKit have no Retest pin or exercised target here; their authorized archive hashes are retained below.
3. Exact WebKit binary-to-source and component-notice correspondence remains unverified, as `SOURCE.txt` states. All nine supplied notices are retained with pinned hashes.
4. The cause of the first standalone Firefox unpack failure remains unverified. Subsequent real CLI disk-image installs and verification pass. A disk image asking for licence agreement was not exercised.
5. Current install and Linux execution results are in the checksum report. The historical proof tables above remain evidence for the earlier tree.
6. Native executors: install was run only where builds were already recorded. A fresh build through `retest install`, and the refusal on missing checkouts with the real tools, were not run here. The unit test shows the refusal from absent tools. A native run still builds an executor itself when none is recorded (`src/runner/native-pool.ts`), so for native targets "never installs on run" holds for downloads only.
7. The Firefox lookup now asks `installedBuild` and fails setup by name on a damaged pinned build or a folder for the refused pin (`src/browser/firefox/executable.ts:71-73`, changed by the Firefox driver's lane). This lane did not run a Firefox target against such a folder.
8. `doctor`'s native rows read the executor build and the app folder only; nothing in them says the app's contents, the simulator, Xcode or Automation Mode are ready, yet `doctor` closes with "Ready" when they pass.
9. The Linux install lock, `/proc` start ticks and pid-namespace execution are recorded in the current checksum report. Durability after a power loss rests on fsync of each generation file and of the folder; no power loss was tried.
10. A real stopped attach that the helper finishes later than two seconds after hdiutil was ended would stay attached; on this Mac every stop was settled within that time.
11. Device files: a test cannot make one without root, so their refusal rests on the same `lstat` branch as FIFOs and sockets, which were made and refused.
12. A native run reading an executor record that a link or a FIFO took the place of: shown through `ensureExecutorBuild` with stand-in tools, not with Xcode and a simulator.

## Current Mac command result

The source CLI ran again under the shared gate on all three publisher downloads, served only from a local stand-in mirror. Each engine's install, JSON list, whole-tree verify, repeat install and doctor exited 0. Each fetched its archive once; list, verify and repeat fetched no archive, and doctor made only the local app readiness request. All recorded licence hashes match the pins. The selected CLI and pin files had identical hashes before and after these commands.

This separate proof continues every requested command and preserves the required notice checks. WebKit prints zero detailed install notices and zero detailed doctor notices, against nine required in each check. Its overall proof exits 1. The current compiled pin has all nine checked notices and the record retains them; terminal output is the unmet requirement. Exact commands and raw logs are under `.retest/pin-checksums/mac-current/`, with facts in `results.json` and the complete result in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md).

## Isolated browser installation result

The complete install file ran under the shared gate on the integration builder's verified local copies of the publisher downloads. That isolated run passed all 16 tests, with no failures or skips, before concurrent CLI terminal changes. Those cases required successful CLI install, list, whole-tree verify, repeat without an archive request, and doctor. Firefox copied only the disk image's top-level `Firefox.app`. WebKit required all nine supplied notices in install output, their exact checksums in the record and doctor, and its published notices and protocol unchanged. Log `.retest/integration-leftovers/logs/install-final.log`. Exact commands, failed fixture attempts and raw CLI output are retained in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md). A broader run then failed the WebKit notice-output assertion. A concurrent builder subsequently replaced that assertion with a short-message requirement and added full `licences webkit` checks. The separate current Mac proof retains the checksum brief's nine-notice requirement and fails it; the earlier pass does not verify the changed terminal output or changed assertions.

## Authorized Linux archives without Retest pins

The existing table has no Linux Firefox or WebKit pin. These downloads record the authorized version and archive, without adding unsupported targets or a tar unpacker.

| Engine | Publisher address | Size in bytes | Archive SHA-256 |
| --- | --- | ---: | --- |
| firefox | `https://archive.mozilla.org/pub/firefox/releases/133.0.3/linux-x86_64/en-US/firefox-133.0.3.tar.bz2` | 89495132 | `43713e238d0153fdbf1ab46dd76c6b01ab83fae197b5dc3a95087f51907ba44d` |
| webkit | `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-debian-13.zip` | 99959260 | `6c402e84b829a5f0bdee7c86dd0725a21ace8801340542d6422deb0f3a40c4eb` |

WebKit uses the Debian 13 x64 archive name in the cached publisher registry, matching the trixie Linux container. Current commands and cleanup are in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md).

## First real Linux lock and reader run

The requested three unit files ran in the same amd64 Rust container as the media build, using the authorized official Node fallback binary. Node v24.21.0 reported Linux x64. There were 28 passes, no failures or cancellations, and one existing macOS-only slow-ps cancellation case skipped. The live `/proc` case, the boot id and PID namespace reading, the install-lock race and permission refusals, and the regular-file cases passed. Log `.retest/linux-build/logs/node-unit-tests.log`.

The GNU x64 release build passed: 1,630,000 bytes, SHA-256 `4fb5a0a9945010e6c8f50cdae099450f51d6741e53ab745fb83a99074af7664a`. The full Cargo test passed 97 unit cases and failed one real-encoder case. The unchanged compiled process-test target was then run separately, with default parallel execution: 51 passed, four failed, none ignored or filtered. Its failures cover the missing encoder outcome, maximum frame IDs, the codec-unavailable outcome, and frame release after ending. Logs `.retest/linux-build/logs/cargo-test.log` and `process-target.log`. The isolated codec diagnostic also failed. No failure was removed or treated as a pass.

Neither ffmpeg nor ffprobe was available in the approved image, and neither was downloaded. Real Linux video encoding remains unverified. Docker emulation on this arm64 Mac does not prove a physical x64 host. Commands, versions, binary identity, remaining Linux limits and cleanup are in [pin-checksums-report.md](../reviews/fix-reports/pin-checksums-report.md). This supersedes historical "not run on Linux" statements for the exercised lock and reader cases. All six downloaded publisher archives and the temporary app and Node copies were deleted; all three containers were removed. Build outputs and logs remain under `.retest/linux-build/`.

## How to run

```sh
node --conditions=retest-source src/cli/main.ts install --list [--verify] [--json]
node --conditions=retest-source src/cli/main.ts install electron
node --conditions=retest-source --test tests/unit/builds-*.test.ts tests/unit/cli-install.test.ts
lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/install.test.ts
lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/m2-doctor.test.ts
```

The integration test finds Electron's archive at `~/Library/Caches/retest-proofs/electron/44.5.1/electron-v44.5.1-darwin-arm64.zip`, or wherever `RETEST_TEST_ELECTRON_ARCHIVE` points. It fails on macOS arm64 without it, and is skipped by name elsewhere.
