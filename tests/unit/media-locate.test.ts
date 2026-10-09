import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ffmpegLicence, ffmpegRoutes, mediaDoctorRows } from '../../src/cli/install/media-doctor.ts'
import { mediaFolder } from '../../src/cli/install/media-record.ts'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'
import { locateFfmpeg, locateMedia } from '../../src/media/locate.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'

test('ffmpeg settings take precedence over the variable and PATH, and a missing explicit setting refuses', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ffmpeg-')); t.after(() => rm(folder, { recursive: true, force: true }))
  const path = join(folder, 'ffmpeg'); await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = { PATH: folder, RETEST_FFMPEG: '/missing-variable' }
  assert.equal((await locateFfmpeg({ ffmpeg: path, env })).ok, true)
  assert.equal((await locateFfmpeg({ ffmpeg: '/missing-setting', env })).ok, false)
  assert.equal((await locateFfmpeg({ env })).ok, false)
  assert.deepEqual(await locateFfmpeg({ env: { PATH: folder } }), { ok: true, path, source: 'PATH' })
})

test('missing media names the explicit install; an empty explicit path cannot use a cache or Cargo target folder', { skip: unpinnedMedia }, async () => {
  const absent = await locateMedia({ env: { PATH: '', HOME: '/nonexistent-media-home' } })
  assert.equal(absent.ok, false)
  if (!absent.ok) assert.match(absent.message, /install media.*Cargo target folders/)
  const empty = await locateMedia({ executable: '', env: { RETEST_MEDIA_BINARY: '/media/target/release/retest-media' } })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.message, /explicit media setting/)
})

test('doctor names raw input, both codec and muxer routes, and encoded image prerequisites from exact columns', () => {
  const routes = ffmpegRoutes(' V....D libx264 name\n V....D libvpx name\n A..... png wrong\n', ' DE rawvideo raw\n  E mp4 MP4\n  E webm WebM\n D  image2pipe images\n', ' V....D png name\n V....D mjpeg name\n')
  assert.match(routes, /rawvideo demuxer present/)
  assert.match(routes, /libx264 encoder present and mp4 muxer present/)
  assert.match(routes, /libvpx encoder present and webm muxer present/)
  assert.match(routes, /image2pipe demuxer present.*PNG decoder present.*JPEG mjpeg decoder present/)
  assert.match(ffmpegRoutes(' libx264 legend only', 'webm description only', ''), /libx264 encoder missing.*webm muxer missing/)
  assert.match(ffmpegLicence('configuration: --enable-gpl\nffmpeg is free software; you can redistribute it and/or modify\nit under the terms of the GNU General Public License as published by\nthe Free Software Foundation; either version 3 of the License, or\n(at your option) any later version.\n\nWITHOUT ANY WARRANTY'), /GNU General Public License.*version 3.*later version/)
  assert.equal(ffmpegLicence('configuration: --enable-nonfree'), '')
})

test('doctor names both Rust minima and host ffmpeg with accepted fixes when recording tools are missing', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-media-doctor-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const rows = await mediaDoctorRows({ HOME: folder, PATH: '' }, new AbortController().signal)
  assert.deepEqual(rows.map((row) => row.subject), ['retest-media', 'cargo', 'rustc', 'ffmpeg'])
  assert.ok(rows.every((row) => !row.ok))
  for (const name of ['cargo', 'rustc']) {
    const row = rows.find((candidate) => candidate.subject === name) ?? assert.fail(name)
    assert.match(row.text, /Edition 2024 needs Rust 1.85 or later.*crate needs Rust 1.88.0 or later/)
    assert.match(row.fix ?? '', /Install Rust 1.88.0 or later.*install media/)
  }
  assert.match(rows.find((row) => row.subject === 'ffmpeg')?.text ?? '', /declared recording prerequisite/)
  assert.match(rows.find((row) => row.subject === 'ffmpeg')?.fix ?? '', /brew install ffmpeg.*sudo apt-get install ffmpeg/)
})


test('discovery resolves executable and ffmpeg without launching the executable', { skip: unpinnedMedia }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-media-discover-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const executable = join(folder, 'retest-media')
  const marker = join(folder, 'probe-started')
  await writeFile(executable, `#!/bin/sh\nprintf probe > "${marker}"\nexit 1\n`, { mode: 0o755 })
  const ffmpeg = join(folder, 'ffmpeg')
  await writeFile(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const found = await locateMedia({ executable, ffmpeg, env: { HOME: folder, PATH: '' }, mode: 'discover' })
  assert.ok(found.ok, found.ok ? '' : found.message)
  assert.equal(found.executable, executable)
  assert.equal(found.ffmpeg, ffmpeg)
  assert.equal(found.source, 'setting')
  assert.equal('hello' in found, false)
  await assert.rejects(access(marker), { code: 'ENOENT' })
})

test('discovery refuses a damaged checked cache by name without probing it', { skip: unpinnedMedia }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'retest-media-cache-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { HOME: home, PATH: '' }
  const folder = mediaFolder(env, mediaTarget() ?? assert.fail('host media target')) ?? assert.fail('cache folder')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'build.json'), '{')
  const found = await locateMedia({ env, mode: 'discover' })
  assert.ok(!found.ok)
  assert.match(found.message, /not JSON/)
  assert.ok(found.message.includes(folder))
})
