# Commit webhook reference and unresolved local delivery

Issue [#11](https://git.subcult.tv/subculture-collective/pirs/issues/11) requires a
PDS record write to arrive at a local receiver. Issue
[#10](https://git.subcult.tv/subculture-collective/pirs/issues/10) requires
`network.request` to refuse private, loopback, link-local and metadata addresses,
including DNS results and redirects. PR #50 merged that policy. `allowedHosts`
does not override it. The transport also allows only ports 80 and 443.

Those requirements conflict. This reference does not complete #11 or the M1
exit demo. An owner must decide whether to amend the local receiver requirement
or approve a separately specified local transport capability and revise the
two-capability acceptance criterion. This change adds neither an exception nor
a resolver override. A third-party receiver or public deployment is outside the
authorized scope. No successful PDS-to-receiver run is claimed.

## Source and contract

The reference source is `service/pirs/host/webhook/src/lib.rs` and `src/guest.rs`.
The WIT `webhook` world imports only `network.request`. `events.subscribe` is a
manifest grant enforced by the host before instantiation, rather than a guest
import. No diagnostics, WASI, environment, filesystem, sockets or PDS API is
imported. The plugin runs in the existing separate host process.

`build.py` embeds a configured URL, exact collection NSIDs and a disposable
32-byte shared signing key in the component. It emits a matching manifest with
only `events.subscribe` and `network.request`. Do not supply PDS signing keys,
account credentials, admin passwords or a human identity. The artifact and Cargo
build outputs contain the webhook key and must remain private. This example
does not provide secret rotation or a production secret provisioning API.

The host projects collection-scoped commits. The guest projects them again to
sequence, repository DID, revision, time and permitted operation paths/actions.
It sends no record values or CAR blocks. It posts JSON with `content-type:
application/json` and `x-pirs-signature: sha256=<lowercase hex>`. The signature is
HMAC-SHA256 over the exact bytes `pirs-commit-v1\n` followed by the body. The
receiver uses constant-time comparison. Verification authenticates a holder of
the shared key, not a PDS or account signing identity.

Each call makes at most three immediate requests. A 2xx response succeeds.
Transport errors, 429 and 5xx retry; other statuses stop. The host's request and
call deadlines can interrupt the call before all three attempts. A failed call
traps, so the existing supervisor does not advance its durable cursor. It stops
and needs operator intervention. Restarting can replay the event and renew the
per-call attempt budget. There is no persistent guest retry counter, backoff
timer or autonomous retry queue. After successful delivery but before cursor
sync, a crash can repeat a notice. A production receiver would need durable
deduplication using repository and revision, and an explicit replay policy.
The example verifier has neither feature.

## Reproduce reference checks from a clean checkout

Use the repository's Rust toolchain with the `wasm32-wasip2` target already
available, Python 3 and the pinned Cargo lockfile. No global installation is
part of these steps. From the repository root:

```sh
cd service/pirs/host
cargo test --locked -p pirs-commit-webhook
cargo build --locked --release -p pirs-plugin-host
python3 webhook/qualify.py
```

The qualification creates temporary private configuration with a generated
disposable key, builds the component, installs it through the real manifest
installer, checks its imports and exercises the production network path with
`http://localhost/notice`. That call must fail. A matching event traps, unrelated
collections and account events are filtered, and removing the network grant
prevents installation. The script writes `target/webhook-qualification.json`.
Signature and tamper checks use the same independently computed vector as the
Rust tests. Retry outcome tests use a native callback to test plugin logic.
They do not replace network delivery acceptance.

## Build a configured example

The following builds the same denied local destination with a new disposable
key. Run from `service/pirs/host`. Keep the generated directory outside Git:

```sh
umask 077
example_dir=$(mktemp -d)
python3 - "$example_dir/config.json" <<'PY'
import json, secrets, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    "url": "http://localhost/notice",
    "key": secrets.token_hex(32),
    "collections": ["app.bsky.feed.post"]
}))
PY
python3 webhook/build.py --config "$example_dir/config.json" --output "$example_dir/build"
target/release/pirs-host --plugin "$example_dir/build/plugin.wasm" \
  --manifest "$example_dir/build/manifest.json" --install-dir "$example_dir/installs"
```

The install output contains the installation path. The existing event consumer
accepts it via `--installation`; its socket and cursor contract is documented
in `service/pirs/events/README.md`. Attaching this plugin to that consumer will
fail at the first matching commit under the current network policy. It cannot
produce the required successful demo.

`python3 webhook/receiver.py --config "$example_dir/config.json" --port 8080`
starts the loopback-only verifier at `/notice` for receiver development. Port
8080 avoids a privileged listener. The production host denies both that port
and loopback destinations. Starting this verifier does not make the plugin
deliverable, and direct client calls to it do not qualify #11.

## Evidence scope

The recorded checks cover source build, manifest/import enforcement, notice
projection, signing and tamper rejection, bounded retry logic, and a denied
local destination in the installed WIT runtime. The repository smoke gate
checks disposable PDS account and record events independently. Neither check
is a PDS-write-to-local-receiver success. Section 8 of the spec retains that gap.
