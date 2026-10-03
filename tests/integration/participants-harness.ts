import type { TestContext } from 'node:test'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { accountColour } from '../../fixtures/task-app/shared-records.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { assertJudged, assertReleased, eventsOf, readEvents, readResult, RetestProcess, scratchFolder } from './cli-harness.ts'

// What the participant checks share: the sign-in setups each participant runs, the pixels of a screenshot, the
// holders counter of the task app, and a host program of their own that may run several runs at once.

/** The password the task app takes for every account. */
export { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'

/**
 * A `test.setup` that signs one participant's app in as `account` and saves the state under `state`, with the password
 * given as the secret `password`.
 *
 * @example signInSetup('owner-account', 'owner', 'owner-a')
 */
export function signInSetup(state: string, app: string, account: string): string {
  return `test.setup(${JSON.stringify(state)}, { apps: [${JSON.stringify(app)}] }, async ({ ${app} }) => {
  await ${app}.goto('/login')
  await ${app}.getByLabel('User name').fill(${JSON.stringify(account)})
  await ${app}.getByLabel('Password').fill(secret('password'))
  await ${app}.getByRole('button', { name: 'Sign in' }).click()
  await expect(${app}.getByTestId('account')).toHaveText(${JSON.stringify(`Signed in as ${account}`)})
})`
}

/** The red, green and blue of one pixel of a PNG screenshot, and its size. */
export type Pixel = { rgb: readonly [number, number, number]; width: number; height: number }

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The colour of the pixel at `x`, `y` of a PNG of 8-bit RGB or RGBA pixels without interlacing, as Chrome writes its
 * screenshots. Anything else throws, naming what it found.
 *
 * @example pixelAt(readFileSync(path), 10, 10).rgb // [r, g, b]
 */
export function pixelAt(bytes: Buffer, x: number, y: number): Pixel {
  assert.ok(bytes.subarray(0, 8).equals(signature), 'the file is a PNG')
  let width = 0
  let height = 0
  let channels = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset + 8 <= bytes.byteLength; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const colour = body[9]
      assert.ok(depth === 8 && body[12] === 0 && (colour === 2 || colour === 6), `a PNG of 8-bit RGB or RGBA without interlacing, found depth ${depth} and colour type ${colour}`)
      channels = colour === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      compressed.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  assert.ok(x < width && y < height, `the pixel ${x},${y} is inside the ${width}x${height} image`)
  const raw = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  let previous = new Uint8Array(stride)
  for (let row = 0; row <= y; row++) {
    const current = new Uint8Array(stride)
    const start = row * (stride + 1)
    const filter = raw[start] ?? 0
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? (current[index - channels] ?? 0) : 0
      const up = previous[index] ?? 0
      const upLeft = index >= channels ? (previous[index - channels] ?? 0) : 0
      current[index] = ((raw[start + 1 + index] ?? 0) + predict(filter, left, up, upLeft)) & 0xff
    }
    previous = current
  }
  const at = x * channels
  return { rgb: [previous[at] ?? 0, previous[at + 1] ?? 0, previous[at + 2] ?? 0], width, height }
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return Math.floor((left + up) / 2)
    case 4: {
      const estimate = left + up - upLeft
      const [toLeft, toUp, toUpLeft] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
      if (toLeft <= toUp && toLeft <= toUpLeft) return left
      return toUp <= toUpLeft ? up : upLeft
    }
    default:
      throw new Error(`unknown PNG row filter ${filter}`)
  }
}

/**
 * Checks that a failure screenshot shows the banner of `account`, the colour the task app paints for it across the top
 * of each shared-records page, within 3 of each channel, since a browser may round a colour on its way to the screen.
 */
export function assertShowsAccount(folder: string, path: string, account: string): void {
  const { rgb } = pixelAt(readFileSync(join(folder, path)), 12, 12)
  const expected = accountColour(account)
  const close = rgb.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 3)
  assert.ok(close, `${path} shows the banner of ${account}, ${expected.join(',')}, and its pixel is ${rgb.join(',')}`)
}

/** What the task app's holders counter saw of a name: holders now, the most at once, and how many holds began. */
export type Holders = { current: number; most: number; holds: number }

