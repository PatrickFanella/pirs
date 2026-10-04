// Boots a throwaway PDS with the bridge attached and checks both seams:
// the /_pirs/status route and delivery of real account and record events.
//
// It uses a temporary data directory, generated secrets, and a loopback PLC
// fixture. It creates no public identity. Run with `pnpm smoke`.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDS, readEnv } from '@atproto/pds'
import { attachEvents, attachRoutes } from './bridge.ts'
import { startPlcFixture } from './plc-fixture.ts'

const port = Number(process.env.PIRS_SMOKE_PORT ?? 2597)
const dir = await mkdtemp(join(tmpdir(), 'pirs-smoke-'))
const base = `http://127.0.0.1:${port}`

// Do not inherit an operator's entryway, email, storage or other PDS settings.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PDS_')) delete process.env[key]
}
delete process.env.PIRS_EVENT_SOCKET
Object.assign(process.env, {
  PDS_HOSTNAME: 'localhost',
  PDS_DEV_MODE: 'true',
  PDS_PORT: String(port),
  PDS_DATA_DIRECTORY: dir,
  PDS_BLOBSTORE_DISK_LOCATION: join(dir, 'blocks'),
  PDS_JWT_SECRET: randomBytes(32).toString('hex'),
  PDS_ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: randomBytes(32).toString('hex'),
  PDS_DID_PLC_URL: 'http://127.0.0.1:1',
  PDS_INVITE_REQUIRED: 'false',
  PDS_CRAWLERS: '',
  LOG_ENABLED: 'false'
})

const stop = new AbortController()
let failure: unknown = null
let checked = false
let fixture: Awaited<ReturnType<typeof startPlcFixture>> | undefined

async function xrpc(method: string, body: unknown, token?: string) {
  const res = await fetch(`${base}/xrpc/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  })
  // Avoid logging credentials returned by account/session endpoints.
  if (!res.ok) {
    const error = await res.json()
    throw new Error(`${method} returned ${res.status}: ${error.error}: ${error.message}`)
  }
  return await res.json()
}

async function status() {
  const res = await fetch(`${base}/_pirs/status`, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`status route returned ${res.status}`)
  return (await res.json()) as {
    events: { listening: boolean; lastSeq: number | null; counts: Record<string, number> }
  }
}

async function check(pds: PDS) {
  const health = await fetch(`${base}/xrpc/_health`, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok) throw new Error(`PDS health returned ${health.status}`)

  const before = await status()
  if (!before.events.listening) throw new Error('bridge is not listening')

  assert.equal(pds.ctx.cfg.identity.plcUrl, fixture!.url)
  const account = await xrpc('com.atproto.server.createAccount', {
    handle: 'smoke.test',
    email: 'pirs-smoke@example.com',
    password: randomBytes(24).toString('hex')
  })
  assert.match(account.did, /^did:plc:[a-z2-7]{24}$/)
  const afterAccount = await waitForEvents((events) =>
    events.counts.account >= 1 && events.counts.commit >= 1 &&
    events.counts.identity >= 1 && events.lastSeq !== null)

  const record = await xrpc('com.atproto.repo.createRecord', {
    repo: account.did,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'Disposable Pirs smoke record',
      createdAt: new Date().toISOString()
    }
  }, account.accessJwt)
  assert.match(record.uri, /^at:\/\/did:plc:/)
  const afterWrite = await waitForEvents((events) =>
    events.counts.commit > afterAccount.counts.commit &&
    events.lastSeq !== null && events.lastSeq > afterAccount.lastSeq!)
  assert.equal(fixture!.stats().documents, 1)
  assert.ok(fixture!.stats().reads >= 1, 'PDS must resolve the fixture DID')
  console.log('ok: status, health, local account and record events', {
    plcUrl: fixture!.url,
    afterAccount: afterAccount.lastSeq,
    afterWrite: afterWrite.lastSeq,
    counts: afterWrite.counts,
    plc: fixture!.stats()
  })
}

async function waitForEvents(predicate: (events: Awaited<ReturnType<typeof status>>['events']) => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const now = await status()
    if (predicate(now.events)) return now.events
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('sequencer event was not delivered within 10s')
}

try {
  fixture = await startPlcFixture()
  process.env.PDS_DID_PLC_URL = fixture.url
  await PDS.run({
    env: readEnv(),
    signal: stop.signal,
    onCreated: (pds) => {
      // The upstream listen call has no host argument. Bind only this smoke PDS
      // to loopback without changing the distribution's production entrypoint.
      const listen = pds.app.listen.bind(pds.app)
      pds.app.listen = ((port: number) => listen(port, '127.0.0.1')) as typeof pds.app.listen
      attachRoutes(pds)
    },
    onStarted: async (pds) => {
      await attachEvents(pds)
      try {
        await check(pds)
        checked = true
      } catch (err) {
        failure = err
      } finally {
        stop.abort()
      }
    }
  })
} catch (err) {
  failure = err
} finally {
  try {
    await fixture?.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
if (!checked && !failure) failure = new Error('smoke stopped before verification completed')
if (failure) {
  console.error('smoke failed:', failure)
  process.exit(1)
}
