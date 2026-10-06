import type { ArtifactReference, ArtifactRemovalRequestedRecord, ArtifactRemovalFailedRecord, ArtifactRemovedRecord, RetentionPlan, RetentionRecorder } from '../../src/store/artifacts.ts'
import assert from 'node:assert/strict'
import type { PathLike } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, mock, test } from 'node:test'
import { CheckedArtifact, applyRetention, defaultRetentionRules, inventoryArtifacts, planRetention } from '../../src/store/artifacts.ts'

const temporary: string[] = []
after(() => {
  for (const folder of temporary) rmSync(folder, { recursive: true, force: true })
})

function folder(name: string): string {
  const made = mkdtempSync(join(tmpdir(), `retest-retention-${name}-`))
  temporary.push(made)
  return made
}

function put(root: string, reference: string, text: string): void {
  const path = join(root, ...reference.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const passed = 'a1'
const failed = 'a2'
const recordingOf = (attemptId: string, name: string): string => `artifacts/${attemptId}/web/${name}`

// A run with one passed and one failed attempt, each with a recording, a thumbnail of it and a failure screenshot;
// a recording of the passed attempt an AI check judged; diagnostics; a lost recording's partial; and the run's files.
function runFolder(): { run: string; references: ArtifactReference[] } {
  const run = folder('run')
  const references: ArtifactReference[] = []
  for (const attemptId of [passed, failed]) {
    const owner = { testId: `tests/a.retest.ts > ${attemptId}`, attemptId, app: 'web', sessionId: `${attemptId}:web` }
    put(run, recordingOf(attemptId, 'recording-1.mp4'), `video ${attemptId}`)
    put(run, recordingOf(attemptId, 'thumbnail-recording-1.jpg'), `thumb ${attemptId}`)
    put(run, recordingOf(attemptId, 'screenshot-failure-1.png'), `shot ${attemptId}`)
    put(run, `diagnostics/${attemptId}.web.jsonl`, '{}\n')
    references.push(
      { path: recordingOf(attemptId, 'recording-1.mp4'), kind: 'recording', namedBy: 'recording.finished', ...owner },
      { path: recordingOf(attemptId, 'thumbnail-recording-1.jpg'), kind: 'thumbnail', namedBy: 'recording.finished', of: recordingOf(attemptId, 'recording-1.mp4'), ...owner },
      { path: recordingOf(attemptId, 'screenshot-failure-1.png'), kind: 'screenshot', namedBy: 'evidence.captured', ...owner },
      { path: `diagnostics/${attemptId}.web.jsonl`, kind: 'diagnostics', namedBy: 'diagnostics.finished', ...owner },
    )
  }
  put(run, recordingOf(passed, 'recording-2.mp4'), 'judged video')
  references.push(
    { path: recordingOf(passed, 'recording-2.mp4'), kind: 'recording', namedBy: 'recording.finished', attemptId: passed, sessionId: `${passed}:web` },
    { path: recordingOf(passed, 'recording-2.mp4'), kind: 'recording', namedBy: 'evaluation.finished', evidenceOf: 'evaluation', attemptId: passed },
  )
  put(run, recordingOf(passed, 'recording-3.mp4.partial'), 'lost video')
  put(run, recordingOf(failed, 'recording-2.mp4.partial'), 'lost but kept as partial evidence')
  references.push({ path: recordingOf(failed, 'recording-2.mp4.partial'), kind: 'recording', namedBy: 'recording.lost', attemptId: failed })
  put(run, 'diagnostics/stray.jsonl.partial', 'not a recording')
  for (const own of ['events.jsonl', 'result.json', 'result.json.partial', 'logs/a.log']) put(run, own, 'run file')
  return { run, references }
}

function recorder(): RetentionRecorder & { records: (ArtifactRemovalRequestedRecord | ArtifactRemovedRecord | ArtifactRemovalFailedRecord)[] } {
  const records: (ArtifactRemovalRequestedRecord | ArtifactRemovedRecord | ArtifactRemovalFailedRecord)[] = []
  return { records, removing: (record) => { records.push(record); return true }, removed: (record) => { records.push(record) }, failed: (record) => { records.push(record) } }
}

describe('planning what to keep', () => {
  test('when only failures are kept, a passed attempt loses its recording and the thumbnail made from it, and nothing else', () => {
    const { run, references } = runFolder()
    const inventory = inventoryArtifacts(run, references)
    const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory })
    assert.deepEqual(plan.removals, [
      { reference: recordingOf(passed, 'recording-1.mp4'), kind: 'recording', reason: 'passed_attempt_recording', owner: { testId: 'tests/a.retest.ts > a1', attemptId: passed, app: 'web', sessionId: 'a1:web' } },
      { reference: recordingOf(passed, 'thumbnail-recording-1.jpg'), kind: 'thumbnail', reason: 'thumbnail_of_removed', owner: { testId: 'tests/a.retest.ts > a1', attemptId: passed, app: 'web', sessionId: 'a1:web' } },
    ])
    assert.deepEqual(plan.kept, [{ reference: recordingOf(passed, 'recording-2.mp4'), why: "an AI check's evidence names it (evaluation.finished)" }])
  })

  test('an attempt that did not pass, or rules that keep every recording, remove nothing', () => {
    const { run, references } = runFolder()
    const inventory = inventoryArtifacts(run, references)
    for (const status of ['failed', 'error', 'inconclusive', 'not_run', 'skipped'] as const) {
      assert.deepEqual(planRetention({ moment: { kind: 'attempt_finished', attemptId: failed, status }, rules: { recordings: 'failures' }, references, inventory }).removals, [], status)
    }
    assert.deepEqual(planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: defaultRetentionRules, references, inventory }).removals, [])
  })

  test('a recording another attempt or another kind of record names is kept, and so is one that is not there', () => {
    const run = folder('shared')
    put(run, 'artifacts/a1/web/recording-1.mp4', 'video')
    put(run, 'artifacts/a1/web/recording-2.mp4', 'video')
    const references: ArtifactReference[] = [
      { path: 'artifacts/a1/web/recording-1.mp4', kind: 'recording', namedBy: 'recording.finished', attemptId: passed },
      { path: 'artifacts/a1/web/recording-1.mp4', kind: 'recording', namedBy: 'recording.finished', attemptId: failed },
      { path: 'artifacts/a1/web/recording-2.mp4', kind: 'recording', namedBy: 'recording.finished', attemptId: passed },
      { path: 'artifacts/a1/web/recording-2.mp4', kind: 'screenshot', namedBy: 'evidence.captured', attemptId: passed },
      { path: 'artifacts/a1/web/recording-9.mp4', kind: 'recording', namedBy: 'recording.finished', attemptId: passed },
      { path: 'diagnostics/odd.mp4', kind: 'recording', namedBy: 'recording.finished', attemptId: passed },
    ]
    const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
    assert.deepEqual(plan.removals, [])
    assert.deepEqual(plan.kept.map((kept) => [kept.reference, kept.why]), [
      ['artifacts/a1/web/recording-1.mp4', 'recording.finished names it as a recording of attempt a2'],
      ['artifacts/a1/web/recording-2.mp4', 'evidence.captured names it as a screenshot'],
      ['artifacts/a1/web/recording-9.mp4', 'it is not present'],
      ['diagnostics/odd.mp4', 'it is not inside artifacts/'],
    ])
  })

  test('when the run finishes, the partials no record names go, and every other file stays', () => {
    const { run, references } = runFolder()
    const plan = planRetention({ moment: { kind: 'run_finished' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
    assert.deepEqual(plan.removals, [{ reference: recordingOf(passed, 'recording-3.mp4.partial'), kind: 'partial', reason: 'lost_recording_partial', owner: {} }])
  })

  test('nothing a record names is planned for removal at either moment while the rules keep every recording', () => {
    const { run, references } = runFolder()
    const inventory = inventoryArtifacts(run, references)
    const named = new Set(references.map((reference) => reference.path))
    const plans: RetentionPlan[] = [
      planRetention({ moment: { kind: 'run_finished' }, rules: defaultRetentionRules, references, inventory }),
      planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: defaultRetentionRules, references, inventory }),
      planRetention({ moment: { kind: 'attempt_finished', attemptId: failed, status: 'failed' }, rules: { recordings: 'failures' }, references, inventory }),
    ]
    for (const plan of plans) for (const removal of plan.removals) assert.equal(named.has(removal.reference), false, removal.reference)
  })
})

