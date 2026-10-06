/** An executable's command line, rather than another process mentioning its name in an argument. */
export function processesRunningExecutable<T extends { readonly command: string }>(entries: readonly T[], executable: string): T[] {
  return entries.filter((entry) => entry.command === executable || entry.command.startsWith(`${executable} `))
}
