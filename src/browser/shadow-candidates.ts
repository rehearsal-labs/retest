import type { AriaRole } from '../protocol/aria-role.ts'
import type { LocatorStep } from '../protocol/locator.ts'
import { normalizeText } from '../protocol/text.ts'
import { labelledRoles } from './accessibility.ts'

// Firefox's and WebKit's accessibility trees, as Retest reads them, stop at shadow roots, where Chrome's goes through.
// A role or label step there refuses an open root inside its search that could hold what it asks for, rather than find
// less than Chrome: a root holding none of the step's candidates, or none of the words of the name it asks for, is left
// alone. Each candidate selector is wider than the elements HTML gives that role, never narrower; an explicit role,
// and any custom element, which can give itself a role, count too, and a role with no row here takes every element.

const implicit: Partial<Record<AriaRole, string>> = {
  article: 'article',
  banner: 'header',
  blockquote: 'blockquote',
  button: 'button, input, summary',
  caption: 'caption, figcaption',
  cell: 'td, th',
  checkbox: 'input',
  code: 'code',
  columnheader: 'th',
  combobox: 'select, input',
  complementary: 'aside',
  contentinfo: 'footer',
  definition: 'dd',
  deletion: 'del, s',
  dialog: 'dialog',
  emphasis: 'em',
  figure: 'figure',
  form: 'form',
  gridcell: 'td, th',
  group: 'fieldset, details, optgroup, address, hgroup',
  heading: 'h1, h2, h3, h4, h5, h6',
  img: 'img, svg, picture, canvas, object, embed, input, area',
  insertion: 'ins',
  link: 'a, area',
  list: 'ul, ol, menu',
  listbox: 'select, datalist',
  listitem: 'li',
  main: 'main',
  math: 'math',
  meter: 'meter',
  navigation: 'nav',
  option: 'option',
  paragraph: 'p',
  progressbar: 'progress',
  radio: 'input',
  region: 'section',
  row: 'tr',
  rowgroup: 'thead, tbody, tfoot',
  rowheader: 'th',
  search: 'search, form',
  searchbox: 'input',
  separator: 'hr',
  slider: 'input',
  spinbutton: 'input',
  status: 'output',
  strong: 'strong',
  subscript: 'sub',
  superscript: 'sup',
  switch: 'input',
  table: 'table',
  term: 'dfn, dt',
  textbox: 'input, textarea, [contenteditable]',
  time: 'time',
}

// Elements whose name can come from no text the page wrote, such as a submit button's "Submit": a root holding one could
// hold any name.
const unnamedButtons = 'input[type="submit" i], input[type="reset" i], input[type="image" i], input[type="file" i]'

/**
 * What a role or label step's refusal of open shadow roots looks for: a CSS selector of the elements that could have
 * the role, the name it asks for, lowercased with whitespace normalised, or null when it asks for none or a pattern,
 * and a selector of elements whose name the page never writes, or null.
 */
export type ShadowCandidates = { candidates: string; named: string | null; unnamed: string | null }

/**
 * The candidates of a role or label step, as an engine whose tree stops at shadow roots refuses them.
 *
 * @example shadowCandidates({ by: 'role', role: 'listitem' }).candidates // 'li, [role~="listitem" i]'
 */
export function shadowCandidates(step: Extract<LocatorStep, { by: 'role' | 'label' }>): ShadowCandidates {
  const roles: readonly AriaRole[] = step.by === 'role' ? [step.role] : labelledRoles
  const candidates = roles.map((role) => `${implicit[role] ?? '*'}, [role~="${role}" i]`).join(', ')
  const name = step.by === 'role' ? step.name : step.text
  const named = typeof name === 'string' ? normalizeText(name).toLowerCase() : null
  return { candidates, named, unnamed: roles.includes('button') ? unnamedButtons : null }
}
