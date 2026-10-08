import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { browserPath } from '../tests/support/test-browser.ts'

export type Engine = 'chromium' | 'firefox' | 'webkit'
export type RecordingOptions = {
  readonly output: string
  readonly workspace: string
  readonly observer: string
  readonly media: string
  readonly ffmpeg: string
  readonly ffprobe: string
  readonly runs: number
  readonly engines: readonly Engine[]
  readonly comparison: boolean
  readonly comparisonOnly: boolean
  readonly paths: Readonly<Record<Engine, string>>
}

export const recordingUsage: string = `Usage: node benchmarks/recording.ts --workspace <prepared-benchmark-workspace> --observer <observer-build-output> [options]
  --output <folder>   Empty result folder. Default: .retest/benchmarks/recording-<timestamp>
  --runs <n>          At least five measured runs per cell. Default: 5
  --engines <list>    chromium,firefox,webkit. Default: all
  --no-comparison     Omit the matched recording-off Chrome Playwright rows
  --comparison-only  Run only those rows; requires --engines chromium
  --chrome <path>     Installed Chrome binary
  --firefox <path>    Installed Firefox binary
  --webkit <path>     Unpacked WebKit build folder
  --media <path>      Explicit production media binary
  --ffmpeg <path>     Explicit host encoder
  --ffprobe <path>    Explicit host artifact probe
  --help              Show this help
`

export function recordingOptions(argv: readonly string[]): RecordingOptions | null {
  const { values } = parseArgs({ args: [...argv], options: {
    output: { type: 'string' }, workspace: { type: 'string' }, observer: { type: 'string' },
    runs: { type: 'string', default: '5' }, engines: { type: 'string', default: 'chromium,firefox,webkit' },
    'no-comparison': { type: 'boolean', default: false }, chrome: { type: 'string' }, firefox: { type: 'string' }, webkit: { type: 'string' },
    'comparison-only': { type: 'boolean', default: false },
    media: { type: 'string', default: 'media/target/release/retest-media' }, ffmpeg: { type: 'string', default: '/opt/homebrew/bin/ffmpeg' },
    ffprobe: { type: 'string', default: '/opt/homebrew/bin/ffprobe' }, help: { type: 'boolean', default: false },
  } })
  if (values.help) return null
  if (values.workspace === undefined || values.observer === undefined) throw new Error('--workspace and --observer are required. No installation is implicit.')
  if (!/^[1-9]\d*$/.test(values.runs) || Number(values.runs) < 5 || !Number.isSafeInteger(Number(values.runs))) throw new Error('--runs needs a safe integer of at least five.')
  const engines: Engine[] = values.engines.split(',').map(name => {
    if (name !== 'chromium' && name !== 'firefox' && name !== 'webkit') throw new Error(`Unknown engine ${name}`)
    return name
  })
  if (new Set(engines).size !== engines.length) throw new Error('An engine was named twice.')
  if (values['comparison-only'] && (values['no-comparison'] || engines.length !== 1 || engines[0] !== 'chromium')) throw new Error('--comparison-only requires --engines chromium and permits the comparison.')
  return {
    output: resolve(values.output ?? `.retest/benchmarks/recording-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`),
    workspace: resolve(values.workspace), observer: resolve(values.observer), media: resolve(values.media), ffmpeg: resolve(values.ffmpeg), ffprobe: resolve(values.ffprobe),
    runs: Number(values.runs), engines, comparison: !values['no-comparison'], comparisonOnly: values['comparison-only'],
    paths: { chromium: values.chrome ?? browserPath(), firefox: values.firefox ?? '/Applications/Firefox.app/Contents/MacOS/firefox', webkit: values.webkit ?? join(homedir(), 'Library/Caches/ms-playwright/webkit-2359') },
  }
}
