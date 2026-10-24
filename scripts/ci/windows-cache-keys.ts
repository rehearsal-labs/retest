import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { windowsSetupPins } from './windows-pins.ts'

// Writes the browser archive cache key as a step output, for .github/actions/setup-windows-integration/action.yml:
//
//   node scripts/ci/windows-cache-keys.ts    # with GITHUB_OUTPUT set

const output = process.env['GITHUB_OUTPUT']
if (output === undefined || !isAbsolute(output)) throw new Error('GITHUB_OUTPUT must name an absolute file.')
const line = `archives-key=${windowsSetupPins().archivesKey}\n`
appendFileSync(output, line)
process.stdout.write(line)
