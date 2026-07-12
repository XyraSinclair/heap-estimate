# Design

## Retained-size contract

The estimate is the allocation retained exclusively through the supplied
value graph. It includes object bodies, property and element stores, flat
string bodies, ordered hash tables, and ArrayBuffer backing stores. It does
not include the caller's root reference slot or shared/global V8 metadata
such as prototypes, hidden-class `Map`s, descriptor arrays, compiled code,
and inline caches.

Traversal is iterative and identity-based. Objects are entered into the
caller's `WeakSet` before their outgoing edges are queued, so cycles terminate
and DAG nodes are charged once. Map and Set contents are walked with their
iterators, avoiding temporary `Array.from` copies. Own data descriptors are
read directly, so accessors are not invoked.

## V8 13.6 layout profiles

All sizes are bytes and heap objects are aligned to eight bytes.

| allocation | compressed | uncompressed |
|---|---:|---:|
| tagged slot | 4 | 8 |
| ordinary-object header | 12 | 24 |
| empty ordinary object | 32 | 56 |
| JSArray shell | 16 | 32 |
| FixedArray/string header | 8 / 12 | 16 / 16 |
| HeapNumber | 16 | 16 |
| JSMap / JSSet shell | 16 | 32 |
| JSDate | 48 | 96 |
| JSArrayBuffer | 64 | 96 |
| JSTypedArray | 64 | 104 |
| JSDataView | 56 | 88 |
| JSFunction shallow shell | 32 | 64 |

The uncompressed column was checked on Node 24.13.1 / V8
13.6.233.17-node.40 with `%DebugPrint` and then independently recovered by
the forced-GC deltas. Official Node 24.13.1 darwin-arm64, Linux ARM64, and
Linux x64 builds all report `v8_enable_pointer_compression=0`; the Linux x64
reduced accuracy gate was also run in the official container image. The
compressed column applies V8's 4-byte `kTaggedSize` field layout and is
available explicitly for custom builds; it is not represented as a stock
Node 24 receipt.

Fast object literals use
`align8(objectHeader + ownNamedProperties * taggedSlot)`. The empty
`Object.prototype` shape is special because its initial map reserves four
in-object property fields. Dictionary mode uses the observed Node 24
`NameDictionary` form: six prefix slots and three slots per capacity bucket.
Construction and deletion history are not reflectable. Auto therefore uses
fast accounting at every visible width, matching wide literals and
`JSON.parse`; callers who know that mutation forced dictionary properties can
select the `objectMode` override.

An array is its shell plus an elements store. Dense stores are sized by
`length` — the one reflectable quantity V8 actually allocates for:
`new Array(n)` and a bare length-set both materialize n slots (both are
calibration families). An all-numeric dense array with any non-SMI number
is modeled as a FixedDoubleArray with eight-byte unboxed elements. The
fast-vs-dictionary decision approximates V8's real per-write rule
(kMaxGap ≈ 1024) with the maximum hole run between present indices,
including the leading run; a length beyond kMaxFastArrayLength forces
dictionary mode regardless. Dictionary stores use the observed
NumberDictionary form: four prefix slots and three slots per capacity
bucket. Plain objects have no preallocation idiom, so their elements
stores are sized by maximum index instead.

Two reflection-identical pairs stay undecidable, deliberately: a
preallocated tail (`new Array(2000); a[1999] = x`, really fast-holey) is
indistinguishable from a written one (`a = []; a[1999] = x`, really
dictionary) — the gap rule picks the dictionary reading; and a write-grown
array carries ~1.5× spare capacity that a literal-built twin lacks, so
incrementally built spread-out arrays under-estimate by roughly the spare
factor. Sparse double entries also run ~25% hot (dictionary-plus-boxed-
HeapNumber modeling). Element-kind and capacity history remain
unobservable; these are the residuals of that fact, and the calibration
families are chosen adversarially against the estimator's branches rather
than to flatter them.

For current ordered collections, capacity is the next power of two at least
as large as size, with minima of four for Map and eight for Set. A Map table
contains `3 + capacity/2 + 3*capacity` slots; a Set contains
`3 + capacity/2 + 2*capacity`. The formula exactly predicts the
`OrderedHashMap[17/31/59/…]` and `OrderedHashSet[23/43/83/…]` lengths printed
by V8 13.6.

Sequential strings are `align8(header + length * width)`, where width is one
for Latin-1 code units and two otherwise. BigInts are a header plus at least
one eight-byte digit. ArrayBuffer estimates add the exact `byteLength` native
backing store to the heap shell; multiple views reach the same buffer object,
so identity traversal charges it once.

## Calibration design

`probes/calibrate-worker.mjs` handles exactly one shape and one repetition.
The parent launches a fresh process for every sample. After shape warmup and
five forced GCs, the worker allocates its holey root array and takes the
baseline; it then fills those pre-existing slots, forces five more GCs, and
reports `(heapUsed delta + arrayBuffers delta) / N`. The parent takes a median
of seven full-run samples or three CI samples. This isolates shape state,
removes root-array storage from the delta, and limits scheduler/load drift.

Calibration families are chosen adversarially against the estimator's
branches, not to flatter it. The reduced gate includes every shape that has
exposed a branch error: the sparse 100k-index array, 30-key parsed object in
auto mode, dictionary-forced object with 30 indexed elements, and boxed
String. In the current seven-run receipt their signed errors are respectively
-0.4%, -0.2%, -0.1%, and -0.5%.

The 15% gate covers plain objects, packed SMI arrays, packed double arrays,
holey and sparse arrays, wide parsed and dictionary-property objects, boxed,
one-byte, and two-byte strings, Maps, Sets, and nested trees. The full receipt
additionally covers object-valued arrays, more capacities, ArrayBuffer, and
typed-array view-plus-buffer ownership. The gate remains 15%; raw samples are
committed in `receipts/calibration.json`.

## Deliberate exclusions

Function source length is not multiplied into a fictional AST size. A
function estimate is its shallow `JSFunction` shell and custom own-property
storage; code, SFI, feedback vectors, and closure contexts are shared or
unobservable. Weak collection entries cannot be enumerated without changing
their semantics and are excluded. Ropes, slices, external strings, spare
array capacity, IC state, property slack before finalization, allocator
fragmentation, addon-native allocations, and Proxy behavior are likewise
outside the observable model and are called out in the README.
