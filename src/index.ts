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
     * uses dictionary accounting for 20+ named properties; override when
     * deletion forced a smaller object into dictionary mode.
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

const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty) as (
    value: object,
    key: PropertyKey,
) => boolean
const objectPrototype = Object.prototype
const nullPrototype = null
const arrayIndexPattern = /^(?:0|[1-9]\d*)$/
const bigintPrototype = Object.getPrototypeOf(Object(0n)) as object
const symbolPrototype = Object.getPrototypeOf(Object(Symbol())) as object
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

    if (indexedProperties > 0) {
        const dense = maximumIndex < indexedProperties * 2 + 16
        if (dense) {
            bytes += align8(
                constants.fixedArrayHeader + (maximumIndex + 1) * constants.taggedSlot,
            )
        } else {
            const capacity = nextPowerOfTwo(Math.max(4, Math.ceil(indexedProperties * 1.5)))
            bytes += align8(constants.fixedArrayHeader + (3 + capacity * 3) * constants.taggedSlot)
        }
    }
    return bytes
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
            let allNumeric = true
            let hasNonSmi = false
            for (let index = 0; index < array.length; index++) {
                if (!hasOwn(array, index)) continue
                const element = array[index]
                if (typeof element !== 'number') allNumeric = false
                else if (!isSmi(element, layout)) hasNonSmi = true
            }
            const doubleElements = allNumeric && hasNonSmi
            let bytes = constants.arrayHeader
            if (array.length > 0) {
                bytes += align8(
                    constants.fixedArrayHeader +
                    array.length * (doubleElements ? 8 : constants.taggedSlot),
                )
            }
            add('arrays', bytes)
            if (!doubleElements) {
                for (let index = 0; index < array.length; index++) {
                    if (hasOwn(array, index)) queue.push(array[index])
                }
            }
            const custom = enqueueOwnValues(array, (key) =>
                key === 'length' || isArrayIndex(key))
            add('arrays', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Map) {
            add('collections', constants.mapShell + orderedHashTableSize(object.size, 'map', constants))
            for (const [key, entryValue] of object) {
                queue.push(key, entryValue)
            }
            const custom = enqueueOwnValues(object)
            add('collections', propertyStoreSize(custom, constants))
            continue
        }

        if (object instanceof Set) {
            add('collections', constants.setShell + orderedHashTableSize(object.size, 'set', constants))
            for (const entryValue of object) queue.push(entryValue)
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
            const custom = enqueueOwnValues(object, isArrayIndex)
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

        const mode = options.objectMode === 'dictionary' ||
            (options.objectMode !== 'fast' && namedProperties >= 20)
            ? 'dictionary'
            : 'fast'
        if (mode === 'dictionary') {
            add('objects', dictionaryObjectSize(namedProperties, constants))
            // Dictionary property names live in the table rather than shared
            // hidden-class descriptors. Charge their flat storage too.
            for (const key of keys) if (typeof key === 'string' && !isArrayIndex(key)) queue.push(key)
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
