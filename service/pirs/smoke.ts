// Boots a throwaway PDS with the bridge attached and checks both seams:
// the /_pirs/status route and delivery of a sequencer event to the listener.
//
// It uses a temporary data directory and generated secrets, contacts no PLC
// directory and creates no account. Run with `pnpm smoke`.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDS, readEnv } from '@atproto/pds'
import { attachEvents, attachRoutes } from './bridge.ts'

const port = Number(process.env.PIRS_SMOKE_PORT ?? 2597)
const dir = await mkdtemp(join(tmpdir(), 'pirs-smoke-'))
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  PDS_HOSTNAME: 'pirs-smoke.invalid',
  PDS_PORT: String(port),
  PDS_DATA_DIRECTORY: dir,
  PDS_BLOBSTORE_DISK_LOCATION: join(dir, 'blocks'),
  PDS_JWT_SECRET: randomBytes(32).toString('hex'),
  PDS_ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: randomBytes(32).toString('hex'),
  PDS_DID_PLC_URL: 'http://127.0.0.1:1',
  PDS_CRAWLERS: '',
  LOG_ENABLED: 'false'
})

const stop = new AbortController()
let failure: unknown = null

async function status() {
  const res = await fetch(`${base}/_pirs/status`)
  if (!res.ok) throw new Error(`status route returned ${res.status}`)
  return (await res.json()) as {
    events: { listening: boolean; lastSeq: number | null; counts: Record<string, number> }
  }
}

async function check(pds: PDS) {
  const health = await fetch(`${base}/xrpc/_health`)
  if (!health.ok) throw new Error(`PDS health returned ${health.status}`)

  const before = await status()
  if (!before.events.listening) throw new Error('bridge is not listening')

  await pds.ctx.sequencer.sequenceIdentity('did:web:pirs-smoke.invalid')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const now = await status()
    if (now.events.counts.identity === 1 && now.events.lastSeq !== null) {
      console.log('ok: status route, health, and one identity event delivered', now.events)
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('sequencer event was not delivered within 10s')
}

try {
  await PDS.run({
    env: readEnv(),
    signal: stop.signal,
    onCreated: (pds) => attachRoutes(pds),
    onStarted: async (pds) => {
      attachEvents(pds)
      try {
        await check(pds)
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
  await rm(dir, { recursive: true, force: true })
}
if (failure) {
  console.error('smoke failed:', failure)
  process.exit(1)
}
