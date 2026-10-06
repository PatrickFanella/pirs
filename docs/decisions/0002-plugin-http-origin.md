# Plugin HTTP origins

Issue #14 chooses a separate origin and listener per plugin. A shared PDS path
prefix makes every HTML response part of the sign-in/OAuth origin unless every
response remains sandboxed. One missing policy then grants the PDS origin to a
guest. Dedicated listeners avoid inserting plugin routes into the PDS router.
There is no fallback to another plugin or the PDS.

The first implementation accepts only dedicated loopback addresses in
127.0.0.2 through 127.0.0.254, with the disposable PDS on 127.0.0.1. A second
plugin cannot reuse an address in the same supervisor process. Bind conflicts
also fail. Operators must assign unique addresses across supervisor processes.
Different ports on one hostname do not isolate cookies, so that configuration
is rejected. Public origins and ingress remain a separate qualification gate.

Separate origins alone do not prevent credentials from reaching a destination.
Sibling hostnames can receive parent-domain cookies, and cross-origin fetch with
`credentials: "include"` can use visitor cookies when browser cookie rules allow
it. `credentials: "omit"` removes those credentials but does not prevent a request.
CORS controls response access, not whether a request reaches the server.

All plugin responses therefore also carry a fixed CSP sandbox with no exceptions
and `script-src 'none'`, `connect-src 'none'`, `form-action 'none'` and denied
images, frames, objects and base URLs. HTML has an opaque sandbox origin. Scripts
and forms are disabled, including the hostile fixture's explicit credentialed
fetch. This is intentionally a static HTML contract; enabling guest script is
outside the qualification. CSP does not block a document's own ordinary anchor
navigation. Before sending HTML, the supervisor therefore parses it with the
WHATWG HTML tree builder from pinned parse5 and rebuilds a static document from
an explicit inert tag and attribute list. It never copies raw source markup.
All guest URL attributes, including href, target, ping, src and form actions,
are removed. Anchors retain their labels but cannot navigate, including after a
click. Forms are unwrapped; buttons have a fixed type of button. Scripts, styles,
frames, templates and foreign SVG/MathML trees are discarded. CSS attributes are
removed. No unsupported `navigate-to` directive or raw HTML regular expression
is relied on. The policy applies to errors and non-HTML responses too.

This remains useful rendered HTML: titles, headings, paragraphs, emphasis,
lists, code, quotations, tables and details/summary controls retain their
semantics. Inert id, title, language, direction and bounded table span attributes
are preserved. Navigation and guest styling are intentionally removed by the
response policy, not renamed or sent as plaintext. Arbitrary HTML bytes are
accepted as input to this projection; arbitrary active HTML is never served.
Enabling navigation, arbitrary styling or scripts requires a separate design
and qualification. Rendered UTF-8 bytes also obey the installed response ceiling.
The guest cannot set headers, cookies, redirect status or content types outside
HTML, plain text and JSON. No CORS permission, streaming or WebSocket is exposed.

The supervisor drops every request header before the WIT call, including Cookie,
Authorization, proxy authorization and forwarded headers. The envelope contains
only path, method, query and a bounded UTF-8 body. These fields are visitor data;
a visitor can deliberately put a secret in a body or query. This is not automatic
credential forwarding. No host, PDS secrets, account database or environment
variables enter the guest. The existing installed receipt, import checks, memory,
log and epoch deadline controls apply. Direct runtime calls independently check
the installed HTTP grant before allocating a Store. For an HTTP call the native
host uses the smaller installed and CLI deadline and body-byte budgets. CLI
settings can tighten the grant, never enlarge it. The HTTP body is measured after
JSON decoding as UTF-8 bytes. A separately bounded JSON ABI envelope allows
encoding overhead without spending the body grant on it. Non-HTTP invocation
paths retain their existing encoded-result CLI budgets.

HTTP manifests declare exact routes and requestBytes, responseBytes and
deadlineMs. Install ceilings are 8 KiB request, 16 KiB response and 1000 ms guest
time. Reading the request has a separate 2 second deadline; one active call per
plugin rejects overload with 503. A hard 2 second socket lifetime begins on
connection acceptance, covers incomplete headers and trickle traffic, and also
caps keep-alive reuse. Node's periodic headersTimeout sweep is not the timing
authority. The listener retains its 16-connection and 8 KiB header ceilings. Reserved
XRPC, OAuth and well-known paths, encoded paths and dot traversal are rejected.
The supervisor buffers the full guest result before replying.

Browser verification must use the installed hostile component, a disposable
session cookie and a successful authenticated baseline. Header inspection alone
cannot establish browser isolation. A production deployment, public DNS, real
identity and owner acceptance are not part of this work.
