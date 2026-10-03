import { truncateText, type TruncatedText } from '../protocol/failures.ts'

// The rules every address in a diagnostics artifact follows: no user name or password, no query and no fragment
// (each replaced by a mark that says one was there), and no path segment that looks like a token. A page puts
// session ids, reset codes and signed links in exactly these places.

/** What stands in for a query, a fragment or a path segment Retest left out. */
export const omitted = '…'

// A segment that holds this many letters and digits, or this many digits, reads as a token rather than a name, unless
// it is a file name, a version or a date. A dotted three-part segment of long parts is a JSON Web Token's shape.
const tokenCharacters = 16
const tokenDigits = 12
const jsonWebToken = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/
const fileExtension = /\.(?=[a-z0-9]{0,4}[a-z])[a-z0-9]{1,5}$/i
const version = /^v?\d+\.\d+\.\d+(?:[-+.][\w.-]*)?$/i
const date = /^\d{4}-\d{2}-\d{2}(?:[T_ ]\d{2}[-:]\d{2}(?:[-:]\d{2}(?:\.\d+)?)?Z?)?$/i

// Addresses inside free text, such as the frames of an error's stack. An address runs to whitespace, a quote or an
// angle bracket; brackets and parentheses inside it, as in a query `ids[]=1` or an IPv6 host, belong to it.
const addressInText = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'`<>]+/gi
const encodedPlaceholder = /%7B%7B([\w.-]+)%7D%7D/gi

// Punctuation that ends a sentence around an address rather than the address itself.
const trailingPunctuation = /[.,;!?]$/
// A stack frame's address ends with its line and column, which stay readable.
const lineAndColumn = /(:\d+(?::\d+)?)$/

/**
 * An address as diagnostics record it. Web addresses keep their origin and path, with credentials removed, the query
 * and fragment replaced by `…`, and each token-bearing path segment replaced by `…`. A `data:` address keeps its
 * media type only, a `blob:` address its origin, and an address that does not parse keeps its scheme.
 *
 * @example sanitizeUrl('https://ada:pw@example.com/reset/9f8e7d6c5b4a39281706f5e4?code=1#top') // 'https://example.com/reset/…?…#…'
 */
export function sanitizeUrl(address: string): string {
  const trimmed = address.trim()
  if (/^data:/i.test(trimmed)) return `data:${mediaTypeOf(trimmed)},${omitted}`
  const url = URL.parse(trimmed)
  if (url === null) return schemeOnly(trimmed)
  if (url.protocol === 'blob:') return `blob:${blobOrigin(url)}/${omitted}`
  if (url.protocol === 'about:') return `about:${url.pathname}`
  if (url.host === '' && url.protocol !== 'file:') return `${url.protocol}${omitted}`
  const path = url.pathname.split('/').map((segment) => (isTokenSegment(segment) ? omitted : segment)).join('/')
  const query = url.search === '' ? '' : `?${omitted}`
  const fragment = url.hash === '' ? '' : `#${omitted}`
  // A secret's placeholder the redactor wrote into the path stays readable rather than percent-encoded.
  return `${url.protocol}//${url.host}${path.replace(encodedPlaceholder, '{{$1}}')}${query}${fragment}`
}

/**
 * Free text with every address in it sanitized as `sanitizeUrl` does, keeping a stack frame's line and column.
 *
 * @example sanitizeText('Error: boom\n    at https://app.test/app.js?v=abc123:4:9') // 'Error: boom\n    at https://app.test/app.js?…:4:9'
 */
export function sanitizeText(text: string): string {
  return text.replace(addressInText, (match) => {
    const { address, rest } = withoutClosing(match)
    const position = positionOf(address)
    const bare = position === '' ? address : address.slice(0, -position.length)
    return `${sanitizeUrl(bare)}${position}${rest}`
  })
}

// A bracket or a parenthesis that closes text around the address, as `(http://app.test/a.js:4:9)` does in a stack, is
// left outside it; one the address itself opened stays.
function withoutClosing(match: string): { address: string; rest: string } {
  let address = match
  for (;;) {
    const last = address.at(-1) ?? ''
    const unopened = (close: string, open: string): boolean => last === close && count(address, close) > count(address, open)
    if (!trailingPunctuation.test(last) && !unopened(')', '(') && !unopened(']', '[') && !unopened('}', '{')) break
    address = address.slice(0, -1)
  }
  return { address, rest: match.slice(address.length) }
}

function count(text: string, character: string): number {
  return text.split(character).length - 1
}

// A line and column follow a path, so a port right after the host is never read as one.
function positionOf(address: string): string {
  const position = lineAndColumn.exec(address)?.[1] ?? ''
  const pathStart = address.indexOf('/', address.indexOf('://') + 3)
  return position !== '' && pathStart !== -1 && pathStart < address.length - position.length ? position : ''
}

/**
 * Whether a path segment looks like a token. A JSON Web Token's shape is one. A file name, a version or a date is not.
 * Otherwise a segment of 12 digits or more, or of 16 letters and digits or more, is one, so a long name such as a
 * slug of several words is hidden too. Percent-escapes are read as the characters they stand for.
 *
 * @example isTokenSegment('4829137465019283') // true
 * @example isTokenSegment('jquery-3.7.1.min.js') // false
 */
export function isTokenSegment(segment: string): boolean {
  const decoded = safeDecode(segment)
  if (jsonWebToken.test(decoded)) return true
  if (fileExtension.test(decoded) || version.test(decoded) || date.test(decoded)) return false
  const digits = decoded.replace(/\D/g, '').length
  const characters = decoded.replace(/[^a-z0-9]/gi, '').length
  return digits >= tokenDigits || characters >= tokenCharacters
}

/**
 * Text bounded for a record: cut to `limit` code units, never inside a surrogate pair, with its length before the cut.
 *
 * @example boundText('a'.repeat(5000), 4096).truncated // true
 */
export function boundText(text: string, limit: number): TruncatedText {
  return truncateText(text, limit)
}

function mediaTypeOf(address: string): string {
  const comma = address.indexOf(',')
  const header = address.slice(5, comma === -1 ? undefined : comma)
  const [type = ''] = header.split(';')
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : ''
}

function blobOrigin(url: URL): string {
  const inner = URL.parse(url.pathname)
  return inner === null ? '' : inner.origin
}

function schemeOnly(address: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1]
  return scheme === undefined ? omitted : `${scheme.toLowerCase()}:${omitted}`
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
