// Disposable process-level qualification. Never supplies operator PDS state.
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { startPlcFixture } from '../plc-fixture.ts'
import { fetchPage } from './consumer.ts'
import { PAGE_BYTES, PAGE_EVENTS } from './protocol.ts'

const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
const plugin = fileURLToPath(new URL('../host/target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'pirs-delivery-'))
const data = join(root, 'pds')
const socket = join(root, 'transport', 'events.sock')
const cursor = join(root, 'host-state', 'cursor.json')
const installationManifest = join(root, 'manifest.json')
await writeFile(installationManifest, JSON.stringify({ schemaVersion: 1, id: 'qualification-observer', minSpecLevel: 0,
  hooks: ['event.commit', 'event.sync', 'event.identity', 'event.account'], capabilities: [
    { name: 'diagnostics.log', constraints: {} },
    { name: 'events.subscribe', constraints: { eventTypes: ['commit', 'sync', 'identity', 'account'], collections: ['*'] } }
  ] }))
const installation = JSON.parse(execFileSync(host, ['--plugin', plugin, '--manifest', installationManifest, '--install-dir', join(root, 'installs')], { encoding: 'utf8' })).installed
const children: ChildProcess[] = []
const runtimePids: number[] = []
const received: { delivered: number; type: string; logs: string[] }[] = []
let base = ''
let account: { did: string; accessJwt: string }
let freezeNext = false

function child(file: string, args: string[], preload?: string) {
  const processChild = spawn(process.execPath, [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), file, ...args], {
    env: { PATH: process.env.PATH, LOG_ENABLED: 'false', PDS_ADMIN_PASSWORD: 'disposable-operator-marker' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(processChild)
  let output = ''
  let error = ''
  processChild.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
  processChild.stderr!.on('data', (chunk: Buffer) => { error += chunk.toString() })
  processChild.on('error', (err) => { error += err.message })
  return { process: processChild, output: () => output, error: () => error }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function runtimeGone(pid: number) {
  // An orphan may briefly remain as a zombie before the container's PID 1
  // reaps it. It must no longer execute or retain a serving address space.
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].startsWith('Z') }
  catch { return !alive(pid) }
}

async function stop(processChild: ChildProcess, signal: NodeJS.Signals) {
  if (processChild.exitCode !== null || processChild.signalCode !== null) return
  const exited = new Promise<void>((resolve) => processChild.once('exit', () => resolve()))
  processChild.kill(signal)
  await exited
}

const fixture = await startPlcFixture()

async function startPds() {
  const pds = child(fileURLToPath(new URL('./pds-fixture.ts', import.meta.url)), [data, socket, fixture.url])
  await waitFor(() => pds.output().includes('"ready":true'), `PDS ready: ${pds.error()}`)
  const ready = JSON.parse(pds.output().trim().split('\n').at(-1)!)
  base = `http://127.0.0.1:${ready.port}`
  return pds
}

async function startConsumer(checkEnvironment = true, preload?: string) {
  const consumer = child(fileURLToPath(new URL('./consumer.ts', import.meta.url)),
    ['--socket', socket, '--cursor', cursor, '--host', host, '--installation', installation], preload)
  let buffer = ''
  consumer.process.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (line.runtimePid) runtimePids.push(line.runtimePid)
      if (line.delivered) {
        received.push(line)
        if (freezeNext) { freezeNext = false; consumer.process.kill('SIGSTOP') }
      }
    }
  })
  await waitFor(() => consumer.output().includes('"ready":true'), `consumer ready: ${consumer.error()}`, 30_000)
  if (checkEnvironment) assert.equal((await readFile(`/proc/${runtimePids.at(-1)}/environ`)).length, 0)
  return consumer
}

