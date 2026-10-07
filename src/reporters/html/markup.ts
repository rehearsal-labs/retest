import type { JsonValue } from '../../evaluation/contract.ts'
import { artifactHref, escapeHtml, scriptJson } from './escape.ts'

// Every piece of the report is built here. A string put into markup is always escaped, so text from a test, a page, a
// browser or a model can never become an element or an attribute; only markup this module built passes through whole.
// Attribute values are always written in double quotes, and attribute names, tags, the style sheet and the script are
// the report's own constants. Before it is escaped, a string's control characters and the characters that reorder
// text (bidirectional overrides and isolates) are written as their escapes, so page text cannot hide or disguise
// itself; line breaks and tabs stay.

// C0 controls but tab and line feed, DEL and the C1 range, and the bidirectional marks, embeddings, overrides and isolates.
const invisible = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Text with every character that could hide or reorder it written as its escape.
 *
 * @example visibleText('Saved\u202egnp.exe') // 'Saved\\u202egnp.exe'
 */
export function visibleText(text: string): string {
  return text.replace(invisible, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Markup this module built: escaped text, the report's own tags, or both. Its text is kept where only this module reads it. */
export type Markup = { readonly kind: 'markup' }

const built = new WeakMap<Markup, string>()

function made(text: string): Markup {
  const markup: Markup = Object.freeze({ kind: 'markup' })
  built.set(markup, text)
  return markup
}

/** What may go into markup: text, which is escaped, a number, markup, a list of markup, or nothing. */
export type Part = string | number | Markup | readonly Markup[] | undefined | null | false

/**
 * Markup from a template whose text parts are the report's own tags. Every interpolated string is escaped, so it is
 * text wherever it lands, inside an element or a double-quoted attribute value.
 *
 * @example html`<td>${title}</td>` // title escaped
 */
export function html(strings: TemplateStringsArray, ...parts: readonly Part[]): Markup {
  let written = strings[0] ?? ''
  for (const [index, part] of parts.entries()) written += render(part) + (strings[index + 1] ?? '')
  return made(written)
}

/**
 * Markup from text the report itself holds as a constant, such as its style sheet. Never for text from a run.
 *
 * @example constant(styleSheet)
 */
export function constant(text: string): Markup {
  return made(text)
}

/** Joins markup with nothing between. */
export function join(parts: readonly Part[]): Markup {
  return made(parts.map(render).join(''))
}

/**
 * The text of markup this module built. Anything shaped like markup that it did not build is refused, so no caller can
 * slip raw text through.
 *
 * @example markupText(html`<p>${title}</p>`)
 */
export function markupText(markup: Markup): string {
  const text = built.get(markup)
  if (text === undefined) throw new TypeError('This markup was not built by the report.')
  return text
}

function render(part: Part): string {
  if (part === undefined || part === null || part === false) return ''
  if (typeof part === 'string') return escapeHtml(visibleText(part))
  if (typeof part === 'number') return Number.isFinite(part) ? String(part) : ''
  if (isMarkup(part)) return markupText(part)
  return part.map((item) => markupText(item)).join('')
}

function isMarkup(part: Markup | readonly Markup[]): part is Markup {
  return !Array.isArray(part)
}

/** The data blocks a report carries, each by its element id. */
export type DataBlockId = 'retest-outcome' | 'retest-recording-clocks'

/**
 * A JSON data block, for a program that reads the file and never for the browser to run: the element's type is not a
 * script type. `scriptJson` writes every `<`, `>` and `&` in the value as
 * a JSON escape, so no text in it, `</script>` included, can end the element or open a comment. This is the only way
 * run data reaches the inside of an element whose content the browser does not parse as markup.
 *
 * @example dataBlock('retest-outcome', { status: 'failed' })
 */
export function dataBlock(id: DataBlockId, value: JsonValue): Markup {
  return made(`<script type="application/json" id="${escapeHtml(id)}">${scriptJson(value)}</script>`)
}

/**
 * The `href` or `src` value for a file of the run folder, from its portable reference, as markup for a double-quoted
 * attribute; undefined when the reference is not a portable one, so no record can point the report outside the folder.
 * `artifactHref` escapes the value itself, so it is taken whole here rather than escaped twice. Page addresses are
 * never made links: the report shows them as text.
 *
 * @example html`<a href="${artifactLink('artifacts/a.png')}">`
 */
export function artifactLink(reference: string): Markup | undefined {
  const href = artifactHref(reference)
  return href === undefined ? undefined : made(href)
}
