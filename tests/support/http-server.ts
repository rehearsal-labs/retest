import { createServer } from 'node:http'

// A server an app's `start` command runs in tests: `node http-server.ts <port> [delayMs] [secret]`. It answers
// every request with 503 after waiting `delayMs` to listen, and prints its process id, and `secret` when given,
// so a test can find it in the log.

const [portText = '', delayText = '0', printed] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isInteger(port) || port <= 0) throw new Error(`Pass a port, received ${JSON.stringify(portText)}.`)

process.stdout.write(`pid ${process.pid}\n`)
if (printed !== undefined) process.stdout.write(`password is ${printed}\n`)
setTimeout(() => {
  createServer((_request, response) => {
    response.statusCode = 503
    response.end('starting')
  }).listen(port, '127.0.0.1', () => process.stdout.write(`listening on ${port}\n`))
}, Number(delayText))
