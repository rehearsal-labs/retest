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
