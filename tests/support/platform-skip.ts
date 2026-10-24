// Some subjects exist on one family of systems only: a FIFO, a file mode that refuses reading, a POSIX process group,
// the macOS driver's tools, a Windows Job Object. A case about one is skipped by name where its subject does not
// exist, so the skip says why the case has nothing to check there. It is never a way to make a platform pass.

/**
 * The skip for a case whose subject does not exist on Windows, or false on macOS and Linux.
 *
 * @example test('a FIFO is refused', { skip: unixOnly('a Windows file system has no FIFOs') }, () => {})
 */
export function unixOnly(reason: string): string | false {
  return process.platform === 'win32' ? reason : false
}

/**
 * The skip for a case whose subject exists only on Windows, or false on Windows.
 *
 * @example test('the job ends the tree', { skip: windowsOnly('Job Objects exist only on Windows') }, () => {})
 */
export function windowsOnly(reason: string): string | false {
  return process.platform === 'win32' ? false : reason
}
