# Local plugin HTTP qualification

The implementation and fixtures are under `service/pirs/http/`. The
[origin decision](../decisions/0002-plugin-http-origin.md) records the static HTML
contract and the unresolved public ingress qualification.

From `service/`, build with `python3 pirs/host/build.py`, then run
`pnpm exec tsc -p pirs/http/tsconfig.json` and
`node --test pirs/http/*.test.ts`. The test installs a WIT component into a
temporary private directory and starts two separate runtime processes. It checks
credential exclusion, exact routing, host confusion, duplicate address rejection,
request boundaries, guest deadline and response failure recovery. Direct runtime
calls test grant enforcement before guest allocation, installed 1 ms deadlines,
16-byte HTTP body grants, CLI tightening, ABI overhead and denial/recovery.
HTML tests cover encoded and malformed navigation, foreign trees and semantic
formatting. Incomplete-header and stalled-body sockets are tested separately. No PDS process loads Wasm.

Run `node pirs/http/browser-fixture.ts` for the disposable browser page at
`http://127.0.0.1:43141`. It creates a synthetic cookie session canary. This is not
an account, PLC identity or production PDS login. Its `/session` endpoint checks
the cookie and records every attempt. The initial page makes one authenticated
baseline request. Open the installed hostile plugin at
`http://127.0.0.2:43142/hostile`. Its visible marker must remain "script did not
run" and the canary counters must remain at the baseline. Click the ordinary,
_top, new-window and encoded link labels and the inert form button. None may
navigate or contact the canary. Open the details control and verify the heading,
list, emphasis and table render as HTML. Guest href/target/ping/action attributes,
scripts, frames, images and refresh must be absent in the served DOM. Read-only
automation inspection is allowed; inserting hostile DOM is not this regression.
The exact installed component supplies every attack. Verify the counters and
opaque-origin cookie denial, then stop the fixture. SIGTERM removes its
installation and listeners.

On 2026-10-06, T3's browser rendered the installed hostile page after one
successful authenticated baseline request. The page retained "script did not
run". Browser security diagnostics blocked script execution, meta refresh,
images, framing and the clicked form submission. The session endpoint recorded
one total request and one authenticated request before and after the hostile
page. That run did not cover ordinary anchor navigation. Independent review then
installed a component with a PDS link and reproduced a credentialed call after
a click. The prior run alone did not establish the full navigation boundary. Raw browser snapshots, screenshots,
installation identity and exact-head logs are retained in the issue audit status
record. Public DNS, production ingress and script-enabled pages remain unqualified.
