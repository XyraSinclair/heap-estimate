import { shapes } from './shapes.mjs'

const [shapeName, countText] = process.argv.slice(2)
const shape = shapes[shapeName]
if (shape === undefined) throw new RangeError(`unknown shape: ${shapeName}`)
if (typeof global.gc !== 'function') throw new Error('calibration requires --expose-gc')

const count = Number(countText)
let warmup = Array.from({ length: Math.min(2_000, count) }, (_, index) => shape.make(index))
warmup = undefined
for (let pass = 0; pass < 5; pass++) global.gc()

// Allocate the root references before the baseline. Filling a hole changes
// only a slot already present in this exact-sized backing store, so the delta
// is the retained allocation of the instances rather than their root array.
const roots = new Array(count)
for (let pass = 0; pass < 5; pass++) global.gc()
const before = process.memoryUsage()

for (let index = 0; index < count; index++) roots[index] = shape.make(index + 10_000)
for (let pass = 0; pass < 5; pass++) global.gc()
const after = process.memoryUsage()

// Keep the graph observably live through both snapshots.
if (roots.length !== count || roots[count - 1] === undefined) throw new Error('allocation escaped')

const heapDelta = after.heapUsed - before.heapUsed
const arrayBufferDelta = after.arrayBuffers - before.arrayBuffers
process.stdout.write(JSON.stringify({
    shape: shapeName,
    count,
    heapDelta,
    arrayBufferDelta,
    bytesPerInstance: (heapDelta + arrayBufferDelta) / count,
}))
