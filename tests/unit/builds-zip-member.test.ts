import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { readZipMember } from '../../src/cli/install/zip-member.ts'

// Zips written byte by byte, as the format lays them out, so each case controls every field the reader trusts or checks.

type Member = { readonly name: string; readonly bytes: Buffer; readonly method?: 0 | 8; readonly flags?: number; readonly crc?: number }

/** A zip of `members`, with `before` ahead of everything; `directoryFirst` puts the central directory before the members, as Mozilla lays out omni.ja. */
function zip(members: readonly Member[], options: { readonly before?: Buffer; readonly directoryFirst?: boolean } = {}): Buffer {
  const packed = members.map((member) => ({ ...member, stored: member.method === 8 ? deflateRawSync(member.bytes) : member.bytes }))
  const directorySize = packed.reduce((total, member) => total + 46 + Buffer.byteLength(member.name), 0)
  const start = options.before?.length ?? 0
  const localsAt = options.directoryFirst === true ? start + directorySize : start
  const locals: Buffer[] = []
  const entries: Buffer[] = []
  let at = localsAt
  for (const member of packed) {
    const name = Buffer.from(member.name)
    const crc = member.crc ?? crc32(member.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(member.flags ?? 0, 6)
    local.writeUInt16LE(member.method ?? 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(member.stored.length, 18)
    local.writeUInt32LE(member.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(member.flags ?? 0, 8)
    entry.writeUInt16LE(member.method ?? 0, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(member.stored.length, 20)
    entry.writeUInt32LE(member.bytes.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(at, 42)
    locals.push(local, name, member.stored)
    entries.push(entry, name)
    at += 30 + name.length + member.stored.length
  }
  const directoryAt = options.directoryFirst === true ? start : at
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(directoryAt, 16)
  const body = options.directoryFirst === true ? [...entries, ...locals] : [...locals, ...entries]
  return Buffer.concat([options.before ?? Buffer.alloc(0), ...body, end])
}

const page = Buffer.from('<html><body>The licence page.</body></html>\n')
const name = 'chrome/toolkit/content/global/license.html'

describe('reading one member of a zip', () => {
  test('reads a stored member and a deflated one, with their checksums', () => {
    const archive = zip([{ name: 'chrome.manifest', bytes: Buffer.from('manifest') }, { name, bytes: page, method: 8 }])
    assert.deepEqual(readZipMember(archive, name, 1024), { ok: true, bytes: page })
    assert.deepEqual(readZipMember(archive, 'chrome.manifest', 1024), { ok: true, bytes: Buffer.from('manifest') })
  })

  test("reads omni.ja's layout, with the central directory ahead of the members and four bytes before it", () => {
    const preamble = Buffer.alloc(4)
    const archive = zip([{ name: 'chrome.manifest', bytes: Buffer.from('manifest') }, { name, bytes: page }], { before: preamble, directoryFirst: true })
    assert.deepEqual(readZipMember(archive, name, 1024), { ok: true, bytes: page })
  })

  test('refuses a member it lacks, a changed one, an encrypted one, one over its limit, and bytes that are not a zip', () => {
    assert.deepEqual(readZipMember(zip([{ name: 'other', bytes: page }]), name, 1024), { ok: false, problem: `it holds no ${name}` })
    assert.deepEqual(readZipMember(zip([{ name, bytes: page, crc: 1 }]), name, 1024), { ok: false, problem: "the member's checksum does not hold" })
    assert.deepEqual(readZipMember(zip([{ name, bytes: page, flags: 1 }]), name, 1024), { ok: false, problem: 'the member is encrypted' })
    assert.deepEqual(readZipMember(zip([{ name, bytes: page }]), name, page.length - 1), { ok: false, problem: 'the member exceeds its byte limit' })
    assert.deepEqual(readZipMember(Buffer.from('not a zip at all, and long enough to search'), name, 1024), { ok: false, problem: 'it is not a zip archive' })
  })

  test('refuses offsets that lead outside the archive, rather than reading past its end', () => {
    const archive = zip([{ name, bytes: page }])
    const cut = Buffer.concat([archive.subarray(0, 10), archive.subarray(archive.length - 22)])
    cut.writeUInt32LE(0, cut.length - 22 + 16)
    assert.equal(readZipMember(cut, name, 1024).ok, false)
    const outside = Buffer.from(archive)
    outside.writeUInt32LE(outside.length, outside.length - 22 + 16)
    assert.deepEqual(readZipMember(outside, name, 1024), { ok: false, problem: 'its central directory lies outside it' })
  })
})