async function xrpc(method: string, body: unknown, token?: string) {
  const response = await fetch(`${base}/xrpc/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 200, `${method}: ${response.status}`)
  return response.json()
}

async function writes(count: number, label: string) {
  const elapsed: number[] = []
  for (let index = 0; index < count; index++) {
    const start = performance.now()
    await xrpc('com.atproto.repo.createRecord', { repo: account.did, collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post', text: `${label}:${index}`, createdAt: new Date().toISOString() } }, account.accessJwt)
    elapsed.push(performance.now() - start)
  }
  return elapsed
}

async function lastSeq() {
  // The status route counts only events seen by the current PDS process.
  // Persisted ranges, rather than those reset counters, define restart progress.
  let after = 0
  while (true) {
    const page = await fetchPage(socket, after)
    if (!page.events.length) return after
    after = page.events.at(-1)!.seq
    if (!page.full) return after
  }
}

async function caughtUp() {
  const latest = await lastSeq()
  await waitFor(async () => JSON.parse(await readFile(cursor, 'utf8')).seq === latest, `durable cursor ${latest}`)
  return latest
}

function latency(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { samples: samples.length, median_ms: sorted[Math.floor(sorted.length / 2)],
    p95_ms: sorted[Math.ceil(sorted.length * .95) - 1], max_ms: sorted.at(-1)! }
}

try {
  await mkdir(data, { mode: 0o700 })
  await mkdir(join(root, 'operator'), { mode: 0o700 })
  await writeFile(join(root, 'operator', 'sentinel'), 'preserve')
  let pds = await startPds()
  account = await xrpc('com.atproto.server.createAccount', {
    handle: 'smoke.test', email: 'pirs-delivery@example.com', password: randomBytes(24).toString('hex')
  })
  await writes(70, 'initial-backlog')
  const backlog = await lastSeq()
  assert.equal(backlog, 74)
  const page = await fetchPage(socket, 0)
  assert.equal(page.events.length, PAGE_EVENTS)
  assert.equal(page.full, true)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= PAGE_BYTES)
  const commit = page.events.find((event) => event.type === 'commit')
  assert.ok(commit?.evt && typeof commit.evt === 'object' && 'blocks' in commit.evt && 'commit' in commit.evt)
  const blocks = commit.evt.blocks
  const cid = commit.evt.commit
  assert.ok(blocks && typeof blocks === 'object' && '$bytes' in blocks && typeof blocks.$bytes === 'string')
  assert.ok(Buffer.from(blocks.$bytes, 'base64').length > 0, 'real CAR bytes survive transport encoding')
  assert.ok(cid && typeof cid === 'object' && '/' in cid && typeof cid['/'] === 'string')
  assert.match(cid['/'], /^b[a-z2-7]+$/, 'real commit CID survives JSON encoding')
  assert.ok(!JSON.stringify(page).includes('disposable-operator-marker'))
  assert.equal((await stat(socket)).mode & 0o777, 0o600)
  const publicResponse = await fetch(`${base}/events?after=0`)
  assert.equal(publicResponse.status, 404, 'private range must not appear on public PDS listener')
  const publicPirsResponse = await fetch(`${base}/_pirs/events?after=0`)
  assert.equal(publicPirsResponse.status, 404)

  freezeNext = true
  let consumer = await startConsumer()
  await waitFor(() => received.length > 0 && !freezeNext, 'stop consumer mid-page')
  const beforeCrash = JSON.parse(await readFile(cursor, 'utf8'))
  assert.ok(beforeCrash.seq < backlog, 'consumer must stop before backlog drains')
  const stoppedLatency = latency(await writes(40, 'host-stopped'))
  assert.ok(stoppedLatency.max_ms < 1000, 'stopped host must not stall PDS writes')
  await stop(consumer.process, 'SIGKILL')
  await waitFor(() => runtimeGone(runtimePids.at(-1)!), 'kernel kills orphan runtime')
  const persisted = JSON.parse(await readFile(cursor, 'utf8'))
  const oldBase = base
  await stop(pds.process, 'SIGKILL')
  await assert.rejects(fetch(`${oldBase}/xrpc/_health`))
  pds = await startPds()
  assert.equal((await fetchPage(socket, persisted.seq)).stream, persisted.stream)
  consumer = await startConsumer()
  await caughtUp()
  const runningLatency = latency(await writes(40, 'host-running'))
  await caughtUp()
  assert.ok(stoppedLatency.p95_ms <= runningLatency.p95_ms * 5 + 20, 'stopped-host latency regression')

  const runtimeCrashCursor = JSON.parse(await readFile(cursor, 'utf8')).seq
  process.kill(runtimePids.at(-1)!, 'SIGKILL')
  await writes(1, 'runtime-crashed')
  await waitFor(() => consumer.process.exitCode !== null, 'runtime death stops consumer')
  assert.equal(consumer.process.exitCode, 1)
  assert.equal(JSON.parse(await readFile(cursor, 'utf8')).seq, runtimeCrashCursor)
  consumer = await startConsumer()
  await caughtUp()
  await stop(consumer.process, 'SIGTERM')

  // Fault injection is confined to this child process. The real consumer has
  // no test switch: pause its filesystem rename after a successful guest call,
  // then SIGKILL it before the durable acknowledgement. Restart must replay.
  const acknowledgementCursor = JSON.parse(await readFile(cursor, 'utf8')).seq
  const freezeRename = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.promises.rename;
    fs.promises.rename = async (source, destination) => {
      const next = JSON.parse(await fs.promises.readFile(source, 'utf8'));
      if (next.seq > ${acknowledgementCursor}) {
        await new Promise((resolve) => process.stdout.write(JSON.stringify({ before_cursor: next.seq }) + '\\n', resolve));
        process.kill(process.pid, 'SIGSTOP');
        await new Promise(() => {});
      }
      return rename(source, destination);
    };
    syncBuiltinESMExports();`
  const boundaryConsumer = await startConsumer(true, freezeRename)
  await writes(1, 'acknowledgement-boundary')
  await waitFor(() => boundaryConsumer.output().includes('"before_cursor":'), 'guest call before durable cursor')
  const replayedSeq = acknowledgementCursor + 1
  assert.match(boundaryConsumer.output(), new RegExp(`"before_cursor":${replayedSeq}`))
  assert.equal(JSON.parse(await readFile(cursor, 'utf8')).seq, acknowledgementCursor)
  await stop(boundaryConsumer.process, 'SIGKILL')
  await waitFor(() => runtimeGone(runtimePids.at(-1)!), 'boundary crash kills runtime')
  consumer = await startConsumer()
  await caughtUp()
  assert.ok(received.some((event) => event.delivered === replayedSeq && event.logs.includes(`seq:${replayedSeq}`)))

  // Kill/restart the PDS while the consumer remains running. New persisted
  // events must be fetched through the recovered socket at the saved cursor.
  await stop(pds.process, 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 150))
  pds = await startPds()
  await writes(10, 'pds-restarted')
  const finalSeq = await caughtUp()
  await waitFor(() => received.at(-1)?.delivered === finalSeq, 'last operator receipt')
  assert.equal(finalSeq, 166)
  const sequences = received.map((event) => event.delivered)
  assert.ok(sequences.every((seq, index) => index === 0 || seq >= sequences[index - 1]), 'nondecreasing delivery order')
  assert.deepEqual([...new Set(sequences)], Array.from({ length: finalSeq }, (_, index) => index + 1))
  assert.ok(received.every((event) => event.logs.includes(`seq:${event.delivered}`)), 'every event reached the WIT guest')
  assert.deepEqual(new Set(received.map((event) => event.type)), new Set(['identity', 'account', 'commit', 'sync']))

  // A second consumer must not share the cursor or start a second runtime.
  const second = child(fileURLToPath(new URL('./consumer.ts', import.meta.url)),
    ['--socket', socket, '--cursor', cursor, '--host', host, '--installation', installation])
  await waitFor(() => second.process.exitCode !== null, 'second cursor owner rejected')
  assert.equal(second.process.exitCode, 1)
  assert.match(second.error(), /already active/)
  await stop(consumer.process, 'SIGTERM')
  await waitFor(() => runtimeGone(runtimePids.at(-1)!), 'clean runtime shutdown')

  // A cursor for another stream is rejected without altering progress.
  const originalCursor = await readFile(cursor, 'utf8')
  await writeFile(cursor, JSON.stringify({ ...JSON.parse(originalCursor), stream: '00000000-0000-0000-0000-000000000000' }))
  const mismatch = await startConsumer(false)
  await waitFor(() => mismatch.process.exitCode !== null, 'stream mismatch rejected')
  assert.equal(mismatch.process.exitCode, 1)
  assert.match(mismatch.error(), /stream changed/)
  assert.equal(JSON.parse(await readFile(cursor, 'utf8')).stream, '00000000-0000-0000-0000-000000000000')
  await writeFile(cursor, originalCursor)
  assert.equal(await readFile(join(root, 'operator', 'sentinel'), 'utf8'), 'preserve')

  // Real PDS qualification for a collection-scoped installed observer. Use a
  // separate cursor because the receipt/grant differs from the broad observer.
  const scopedManifest = join(root, 'scoped-manifest.json')
  await writeFile(scopedManifest, JSON.stringify({ schemaVersion: 1, id: 'scoped-real-observer', minSpecLevel: 0,
    hooks: ['event.commit'], capabilities: [
      { name: 'diagnostics.log', constraints: {} },
      { name: 'events.subscribe', constraints: { eventTypes: ['commit'], collections: ['app.bsky.feed.post'] } }
    ] }))
  const scopedPlugin = fileURLToPath(new URL('../host/target/event-echo.wasm', import.meta.url))
  const scopedInstallation = JSON.parse(execFileSync(host, ['--plugin', scopedPlugin, '--manifest', scopedManifest,
    '--install-dir', join(root, 'installs')], { encoding: 'utf8' }))
  const scopedCursor = join(root, 'host-state', 'scoped-cursor.json')
  const scoped = child(fileURLToPath(new URL('./consumer.ts', import.meta.url)),
    ['--socket', socket, '--cursor', scopedCursor, '--host', host, '--installation', scopedInstallation.installed])
  await waitFor(() => scoped.output().includes('"ready":true'), 'scoped observer ready')
  runtimePids.push(JSON.parse(scoped.output().trim().split('\n')[0]).runtimePid)
  await waitFor(async () => {
    try { return JSON.parse(await readFile(scopedCursor, 'utf8')).seq === finalSeq }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, 'scoped replay caught up')
  await xrpc('com.atproto.repo.createRecord', { repo: account.did, collection: 'org.test.denied',
    record: { $type: 'org.test.denied', secret: 'DENIED-COLLECTION' } }, account.accessJwt)
  await xrpc('com.atproto.repo.applyWrites', { repo: account.did, writes: [
    { $type: 'com.atproto.repo.applyWrites#create', collection: 'app.bsky.feed.post',
      value: { $type: 'app.bsky.feed.post', text: 'mixed allowed', createdAt: new Date().toISOString() } },
    { $type: 'com.atproto.repo.applyWrites#create', collection: 'org.test.denied',
      value: { $type: 'org.test.denied', secret: 'DENIED-MIXED' } }
  ] }, account.accessJwt)
  const scopedFinalSeq = await lastSeq()
  await waitFor(async () => JSON.parse(await readFile(scopedCursor, 'utf8')).seq === scopedFinalSeq, 'scoped real writes persisted')
  await waitFor(() => scoped.output().includes(`"delivered":${scopedFinalSeq}`), 'mixed commit delivered')
  await stop(scoped.process, 'SIGTERM')
  assert.equal(scoped.process.exitCode, 0, scoped.error())
  const scopedRows = scoped.output().trim().split('\n').slice(1).map(line => JSON.parse(line))
  assert.deepEqual(scopedRows.slice(-2).map(row => row.delivered ?? -row.filtered), [-167, 168])
  assert.ok(scopedRows.filter(row => row.delivered).every(row => row.type === 'commit'))
  assert.ok(scopedRows.filter(row => row.filtered).every(row => row.logs.length === 0))
  assert.ok(!scoped.output().includes('DENIED'))
  const scopedEvidence = { receipt: scopedInstallation.receipt, final_cursor: JSON.parse(await readFile(scopedCursor, 'utf8')),
    filtered: scopedRows.filter(row => row.filtered).map(row => row.filtered),
    delivered: scopedRows.filter(row => row.delivered).map(row => row.delivered),
    denied_collection_sequence: 167, mixed_collection_sequence: 168 }

  const report = { generated_at: new Date().toISOString(), platform: process.platform, node: process.version,
    artifact_sha256: { host: createHash('sha256').update(await readFile(host)).digest('hex'),
      plugin: createHash('sha256').update(await readFile(plugin)).digest('hex') },
    scoped_observer: scopedEvidence,
    first_backlog: backlog, crash_cursor: persisted.seq, final_cursor: finalSeq,
    replayed_after_success_before_cursor: replayedSeq,
    delivered: received.length, unique_sequences: new Set(sequences).size,
    page_events: PAGE_EVENTS, page_bytes: PAGE_BYTES, stopped_host: stoppedLatency, running_host: runningLatency,
    checks: { guest_observed_all: true, ordered: true, host_sigkill_recovery: true, pds_sigkill_recovery: true,
      car_and_cid_encoding: true,
      orphan_runtime_killed: true, serving_environment_empty: true, public_transport_absent: true,
      runtime_failure_preserves_cursor: true, acknowledgement_crash_replayed: true,
      exclusive_cursor: true, stream_mismatch_rejected: true, operator_sentinel_unchanged: true } }
  await writeFile(fileURLToPath(new URL('../host/target/event-delivery.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const processChild of children) await stop(processChild, 'SIGKILL')
  for (const pid of runtimePids) if (!(await runtimeGone(pid))) process.kill(pid, 'SIGKILL')
  await fixture.close()
  await rm(root, { recursive: true, force: true })
}
