# heap-estimate

One `Map` with eight small-integer pairs, four answers:

| method | bytes |
|---|---:|
| `JSON.stringify(value).length` | 2 |
| `object-sizeof(value)` | 65 |
| `heap-estimate(value)` | **296** |
| forced-GC retained delta | **296.2** |

The JSON result is `{}` because Maps are not JSON objects. `object-sizeof`
walks the entries but misses V8's 32-byte `JSMap` and 248-byte
`OrderedHashMap` allocation. `heap-estimate` models both.

```ts
import estimateMemory, { estimateMemoryDetailed } from 'heap-estimate'

const value = new Map(Array.from({ length: 8 }, (_, i) => [i, i]))
estimateMemory(value) // 296 on stock 64-bit Node 24

estimateMemoryDetailed(value)
// {
//   total: 296,
//   byCategory: { collections: 296, objects: 0, arrays: 0, ... },
//   layout: 'uncompressed'
// }
```

## Why this exists

Serialized length is a wire-format fact, not a heap fact. V8 stores object
fields according to hidden-class layout, arrays in tagged or unboxed-double
elements stores, strings as one-byte or two-byte representations, and Maps
and Sets in capacity-rounded ordered hash tables. Those allocations dominate
many real graphs and are invisible to `JSON.stringify`.

`heap-estimate` walks the retained graph once, handles cycles and sharing,
and reports both a total and a category breakdown. It has no runtime
dependencies. The model targets Node 24 / V8 13.6 and is tested on Node 18,
22, and 24.

## Calibration receipts

These are allocation measurements, not heap-snapshot folklore. For every
row, `probes/calibrate.mjs` starts a fresh child process, warms the shape,
forces GC five times, allocates the exact-sized root reference array, and
takes a baseline. It then fills that existing array with thousands of shape
instances, forces GC five more times, and divides the retained
`heapUsed + arrayBuffers` delta by the instance count. The table reports the
median of seven isolated runs.

Isolated runs and a median make background load an outlier instead of a
systematic bias; they do not make a busy machine magically deterministic.
Raw samples and machine metadata are in `receipts/calibration.json`. Run
`npm run calibrate` to replace both that receipt and this table. CI runs a
three-repetition cross-family subset and fails if any absolute error exceeds
15%.

<!-- calibration:start -->
Node 24.13.1 / V8 13.6.233.17-node.40, darwin-arm64, uncompressed tagged pointers; 7 isolated runs per row.

| shape | measured B/instance | heap-estimate | object-sizeof | ours error | theirs error |
|---|---:|---:|---:|---:|---:|
| object/0-keys | 56.1 | 56.0 | 2.0 | -0.2% | -96.4% |
| object/4-keys | 56.2 | 56.0 | 25.0 | -0.4% | -55.5% |
| object/16-keys | 152.8 | 152.0 | 104.0 | -0.5% | -31.9% |
| array/packed-smi-32 | 304.4 | 304.0 | 88.0 | -0.1% | -71.1% |
| array/packed-double-32 | 304.5 | 304.0 | 152.0 | -0.2% | -50.1% |
| array/holey-smi-32 | 304.5 | 304.0 | 375.0 | -0.2% | +23.2% |
| array/objects-8 | 368.5 | 368.0 | 97.0 | -0.1% | -73.7% |
| string/one-byte-64 | 80.1 | 80.0 | 76.0 | -0.2% | -5.2% |
| string/two-byte-64 | 144.2 | 144.0 | 76.0 | -0.1% | -47.3% |
| map/8-smi-pairs | 296.2 | 296.0 | 65.0 | -0.1% | -78.1% |
| map/32-smi-pairs | 968.7 | 968.0 | 285.0 | -0.1% | -70.6% |
| set/8-smis | 232.2 | 232.0 | 23.0 | -0.1% | -90.1% |
| set/32-smis | 712.7 | 712.0 | 97.0 | -0.1% | -86.4% |
| tree/binary-depth-3 | 592.3 | 592.0 | 293.0 | -0.0% | -50.5% |
| array-buffer/256 | 352.8 | 352.0 | 2.0 | -0.2% | -99.4% |
| typed-array/u8-256 | 456.7 | 456.0 | 256.0 | -0.2% | -43.9% |
<!-- calibration:end -->

