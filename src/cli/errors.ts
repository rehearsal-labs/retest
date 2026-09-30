/** An expected failure. The CLI prints its message on stderr and exits with 2. */
export class CliError extends Error {
  override readonly name: string = 'CliError'
}

/** A mistake in the command line. The CLI also points to the command's help. */
export class UsageError extends CliError {
  override readonly name: string = 'UsageError'
}
