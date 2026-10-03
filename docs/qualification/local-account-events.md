# Disposable account event qualification

Issue: [#3](https://git.subcult.tv/subculture-collective/pirs/issues/3).
Observed locally on Kvant on 2026-10-03, Node 26.10.0, pnpm 10.34.1,
`@atproto/pds` 0.5.36.

## Run

From `service/`:

```sh
pnpm install --frozen-lockfile
pnpm smoke
node --test pirs/smoke.test.ts
```

The smoke script starts a temporary PDS and a PLC fixture, both bound to
`127.0.0.1`. The PLC URL is `http://localhost:<ephemeral port>`: the PDS's DID
resolver rejects IP-literal hosts even with development mode enabled. The
fixture accepts one signed creation operation, validates its signature and DID
hash with `@did-plc/lib` 0.0.4, and serves the DID document from memory. It does
not implement PLC updates, recovery, or a public directory.

The script discards inherited `PDS_*` settings before supplying temporary
storage, generated secrets, the fixture URL, a localhost service hostname,
development mode, and disabled invites. It creates `smoke.test` using
`com.atproto.server.createAccount`, then writes an `app.bsky.feed.post` through
`com.atproto.repo.createRecord` with the returned session token. Credentials
and event bodies are not printed. The effective PLC URL is asserted against
the fixture URL, and the fixture confirms a creation and a DID-resolution read.

Local output:

```text
afterAccount: 4
afterWrite: 5
counts: { commit: 2, sync: 1, identity: 1, account: 1 }
plc: { documents: 1, reads: 1 }
```

The second commit and advancing cursor are checked after the record write,
separately from the initial repository commit created with the account.

## Cleanup evidence

Both cleanup tests passed. Each runs the smoke in a child process with its own
temporary directory and disposable operator-state sentinel. One permits the
write. The other changes the outgoing record's text to a number, so the real
public API returns 400 after the account already exists; the child exits 1.
After both exits, the tests confirm:

- The smoke's PDS directories have been removed.
- The in-memory PLC listener and PDS listener no longer answer.
- The supplied operator-state sentinel is unchanged.
- Inherited public PLC, entryway and SMTP settings did not determine the run.

The Gitea smoke workflow also runs these cleanup tests after `pnpm smoke`.
Hosted run evidence is recorded in the PR after its checks finish.

## Proof boundary

This verifies the bridge's local persisted-event seam using real account and
record API calls against a bounded identity fixture. It does not qualify a
public PLC directory, production account provisioning, resumable host delivery,
a plugin, or any deciding hook. The production PDS entrypoint and bridge are
unchanged. The PLC library is an explicit development dependency at the same
version already used by the PDS.
