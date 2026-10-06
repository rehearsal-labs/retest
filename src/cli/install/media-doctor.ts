import type { Check } from '../doctor/checks.ts'
import type { LoadedConfig } from '../../config/loaded.ts'
import type { MediaEnvironment } from './media-tools.ts'
import { locateFfmpeg, ffmpegFix, locateMedia } from '../../media/locate.ts'
import { mediaTarget, minimumRust } from './media-pins.ts'
import { findMediaTool, probeMediaBinary, rustAtLeast, runMediaTool, rustFix } from './media-tools.ts'

/** Media checks are setup checks only for a config that asks for recording. No target is captured. */
export async function checkMedia(config: LoadedConfig, env: MediaEnvironment, signal: AbortSignal): Promise<Check[]> {
  if (config.recording === undefined || (!config.recording.record && ![...config.recording.apps.values()].some(Boolean))) return []
  return mediaDoctorRows(env, signal)
}

export async function mediaDoctorRows(env: MediaEnvironment, signal: AbortSignal): Promise<Check[]> {
  const checks: Check[] = []
  if (signal.aborted) return [{ group: 'media', subject: 'retest-media', ok: false, text: 'The media check was stopped.', fix: rustFix }]
  const found = await locateMedia({ env, ffmpeg: '/usr/bin/false', signal })
  checks.push(found.ok
    ? { group: 'media', subject: 'retest-media', ok: true, text: `retest-media ${found.hello.version}, protocol ${found.hello.protocol}, from ${found.source}; source builds need Rust 1.88 or later, edition 2024 needs Rust 1.85 or later${found.inspection?.record === undefined ? '; no cache record for this explicit binary' : `; SHA-256 ${found.inspection.record.binarySha256} matches its record`}`, detail: found.executable, fix: rustFix }
    : { group: 'media', subject: 'retest-media', ok: false, text: found.message, fix: 'Run npx retest install media. For an explicit release binary set RETEST_MEDIA_BINARY.' })
  if (!found.ok) {
    for (const name of ['cargo', 'rustc']) {
      const path = await findMediaTool(name, env)
      const result = path === undefined ? undefined : await runMediaTool(path, [name === 'cargo' ? '--version' : '-vV'], { env, signal })
      const version = result?.stdout.split('\n')[0]?.trim() ?? ''
      const ok = result?.code === 0 && !result.stopped && !result.timedOut && result.cleanupProblems.length === 0 && rustAtLeast(version)
      checks.push({ group: 'media', subject: name, ok, text: `${ok ? version : `${name} is missing, unreadable or older than the pinned minimum`}. Edition 2024 needs Rust 1.85 or later; this crate needs Rust ${minimumRust} or later.`, ...(path === undefined ? {} : { detail: path }), fix: rustFix })
    }
  }
  const ffmpeg = await locateFfmpeg({ env })
  if (!ffmpeg.ok) { checks.push({ group: 'media', subject: 'ffmpeg', ok: false, text: ffmpeg.message, fix: ffmpegFix }); return checks }
  if (signal.aborted) return [...checks, { group: 'media', subject: 'ffmpeg', ok: false, text: 'The ffmpeg check was stopped.', fix: ffmpegFix }]
  const listings: Record<string, string> = {}
  for (const [key, argument] of [['version', '-version'], ['licence', '-L'], ['encoders', '-encoders'], ['formats', '-formats'], ['decoders', '-decoders']] as const) {
    const result = await runMediaTool(ffmpeg.path, [argument], { env, signal })
    if (result.code !== 0 || result.stopped || result.timedOut || result.cleanupProblems.length > 0) { checks.push({ group: 'media', subject: 'ffmpeg', ok: false, text: `ffmpeg could not answer ${argument} with confirmed cleanup.`, detail: ffmpeg.path, fix: ffmpegFix }); return checks }
    listings[key] = result.stdout + '\n' + result.stderr
  }
  const version = /^ffmpeg version [^\n]+/m.exec(listings['version'] ?? '')?.[0]?.slice(0, 200)
  const licence = ffmpegLicence(listings['licence'] ?? '')
  const routes = ffmpegRoutes(listings['encoders'] ?? '', listings['formats'] ?? '', listings['decoders'] ?? '')
  const target = mediaTarget()
  const ready = found.ok && target !== undefined ? await probeMediaBinary(found.executable, ffmpeg.path, target, 15_000, true) : undefined
  const encoder = ready?.ok === true ? ready.encoder : undefined
  const decision = encoder?.state === 'ready' ? `Media probe chose ${encoder.encoder} in ${encoder.container}; encoded inputs ${encoder.encodedInput.join(', ') || 'none'}.` : encoder?.state === 'unavailable' || encoder?.state === 'failed' ? encoder.message : ready?.ok === false ? ready.message : 'Media binary unavailable; its own recording probe could not run.'
  checks.push({ group: 'media', subject: 'ffmpeg', ok: version !== undefined && licence !== '' && encoder?.state === 'ready', text: `${version ?? 'No ffmpeg version line'}. Licence: ${licence || 'no licence line found'}. ${routes} ${decision} ffmpeg is a declared prerequisite; Retest ships no ffmpeg.`, detail: ffmpeg.path, fix: ffmpegFix })
  return checks
}

/** Keeps the licence's opening paragraph, including its version; a build banner is not a licence. */
export function ffmpegLicence(listing: string): string {
  const lines = listing.split('\n').map((line) => line.trim())
  const start = lines.findIndex((line) => !/^configuration:/i.test(line) && /(?:GNU (?:Lesser )?General Public License|ffmpeg is (?:free software|nonfree)|unredistributable)/i.test(line))
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && line === '')
  return lines.slice(start, Math.min(start + 4, end < 0 ? lines.length : end)).join(' ').slice(0, 600)
}

export function ffmpegRoutes(encoders: string, formats: string, decoders: string): string {
  const encoder = (name: string): boolean => encoders.split('\n').some((line) => /^\s*V[A-Z.]{5}\s+/.test(line) && line.trim().split(/\s+/)[1] === name)
  const format = (name: string, flag: 'D' | 'E'): boolean => formats.split('\n').some((line) => { const match = /^\s*([D E]{2})\s+(\S+)/.exec(line); return match !== null && match[1]?.includes(flag) === true && match[2]?.split(',').includes(name) === true })
  const decoder = (name: string): boolean => decoders.split('\n').some((line) => /^\s*V[A-Z.]{5}\s+/.test(line) && line.trim().split(/\s+/)[1] === name)
  const present = (yes: boolean): string => yes ? 'present' : 'missing'
  return `Decoded route: rawvideo demuxer ${present(format('rawvideo', 'D'))}; H.264 libx264 encoder ${present(encoder('libx264'))} and mp4 muxer ${present(format('mp4', 'E'))}; VP8 libvpx encoder ${present(encoder('libvpx'))} and webm muxer ${present(format('webm', 'E'))}. Encoded route also needs image2pipe demuxer ${present(format('image2pipe', 'D'))}, with PNG decoder ${present(decoder('png'))} or JPEG mjpeg decoder ${present(decoder('mjpeg'))}.`
}
