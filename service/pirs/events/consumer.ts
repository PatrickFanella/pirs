// Host-side delivery supervisor. Run separately from the PDS. Only sequenced
// event JSON crosses into the WIT runtime; no PDS environment or DB descriptor.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { open, readFile, rename } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { listenPrivate } from './local-socket.ts'
import { PAGE_BYTES, isSequence, parsePage } from './protocol.ts'

type Cursor = { version: 2; stream: string; seq: number; installationId: string }

async function readCursor(path: string): Promise<Cursor | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 2 ||
      !('stream' in value) || typeof value.stream !== 'string' || !/^[0-9a-f-]{36}$/.test(value.stream) ||
      !('seq' in value) || !isSequence(value.seq) ||
      !('installationId' in value) || typeof value.installationId !== 'string' || !/^[0-9a-f]{64}$/.test(value.installationId)) throw new Error('invalid durable cursor')
    return { version: 2, stream: value.stream, seq: value.seq, installationId: value.installationId }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function saveCursor(path: string, cursor: Cursor) {
  const file = await open(`${path}.next`, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(cursor)); await file.sync() }
  finally { await file.close() }
  await rename(`${path}.next`, path)
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function fetchPage(socketPath: string, after: number) {
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ socketPath, path: `/events?after=${after}`, method: 'GET', agent: false }, (res) => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > PAGE_BYTES) req.destroy(new Error('event page exceeds byte ceiling'))
        else chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('end', () => {
        if (res.statusCode !== 200) {
          const error = new Error(`bridge returned ${res.statusCode}`)
          // Busy/temporary range failures retry. An oversized event is a hard
          // failure: the cursor stays put and operator intervention is needed.
          if (res.statusCode === 429 || res.statusCode === 503) Object.assign(error, { code: 'EAGAIN' })
          reject(error)
        } else resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
    req.setTimeout(5000, () => req.destroy(Object.assign(new Error('bridge timeout'), { code: 'ETIMEDOUT' })))
    req.once('error', reject)
    req.end()
  })
  return parsePage(JSON.parse(body), after)
}

// The trusted runtime emits one ready line and one bounded response per call.
// Reject unsolicited responses rather than allowing an unbounded output queue.
class Runtime {
  child: ChildProcessWithoutNullStreams
  private line = Buffer.alloc(0)
  private queued: unknown[] = []
  private waiter: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
  private failure: Error | undefined

  constructor(host: string, installation: string, stateDir?: string) {
    this.child = spawn(host, ['--installation', installation, ...(stateDir ? ['--state-dir', stateDir] : []), '--parent-pid', String(process.pid),
      '--input-bytes', '1048576', '--deadline-ms', '250'], { env: {}, stdio: 'pipe' })
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.line = Buffer.concat([this.line, chunk])
        if (this.line.length > 8192) throw new Error('runtime response exceeds ceiling')
        let newline: number
        while ((newline = this.line.indexOf(10)) !== -1) {
          const value: unknown = JSON.parse(this.line.subarray(0, newline).toString('utf8'))
          this.line = this.line.subarray(newline + 1)
          if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(value) }
          else if (!this.queued.length) this.queued.push(value)
          else throw new Error('unsolicited runtime output')
        }
      } catch { this.fail(new Error('invalid runtime output')); this.child.kill('SIGKILL') }
    })
    // Runtime stderr has no plugin backtrace or secret, but is intentionally
    // not forwarded. Report a bounded supervisor error instead.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail(new Error('runtime input closed')))
    this.child.once('error', () => this.fail(new Error('runtime failed to start')))
    this.child.once('exit', () => this.fail(new Error('runtime exited')))
  }

  private fail(error: Error) {
    this.failure = error
    this.waiter?.reject(error)
    this.waiter = undefined
  }

  async response(timeout: number): Promise<unknown> {
    if (this.failure) throw this.failure
    if (this.queued.length) return this.queued.shift()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new Error('runtime response timed out')) }, timeout)
      this.waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      }
    })
  }

  async ready() {
    const value = await this.response(30_000)
    if (!value || typeof value !== 'object' || !('ready' in value) || value.ready !== true ||
      !('installationId' in value) || typeof value.installationId !== 'string' || !/^[0-9a-f]{64}$/.test(value.installationId)) throw new Error('installed runtime not ready')
    return value.installationId
  }

  async call(seq: number, event: unknown) {
    const response = this.response(5000)
    this.child.stdin.write(JSON.stringify({ id: seq, input: `event:${JSON.stringify(event)}` }) + '\n')
    const value = await response
    if (!value || typeof value !== 'object' || !('id' in value) || value.id !== seq ||
      !('ok' in value) || value.ok !== true || !('logs' in value) || !Array.isArray(value.logs) ||
      value.logs.some((log: unknown) => typeof log !== 'string') || !('filtered' in value) || typeof value.filtered !== 'boolean') throw new Error('plugin call failed; cursor unchanged')
    return { logs: value.logs, filtered: value.filtered }
  }

  async close() {
    const child = this.child
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGKILL')
    })
  }
}

