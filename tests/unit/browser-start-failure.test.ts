import type { SandboxSystem } from '../../src/browser/sandbox-system.ts'
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

// Ubuntu 24.04 as it ships: the restriction on, and a shell, so Retest and the browser it starts, unconfined.
const ubuntu: SandboxSystem = { userNamespaceRestriction: '1', appArmorLabel: 'unconfined', container: false }
const unreadable: SandboxSystem = { userNamespaceRestriction: undefined, appArmorLabel: undefined, container: false }

// Where `retest install chromium` puts Chrome for Testing for the user `runner`, as on GitHub's ubuntu-24.04 runner.
const installed = '/home/runner/.cache/retest/browsers/chromium-153.0.8010.12-linux-x64/build/chrome-linux64/chrome'
const profileFile = '/etc/apparmor.d/home.runner..cache.retest.browsers.chromium-153.0.8010.12-linux-x64.build.chrome-linux64.chrome'
const appArmorCause =
  "Chrome's sandbox could not start, because this system lets a program create user namespaces only when an AppArmor profile allows it, as Ubuntu 23.10 and later do. Retest keeps the sandbox on, so give the browser a profile that allows them"

describe('explainStartFailure', () => {
  test('where AppArmor decides, the sandbox cause gives the commands that write and load a profile for the browser', () => {
    const explained = explainStartFailure(debianWithoutSandbox, { executable: installed, file: installed, system: ubuntu })
    assert.deepEqual(explained, {
      text: `${appArmorCause}: the two commands below write one for ${installed} and load it.`,
      commands: [
        `printf '%s\\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' '${installed} flags=(unconfined) {' '  userns,' '}' | sudo tee ${profileFile} > /dev/null`,
        `sudo apparmor_parser -r ${profileFile}`,
      ],
    })
    assert.equal(explainStartFailure(chromeSetuidHelperRefused, { executable: installed, file: installed, system: ubuntu })?.text, explained?.text)
    assert.doesNotMatch(JSON.stringify(explained), /--no-sandbox/)
  })

  test('a browser started through a link gets a profile for the file the link leads to, which is the path AppArmor names', () => {
    const explained = explainStartFailure(debianWithoutSandbox, { executable: '/usr/local/bin/chrome', file: installed, system: ubuntu })
    assert.equal(explained?.text, `${appArmorCause}: the two commands below write one for ${installed}, the file /usr/local/bin/chrome links to, and load it.`)
    assert.equal(explained?.commands[1], `sudo apparmor_parser -r ${profileFile}`)
  })

  test('a path a profile would read as a pattern, or one AppArmor would not load a profile file named after, gets the fix in words and no commands', () => {
    const paths = [
      '/home/ada/My Browsers/chrome',
      "/home/ada/ada's/chrome",
      '/opt/chrome-[1]/chrome',
      '/opt/{a,b}/chrome',
      '/opt/@{HOME}/chrome',
      `/opt/${'b'.repeat(256)}/chrome`,
      // AppArmor's loader passes over these profile files when it loads /etc/apparmor.d at boot.
      '/.hidden/chrome',
      '/opt/chrome/chrome.orig',
      '/opt/chrome/chrome.dpkg-new',
    ]
    for (const file of paths) {
      const explained = explainStartFailure(debianWithoutSandbox, { executable: file, file, system: ubuntu })
      assert.deepEqual(explained, {
        text: `${appArmorCause}. Retest gives the commands only for a path it can write into a profile and a file name as it is, so write a profile for ${file} by hand: one that names that path and holds the rule "userns,". Load it with sudo apparmor_parser -r.`,
        commands: [],
      }, file)
    }
  })

  test('a path of letters, digits and . _ + @ - is written into the profile and the commands as it is', () => {
    const file = '/home/ada@example/.local/chrome+1/chrome_test-2'
    const explained = explainStartFailure(debianWithoutSandbox, { executable: file, file, system: ubuntu })
    assert.equal(explained?.commands[1], 'sudo apparmor_parser -r /etc/apparmor.d/home.ada@example..local.chrome+1.chrome_test-2')
    assert.match(explained?.commands[0] ?? '', / '\/home\/ada@example\/\.local\/chrome\+1\/chrome_test-2 flags=\(unconfined\) \{' /)
  })

  test('in a container the advice stays the seccomp profile, even on a host that restricts user namespaces', () => {
    for (const system of [
      { userNamespaceRestriction: '1', appArmorLabel: 'docker-default (enforce)', container: true },
      { userNamespaceRestriction: '1', appArmorLabel: 'unconfined', container: true },
    ]) {
      assert.deepEqual(explainStartFailure(debianWithoutSandbox, { executable: installed, file: installed, system }), { text: sandboxCause, commands: [] }, JSON.stringify(system))
    }
  })

  test('where AppArmor does not decide, or Retest cannot read whether it does, the cause names both ways and gives no commands', () => {
    for (const system of [
      unreadable,
      { ...ubuntu, userNamespaceRestriction: '0' },
      { ...ubuntu, appArmorLabel: undefined },
      // A confined Retest starts a browser that its own profile decides for, not the restriction.
      { ...ubuntu, appArmorLabel: 'snap.code.code (enforce)' },
      { ...ubuntu, appArmorLabel: 'vscode (unconfined)' },
    ]) {
      assert.deepEqual(explainStartFailure(debianWithoutSandbox, { executable: installed, file: installed, system }), { text: sandboxCause, commands: [] }, JSON.stringify(system))
      assert.deepEqual(explainStartFailure(chromeSetuidHelperRefused, { executable: installed, file: installed, system }), { text: sandboxCause, commands: [] }, JSON.stringify(system))
    }
    assert.doesNotMatch(sandboxCause, /--no-sandbox/)
  })

  test('a browser started as root is told to run as another user, wherever it runs', () => {
    for (const system of [ubuntu, unreadable]) {
      assert.deepEqual(explainStartFailure(asRoot, { executable: installed, file: installed, system }), {
        text: 'Chrome does not start its sandbox as root, and Retest keeps the sandbox on. Run Retest as a user other than root.',
        commands: [],
      })
    }
  })

  test('a missing system library is named, wherever it runs', () => {
    for (const system of [ubuntu, unreadable]) {
      assert.deepEqual(explainStartFailure(missingLibrary, { executable: installed, file: installed, system }), {
        text: 'The browser cannot load the system library libnss3.so. Install the system libraries the browser needs.',
        commands: [],
      })
    }
  })

  test('output that names no cause Chrome states has no explanation', () => {
    for (const output of ['', 'hello\n', '[1:1:0930/170743.1:ERROR:gpu/command_buffer/service/shared_image.cc:1] something else\n']) {
      assert.equal(explainStartFailure(output, { executable: installed, file: installed, system: ubuntu }), undefined, output)
    }
  })
})
