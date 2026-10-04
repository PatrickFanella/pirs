import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startEventBridge } from './bridge-server.ts'
import { fetchPage } from './consumer.ts'
import { EVENT_BYTES, PAGE_BYTES, PAGE_EVENTS } from './protocol.ts'

function get(path: string, after: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    request({ socketPath: path, path: `/events?after=${after}`, agent: false }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject).end()
  })
}

test('bounded pages retain overflow for the next range; oversized events are never skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pirs-pages-'))
  const path = join(dir, 'events.sock')
  const events = Array.from({ length: 70 }, (_, i) => ({ seq: i + 1, type: 'identity' as const,
    time: new Date().toISOString(), evt: { did: `did:plc:${i}`, handle: 'x'.repeat(9000) } }))
  const bridge = await startEventBridge({ async requestSeqRange({ earliestSeq = 0, limit = 1 }) {
    return events.filter((event) => event.seq > earliestSeq).slice(0, limit)
  } }, path)
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const seen: number[] = []
    let after = 0
    while (after < 70) {
      const reply = await get(path, String(after))
      assert.equal(reply.status, 200)
      assert.ok(Buffer.byteLength(reply.body) <= PAGE_BYTES)
      const page = await fetchPage(path, after)
      assert.ok(page.events.length < PAGE_EVENTS, 'byte ceiling must split this workload')
      seen.push(...page.events.map((event) => event.seq))
      after = seen.at(-1)!
    }
    assert.deepEqual(seen, events.map((event) => event.seq))
    assert.ok(bridge.metrics.fullPages >= 2)
    assert.ok(bridge.metrics.maxBufferedBytes <= PAGE_BYTES)
    assert.ok(bridge.metrics.maxBufferedEvents <= PAGE_EVENTS)
    events[0].evt.handle = 'x'.repeat(EVENT_BYTES)
    assert.equal((await get(path, '0')).status, 413)
    assert.equal((await get(path, '-1')).status, 400)
    assert.equal((await get(path, '9007199254740992')).status, 400)
    const stream = JSON.parse(await readFile(join(dir, 'stream.json'), 'utf8')).stream
    assert.equal((await fetchPage(path, 1)).stream, stream)
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }) }
})

test('disconnected requests cannot create concurrent DB queries; excess requests get 429', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pirs-overload-'))
  const path = join(dir, 'events.sock')
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const queried = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const bridge = await startEventBridge({ async requestSeqRange() {
    calls++; entered(); await gate; return []
  } }, path)
  try {
    const pending = request({ socketPath: path, path: '/events?after=0', agent: false })
    pending.on('error', () => {})
    pending.end()
    await queried
    pending.destroy()
    assert.equal((await get(path, '0')).status, 429)
    assert.equal(calls, 1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await get(path, '0')).status, 200)
    assert.equal(bridge.metrics.overloaded, 1)
  } finally { release(); await bridge.close(); await rm(dir, { recursive: true, force: true }) }
})

test('socket recovery preserves ordinary files and rejects a second owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pirs-owner-'))
  const path = join(dir, 'events.sock')
  try {
    await writeFile(path, 'preserve')
    await assert.rejects(startEventBridge({ async requestSeqRange() { return [] } }, path), /occupied/)
    assert.equal(await readFile(path, 'utf8'), 'preserve')
    await rm(path)
    const first = await startEventBridge({ async requestSeqRange() { return [] } }, path)
    try { await assert.rejects(startEventBridge({ async requestSeqRange() { return [] } }, path), /active/) }
    finally { await first.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('simultaneous listener starts cannot replace each other during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pirs-socket-race-'))
  const path = join(dir, 'events.sock')
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 2 }, () =>
      startEventBridge({ async requestSeqRange() { return [] } }, path)))
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1)
    try { assert.equal((await get(path, '0')).status, 200) }
    finally { for (const attempt of attempts) if (attempt.status === 'fulfilled') await attempt.value.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
