# Outbound plugin requests

`network.request` is a level 0 host capability. Local installation approves an
exact manifest, including its grant. Operator policy management remains #20.

```json
{"name":"network.request","constraints":{"allowedHosts":["example.com"]}}
```

The list contains 1 to 32 unique lowercase ASCII DNS names. Each label has
1 to 63 letters, digits or hyphens, starts and ends with a letter or digit,
and the name is at most 253 bytes. Wildcards, trailing dots, IP literals,
URLs, ports and unknown constraints fail installation. URL parsing normalizes
hostnames before exact comparison. Subdomains need separate entries.

The WIT interface is `pirs:sandbox/network@0.1.0`. `request` takes a method,
URL, header pairs and body bytes and returns either a status/body record or a
fixed error string. It supports GET, HEAD, POST, PUT, PATCH and DELETE over
HTTP or HTTPS, on ports 80 and 443. Userinfo and fragments are rejected.
Host, proxy, connection and framing headers cannot be supplied by the guest.
TLS uses certificate and hostname verification with the bundled public roots.
There is no client certificate, cookie store, environment proxy or ambient
credential API. Response headers are not exposed.

Every destination is checked before transport. The resolver refuses a name
if any answer is private, loopback, link-local, shared address space,
multicast, reserved, documentation or a prohibited IPv6 transition address.
IPv6 accepts conservative public unicast in 2000::/3, excluding special ranges.
The transport connects to the checked answers and keeps the hostname for Host
and TLS SNI. It does not resolve the name again at connect time. The complete
request is cancelled at its deadline. libc DNS itself cannot be interrupted,
so two semaphore permits remain inside outstanding libc lookups until they
finish. Later requests wait within their deadline, without adding DNS work.
This is not a bound on OS resolver completion time.

The host follows at most five 301, 302, 303, 307 or 308 redirects. Every next
URL goes through the same grant and DNS checks. HTTPS downgrades are denied.
Headers are dropped on every redirect, and a request carrying a body cannot
redirect to another origin. POST changes to GET on 301/302; 303 changes to
GET and removes the body. There are no plugin-controlled retries.

Each guest call permits eight network invocations, including denied attempts.
Each request permits a 2048-byte URL, 32 headers totalling 8192 name/value
bytes and a 16 KiB body. A response permits 64 KiB of body, checked both at
Content-Length and while streaming unknown-length bodies. Compression is
disabled. HTTP/1 uses the pinned Hyper parser's bounded native buffer.
Each network invocation shares the guest call's absolute deadline and has a
five-second maximum across DNS, TLS, redirects and body reads. The existing
guest memory, output and log quotas still apply. Scheduling can add latency;
this is not a hard real-time guarantee.

An undeclared network import fails before installation or instantiation.
The callback independently requires the loaded installation grant, including
during guest startup. Raw qualification mode has no network grant. WASI HTTP,
sockets, environment, filesystem and all unrecognized imports remain unlinked.
The host clears inherited environment state and runs outside the PDS process.
It exposes no signing keys, admin credentials or account database handles.

## Qualification fixtures

`cargo test -p pirs-plugin-host --locked` uses a test-only resolver to route a
fictional public name to a disposable loopback listener. It runs the production
HTTP loop and limits, with an injected transport address only in `cfg(test)`.
That fixture is not evidence of public routing or TLS. Its second hostname
passes through the production address classifier with a loopback answer.
There is no fixture switch or resolver override in the shipping executable.

`python3 qualify-network.py` installs a real WIT guest with disposable files,
uses the shipping resolver and transport for a credential-free HTTPS GET to
example.com, and checks local DNS, metadata, undeclared imports and recovery.
It records an explicit gate if the external GET fails. This does not qualify
#11's webhook signature, receiver, retries or PDS integration. A local webhook
receiver must use a test-only transport fixture or a separately qualified public
receiver. It must not add a loopback exception to this policy.
