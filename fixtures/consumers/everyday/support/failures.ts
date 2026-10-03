// Node's transformer prints the enum and the class below on more lines than they take here, so in what Node runs the
// throw sits on another line; a stack names this file's own line only through the source map.
export enum Reason {
  Broken = 'broken',
}

class Thrower {
  constructor(readonly reason: Reason) {}

  fail(): never {
    throw new Error(`failed on purpose: ${this.reason}`)
  }
}

export function failLoudly(): never {
  return new Thrower(Reason.Broken).fail()
}
