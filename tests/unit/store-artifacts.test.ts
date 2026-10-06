import { evaluationFramePath, missingEvaluationFramePath, evaluationDiagnosticsPath, extendedEvidenceRun } from './reporters-html-fixtures.ts'
import { resultOf, projectFolder } from './reporters-fixtures.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { ArtifactReference } from '../../src/store/artifacts.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  ArtifactSequences,
  artifactPath,
  checkArtifact,
  createArtifactFolder,
  eventArtifactReferences,
  inventoryArtifacts,
  portableReference,
  readArtifactFile,
  recordingOutput,
  referenceProblem,
  resolveReference,
  resultArtifactReferences,
} from '../../src/store/artifacts.ts'
import { readEvents } from '../../src/store/read-run-folder.ts'

const identity: RecordIdentity = { testId: 'tests/login.retest.ts > signs in as {{password}}', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web', observationId: 'o7' }
const megabyte = 1024 * 1024
const temporary: string[] = []
after(() => {
  for (const folder of temporary) rmSync(folder, { recursive: true, force: true })
})

function folder(name: string): string {
  const made = mkdtempSync(join(tmpdir(), `retest-artifacts-${name}-`))
  temporary.push(made)
  return made
}

function put(root: string, reference: string, text: string): string {
  const path = join(root, ...reference.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('artifact paths', () => {
  test('each kind has its place inside the run folder, named only from the attempt, the app, the kind and a number', () => {
    const app = artifactPath({ kind: 'screenshot', identity, purpose: 'failure', sequence: 1, format: 'png' }).split('/')[2] ?? ''
    assert.match(app, /^web-[a-z0-9]{13}$/)
    const folderOf = `artifacts/k3v9q0x2mb/${app}`
    assert.equal(artifactPath({ kind: 'screenshot', identity, purpose: 'failure', sequence: 1, format: 'png' }), `${folderOf}/screenshot-failure-1.png`)
    assert.equal(artifactPath({ kind: 'screenshot', identity, purpose: 'evaluation', sequence: 12, format: 'jpeg' }), `${folderOf}/screenshot-evaluation-12.jpg`)
    assert.equal(artifactPath({ kind: 'thumbnail', identity, of: { kind: 'screenshot', purpose: 'failure', sequence: 1 }, format: 'jpeg' }), `${folderOf}/thumbnail-screenshot-failure-1.jpg`)
    assert.equal(artifactPath({ kind: 'thumbnail', identity, of: { kind: 'recording', sequence: 2 }, format: 'png' }), `${folderOf}/thumbnail-recording-2.png`)
    assert.equal(artifactPath({ kind: 'recording', identity, sequence: 2, container: 'webm' }), `${folderOf}/recording-2.webm`)
    assert.equal(artifactPath({ kind: 'frames', identity, sequence: 1, index: 7, format: 'jpeg' }), `${folderOf}/frames-1/000007.jpg`)
    assert.equal(artifactPath({ kind: 'frames', identity, sequence: 1, index: 1_234_567, format: 'png' }), `${folderOf}/frames-1/1234567.png`)
    assert.equal(artifactPath({ kind: 'diagnostics', identity }), `diagnostics/k3v9q0x2mb.${app}.jsonl`)
    assert.equal(artifactPath({ kind: 'report' }), 'report.html')
    assert.equal(recordingOutput(identity, 3), `${folderOf}/recording-3`)
  })

  test('no test title, look id or secret placeholder reaches a name, and every name is a portable reference', () => {
    const hostile: RecordIdentity = { testId: '../../etc/passwd <script>', attemptId: 'Attempt 1/../x', app: '../../Home Screen', sessionId: 'Attempt 1/../x:../../Home Screen', observationId: 'o1' }
    const paths = [identity, hostile].flatMap((each) => [
      artifactPath({ kind: 'screenshot', identity: each, purpose: 'evaluation', sequence: 3, format: 'png' }),
      artifactPath({ kind: 'thumbnail', identity: each, of: { kind: 'recording', sequence: 1 }, format: 'jpeg' }),
      artifactPath({ kind: 'recording', identity: each, sequence: 1, container: 'mp4' }),
      artifactPath({ kind: 'frames', identity: each, sequence: 1, index: 0, format: 'jpeg' }),
      artifactPath({ kind: 'diagnostics', identity: each }),
    ])
    for (const path of paths) {
      assert.equal(referenceProblem(path), undefined, path)
      assert.doesNotMatch(path, /password|login|signs|script|passwd|\.\./)
    }
    const hostileShot = artifactPath({ kind: 'screenshot', identity: hostile, purpose: 'failure', sequence: 1, format: 'png' })
    assert.match(hostileShot, /^artifacts\/attempt-1-[a-z0-9]{13}\/home-scre-[a-z0-9]{13}\/screenshot-failure-1\.png$/)
  })

  test('two apps that differ only in case get different folders', () => {
    const upper: RecordIdentity = { testId: 't', attemptId: 'a1', app: 'Web', sessionId: 'a1:Web' }
    const lower: RecordIdentity = { testId: 't', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
    assert.notEqual(artifactPath({ kind: 'recording', identity: upper, sequence: 1, container: 'mp4' }).toLowerCase(), artifactPath({ kind: 'recording', identity: lower, sequence: 1, container: 'mp4' }).toLowerCase())
  })

  test('an identity whose session is another, or a number, purpose or format outside the list, is refused', () => {
    const other: RecordIdentity = { ...identity, sessionId: 'k3v9q0x2mb:phone' }
    assert.throws(() => artifactPath({ kind: 'diagnostics', identity: other }), /names session "k3v9q0x2mb:phone", which is not "k3v9q0x2mb:web"/)
    assert.throws(() => artifactPath({ kind: 'recording', identity, sequence: 0, container: 'mp4' }), RangeError)
    assert.throws(() => artifactPath({ kind: 'recording', identity, sequence: 1.5, container: 'mp4' }), RangeError)
    assert.throws(() => artifactPath({ kind: 'frames', identity, sequence: 1, index: -1, format: 'png' }), RangeError)
    // A caller past the types, as a JavaScript caller or a parsed record is, still never gets a path out of these.
    const loosely = (spec: object): unknown => Reflect.apply(artifactPath, undefined, [spec])
    assert.throws(() => loosely({ kind: 'screenshot', identity, purpose: '../escape', sequence: 1, format: 'png' }), RangeError)
    assert.throws(() => loosely({ kind: 'screenshot', identity, purpose: 'failure', sequence: 1, format: 'png/../../x' }), RangeError)
    assert.throws(() => loosely({ kind: 'recording', identity, sequence: 1, container: 'mp4/../../x' }), RangeError)
    assert.throws(() => loosely({ kind: 'thumbnail', identity, of: { kind: 'screenshot', purpose: '../escape', sequence: 1 }, format: 'png' }), RangeError)
  })

  test('sequences count from 1 for each session and family', () => {
    const sequences = new ArtifactSequences()
    const phone: RecordIdentity = { testId: 't', attemptId: 'k3v9q0x2mb', app: 'phone', sessionId: 'k3v9q0x2mb:phone' }
    assert.deepEqual([sequences.next(identity, 'evaluation'), sequences.next(identity, 'evaluation'), sequences.next(identity, 'recording'), sequences.next(phone, 'evaluation')], [1, 2, 1, 1])
    assert.throws(() => sequences.next({ ...identity, sessionId: 'x' }, 'recording'), RangeError)
  })
})

describe('portable references', () => {
  test('a reference is relative, POSIX, and made of plain parts', () => {
    for (const reference of ['artifacts/a/b.png', 'diagnostics/k3v9q0x2mb.web-0123456789abc.jsonl', 'artifacts/examples-task-retest-ts-sa-0abc-k3v9q0x2mb-failure.png', 'a', 'A_b-c.d']) {
      assert.equal(referenceProblem(reference), undefined, reference)
    }
    const refused: [string, RegExp][] = [
      ['', /empty/],
      ['/etc/passwd', /absolute/],
      ['../secret', /starts with "\."/],
      ['artifacts/../../secret', /starts with "\."/],
      ['artifacts/./a.png', /starts with "\."/],
      ['artifacts/.hidden', /starts with "\."/],
      ['artifacts//a.png', /empty part/],
      ['artifacts/a.png/', /empty part/],
      ['artifacts\\..\\a.png', /backslash/],
      ['C:/Windows/win.ini', /character other than/],
      ['javascript:alert(1)', /character other than/],
      ['artifacts/a b.png', /character other than/],
      ['artifacts/%2e%2e/a.png', /character other than/],
      ['artifacts/a\u0000.png', /character other than/],
      ['artifacts/caf\u00e9.png', /character other than/],
      [`artifacts/${'a'.repeat(256)}`, /longer than 255/],
      [`${'a/'.repeat(600)}b`, /longer than 1024/],
    ]
    for (const [reference, problem] of refused) assert.match(referenceProblem(reference) ?? '', problem, JSON.stringify(reference))
  })

  test('a path inside the run folder becomes its reference, and one outside, through .. or a linked folder, is refused', () => {
    const run = folder('portable')
    const outside = folder('portable-outside')
    mkdirSync(join(run, 'artifacts'))
    symlinkSync(outside, join(run, 'artifacts', 'away'))
    assert.deepEqual(portableReference(run, join(run, 'artifacts', 'k3', 'recording-1.mp4')), { ok: true, reference: 'artifacts/k3/recording-1.mp4' })
    const outsidePath = portableReference(run, join(run, '..', 'elsewhere.mp4'))
    assert.equal(outsidePath.ok, false)
    assert.equal(outsidePath.ok ? '' : outsidePath.reason, 'outside_run_folder')
    const linked = portableReference(run, join(run, 'artifacts', 'away', 'recording-1.mp4'))
    assert.equal(linked.ok ? '' : linked.reason, 'outside_run_folder')
    const root = portableReference(run, run)
    assert.equal(root.ok ? '' : root.reason, 'outside_run_folder')
    const odd = portableReference(run, join(run, 'artifacts', 'a b.mp4'))
    assert.equal(odd.ok ? '' : odd.reason, 'invalid_reference')
  })

  test('a run folder named through a link gives the same references', () => {
    const real = folder('portable-real')
    const links = folder('portable-links')
    symlinkSync(real, join(links, 'run'))
    assert.deepEqual(portableReference(join(links, 'run'), join(real, 'artifacts', 'x.png')), { ok: true, reference: 'artifacts/x.png' })
  })

  test('resolving a reference refuses one that is not portable and joins one that is', () => {
    const run = folder('resolve')
    assert.deepEqual(resolveReference(run, 'artifacts/a.png'), { ok: true, path: join(run, 'artifacts', 'a.png') })
    const refused = resolveReference(run, '../../etc/passwd')
    assert.equal(refused.ok ? '' : refused.reason, 'invalid_reference')
  })

  test('folders for an artifact are created one at a time and never through a link or a file', () => {
    const run = folder('create')
    const outside = folder('create-outside')
    const reference = recordingOutput(identity, 1)
    const made = createArtifactFolder(run, reference)
    assert.equal(made.ok, true)
    assert.ok(existsSync(join(run, ...reference.split('/').slice(0, -1))))
    const again = createArtifactFolder(run, reference)
    assert.equal(again.ok, true)

    mkdirSync(join(run, 'artifacts', 'other'))
    symlinkSync(outside, join(run, 'artifacts', 'other', 'k1'))
    const throughLink = createArtifactFolder(run, 'artifacts/other/k1/web/recording-1')
    assert.equal(throughLink.ok ? '' : throughLink.reason, 'outside_run_folder')
    assert.equal(existsSync(join(outside, 'web')), false, 'nothing was created outside')

    writeFileSync(join(run, 'artifacts', 'file'), 'x')
    const throughFile = createArtifactFolder(run, 'artifacts/file/web/recording-1')
    assert.equal(throughFile.ok ? '' : throughFile.reason, 'not_regular_file')
    const invalid = createArtifactFolder(run, '../x/recording-1')
    assert.equal(invalid.ok ? '' : invalid.reason, 'invalid_reference')
  })
})

describe('safe reads', () => {
  const limits = { maxBytes: megabyte }

  test('a regular file inside the run folder is read whole', () => {
    const run = folder('read')
    put(run, 'artifacts/k3/web/screenshot-failure-1.png', 'pixels')
    const read = readArtifactFile(run, 'artifacts/k3/web/screenshot-failure-1.png', limits)
    assert.equal(read.ok, true)
    assert.equal(read.ok ? read.bytes.toString() : '', 'pixels')
  })

  test('a reference with .., an absolute path or a backslash is refused before the disk is looked at', () => {
    const run = folder('read-lexical')
    put(join(run, '..'), `${run.split('/').at(-1) ?? ''}-sibling.txt`, 'sibling')
    temporary.push(`${run}-sibling.txt`)
    for (const reference of ['../secret.txt', `../${run.split('/').at(-1) ?? ''}-sibling.txt`, '/etc/passwd', 'artifacts\\..\\x', '']) {
      const read = readArtifactFile(run, reference, limits)
      assert.equal(read.ok ? '' : read.reason, 'invalid_reference', reference)
    }
  })

  test('nothing at the reference, or a part that is a file, is missing', () => {
    const run = folder('read-missing')
    put(run, 'artifacts/file', 'x')
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/none.png', limits)), 'missing')
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/file/inner.png', limits)), 'missing')
    assert.equal(nameOf(readArtifactFile(join(run, 'no-such-run'), 'artifacts/file', limits)), 'missing')
  })

  test('a symbolic link is never followed: out of the run folder it is outside_run_folder, inside it symbolic_link', () => {
    const run = folder('read-symlink')
    const outside = folder('read-symlink-outside')
    writeFileSync(join(outside, 'id_rsa'), 'private key')
    mkdirSync(join(outside, 'web'))
    writeFileSync(join(outside, 'web', 'shot.png'), 'outside pixels')
    put(run, 'artifacts/real.png', 'inside')
    symlinkSync(join(outside, 'id_rsa'), join(run, 'artifacts', 'key.png'))
    symlinkSync('real.png', join(run, 'artifacts', 'alias.png'))
    symlinkSync(outside, join(run, 'artifacts', 'k3'))
    symlinkSync('../../../../../../../../../../../../etc/hosts', join(run, 'artifacts', 'hosts.png'))
    const key = readArtifactFile(run, 'artifacts/key.png', limits)
    assert.equal(nameOf(key), 'outside_run_folder')
    assert.doesNotMatch(key.ok ? '' : key.message, /id_rsa|read-symlink-outside/, 'the link target is not quoted')
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/alias.png', limits)), 'symbolic_link')
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/k3/web/shot.png', limits)), 'outside_run_folder')
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/hosts.png', limits)), 'outside_run_folder')
  })

  test('a file with a second name is refused as a hard link, wherever the other name is', () => {
    const run = folder('read-hardlink')
    const outside = folder('read-hardlink-outside')
    writeFileSync(join(outside, 'secret.txt'), 'outside secret')
    mkdirSync(join(run, 'artifacts'))
    linkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'secret.png'))
    const read = readArtifactFile(run, 'artifacts/secret.png', limits)
    assert.equal(nameOf(read), 'hard_link')
    assert.match(read.ok ? '' : read.message, /has 2 names/)
    put(run, 'artifacts/one.png', 'x')
    linkSync(join(run, 'artifacts', 'one.png'), join(run, 'artifacts', 'two.png'))
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/one.png', limits)), 'hard_link')
  })

  test('a folder, a pipe and a file over the stated size are refused by name', () => {
    const run = folder('read-kinds')
    mkdirSync(join(run, 'artifacts', 'k3'), { recursive: true })
    execFileSync('mkfifo', [join(run, 'artifacts', 'pipe.png')])
    put(run, 'artifacts/big.png', 'x'.repeat(2048))
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/k3', limits)), 'not_regular_file')
    const pipe = readArtifactFile(run, 'artifacts/pipe.png', limits)
    assert.equal(nameOf(pipe), 'not_regular_file')
    assert.match(pipe.ok ? '' : pipe.message, /a pipe/)
    const big = readArtifactFile(run, 'artifacts/big.png', { maxBytes: 2047 })
    assert.equal(nameOf(big), 'too_large')
    assert.match(big.ok ? '' : big.message, /2048 bytes, over the limit of 2047/)
    assert.equal(nameOf(readArtifactFile(run, 'artifacts/big.png', { maxBytes: 2048 })), 'ok')
    assert.throws(() => readArtifactFile(run, 'artifacts/big.png', { maxBytes: -1 }), RangeError)
    assert.throws(() => readArtifactFile(run, 'artifacts/big.png', { maxBytes: Number.POSITIVE_INFINITY }), RangeError)
  })

  test('a run folder reached through a link is read, since its real path is the root', () => {
    const real = folder('read-root-real')
    const links = folder('read-root-links')
    put(real, 'artifacts/a.png', 'inside')
    symlinkSync(real, join(links, 'latest'))
    assert.equal(nameOf(readArtifactFile(join(links, 'latest'), 'artifacts/a.png', limits)), 'ok')
  })
})

describe('a swap between the check and the open', () => {
  const limits = { maxBytes: megabyte }

  test('a folder swapped for a link to a folder outside is refused, and nothing outside is read', () => {
    const run = folder('swap-folder')
    const outside = folder('swap-folder-outside')
    put(run, 'artifacts/k3/web/shot.png', 'inside')
    put(outside, 'k3/web/shot.png', 'outside secret')
    const checked = checkArtifact(run, 'artifacts/k3/web/shot.png', limits)
    assert.ok(checked.ok)
    renameSync(join(run, 'artifacts', 'k3'), join(run, 'artifacts', 'k3-moved'))
    symlinkSync(join(outside, 'k3'), join(run, 'artifacts', 'k3'))
    const opened = checked.artifact.open()
    assert.equal(nameOf(opened), 'changed')
    assert.match(opened.ok ? '' : opened.message, /Another file took the place/)
  })

  test('a folder swapped for a link to a folder holding the same file under a second name is refused as a hard link', () => {
    const run = folder('swap-same-file')
    const outside = folder('swap-same-file-outside')
    put(run, 'artifacts/k3/shot.png', 'inside')
    const checked = checkArtifact(run, 'artifacts/k3/shot.png', limits)
    assert.ok(checked.ok)
    linkSync(join(run, 'artifacts', 'k3', 'shot.png'), join(outside, 'shot.png'))
    renameSync(join(run, 'artifacts', 'k3'), join(run, 'artifacts', 'k3-moved'))
    symlinkSync(outside, join(run, 'artifacts', 'k3'))
    assert.equal(nameOf(checked.artifact.open()), 'hard_link')
  })

  test('a folder replaced by another folder that holds the same file is refused', () => {
    const run = folder('swap-replaced')
    put(run, 'artifacts/k3/shot.png', 'inside')
    const checked = checkArtifact(run, 'artifacts/k3/shot.png', limits)
    assert.ok(checked.ok)
    renameSync(join(run, 'artifacts'), join(run, 'artifacts-moved'))
    put(run, 'artifacts/k3/other.png', 'x')
    renameSync(join(run, 'artifacts-moved', 'k3', 'shot.png'), join(run, 'artifacts', 'k3', 'shot.png'))
    const opened = checked.artifact.open()
    assert.equal(nameOf(opened), 'changed')
    assert.match(opened.ok ? '' : opened.message, /"artifacts" was replaced/)
  })

  test('the file swapped for a link, for another file, or for a pipe is refused', () => {
    const run = folder('swap-file')
    const outside = folder('swap-file-outside')
    writeFileSync(join(outside, 'secret.txt'), 'outside secret')
    put(run, 'artifacts/a.png', 'inside a')
    put(run, 'artifacts/b.png', 'inside b')
    put(run, 'artifacts/c.png', 'inside c')
    const a = checkArtifact(run, 'artifacts/a.png', limits)
    const b = checkArtifact(run, 'artifacts/b.png', limits)
    const c = checkArtifact(run, 'artifacts/c.png', limits)
    assert.ok(a.ok && b.ok && c.ok)
    rmSync(join(run, 'artifacts', 'a.png'))
    symlinkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'a.png'))
    const linked = a.artifact.open()
    assert.equal(nameOf(linked), 'changed')
    assert.match(linked.ok ? '' : linked.message, /became a symbolic link/)
    put(run, 'artifacts/replacement.png', 'replacement')
    renameSync(join(run, 'artifacts', 'replacement.png'), join(run, 'artifacts', 'b.png'))
    assert.equal(nameOf(b.artifact.open()), 'changed')
    rmSync(join(run, 'artifacts', 'c.png'))
    execFileSync('mkfifo', [join(run, 'artifacts', 'c.png')])
    const piped = c.artifact.open()
    assert.equal(nameOf(piped), 'changed', 'opening a pipe in the file\'s place does not wait for a writer')
  })

  test('the run folder itself swapped for a link is refused', () => {
    const parent = folder('swap-root')
    const outside = folder('swap-root-outside')
    const run = join(parent, 'run')
    put(run, 'artifacts/a.png', 'inside')
    put(outside, 'artifacts/a.png', 'outside secret')
    const checked = checkArtifact(run, 'artifacts/a.png', limits)
    assert.ok(checked.ok)
    renameSync(run, join(parent, 'run-moved'))
    symlinkSync(outside, run)
    assert.equal(nameOf(checked.artifact.open()), 'changed')
  })

  test('a file that grows or shrinks after it was opened is refused when read', () => {
    const run = folder('swap-size')
    put(run, 'artifacts/grows.png', 'abc')
    put(run, 'artifacts/shrinks.png', 'abcdef')
    const grows = checkArtifact(run, 'artifacts/grows.png', limits)
    const shrinks = checkArtifact(run, 'artifacts/shrinks.png', limits)
    assert.ok(grows.ok && shrinks.ok)
    const openedGrows = grows.artifact.open()
    const openedShrinks = shrinks.artifact.open()
    assert.ok(openedGrows.ok && openedShrinks.ok)
    appendFileSync(join(run, 'artifacts', 'grows.png'), 'def')
    truncateSync(join(run, 'artifacts', 'shrinks.png'), 2)
    try {
      const grew = openedGrows.file.read()
      const shrank = openedShrinks.file.read()
      assert.equal(nameOf(grew), 'changed')
      assert.match(grew.ok ? '' : grew.message, /grew/)
      assert.equal(nameOf(shrank), 'changed')
      assert.match(shrank.ok ? '' : shrank.message, /shorter/)
    } finally {
      openedGrows.file.close()
      openedShrinks.file.close()
    }
  })

  test('a file that grew past the limit between the check and the open is refused as too large', () => {
    const run = folder('swap-limit')
    put(run, 'artifacts/a.png', 'abc')
    const checked = checkArtifact(run, 'artifacts/a.png', { maxBytes: 4 })
    assert.ok(checked.ok)
    appendFileSync(join(run, 'artifacts', 'a.png'), 'def')
    assert.equal(nameOf(checked.artifact.open()), 'too_large')
  })
})

