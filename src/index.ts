import { align8, detectV8Layout, LAYOUTS } from './layout.js'
import type { LayoutConstants, V8Layout } from './layout.js'

export type { V8Layout } from './layout.js'
export { detectV8Layout } from './layout.js'

export type ObjectMode = 'auto' | 'fast' | 'dictionary'

export interface EstimateMemoryOptions {
    /**
     * Match the original estimator's interning switch. False (the default)
     * charges every string occurrence as an independent flat string. True
     * assumes equal string values share storage and charges each distinct
     * string value once per call.
     */
    countInternedStrings?: boolean
    /** Objects already charged by a surrounding retained-graph estimate. */
    seen?: WeakSet<object>
    /** V8 tagged-pointer layout. Auto-detected by default. */
    layout?: V8Layout | 'auto'
    /**
     * V8 does not expose fast-vs-dictionary properties to JavaScript. Auto
     * uses fast-property accounting because construction history is
     * unobservable; override when assignment or deletion caused dictionary
     * mode.
     */
    objectMode?: ObjectMode
}

export interface MemoryBreakdown {
    objects: number
    arrays: number
    strings: number
    collections: number
    numbers: number
    bigints: number
    symbols: number
    functions: number
    arrayBuffers: number
    typedArrays: number
    other: number
}

export interface DetailedMemoryEstimate {
    total: number
    byCategory: MemoryBreakdown
    layout: V8Layout
}

const objectPrototype = Object.prototype
const nullPrototype = null
const arrayIndexPattern = /^(?:0|[1-9]\d*)$/
const bigintPrototype = Object.getPrototypeOf(Object(0n)) as object
const symbolPrototype = Object.getPrototypeOf(Object(Symbol())) as object
const symbolConstructor = Symbol as SymbolConstructor & {
    readonly dispose?: symbol
    readonly asyncDispose?: symbol
}
const wellKnownSymbols = new Set<symbol>([
    Symbol.asyncIterator,
    Symbol.hasInstance,
    Symbol.isConcatSpreadable,
    Symbol.iterator,
    Symbol.match,
    Symbol.matchAll,
    Symbol.replace,
    Symbol.search,
    Symbol.species,
    Symbol.split,
    Symbol.toPrimitive,
    Symbol.toStringTag,
    Symbol.unscopables,
])
if (symbolConstructor.dispose !== undefined) wellKnownSymbols.add(symbolConstructor.dispose)
if (symbolConstructor.asyncDispose !== undefined) {
    wellKnownSymbols.add(symbolConstructor.asyncDispose)
}

function nextPowerOfTwo(value: number): number {
    let power = 1
    while (power < value) power *= 2
    return power
}

function isArrayIndex(key: PropertyKey): key is string {
    if (typeof key !== 'string' || !arrayIndexPattern.test(key)) return false
    const index = Number(key)
    return index >= 0 && index < 0xffff_ffff && Number.isSafeInteger(index)
}

function isSmi(value: number, layout: V8Layout): boolean {
    if (!Number.isInteger(value) || Object.is(value, -0)) return false
    const limit = layout === 'compressed' ? 0x4000_0000 : 0x8000_0000
    return value >= -limit && value < limit
}

function isOneByteString(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) > 0xff) return false
    }
    return true
}

function flatStringSize(value: string, constants: LayoutConstants): number {
    const width = isOneByteString(value) ? 1 : 2
    return align8(constants.stringHeader + value.length * width)
}

function orderedHashTableSize(
    entries: number,
    kind: 'map' | 'set',
    constants: LayoutConstants,
): number {
    const minimumCapacity = kind === 'map' ? 4 : 8
    const capacity = nextPowerOfTwo(Math.max(minimumCapacity, entries))
    const entryWidth = kind === 'map' ? 3 : 2
    // OrderedHashTable prefix: element count, deleted count, bucket count;
    // then capacity/2 buckets and capacity fixed-width entries.
    const slots = 3 + capacity / 2 + capacity * entryWidth
    return align8(constants.fixedArrayHeader + slots * constants.taggedSlot)
}

function propertyStoreSize(count: number, constants: LayoutConstants): number {
    if (count === 0) return 0
    return align8(constants.fixedArrayHeader + count * constants.taggedSlot)
}

