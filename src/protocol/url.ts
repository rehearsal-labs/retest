/**
 * A URL as Retest records it, in events, results and printed commands: without a user name or password.
 * Any other URL is kept exactly as given.
 *
 * @example withoutCredentials('http://ada:secret@127.0.0.1:4173') // 'http://127.0.0.1:4173/'
 */
export function withoutCredentials(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.username === '' && parsed.password === '')) return url
  parsed.username = ''
  parsed.password = ''
  return parsed.href
}

/** An http or https address, the only kind Retest opens or tests. */
export type WebUrl = URL & { readonly protocol: 'http:' | 'https:' }

/**
 * Whether a parsed URL is an http or https address.
 *
 * @example isWebUrl(URL.parse('about:blank')) // false
 */
export function isWebUrl(url: URL | null | undefined): url is WebUrl {
  return url?.protocol === 'http:' || url?.protocol === 'https:'
}

/**
 * The origin of an http or https address, or undefined for anything else, such as `about:blank`.
 *
 * @example originOf('http://127.0.0.1:4173/login') // 'http://127.0.0.1:4173'
 */
export function originOf(address: string | undefined): string | undefined {
  const url = address === undefined ? null : URL.parse(address)
  return isWebUrl(url) ? url.origin : undefined
}

/**
 * The origin `text` names when it is an http or https origin and nothing more, with or without a trailing
 * slash, written the way the URL standard writes it.
 *
 * @example readOrigin('https://Example.com/') // 'https://example.com'
 */
export function readOrigin(text: string): string | undefined {
  const url = URL.parse(text)
  return isWebUrl(url) && url.href === `${url.origin}/` ? url.origin : undefined
}
