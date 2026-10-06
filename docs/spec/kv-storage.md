# Plugin key-value state

Issue #16 adds host-owned durable state. A plugin can import
`pirs:sandbox/kv-read@0.1.0` for `get` and `list`, and
`pirs:sandbox/kv-write@0.1.0` for `set`. Each interface requires its matching
`kv.read` or `kv.write` manifest capability with `{"quotaBytes": 1048576}`.
The installer rejects unknown constraints, noninteger quotas, quotas below
2 or above 1048576 bytes, mismatched read/write quotas and ungranted imports.
Raw qualification mode grants neither capability.

`get` returns an optional byte array. `list` returns sorted keys starting with
the supplied prefix. `set` replaces a byte array, or deletes the key when the
value is absent. Keys are nonempty UTF-8 strings of at most 256 bytes. Prefixes
may be empty and have the same byte bound. There are no other queries.
A listing exceeding 256 keys or 65536 encoded JSON bytes returns an error;
use a narrower prefix. Each guest call may make at most 128 KV operations.

The quota counts the complete compact JSON file, including keys, punctuation
and decimal byte-array encoding. An empty object costs two bytes. Thus a
byte value can cost more than one quota byte. A rejected write leaves the
previous value intact. Replacement and deletion reclaim space. The host
checks the complete prospective state before writing a private staging file,
syncing it, renaming it to `state.json`, and syncing the namespace directory.
Before opening state, the host syncs the parent of every directory entry in
the root and namespace path, including newly created root ancestors. A sync
failure aborts opening state. Retries also sync existing entries left by a
failed or concurrent creation. Reads use the last committed state. Staging left by a crash is ignored and
replaced on the next write. A successful write is durable before the guest
receives success. KV writes are independent of event cursor persistence;
replayed events must use idempotent keys or handle repeated writes.

## State location and backup scope

Launch a KV-enabled installation with an absolute `--state-dir` path, or pass
that option to the event consumer. The consumer forwards it to the separate
host. Example host arguments:

```sh
pirs-host --installation /srv/pirs/installs/INSTALLATION_ID \
  --state-dir /srv/pirs/plugin-state
```

Use an owned private directory on local storage, outside every PDS data
volume, database and blob store. The host receives no PDS data path. Run it
as a separate user without PDS directory permissions. Directory placement
and OS access control remain operator responsibilities. The root and its
ancestors must be trusted, and the host must have exclusive write ownership.
New namespace directories have mode 0700 and files mode 0600. State file and
lock symlinks are rejected. This is not an OS sandbox against a malicious
operator.

The namespace is the manifest plugin ID, never a guest-supplied path or the
artifact checksum. Updating that plugin ID's installation preserves state;
changing the ID creates a separate namespace. Stop the old host before an
update. An exclusive nonblocking file lock permits only one host or operator
state command per ID. The lock file remains in the root after deletion so
concurrent processes cannot obtain different lock inodes. The directory tree
is `STATE_ROOT/PLUGIN_ID/state.json`, plus private `.PLUGIN_ID.lock` files.

Back up the complete state root separately from the PDS backup, together
with installed manifests/receipts and event cursors. Stop the affected hosts
before copying or restoring it. Retain state for every active manifest ID;
restoring a PDS database alone does not restore plugin state. Do not restore
a quota smaller than the saved state without operator review. The host rejects
oversized or malformed saved state. These commands have not been exercised
on a production deployment.

## Export, deletion and uninstall

Stop the plugin host first. All commands below also require `--installation`
and `--state-dir` as above. Exports contain the exact compact state object,
with byte arrays as decimal JSON arrays. Exports can contain plugin secrets;
the host creates a private file, refuses overwrite and does not print values.

```sh
pirs-host ... --state-command export --export-path /backup/plugin.json
pirs-host ... --state-command delete
pirs-host ... --state-command uninstall --state-action retain
pirs-host ... --state-command uninstall --state-action export \
  --export-path /backup/plugin-before-uninstall.json
pirs-host ... --state-command uninstall --state-action delete
```

`delete` removes the namespace and leaves the installation. Its next start
has empty state. `uninstall` refuses to run without an explicit state choice.
Export completes before removing the installation and retains state. Delete
removes state before removing the installation. Retain removes only the
installation. Delete and retain do not parse or quota-check saved state, so
they remain available after corruption or a reduced grant. Export still
requires valid state within the current quota. Export failure leaves the
installation present. The commands
verify installed checksums and hold the namespace lock throughout. Uninstall
removes only that content-addressed installation; other versions with the
same plugin ID share the retained state. This implements the #16 state
choice, not upgrade, disable, or cursor policy for #20.

Filesystem operations can block on the OS. The call deadline is checked
before KV work and on return from the guest, but it cannot interrupt an
in-progress filesystem sync. Use local storage. A write can commit before
a later guest trap or timeout, so failed calls do not roll back KV state.

## Validation

From `service/pirs/host`, run `python3 build.py`,
`cargo test -p pirs-plugin-host --locked`, and `python3 qualify-kv.py`.
The latter uses verified installed components and the shipping operator
commands with disposable state. It does not use a test-only storage backend.
