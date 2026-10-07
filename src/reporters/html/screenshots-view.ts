import type { PictureFile } from './artifact-files.ts'
import type { ScreenshotItem } from './evidence-status.ts'
import type { Markup } from './markup.ts'
import { missingFileView } from './artifact-files.ts'
import { html } from './markup.ts'

/**
 * A picture of the run folder, linked to its file, or a frame standing where it would have been that says why it is
 * not there. `alt` says what the picture shows; `caption` names its file and where it came from.
 *
 * @example pictureView(files.picture('artifacts/a.png'), 'Failure screenshot of web', 'artifacts/a.png')
 */
export function pictureView(picture: PictureFile, alt: string, caption: string): Markup {
  if (!picture.ok) return missingFileView(alt, picture)
  const size = picture.width === undefined || picture.height === undefined ? '' : html` width="${picture.width}" height="${picture.height}"`
  return html`<figure class="shot"><a href="${picture.link}"><img src="${picture.link}" alt="${alt}"${size} loading="lazy" decoding="async"></a><figcaption class="words">${caption}</figcaption></figure>`
}

/**
 * A test's screenshots, each linked to its file, or a frame naming why it is missing: a screenshot the run could not
 * save, a file that is not where its record says, or none recorded for a failure at all.
 *
 * @example screenshotsView(evidence.screenshots, { missing: 'no failure screenshot was recorded' })
 */
export function screenshotsView(items: readonly ScreenshotItem[], options: { missing?: string | undefined } = {}): Markup | undefined {
  if (items.length === 0) return options.missing === undefined ? undefined : html`<div class="gap"><strong>No screenshot.</strong> ${capitalized(options.missing)}.</div>`
  const shown = items.map((item) => {
    const subject = item.app === undefined ? 'Failure screenshot' : `Failure screenshot of ${item.app}`
    if (!item.saved) return html`<div class="gap"><strong>${subject} not saved.</strong> ${item.message}</div>`
    const facts = [item.reference, ...(item.source === undefined ? [] : [item.source]), ...(item.sessionId === undefined ? [] : [`session ${item.sessionId}`]), ...(item.observationId === undefined ? [] : [`look ${item.observationId}`])]
    return pictureView(item.picture, subject, facts.join(' · '))
  })
  return html`<div class="shots">${shown}</div>`
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}
