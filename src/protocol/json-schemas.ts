// The build writes these next to the compiled package. The URLs resolve from both src/protocol and
// dist/protocol, which sit at the same depth under the package root.

export const eventSchemaFileName = 'event-v1.schema.json'
export const resultSchemaFileName = 'result-v1.schema.json'

/** The JSON Schema of one line of `events.jsonl`, as a file URL inside the installed package. */
export const eventSchemaUrl: string = new URL(`../../dist/schemas/${eventSchemaFileName}`, import.meta.url).href

/** The JSON Schema of `result.json`, as a file URL inside the installed package. */
export const resultSchemaUrl: string = new URL(`../../dist/schemas/${resultSchemaFileName}`, import.meta.url).href
