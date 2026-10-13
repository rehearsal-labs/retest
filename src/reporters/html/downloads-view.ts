import type { EventOfType, TestEvent } from '../run-record.ts'
import type { Markup } from './markup.ts'
import { checkArtifact } from '../../store/artifacts.ts'
import { describeDownload, failureLabel } from '../format.ts'
import { artifactLink, html } from './markup.ts'

// Larger than any file a test downloads; the report links to the file and never reads it.
const maxDownloadBytes = Number.MAX_SAFE_INTEGER

/**
 * A test's downloads, each linked to its file in the run folder so a reviewer can open it, or saying why there is none:
 * the browser stopped it, it was unfinished when the test ended, or its file is not where its record says.
 *
 * @example downloadsView(events, '/work/.retest/runs/2026-10-14T10-00-00')
 */
export function downloadsView(events: readonly TestEvent[], directory: string): Markup | undefined {
  const downloads = events.filter((event): event is EventOfType<'download'> => event.type === 'download')
  if (downloads.length === 0) return undefined
  return html`<ul class="downloads">${downloads.map((event) => html`<li class="words">${downloadItem(event, directory)}</li>`)}</ul>`
}

function downloadItem(event: EventOfType<'download'>, directory: string): Markup {
  const what = describeDownload(event)
  if (event.state !== 'completed' || event.path === undefined) {
    const failed = event.failure === undefined ? '' : html` <span class="status status-failed">${failureLabel(event.failure.class)}</span>`
    return html`${what}${failed}`
  }
  const checked = checkArtifact(directory, event.path, { maxBytes: maxDownloadBytes })
  const link = artifactLink(event.path)
  if (!checked.ok || link === undefined) return html`${what}: <code>${event.path}</code> cannot be opened (${checked.ok ? 'not a path inside the run folder' : checked.message})`
  return html`<a href="${link}" download><code>${event.path}</code></a> · ${what}`
}
