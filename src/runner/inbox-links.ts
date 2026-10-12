import { isTokenSegment } from '../diagnostics/sanitize.ts'

/**
 * A message's link as Retest reads it: the address it parsed, and the parts of it that read as tokens, each as the
 * address writes it and decoded, with no repeats. A link with any such part carries a token.
 */
export type ReadLink = { readonly url: URL; readonly tokens: readonly string[] }

// A parameter whose name is one of these words, or a longer word ending in one, as `access_token` or `oobCode` read,
// carries a credential, whatever its value looks like.
const credentialWords: readonly string[] = ['token', 'code', 'key', 'secret', 'signature', 'sig', 'auth', 'otp', 'nonce', 'ticket', 'session', 'hash', 'password']

/**
 * Reads a link from a message, or undefined when its address is not an http or https URL. A password in the address is
 * a token. A part reads as a token when it is one of the message's codes; when it is a query parameter, or a parameter of a fragment written as a query,
 * whose name speaks of a credential; or when it reads as one as diagnostics read a path segment: 16 letters and digits
 * or more, 12 digits or more, or a JSON Web Token's shape, and not a file name, a version or a date. That rule applies
 * to each path segment, each query value and the fragment.
 *
 * @example readLink('https://app.test/verify/9f8e7d6c5b4a39281706f5e4?utm=mail', [])?.tokens // ['9f8e7d6c5b4a39281706f5e4']
 */
export function readLink(address: string, codes: readonly string[]): ReadLink | undefined {
  const url = URL.parse(address.trim())
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  const isCode = (value: string): boolean => codes.includes(value)
  // A password written into the address is a credential, whatever it looks like.
  const found: string[] = url.password === '' ? [] : [url.password, decoded(url.password)]
  for (const segment of url.pathname.split('/')) {
    if (segment !== '' && (isCode(decoded(segment)) || isTokenSegment(segment))) found.push(segment, decoded(segment))
  }
  found.push(...parameterTokens(url.search.slice(1), isCode))
  // A fragment written as a query, as a sign-in that hands its token to the page writes it, is read as one.
  const fragment = url.hash.slice(1)
  if (fragment.includes('=')) found.push(...parameterTokens(fragment, isCode))
  else if (fragment !== '' && (isCode(decoded(fragment)) || isTokenSegment(fragment))) found.push(fragment, decoded(fragment))
  return { url, tokens: [...new Set(found.filter((part) => part !== ''))] }
}

// Each parameter's value, raw and decoded, when its name speaks of a credential or its value reads as a token.
function parameterTokens(query: string, isCode: (value: string) => boolean): string[] {
  const found: string[] = []
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const name = decoded(pair.slice(0, separator).replaceAll('+', ' '))
    const raw = pair.slice(separator + 1)
    const value = decoded(raw.replaceAll('+', ' '))
    if (value !== '' && (namesCredential(name) || isCode(value) || isTokenSegment(raw))) found.push(raw, value)
  }
  return found
}

function namesCredential(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return words.some((word) => credentialWords.some((credential) => word.endsWith(credential)))
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
