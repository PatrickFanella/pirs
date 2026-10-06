# Plugin XRPC service proxying

The separate Node HTTP supervisor in `service/pirs/xrpc/server.ts` verifies
service authentication before invoking an installed WIT component. It uses
the PDS's existing `atproto-proxy` behavior. It adds no PDS package patch,
adapter or PDS listener route.

## Per-server service identity

One supervisor runs one operator-installed plugin. Give it a dedicated
service DID with a DID-document service entry named `#pirs`. The operator
supplies the DID at startup. `pirs` is the default convention, rather than a
registered atproto service type. The CLI requires the service ID explicitly
and accepts another ID when it matches the published document.

For example, the DID document for an operator-owned
`did:web:plugins.example.net` contains:

```json
{
  "id": "did:web:plugins.example.net",
  "service": [
    {
      "id": "#pirs",
      "type": "PirsPluginService",
      "serviceEndpoint": "https://plugins.example.net"
    }
  ]
}
```

The document must satisfy the resolver's normal DID-document requirements.
This example is an addressing convention, not a deployed identity. Publish
the endpoint through operator-managed HTTPS ingress to the supervisor's
loopback listener. The client sends its PDS access credential to its PDS and
`atproto-proxy: did:web:plugins.example.net#pirs`. The PDS resolves that entry
and signs a service token on behalf of the account. The host needs public
issuer keys, never account signing keys or the PDS admin password.

