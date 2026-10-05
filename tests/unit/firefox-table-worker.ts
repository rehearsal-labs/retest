import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import { parentPort } from 'node:worker_threads'
import { metadataComplete, metadataFailure, metadataSuccess } from '../../src/shared/metadata-process.ts'

const pids = [50_000_001, 50_000_002, 50_000_003, 50_000_004, process.pid]
const parts = new Date(0).toUTCString().split(' ')
const startedAt = `${parts[0]?.replace(',', '')} ${parts[2]} ${parts[1]} ${parts[4]} ${parts[3]}`
const changedParts = new Date(86_400_000).toUTCString().split(' ')
const changedStart = `${changedParts[0]?.replace(',', '')} ${changedParts[2]} ${changedParts[1]} ${changedParts[4]} ${changedParts[3]}`
export function installTableFixture(reused = false): void {
  parentPort?.on('message', (request: MetadataProcessRequest) => {
    const control = new Int32Array(request.control)
    let text: string
    let status: number = metadataSuccess
    if (request.args.join(' ') === '-axo pid=') text = pids.join('\n')
    else if (request.args.join(' ') === '-axo pid=,ppid=,pgid=,stat=,lstart=,comm=') text = pids.map((pid) => `${pid} 1 ${pid} S ${startedAt} /fixture/process-${pid}`).join('\n')
    else if (request.args.includes('-p')) {
      const asked = (request.args.at(-1) ?? '').split(',').map(Number)
      const selected = pids.filter((pid) => asked.includes(pid))
      if (selected.filter((pid) => pid !== process.pid).length > 2) {
        status = metadataFailure
        text = 'The metadata process exceeded its output limit.'
      } else text = selected.filter((pid) => pid !== 50_000_004).map((pid) => `${pid} 1 ${pid} S ${reused ? changedStart : startedAt} /fixture/process-${pid}`).join('\n')
    } else {
      status = metadataFailure
      text = 'The metadata process exceeded its output limit.'
    }
    const bytes = new TextEncoder().encode(text)
    new Uint8Array(request.output).set(bytes)
    Atomics.store(control, 1, status)
    Atomics.store(control, 2, bytes.length)
    Atomics.store(control, 0, metadataComplete)
    Atomics.notify(control, 0)
  })
}

if (process.argv[1]?.endsWith('/firefox-table-worker.ts') === true) installTableFixture()