describe('applying a plan', () => {
  test('each removal is recorded before its file goes, and only the planned files go', () => {
    const { run, references } = runFolder()
    const inventory = inventoryArtifacts(run, references)
    const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory })
    const seenAtRecord: boolean[] = []
    const records: ArtifactRemovedRecord[] = []
    const requests: ArtifactRemovalRequestedRecord[] = []
    const seenAtCompletion: boolean[] = []
    const outcome = applyRetention(run, plan, {
      removing: (record) => {
        seenAtRecord.push(existsSync(join(run, record.path)))
        requests.push(record)
        return true
      },
      removed: (record) => {
        seenAtCompletion.push(existsSync(join(run, record.path)))
        records.push(record)
      },
      failed: () => assert.fail('no removal failed'),
    })
    assert.deepEqual(seenAtRecord, [true, true], 'each file was still there when its request was recorded')
    assert.deepEqual(seenAtCompletion, [false, false], 'each completion is recorded only after the file goes')
    assert.deepEqual(requests, records.map((record) => ({ ...record, type: 'artifact.removal_requested' })))
    assert.deepEqual(outcome.refused, [])
    assert.deepEqual(outcome.removed, records)
    assert.deepEqual(records, [
      { type: 'artifact.removed', path: recordingOf(passed, 'recording-1.mp4'), kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 'video a1'.length, testId: 'tests/a.retest.ts > a1', attemptId: passed, session: 'web', sessionId: 'a1:web' },
      { type: 'artifact.removed', path: recordingOf(passed, 'thumbnail-recording-1.jpg'), kind: 'thumbnail', reason: 'thumbnail_of_removed', moment: 'attempt_finished', bytes: 'thumb a1'.length, testId: 'tests/a.retest.ts > a1', attemptId: passed, session: 'web', sessionId: 'a1:web' },
    ])
    assert.equal(existsSync(join(run, recordingOf(passed, 'recording-1.mp4'))), false)
    assert.equal(existsSync(join(run, recordingOf(passed, 'thumbnail-recording-1.jpg'))), false)
    for (const kept of [recordingOf(passed, 'recording-2.mp4'), recordingOf(passed, 'screenshot-failure-1.png'), recordingOf(failed, 'recording-1.mp4'), recordingOf(failed, 'thumbnail-recording-1.jpg'), 'diagnostics/a1.web.jsonl']) {
      assert.ok(existsSync(join(run, kept)), kept)
    }
  })

  test('at the end of the run the unnamed partial goes and the named one stays', () => {
    const { run, references } = runFolder()
    const plan = planRetention({ moment: { kind: 'run_finished' }, rules: defaultRetentionRules, references, inventory: inventoryArtifacts(run, references) })
    const log = recorder()
    const outcome = applyRetention(run, plan, log)
    assert.deepEqual(outcome.removed.map((record) => [record.path, record.kind, record.reason, record.moment]), [[recordingOf(passed, 'recording-3.mp4.partial'), 'partial', 'lost_recording_partial', 'run_finished']])
    assert.ok(existsSync(join(run, recordingOf(failed, 'recording-2.mp4.partial'))))
    assert.ok(existsSync(join(run, 'diagnostics/stray.jsonl.partial')))
    assert.ok(existsSync(join(run, 'result.json.partial')))
  })

  test('a plan that names a file outside artifacts/, or a recording as a partial, is refused and the file stays', () => {
    const run = folder('outside-artifacts')
    put(run, 'diagnostics/a.jsonl', '{}')
    put(run, 'artifacts/a1/web/recording-1.mp4', 'video')
    put(run, 'result.json', '{}')
    const plan: RetentionPlan = {
      moment: { kind: 'run_finished' },
      removals: [
        { reference: 'diagnostics/a.jsonl', kind: 'diagnostics', reason: 'lost_recording_partial', owner: {} },
        { reference: 'result.json', kind: 'report', reason: 'lost_recording_partial', owner: {} },
        { reference: 'artifacts/a1/web/recording-1.mp4', kind: 'partial', reason: 'lost_recording_partial', owner: {} },
        { reference: 'artifacts/../result.json', kind: 'recording', reason: 'passed_attempt_recording', owner: {} },
      ],
      kept: [],
    }
    const log = recorder()
    const outcome = applyRetention(run, plan, log)
    assert.deepEqual(outcome.removed, [])
    assert.deepEqual(log.records, [])
    assert.deepEqual(outcome.refused.map((entry) => entry.reason), ['not_removable', 'not_removable', 'not_removable', 'not_removable'])
    for (const kept of ['diagnostics/a.jsonl', 'result.json', 'artifacts/a1/web/recording-1.mp4']) assert.ok(existsSync(join(run, kept)), kept)
  })

  test('a planned file that became a link to a file outside is refused, recorded nowhere, and the outside file stays', () => {
    const { run, references } = runFolder()
    const outside = folder('outside')
    writeFileSync(join(outside, 'precious.mp4'), 'precious')
    const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
    rmSync(join(run, recordingOf(passed, 'recording-1.mp4')))
    symlinkSync(join(outside, 'precious.mp4'), join(run, recordingOf(passed, 'recording-1.mp4')))
    const log = recorder()
    const outcome = applyRetention(run, plan, log)
    assert.deepEqual(outcome.refused.map((entry) => [entry.reference, entry.reason]), [[recordingOf(passed, 'recording-1.mp4'), 'outside_run_folder']])
    assert.equal(readFileSync(join(outside, 'precious.mp4'), 'utf8'), 'precious')
    assert.deepEqual(log.records.map((record) => [record.type, record.path]), [['artifact.removal_requested', recordingOf(passed, 'thumbnail-recording-1.jpg')], ['artifact.removed', recordingOf(passed, 'thumbnail-recording-1.jpg')]])
  })

  test('a folder swapped for a link after the removal was recorded is caught before the unlink: the outside file stays and the failure is recorded', () => {
    const { run, references } = runFolder()
    const outside = folder('swap')
    mkdirSync(join(outside, 'web'))
    writeFileSync(join(outside, 'web', 'recording-1.mp4'), 'precious')
    writeFileSync(join(outside, 'web', 'thumbnail-recording-1.jpg'), 'precious thumbnail')
    const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
    const records: (ArtifactRemovalRequestedRecord | ArtifactRemovedRecord | ArtifactRemovalFailedRecord)[] = []
    let swapped = false
    const outcome = applyRetention(run, plan, {
      removing: (record) => {
        records.push(record)
        if (swapped) return true
        swapped = true
        renameSync(join(run, 'artifacts', passed), join(run, 'artifacts', `${passed}-moved`))
        symlinkSync(outside, join(run, 'artifacts', passed))
        return true
      },
      removed: () => assert.fail('a swapped file must not be removed'),
      failed: (record) => records.push(record),
    })
    assert.equal(readFileSync(join(outside, 'web', 'recording-1.mp4'), 'utf8'), 'precious')
    assert.equal(readFileSync(join(outside, 'web', 'thumbnail-recording-1.jpg'), 'utf8'), 'precious thumbnail')
    assert.deepEqual(outcome.removed, [])
    assert.deepEqual(outcome.refused.map((entry) => [entry.reference, entry.reason]), [
      [recordingOf(passed, 'recording-1.mp4'), 'changed'],
      [recordingOf(passed, 'thumbnail-recording-1.jpg'), 'outside_run_folder'],
    ])
    assert.deepEqual(records.map((record) => [record.type, record.path]), [
      ['artifact.removal_requested', recordingOf(passed, 'recording-1.mp4')],
      ['artifact.removal_failed', recordingOf(passed, 'recording-1.mp4')],
    ])
    const failure = records[1]
    assert.ok(failure?.type === 'artifact.removal_failed')
    assert.match(failure.message, /was replaced/)
    assert.ok(existsSync(join(run, 'artifacts', `${passed}-moved`, 'web', 'recording-1.mp4')), 'the run\'s own file was not removed either')
  })

  test('a removal whose record cannot be written keeps its file', () => {
    const { run, references } = runFolder()
    const plan = planRetention({ moment: { kind: 'run_finished' }, rules: defaultRetentionRules, references, inventory: inventoryArtifacts(run, references) })
    const outcome = applyRetention(run, plan, {
      removing: () => {
        throw new Error('the event log is closed')
      },
      removed: () => assert.fail('nothing was removed'),
      failed: () => assert.fail('nothing was removed, so nothing failed'),
    })
    assert.deepEqual(outcome.refused.map((entry) => entry.reason), ['unrecorded'])
    assert.match(outcome.refused[0]?.message ?? '', /the event log is closed/)
    assert.ok(existsSync(join(run, recordingOf(passed, 'recording-3.mp4.partial'))))
  })
})

