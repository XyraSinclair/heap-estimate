import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import objectSizeofImport from 'object-sizeof'
import estimateMemory, { detectV8Layout } from '../dist/index.js'
import { reducedShapeNames, shapes } from './shapes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = new Set(process.argv.slice(2))
const reduced = args.has('--reduced')
const gate = args.has('--gate')
const writeReadme = args.has('--write-readme')
const runs = reduced ? 3 : 7
const shapeNames = reduced ? reducedShapeNames : Object.keys(shapes)
const objectSizeof = typeof objectSizeofImport === 'function'
    ? objectSizeofImport
    : objectSizeofImport.default

function median(values) {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
}

function errorPercent(estimate, measured) {
    return Math.abs(estimate - measured) / measured * 100
}

function signedErrorPercent(estimate, measured) {
    return (estimate - measured) / measured * 100
}

function formatBytes(bytes) {
    return bytes.toFixed(1)
}

function formatError(error) {
    const prefix = error >= 0 ? '+' : ''
    return `${prefix}${error.toFixed(1)}%`
}

const rows = []
for (const shapeName of shapeNames) {
    const shape = shapes[shapeName]
    const count = reduced ? Math.max(5_000, Math.floor(shape.count / 2)) : shape.count
    const samples = []
    for (let run = 0; run < runs; run++) {
        const output = execFileSync(process.execPath, [
            '--expose-gc',
            '--max-old-space-size=2048',
            join(here, 'calibrate-worker.mjs'),
            shapeName,
            String(count),
        ], { encoding: 'utf8' })
        samples.push(JSON.parse(output).bytesPerInstance)
    }
    const measured = median(samples)
    const example = shape.make(1)
    const estimate = estimateMemory(example, shape.estimateOptions)
    const incumbent = objectSizeof(example)
    rows.push({
        shape: shapeName,
        family: shape.family,
        estimateOptions: shape.estimateOptions ?? {},
        count,
        samples,
        measured,
        estimate,
        objectSizeof: incumbent,
        errorPercent: signedErrorPercent(estimate, measured),
        absoluteErrorPercent: errorPercent(estimate, measured),
        objectSizeofErrorPercent: signedErrorPercent(incumbent, measured),
    })
    process.stdout.write(`${shapeName.padEnd(27)} measured ${formatBytes(measured).padStart(8)} B  ` +
        `estimate ${formatBytes(estimate).padStart(8)} B  error ${formatError(rows.at(-1).errorPercent)}\n`)
}

const receipt = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    layout: detectV8Layout(),
    runs,
    method: 'median of isolated child processes after five forced GCs; root backing store allocated before baseline',
    rows,
}

const table = [
    '| shape | measured B/instance | heap-estimate | object-sizeof | ours error | theirs error |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.shape} | ${formatBytes(row.measured)} | ${formatBytes(row.estimate)} | ` +
        `${formatBytes(row.objectSizeof)} | ${formatError(row.errorPercent)} | ` +
        `${formatError(row.objectSizeofErrorPercent)} |`),
].join('\n')

if (!reduced) {
    writeFileSync(join(root, 'receipts', 'calibration.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (writeReadme) {
    const readmePath = join(root, 'README.md')
    const readme = readFileSync(readmePath, 'utf8')
    const metadata = `Node ${receipt.node.slice(1)} / V8 ${receipt.v8}, ${receipt.platform}-${receipt.arch}, ` +
        `${receipt.layout} tagged pointers; ${runs} isolated runs per row.`
    const replacement = `<!-- calibration:start -->\n${metadata}\n\n${table}\n<!-- calibration:end -->`
    const updated = readme.replace(
        /<!-- calibration:start -->[\s\S]*?<!-- calibration:end -->/,
        replacement,
    )
    if (updated === readme) throw new Error('README calibration markers not found')
    writeFileSync(readmePath, updated)
}

if (gate) {
    const failures = rows.filter((row) => row.absoluteErrorPercent > 15)
    if (failures.length > 0) {
        process.stderr.write(`accuracy gate failed (>15%): ${failures.map((row) => row.shape).join(', ')}\n`)
        process.exitCode = 1
    } else {
        process.stdout.write('accuracy gate passed: every reduced calibration family is within 15%\n')
    }
}
