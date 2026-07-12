function literalObject(keys, seed) {
    switch (keys) {
        case 0: return {}
        case 4: return { a: seed, b: seed + 1, c: seed + 2, d: seed + 3 }
        case 16: return {
            a: seed, b: seed + 1, c: seed + 2, d: seed + 3,
            e: seed + 4, f: seed + 5, g: seed + 6, h: seed + 7,
            i: seed + 8, j: seed + 9, k: seed + 10, l: seed + 11,
            m: seed + 12, n: seed + 13, o: seed + 14, p: seed + 15,
        }
        default: throw new RangeError(`unsupported literal width: ${keys}`)
    }
}

function uniqueFlatString(index, length, twoByte) {
    const prefix = index.toString(36).padStart(8, '0')
    const fill = twoByte ? 'π' : 'x'
    const text = prefix + fill.repeat(Math.max(0, length - prefix.length))
    // JSON.parse materializes a flat sequential string; concatenation alone
    // would deliberately create a ConsString and test a different question.
    return JSON.parse(JSON.stringify(text))
}

function tree(depth, seed) {
    if (depth === 0) return { value: seed }
    return {
        value: seed,
        left: tree(depth - 1, seed * 2 + 1),
        right: tree(depth - 1, seed * 2 + 2),
    }
}

const wideParsedJson = JSON.stringify(Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`key${index}`, index]),
))
const indexedDictionaryJson = JSON.stringify(Object.fromEntries([
    ...Array.from({ length: 30 }, (_, index) => [String(index), index]),
    ['a', 1],
    ['discard', 2],
]))

export const shapes = {
    'object/0-keys': {
        family: 'plain object',
        count: 80_000,
        make: (index) => literalObject(0, index),
    },
    'object/4-keys': {
        family: 'plain object',
        count: 60_000,
        make: (index) => literalObject(4, index),
    },
    'object/16-keys': {
        family: 'plain object',
        count: 25_000,
        make: (index) => literalObject(16, index),
    },
    'object/json-30-keys-auto': {
        family: 'wide parsed object',
        count: 25_000,
        make: (index) => {
            const value = JSON.parse(wideParsedJson)
            value.key0 = index
            return value
        },
    },
    'object/dictionary-indexed-30': {
        family: 'dictionary object with elements',
        count: 20_000,
        estimateOptions: { objectMode: 'dictionary' },
        make: (index) => {
            const value = JSON.parse(indexedDictionaryJson)
            delete value.discard
            value.a = index
            return value
        },
    },
    'array/packed-smi-32': {
        family: 'array',
        count: 35_000,
        make: (index) => Array.from({ length: 32 }, (_, offset) => index + offset),
    },
    'array/packed-double-32': {
        family: 'array',
        count: 25_000,
        make: (index) => Array.from({ length: 32 }, (_, offset) => index + offset + 0.5),
    },
    'array/holey-smi-32': {
        family: 'array',
        count: 35_000,
        make: (index) => {
            const value = new Array(32)
            value[31] = index
            return value
        },
    },
    'array/sparse-smi-100k': {
        family: 'sparse array',
        count: 25_000,
        make: (index) => {
            const value = []
            value[100_000] = index
            return value
        },
    },
    'array/objects-8': {
        family: 'array',
        count: 20_000,
        make: (index) => Array.from({ length: 8 }, (_, offset) => ({ value: index + offset })),
    },
    'string/one-byte-64': {
        family: 'string',
        count: 60_000,
        make: (index) => uniqueFlatString(index, 64, false),
    },
    'string/two-byte-64': {
        family: 'string',
        count: 45_000,
        make: (index) => uniqueFlatString(index, 64, true),
    },
    'string/boxed-one-byte-3': {
        family: 'boxed string',
        count: 20_000,
        make: (index) => Object(JSON.parse(JSON.stringify(
            index.toString(36).padStart(3, '0'),
        ))),
    },
    'map/8-smi-pairs': {
        family: 'Map',
        count: 20_000,
        make: (index) => new Map(Array.from({ length: 8 }, (_, offset) => [
            index * 16 + offset,
            index * 16 + offset + 8,
        ])),
    },
    'map/32-smi-pairs': {
        family: 'Map',
        count: 8_000,
        make: (index) => new Map(Array.from({ length: 32 }, (_, offset) => [
            index * 64 + offset,
            index * 64 + offset + 32,
        ])),
    },
    'set/8-smis': {
        family: 'Set',
        count: 20_000,
        make: (index) => new Set(Array.from({ length: 8 }, (_, offset) => index * 8 + offset)),
    },
    'set/32-smis': {
        family: 'Set',
        count: 8_000,
        make: (index) => new Set(Array.from({ length: 32 }, (_, offset) => index * 32 + offset)),
    },
    'tree/binary-depth-3': {
        family: 'nested tree',
        count: 8_000,
        make: (index) => tree(3, index),
    },
    'array-buffer/256': {
        family: 'ArrayBuffer',
        count: 20_000,
        make: () => new ArrayBuffer(256),
    },
    'typed-array/u8-256': {
        family: 'typed array',
        count: 18_000,
        make: () => new Uint8Array(256),
    },
}

export const reducedShapeNames = [
    'object/4-keys',
    'object/json-30-keys-auto',
    'object/dictionary-indexed-30',
    'array/packed-smi-32',
    'array/packed-double-32',
    'array/holey-smi-32',
    'array/sparse-smi-100k',
    'string/one-byte-64',
    'string/two-byte-64',
    'string/boxed-one-byte-3',
    'map/8-smi-pairs',
    'set/8-smis',
    'tree/binary-depth-3',
]
