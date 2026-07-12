import { describe, expect, it } from 'vitest'
import estimateMemory, {
    detectV8Layout,
    estimateMemoryDetailed,
} from './index.js'

const uncompressed = { layout: 'uncompressed' as const }
const compressed = { layout: 'compressed' as const }

describe('retained graph traversal', () => {
    it('terminates on a self-reference', () => {
        const value: { self?: unknown } = {}
        value.self = value
        expect(estimateMemory(value, uncompressed)).toBe(32)
    })

    it('charges a shared DAG node once', () => {
        const child = { value: 1 }
        const value = { left: child, right: child }
        expect(estimateMemory(value, uncompressed)).toBe(72)
    })

    it('composes across calls through a caller-owned WeakSet', () => {
        const seen = new WeakSet<object>()
        const child = { value: 1 }
        expect(estimateMemory(child, { ...uncompressed, seen })).toBe(32)
        expect(estimateMemory(child, { ...uncompressed, seen })).toBe(0)

        const left = { child }
        const right = { child }
        expect(estimateMemory(left, { ...uncompressed, seen })).toBe(32)
        expect(estimateMemory(right, { ...uncompressed, seen })).toBe(32)
    })

    it('walks Map and Set entries without forEach', () => {
        const child = { value: 1 }
        const map = new Map<unknown, unknown>([[child, child]])
        const set = new Set<unknown>([map, child])
        Object.defineProperty(map, 'forEach', { value: () => { throw new Error('not iterator based') } })
        Object.defineProperty(set, 'forEach', { value: () => { throw new Error('not iterator based') } })
        expect(() => estimateMemory(set, uncompressed)).not.toThrow()
    })

    it('does not invoke getters while inspecting own properties', () => {
        const value = Object.defineProperty({}, 'danger', {
            get: () => { throw new Error('getter ran') },
        })
        expect(() => estimateMemory(value, uncompressed)).not.toThrow()
    })
})

describe('V8 representations', () => {
    it('auto-detects the runtime layout and permits explicit profiles', () => {
        expect(['compressed', 'uncompressed']).toContain(detectV8Layout())
        expect(estimateMemory([], compressed)).toBe(16)
        expect(estimateMemory([], uncompressed)).toBe(32)
    })

    it('models tagged, double, and holey element stores', () => {
        const smis = [1, 2, 3, 4]
        const doubles = [1.5, 2.5, 3.5, 4.5]
        const holey = new Array(4)
        holey[3] = 1
        expect(estimateMemory(smis, compressed)).toBe(40)
        expect(estimateMemory(doubles, compressed)).toBe(56)
        expect(estimateMemory(holey, compressed)).toBe(40)
    })

    it('models sparse arrays with a NumberDictionary and walks only present elements', () => {
        const sparse: unknown[] = []
        sparse[100_000] = 1
        expect(estimateMemory(sparse, uncompressed)).toBe(176)
    })

    it('distinguishes one-byte and two-byte flat strings', () => {
        expect(estimateMemory('x'.repeat(16), compressed)).toBe(32)
        expect(estimateMemory('π'.repeat(16), compressed)).toBe(48)
    })

    it('matches the original string interning switch semantics', () => {
        const value = ['abcdefghij', 'abcdefghij']
        const full = estimateMemory(value, { ...uncompressed, countInternedStrings: false })
        const interned = estimateMemory(value, { ...uncompressed, countInternedStrings: true })
        expect(full - interned).toBe(32)
    })

    it('uses current OrderedHashMap and OrderedHashSet capacities', () => {
        expect(estimateMemory(new Map(Array.from({ length: 8 }, (_, i) => [i, i])), uncompressed))
            .toBe(296)
        expect(estimateMemory(new Set(Array.from({ length: 8 }, (_, i) => i)), uncompressed))
            .toBe(232)
    })

    it('offers explicit dictionary-property accounting', () => {
        const value: Record<string, number> = {}
        for (let index = 0; index < 10; index++) value[`key${index}`] = index
        delete value.key0
        const fast = estimateMemory(value, { ...uncompressed, objectMode: 'fast' })
        const dictionary = estimateMemory(value, { ...uncompressed, objectMode: 'dictionary' })
        expect(dictionary).toBeGreaterThan(fast * 5)
    })

    it('defaults wide parsed objects to fast-property accounting', () => {
        const source = Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [`key${index}`, index]),
        )
        const value = JSON.parse(JSON.stringify(source)) as object
        expect(estimateMemory(value, uncompressed)).toBe(264)
        expect(estimateMemory(value, { ...uncompressed, objectMode: 'dictionary' })).toBe(1624)
    })

    it('charges indexed elements separately from dictionary properties', () => {
        const source = Object.fromEntries([
            ...Array.from({ length: 30 }, (_, index) => [String(index), index] as const),
            ['a', 1],
            ['discard', 2],
        ])
        const value = JSON.parse(JSON.stringify(source)) as Record<string, number>
        delete value.discard
        expect(estimateMemory(value, { ...uncompressed, objectMode: 'dictionary' })).toBe(536)
    })

    it('counts a shared ArrayBuffer once across multiple views', () => {
        const buffer = new ArrayBuffer(64)
        const value = [new Uint8Array(buffer), new Uint16Array(buffer)]
        const detailed = estimateMemoryDetailed(value, uncompressed)
        expect(detailed.byCategory.arrayBuffers).toBe(160)
        expect(detailed.byCategory.typedArrays).toBe(208)
    })

    it('handles local, registered, and well-known symbols', () => {
        expect(estimateMemory(Symbol.for('shared'), uncompressed)).toBe(0)
        expect(estimateMemory(Symbol.iterator, uncompressed)).toBe(0)
        expect(estimateMemory(Symbol('local'), uncompressed)).toBe(48)
    })

    it('accounts for BigInts, boxed primitives, and shallow functions', () => {
        expect(estimateMemory(1n, uncompressed)).toBe(24)
        expect(estimateMemory(Object(1n), uncompressed)).toBe(56)
        expect(estimateMemory(Object(Symbol.for('shared')), uncompressed)).toBe(32)
        expect(estimateMemory(() => 1, uncompressed)).toBe(64)
    })
})

describe('detailed estimates', () => {
    it('sums every category to total', () => {
        const value = {
            array: [1, 2.5, 'three'],
            map: new Map([[1, { ok: true }]]),
            bytes: new Uint8Array(8),
        }
        const detailed = estimateMemoryDetailed(value, uncompressed)
        expect(Object.values(detailed.byCategory).reduce((sum, bytes) => sum + bytes, 0))
            .toBe(detailed.total)
        expect(detailed.byCategory.objects).toBeGreaterThan(0)
        expect(detailed.byCategory.arrays).toBeGreaterThan(0)
        expect(detailed.byCategory.collections).toBeGreaterThan(0)
        expect(detailed.byCategory.typedArrays).toBeGreaterThan(0)
    })
})
