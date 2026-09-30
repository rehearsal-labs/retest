import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAppServer } from '../../src/runner/app-server.ts'

// Starts a server, prints the process id it logged, then exits without stopping it, as a second Ctrl+C does.

const [folder, port] = process.argv.slice(2)
if (folder === undefined || port === undefined) throw new Error('Pass a folder and a port.')
const script = fileURLToPath(new URL('./http-server.ts', import.meta.url))
const logFile = join(folder, 'app.log')
const command = [process.execPath, script, port].map((part) => JSON.stringify(part)).join(' ')
await startAppServer({ name: 'web', start: { command, ready: `http://127.0.0.1:${port}/`, cwd: folder }, logFile }, 5000)
const pid = /pid (\d+)/.exec(readFileSync(logFile, 'utf8'))?.[1]
process.stdout.write(`server ${pid}\n`, () => process.exit(0))
