**Counts:** 2 high, 5 medium, 12 low.

**The five worst:**
1. A-1 (high): `recipe()` accepts a durable locator that names a different element, as long as that element shows the same text.
2. A-2 (high): if `open()` fails after the session lease is taken, the session is never given back, the target's launch stays broken, the process gets an unhandled rejection (which crashes it), and `close()` rejects.
3. A-3 (medium): `close()` reports ok while a browser is still starting. When that browser arrives and its close fails, the rejection is unhandled and the process crashes.
4. I-1 (medium): `--list --verify`, `doctor` and the Firefox lookup report a hand-filled cache as "installed by Retest", including for Chrome for Testing and WebKit, which the installer refuses.
5. A-4 (medium): a reference acts on a different element after the app re-sorts matches that show the same text.

## Findings

**A-1 (high)**: `src/agent/recipes.ts:46-52`, called from `src/agent/session.ts:337`
- **Claim:** a recipe counts as naming the referenced element when it finds one element with the same text and visibility. Nothing proves it is the same element.
- **Scenario:** two rows each have a "Delete" button. The agent looks at `getByTestId('row-2-delete')`, which lists one element, then calls `recipe(ref, { by: 'testId', value: 'row-1-delete' })`. The answer is `{ ok: true, locator: getByTestId('row-1-delete') }`. Confirmed with the fake browser. A codified test then deletes row 1 and can pass. The guide only warns about "an element of another kind".
- **Fix:** prove identity in one page read. A driver read could resolve both the look's locator at its place and the recipe, and compare the nodes. Otherwise refuse.

**A-2 (high)**: `src/agent/host.ts:165`, `:222-231`, `:283-287`, `:189`
- **Claim:** `open()` is documented never to throw, but `#open` can reject after `acquireResources` granted the lease. When it does:
  - nothing gives the lease back;
  - `#launches` keeps the rejected promise, so every later open of that target rejects too;
  - `void opening.finally(...)` leaves a rejected promise nobody handles;
  - `#close`'s `Promise.all` over `#launches` rejects, so no browser is closed.
- **Scenario:** a launcher that throws synchronously, or any unexpected throw in `#open`. Two opens reject and the budget reads host=2 of 2 for good, which also starves `runFiles` on the same budget. Each open logged an unhandled rejection; without a handler the process crashed. `close()` rejects. Confirmed by running.
- **Fix:**
  - wrap everything after the grant in try/catch that calls `giveBack(lease)` and returns a failure;
  - delete a rejected launch from `#launches`;
  - handle the `.finally` chain;
  - use `allSettled` in `#close`.