const scope = { schemaVersion: 1, runId: 'run-1', time: '2026-10-05T00:00:00.000Z', origin: 'parent', testId: 'tests/a.retest.ts > saves', attemptId: 'k3v9q0x2mb' } as const

function events(): RetestEvent[] {
  const lines = [
    { ...scope, sequence: 1, elapsedMs: 10, type: 'evidence.captured', session: 'web', sessionId: 'k3v9q0x2mb:web', kind: 'screenshot', path: 'artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', reason: 'failure' },
    {
      ...scope,
      sequence: 2,
      elapsedMs: 11,
      type: 'diagnostics.finished',
      session: 'web',
      sessionId: 'k3v9q0x2mb:web',
      diagnostics: { app: 'web', sessionId: 'k3v9q0x2mb:web', path: 'diagnostics/k3v9q0x2mb.web.jsonl', console: { state: 'disabled' }, network: { state: 'disabled' } },
    },
    {
      ...scope,
      sequence: 3,
      elapsedMs: 12,
      type: 'evaluation.finished',
      evaluation: {
        checkId: 'saved',
        source: 'test',
        mode: 'required',
        verdict: 'pass',
        criteria: [{ id: 'saved', requirement: 'The task shows as saved.', verdict: 'pass', citations: ['e1'] }],
        criteriaSha256: 'c'.repeat(64),
        evidence: [
          { id: 'e1', kind: 'screenshot', app: 'web', sessionId: 'k3v9q0x2mb:web', attemptId: 'k3v9q0x2mb', capturedAt: '2026-10-05T00:00:00.000Z', path: 'artifacts/k3v9q0x2mb/web/screenshot-evaluation-1.png', sha256: 'd'.repeat(64), bytes: 10 },
          { id: 'e2', kind: 'text', attemptId: 'k3v9q0x2mb', capturedAt: '2026-10-05T00:00:00.000Z', sha256: 'e'.repeat(64), bytes: 5 },
        ],
        durationMs: 5,
      },
    },
  ]
  const reading = readEvents(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  assert.ok(reading.ok, reading.ok ? '' : reading.problem)
  return reading.events
}

function result(): RunResult {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    retestVersion: '0.0.0',
    startedAt: '2026-10-05T00:00:00.000Z',
    finishedAt: '2026-10-05T00:00:01.000Z',
    complete: true,
    status: 'failed',
    exitCode: 1,
    durationMs: 1000,
    browser: null,
    counts: { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
    files: [
      {
        file: 'tests/a.retest.ts',
        collection: 'ok',
        tests: [
          {
            testId: 'tests/a.retest.ts > saves',
            name: 'saves',
            file: 'tests/a.retest.ts',
            location: { file: 'tests/a.retest.ts', line: 3, column: 1 },
            attemptId: 'k3v9q0x2mb',
            status: 'failed',
            durationMs: 900,
            assertionCount: 1,
            evidence: [{ kind: 'screenshot', path: 'artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', app: 'web', sessionId: 'k3v9q0x2mb:web' }],
            diagnostics: [{ app: 'web', sessionId: 'k3v9q0x2mb:web', path: 'diagnostics/k3v9q0x2mb.web.jsonl', console: { state: 'disabled' }, network: { state: 'disabled' } }],
          },
        ],
      },
    ],
  }
}

describe('what a run folder holds against what its records name', () => {
  test('events and result.json name their screenshots, diagnostics and AI check evidence', () => {
    const fromEvents = eventArtifactReferences(events())
    assert.deepEqual(fromEvents, [
      { path: 'artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', kind: 'screenshot', namedBy: 'evidence.captured', testId: 'tests/a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' },
      { path: 'diagnostics/k3v9q0x2mb.web.jsonl', kind: 'diagnostics', namedBy: 'diagnostics.finished', testId: 'tests/a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' },
      { path: 'artifacts/k3v9q0x2mb/web/screenshot-evaluation-1.png', kind: 'screenshot', namedBy: 'evaluation.finished', evidenceOf: 'evaluation', testId: 'tests/a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' },
    ])
    assert.deepEqual(resultArtifactReferences(result()).map((reference) => [reference.path, reference.kind, reference.namedBy]), [
      ['artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', 'screenshot', 'result.json'],
      ['diagnostics/k3v9q0x2mb.web.jsonl', 'diagnostics', 'result.json'],
    ])
  })

  test('the listing names the present, the missing with why, the unreferenced and what it did not follow', () => {
    const run = folder('inventory')
    const outside = folder('inventory-outside')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    for (const own of ['events.jsonl', 'result.json', 'result.json.partial', 'report.html', 'logs/a.log', 'states/s.json']) put(run, own, 'run file')
    put(run, 'artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', 'png')
    put(run, 'diagnostics/k3v9q0x2mb.web.jsonl', '{}\n')
    put(run, 'artifacts/k3v9q0x2mb/web/recording-1.mp4.partial', 'partial video')
    put(run, 'artifacts/k3v9q0x2mb/web/stray.png', 'stray')
    symlinkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'k3v9q0x2mb', 'web', 'link.png'))
    symlinkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'k3v9q0x2mb', 'web', 'named-link.png'))
    linkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'hard.png'))
    execFileSync('mkfifo', [join(run, 'artifacts', 'pipe')])
    const references: ArtifactReference[] = [
      ...eventArtifactReferences(events()),
      ...resultArtifactReferences(result()),
      { path: 'artifacts/k3v9q0x2mb/web/named-link.png', kind: 'screenshot', namedBy: 'evidence.captured' },
      { path: '../escape.png', kind: 'screenshot', namedBy: 'evidence.captured' },
    ]
    const inventory = inventoryArtifacts(run, references)
    assert.deepEqual(inventory.present, [
      { reference: 'artifacts/k3v9q0x2mb/web/screenshot-failure-1.png', size: 3, namedBy: ['evidence.captured', 'result.json'] },
      { reference: 'diagnostics/k3v9q0x2mb.web.jsonl', size: 3, namedBy: ['diagnostics.finished', 'result.json'] },
    ])
    assert.deepEqual(inventory.missing.map((entry) => [entry.reference, entry.reason, entry.namedBy]), [
      ['artifacts/k3v9q0x2mb/web/screenshot-evaluation-1.png', 'missing', ['evaluation.finished']],
      ['artifacts/k3v9q0x2mb/web/named-link.png', 'outside_run_folder', ['evidence.captured']],
      ['../escape.png', 'invalid_reference', ['evidence.captured']],
    ])
    assert.deepEqual(inventory.unreferenced, [
      { reference: 'artifacts/k3v9q0x2mb/web/recording-1.mp4.partial', size: 13, partial: true },
      { reference: 'artifacts/k3v9q0x2mb/web/stray.png', size: 5, partial: false },
    ])
    assert.deepEqual(inventory.refused.map((entry) => [entry.reference, entry.reason]), [
      ['artifacts/hard.png', 'hard_link'],
      ['artifacts/k3v9q0x2mb/web/link.png', 'outside_run_folder'],
      ['artifacts/pipe', 'not_regular_file'],
    ])
    assert.equal(inventory.truncated, false)
  })

  test('a link under one of the run\'s own names is listed as a link, not skipped as the run\'s own', () => {
    const run = folder('inventory-own-link')
    const outside = folder('inventory-own-link-outside')
    writeFileSync(join(outside, 'events.jsonl'), 'outside')
    symlinkSync(outside, join(run, 'states'))
    symlinkSync(join(outside, 'events.jsonl'), join(run, 'events.jsonl'))
    const inventory = inventoryArtifacts(run, [])
    assert.deepEqual(inventory.refused.map((entry) => [entry.reference, entry.reason]), [
      ['events.jsonl', 'outside_run_folder'],
      ['states', 'outside_run_folder'],
    ])
  })

  test('the listing stops at its entry limit and says so', () => {
    const run = folder('inventory-limit')
    for (let index = 0; index < 5; index++) put(run, `artifacts/${index}.png`, 'x')
    const inventory = inventoryArtifacts(run, [], { maxEntries: 3 })
    assert.equal(inventory.truncated, true)
    assert.ok(inventory.unreferenced.length < 5)
  })

  test('a run folder that cannot be read throws', () => {
    assert.throws(() => inventoryArtifacts(join(folder('inventory-none'), 'none'), []), /could not be read/)
  })
})

