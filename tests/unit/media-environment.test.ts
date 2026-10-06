import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MediaProcess } from '../../src/media/client.ts'
import { tempProject } from '../support/project.ts'
import { fakeMediaStarter, recordProject } from './runner-recording-fakes.ts'

test('an explicit media environment excludes a synthetic parent judge variable in the actual child', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-media-env-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const name = 'RETEST_SYNTHETIC_MEDIA_JUDGE_KEY'
  const previous = process.env[name]
  process.env[name] = 'synthetic-fixture-value'
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  const executable = join(folder, 'media.mjs')
  const marker = join(folder, 'environment.json')
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({judgePresent:Object.hasOwn(process.env,${JSON.stringify(name)}), path:process.env.PATH}));
function send(value){const head=Buffer.from(JSON.stringify(value));const prefix=Buffer.alloc(8);prefix.writeUInt32BE(head.length);process.stdout.write(Buffer.concat([prefix,head]));}
send({type:'hello',protocol:2,version:'0.1.0',build:{target:'aarch64-apple-darwin',profile:'release'},ffmpeg:'/fake/ffmpeg',encoder:{state:'probing'}});
process.stdin.once('data',()=>{send({type:'bye',stopped:0});process.stdin.pause();});
process.stdin.resume();\n`, { mode: 0o755 })
  const options = { executable, startTimeoutMs: 5000, env: { PATH: '/usr/bin:/bin' } }
  const media = await MediaProcess.start(options)
  try {
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { judgePresent: false, path: '/usr/bin:/bin' })
  } finally {
    const closed = await media.close(5000)
    assert.equal(closed.forced, false)
    assert.equal(closed.code, 0)
  }
})

test('the recording runner carries its judge exclusion into media startup', async t => {
  const name = 'RETEST_SYNTHETIC_MEDIA_JUDGE_KEY'
  const previous = process.env[name]
  process.env[name] = 'synthetic-fixture-value'
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  const root = tempProject({
    'retest.config.ts': `import {chromium,defineConfig,env} from '@rehearsal-labs/retest';export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true},evaluation:{judges:{review:{adapter:${JSON.stringify(join(process.cwd(), 'tests/support/fake-evaluator.ts'))},accepts:['text'],credentials:{apiKey:env('${name}')}}}}})`,
    'tests/one.retest.ts': `import {expect,test} from '@rehearsal-labs/retest';test('one',async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})`,
  })
  const fake = fakeMediaStarter()
  let environment: Readonly<Record<string, string | undefined>> | undefined
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: async (location, timeoutMs, env) => {
    environment = env
    return fake.start(location, timeoutMs)
  } })
  assert.equal(run.result.files[0]?.tests[0]?.status, 'passed')
  assert.ok(environment, 'media startup must receive an explicit environment')
  assert.equal(Object.hasOwn(environment, name), false)
  assert.equal(environment['PATH'], process.env['PATH'])
})
