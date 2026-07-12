# Design

`heap-estimate` models V8 heap objects rather than serialized payloads. The
constants, assumptions, and calibration evidence live here and in
`probes/calibrate.mjs`; the README is the user-facing contract.
