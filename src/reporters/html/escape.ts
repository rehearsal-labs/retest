import type { JsonValue } from '../../evaluation/contract.ts'
import { referenceProblem } from '../../store/artifacts.ts'

// Everything the HTML report shows from a run is untrusted: page titles, addresses, element text, console messages,
// test names and a judge's words. It goes into the report only through these functions, so no text of an app, a test
// or a model is ever read as markup, an attribute, a link Retest did not mean, or a script.

const htmlEscapes: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }

// `&`, `<`, `>` and both quotes end a text or a quoted attribute; a backtick ends an attribute in old parsers. A lone
// surrogate cannot be encoded in UTF-8 and NUL is a parse error, so both become U+FFFD; nothing else is dropped.
const htmlSpecial = /[&<>"'`]|\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Untrusted text made safe for an HTML text position, or for an attribute value inside double or single quotes. It
 * escapes `&`, `<`, `>`, `"`, `'` and the backtick, and replaces NUL and a lone surrogate with U+FFFD. An attribute
 * must be quoted: an unquoted attribute, an event handler attribute, a `style` and the inside of `<script>` or
 * `<style>` are never safe places for app text, escaped or not. Text keeps its line breaks and direction controls; show
 * it in an element with `dir="auto"` so a right-to-left mark cannot reorder the report around it.
 *
 * @example `<td title="${escapeHtml(pageTitle)}">${escapeHtml(pageTitle)}</td>`
 */
export function escapeHtml(text: string): string {
  return text.replace(htmlSpecial, (found) => htmlEscapes[found] ?? '\uFFFD')
}

/**
 * The `href` value for a page address an app gave, escaped for a quoted attribute, or undefined when it is not an
 * `http:` or `https:` address, so the report shows it as text instead of a link. A `javascript:`, `data:`, `file:` or
 * any other scheme, and text that is not an absolute address, never becomes a link. A user name and password in the
 * address are left out.
 *
 * @example const href = pageHref(navigation.url); href === undefined ? escapeHtml(navigation.url) : `<a href="${href}" rel="noreferrer noopener">…</a>`
 */
export function pageHref(address: string): string | undefined {
  const url = URL.parse(address)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  url.username = ''
  url.password = ''
  return escapeHtml(url.href)
}

/**
 * The `href` or `src` value for an artifact, from its portable reference, relative to the run folder, where the
 * report sits: each part percent-encoded and the whole escaped for a quoted attribute. Undefined when the reference is
 * not a portable reference (`..`, an absolute path, a scheme, a backslash and the rest `referenceProblem` refuses), so
 * a record can never point the report outside the run folder.
 *
 * @example const src = artifactHref(evidence.path); src === undefined ? '' : `<img src="${src}" alt="">`
 */
export function artifactHref(reference: string): string | undefined {
  if (referenceProblem(reference) !== undefined) return undefined
  return escapeHtml(reference.split('/').map((segment) => encodeURIComponent(segment)).join('/'))
}

/**
 * A JSON value as text for `<script type="application/json">`, read back with `JSON.parse`: `<`, `>` and `&` are
 * written as `\u003c`, `\u003e` and `\u0026`, so no `</script>` or `<!--` in app text can end or bend the element,
 * and U+2028 and U+2029 are escaped too. The script element must not be one the browser runs.
 *
 * @example `<script type="application/json" id="run">${scriptJson(record)}</script>`
 */
export function scriptJson(value: JsonValue): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (found) => `\\u${found.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
