import { appendFileSync } from 'node:fs'
import { expect, test } from 'retest'

// Tells the signals server each time it is loaded, collection's load included, so a test can tell when a run loaded it
// ahead of its turn. With SIGNALS_FAIL_LATER it fails every load after the first, as a file that loads to be collected
// and then fails to load to run.
const { SIGNALS_URL, SIGNALS_ORDER, SIGNALS_FAIL_LATER } = process.env
if (SIGNALS_ORDER !== undefined) appendFileSync(SIGNALS_ORDER, `loaded ${process.pid}\n`)
console.log(`loading ahead-signals in ${process.pid}`)
const loads = Number(await (await fetch(`${SIGNALS_URL}/load?pid=${process.pid}`)).text())
if (SIGNALS_FAIL_LATER === '1' && loads > 1) throw new Error('This file fails each time it loads after the first.')

test('was loaded to run', () => {
  expect(loads > 1).toBe(true)
})