test('a directory swapped after final verification is refused before unlinking through its verified handle', () => {
  const { run, references } = runFolder()
  const outside = folder('after-verify')
  writeFileSync(join(outside, 'recording-1.mp4'), 'precious outside file')
  const reference = recordingOf(passed, 'recording-1.mp4')
  const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
  const original = CheckedArtifact.prototype.verify
  let swapped = false
  const hook = mock.method(CheckedArtifact.prototype, 'verify', function (this: CheckedArtifact) {
    const problem = original.call(this)
    if (this.reference === reference && problem === undefined && !swapped) {
      swapped = true
      renameSync(join(run, 'artifacts', passed, 'web'), join(run, 'artifacts', passed, 'web-moved'))
      symlinkSync(outside, join(run, 'artifacts', passed, 'web'))
    }
    return problem
  })
  try {
    const outcome = applyRetention(run, { ...plan, removals: plan.removals.filter((removal) => removal.reference === reference) }, recorder())
    assert.ok(swapped, 'the swap happened after verification accepted the intended file')
    assert.ok(existsSync(join(outside, 'recording-1.mp4')), 'the outside file survives')
    assert.equal(readFileSync(join(outside, 'recording-1.mp4'), 'utf8'), 'precious outside file')
    assert.ok(existsSync(join(run, 'artifacts', passed, 'web-moved', 'recording-1.mp4')), 'the intended file remains present')
    assert.deepEqual(outcome.removed, [])
    assert.equal(outcome.refused[0]?.reason, 'changed')
    assert.match(outcome.refused[0]?.message ?? '', /replaced|changed/)
  } finally { hook.mock.restore() }
})

