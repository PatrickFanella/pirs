import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { startEventBridge } from './bridge-server.ts'

test('consumer forwards private KV root and acknowledges a durable installed guest write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pirs-kv-consumer-'))
  const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
  const plugin = fileURLToPath(new URL('../host/target/kv.wasm', import.meta.url))
  const socket = join(root, 'events.sock')
  const state = join(root, 'plugin-state')
  const cursor = join(root, 'cursor.json')
  const manifest = join(root, 'manifest.json')
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, id: 'consumer-kv', minSpecLevel: 0,
    hooks: ['event.commit'], capabilities: [
      { name: 'events.subscribe', constraints: { eventTypes: ['commit'], collections: ['*'] } },
      { name: 'kv.read', constraints: { quotaBytes: 128 } },
      { name: 'kv.write', constraints: { quotaBytes: 128 } }
    ] }))
  const installed = JSON.parse(execFileSync(host, ['--plugin', plugin, '--manifest', manifest,
    '--install-dir', join(root, 'installs')], { encoding: 'utf8' })).installed
  const bridge = await startEventBridge({ requestSeqRange: async ({ earliestSeq }) =>
    earliestSeq ? [] : [{ seq: 1, type: 'commit', time: 'fixture', evt: { repo: 'write' } }] }, socket)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./consumer.ts', import.meta.url)),
    '--socket', socket, '--cursor', cursor, '--host', host, '--installation', installed,
    '--state-dir', state], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { error += chunk.toString() })
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    const end = Date.now() + 10_000
    while (!output.includes('"delivered":1') && Date.now() < end && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(output.includes('"delivered":1'), error || output)
    assert.deepEqual(JSON.parse(await readFile(join(state, 'consumer-kv/state.json'), 'utf8')), { entry: [1, 2, 3] })
    assert.equal(JSON.parse(await readFile(cursor, 'utf8')).seq, 1)
    child.kill('SIGTERM'); await ended
    assert.equal(child.exitCode, 0, error)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended }
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
