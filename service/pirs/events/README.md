# Local event delivery

This is the post-commit transport and host-side consumer for
[issue #8](https://git.subcult.tv/subculture-collective/pirs/issues/8).
It does not reject writes or run plugins in the PDS process.

## Run separately from the PDS

Set `PIRS_EVENT_SOCKET` on the PDS to an absolute path in a dedicated owned
directory with mode 0700, for example `/run/pirs-events/events.sock`. The PDS
creates a mode-0600 Unix socket there and stores the stream identity beside
it. Delivery is disabled when that variable is absent. Both processes need
access to this private directory; the WIT guest has no filesystem import.

Build the host as described in [its README](../host/README.md), install the local
component and [manifest](../../../docs/spec/local-manifest.md), then start the
consumer from `service/` in a separate process:

```sh
node pirs/events/consumer.ts \
  --socket /run/pirs-events/events.sock \
  --cursor /var/lib/pirs-host/cursor.json \
  --host /absolute/path/pirs-host \
  --installation /absolute/path/local-installs/INSTALLATION_ID
```

The cursor parent must also be owned with mode 0700 and must be separate from
the PDS data directory. A new cursor starts at zero. Do not give the host the
PDS environment, signing keys, rotation keys, admin password or database.
The consumer spawns the runtime with an empty environment and pipe descriptors.
The shipping consumer's supervised runtime requires Linux; parent death kills
it even when the consumer is terminated with SIGKILL.

The consumer sends `event:` followed by the sequenced JSON envelope to the
guest's existing `run(string) -> string` WIT call. A successful call or a host-filtered event advances
the synced cursor; failure stops without advancing it. Filtering runs inside
the runtime before guest instantiation. Version 2 cursors bind progress to the
installation ID. Changed installs and version 1 cursors require operator review
and a new cursor path; the consumer preserves existing cursor bytes. Stdout emits readiness
and `{delivered, type, logs}` or `{filtered, type, logs}` receipts after persistence. Guest logs remain
bounded but may contain event data; keep these operational outputs private.
Use SIGTERM for graceful stop. On restart, the same cursor and stream identity
resume retained events. Do not delete them to resolve a delivery failure.

At most one page of 32 events/256 KiB is buffered. Page overflow resumes on
the next request; excess requests receive retryable 429. An event over 128 KiB
blocks at that sequence with 413 instead of being dropped. Cursor or plugin
errors need operator repair. Duplicate calls are possible at a crash before
cursor persistence. Upstream sequencer deletion/invalidation/retention remains
the history boundary. When replacing a PDS dataset, rotate its transport
directory and handle the resulting stream mismatch explicitly.

## Qualify with disposable state

```sh
pnpm check:events
node --test pirs/events/manifest.test.ts
pnpm qualify:events
```

Build the locked Rust host and both fixtures first. The suite starts its own
loopback PLC and disposable PDS, kills/restarts both delivery sides, checks
ordered guest coverage and measures writes with a stopped host. It also tests
the acknowledgement crash window, runtime death, exclusive cursor ownership,
private transport and bounded overflow. The PDS fixture and rename injection
are test-only; they are never loaded by the distribution entrypoint.

Results go to ignored `../host/target/event-delivery.json`. The
[qualification record](../../../docs/qualification/event-delivery.md) documents
the exact protocol, commands, evidence and remaining boundaries.

KV-enabled plugins require `--state-dir /absolute/private/plugin-state` on the
consumer. It forwards that path to the host. See [storage and backup scope](../../../docs/spec/kv-storage.md).