The [current XRPC specification](https://atproto.com/specs/xrpc) recommends a
service-fragment audience. The pinned `@atproto/pds@0.5.37` package emits a
bare DID in `pipethrough.js`, including in the hook-only carrier. Strict mode
accepts only the configured `DID#service-id`. To use the pinned PDS, the
operator must explicitly pass `--legacy-bare-audience`. That also accepts
the exact configured bare DID. It never accepts another DID or another
fragment. A legacy audience does not distinguish service entries on one
DID, so dedicate that DID to this plugin service. Remove the compatibility
option after qualifying a PDS that emits fragment audiences.

This decides addressing for per-server installs only. Issue #18 still owns
per-account installation and grants. No per-account service identity,
account membership authorization, record access or full level 1 conformance
follows from this contract.

## Installation and invocation

```json
{
  "schemaVersion": 1,
  "id": "example-xrpc",
  "minSpecLevel": 1,
  "hooks": ["xrpc.serve"],
  "capabilities": [
    {"name": "xrpc.serve", "constraints": {"nsids": ["net.example.getStatus"]}}
  ]
}
```

The nonempty NSID list is exact, unique and limited to 64 methods. Wildcards,
unknown constraints and the reserved `com.atproto.*` and `app.bsky.*`
namespaces are refused. `xrpc.serve` requires level 1 and the matching hook.
Event subscriptions can coexist and still require matching `event.*` hooks.
Other level 1 capabilities remain unsupported. The existing installer checks
all imports, WIT exports and pinned bytes without instantiating the guest.
`xrpc.serve` needs no new guest import.

Build the host, install with the existing local manifest command, then run:

```sh
rtk proxy node service/pirs/xrpc/server.ts \
  --host /absolute/path/pirs-host \
  --installation /absolute/path/installs/INSTALLATION_ID \
  --service-did did:web:plugins.example.net --service-id pirs \
  --legacy-bare-audience --port 3001
```

Add `--state-dir /absolute/private/plugin-state` only for a plugin with KV
grants. Startup obtains NSIDs from the Rust runtime's verified in-memory
manifest. Mutable source files are not a second routing authority. A host
without an XRPC grant fails before opening the HTTP listener.

The supervisor accepts GET queries and JSON POST procedures. The guest's
existing WIT `run` export receives `xrpc:` followed by JSON:

```json
{
  "nsid": "net.example.getStatus",
  "method": "GET",
  "issuer": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  "query": "limit=10",
  "body": null
}
```

`query` is the raw query string without `?`. `body` is parsed JSON or null.
The guest returns a JSON string, which becomes the response body with HTTP
200. It cannot set HTTP status, cookies, redirects or headers. Authorization,
cookies and other incoming headers never enter this envelope. Guest logs
remain internal to the bounded runtime response and are not sent to clients.
The Rust runtime independently refuses malformed envelopes and undeclared
NSIDs before creating a Store or guest instance.

The JSON-lines runtime protocol is a private trusted-supervisor boundary.
Operators must protect installation paths and process stdin. A caller with
access to runtime stdin is inside that boundary; the Rust process does not
resolve DIDs or verify JWTs itself.

## Authentication, limits and errors

The host accepts `did:plc` account issuers and resolves their `#atproto` public
key using the SSRF-protected upstream resolver and PLC directory. Other issuer
DID methods are refused in this scoped implementation. It checks ES256 or
ES256K signatures, JWT type, the permitted key ID, exact audience, method,
finite integer creation/expiry dates, a maximum 60-second lifetime and a nonce.
Creation times have five seconds of clock tolerance. Expiry is checked again
after resolution and body reading, immediately before guest invocation.
Signature verification retries a refreshed key through the upstream library.
Resolver failures refuse authentication.

The process remembers at most 4096 issuer/nonce pairs until expiry and rejects
reuse. That replay cache is volatile and local to one supervisor. Restart or
multiple replicas need a separate durable/shared replay policy before hosted
qualification. The host does not infer account status from a signature; the
PDS performs its account checks when proxying a request.

Only one HTTP request at a time can resolve, read input or invoke the guest.
Overload returns 503 without an invocation queue. Headers, token, URL and
body limits are 8192, 4096, 8192 and 8192 bytes. POST requires JSON and rejects
compressed input. Slow input is disconnected after five seconds. Each DID
resolution attempt has a three-second timeout. At most 32 connections are
accepted, with a one-second idle keep-alive timeout.

The runtime gets an empty environment, a Linux parent-death signal, a 16 MiB
guest-memory ceiling, a 250 ms guest deadline, a 4096-byte encoded result
limit, a 1024-byte encoded log limit and a 65536-byte encoded request limit.
Its supervisor bounds output and kills an unresponsive runtime after five
seconds. Limits cover guest linear memory and execution; total process RSS,
compilation and OS filesystem/network latency have their existing limits.
An unavailable runtime requires an operator restart. Guest traps and limits
leave the same runtime able to accept the next request.

| Condition | HTTP | XRPC `error` |
| --- | --- | --- |
| Missing authentication | 401 | `AuthenticationRequired` |
| Invalid signature, claims, issuer, expiry or replay | 401 | `InvalidToken` |
| Undeclared method | 400 | `MethodNotImplemented` |
| Malformed input | 400 or 405 | `InvalidRequest` |
| Oversized body | 413 | `RequestTooLarge` |
| Guest trap | 500 | `PluginFailed` |
| Memory, result or log quota | 500 | `PluginLimitExceeded` |
| Non-JSON guest result | 500 | `PluginInvalidResponse` |
| Guest deadline | 504 | `PluginTimeout` |
| Busy request or full replay cache | 503 | `PluginBusy` |
| Runtime exit, protocol failure or supervisor response timeout | 503 | `PluginUnavailable` |

Errors contain a bounded code, without token contents, plugin logs or stack
traces. Network/KV writes committed before a later guest failure are not
rolled back. This service grants no level 2 or deciding hooks.

## Verification

From `service/`, run `pnpm check:xrpc` and `pnpm qualify:xrpc` after the locked
host build. The test uses disposable PDS state, an account created through its
public API, a local PLC fixture and real service signatures. Only the test
resolver and PDS development mode permit local fixture transport. The CLI's
production resolver has no loopback override. The
[qualification record](../qualification/xrpc-service.md) states the observed
results and remaining deployment boundaries.
