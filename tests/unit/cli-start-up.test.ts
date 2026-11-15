import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tempProject } from '../support/project.ts'
import { rootDir } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

const run = promisify(execFile)

// A hook the CLI's process loads first, which writes every module it loaded to a file as it exits.
const hook = `import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'
const loaded = []
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })
process.on('exit', () => writeFileSync(process.env.LOADED_MODULES, loaded.join('\\n')))
`

// The modules of Retest's own source the CLI loaded for one command line, relative to the repository.
async function loadedFor(cwd: string, args: readonly string[]): Promise<string[]> {
  const folder = tempFolder('cli-start-up-')
  const hookFile = join(folder, 'hook.mjs')
  const list = join(folder, 'loaded.txt')
  writeFileSync(hookFile, hook)
  const main = join(rootDir, 'src', 'cli', 'main.ts')
  await run(process.execPath, ['--conditions=retest-source', '--import', pathToFileURL(hookFile).href, main, ...args], { cwd, env: { ...process.env, LOADED_MODULES: list, NO_COLOR: '1' } }).catch((error: unknown) => {
    // A command that ends with a nonzero code still wrote what it loaded.
    if (!(error instanceof Error && 'code' in error && typeof error.code === 'number')) throw error
  })
  const source = pathToFileURL(join(rootDir, 'src')).href
  return readFileSync(list, 'utf8').split('\n').filter((url) => url.startsWith(source)).map((url) => relative(rootDir, new URL(url).pathname))
}

const runner = ['src/runner/run.ts', 'src/runner/run-session.ts', 'src/browser/launch.ts', 'src/config/load.ts', 'src/runner/app-server.ts']
// What the other commands run with: doctor's checks, the installers, the run folder reader and inspect's timeline.
const otherCommands = ['src/cli/doctor/checks.ts', 'src/cli/install/install-archive.ts', 'src/cli/install/media-install.ts', 'src/cli/install/supervisor-install.ts', 'src/store/read-run-folder.ts', 'src/cli/inspect/test-timeline.ts']
const otherReporters = ['src/reporters/agent.ts', 'src/reporters/jsonl.ts', 'src/reporters/html/reporter.ts', 'src/reporters/html/build-report.ts']
const otherEngines = ['src/browser/firefox/launch.ts', 'src/browser/firefox/browser.ts', 'src/browser/firefox/executable.ts', 'src/browser/webkit/browser.ts', 'src/browser/webkit/build.ts']

describe('what a command loads', () => {
  test('--version loads neither the runner, the browser launch, the config loader nor any command of its own', async () => {
    const loaded = await loadedFor(tempFolder('cli-version-'), ['--version'])
    assert.ok(loaded.includes('src/cli/cli.ts'), loaded.join('\n'))
    assert.deepEqual(runner.filter((module) => loaded.includes(module)), [])
    assert.deepEqual([...otherCommands, ...otherReporters, 'src/reporters/human.ts'].filter((module) => loaded.includes(module)), [])
  })

  test('a run of Chromium tests printed for people loads the runner, and neither the other reporters nor the other engines', async () => {
    const root = tempProject({
      'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) } })
`,
      'tests/one.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('one', () => { expect(1).toBe(1) })
`,
    })
    // Nothing matches, so the run ends once it has collected the file, before any browser.
    const loaded = await loadedFor(root, ['run', '--no-agent', '--grep', 'nothing matches this'])
    assert.deepEqual(runner.filter((module) => !loaded.includes(module)), [], 'the run loads the runner')
    assert.ok(loaded.includes('src/reporters/human.ts'))
    assert.deepEqual([...otherCommands, ...otherReporters, ...otherEngines].filter((module) => loaded.includes(module)), [])
  })
})
