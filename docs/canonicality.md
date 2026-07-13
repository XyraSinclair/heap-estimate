# Publication canonicality

This file is the release gate for `heap-estimate@0.1.0`.

| Area | Requirement | Status | Evidence |
|---|---|---|---|
| Truth | Published shape families stay within the stated calibration error | covered | isolated forced-GC receipt and 15% CI gate |
| Truth | Cycles, sharing, buffers, collections, strings, and accessors follow the contract | covered | source tests and calibrated fixtures |
| First contact | A stranger can install and estimate the opening Map example | covered | README install command, example, and packed-artifact consumer smoke test |
| Depth | Layout assumptions and reflection limits are explicit | covered | DESIGN.md and precision-limits section |
| Craft | The API says estimate, names excluded memory, and avoids false exactness | covered | retained-size contract and dated receipts |
| Stewardship | Tests, calibration subset, build, and package contents are gated | covered | CI on Node 18/22/24; reduced calibration on Node 24 |

## Named gaps

- The calibrated model targets Node 24 / V8 13.6; future layouts can change.
- Fast-vs-dictionary properties, string representation, and spare array capacity are not reflectable.
- Compiled code, closure environments, shared metadata, fragmentation, and arbitrary addon-native memory are excluded.

## Ruled out

- Exact heap-snapshot replacement: ruled out; this is a calibrated graph estimate.
- Getter execution: ruled out; descriptors are inspected without invoking getters.