export async function consume(options: { socket: string; cursor: string; host: string; installation: string; stateDir?: string; signal: AbortSignal }) {
  if (![options.cursor, options.host, options.installation].every(isAbsolute)) throw new Error('host, installation and cursor paths must be absolute')
  const lock = createServer((connection) => connection.end())
  const unlock = await listenPrivate(lock, `${options.cursor}.lock`)
  let runtime: Runtime | undefined
  try {
    let cursor = await readCursor(options.cursor)
    runtime = new Runtime(options.host, options.installation, options.stateDir)
    const installationId = await runtime.ready()
    if (cursor && cursor.installationId !== installationId) throw new Error('installation changed; use a new cursor after operator review')
    process.stdout.write(JSON.stringify({ ready: true, runtimePid: runtime.child.pid, cursor: cursor?.seq ?? 0 }) + '\n')
    while (!options.signal.aborted) {
      let page
      try { page = await fetchPage(options.socket, cursor?.seq ?? 0) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error &&
          ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAGAIN'].includes(String(error.code)))) throw error
        await pause(options.signal)
        continue
      }
      if (cursor && cursor.stream !== page.stream) throw new Error('event stream changed; cursor unchanged')
      if (!cursor) { cursor = { version: 2, stream: page.stream, seq: 0, installationId }; await saveCursor(options.cursor, cursor) }
      for (const event of page.events) {
        if (options.signal.aborted) break
        const { logs, filtered } = await runtime.call(event.seq, event)
        // A process crash after the call but before this synced rename repeats
        // the event on restart. Persist before acknowledging it to the operator.
        cursor = { version: 2, stream: page.stream, seq: event.seq, installationId }
        await saveCursor(options.cursor, cursor)
        await new Promise<void>((resolve, reject) => process.stdout.write(
          JSON.stringify({ ...(filtered ? { filtered: event.seq } : { delivered: event.seq }), type: event.type, logs }) + '\n',
          (error) => error ? reject(error) : resolve()))
      }
      if (!page.events.length) await pause(options.signal)
    }
  } finally {
    await runtime?.close()
    await unlock()
  }
}

async function pause(signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, 100)
    signal.addEventListener('abort', finish, { once: true })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    socket: { type: 'string' }, cursor: { type: 'string' }, host: { type: 'string' }, installation: { type: 'string' }, 'state-dir': { type: 'string' }
  } })
  if (!values.socket || !values.cursor || !values.host || !values.installation) throw new Error('required: --socket --cursor --host --installation')
  const stop = new AbortController()
  process.once('SIGTERM', () => stop.abort())
  process.once('SIGINT', () => stop.abort())
  consume({ socket: values.socket, cursor: values.cursor, host: values.host, installation: values.installation, stateDir: values['state-dir'], signal: stop.signal })
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'delivery failed'); process.exitCode = 1 })
}
