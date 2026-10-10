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

## Current-revision browser conformance, 2026-10-10

The corrected HTTP implementation passed local browser conformance on source
`c60e8d5a87cfcd85bfacc35ec3f363d73f8471c7`. The only working-tree changes during
the run were qualification records and CI wiring; no runtime source changed.
The [browser evidence](plugin-http.browser.json) retains the installed identity,
artifact hashes, DOM observations, browser version, network log and action times.
This run checks the current implementation; it does not rerun the vulnerable
implementation to establish a new before/after regression comparison.

T3's Chromium 154 browser first opened the disposable session fixture. Its
baseline `/session` request returned 200 with the canary cookie, producing one
total and one authenticated session call. It then followed the fixture's link
to the separately installed hostile component. The ordinary, `_top`, new-window
and encoded anchor elements were each clicked, followed by the inert form
button. Every click left the URL at `http://127.0.0.2:43142/hostile`; no new tab
opened and the session counters remained one total and one authenticated call.
The original two-second refresh interval also elapsed without a session call.

The visible marker remained `script did not run`. Read-only DOM inspection found
no href, target, ping, action, src, style or onclick attributes and no script,
form, iframe, image, meta, base, SVG, MathML or style elements. Reading
`document.cookie` threw `SecurityError` because the sandbox lacks
`allow-same-origin`. Inspection did not insert or modify attack markup. Clicking
the details summary revealed its content; headings, the list, strong emphasis
and the table retained their HTML semantics. The attacks came from the built
and installed component, not browser-injected content.

Local checks passed with Rust 1.95.0, Node 24.18.0 and pnpm 10.34.1:

- Locked release host and all fixture builds through `python3 pirs/host/build.py`.
- `pnpm exec tsc -p pirs/http/tsconfig.json`.
- `node --test pirs/http/*.test.ts`: five passing tests, including installed
  credential exclusion, route isolation, HTTP limits and native denial/recovery.
- `pnpm smoke`: real disposable account/record flow, cursor 4 to 5.
- `node --test pirs/smoke.test.ts`: both success and rejected-write cleanup tests.

The host workflow now watches HTTP source and qualification paths and runs the
HTTP type check and these five tests. Hosted execution of that new step remains
pending. This evidence qualifies the local static HTML contract only. Public
ingress, a real PDS/OAuth session, script-enabled HTML and other browser engines
remain unqualified.

The owner subsequently reported that all controls behaved as expected during
the optional manual Preview check. The canary readback still showed one total
and one authenticated session call. SIGTERM then stopped the disposable fixture.
