import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { startEventBridge } from './bridge-server.ts'
import type { DeliveryEvent } from './protocol.ts'

test('installed consumer persists filtered progress, restarts and rejects changed grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pirs-installed-delivery-'))
  const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
  const plugin = fileURLToPath(new URL('../host/target/event-echo.wasm', import.meta.url))
  const cursor = join(root, 'cursor.json')
  const socket = join(root, 'events.sock')
  const manifest = { schemaVersion: 1, id: 'scoped-observer', minSpecLevel: 0,
    hooks: ['event.commit'], capabilities: [
      { name: 'diagnostics.log', constraints: {} },
      { name: 'events.subscribe', constraints: { eventTypes: ['commit'], collections: ['app.bsky.feed.post'] } }
    ] }
  async function install() {
    const path = join(root, 'manifest.json')
    await writeFile(path, JSON.stringify(manifest))
    return JSON.parse(execFileSync(host, ['--plugin', plugin, '--manifest', path, '--install-dir', join(root, 'installs')], { encoding: 'utf8' }))
  }
  const original = await install()
  const op = (collection: string) => ({ path: `${collection}/rkey`, action: 'delete', cid: null })
  const events: DeliveryEvent[] = [
    { seq: 1, type: 'commit', time: 'now', evt: { ops: [op('app.bsky.feed.post')] } },
    { seq: 2, type: 'commit', time: 'now', evt: { ops: [op('app.bsky.feed.like')] } },
    { seq: 3, type: 'identity', time: 'now', evt: { did: 'did:plc:fixture' } },
    { seq: 4, type: 'commit', time: 'now', evt: { ops: [op('app.bsky.feed.post'), op('app.bsky.feed.like')] } }
  ]
  const bridge = await startEventBridge({ requestSeqRange: async ({ earliestSeq }) => events.filter(e => e.seq > (earliestSeq ?? 0)).slice(0, 1) }, socket)
  const children: ReturnType<typeof spawn>[] = []
  const launch = (installation: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./consumer.ts', import.meta.url)),
      '--socket', socket, '--cursor', cursor, '--host', host, '--installation', installation], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = '', error = ''
    child.stdout!.on('data', chunk => { output += chunk.toString() })
    child.stderr!.on('data', chunk => { error += chunk.toString() })
    const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
    return { child, ended, output: () => output, error: () => error }
  }
  const wait = async (check: () => boolean) => {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      if (check()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('installed consumer did not reach expected state')
  }
  try {
    const consumer = launch(original.installed)
    await wait(() => consumer.output().includes('"delivered":4'))
    consumer.child.kill('SIGTERM'); await consumer.ended
    assert.equal(consumer.child.exitCode, 0, consumer.error())
    const rows = consumer.output().trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.slice(1).map(row => row.delivered ?? -row.filtered), [1, -2, -3, 4])
    assert.ok(rows.filter(row => row.filtered).every(row => row.logs.length === 0))
    const saved = await readFile(cursor, 'utf8')
    assert.equal(JSON.parse(saved).seq, 4)
    assert.equal(JSON.parse(saved).installationId, original.receipt.installationId)
    const restart = launch(original.installed)
    await wait(() => restart.output().includes('"ready":true'))
    await new Promise(resolve => setTimeout(resolve, 150))
    restart.child.kill('SIGTERM'); await restart.ended
    assert.equal(restart.output().trim().split('\n').length, 1, 'restart replayed acknowledged filtered events')
    assert.equal(await readFile(cursor, 'utf8'), saved)

    manifest.capabilities[1].constraints = { eventTypes: ['commit'], collections: ['*'] }
    const changed = await install()
    const mismatch = launch(changed.installed)
    await wait(() => mismatch.child.exitCode !== null)
    assert.equal(mismatch.child.exitCode, 1)
    assert.match(mismatch.error(), /installation changed/)
    assert.equal(await readFile(cursor, 'utf8'), saved)
    const pinned = join(original.installed, 'plugin.wasm')
    const bytes = await readFile(pinned)
    await writeFile(pinned, Buffer.concat([bytes, Buffer.from('changed')]))
    const tampered = launch(original.installed)
    await wait(() => tampered.child.exitCode !== null)
    assert.equal(tampered.child.exitCode, 1)
    assert.equal(tampered.output(), '')
    assert.equal(await readFile(cursor, 'utf8'), saved)
    await writeFile(pinned, bytes)
    await writeFile(cursor, JSON.stringify({ version: 1, stream: JSON.parse(saved).stream, seq: 4 }))
    const legacy = launch(original.installed)
    await wait(() => legacy.child.exitCode !== null)
    assert.match(legacy.error(), /invalid durable cursor/)
    assert.equal(JSON.parse(await readFile(cursor, 'utf8')).version, 1)
    await writeFile(fileURLToPath(new URL('../host/target/manifest-delivery.json', import.meta.url)), JSON.stringify({
      recorded_at: new Date().toISOString(), receipt: original.receipt, cursor: JSON.parse(saved), receipts: rows.slice(1),
      checks: { filtered_cursor_synced: true, restart_no_replay: true, grant_change_refused: true,
        tamper_before_readiness: true, legacy_cursor_preserved: true }
    }, null, 2) + '\n')
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGKILL'); await stopped
      }
    }
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
