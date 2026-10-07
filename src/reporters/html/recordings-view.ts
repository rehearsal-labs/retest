import type { RecordingRecord } from '../../protocol/recording.ts'
import type { ArtifactFiles } from './artifact-files.ts'
import type { Markup } from './markup.ts'
import { recordingArtifactReferences } from '../../store/artifacts.ts'
import { formatDuration } from '../format.ts'
import { missingFileView } from './artifact-files.ts'
import { html } from './markup.ts'

const statusWords: Record<RecordingRecord['status'], { word: string; tone: string }> = {
  complete: { word: 'Complete', tone: 'evidence-complete' },
  partial: { word: 'Partial', tone: 'evidence-partial' },
  unavailable: { word: 'Unavailable', tone: 'evidence-unavailable' },
}

/**
 * A test's recordings, one for each app session the run recorded: its state, the video from the run folder when there
 * is one, each gap the run named, and what became of the frames. A recording with no video says why where the video
 * would have been, and names a partial file the media process kept; one retention removed after its attempt passed says
 * so. Undefined for a test the run did not record.
 *
 * @example recordingsView(test.recordings ?? [], files)
 */
export function recordingsView(recordings: readonly RecordingRecord[], files: ArtifactFiles): Markup | undefined {
  if (recordings.length === 0) return undefined
  return html`${recordings.map((recording) => recordingView(recording, files))}`
}

function recordingView(recording: RecordingRecord, files: ArtifactFiles): Markup {
  const { word, tone } = statusWords[recording.status]
  const subject = `Recording ${recording.sequence} of ${recording.app}`
  const heading = html`<h4><span class="words">${subject}</span> <span class="evidence ${tone}">${word}</span></h4>`
  const pending = recording.removalPending === true ? html`<p class="gap">Present, removal not confirmed: retention requested this file's removal but recorded no completion.</p>` : undefined
  const gaps = recording.gaps.length === 0 ? undefined : html`<ul class="small">${recording.gaps.map((gap) => html`<li class="words">${gap.message}</li>`)}</ul>`
  return html`<section class="part" data-recording-id="${recording.recordingId}" data-status="${recording.status}">${heading}${pending}${videoView(recording, subject, files)}<p class="small gap" data-jump-note aria-live="polite"></p>${gaps}${factsView(recording)}</section>`
}

function videoView(recording: RecordingRecord, subject: string, files: ArtifactFiles): Markup {
  if (recording.removed !== undefined) {
    return html`<div class="gap"><strong>${subject} was removed after the test passed.</strong> The config keeps recordings of tests that did not pass. <code class="words">${recording.path ?? ''}</code></div>`
  }
  if (recording.path === undefined) {
    const partial = recording.partialPath === undefined ? undefined : html` A partial file was kept at <code class="words">${recording.partialPath}</code>; whether it plays was not checked.`
    return html`<div class="gap"><strong>${subject} has no video.</strong>${partial}</div>`
  }
  const reference = recordingArtifactReferences(recording, 'result.json').find(reference => reference.path === recording.path)
  if (reference === undefined) return html`<div class="gap">${subject} has no retained video reference.</div>`
  const video = files.video(reference.path)
  if (!video.ok) return missingFileView(subject, video)
  const size = recording.video === undefined ? '' : html` width="${recording.video.width}" height="${recording.video.height}"`
  return html`<figure class="shot"><video controls preload="metadata" src="${video.link}"${size}></video><figcaption class="words">${recording.path}</figcaption></figure>`
}

function factsView(recording: RecordingRecord): Markup {
  const rows: [string, string][] = []
  const capture = [...(recording.source === undefined ? [] : [recording.source]), ...(recording.mode === undefined ? [] : [recording.mode])]
  if (capture.length > 0) rows.push(['Captured by', capture.join(', ')])
  const { video, frames, withheld } = recording
  if (video !== undefined) rows.push(['Video', `${video.codec} in ${video.container}, ${video.width}×${video.height}, ${video.fps} fps, ${video.outputFrames} frames, ${formatDuration(video.durationUs / 1000)}`])
  if (frames !== undefined) {
    const lost = [`${frames.dropped} dropped`, `${frames.notSent} not sent`, `${frames.withheld} withheld by the pixel policy`, `${frames.refused} refused`].filter((part) => !part.startsWith('0 '))
    rows.push(['Frames', `${frames.delivered} delivered, ${frames.sent} sent${lost.length === 0 ? '' : `, ${lost.join(', ')}`}`])
  }
  if (withheld !== undefined && withheld.stretches > 0) rows.push(['Withheld', `${withheld.stretches} ${withheld.stretches === 1 ? 'stretch' : 'stretches'}, ${formatDuration(withheld.durationUs / 1000)} in all, while a secret may have been on screen`])
  rows.push(['Session', recording.sessionId])
  return html`<dl class="check-lines">${rows.map(([label, value]) => html`<dt>${label}</dt><dd class="words">${value}</dd>`)}</dl>`
}
