import type { FailureCard } from '../failure-card.ts'
import type { ArtifactFiles } from './artifact-files.ts'
import type { Markup } from './markup.ts'
import { html } from './markup.ts'
import { pictureView } from './screenshots-view.ts'

const names: Readonly<Record<string, string>> = { expected: 'Expected', actual: 'Actual', diff: 'Difference' }

/**
 * The pictures a failed screenshot comparison left, side by side, each linked to its file in the run folder: the
 * baseline it expected, the picture the page showed, and where the two differ, in red. A picture the safe read refuses
 * is named in a frame where it would have been. Undefined when the failing call left no pictures.
 *
 * @example comparisonView(card, context.files)
 */
export function comparisonView(card: FailureCard, files: ArtifactFiles): Markup | undefined {
  const { call } = card
  if (call?.type !== 'assertion.failed' || call.attachments === undefined || call.attachments.length === 0) return undefined
  const subject = call.screenshot === undefined ? 'the check' : `"${call.screenshot.name}"`
  const shown = call.attachments.map(({ name, path }) => {
    const label = names[name] ?? name
    return pictureView(files.picture(path), `${label} picture of ${subject}`, `${label} · ${path}`)
  })
  return html`<div class="shots comparison">${shown}</div>`
}
