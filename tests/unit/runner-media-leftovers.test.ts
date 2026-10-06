import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { outputPath } from '../../src/runner/media-leftovers.ts'
import { tempFolder } from '../support/temp-folder.ts'

test('a killed run output cannot follow a symbolic link into another folder', () => {
  const run = tempFolder('old-run-')
  const other = tempFolder('other-run-')
  mkdirSync(join(run, 'artifacts'))
  symlinkSync(other, join(run, 'artifacts', 'a1'))
  assert.equal(outputPath(run, 'artifacts/a1/web/recording-1'), undefined)
})
