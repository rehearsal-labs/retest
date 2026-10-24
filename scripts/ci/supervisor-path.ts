import { appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { supervisorFolder } from '../../src/cli/install/supervisor-locate.ts'
import { supervisorExecutable, supervisorTarget } from '../../src/cli/install/supervisor-pins.ts'

// Names the supervisor `retest install supervisor` put in this runner's cache to every later step through GITHUB_ENV,
// so the harnesses can hand it to the product under test, which they start with a home of its own. It runs after the
// install, since the product's own install reads the variable too and refuses a path that is not a file yet.
//
//   node scripts/ci/supervisor-path.ts

const target = supervisorTarget()
const folder = target === undefined ? undefined : supervisorFolder(process.env, target)
if (target === undefined || folder === undefined) throw new Error('No supervisor build target for this machine.')
const binary = join(folder, supervisorExecutable)
if (!statSync(binary, { throwIfNoEntry: false })?.isFile()) throw new Error(`No supervisor at ${binary}; run retest install supervisor first.`)
const environmentFile = process.env['GITHUB_ENV']
if (environmentFile === undefined) throw new Error('GITHUB_ENV is required.')
appendFileSync(environmentFile, `RETEST_SUPERVISOR_BINARY=${binary}\n`)
process.stdout.write(`RETEST_SUPERVISOR_BINARY=${binary}\n`)
