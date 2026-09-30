/**
 * A page address as results record it: origin and path, with no credentials, query or fragment.
 * Addresses without a host keep only their scheme, because their path is the content itself.
 *
 * @example originAndPath(new URL('https://app.test/tasks?page=2#top')) // 'https://app.test/tasks'
 */
export function originAndPath(url: URL): string {
  if (url.host !== '') return `${url.protocol}//${url.host}${url.pathname}`
  if (url.protocol === 'file:') return `file://${url.pathname}`
  if (url.protocol === 'about:') return `about:${url.pathname}`
  return url.protocol
}
