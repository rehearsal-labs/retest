import type { LoadedConfig } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { app, chromium, defineConfig, electron } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { tempFolder } from '../support/temp-folder.ts'

const path = '/work/retest.config.ts'
const binary = 'electron/dist/Electron.app/Contents/MacOS/Electron'

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, path)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

/** Every problem the config has, as `key: message` lines. */
function problems(value: unknown): string[] {
  const result = validateConfig(value, path)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  assert.equal(result.failure.class, 'usage')
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${path}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

describe('electron(): an Electron app in the config', () => {
  test('names its browser, keeps every option and checks nothing at run time', () => {
    const target = electron({ executablePath: binary, appPath: 'desktop', args: ['--tasks=3'], userDataDir: 'data' })
    assert.deepEqual(target, { executablePath: binary, appPath: 'desktop', args: ['--tasks=3'], userDataDir: 'data', browser: 'electron' })
  })

  test('on its own, it is an app named after its browser, with every path absolute from the config folder', () => {
    const config = loaded(defineConfig({ apps: { desktop: electron({ executablePath: binary, appPath: '../apps/desktop' }) } }))
    assert.deepEqual([...(config.apps.get('desktop')?.targets.entries() ?? [])], [
      [
        'electron',
        {
          name: 'electron',
          browser: 'electron',
          executablePath: `/work/${binary}`,
          appPath: '/apps/desktop',
          args: [],
        },
      ],
    ])
    assert.equal(config.apps.get('desktop')?.baseUrl, undefined)
  })

  test("takes the app's arguments, a data folder and the app's start command", () => {
    const config = loaded(
      defineConfig({
        apps: {
          desktop: electron({
            executablePath: '/opt/Electron.app/Contents/MacOS/Electron',
            appPath: 'desktop/main.js',
            args: ['--tasks=3', '--theme', 'dark'],
            userDataDir: '.data/desktop',
            start: { command: 'node service.ts', ready: 'http://127.0.0.1:4100/' },
          }),
        },
      }),
    )
    const desktop = config.apps.get('desktop')
    assert.deepEqual(desktop?.targets.get('electron'), {
      name: 'electron',
      browser: 'electron',
      executablePath: '/opt/Electron.app/Contents/MacOS/Electron',
      appPath: '/work/desktop/main.js',
      args: ['--tasks=3', '--theme', 'dark'],
      userDataDir: '/work/.data/desktop',
    })
    assert.deepEqual(desktop?.start, { command: 'node service.ts', ready: 'http://127.0.0.1:4100/', cwd: '/work' })
  })

  test('an app may hold several Electron targets, such as two builds of the same app', () => {
    const config = loaded({
      apps: {
        desktop: app({
          targets: {
            stable: electron({ executablePath: '/opt/stable/Electron', appPath: 'desktop' }),
            next: electron({ executablePath: '/opt/next/Electron', appPath: 'desktop' }),
          },
        }),
      },
    })
    assert.deepEqual([...(config.apps.get('desktop')?.targets.keys() ?? [])], ['stable', 'next'])
  })
})

describe('electron(): what the config refuses', () => {
  test('an address, on its own or on its app: the first window the app opens is the page', () => {
    const message = 'an Electron app has no address: the first window it opens is the page, so it takes no baseUrl'
    assert.deepEqual(problems({ apps: { desktop: { browser: 'electron', executablePath: binary, appPath: 'desktop', baseUrl: 'http://127.0.0.1:4173' } } }), [
      `apps.desktop.baseUrl: ${message}`,
    ])
    assert.deepEqual(problems({ apps: { desktop: { baseUrl: 'http://127.0.0.1:4173', targets: { electron: { browser: 'electron', executablePath: binary, appPath: 'desktop' } } } } }), [
      `apps.desktop.baseUrl: ${message}`,
    ])
  })

  test('an app that mixes Electron targets with browsers', () => {
    assert.deepEqual(problems({ apps: { tasks: app({ targets: { web: chromium(), desktop: electron({ executablePath: binary, appPath: 'desktop' }) } }) } }), [
      "apps.tasks.targets: mixes browsers and Electron apps. An app's targets are all of one kind: give each kind an app of its own",
    ])
  })

  test('browser settings, which an Electron app has no use for, and keys it does not know', () => {
    const message = problems({
      apps: {
        desktop: {
          browser: 'electron',
          executablePath: binary,
          appPath: 'desktop',
          headless: true,
          emulate: 'Pixel 9',
          viewport: { width: 800, height: 600 },
          proxy: { server: 'http://127.0.0.1:8080' },
          appPth: 'desktop',
        },
      },
    })
    assert.deepEqual(message.sort(), [
      'apps.desktop.appPth: unknown key',
      'apps.desktop.emulate: unknown key',
      'apps.desktop.headless: unknown key',
      'apps.desktop.proxy: unknown key',
      'apps.desktop.viewport: unknown key',
    ])
  })

  test('a missing or empty binary, app or data folder', () => {
    assert.deepEqual(problems({ apps: { desktop: { browser: 'electron', appPath: 'desktop' } } }), ['apps.desktop.executablePath: missing required key'])
    assert.deepEqual(problems({ apps: { desktop: { browser: 'electron', executablePath: binary } } }), ['apps.desktop.appPath: missing required key'])
    assert.deepEqual(problems({ apps: { desktop: { browser: 'electron', executablePath: ' ', appPath: '', userDataDir: '' } } }).sort(), [
      'apps.desktop.appPath: expected a path, received ""',
      'apps.desktop.executablePath: expected a path, received " "',
      'apps.desktop.userDataDir: expected a folder, received ""',
    ])
  })

  test('arguments that would take the debugging pipe or the data folder away from Retest, naming the switch alone', () => {
    const lines = problems({
      apps: {
        desktop: electron({
          executablePath: binary,
          appPath: 'desktop',
          args: ['--tasks=3', '--user-data-dir=/home/someone/.config/tasks', '--remote-debugging-port=9222', '-remote-debugging-pipe', '-user-data-dir'],
        }),
      },
    })
    assert.deepEqual(lines, [
      'apps.desktop.args[1]: Retest gives the app its data folder: set userDataDir instead of --user-data-dir',
      'apps.desktop.args[2]: Retest drives the app over a debugging pipe of its own, so the app takes no --remote-debugging-port',
      'apps.desktop.args[3]: Retest drives the app over a debugging pipe of its own, so the app takes no --remote-debugging-pipe',
      'apps.desktop.args[4]: Retest gives the app its data folder: set userDataDir instead of --user-data-dir',
    ])
    assert.equal(lines.join('\n').includes('/home/someone'), false, 'no message quotes the value an argument carries')
  })

  test('two Electron targets that name one data folder, naming both, since each would wait on the other for the run', () => {
    const shared = { executablePath: binary, appPath: 'desktop', userDataDir: '.data/desktop' }
    assert.deepEqual(
      problems({
        apps: {
          desktop: electron(shared),
          builds: app({ targets: { stable: electron({ ...shared, executablePath: '/opt/stable/Electron' }), next: electron({ ...shared, userDataDir: './.data/desktop/' }) } }),
        },
      }),
      [
        'apps.builds.targets.stable.userDataDir: is also the data folder of apps.desktop: give each Electron target a folder of its own',
        'apps.builds.targets.next.userDataDir: is also the data folder of apps.desktop: give each Electron target a folder of its own',
      ],
    )
    // Folders named differently are told apart by their real paths and their disk's case rule, which the check reads from
    // the disk itself, so this config lives in a real folder rather than the made-up one above.
    const project = tempFolder('electron-folders-')
    const apart = validateConfig({ apps: { one: electron({ ...shared, userDataDir: 'one' }), two: electron({ ...shared, userDataDir: 'two' }), three: electron(shared) } }, join(project, 'retest.config.ts'))
    assert.ok(apart.ok, apart.ok ? '' : apart.failure.message)
    assert.equal(apart.config.apps.size, 3, 'folders of their own, or none named, are fine')
  })

  test('arguments that are not a list of strings', () => {
    assert.deepEqual(problems({ apps: { desktop: { browser: 'electron', executablePath: binary, appPath: 'desktop', args: '--tasks=3' } } }), [
      'apps.desktop.args: expected array, received "--tasks=3"',
    ])
  })
})
