import { readFileSync } from 'node:fs'

/** The version this package declares, read once from its package.json. */
export const retestVersion: string = readVersion()

function readVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string') {
    return manifest.version
  }
  throw new Error('The Retest package.json has no version.')
}