function nameOf(answer: { readonly ok: true } | { readonly ok: false; readonly reason: string }): string {
  return answer.ok ? 'ok' : answer.reason
}

test('a read never returns the bytes of a file outside the run folder in any of these cases', () => {
  const run = folder('never-outside')
  const outside = folder('never-outside-target')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret')
  mkdirSync(join(run, 'artifacts'))
  symlinkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'a.png'))
  linkSync(join(outside, 'secret.txt'), join(run, 'artifacts', 'b.png'))
  symlinkSync(outside, join(run, 'artifacts', 'c'))
  for (const reference of ['artifacts/a.png', 'artifacts/b.png', 'artifacts/c/secret.txt', `../${outside.split('/').at(-1) ?? ''}/secret.txt`, join(outside, 'secret.txt')]) {
    const read = readArtifactFile(run, reference, { maxBytes: megabyte })
    assert.equal(read.ok, false, reference)
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret')
})


describe('recording artifact references', () => {
  const recording: import('../../src/protocol/recording.ts').RecordingRecord = { recordingId: 'r1', sequence: 1, testId: 'tests/a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web', status: 'partial', gaps: [{ code: 'recording_lost', message: 'recording stopped' }], path: 'artifacts/k3v9q0x2mb/web/recording-1.mp4', partialPath: 'artifacts/k3v9q0x2mb/web/recording-1.mp4.partial' }
  const stamped = (bodies: import('../../src/protocol/events.ts').EventBody[]): RetestEvent[] => bodies.map((body, sequence) => ({ schemaVersion: 1, runId: 'run-1', origin: 'parent', time: '2026-10-05T00:00:00Z', elapsedMs: sequence, sequence, ...body }))
  const ended: import('../../src/protocol/events.ts').EventBody = { type: 'recording.finished', testId: recording.testId, attemptId: recording.attemptId, sessionId: recording.sessionId, recording }
  const removal: import('../../src/protocol/events.ts').EventBody = { type: 'artifact.removed', path: recording.path ?? assert.fail(), kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 12 }

  test('events and results name video and partial files with the recording identity', () => {
    const named = eventArtifactReferences(stamped([ended]))
    const expected = [recording.path, recording.partialPath].map(path => ({ path, kind: 'recording', namedBy: 'recording.finished', testId: recording.testId, attemptId: recording.attemptId, app: recording.app, sessionId: recording.sessionId }))
    assert.deepEqual(named, expected)
    const run = result()
    const test = run.files[0]?.tests[0] ?? assert.fail()
    test.recordings = [recording]
    assert.deepEqual(resultArtifactReferences(run).filter(reference => reference.kind === 'recording'), expected.map(reference => ({ ...reference, namedBy: 'result.json' })))
  })

  test('successful retention removes the video reference but a failed unlink restores it', () => {
    assert.deepEqual(eventArtifactReferences(stamped([ended, removal])).map(reference => reference.path), [recording.partialPath])
    const { bytes: _bytes, ...failed } = removal
    assert.deepEqual(eventArtifactReferences(stamped([ended, removal, { ...failed, type: 'artifact.removal_failed', message: 'unlink refused' }])).map(reference => reference.path), [recording.path, recording.partialPath])
    const run = result()
    const test = run.files[0]?.tests[0] ?? assert.fail()
    test.recordings = [{ ...recording, removed: 'passed_attempt_recording' }]
    assert.deepEqual(resultArtifactReferences(run).filter(reference => reference.kind === 'recording').map(reference => reference.path), [recording.partialPath])
  })
})

test('frame and diagnostics evaluation references preserve their kinds and nested frame paths in events and results', () => {
  const root = projectFolder()
  const events = [...extendedEvidenceRun(root, 'frames'), ...extendedEvidenceRun(root, 'diagnostics')]
  for (const references of [eventArtifactReferences(events), resultArtifactReferences(resultOf(extendedEvidenceRun(root, 'frames'))), resultArtifactReferences(resultOf(extendedEvidenceRun(root, 'diagnostics')))]) {
    const evaluated = references.filter((reference) => reference.evidenceOf === 'evaluation')
    assert.ok(evaluated.length > 0)
    for (const reference of evaluated) assert.equal(reference.kind, reference.path === evaluationDiagnosticsPath ? 'diagnostics' : 'frames')
  }
  const paths = eventArtifactReferences(events).map((reference) => reference.path)
  for (const path of [evaluationFramePath, missingEvaluationFramePath, evaluationDiagnosticsPath]) assert.ok(paths.includes(path), path)
})
