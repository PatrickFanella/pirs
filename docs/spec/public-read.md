# Public repository reads

The separate host implements `records.read` and `blobs.read` for public account
repositories on one operator-selected local PDS. These are auxiliary capabilities
for existing event and XRPC plugins. They do not grant account write authority or
implement level 2 account consent. Private preferences and Spaces are excluded.

## Manifest and WIT

Each grant requires `{"collections": ["tv.example.page"]}`. Lists contain 1 to 64
unique, exact NSIDs. Empty lists, wildcards and unknown constraints fail install.
Record and blob collections are independent. The installer checks both imports
before instantiation, and each callback checks its installed grant again.

```wit
interface records-read {
  get: func(did: string, collection: string, rkey: string) -> result<string, string>;
}
interface blobs-read {
  get: func(did: string, collection: string, rkey: string, cid: string) -> result<list<u8>, string>;
}
```

The record result is JSON with `uri`, `cid` and `value`. The blob result contains
bytes. No database handle, internal filename, account token or admin credential
enters the guest. Reads take a DID, never a handle, URI, URL or private repository
identifier. DID syntax permits `did:plc` and `did:web`; the local PDS decides
whether the account exists. The qualification uses disposable PLC accounts.
There is no enumeration or historical-CID read operation in this first interface.

## Trusted PDS connection

Start an installed read-capable host with `--public-pds http://127.0.0.1:PORT`.
The event consumer and XRPC supervisor forward the same option. A missing endpoint
fails startup before readiness. Only an HTTP origin with a literal loopback
address is accepted. Paths, credentials, query strings and fragments are refused.
The operator must point it at this PDS's trusted listener. A co-located PDS is
required; remote PDS transport is outside this implementation.

The host sends anonymous GET requests with fixed method names and encoded query
parameters. It disables proxy use and redirects. The guest cannot change the
origin or send headers. This local capability is separate from `network.request`;
its grant does not relax outbound network restrictions.

`com.atproto.sync.getRepoStatus` must report the requested local DID as active,
with a revision and no inactive status. The pinned stock PDS obtains this status
from its local account manager. A remote or nonexistent DID fails even if an
appview fallback is configured. Suspended accounts use the stock account takedown
state. Any inactive status, including deactivation or a future suspension status,
is refused. A record read uses `com.atproto.repo.getRecord`, which excludes record
takedowns. No private API, PDS file access or package patch is used.

## Blob ownership and visibility

A blob read requires all of the following on every call:

- The blob grant declares the exact collection.
- The named account is local and active.
- The current visible record at that DID, collection and key contains a typed
  `$type: "blob"` value whose `ref.$link` equals the requested base32 CID.
- Anonymous `com.atproto.sync.getBlob` serves that CID from the same DID's blob
  store. That stock API excludes blob takedowns.

A CID, untyped link or record from another account cannot substitute for these
checks. Nested blob values are supported. A reference alone cannot grant access
to an absent or taken-down blob. Deleting the record or removing its reference
removes this authorization, even if another collection still references the CID.
A blob shared by two collections is readable through either currently visible
owning record only when that collection is declared.

Before returning, the host re-reads the record, compares its full public response,
and checks that the account remains active at the same revision. Blob reads also
repeat the anonymous blob request and compare bytes. This catches account, record,
reference, revision and blob takedown changes during the tested requests. Reads
have no cache. These HTTP checks are observations, not a transaction spanning the
PDS and host. A change after the final check cannot retract bytes already returned;
an account that changes state and restores it between checks may go unobserved.
Review also reproduced delivery after takedown completed while a final response
was buffered. Account revision equality does not cover record or blob moderation.
The owner accepted these HTTP observation semantics on 2026-10-06 for PR #54.
Data must be public when sampled by the anonymous PDS requests. A later takedown
can race delivery, including while a successful final response is buffered.
Strict visibility at guest delivery is outside this contract. See the
[qualification evidence](../qualification/public-read.md#accepted-http-observation-semantics).

## Bounds

Each imported operation returns at most 64 KiB. Upstream JSON and blob response
streams have the same bound, including responses without Content-Length. Status
responses are capped at 4 KiB. A guest invocation permits eight public-read
operations and at most 128 KiB of successful returned data across both grants.
Retries and failed permitted reads consume the operation count. Scope refusals
perform no PDS I/O. The existing call deadline covers all HTTP work and guest
execution; response, log and guest memory ceilings still apply. Errors are bounded
fixed strings and do not echo upstream bodies, URLs or filesystem paths.
