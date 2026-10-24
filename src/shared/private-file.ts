import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { consolesDetached, holdLaunch, prepareOwnedLaunch } from './process-system.ts'

// A folder that holds secrets, such as a run's saved sign-in states, is open to this user alone, and so is every file
// later made in it. On macOS and Linux the mode it is created with does that. Windows ignores the mode and gives a new
// folder the access list of its parent, which under C:\ lets every local user read it, and a file made in it takes that
// list too. There the folder keeps nothing of its parent's list and gets one entry, this user's full control, which
// every file and folder made in it inherits. That is done before any file is made in it: Windows checks access when a
// file is opened, so a file another user opened while it was still open to them would stay open to them.
//
// whoami and icacls run as every program Retest starts does, through the launch seam, and are waited for without
// blocking: each is held in a job of its own on Windows, and one that has not ended within its time is ended with it.

const toolTimeoutMs = 10_000
const outputLimit = 64 * 1024

/**
 * Why a folder could not be kept to this user alone: `message` is a sentence for a person, `detail` names the Windows
 * tool and what it said.
 */
export class PrivateFolderError extends Error {
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.name = 'PrivateFolderError'
    this.detail = detail
  }
}

let userSid: Promise<string> | undefined

/**
 * Leaves `folder`, an empty folder this process just made, readable and writable by the user this process runs as and by
 * no other user, and makes every file and folder later made in it inherit that. Nothing runs on macOS and Linux, where
 * the folder's mode does it. On Windows every inherited entry is removed, Users' read among them, and this user's SID
 * gets full control, passed on to what the folder will hold. An entry the folder holds as its own stays: under a parent
 * whose list is not marked as passed down, such as a temporary folder Node makes, Windows writes the system's and the
 * administrators' that way, and they read any file, as root does on Unix. Throws a `PrivateFolderError` when that cannot
 * be done.
 *
 * @example mkdirSync(folder, { mode: 0o700 }); await keepFolderToUser(folder)
 */
export async function keepFolderToUser(folder: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'win32') return
  const sid = await currentUserSid()
  const ended = await runOwnedTool(systemTool('icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`])
  if (ended !== undefined) throw new PrivateFolderError('its folder could not be kept to this user alone.', `icacls.exe ${ended}`)
}

/**
 * The SID of the user this process runs as, from whoami, read once.
 *
 * @example await currentUserSid() // 'S-1-5-21-…-1001'
 */
export function currentUserSid(): Promise<string> {
  const reading = (userSid ??= readUserSid())
  // A reading that failed is not kept, so the next save asks again.
  reading.catch(() => {
    if (userSid === reading) userSid = undefined
  })
  return reading
}

async function readUserSid(): Promise<string> {
  const output: string[] = []
  const ended = await runOwnedTool(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { output })
  const printed = (output[0] ?? '').trim()
  const sid = ended === undefined ? /"(S-1-[0-9-]+)"\s*$/.exec(printed)?.[1] : undefined
  if (sid === undefined) throw new PrivateFolderError('Retest could not tell which user it runs as.', `whoami.exe ${ended ?? `printed no SID: ${printed}`}`)
  return sid
}

/**
 * Runs a Windows tool to its end through the launch seam, with an environment of `SystemRoot` alone: undefined once it
 * ended with 0, otherwise how it ended, as a clause for a detail. One that has not ended within `timeoutMs` is ended,
 * with everything it started. What it printed on stdout is pushed to `output`.
 *
 * @example await runOwnedTool('C:\\Windows\\System32\\whoami.exe', []) // undefined
 */
export async function runOwnedTool(program: string, args: readonly string[], options: { output?: string[]; timeoutMs?: number } = {}): Promise<string | undefined> {
  const { output = [], timeoutMs = toolTimeoutMs } = options
  let child: ReturnType<typeof spawn>
  try {
    prepareOwnedLaunch()
    child = spawn(program, args, { env: { SystemRoot: systemRoot() }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: consolesDetached })
  } catch (error) {
    return `could not start: ${error instanceof Error ? error.message : String(error)}`
  }
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    if (stdout.length < outputLimit) stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    if (stderr.length < outputLimit) stderr += chunk
  })
  const ended = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }))
    child.once('close', (code: number | null) => resolve({ code }))
  })
  const ownership = child.pid === undefined ? undefined : holdLaunch(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (ownership === undefined) child.kill('SIGKILL')
    else ownership.signal('SIGKILL')
  }, timeoutMs)
  try {
    const { code, error } = await ended
    output.push(stdout)
    if (error !== undefined) return `could not start: ${error.message}`
    if (timedOut) return `did not finish within ${timeoutMs} ms and was ended`
    if (code === 0) return undefined
    const said = (stderr.trim() || stdout.trim()).split(/\r?\n/, 1)[0] ?? ''
    return `ended with exit code ${code ?? 'none'}${said === '' ? '' : `: ${said}`}`
  } finally {
    clearTimeout(timer)
  }
}

// The tools are named by their place in the system folder, never looked up on PATH.
function systemTool(name: string): string {
  return win32.join(systemRoot(), 'System32', name)
}

function systemRoot(): string {
  return process.env['SystemRoot'] ?? 'C:\\Windows'
}