function dictionaryCapacity(entries: number): number {
    if (entries <= 2) return 8
    if (entries <= 8) return 16
    if (entries <= 22) return 32
    if (entries <= 48) return 64
    return nextPowerOfTwo(Math.ceil(entries * 1.5))
}

function dictionaryObjectSize(entries: number, constants: LayoutConstants): number {
    const capacity = dictionaryCapacity(entries)
    // NameDictionary has six prefix slots and three slots per bucket.
    const dictionary = align8(
        constants.fixedArrayHeader + (6 + capacity * 3) * constants.taggedSlot,
    )
    return constants.objectHeader + dictionary
}

function numberDictionarySize(indexedProperties: number, constants: LayoutConstants): number {
    const capacity = nextPowerOfTwo(Math.max(4, Math.ceil(indexedProperties * 1.5)))
    // NumberDictionary has four prefix slots and three slots per bucket.
    return align8(constants.fixedArrayHeader + (4 + capacity * 3) * constants.taggedSlot)
}

/* Plain-object elements path only: objects have no length/preallocation
 * idiom, so the reflected shape (count + maximum index) is all there is. */
function elementsStoreSize(
    indexedProperties: number,
    maximumIndex: number,
    constants: LayoutConstants,
    slotWidth = constants.taggedSlot,
): number {
    if (indexedProperties === 0) return 0
    const dense = maximumIndex < indexedProperties * 2 + 1024
    if (dense) {
        return align8(constants.fixedArrayHeader + (maximumIndex + 1) * slotWidth)
    }
    return numberDictionarySize(indexedProperties, constants)
}

/* Array elements path: `length` IS reflectable and is what V8 allocates for
 * dense stores (new Array(n) and length-set both allocate n slots — measured
 * in the calibration families). The fast-vs-dictionary decision approximates
 * V8's real rule, which is per-write gap (kMaxGap ≈ 1024), via the maximum
 * hole run between present indices (including the leading run); a huge
 * length alone also forces dictionary mode (kMaxFastArrayLength). Two
 * reflection-identical shapes remain undecidable and are documented in
 * DESIGN.md: a preallocated tail (new Array(2000); a[1999]=x, really fast-
 * holey) vs a written tail (a=[]; a[1999]=x), and write-grown spare
 * capacity (~1.5×) vs literal exact capacity. */
const KMAX_GAP = 1024
const KMAX_FAST_ARRAY_LENGTH = 33_554_432
function arrayElementsStoreSize(
    length: number,
    indexedProperties: number,
    maxHoleRun: number,
    constants: LayoutConstants,
    slotWidth = constants.taggedSlot,
): number {
    const dictionary = maxHoleRun > KMAX_GAP || length > KMAX_FAST_ARRAY_LENGTH
    if (dictionary) {
        return indexedProperties === 0
            ? numberDictionarySize(1, constants)
            : numberDictionarySize(indexedProperties, constants)
    }
    if (length === 0) return 0 // the empty elements store is a shared singleton
    return align8(constants.fixedArrayHeader + length * slotWidth)
}

function fastObjectSize(
    namedProperties: number,
    indexedProperties: number,
    maximumIndex: number,
    prototype: object | null,
    constants: LayoutConstants,
): number {
    let bytes: number
    if (namedProperties === 0 && indexedProperties === 0 && prototype === objectPrototype) {
        bytes = constants.emptyObject
    } else {
        bytes = align8(constants.objectHeader + namedProperties * constants.taggedSlot)
    }

    return bytes + elementsStoreSize(
        indexedProperties,
        maximumIndex,
        constants,
    )
}

function bigintSize(value: bigint, constants: LayoutConstants): number {
    const magnitude = value < 0n ? -value : value
    let digits = 0
    let remainder = magnitude
    while (remainder !== 0n) {
        digits++
        remainder >>= 64n
    }
    return align8(constants.bigintHeader + Math.max(1, digits) * 8)
}

function createBreakdown(): MemoryBreakdown {
    return {
        objects: 0,
        arrays: 0,
        strings: 0,
        collections: 0,
        numbers: 0,
        bigints: 0,
        symbols: 0,
        functions: 0,
        arrayBuffers: 0,
        typedArrays: 0,
        other: 0,
    }
}

