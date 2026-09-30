import { parseArgs } from 'node:util'
import { startProxy } from './server.ts'

const USAGE = `Usage: node fixtures/proxy/cli.ts [--challenge]
Prints the proxy's address, then one line for each request it receives: the method and the address or host.
Plain requests to loopback hosts are forwarded with the x-retest-proxy header, and CONNECT to them is tunnelled.
  --challenge   answer every request with 407, as a proxy that wants credentials does
`

try {
  const { values } = parseArgs({ options: { challenge: { type: 'boolean', default: false } } })
  const proxy = await startProxy({
    challenge: values.challenge,
    onRequest: ({ method, target }) => process.stdout.write(`${method} ${target}\n`),
  })
  process.stdout.write(`${proxy.url}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  process.exitCode = 2
}
