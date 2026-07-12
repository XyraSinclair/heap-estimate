import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare } from 'cyclebench'
import objectSizeofImport from 'object-sizeof'
import estimateMemory from '../dist/index.js'

const objectSizeof = typeof objectSizeofImport === 'function'
    ? objectSizeofImport
    : objectSizeofImport.default
const fixture = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    label: `record-${index}`,
    samples: Array.from({ length: 16 }, (_, offset) => index + offset + 0.5),
    lookup: new Map(Array.from({ length: 8 }, (_, offset) => [offset, index + offset])),
}))

const report = await compare({
    candidates: {
        heapEstimate: (value) => estimateMemory(value),
        objectSizeof: (value) => objectSizeof(value),
        stringifyLength: (value) => JSON.stringify(value).length,
    },
    inputs: [[fixture]],
    agree: false,
    timeMs: 750,
    warmupMs: 150,
})
report.print()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
writeFileSync(join(root, 'receipts', 'throughput.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    note: 'Different functions intentionally return different size metrics; agreement checking is disabled.',
    report,
}, null, 2)}\n`)
