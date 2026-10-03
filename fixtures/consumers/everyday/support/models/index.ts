// A namespace with values, which type stripping alone cannot load.
export namespace Priority {
  export const high = 'high'
  export function describe(priority: string): string {
    return `priority ${priority}`
  }
}
