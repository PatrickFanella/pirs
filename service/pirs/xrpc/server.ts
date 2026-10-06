// Separate trusted HTTP supervisor. Tokens and request headers never enter Wasm.
import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DidResolver } from '@atproto/identity'
import { verifyJwt } from '@atproto/xrpc-server'

const BODY_BYTES = 8192
// Same syntax as the frozen @atproto/syntax 0.7.6 validator.
const NSID = /^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?:\.[A-Za-z][A-Za-z0-9]{0,62})$/
function reservedXrpc(nsid: string) {
  const authority = nsid.slice(0, nsid.lastIndexOf('.')).toLowerCase()
  return ['com.atproto', 'app.bsky'].some(prefix => authority === prefix || authority.startsWith(`${prefix}.`))
}
const ISSUER = /^did:plc:[a-z2-7]{24}$/

export type Options = {
  host: string; installation: string; stateDir?: string
  serviceDid: string; serviceId: string; legacyBareAudience?: boolean
  // Trusted resolver injection for disposable qualification, absent from CLI.
  resolver?: Pick<DidResolver, 'resolveAtprotoKey'>
}

class XrpcError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}

function reply(res: ServerResponse, status: number, value: unknown) {
  if (!res.destroyed) res.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }).end(JSON.stringify(value))
}

class Runtime {
  child: ReturnType<typeof spawn>
  private line = Buffer.alloc(0)
  outputCeiling = 32768
  private queued: unknown[] = []
  private waiter?: { resolve: (value: unknown) => void; reject: (error: Error) => void }
  private failure?: Error

  constructor(options: Options) {
    this.child = spawn(options.host, ['--installation', options.installation,
      ...(options.stateDir ? ['--state-dir', options.stateDir] : []),
      '--parent-pid', String(process.pid), '--input-bytes', '65536', '--deadline-ms', '250'],
      { env: {}, stdio: 'pipe' })
    this.child.stdout!.on('data', (chunk: Buffer) => {
      try {
        this.line = Buffer.concat([this.line, chunk])
        if (this.line.length > this.outputCeiling) throw new Error('runtime output exceeds limit')
        let end: number
        while ((end = this.line.indexOf(10)) !== -1) {
          const value: unknown = JSON.parse(this.line.subarray(0, end).toString('utf8'))
          this.line = this.line.subarray(end + 1)
          if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(value) }
          else if (!this.queued.length) this.queued.push(value)
          else throw new Error('unsolicited runtime output')
        }
      } catch { this.fail(); this.child.kill('SIGKILL') }
    })
    this.child.stderr!.resume()
    this.child.stdin!.on('error', () => this.fail())
    this.child.once('error', () => this.fail())
    this.child.once('exit', () => this.fail())
  }

  private fail() {
    this.failure = new XrpcError(503, 'PluginUnavailable')
    this.waiter?.reject(this.failure)
    this.waiter = undefined
  }

  response(timeout: number): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.queued.length) return Promise.resolve(this.queued.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); this.child.kill('SIGKILL') }, timeout)
      this.waiter = {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      }
    })
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit')
    this.child.kill('SIGKILL')
    await exited
  }
}

