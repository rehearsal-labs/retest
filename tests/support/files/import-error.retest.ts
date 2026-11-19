import { test } from 'retest'

const missing = './no-such-helper.ts'
await import(missing)

test('never collected', () => {})
