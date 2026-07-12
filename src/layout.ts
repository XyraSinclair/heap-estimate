export type V8Layout = 'compressed' | 'uncompressed'

export interface LayoutConstants {
    readonly name: V8Layout
    readonly taggedSlot: number
    readonly objectHeader: number
    readonly emptyObject: number
    readonly arrayHeader: number
    readonly fixedArrayHeader: number
    readonly stringHeader: number
    readonly heapNumber: number
    readonly mapShell: number
    readonly setShell: number
    readonly date: number
    readonly regexp: number
    readonly function: number
    readonly symbol: number
    readonly bigintHeader: number
    readonly arrayBuffer: number
    readonly typedArray: number
    readonly dataView: number
    readonly primitiveWrapper: number
    readonly weakCollection: number
    readonly promise: number
    readonly error: number
}

// Node 24.13.1 / V8 13.6. The uncompressed sizes were checked with
// %DebugPrint on the official darwin-arm64 build. Compressed tagged fields
// follow V8's 4-byte kTaggedSize layout used by official linux-x64 builds.
export const LAYOUTS: Readonly<Record<V8Layout, LayoutConstants>> = {
    compressed: {
        name: 'compressed',
        taggedSlot: 4,
        objectHeader: 12,
        emptyObject: 32,
        arrayHeader: 16,
        fixedArrayHeader: 8,
        stringHeader: 12,
        heapNumber: 16,
        mapShell: 16,
        setShell: 16,
        date: 48,
        regexp: 32,
        function: 32,
        symbol: 16,
        bigintHeader: 8,
        arrayBuffer: 64,
        typedArray: 64,
        dataView: 56,
        primitiveWrapper: 16,
        weakCollection: 16,
        promise: 24,
        error: 24,
    },
    uncompressed: {
        name: 'uncompressed',
        taggedSlot: 8,
        objectHeader: 24,
        emptyObject: 56,
        arrayHeader: 32,
        fixedArrayHeader: 16,
        stringHeader: 16,
        heapNumber: 16,
        mapShell: 32,
        setShell: 32,
        date: 96,
        regexp: 56,
        function: 64,
        symbol: 24,
        bigintHeader: 16,
        arrayBuffer: 96,
        typedArray: 104,
        dataView: 88,
        primitiveWrapper: 32,
        weakCollection: 32,
        promise: 48,
        error: 48,
    },
}

export function align8(bytes: number): number {
    return Math.ceil(bytes / 8) * 8
}

export function detectV8Layout(): V8Layout {
    const runtime = globalThis as typeof globalThis & {
        process?: { config?: { variables?: Record<string, unknown> } }
    }
    const enabled = runtime.process?.config?.variables?.v8_enable_pointer_compression
    if (enabled === 0 || enabled === '0' || enabled === false) return 'uncompressed'
    if (enabled === 1 || enabled === '1' || enabled === true) return 'compressed'

    // Pointer compression is the normal 64-bit V8 configuration. Unknown
    // embedders can override this with opts.layout.
    return 'compressed'
}