export async function holders(url: string, name: string): Promise<Holders> {
  const response = await fetch(new URL(`/holders?name=${encodeURIComponent(name)}`, url))
  const body: unknown = await response.json()
  assert.ok(typeof body === 'object' && body !== null && 'most' in body && 'holds' in body && 'current' in body)
  const { current, most, holds } = body
  assert.ok(typeof current === 'number' && typeof most === 'number' && typeof holds === 'number')
  return { current, most, holds }
}

/** One run a host program wrote: its folder, its events and its result. */
export type HostedRun = { output: string; events: RetestEvent[]; result: RunResult | undefined }

/** A host program's end: how it exited, what it printed, and each run it wrote, by the folder name it was given. */
export type HostedRuns = { code: number | null; stdout: string; stderr: string; runs: Record<string, HostedRun> }

/**
 * Runs a host program of the test's own from `root`, from source, in its own process group with its own temporary
 * folder, giving it a scratch folder as its last argument, under which it writes each run to a folder named in `runs`.
 * Each run must leave nothing behind, and every assertion it passed must say who judged it.
 */
export async function runHostProgram(t: TestContext, root: string, file: string, runs: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<HostedRuns> {
  const folder = await scratchFolder(t, 'retest-hosted-')
  const retest = await RetestProcess.start(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', file], args: [folder], env })
  const exit = await retest.exited
  const written: Record<string, HostedRun> = {}
  for (const name of runs) {
    const output = join(folder, name)
    const events = existsSync(join(output, eventsFile)) ? readEvents(readFileSync(join(output, eventsFile), 'utf8')) : []
    assertJudged(events)
    for (const event of events) if (event.type === 'browser.started' || event.type === 'app.started') retest.ownGroup(event.pid)
    const result = existsSync(join(output, resultFile)) ? readResult(readFileSync(join(output, resultFile), 'utf8')) : undefined
    written[name] = { output, events, result }
  }
  await assertReleased(retest, Object.values(written).flatMap((run) => run.events))
  return { code: exit.code, stdout: retest.stdout, stderr: retest.stderr, runs: written }
}

/** The result of the test with this name in a run's result. */
export function resultNamed(result: RunResult | undefined, name: string): TestResult {
  const found = result?.files.flatMap((file) => file.tests).find((each) => each.name === name)
  assert.ok(found !== undefined, `the result lists ${name}`)
  return found
}

/** The events of one attempt, in order. */
export function attemptEvents(events: readonly RetestEvent[], attemptId: string): RetestEvent[] {
  return events.filter((event) => 'attemptId' in event && event.attemptId === attemptId)
}

// The elements that say whose session a page is: the account the cookie signs in, and the name the browser kept.
const identityTestIds: ReadonlySet<string> = new Set(['account', 'shared-account', 'stored-user'])

/**
 * Checks that every look of an attempt names the session of the app it read, and that no look at who is signed in,
 * served by one participant's session, holds the account of another. A record's maker, which a page shows on purpose,
 * is not a look at who is signed in.
 */
export function assertLooksStayWithTheirSession(run: Pick<FinishedRun, 'events'>, attemptId: string, accounts: Readonly<Record<string, string>>): void {
  const looks = eventsOf(run.events, 'observation').filter((event) => event.attemptId === attemptId)
  assert.ok(looks.length > 0, 'the attempt looked at its pages')
  const sawItself = new Set<string>()
  for (const look of looks) {
    const app = look.session ?? ''
    assert.equal(look.sessionId, `${attemptId}:${app}`, `a look at ${app} names that app's session`)
    if (look.locator.by !== 'testId' || !identityTestIds.has(look.locator.value)) continue
    const seen = JSON.stringify(look.observed)
    const own = accounts[app]
    if (own !== undefined && seen.includes(own)) sawItself.add(app)
    for (const [other, account] of Object.entries(accounts)) {
      if (other !== app) assert.equal(seen.includes(account), false, `a look of ${app}'s session never shows ${account}, the account of ${other}`)
    }
  }
  assert.deepEqual([...sawItself].sort(), Object.keys(accounts).sort(), 'every participant saw itself signed in as its own account')
}
