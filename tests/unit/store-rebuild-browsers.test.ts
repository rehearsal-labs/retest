import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { variantProject, variantRun } from './reporters-variant-fixtures.ts'

test('a result rebuilt from events lists each target once, though its tests ran in several browsers', () => {
  const events = variantRun(variantProject()).flatMap((event): RetestEvent[] => {
    if (event.type !== 'browser.started' || event.target?.name !== 'chromium') return [event]
    return [{ ...event, instances: 2 }, { ...event, instance: 2, pid: event.pid + 1 }]
  })
  const rebuilt = rebuildResult(events.slice(0, -1))
  assert.deepEqual(rebuilt.browsers?.map((browser) => [browser.app, browser.target?.name]), [
    ['web', 'chromium'],
    ['web', 'pixel'],
  ])
})