export function estimateMemoryDetailed(
    value: unknown,
    options: EstimateMemoryOptions = {},
): DetailedMemoryEstimate {
    const layout = options.layout === undefined || options.layout === 'auto'
        ? detectV8Layout()
        : options.layout
    const constants = LAYOUTS[layout]
    const seen = options.seen ?? new WeakSet<object>()
    const seenStrings = new Set<string>()
    const seenSymbols = new Set<symbol>()
    const breakdown = createBreakdown()
    const queue: unknown[] = [value]

    const add = (category: keyof MemoryBreakdown, bytes: number): void => {
        breakdown[category] += bytes
    }

    const enqueueOwnValues = (
        object: object,
        skip: (key: PropertyKey) => boolean = () => false,
    ): number => {
        let dataProperties = 0
        for (const key of Reflect.ownKeys(object)) {
            if (skip(key)) continue
            const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
            if (descriptor === undefined) continue
            dataProperties++
            if ('value' in descriptor) queue.push(descriptor.value)
            else {
                if (descriptor.get !== undefined) queue.push(descriptor.get)
                if (descriptor.set !== undefined) queue.push(descriptor.set)
            }
        }
        return dataProperties
    }

    while (queue.length > 0) {
        const current = queue.pop()
        const type = typeof current

        if (type === 'string') {
            const string = current as string
            if (options.countInternedStrings && seenStrings.has(string)) continue
            if (options.countInternedStrings) seenStrings.add(string)
            add('strings', flatStringSize(string, constants))
            continue
        }
        if (type === 'number') {
            if (!isSmi(current as number, layout)) add('numbers', constants.heapNumber)
            continue
        }
        if (type === 'bigint') {
            add('bigints', bigintSize(current as bigint, constants))
            continue
        }
        if (type === 'symbol') {
            const symbol = current as symbol
            if (seenSymbols.has(symbol)) continue
            seenSymbols.add(symbol)
            if (Symbol.keyFor(symbol) !== undefined || wellKnownSymbols.has(symbol)) continue
            add('symbols', constants.symbol)
            if (symbol.description !== undefined) queue.push(symbol.description)
            continue
        }
        if ((type !== 'object' || current === null) && type !== 'function') continue

        const object = current as object
        if (seen.has(object)) continue
        seen.add(object)

        if (type === 'function') {
            add('functions', constants.function)
            const custom = enqueueOwnValues(object, (key) =>
                key === 'length' || key === 'name' || key === 'arguments' ||
                key === 'caller' || key === 'prototype')
            add('functions', propertyStoreSize(custom, constants))
            continue
        }

        if (Array.isArray(object)) {
            const array = object as unknown[]
            const keys = Reflect.ownKeys(array)
            let allNumeric = true
            let hasNonSmi = false
            let indexedProperties = 0
            let customProperties = 0
            // Integer keys arrive in ascending order (spec), so one pass
            // yields the maximum hole run for the fast-vs-dictionary call.
            let previousIndex = -1
            let maxHoleRun = 0
            const indexedValues: unknown[] = []
            for (const key of keys) {
                if (key === 'length') continue
                const descriptor = Reflect.getOwnPropertyDescriptor(array, key)
                if (descriptor === undefined) continue

                if (!isArrayIndex(key)) {
                    customProperties++
                    if ('value' in descriptor) queue.push(descriptor.value)
                    else {
                        if (descriptor.get !== undefined) queue.push(descriptor.get)
                        if (descriptor.set !== undefined) queue.push(descriptor.set)
                    }
                    continue
                }

                indexedProperties++
                const index = Number(key)
                maxHoleRun = Math.max(maxHoleRun, index - previousIndex - 1)
                previousIndex = index
                if (!('value' in descriptor)) {
                    allNumeric = false
                    if (descriptor.get !== undefined) queue.push(descriptor.get)
                    if (descriptor.set !== undefined) queue.push(descriptor.set)
                    continue
                }
                indexedValues.push(descriptor.value)
                if (typeof descriptor.value !== 'number') allNumeric = false
                else if (!isSmi(descriptor.value, layout)) hasNonSmi = true
            }
            const dictionary =
                maxHoleRun > KMAX_GAP || array.length > KMAX_FAST_ARRAY_LENGTH
            const doubleElements =
                !dictionary && allNumeric && hasNonSmi && indexedProperties > 0
            add('arrays', constants.arrayHeader + arrayElementsStoreSize(
                array.length,
                indexedProperties,
                maxHoleRun,
                constants,
                doubleElements ? 8 : constants.taggedSlot,
            ))
            if (!doubleElements) {
                for (const element of indexedValues) queue.push(element)
            }
            add('arrays', propertyStoreSize(customProperties, constants))
            continue
        }

        if (object instanceof Map) {
            add('collections', constants.mapShell + orderedHashTableSize(object.size, 'map', constants))
            for (const [key, entryValue] of Map.prototype.entries.call(object)) {
                queue.push(key, entryValue)
            }
            const custom = enqueueOwnValues(object)
            add('collections', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Set) {
            add('collections', constants.setShell + orderedHashTableSize(object.size, 'set', constants))
            for (const entryValue of Set.prototype.values.call(object)) queue.push(entryValue)
            const custom = enqueueOwnValues(object)
            add('collections', propertyStoreSize(custom, constants))
            continue
        }

        if (ArrayBuffer.isView(object)) {
            const view = object as ArrayBufferView
            if (view instanceof DataView) add('typedArrays', constants.dataView)
            else add('typedArrays', constants.typedArray)
            queue.push(view.buffer)
            const custom = enqueueOwnValues(object, isArrayIndex)
            add('typedArrays', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof ArrayBuffer ||
            (typeof SharedArrayBuffer !== 'undefined' && object instanceof SharedArrayBuffer)) {
            add('arrayBuffers', constants.arrayBuffer + object.byteLength)
            const custom = enqueueOwnValues(object)
            add('arrayBuffers', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Date) {
            add('other', constants.date)
            const custom = enqueueOwnValues(object)
            add('other', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof RegExp) {
            add('other', constants.regexp)
            const custom = enqueueOwnValues(object, (key) => key === 'lastIndex')
            add('other', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof WeakMap || object instanceof WeakSet) {
            add('collections', constants.weakCollection)
            const custom = enqueueOwnValues(object)
            add('collections', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Promise) {
            add('other', constants.promise)
            const custom = enqueueOwnValues(object)
            add('other', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Error) {
            add('other', constants.error)
            const custom = enqueueOwnValues(object)
            add('other', propertyStoreSize(custom, constants))
            continue
        }

        const prototype = Object.getPrototypeOf(object) as object | null
        if (object instanceof Number || object instanceof Boolean || object instanceof String ||
            prototype === bigintPrototype || prototype === symbolPrototype) {
            add('objects', constants.primitiveWrapper)
            if (object instanceof Number) queue.push(Number.prototype.valueOf.call(object))
            else if (object instanceof Boolean) queue.push(Boolean.prototype.valueOf.call(object))
            else if (object instanceof String) queue.push(String.prototype.valueOf.call(object))
            else if (prototype === bigintPrototype) queue.push(BigInt.prototype.valueOf.call(object))
            else queue.push(Symbol.prototype.valueOf.call(object))
            const custom = enqueueOwnValues(object, (key) =>
                (object instanceof String && key === 'length') || isArrayIndex(key))
            add('objects', propertyStoreSize(custom, constants))
            continue
        }

        const keys = Reflect.ownKeys(object)
        let namedProperties = 0
        let indexedProperties = 0
        let maximumIndex = -1
        for (const key of keys) {
            if (isArrayIndex(key)) {
                indexedProperties++
                maximumIndex = Math.max(maximumIndex, Number(key))
            } else {
                namedProperties++
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
            if (descriptor === undefined) continue
            if ('value' in descriptor) queue.push(descriptor.value)
            else {
                if (descriptor.get !== undefined) queue.push(descriptor.get)
                if (descriptor.set !== undefined) queue.push(descriptor.set)
            }
        }

        const mode = options.objectMode === 'dictionary' ? 'dictionary' : 'fast'
        if (mode === 'dictionary') {
            add('objects', dictionaryObjectSize(namedProperties, constants) + elementsStoreSize(
                indexedProperties,
                maximumIndex,
                constants,
            ))
        } else {
            add('objects', fastObjectSize(
                namedProperties,
                indexedProperties,
                maximumIndex,
                prototype === nullPrototype ? null : prototype,
                constants,
            ))
        }
    }

    const total = Object.values(breakdown).reduce((sum, bytes) => sum + bytes, 0)
    return { total, byCategory: breakdown, layout }
}

export function estimateMemory(value: unknown, options?: EstimateMemoryOptions): number {
    return estimateMemoryDetailed(value, options).total
}

export default estimateMemory