The reduced gate also passes in the official Node 24.13.1 Linux x64 image.
Both that image and the official Linux ARM64 and macOS ARM64 builds report
`v8_enable_pointer_compression=0`. Contrary to a common assumption, stock
Node 24 therefore uses 8-byte tagged slots. The estimator detects this from
`process.config`; `layout: 'compressed'` exposes the 4-byte-slot model for a
custom V8 build or embedder.

## API

```ts
estimateMemory(value, options?): number
estimateMemoryDetailed(value, options?): {
  total: number
  byCategory: {
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
  layout: 'compressed' | 'uncompressed'
}

interface EstimateMemoryOptions {
  countInternedStrings?: boolean
  seen?: WeakSet<object>
  layout?: 'auto' | 'compressed' | 'uncompressed'
  objectMode?: 'auto' | 'fast' | 'dictionary'
}
```

`countInternedStrings` preserves the original estimator's switch semantics:
it defaults to `false`, which charges every string occurrence as an
independent flat string. `true` assumes equal string values share storage and
charges each distinct value once during that call. Strings cannot be members
of a `WeakSet`, so string interning does not compose across separate calls.

Pass the same `seen` set to several calls to estimate disjoint roots that may
share objects. The function adds every visited object to that set; a later
call charges zero for an already-seen subtree.

V8 does not expose fast-vs-dictionary property mode to JavaScript.
`objectMode: 'auto'` uses dictionary accounting for 20 or more named
properties. Use `'dictionary'` when `delete` forced a smaller object into
dictionary mode, or `'fast'` when a wide object literal retained fast
properties.

## Speed

The estimator is a graph walk; the honest cost is proportional to reachable
values. On the 100-record mixed fixture in `probes/bench.mjs`, cyclebench
measured:

| candidate | median time/op | ops/s | vs stringify |
|---|---:|---:|---:|
| `JSON.stringify(value).length` | 98.1µs | 10.2k | 1× |
| `object-sizeof(value)` | 222µs | 4.50k | 2.26× |
| `heap-estimate(value)` | 259µs | 3.86k | 2.64× |

The candidates intentionally compute different answers, so cyclebench's
agreement check is disabled. It still interleaves them to reduce machine
drift. Run `npm run bench`; the complete report is written to
`receipts/throughput.json`.

## Precision limits

- The calibration guarantee is for the published shape families, not every
  object V8 can create. Node/V8 releases can change layouts.
- The model assumes exact visible array capacity. Arrays grown by repeated
  `push` may retain spare backing-store capacity that reflection cannot see.
- Strings are assumed to be flat sequential one-byte or two-byte strings.
  JavaScript cannot reliably distinguish slices, ropes, external strings, or
  internalized literals. The interning option makes that uncertainty explicit.
- Shared hidden-class maps, descriptor arrays, prototypes, compiled code,
  inline caches, and other runtime metadata are not charged: they are shared
  or globally rooted rather than retained solely by the input. Hidden-class
  decisions still determine the in-object field bytes the model charges.
- Functions receive a shallow shell estimate plus custom own properties.
  Shared code/SFI and the unobservable captured lexical environment are
  excluded. WeakMap and WeakSet entries are also excluded because their weak
  contents cannot be enumerated.
- ArrayBuffer backing bytes are included exactly; allocator fragmentation,
  reserved-but-uncommitted space, and native allocations owned by arbitrary
  addons are not.
- Property getters are not invoked, but estimating a Proxy may execute its
  reflection traps.

## License

MIT © Xyra Sinclair
