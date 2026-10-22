import { chmodSync, closeSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Stands in for src/shared/private-file.ts in tests/unit/store-states.test.ts: the access-list step fails, as icacls
// refused would, and the folder it was given is held so it cannot be removed: on macOS and Linux its parent is made
// unwritable, on Windows a file in it is held open.

export class PrivateFolderError extends Error {
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.name = 'PrivateFolderError'
    this.detail = detail
  }
}

/** The folder the stand-in held, for the caller to let go once the failure is read. */
export const held: { folder?: string; descriptor?: number } = {}

export async function keepFolderToUser(folder: string): Promise<void> {
  held.folder = folder
  if (process.platform === 'win32') held.descriptor = openSync(join(folder, 'held.txt'), 'w')
  else chmodSync(dirname(folder), 0o500)
  throw new PrivateFolderError('its folder could not be kept to this user alone.', 'icacls.exe ended with exit code 5: Access is denied.')
}

/** Lets go of what `keepFolderToUser` held. */
export function release(): void {
  if (held.descriptor !== undefined) closeSync(held.descriptor)
  if (held.folder !== undefined && process.platform !== 'win32') chmodSync(dirname(held.folder), 0o700)
}
