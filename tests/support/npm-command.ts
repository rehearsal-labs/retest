import { basename, dirname, join } from 'node:path'

/**
 * How a test or a script starts npm: the program and the arguments that come before npm's own. On macOS and Linux it is
 * `npm` from PATH. On Windows npm is a batch file, `npm.cmd`, which Node starts only through a shell, so npm's own script
 * runs under this Node instead: the one npm named when it started this process, or else the one installed beside node.
 *
 * @example const [npm, ...before] = npmCommand(); spawn(npm, [...before, 'pack'])
 */
export function npmCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): [string, ...string[]] {
  if (platform !== 'win32') return ['npm']
  const started = env['npm_execpath']
  const script = started !== undefined && basename(started) === 'npm-cli.js' ? started : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return [process.execPath, script]
}
