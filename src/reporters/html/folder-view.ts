import type { ArtifactInventory } from '../../store/artifacts.ts'
import type { Markup } from './markup.ts'
import type { ReportContext } from './report-context.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { eventArtifactReferences, inventoryArtifacts, resultArtifactReferences } from '../../store/artifacts.ts'
import { html } from './markup.ts'

// The run folder lists hold this many files each; a folder with more says how many more.
const shownFiles = 100

/**
 * What the run folder holds against what its records name, when they differ: files a record names that the safe read
 * refused, each with its reason, files no record names, a `.partial` one among them marked as left unfinished, and
 * entries the listing did not follow. Undefined when every named file is there and nothing else is.
 *
 * @example folderView(context)
 */
export function folderView(context: ReportContext): Markup | undefined {
  const { directory, events, result } = context.input
  let inventory: ArtifactInventory
  try {
    inventory = inventoryArtifacts(directory, [...eventArtifactReferences(events), ...resultArtifactReferences(result)])
  } catch (error) {
    return section(html`<div class="gap"><strong>The run folder could not be listed.</strong> ${errorMessage(error)}</div>`)
  }
  const { missing, unreferenced, refused, truncated } = inventory
  if (missing.length + unreferenced.length + refused.length === 0 && !truncated) return undefined
  const missingRows = missing.map((file) => html`<tr data-reference="${file.reference}" data-refusal="${file.reason}"><td class="words"><code>${file.reference}</code></td><td>${file.reason.replaceAll('_', ' ')}</td><td class="words muted">${file.message}</td><td class="muted">${file.namedBy.join(', ')}</td></tr>`)
  const extraRows = unreferenced.slice(0, shownFiles).map((file) => html`<tr><td class="words"><code>${file.reference}</code></td><td class="number">${file.size} bytes</td><td>${file.partial ? 'left unfinished' : ''}</td></tr>`)
  const refusedRows = refused.slice(0, shownFiles).map((entry) => html`<tr data-reference="${entry.reference}" data-refusal="${entry.reason}"><td class="words"><code>${entry.reference}</code></td><td>${entry.reason.replaceAll('_', ' ')}</td><td class="words muted">${entry.message}</td></tr>`)
  return section(html`${missing.length === 0 ? undefined : html`<h4>Named by the records, not readable here</h4><div class="table-wrap"><table><thead><tr><th scope="col">File</th><th scope="col">Refused as</th><th scope="col">Why</th><th scope="col">Named by</th></tr></thead><tbody>${missingRows}</tbody></table></div>`}${unreferenced.length === 0 ? undefined : html`<h4>In the folder, named by no record</h4><div class="table-wrap"><table><thead><tr><th scope="col">File</th><th scope="col">Size</th><th scope="col">Note</th></tr></thead><tbody>${extraRows}</tbody></table></div>${more(unreferenced.length)}`}${refused.length === 0 ? undefined : html`<h4>Not followed</h4><div class="table-wrap"><table><thead><tr><th scope="col">Entry</th><th scope="col">Refused as</th><th scope="col">Why</th></tr></thead><tbody>${refusedRows}</tbody></table></div>${more(refused.length)}`}${truncated ? html`<p class="muted small">The folder holds more entries than the listing reads, so these lists may be short.</p>` : undefined}`)
}

function section(content: Markup): Markup {
  return html`<section aria-labelledby="run-folder"><h2 id="run-folder">Run folder</h2>${content}</section>`
}

function more(total: number): Markup | undefined {
  return total > shownFiles ? html`<p class="muted small">${total - shownFiles} more are not listed.</p>` : undefined
}
