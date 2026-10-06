# Local plugin XRPC qualification

On 2026-10-06, the issue #13 worktree based on main
`b494bdd3182cc330d819fb73210e23a6ba091dc7` built the locked host and no-WASI
fixtures. Main advanced to `aa04ad1e1d13c00fd9e8dd8eefe356099737203e`
through another process merging PR51. That head was incorporated before final
committed-source checks, preserving its webhook evidence. Its strict TypeScript check and disposable XRPC runtime test passed.

The test created an account through the PDS API and called the installed guest
with GET and JSON POST through `atproto-proxy`. The PDS resolved a service
entry from a local DID fixture and signed the account's service token. The
host resolved the account key from the same local PLC fixture and the guest
returned the verified issuer, method, query and body. The pinned PDS emitted
a bare audience, so this path used the explicit compatibility option. Strict
mode separately accepted a signed fragment audience and refused a bare one.

Signed wrong audience, wrong service fragment, wrong issuer, wrong method,
expired/future/overlong dates and missing method were refused. Invalid
signatures, key IDs, nonce/date shapes, absent authentication and replay were
also refused. Undeclared methods failed through both HTTP and the real PDS.
A direct Rust-runtime bypass attempt failed before guest allocation with zero
guest memory and no logs. Invalid NSID manifests, reserved namespaces,
duplicate methods, wildcard methods, missing hook, wrong level and unknown
constraints failed installation.

Real guest traps, loops, allocation floods, response floods and log floods
mapped to their documented XRPC errors. Each failure was followed by a
successful request in the same runtime. A non-JSON result mapped to
`PluginInvalidResponse`. The echoing guest received no incoming headers or
tokens, and the runtime's Linux environment was empty. POST format, input
size and HTTP-method refusals passed. A stalled resolver confirmed admission
overload and expiration before invocation; a killed runtime returned
`PluginUnavailable`.

The same proxy qualification also passed against the frozen stock
`@atproto/pds@0.5.37` package in a disposable service copy, with the same
committed host and test source. Both dependency tracks retain their previous
resolved dependency graph and add only the direct verification/test imports.

Regression checks passed six native tests, 29 sandbox calls, 32 manifest
checks, 20 KV/operator checks, both installed-consumer tests and event
typechecking. PDS smoke advanced the cursor from 4 to 5. Four bridge tests
and the full event/restart qualification passed with final cursor 166 and
scoped mixed sequence 168. The issue-specific raw logs, exact
committed source head, final binary hashes, per-command outcomes and any
failed preliminary attempts are retained in audit `chunks/7/pirs13-status.json`.
The Gitea host workflow includes the XRPC type and runtime checks.

Independent review found two NSID validation errors. On 2026-10-06, focused
regressions failed before correction in the native manifest and HTTP supervisor:
`tv.123.echo` was refused, `tv.test.bad-name` was accepted, and mixed-case
reserved authorities were accepted. The corrected validators follow the frozen
`@atproto/syntax@0.7.6` rules and compare reserved authorities without case
sensitivity. The final name remains case-sensitive for routing and grants.

A fresh locked host/component build passed. The expanded XRPC suite passed
22 manifest/readiness cases against the pinned upstream validator, real signed
HTTP calls for numeric-authority and mixed-case methods, invalid/reserved HTTP
and direct-runtime refusals before guest allocation, and real proxy calls on
both stock and carried PDS 0.5.37 packages.
Nine native tests include numeric-collection projection with exact grants and
opaque-data removal. Sandbox, manifest, KV, consumer, smoke and event/restart
regressions passed. Audit `chunks/7/pirs13-fix-status.json` records the fix head,
commands, raw logs, preliminary failures and remaining gates.

This is local evidence using a real PDS proxy handler, real account signatures
and installed Wasm. The PLC/service documents and their loopback transports
are disposable test fixtures. No real/public identity, HTTPS ingress, hosted
CI result, production load, multi-replica replay policy or complete level 1
conformance is claimed. No PDS package patch or adapter was added. Issue #18's
per-account owner decision, issue #22's release gate and the hosted-use review
remain independent gates. Root owns review, merge and issue closure.
