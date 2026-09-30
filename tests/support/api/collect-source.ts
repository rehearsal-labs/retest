import type { Collected, TestEntry } from '../../../src/api/registry.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectFile, findTest } from '../../../src/api/registry.ts'
import { testId, testTitle } from '../../../src/protocol/run-folder.ts'
import { tempFolder } from '../temp-folder.ts'

// The same module the unit tests import, so a written file registers with the registry they read.
const entry = new URL('../../../src/index.ts', import.meta.url).href

export type CollectedSource = { collected: Collected; file: string; rootDir: string }

let written = 0

/**
 * Writes a JavaScript test file whose first line imports `test`, `expect` and `secret`, so `source` starts on
 * line 2, and collects it in this process as a test file's process would.
 */
export async function collectSource(source: string): Promise<CollectedSource> {
  const rootDir = tempFolder('collect-')
  written++
  const file = `case-${written}.retest.js`
  writeFileSync(join(rootDir, file), `import { expect, secret, test } from ${JSON.stringify(entry)}\n${source}\n`)
  return { collected: await collectFile(file, rootDir), file, rootDir }
}

/** The collected test with this title, its `test.describe` names first. */
export function collectedTest({ file }: CollectedSource, name: string, describePath: readonly string[] = []): TestEntry {
  const found = findTest(testId(file, testTitle(name, describePath)))
  assert.ok(found, `a test named ${JSON.stringify(name)} was collected`)
  return found.test
}

/** The failure a collection that should have failed gave. */
export function collectionFailure({ collected }: CollectedSource): Extract<Collected, { ok: false }>['failure'] {
  assert.ok(!collected.ok, 'the file failed collection')
  return collected.failure
}
