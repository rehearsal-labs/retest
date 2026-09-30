import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string | undefined

/** A new folder under one root per test process; the root is removed when the process exits. */
export function tempFolder(prefix: string): string {
  root ??= createRoot()
  return mkdtempSync(join(root, prefix))
}

function createRoot(): string {
  const folder = mkdtempSync(join(tmpdir(), 'retest-tests-'))
  process.once('exit', () => rmSync(folder, { recursive: true, force: true }))
  return folder
}