test('a thumbnail shared with a retained recording is kept with its other owner reason', () => {
  const { run, references } = runFolder()
  const thumbnail = recordingOf(passed, 'thumbnail-recording-1.jpg')
  references.push({ path: thumbnail, kind: 'thumbnail', namedBy: 'recording.finished', of: recordingOf(failed, 'recording-1.mp4'), attemptId: failed, sessionId: `${failed}:web` })
  const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
  assert.ok(plan.removals.some((removal) => removal.reference === recordingOf(passed, 'recording-1.mp4')))
  assert.ok(!plan.removals.some((removal) => removal.reference === recordingOf(failed, 'recording-1.mp4')))
  assert.ok(!plan.removals.some((removal) => removal.reference === thumbnail), 'the failed recording still owns the thumbnail')
  assert.match(plan.kept.find((kept) => kept.reference === thumbnail)?.why ?? '', /recording.finished.*attempt a2|retained recording/)
})

test('a swap inside the unlink call cannot redirect deletion outside the opened parent directory', () => {
  const { run, references } = runFolder()
  const outside = folder('unlink-boundary')
  writeFileSync(join(outside, 'recording-1.mp4'), 'precious outside file')
  const reference = recordingOf(passed, 'recording-1.mp4')
  const plan = planRetention({ moment: { kind: 'attempt_finished', attemptId: passed, status: 'passed' }, rules: { recordings: 'failures' }, references, inventory: inventoryArtifacts(run, references) })
  const original = fs.unlinkSync
  let swapped = false
  const hook = mock.method(fs, 'unlinkSync', (path: PathLike) => {
    if (typeof path === 'string' && path.endsWith('recording-1.mp4') && !swapped) {
      swapped = true
      renameSync(join(run, 'artifacts', passed, 'web'), join(run, 'artifacts', passed, 'web-moved'))
      symlinkSync(outside, join(run, 'artifacts', passed, 'web'))
    }
    original(path)
  })
  syncBuiltinESMExports()
  try {
    const outcome = applyRetention(run, { ...plan, removals: plan.removals.filter((removal) => removal.reference === reference) }, recorder())
    assert.ok(swapped)
    assert.ok(existsSync(join(outside, 'recording-1.mp4')), 'unlink must stay anchored to the verified parent even inside the call boundary')
    assert.equal(readFileSync(join(outside, 'recording-1.mp4'), 'utf8'), 'precious outside file')
    assert.equal(outcome.removed.length, 1, 'the original entry was removed through its opened parent')
    assert.ok(!existsSync(join(run, 'artifacts', passed, 'web-moved', 'recording-1.mp4')))
  } finally { hook.mock.restore(); syncBuiltinESMExports() }
})
