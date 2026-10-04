# Resumable event delivery

Issue [#8](https://git.subcult.tv/subculture-collective/pirs/issues/8) adds
post-commit delivery to the separate WIT host selected in #6 and implemented
in #7. No plugin executes inside the PDS and no delivery acknowledgement is
part of an account or record write.

## Transport and cursor contract

Set `PIRS_EVENT_SOCKET` on the PDS to an absolute Unix-socket path. Delivery is
disabled when it is absent. The socket parent must be owned by the process
user and have mode 0700; the socket is mode 0600. Use a dedicated transport
directory, outside the PDS data directory. No event route is added to the PDS
HTTP application. Keep the existing status route's counters-only boundary.

The private `GET /events?after=N` service calls the sequencer's
`requestSeqRange({ earliestSeq: N, limit: 1 })` and returns retained events in
ascending sequence order. Its envelope is `{stream, after, events, full}`.
Each event contains `seq`, `type`, `time` and `evt`. CAR byte arrays use
`{"$bytes":"base64"}`; CIDs retain their JSON link representation
`{"/":"cid"}`. No account database, signing key, rotation key, session token
or admin password is included.

Buffering is bounded to one active range response, at most 32 events and
256 KiB of encoded JSON. Excess simultaneous requests receive 429 and retry;
a disconnected reader keeps its slot until the outstanding query finishes.
Idle sockets time out after five seconds; at most four connections are open.
When a page fills, unreturned events remain in the sequencer for the next
request. An encoded event larger than 128 KiB yields preceding events first,
then 413 at that event. It blocks delivery without advancing the cursor;
there is no silent drop policy. These limits bound the delivery page, not the
upstream database or the temporary decoding of one upstream event.

The host-side consumer is a separate Node process. It reads one page at a time
and calls the separate Rust runtime sequentially with
`{id: seq, input: "event:" + JSON.stringify(event)}`. Its runtime receives an
empty environment and pipe descriptors, with the existing memory, deadline
and output limits. The runtime's optional Linux parent-death signal prevents
an orphan serving process after the supervisor is killed. Standalone host
calls retain their previous defaults; the supervised consumer allows up to
1 MiB of encoded input to accommodate event JSON escaping.

Only a successful guest response advances the consumer's cursor. The cursor
file contains `{version: 1, stream, seq}`; storage writes a mode-0600 temporary
file, syncs it, renames it, and syncs its directory before emitting a delivery
receipt. A private local lock socket excludes a second consumer sharing that
cursor. A Linux abstract-socket reservation serializes startup and stale-socket
recovery; the kernel releases it on process death. Stale filesystem sockets
recover without replacing ordinary files or a live listener. Invalid cursors
and a changed stream stop delivery.
The reservation applies within a Linux network namespace. Run competing owners
of a given socket in the same namespace; cross-namespace replica startup is
outside this qualification.

A crash after the guest call but before the durable cursor can repeat an
event. Plugins must tolerate duplicates. Transport outages retry from the
saved cursor; plugin, cursor or protocol errors stop without skipping ahead.
The stream identity persists in the private transport directory. When
replacing the PDS dataset, create a new transport directory/stream rather than
reusing that identity. This protocol resumes retained, non-invalidated
sequencer events; upstream account deletion, invalidation and retention can
remove history. It is not an indefinite independent event archive.

## Local qualification

Commands from `service/`:

```sh
pnpm install --frozen-lockfile
python3 pirs/host/build.py
python3 pirs/host/qualify.py
pnpm check:events
pnpm qualify:events
pnpm smoke
node --test pirs/smoke.test.ts
```

The October 4 local process run used disposable PDS data, generated secrets
and a loopback PLC fixture. It created one account and 162 records: 166
sequenced events including identity, account, sync and commit. The guest
reported every sequence from 1 through 166 in nondecreasing order.

The first backlog contained 74 events. The consumer was stopped mid-page,
40 writes completed while it was stopped, and the consumer and PDS were
killed and restarted with their disposable persistent state. Delivery resumed
from the saved cursor. A second PDS kill while the consumer remained running
also recovered. Killing the Rust runtime stopped the consumer without moving
the cursor; a restarted consumer delivered the pending event.

The acknowledgement-boundary probe modifies filesystem rename only inside a
qualification child. Sequence 156 successfully called the guest, then the
child stopped before its cursor rename and was killed. Restart replayed that
sequence. The shipping consumer contains no fault-injection switch.

Forty stopped-host and forty running-host writes use the same API workload.
The harness requires stopped-host maximum latency below one second and p95
within five times running p95 plus 20 ms. This catches a blocking delivery
dependency; it is not a production latency SLO. Exact measurements, artifact
hashes and checks are in [the local report](event-delivery.measurements.json).

Four focused bridge tests cover byte overflow with 70 events, retry from
each page, request overload after disconnect, oversized-event blocking,
invalid cursors, socket permissions, ordinary-file preservation and duplicate
listener rejection and simultaneous startup ownership. The process harness additionally verifies exclusive
cursor ownership, changed-stream rejection, an empty runtime environment,
kernel cleanup after supervisor death, both public event paths returning 404,
and an unchanged disposable operator sentinel. All children, listeners and
temporary fixture data are cleaned up.

The existing 29-call adversarial host qualification and PDS account/record
smoke still pass, as do both smoke cleanup checks, Rust formatting, Clippy
and strict TypeScript checking. Hosted results are recorded in the delivery
PR after the final source head finishes its checks.

## Limits of this evidence

The process-kill tests establish restart and replay behavior on Linux using
retained local sequencer data. They do not prove power-loss recovery on every
filesystem, public-hostname behavior, indefinite retention or production
load. The private stream and cursor directories must remain recoverable.
Manifest filtering, outbound grants and the commit webhook plugin are later
issues. No production PDS, Prichal deployment or public identity was changed.
