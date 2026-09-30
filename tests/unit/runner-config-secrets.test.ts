import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'

const variable = 'RETEST_UNIT_PASSWORD'
const password = 'hunter2-7391'
process.env[variable] = password
after(() => {
  delete process.env[variable]
})

const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'

let reads = 0

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: { password: env('${variable}'), code: () => \`otp-\${++reads}-5521\` },
  secretOrigins: { password: ['http://127.0.0.1:5000'] },
})
`

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('signs in', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('password').fill(secret('password'))
  await page.getByTestId('password').fill(secret('code'))
  await page.getByTestId('password').fill(secret('code'))
  console.log(\`the variable is \${process.env.${variable}}\`)
  await expect(page.getByTestId('typed-value')).toHaveText('nothing')
})

test('types on a listed origin', async ({ page }) => {
  await page.goto('http://127.0.0.1:5000/login')
  await page.getByTestId('password').fill(secret('password'))
  await expect(page.getByTestId('typed-value')).toHaveText(\`\${secret('password')}\`)
})

test('refuses another origin', async ({ page }) => {
  await page.goto('https://evil.example/login')
  await page.getByTestId('password').fill(secret('password'))
})
`

describe('secrets in a run', async () => {
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/sign-in.retest.ts': tests }), {
    files: ['tests/sign-in.retest.ts'],
    env: { [variable]: password },
  })
  const [signsIn, listed, refused] = record.result.files[0]?.tests ?? []
  const pages = record.browsers[0]?.pages ?? []

  test('the page types each value, labelled with its secret; a function source is read on every use', () => {
    assert.deepEqual(pages[0]?.typed.map(({ value, secret }) => [value, secret]), [
      [password, 'password'],
      ['otp-1-5521', 'code'],
      ['otp-2-5521', 'code'],
    ])
    assert.deepEqual(pages[1]?.typed.map(({ value, url }) => [value, url]), [[password, 'http://127.0.0.1:5000/login']])
  })

  test('a fill event names its secret, never the length or text of the value', () => {
    const fills = eventsOfType(record.events, 'action.completed').filter((event) => event.command === 'fill')
    assert.deepEqual(fills.map((event) => [event.secret, event.valueLength]), [
      ['password', undefined],
      ['code', undefined],
      ['code', undefined],
      ['password', undefined],
    ])
  })

  test('page text holding a value reaches the test process redacted', () => {
    assert.equal(signsIn?.failure?.class, 'check_failed')
    assert.match(signsIn?.failure?.message ?? '', /has text "\{\{code\}\}", expected "nothing"/)
    assert.equal(listed?.status, 'passed', 'the page showed the value, and the test compared its placeholder')
  })

  test('a page on an origin the secret does not belong to is refused, and nothing is typed', () => {
    assert.equal(refused?.failure?.class, 'not_actionable')
    assert.match(refused?.failure?.message ?? '', /the page is on https:\/\/evil\.example, and it may be typed only on http:\/\/127\.0\.0\.1:4173, http:\/\/127\.0\.0\.1:5000/)
    assert.deepEqual(pages[2]?.typed, [])
  })

  test('the test process never sees the variable a secret reads', () => {
    const log = record.output.map((chunk) => chunk.text).join('')
    assert.match(log, /the variable is undefined/)
  })

  test('no value is anywhere in the run folder: events, result, logs and artifacts', () => {
    const files = readdirSync(record.folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    assert.ok(files.length > 3)
    for (const file of files) {
      const text = readFileSync(join(file.parentPath, file.name), 'latin1')
      for (const value of [password, 'otp-1-5521', 'otp-2-5521']) assert.ok(!text.includes(value), `${file.name} holds ${value}`)
    }
    assert.ok(!record.output.some((chunk) => chunk.text.includes(password)))
  })
})

describe('a secret value that appears inside identifiers', () => {
  test('is hidden in free text and nowhere else: paths, ids, names and locators stay as they are', async () => {
    const value = 'xample'
    const root = tempProject({
      'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: { password: () => '${value}' },
})
`,
      'tests/example.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'
test.describe('xample block', () => {
  test('signs in as xample', async ({ page }) => {
    await page.goto('/xample')
    await page.getByTestId('password').fill(secret('password'))
    await expect(page.getByTestId('typed-value')).toHaveText('not xample')
  })
})
`,
    })
    const record = await runProject(root, { files: ['tests/example.retest.ts'] })
    const [result] = record.result.files[0]?.tests ?? []
    assert.deepEqual([record.result.files[0]?.file, result?.testId, result?.name, result?.describePath], [
      'tests/example.retest.ts',
      'tests/example.retest.ts > xample block > signs in as xample',
      'signs in as xample',
      ['xample block'],
    ])
    assert.equal(result?.failure?.location?.file, 'tests/example.retest.ts')
    assert.match(result?.failure?.message ?? '', /has text "\{\{password\}\}", expected "not \{\{password\}\}"/)
    const navigation = eventsOfType(record.events, 'navigation')[0]
    assert.equal(navigation?.url, 'http://127.0.0.1:4173/xample')
    const started = eventsOfType(record.events, 'test.started')[0]
    assert.deepEqual([started?.name, started?.file, started?.describePath], ['signs in as xample', 'tests/example.retest.ts', ['xample block']])
    assert.ok(record.lines.some((line) => line.includes('tests/example.retest.ts')))
  })
})

describe('a secret value too short to redact', () => {
  test('stops the run before any file loads, and the message never quotes it', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/sign-in.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/sign-in.retest.ts'], secrets: new Map([['password', { value: 'x9' }], ['code', { read: async () => 'long enough' }]]) })
    const problem = { class: 'setup_failed', message: 'The secret "password" is shorter than 4 characters, too short to redact safely. Use a longer value.' }
    assert.deepEqual([record.result.exitCode, record.result.failure], [2, problem])
    assert.equal(record.result.files[0]?.collection, 'failed')
    assert.equal(record.browsers.length, 0)
    assert.ok(!record.lines.some((line) => line.includes('x9')))
  })
})
