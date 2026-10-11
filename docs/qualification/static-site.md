# Local static site plugin, 2026-10-10

Issue #17's reference component serves two pages from one account's public
repository. Its only declared capabilities are `events.subscribe`,
`records.read`, `blobs.read` and `http.serve`. The installed Wasm imports only
the record and blob readers; event and HTTP grants are enforced at dispatch.
Plugin code runs in separate host processes, never in the PDS. The account DID
is public build configuration. No account token, signing key, database or PDS
environment enters the guest.

The component binds `/` to `tv.pirs.site.page/index` and `/about` to
`tv.pirs.site.page/about`. A page record has `$type: tv.pirs.site.page` and a
`file` field containing a typed atproto blob reference. This experimental
collection has no published lexicon; the disposable publisher explicitly uses
`validate: false`. The blob must be UTF-8 `text/html` or `text/plain`, at most
8192 bytes, with bytes matching the descriptor's declared size. Missing,
deleted, malformed or unavailable pages return the same fixed 404 response.
Queries, POST bodies and unknown routes cannot select another account or record.

Each HTTP invocation reads the current record and owning blob through #15's
anonymous public-read capability. No cached site survives a deletion or commit.
The event consumer independently receives scoped commits and persists its cursor;
the guest acknowledges commits for its configured account and two page records.
Events do not invalidate a cache or write plugin state because neither exists.
Updates appear on the next request, not through browser push refresh. Reads
retain #15's accepted sampled-HTTP visibility race; this plugin adds no stronger
visibility or cross-process transaction guarantee.

The supervisor uses #14's dedicated local listener and opaque, scriptless HTML
sandbox. HTML retains static semantic formatting, but guest links, styling,
scripts, images and forms are removed. The manifest grants a 128-byte request
body, a 16384-byte response body and a 1000 ms guest deadline. The response
ceiling also covers HTML after projection; an otherwise valid source can exceed
that ceiling when serialized. Existing socket, concurrency and host read limits
still apply. The demo grants no `network.request`, KV or diagnostic capability.

## Reproduce from a clean checkout

Use Node 24, package-pinned pnpm 10.34.1, Python 3 and Rust 1.95.0 with
`wasm32-wasip2`. Select these for the shell; on this host the user Rust binaries
under `~/.cargo/bin` must precede the system Rust compiler. From `service/`:

```sh
rtk proxy corepack pnpm install --frozen-lockfile
rtk proxy rustup target add wasm32-wasip2
rtk proxy python3 pirs/host/build.py
rtk proxy node pirs/static-site/demo.ts
```

The last command starts a signed local PLC creation/resolution fixture, a
temporary PDS, one disposable account, a configured component installation,
the HTTP host and an event consumer. It publishes an HTML index and plain-text
about page. It prints the public DID, installation identity and site URL when
ready. Open `http://127.0.0.2:43152/` in a browser and see `Version one`.
Expand the details control. Open `/about` by entering its URL; guest navigation
links are intentionally unavailable under the accepted static HTML policy.

In a second terminal, inspect the demo process and send a signal to the exact
Node process PID, not a wrapper or another PDS process:

```sh
rtk proxy pgrep -af 'node pirs/static-site/demo.ts'
rtk proxy kill -USR1 <demo-node-pid>
```

The demo uploads a new blob and replaces the index record. It prints the new
revision and unchanged PDS, HTTP-host and consumer PIDs after the durable cursor
acknowledges that commit. Reload the same site URL and see
`Version two — updated by a commit`. Stop the foreground demo with Ctrl-C, or
send SIGTERM to that exact PID. Shutdown removes its processes, installation,
account storage and loopback listeners. The harness accepts no real PDS data
path, credentials or public PLC URL.

For automated qualification, from `service/`:

```sh
rtk proxy corepack pnpm exec tsc -p pirs/static-site/tsconfig.json
rtk proxy node --test pirs/static-site/site.test.ts
rtk proxy corepack pnpm smoke
```

The build helper can also create the component and four-capability manifest
with `python3 pirs/host/static-site/build.py --did <public-local-did>
--output <private-component-directory>`. It does not install, serve or publish
anything by itself.

## Observed result

The component/runtime source at `22bc91a` passed the locked host/fixture build,
three native component tests, HTTP and site type checks, all five HTTP tests,
the installed site test, PDS smoke and both smoke cleanup tests. Formatting and
diff checks passed. The site test verifies the exact four-capability manifest,
two actual imports, empty HTTP-host environment, real page and blob reads,
commit cursor advancement, installed guest recognition of the actual commit,
unchanged serving process identities, hostile HTML projection, unsupported MIME,
invalid UTF-8, exact 8192/8193-byte boundaries, deletion and recovery. All its
temporary data and children are removed.

T3's Chromium 154 browser loaded the initial site, then loaded the updated
revision after one real record commit. PDS, HTTP-host, event-consumer and
event-host PIDs remained unchanged. The details control expanded, and reading
cookies threw the opaque-sandbox `SecurityError`. The
[browser evidence](static-site.browser.json) retains the configured DID,
component/host hashes, installation identity, durable cursor, process IDs and
before/after page observations. The browser demo was also stopped and its
temporary data removed.

The host workflow now runs native site tests and the installed site test, and
watches site source and this qualification record. Hosted qualification passed
at `7638852ebcb78858d9d78ef5cd6263924f572860`: the
[WIT host job](https://git.subcult.tv/subculture-collective/pirs/actions/runs/14251/jobs/26112)
ran the native and installed site checks, and all eight PR check contexts
reported success. This documentation update records that tested source.
This is a local M2 exit demonstration, not a production hosting qualification.
Public DNS/TLS, real PLC identities, script-enabled sites, arbitrary routes,
binary assets and other browser engines remain outside this run.
