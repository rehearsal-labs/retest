import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { explainStartFailure } from '../../src/browser/start-failure.ts'

// What Chromium 154 and Google Chrome 154 printed in a Linux container, word for word, before they stopped.
const debianWithoutSandbox =
  '[36:36:0930/170743.193801:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If this is a Debian system, please install the chromium-sandbox package to solve this problem. If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.\n'
const chromeSetuidHelperRefused = [
  '[0930/170743.491672:WARNING:chrome/app/chrome_main_linux.cc:84] Read channel stable from /opt/google/chrome/CHROME_VERSION_EXTRA',
  'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
  '[83:83:0930/170743.497256:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:213] Zygote process exited prematurely with exit code 1',
  '',
].join('\n')
const asRoot =
  '[10:10:0930/170755.163753:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.\n'
const missingLibrary =
  '/usr/lib/chromium/chromium: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory\n'

const sandboxCause =
  "Chrome's sandbox could not start, because this system does not let the browser create user namespaces. Retest keeps the sandbox on, so allow them: in Docker, with a seccomp profile that permits them; on Ubuntu 23.10 or later, with an AppArmor profile for the browser."

describe('explainStartFailure', () => {
  test('a sandbox refused user namespaces names the cause and how to allow them, never --no-sandbox', () => {
    assert.equal(explainStartFailure(debianWithoutSandbox), sandboxCause)
    assert.equal(explainStartFailure(chromeSetuidHelperRefused), sandboxCause)
    assert.doesNotMatch(sandboxCause, /--no-sandbox/)
  })

  test('a browser started as root is told to run as another user', () => {
    assert.equal(
      explainStartFailure(asRoot),
      'Chrome does not start its sandbox as root, and Retest keeps the sandbox on. Run Retest as a user other than root.',
    )
  })

  test('a missing system library is named', () => {
    assert.equal(explainStartFailure(missingLibrary), 'The browser cannot load the system library libnss3.so. Install the system libraries the browser needs.')
  })

  test('output that names no cause Chrome states has no explanation', () => {
    for (const output of ['', 'hello\n', '[1:1:0930/170743.1:ERROR:gpu/command_buffer/service/shared_image.cc:1] something else\n']) {
      assert.equal(explainStartFailure(output), undefined, output)
    }
  })
})
