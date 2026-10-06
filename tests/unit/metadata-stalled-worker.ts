import { parentPort } from 'node:worker_threads'

// A metadata worker that takes every query and answers none, as a worker starved under load does.
parentPort?.on('message', () => undefined)
