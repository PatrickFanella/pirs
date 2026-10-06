# Local plugin manifests

This is the implemented level 0 manifest format for issue #9. It is versioned
independently of the draft hook-point spec. Registry installation, operator
policy management and account grants remain separate work.

```json
{
  "schemaVersion": 1,
  "id": "post-observer",
  "minSpecLevel": 0,
  "hooks": ["event.commit"],
  "capabilities": [
    {"name": "diagnostics.log", "constraints": {}},
    {
      "name": "events.subscribe",
      "constraints": {
        "eventTypes": ["commit"],
        "collections": ["app.bsky.feed.post"]
      }
    }
  ]
}
```

The installer accepts local component and JSON files. Running the installer
approves the exact declarations in that file. It does not negotiate account
consent or expose a policy API. The manifest ID is a lowercase ASCII slug of
1 to 128 letters, digits or hyphens. This host supports minimum spec level 0.
Unknown fields, duplicate hooks/capabilities, unknown event types and unknown
capability categories or operations fail installation. Collection constraints
must be nonempty, unique NSIDs, or exactly `["*"]` for explicit unrestricted
collection access. Partial wildcards are rejected.

`events.subscribe` supports `commit`, `sync`, `identity` and `account`. Its
event types must match the manifest's `event.*` hooks exactly. The empty hooks
list is valid for an installed component with no subscription. Diagnostics
has empty constraints because the host's existing encoded log quota applies.
Every imported `pirs:sandbox/diagnostics@0.1.0.log` function must be covered by
`diagnostics.log`. The `pirs:sandbox/network@0.1.0.request` import requires
`network.request` with typed [allowed-host constraints](network-request.md).
Its response record type is checked by the WIT linker. All other import
interfaces, operations and kinds fail.
Wasmtime checks the linked WIT signatures and required export before any
Store or guest instance exists, both at installation and runtime startup.

The shared `category.operation` vocabulary reserves `xrpc.serve`, `http.serve`,
`records.read`, `records.write`, `blobs.read`, `kv.read`,
`kv.write`, `record.validate`, `record.unique`, `account.create` and
`auth.session`. This runtime rejects them as unsupported. Future issues can
add implementations, import mappings and typed constraints without granting
these capabilities through a permissive fallback.

## Installation and integrity

```sh
service/pirs/host/target/release/pirs-host \
  --plugin /absolute/path/post-observer.wasm \
  --manifest /absolute/path/post-observer.json \
  --install-dir /absolute/path/local-installs
```

The successful response contains `installed`, the directory to run, and
`receipt`. Each directory contains `plugin.wasm`, `manifest.json` and
`receipt.json`. The receipt records the schema version, artifact SHA-256,
manifest SHA-256, inspected imports and installation ID. The ID is SHA-256 of
`pirs-install-v1`, a NUL, the hexadecimal artifact hash, a NUL, and the
hexadecimal manifest hash. It binds exact bytes, including JSON formatting.
Changing either file is a new install; repeating identical bytes is idempotent.
The installer validates before writing, writes private files in a private
staging directory, syncs files and directory, renames it into place, then syncs
the parent. New directories have mode 0700 and files mode 0600. Use an owned,
private install root. Existing parent permissions are not changed.

Runtime startup reads bounded bytes, repeats validation and checks the receipt
and directory ID before readiness. It compiles the verified in-memory bytes,
so changing the original file or changing installed files after startup cannot
replace the running component. A later startup rejects tampered installed
bytes. This is checksum pinning, not publisher authentication or a protection
against an operator who replaces the trusted host executable.

```sh
service/pirs/host/target/release/pirs-host \
  --installation /absolute/path/local-installs/INSTALLATION_ID
```

Installed mode accepts only `event:` envelopes through the existing `run`
contract. Raw sandbox calls require the explicit `--qualification-only` flag
with `--plugin`. That mode is for isolated sandbox tests. The shipping event
consumer accepts only an installation and rejects raw-mode readiness.

## Host event enforcement

The Rust runtime parses event requests and applies the installed subscription
before creating a Store or instance. Denied events return `ok:true` and
`filtered:true`, with no result or guest logs and zero guest memory. Invalid
requests return `invalid_request`. The supervisor persists progress for both
delivered and filtered sequences, and emits separate `delivered` or `filtered`
receipts after syncing the cursor.

For `collections: ["*"]`, subscribed envelopes retain their original event
data. For an NSID list, only commits with at least one matching operation reach
the guest. The host projects the envelope to `seq`, `type`, `time` and `evt`,
whose fields are `repo`, `rev` and matching operations with `path` and `action`.
It removes CAR blocks, blobs, CIDs, unknown fields and denied operations. Even a
single-collection commit's opaque CAR can contain other records, so the host
does not pass it through. Scoped observers receive operation metadata; record
reading is a separate capability. Delete operations follow the same rule.
Sync CARs have no collection boundary, and identity/account events name no
collection. They require `["*"]` to be delivered.

Consumer cursor version 2 binds the stream and sequence to `installationId`.
A changed artifact or manifest requires a separately reviewed cursor path;
the old cursor remains untouched. Version 1 cursors fail explicitly. Preserve
them and choose replay policy before starting the installed consumer with a
new cursor. This change does not automate upgrades, disable or remove plugins,
or define lifecycle policy for issue #20.

## Qualification

Build with `python3 build.py` in `service/pirs/host`, then run
`python3 qualify.py`, `python3 qualify-manifest.py`, and from `service/`
`node --test pirs/events/manifest.test.ts`, `pnpm check:events`,
`pnpm qualify:events` and `pnpm smoke`.

The manifest suite uses a guest that echoes every received event byte. It
checks denied data in mixed commits and opaque CAR fields, bypass attempts,
new installation identity and startup tampering. The consumer test checks
filtered durable progress, restart, changed grants and legacy cursor refusal.
Raw reports go to the ignored host target directory. The dated
[qualification record](../qualification/manifest-install.md) records observed
results and boundaries.