**A-3 (medium)**: `src/agent/host.ts:297-300`
- **Claim:** a browser that arrives after its launch was stopped or timed out is closed with `void starting.then(late => late.close(...), () => undefined)`. A rejected `close()` is unhandled, and `#close` never waits for that browser.
- **Scenario:** `open()` starts a launch and `host.close()` follows 50 ms later. `close()` answers `{ ok: true }` with no browser launched yet. When the browser arrives and its close throws (Chromium's close can throw ownership errors, as the agent lane itself recorded), the process crashes. Confirmed by running. If the host process exits right after `close()`, the browser can be left running.
- **Fix:** track late launches in `#closings` with a bounded close and a catch, and make `close()` wait for them.

**I-1 (medium)**: `src/browser/builds.ts:498-505`, `:516`, `:537-540`; `src/cli/install/report.ts:74-76`; `src/cli/install/doctor-rows.ts:112-115`
- **Claim:** inspection never applies `pinRefusal`, and it checks the cache only against the record, which anyone can write. `--verify` compares the tree with `record.tree.sha256`, never with `pin.treeSha256`.
- **Scenario:** I put a hand-written `build.json` in a temporary HOME:
  - Chrome for Testing with only 3 files and archive SHA "not-an-archive";
  - WebKit with the nine required notices as empty files.

  `install --list --verify` printed "✓ installed" for both and exited 0. `doctor`'s rows said "installed by Retest · sha256 not-an-archi". `install webkit chromium` refused both. `installedExecutable('firefox')` would hand such a build to every Firefox run.
- **Fix:**
  - report a refused pin's folder as not installed or unverifiable, and never return its executable;
  - compare the archive and tree checksums with the pin wherever the pin holds them.

**A-4 (medium)**: `src/agent/looks.ts:147-149`, `:169-171`; `src/agent/session.ts:306-316`
- **Claim:** the stale check compares only the text and visibility of the list. The action then goes to `nth(element)`, resolved again after the driver's actionability wait.
- **Scenario:** three empty textboxes; the agent takes the reference to element 1 (f-2). The app re-sorts the list without loading a new document. `fill` by that reference answers `ok`, input `sent`, and the text lands in f-1. Confirmed with the fake browser. A list change during the actionability wait has the same effect.
- **Fix:**
  - pin the node during the re-read and act on that mark;
  - or refuse references whose look lists twins of the element.

**I-2 (medium)**: `src/cli/install/lock.ts:17-27`
- **Claim:** the lock does not keep installers apart:
  - an empty lock file (a live holder between `open('wx')` and writing its pid) is treated as stale and taken over;
  - a stale takeover is `rm` then `open` with no recheck, so two takers both win;
  - `release()` deletes the lock even if another process now holds it.
- **Scenario:** six processes raced over a lock left by a dead pid. Up to 3 held the lock at once (rounds of 1, 1, 3, 3, 2, 1, 2, 2). An empty lock was taken over. Confirmed by running. Separately, a reused pid blocks installs indefinitely, and the refusal does not name the lock file to remove.
- **Fix:**
  - write the pid to a temp file and `link()` it to the lock name;
  - treat an empty lock as held for a grace period;
  - take over a stale lock only by atomic replace after re-reading the same stale pid;
  - release only a lock that still holds your own pid.

**A-5 (medium)**: `src/agent/host.ts:250`, `:391-393`; `src/agent/session.ts:229-232`
- **Claim:** the API never ties a session to its caller, and a request's `holdMs` overrides the host's `timeouts.hold`, up to 2,147,483,647 ms.
- **Scenario:** a worker that dies, or a request with a huge `holdMs`, keeps its context and its budget slot (shared with test runs) until the hold ends. The record's "Disconnect: met" covers browser loss only.
- **Fix:** cap `holdMs` at a host maximum, and add a renewable lease (heartbeat) that ends the session when the caller goes silent.

**I-3 (low)**: `src/cli/install/doctor-rows.ts:117-119`, `src/cli/install/report.ts:80`
- **Claim:** a damaged build's fix says "Remove … and run npx retest install chromium again" without checking `pinRefusal`.
- **Scenario:** I damaged the hand-filled Chromium build. Both the doctor row and `--list` gave that fix, and the installer refuses that command. Confirmed by running.
- **Fix:** build the fix from `pinRefusal`, as the not-installed row already does.

**I-4 (low)**: `src/browser/builds.ts:504`, `src/browser/firefox/executable.ts:36-38`
- **Claim:** `installedExecutable` returns undefined for a damaged build, the same as for a missing one, so the Firefox lookup silently uses `/Applications/Firefox.app`, whatever its version.
- **Scenario:** an installed pinned Firefox gets damaged. `doctor`'s builds row shows ✗, but `retest run` drives the system Firefox with no setup failure.
- **Fix:** tell damaged apart from missing, and fail setup on a damaged pinned build.

**I-5 (low)**: `src/cli/install/install-archive.ts:130`, `:149`; `src/cli/install/download.ts:56-60`, `:167`; `src/protocol/url.ts:7-13`
- **Claim:** `withoutCredentials` strips only the user name and password, so `fetchedFrom` stores the final redirect address with its query string.
- **Scenario:** GitHub release downloads redirect to a signed asset address. Its signature query is written into `build.json`. A mirror with a token in its path is printed in "Downloading … from …" and recorded too.
- **Fix:** print and record only the origin and path; refuse a mirror with a query.

**I-6 (low)**: `src/cli/install/install-archive.ts:127-128`, `:90`, `:244-254`
- **Claim:** `*.partial-<pid>` files left by killed installs are never swept (only staging folders are). An archive left by a kill between the rename into place and the delete stays forever, because later runs return "already installed".
- **Scenario:** each killed download leaves up to 2 GiB in `browsers/downloads`.
- **Fix:** sweep partials of dead pids, and delete the archive of a build that is installed.

**I-7 (low)**: `src/cli/install/unpack.ts:45-49`
- **Claim:** when `hdiutil attach` is ended by timeout or stop, the code returns without detaching. The mount is done by a separate system helper process, so the image can stay attached.
- **Scenario:** Ctrl-C during a disk-image install can leave a volume mounted under the temp folder.
- **Fix:** after a failed attach, look up the mount point in `hdiutil info` and detach it.

**I-8 (low)**: `src/native/executors.ts:321-342`, `src/browser/builds.ts:423-427`, `src/cli/install/install-archive.ts:199-221`
- **Claim:**
  - the tree checksum ignores file modes and non-regular files, so `--verify` misses an added set-id bit or an inserted FIFO;
  - `fileSha256` follows links and blocks forever on a FIFO;
  - `checkUnpacked` never refuses set-id bits or special files.
- **Scenario:** a FIFO at a licence path makes `doctor`, `--list` and every Firefox run hang.
- **Fix:**
  - hash modes into the tree checksum;
  - refuse set-id bits and non-regular files at unpack;
  - check `lstat().isFile()` before hashing.

**I-9 (low, record)**: `docs/plans/public-beta/proofs/builds.md:58`, `:47-52`, `:76`
- **Claim:** the record overstates two guarantees:
  - "One install of a build at a time, across processes" is false (I-2);
  - "installed by Retest" and "`--verify` reads every file again" describe checks against the record, not the pin (I-1).
- **Fix:** correct the record once I-1 and I-2 are fixed.

**A-6 (low)**: `src/runner/sessions.ts:147-152`, with every agent session sharing `scope: this.runId` (`src/agent/host.ts:210`)
- **Claim:** a capacity refusal's `heldBy` lists every session in the host's scope, whoever owns it.
- **Scenario:** with owners "workspace-acme" and "workspace-globex" holding the slots, a refusal for "workspace-initech" read: `heldBy: "r0nab8iohe:acme-billing-admin and rhdhgv8ijz:globex-payroll"`. Confirmed by running.
- **Fix:** name only holders with the same owner, and count the rest.

**A-7 (low)**: `src/agent/checks.ts:82-113` against `src/runner/run-host-checks.ts:71-103`
- **Claim:** the agent's required check is a copy of the runner's loop, not the same code. The verdict logic matches today. The failure messages already differ: the label comes from `id` instead of `name`, and "ignoring case" is missing. The runner's `connected` check before each read is absent.
- **Scenario:** a later fix to the runner's verdict rules skips agent checks without anyone noticing.
- **Fix:** export the runner's check core and call it from the agent.

**A-8 (low)**: `src/agent/host.ts:148`, `:492-498`, `:341`; `src/agent/session.ts:480-481`
- **Claim:** isolation between sessions here depends on the caller:
  - secrets belong to the whole host;
  - a session's own `baseUrl` lets it type every host secret on that origin;
  - `open({ state })` restores any saved state with no check of the app or owner it came from.
- **Scenario:** the member's session can type the owner's password, or be restored as the owner, and nothing refuses it.
- **Fix:** an optional allow-list of secrets per session, and a check of `savedFrom` against the requesting app and owner.

**A-9 (low)**: `src/agent/host.ts:312-321`
- **Claim:** a lost browser is reaped only when the host closes.
- **Scenario:** a long-lived runner host collects the leftovers and profiles of every lost browser until shutdown.
- **Fix:** close a lost browser after a short grace period.

**A-10 (low, record)**: `docs/plans/public-beta/proofs/agent-sessions.md:50`, `:53`; the guide's "Everything above passed on all three"
- **Claim:**
  - "Stale references refused: met" rests on cases where the count changed, a look expired or a new document loaded; a re-sort of identical matches is accepted (A-4);
  - "Disconnect: met" means browser loss, not a caller disconnecting (A-5).
- **Fix:** narrow both claims.

## Held items on the current code

**Builds lane:**
- **Chrome "different identity" at close in `doctor`:** the identity fix lane reports it fixed. I did not re-run `m2-doctor`.
- **Firefox lookup suggesting `retest install firefox`:** fixed at `src/browser/firefox/executable.ts:39`. The damaged rows still suggest refused installs (I-3).
- **`doctor` refusing native targets, and a run building executors itself:** still open (`src/cli/doctor/checks.ts:101` calls `targetDriver` without `native`; `src/runner/native-pool.ts:428`).
- **Chrome for Testing, Firefox and WebKit:** still no archive checksums and WebKit notices still `published: false`. `install` refuses them; the inspection paths do not (I-1).

**Agent session lane:**
- **`./agent` export:** still absent from `package.json`.
- **`webkit` capture source name:** now in `src/protocol/identity.ts:27,29` (uncommitted). The WebKit page still offers only `webKitFrameSource` (`src/browser/webkit/page.ts:413`), so agent sessions still refuse a live frame source on WebKit.
- **Firefox driver defects, Chromium close after an outside kill, `runHostProgram` after-hook:** not verified; those files belong to other lanes.

## Confirmed by running

- `pgrep -fl benchmarks/run.ts`: only other sessions' shells, no benchmark.
- `node --conditions=retest-source --test` on the six `builds-*` and `cli-install` unit files: 65 of 65.
- The five `tests/unit/agent-*.test.ts` files: 64 of 64.
- Crafted zips under `/tmp/retest-review-install/work`, unpacked with `/usr/bin/ditto -x -k` and `/usr/bin/unzip`:
  - `..` and absolute entries were kept inside the target;
  - ditto dropped set-id bits;
  - links pointing outside were created (`linksLeaving` would catch them);
  - writing a file through a link was refused by both tools.
- Hand-filled cache: `HOME=/tmp/retest-review-install/home node --conditions=retest-source src/cli/main.ts install --list --verify` exited 0 and showed both refused pins installed; `install webkit chromium` exited 2; `doctor-rows.ts` printed "installed by Retest" and, after damage, the refused fix.
- Lock: `/tmp/retest-review-install/lock/holder.ts` race (up to 3 holders at once) and `empty.ts` (empty lock taken over).
- Agent, scripts in `/tmp/retest-review-agent`:
  - `thrown-launcher.ts` (A-2);
  - `late-launch.ts` (A-3);
  - `refs.ts`, fake browser (A-1, A-4);
  - `holders.ts` (A-6).

## Not verified, most important first

1. No real-browser run. A-1 and A-4 were shown with the fake browser and the real functions, not on Chrome, Firefox or WebKit. `install.test.ts` and the agent integration suites were not re-run.
2. Whether Rehearsal will pass custom launchers, which decides how likely A-2's trigger is.
3. How Linux `unzip` behaves; only Apple's build of Info-ZIP 6.00 was tried.
4. A real disk-image install, and an interrupted `hdiutil attach`.
5. The lane's ten-mutation claim.
6. The whole unit and integration suites, which I left alone because other lanes are mid-edit.

Throwaway files are under `/tmp/retest-review-install/` and `/tmp/retest-review-agent/`. No browser or other long-lived process was started.
