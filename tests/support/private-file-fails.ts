import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Stands in for src/shared/private-file.ts in tests/unit/store-states.test.ts: the access-list step fails, as icacls
// refused would, and the folder it was given is held so it cannot be removed: on macOS and Linux its parent is made
// unwritable; on Windows a file in it is held open by another process that lets no one delete it (Node's own opens
// always let a file be deleted, and an administrator deletes through an access list that denies it).

export class PrivateFolderError extends Error {
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.name = 'PrivateFolderError'
    this.detail = detail
  }
}

const held: { folder?: string; worker?: ChildProcess } = {}

export async function keepFolderToUser(folder: string): Promise<void> {
  held.folder = folder
  if (process.platform === 'win32') {
    const file = join(folder, 'held.txt').replaceAll("'", "''")
    const script = `$held = [System.IO.File]::Open('${file}', 'OpenOrCreate', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 60`
    const worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    held.worker = worker
    await new Promise<void>((resolve, reject) => {
      worker.stdout?.setEncoding('utf8').on('data', (text: string) => {
        if (text.includes('held')) resolve()
      })
      worker.once('exit', () => reject(new Error('the PowerShell that holds the file ended first')))
    })
  } else {
    chmodSync(dirname(folder), 0o500)
  }
  throw new PrivateFolderError('its folder could not be kept to this user alone.', 'icacls.exe ended with exit code 5: Access is denied.')
}

/** Lets go of what `keepFolderToUser` held. */
export async function release(): Promise<void> {
  const { worker, folder } = held
  if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
    const ended = new Promise((resolve) => worker.once('exit', resolve))
    worker.kill('SIGKILL')
    await ended
  }
  if (folder !== undefined && process.platform !== 'win32') chmodSync(dirname(folder), 0o700)
}
