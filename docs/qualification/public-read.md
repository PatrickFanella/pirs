# Public-read qualification

On 2026-10-06, the separate installed Wasmtime guest passed the disposable
public-read harness against unmodified `@atproto/pds` 0.5.37 and the currently
selected pinned package. Neither run attached a Pirs bridge or transport adapter.
Both used two accounts with signed PLC genesis operations and temporary storage.
The stock package was selected by an explicit absolute module path, without
changing dependency pins or installation files.

Each run passed 38 calls in one serving host, plus direct installed-host reads
against the real PDS endpoint and raw-mode refusals. The forwarding test listener
relayed real PDS responses to inject lifecycle changes and hostile wire cases.
It is test-only and grants no exception in the shipping host.

Verified cases include:

- Real allowed record JSON and exact blob bytes, and reads from a second local
  active account. Undeclared collections, handles and path traversal fail before
  PDS I/O. A nonexistent DID fails the local account check.
- A known CID cannot authorize a blob in another account, an undeclared
  collection, a missing record or a record with only an untyped link.
- Real account self-deactivation, admin deactivation and account takedown refuse
  record and blob reads. The stock PDS represents suspended accounts with its
  account takedown field. An explicit synthetic `suspended` status is also refused.
- Real record and blob takedowns, reference removal, account deactivation and
  unrelated repository revision changes during reads fail before guest delivery.
- A 64 KiB blob succeeds and a 64 KiB plus one byte blob fails. Oversized record
  JSON, unknown-length response overflow, the eight-operation quota and the
  128 KiB invocation budget are enforced. Redirects are refused.
- A delayed HTTP response reaches the host deadline. The next read succeeds
  in the same runtime. Missing PDS configuration fails before readiness;
  uncovered imports and invalid collection grants fail installation.
- The runtime environment is empty. Guests receive JSON/bytes and fixed errors;
  no database interface, credential or internal path is linked.

The existing native, sandbox, manifest, KV, XRPC, event-delivery and PDS smoke
checks also passed locally. Hosted CI and production deployment have not been
qualified by this work. The HTTP rechecks are not a cross-process transaction.
The [contract](../spec/public-read.md) records that visibility observation limit,
the co-located PDS requirement and the absence of enumeration and historical reads.

From `service/pirs/host`, build with `python3 build.py`. From `service`, run:

```sh
pnpm exec tsc -p pirs/public-read/tsconfig.json
node --test pirs/public-read/public-read.test.ts
```

Use `PIRS_READ_PDS_MODULE=/absolute/path/to/stock/dist/index.js` for the stock run.
`PIRS_READ_REPORT=/absolute/path/report.json` retains hashes and acceptance flags.
The harness removes its PDS data, signed local identities, installs and processes.
Evidence is retained in the authorized audit workspace under `chunks/7/pirs15-*`.

## Readiness blocker found during review

Independent review on 2026-10-06 reproduced three late-recheck races against
a real local PDS. A buffered final active-account response allowed record
delivery after account deactivation. Buffered second blob responses allowed
blob delivery after owning-record or blob takedown; the account remained active
at the same revision. Anonymous reads after those takedowns were refused.
The probes reproduced on the tree integrated with the HTTP sandbox changes.

The positive harness above qualifies sampled HTTP checks, not strict visibility
at guest delivery. Public-read readiness remains blocked pending a consistent
PDS authorization boundary or an explicit owner decision accepting sampled
visibility. Adding more separate HTTP rechecks cannot establish that boundary.
PR #54 and issue #15 must remain open under the current acceptance requirement.
