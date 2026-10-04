# Plugin interface comparison

Status: adopted by the owner on 2026-10-03. Interface: WIT components.

[Issue #6](https://git.subcult.tv/subculture-collective/pirs/issues/6) asks for
the same event/callback guest in Rust and Go using WIT components and a core
JSON-over-pointer ABI. All four now build, validate, expose import metadata
before instantiation and execute the callback. The standalone spike is in
[`service/pirs/interface-spike`](../../service/pirs/interface-spike/README.md).
It does not attach to the PDS or implement the production host.

## Recommendation and decision

Adopt WIT components for the next host spike. This workload produced smaller
artifacts and lower call time for both languages, and imports carry an
interface schema instead of requiring a separate JSON contract. Both
interfaces support inspection before instantiation, so that property alone
does not select WIT. Go component authoring needs more tooling and conversion
steps, and the adapter compatibility failure below is a real maintenance cost.

The owner approved WIT components after reviewing the measured comparison.
The comparison merged in [PR #45](https://git.subcult.tv/subculture-collective/pirs/pulls/45).
This resolves the interface choice in issue #6 and permits the host work in
issue #7. The core JSON ABI remains a measured alternative, not the selected
contract. The choice does not qualify event delivery or grant enforcement.

## Local measurements

The checked-in [raw results](0001-plugin-interface.measurements.json) retain
every sample, artifact hash and import inventory. Recorded at 2026-10-03T22:38:15.571792+00:00
on Kvant: AMD Ryzen 9 9900X, Linux 7.2.5-4-omarchy, linux/amd64.
Rust 1.95.0, Go 1.27.1, Wasmtime 39.0.1; release builds use stripped
artifacts. The native harness is also a release build.

| Guest | Artifact bytes | Compile median (ms) | Initialize median (µs) | Call median (µs) | Call batch range (µs) |
| --- | ---: | ---: | ---: | ---: | --- |
| rust-core | 61,044 | 34.03 | 3.53 | 0.272 | 0.256–0.359 |
| rust-component | 41,715 | 25.29 | 5.76 | 0.147 | 0.140–0.157 |
| go-core | 4,357,070 | 1866.36 | 127.70 | 1.528 | 1.502–1.568 |
| go-component | 2,481,164 | 1007.32 | 143.05 | 0.596 | 0.565–0.776 |

Compilation is a fresh in-process Wasmtime compile, with no serialized
compiled-module cache. It is separate from instance initialization. The table
aggregates three processes, 75 fresh initializations and 15 call batches per
artifact. The workload contains one 64-byte payload and one host callback.

## Commands and author workflow

```sh
cd service/pirs/interface-spike
python3 build.py --bootstrap
python3 measure.py
cd ../..
pnpm smoke
node --test pirs/smoke.test.ts
```

`build.py` prints the actual compiler and conversion commands. The spike README
explains the ABI, measurement protocol, setup and tool versions. Rust 1.95.0
builds WIT directly with `wasm32-wasip2`; core uses
`wasm32-unknown-unknown`. Go 1.27.1 builds both as WASI preview1 reactors with
`-buildmode=c-shared`. WIT Go additionally uses wit-bindgen 0.62.0 and
wasm-tools 1.261.0 for binding generation, embedding and adaptation.

| Guest | Author build/conversion commands after setup |
| --- | ---: |
| Rust core | 1 |
| Rust WIT | 1 |
| Go core | 1 |
| Go WIT | 4 |

Go WIT also needs `go mod tidy` during dependency setup. Rust's generator is
a pinned compile-time dependency; it adds no standalone command. The core
guests require handwritten buffer and JSON handling. A one-command wrapper
does not reduce the number of tools or underlying conversion stages.

## Import inspection and authority

The native harness obtains `Module::imports` or `Component::component_type`
imports before creating any Store or instance. Component interfaces are
enumerated down to member names and function types. `wasm-tools component wit`
also extracts the complete component schema without executing guest code.
The raw results contain inventories for all four artifacts.

Rust core requests only `pirs.emit`; its signature is two `i32` parameters and
an `i32` result. Rust WIT requests `pirs:spike/host@0.1.0`, with an `event`
record and `emit(event) -> u32`, plus WASI 0.2.6 runtime interfaces pulled in
by assertion/panic support. This corrects the earlier prose claim that the
final Rust component imported only the callback; the checked-in raw inventory
already contained the complete imports. Go core adds WASI preview1 runtime imports;
Go WIT adds WASI 0.2.12 interfaces through its adapter. The full lists are
retained with the samples rather than reduced to the application callback.

Import visibility is not a grant. This spike links runtime imports with fresh
WASI contexts and no inherited environment, arguments, streams or filesystem
preopens. The real host must classify runtime imports and reject ungranted
capabilities before instantiation. No signing material, administrator password
or account database enters this executable.

## Qualification and limits

Each guest made 153,000 verified host calls across three fresh native harness
processes: 1000 warmup calls and five 10,000-call batches per process. Every
call delivered the expected fields and returned acknowledgment 43. The
measurement harness fails on mismatched data, acknowledgment or callback
count. All four artifacts passed `wasm-tools validate`.

The first Go WIT conversion failed because the 39.0.1 adapter used in the
upstream example did not export `adapter_monotonic_clock_set_paused`, requested
by the generated bindings' runtime dependency. The pinned 49.0.2 adapter
resolved that failure. Binding generation also requires an author-provided
`export_wit_world` package; the build script supplies it explicitly.

Artifact size includes the language runtime and serialization dependencies.
These measurements describe the four tested implementations, not a universal
size or speed property of either ABI. Timings came from a shared machine
without CPU isolation; the raw batch ranges show variation. The core buffer
is fixed at 4096 bytes, and the host serializes its input JSON once outside the
timed loop. WIT lowers its typed event on each call. Core still decodes JSON
in guest and host on every call. Instantiation includes Go initialization and
fresh Store/WASI setup, and excludes separately measured compilation.

The existing PDS account/record smoke and both cleanup checks passed locally.
Revision `be2213ddb9934a1542322f0a383f4bbe0b6f0ccc` passed hosted
[spike run 12535](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12535)
and [PDS smoke run 12536](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12536).
The fresh Dozor container built and validated all four guests, then verified
153,000 callbacks per guest. The harness's optimized native build took 4m 49s.
The PDS job passed the account/record smoke and both cleanup checks.

The workflow rebuilds the guests and reruns callback/import checks without
timing thresholds. Hosted timings are supplemental, on a different machine:
Rust core/WIT call medians were 0.766/0.404 µs and Go core/WIT were
4.048/1.405 µs. They show the same direction as the local comparison but are
not interchangeable samples. Hosted artifact sizes/hashes can differ with
build paths/environment; the table and raw file above describe the recorded
local artifacts. Final PR checks qualify subsequent evidence-only commits.

Initial hosted run [12526](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12526)
failed before checkout because the Rust job image lacked the Node executable
required by Gitea's action runtime. The workflow now installs checksum-verified
Node 24.19.0 before checkout. This failure did not execute the guest builds or
measurement checks.

Run [12532](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12532)
then passed setup and checkout but found that Debian's Python 3.11.2 lacks the
`tarfile` data-filter argument. Bootstrap now extracts only directories and
regular files from checksum-verified archives, with an explicit path bound and
link/device rejection. This removes the dependency on a newer Python patch
release. No runner configuration change was needed for these image/setup
failures.

No production plugin host, PDS delivery path, manifest authorization, memory
ceiling, deadline, fuel policy or response/log bound is qualified here. No
additional hook level gains support from this result.

## Sources

The build follows the [Rust component instructions](https://component-model.bytecodealliance.org/language-support/building-a-simple-component/rust.html)
and the [wit-bindgen Go generator instructions](https://github.com/bytecodealliance/wit-bindgen/blob/v0.62.0/crates/go/README.md).
The latter's older adapter example needed the adjustment described above.
Tool downloads come from Bytecode Alliance release assets, with their observed
SHA-256 values pinned in the bootstrap script. Go's CI archive is checked
against its official release checksum.
