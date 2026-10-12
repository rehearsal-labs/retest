import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { macosSetupPins } from './macos-pins.ts'

// Writes the pinned Rust version and the browser archive cache key as step outputs, for
// .github/actions/setup-macos-integration/action.yml:
//
//   node scripts/ci/macos-cache-keys.ts    # with GITHUB_OUTPUT set

const output = process.env['GITHUB_OUTPUT']
if (output === undefined || !isAbsolute(output)) throw new Error('GITHUB_OUTPUT must name an absolute file.')
const pins = macosSetupPins()
const lines = [`rust=${pins.rust}`, `archives-key=${pins.archivesKey}`, ''].join('\n')
appendFileSync(output, lines)
process.stdout.write(lines)
