import { mkdir, writeFile } from 'node:fs/promises'
import { retestEventSchema } from '../src/protocol/events.ts'
import { eventSchemaFileName, resultSchemaFileName } from '../src/protocol/json-schemas.ts'
import { runResultSchema } from '../src/protocol/result.ts'
import { toJsonSchema } from '../src/protocol/schema.ts'

const directory = new URL('../dist/schemas/', import.meta.url)
const schemas = {
  [eventSchemaFileName]: retestEventSchema,
  [resultSchemaFileName]: runResultSchema,
}

await mkdir(directory, { recursive: true })
for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(new URL(name, directory), `${JSON.stringify(toJsonSchema(schema), null, 2)}\n`)
}
