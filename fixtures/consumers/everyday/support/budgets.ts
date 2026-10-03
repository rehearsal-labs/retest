// Milliseconds, in a numeric enum, so the config itself needs Node's transformer to load.
export enum Budget {
  Action = 5000,
  Assertion = 3000,
  Test = 30_000,
}
