import { crc32, inflateRawSync } from 'node:zlib'

// Reads one member out of a zip already in memory, for a notice a build keeps inside an archive of its own, such as
// the licence page in Firefox's omni.ja. Windows has no unzip, and its tar.exe reads no member of omni.ja, whose central
// directory Mozilla moves to the front of the file. Only what the end of the archive says is trusted, every offset is
// checked against the bytes there are, and the member's CRC-32 must hold.

/** One member's bytes, or why they were not read. */
export type ZipMemberReading = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly problem: string }

const endSignature = 0x06054b50
const entrySignature = 0x02014b50
const localSignature = 0x04034b50
// The end record is 22 bytes and may be followed by a comment of up to 65535.
const endSearchBytes = 22 + 0xffff

/**
 * The bytes of the member `name` of the zip `archive`, stored or deflated, when they are at most `maximumBytes`.
 *
 * @example readZipMember(omni, 'chrome/toolkit/content/global/license.html', 16 * 1024 * 1024) // { ok: true, bytes }
 */
export function readZipMember(archive: Buffer, name: string, maximumBytes: number): ZipMemberReading {
  const end = findEnd(archive)
  if (end === undefined) return { ok: false, problem: 'it is not a zip archive' }
  const entries = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryAt = archive.readUInt32LE(end + 16)
  if (directoryAt + directorySize > end) return { ok: false, problem: 'its central directory lies outside it' }
  const wanted = Buffer.from(name, 'utf8')
  let at = directoryAt
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > end || archive.readUInt32LE(at) !== entrySignature) return { ok: false, problem: 'its central directory is damaged' }
    const nameLength = archive.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32)
    if (next > end) return { ok: false, problem: 'its central directory is damaged' }
    if (archive.subarray(at + 46, at + 46 + nameLength).equals(wanted)) return readEntry(archive, at, maximumBytes)
    at = next
  }
  return { ok: false, problem: `it holds no ${name}` }
}

function readEntry(archive: Buffer, entry: number, maximumBytes: number): ZipMemberReading {
  const flags = archive.readUInt16LE(entry + 8)
  const method = archive.readUInt16LE(entry + 10)
  const crc = archive.readUInt32LE(entry + 16)
  const compressedSize = archive.readUInt32LE(entry + 20)
  const size = archive.readUInt32LE(entry + 24)
  const local = archive.readUInt32LE(entry + 42)
  if ((flags & 1) !== 0) return { ok: false, problem: 'the member is encrypted' }
  if (size > maximumBytes) return { ok: false, problem: 'the member exceeds its byte limit' }
  if (local + 30 > archive.length || archive.readUInt32LE(local) !== localSignature) return { ok: false, problem: "the member's header is damaged" }
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
  if (start + compressedSize > archive.length) return { ok: false, problem: 'the member lies outside the archive' }
  const stored = archive.subarray(start, start + compressedSize)
  let bytes: Buffer
  if (method === 0) bytes = stored
  else if (method === 8) {
    try {
      bytes = inflateRawSync(stored, { maxOutputLength: Math.max(1, size) })
    } catch {
      return { ok: false, problem: 'the member does not inflate' }
    }
  } else return { ok: false, problem: `the member is packed with method ${method}, which Retest does not read` }
  if (bytes.length !== size || crc32(bytes) !== crc) return { ok: false, problem: "the member's checksum does not hold" }
  return { ok: true, bytes }
}

// The last end record in the archive whose comment runs exactly to the archive's end.
function findEnd(archive: Buffer): number | undefined {
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - endSearchBytes); at -= 1) {
    if (archive.readUInt32LE(at) === endSignature && at + 22 + archive.readUInt16LE(at + 20) === archive.length) return at
  }
  return undefined
}