export async function startXrpc(options: Options, port = 0, bind = '127.0.0.1') {
  if (![options.host, options.installation, ...(options.stateDir ? [options.stateDir] : [])].every(isAbsolute)) throw new Error('absolute paths required')
  if (!/^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.:%_-]+)$/.test(options.serviceDid) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(options.serviceId)) throw new Error('invalid service identity')
  const runtime = new Runtime(options)
  let server: ReturnType<typeof createServer> | undefined
  try {
    const ready = await runtime.response(30_000)
    if (ready?.ready !== true || !/^[0-9a-f]{64}$/.test(ready.installationId) ||
      !Array.isArray(ready.xrpcNsids) || !ready.xrpcNsids.length || ready.xrpcNsids.length > 64 ||
      ready.xrpcNsids.some((n: unknown) => typeof n !== 'string' || n.length > 317 || !NSID.test(n) || reservedXrpc(n))) throw new Error('verified XRPC installation required')
    runtime.outputCeiling = 8192
    const nsids = new Set<string>(ready.xrpcNsids)
    const resolver = options.resolver ?? new DidResolver({ timeout: 3000 })
    const audience = `${options.serviceDid}#${options.serviceId}`
    const replay = new Map<string, number>()
    let busy = false
    let sequence = 0
    server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
      // One request, including resolution and body reading, owns the runtime.
      // Fail overload rather than buffering an unbounded invocation queue.
      if (busy) { reply(res, 503, { error: 'PluginBusy' }); req.resume(); return }
      busy = true
      const timer = setTimeout(() => req.destroy(), 5000)
      try {
        if (!req.url || req.url.length > 8192) throw new XrpcError(400, 'InvalidRequest')
        const url = new URL(req.url, 'http://host.invalid')
        const nsid = url.pathname.slice(6)
        if (!url.pathname.startsWith('/xrpc/') || !nsids.has(nsid)) throw new XrpcError(400, 'MethodNotImplemented')
        if (!['GET', 'POST'].includes(req.method ?? '')) throw new XrpcError(405, 'InvalidRequest')
        if (req.headers['content-encoding']) throw new XrpcError(400, 'InvalidRequest')
        if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new XrpcError(400, 'InvalidRequest')
        const authorization = req.headers.authorization
        if (!authorization?.startsWith('Bearer ') || authorization.length > 4096) throw new XrpcError(401, 'AuthenticationRequired')
        const token = authorization.slice(7)
        let claims: any
        try {
          const parts = token.split('.')
          if (parts.length !== 3) throw new Error('token')
          const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
          claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
          const now = Date.now() / 1000
          // Pinned library does not validate iat/kid or finite numeric dates.
          if (!['ES256K', 'ES256'].includes(header.alg) || header.typ !== 'JWT' ||
            (header.kid !== undefined && header.kid !== '#atproto') || !ISSUER.test(claims.iss) ||
            !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
            claims.exp <= now || claims.iat > now + 5 || claims.exp <= claims.iat || claims.exp - claims.iat > 60 ||
            typeof claims.jti !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.jti) ||
            !(claims.aud === audience || options.legacyBareAudience && claims.aud === options.serviceDid)) throw new Error('claims')
          await verifyJwt(token, claims.aud, nsid, (iss, refresh) => {
            if (!ISSUER.test(iss)) throw new Error('issuer')
            return resolver.resolveAtprotoKey(iss, refresh)
          })
          // Check again after resolution, before allocating or invoking guest.
          if (claims.exp <= Date.now() / 1000) throw new Error('expired')
          for (const [key, expiry] of replay) if (expiry <= now) replay.delete(key)
          const key = `${claims.iss}/${claims.jti}`
          if (replay.has(key)) throw new Error('replay')
          if (replay.size >= 4096) throw new XrpcError(503, 'PluginBusy')
          replay.set(key, claims.exp)
        } catch (error) {
          if (error instanceof XrpcError) throw error
          throw new XrpcError(401, 'InvalidToken')
        }
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > BODY_BYTES) throw new XrpcError(413, 'RequestTooLarge')
          chunks.push(chunk)
        }
        let body = null
        if (bytes) {
          if (req.method !== 'POST') throw new XrpcError(400, 'InvalidRequest')
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          catch { throw new XrpcError(400, 'InvalidRequest') }
        }
        if (claims.exp <= Date.now() / 1000 || res.destroyed) throw new XrpcError(401, 'InvalidToken')
        const id = ++sequence
        const response = runtime.response(5000)
        runtime.child.stdin!.write(JSON.stringify({ id, input: `xrpc:${JSON.stringify({
          nsid, method: req.method, issuer: claims.iss, query: url.search.slice(1), body
        })}` }) + '\n')
        const result = await response
        if (result?.id !== id || result.filtered !== false) throw new XrpcError(503, 'PluginUnavailable')
        if (result.ok !== true) {
          const errors: Record<string, [number, string]> = {
            timeout: [504, 'PluginTimeout'], trap: [500, 'PluginFailed'],
            memory_limit: [500, 'PluginLimitExceeded'], response_limit: [500, 'PluginLimitExceeded'],
            log_limit: [500, 'PluginLimitExceeded'], invalid_request: [400, 'InvalidRequest']
          }
          const [status, code] = errors[result.error] ?? [503, 'PluginUnavailable']
          throw new XrpcError(status, code)
        }
        let output: unknown
        try { output = JSON.parse(result.result) } catch { throw new XrpcError(500, 'PluginInvalidResponse') }
        reply(res, 200, output)
      } catch (error) {
        const failure = error instanceof XrpcError ? error : new XrpcError(503, 'PluginUnavailable')
        reply(res, failure.status, { error: failure.code })
        req.resume()
      } finally { clearTimeout(timer); busy = false }
    })
    server.requestTimeout = 5000
    server.headersTimeout = 5000
    server.maxConnections = 32
    server.keepAliveTimeout = 1000
    server.listen(port, bind)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no listener')
    const listener = server
    return {
      port: address.port, nsids: [...nsids], installationId: ready.installationId,
      runtimePid: runtime.child.pid,
      close: async () => {
        listener.closeAllConnections()
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        await runtime.close()
      }
    }
  } catch (error) {
    server?.closeAllConnections(); server?.close()
    await runtime.close()
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, installation: { type: 'string' }, 'state-dir': { type: 'string' },
    'service-did': { type: 'string' }, 'service-id': { type: 'string' }, port: { type: 'string' },
    'legacy-bare-audience': { type: 'boolean', default: false }
  } })
  if (!values.host || !values.installation || !values['service-did'] || !values['service-id']) throw new Error('host, installation and service identity required')
  const port = Number(values.port ?? 3001)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port')
  const host = await startXrpc({ host: values.host, installation: values.installation, stateDir: values['state-dir'],
    serviceDid: values['service-did'], serviceId: values['service-id'], legacyBareAudience: values['legacy-bare-audience'] }, port)
  console.log(JSON.stringify({ ready: true, ...host }))
  const close = () => { void host.close().then(() => process.exit(0)) }
  process.once('SIGTERM', close); process.once('SIGINT', close)
}
