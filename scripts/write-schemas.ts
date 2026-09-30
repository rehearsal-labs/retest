import { mkdir, writeFile } from 'node:fs/promises'
import { retestEventSchema } from '../src/protocol/events.ts'
import { runResultSchema } from '../src/protocol/result.ts'
import { toJsonSchema } from '../src/protocol/schema.ts'

const directory = new URL('../dist/schemas/', import.meta.url)
const schemas = {
  'event-v1.schema.json': retestEventSchema,
  'result-v1.schema.json': runResultSchema,
}

await mkdir(directory, { recursive: true })
for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(new URL(name, directory), `${JSON.stringify(toJsonSchema(schema), null, 2)}\n`)
}
