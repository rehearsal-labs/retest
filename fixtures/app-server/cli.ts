import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

// The server an app's `start` command runs in the integration tests. It says on stdout and stderr what it is
// doing, so a test can read its log, and each flag gives a way for a start to go wrong.
const USAGE = `Usage: node fixtures/app-server/cli.ts --port <port> [options]
  --delay-ms <ms>     wait this long before listening
  --never-listen      start, and never answer
  --ignore-term       keep running on SIGTERM, so only SIGKILL stops it
  --child             start a child process that stays until its process group is stopped
  --print-env <name>  print an environment variable, as a server that logs its settings would
`

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'delay-ms': { type: 'string', default: '0' },
    'never-listen': { type: 'boolean', default: false },
    'ignore-term': { type: 'boolean', default: false },
    child: { type: 'boolean', default: false },
    'print-env': { type: 'string' },
  },
})

const port = Number(values.port)
const delayMs = Number(values['delay-ms'])
if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(delayMs) || delayMs < 0) {
  process.stderr.write(USAGE)
  process.exit(2)
}

process.stdout.write(`app server ${process.pid} starting\n`)
process.stderr.write('app server writes to stderr too\n')
const printed = values['print-env']
if (printed !== undefined) process.stdout.write(`${printed}=${process.env[printed] ?? ''}\n`)

if (values.child) {
  // Its command line names the port too, so a test can find it by the same mark as the server.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', 'app-server-child', '--port', String(port)], { stdio: 'ignore' })
  process.stdout.write(`child pid ${child.pid}\n`)
}

const server = createServer((request, response) => {
  process.stdout.write(`${request.method} ${request.url}\n`)
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>App server</title><link rel="icon" href="data:,"></head>
<body><main><h1>Served by the app server</h1><p data-testid="server-pid">${process.pid}</p>
<label for="code">Code</label><input id="code" autocomplete="off"></main></body>
</html>
`)
})

process.on('SIGTERM', () => {
  process.stdout.write(values['ignore-term'] ? 'ignoring SIGTERM\n' : 'stopping on SIGTERM\n')
  if (values['ignore-term']) return
  server.closeAllConnections()
  server.close()
  process.exit(0)
})

if (values['never-listen']) {
  setInterval(() => {}, 60_000)
} else {
  await delay(delayMs)
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  process.stdout.write(`listening on http://127.0.0.1:${port}\n`)
}
