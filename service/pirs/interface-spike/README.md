# Plugin interface spike

Throwaway evidence for [issue #6](https://git.subcult.tv/subculture-collective/pirs/issues/6).
This executable is separate from the PDS. It receives synthetic data only and
implements one application host call. It is not the Pirs plugin host.

From this directory on Linux amd64, with Rust 1.95.0, Go 1.27.1 and Python 3.11+
available:

```sh
python3 build.py --bootstrap
python3 measure.py
```

Bootstrap downloads wasm-tools 1.261.0, wit-bindgen 0.62.0 and the Wasmtime
49.0.2 preview1 reactor adapter, checks their recorded SHA-256 values, and adds
two Rust targets. Downloads and build outputs stay under ignored directories.
The standalone native harness uses Wasmtime 39.0.1, pinned in Cargo.lock.
Run `python3 build.py` for subsequent builds. The script prints each command.

All guests receive `seq = 42` and a 64-byte ASCII payload, check those fields,
call `emit` once, and return the host's acknowledgment `43`. The harness checks
both event fields, each acknowledgment and the total callback count. WIT uses a
typed record. The core ABI uses UTF-8 JSON in guest linear memory, a 4096-byte
guest input buffer, `input_ptr() -> u32`, `on_event(ptr, len) -> u32`, and an
import `pirs.emit(ptr, len) -> u32`. The host writes the buffer before each core
call; the guest parses the JSON and passes those bytes to the host callback.
This fixed buffer is adequate for the spike; it is not a proposed production
allocation protocol.

The harness reads compiled import metadata before creating any Store or
instance. Components include interface member names and function types; core
modules include module/name pairs and core function signatures. To inspect
the complete WIT schema without instantiating a component:

```sh
tools/wasm-tools-1.261.0-x86_64-linux/wasm-tools component wit artifacts/rust-component.wasm
tools/wasm-tools-1.261.0-x86_64-linux/wasm-tools component wit artifacts/go-component.wasm
```

The Go bindings generator emits an `export_wit_world` import whose application
implementation must be supplied by the author. `build.py` copies `on_event.go`
there before building. It regenerates bindings and retains the dependency
checksums in `go-component/go.sum`. The generator pins its runtime dependency
to `go.bytecodealliance.org/pkg` 0.2.3. That runtime needs
`adapter_monotonic_clock_set_paused`; the 39.0.1 reactor adapter from the
upstream example lacks it. The pinned 49.0.2 adapter works with this synchronous
world and the harness's Wasmtime 39.0.1 runtime.

For author steps, count compilation and interface conversion commands, after
tool/dependency setup: one Cargo build for either Rust interface, one Go build
for core, and four commands for the Go component (bindgen, Go build, embed,
component new). `go mod tidy` is an additional dependency setup command. The
copy step supplies application source rather than converting the artifact.
Validation, hashing and building this measurement harness are qualification
steps, not commands every plugin author must run. The build script wraps all
of these, but does not make the underlying toolchain steps disappear.

`measure.py` starts three fresh harness processes in rotated artifact order.
Each process compiles each artifact once, measures 25 fresh instantiations,
then warms a separate instance with 1000 calls and measures five batches of
10,000 calls. Go's `_initialize` is included in instantiation time. Store,
WASI-context setup and linking are included; compilation is measured separately.
The output retains raw samples, medians, sizes, hashes and import inventories
in `artifacts/measurements.json`. No timing threshold determines CI success.

Per-call time includes guest checks, lowering/copying, the host callback and
acknowledgment validation. The core input JSON is serialized once before the
loop; JSON decoding runs in both guest and host. WIT record lowering runs on
each call. Thus the JSON result excludes repeated host encoding costs and is a
conservative measurement for that implementation. These are end-to-end call
costs for this workload, not isolated Wasm transition costs. Serialization
libraries contribute to both artifact size and timing.

WASI contexts inherit no environment, arguments, streams or preopened
directories. No PDS runs here. The spike does not enforce call deadlines,
memory ceilings, capability manifests, response/log quotas or installation
policy. Clocks/randomness and runtime imports need an explicit policy in a
real host. Measured import visibility does not prove capability enforcement.

See [the decision record](../../../docs/decisions/0001-plugin-interface.md)
for the evidence and the owner's selection of WIT components for issue #7.
