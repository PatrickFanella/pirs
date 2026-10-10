// Local-only dedicated origin supervisor; no PDS credentials or guest imports here.
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { Runtime } from './runtime.ts'
import { staticHtml } from './html.ts'

export const POLICY = "sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'"
const occupied = new Set<string>()
type Grant = { routes: string[]; requestBytes: number; responseBytes: number; deadlineMs: number }
export type Options = { host: string; installation: string; stateDir?: string; publicPds?: string; pluginAddress: string; pdsOrigin: string }
function send(res: ServerResponse, status: number, body: string, type = 'text/plain') {
  if (!res.destroyed && !res.headersSent) res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`, 'content-security-policy': POLICY,
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'DENY', 'content-length': Buffer.byteLength(body)
  }).end(body)
}
export async function startHttp(options: Options, port = 0) {
  // Until a public ingress/cookie-site policy is qualified, accept only distinct
  // loopback IP hosts. Ports do not isolate cookies. Never attach to PDS.run.
  const pds = new URL(options.pdsOrigin)
  if (pds.protocol !== 'http:' || pds.hostname !== '127.0.0.1' || pds.username || pds.password || pds.pathname !== '/' || pds.search || pds.hash ||
      !/^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(options.pluginAddress)) throw new Error('dedicated local origins required')
  if (occupied.has(options.pluginAddress)) throw new Error('plugin address already assigned')
  if (![options.host, options.installation, ...(options.stateDir ? [options.stateDir] : [])].every(isAbsolute)) throw new Error('absolute paths required')
  occupied.add(options.pluginAddress)
  // Installation bytes are revalidated by the host before readiness. Read only
  // its declared limits here; never trust these bytes as authority for routes.
  let runtime: Runtime | undefined
  let server: ReturnType<typeof createServer> | undefined
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(`${options.installation}/manifest.json`)
    if (raw.length > 65536) throw new Error('manifest exceeds limit')
    const manifest = JSON.parse(raw.toString('utf8'))
    const configured = manifest.capabilities?.find((c: any) => c.name === 'http.serve')?.constraints
    if (!configured || !Number.isSafeInteger(configured.deadlineMs) || configured.deadlineMs < 1 || configured.deadlineMs > 1000 ||
        !Number.isSafeInteger(configured.responseBytes) || configured.responseBytes < 1 || configured.responseBytes > 16384) throw new Error('HTTP limits required')
    runtime = new Runtime({ ...options, deadlineMs: configured.deadlineMs, responseBytes: Math.max(2, configured.responseBytes) })
    const ready = await runtime.response(30_000)
    if (ready?.ready !== true || !/^[0-9a-f]{64}$/.test(ready.installationId) || !ready.httpGrant) throw new Error('verified HTTP installation required')
    const grant: Grant = ready.httpGrant
    const routes = new Set(grant.routes)
    runtime.outputCeiling = grant.responseBytes * 12 + 8192
    const worker = runtime
    let busy = false, sequence = 0, authority = ''
    server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
      if (busy) { send(res, 503, 'PluginBusy'); req.resume(); return }
      busy = true
      const timer = setTimeout(() => { send(res, 408, 'RequestTimeout'); req.destroy() }, 2000)
      try {
        // Ignore all forwarding headers. Only origin-form targets on this exact
        // listener are accepted. No route fallback to another plugin or PDS.
        if (req.headers.host !== authority || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048 || /[%\\#]/.test(req.url)) { send(res, 400, 'InvalidRequest'); return }
        const [path, ...queryParts] = req.url.split('?')
        const query = queryParts.join('?')
        if (!routes.has(path)) { send(res, 404, 'RouteNotFound'); return }
        if (!['GET', 'POST'].includes(req.method ?? '') || req.headers.upgrade) { send(res, 405, 'MethodNotAllowed'); return }
        if (req.headers['content-encoding'] || query.length > 1024) { send(res, 400, 'InvalidRequest'); return }
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > grant.requestBytes) { send(res, 413, 'RequestTooLarge'); return }
          chunks.push(chunk)
        }
        if (req.method === 'GET' && bytes) { send(res, 400, 'InvalidRequest'); return }
        const body = Buffer.concat(chunks).toString('utf8')
        if (Buffer.byteLength(body) > grant.requestBytes) { send(res, 413, 'RequestTooLarge'); return }
        if (res.destroyed) return
        const id = ++sequence
        const pending = worker.response(grant.deadlineMs + 1000)
        // There is no header map, principal or credentials field in this ABI.
        worker.child.stdin!.write(JSON.stringify({ id, input: `http:${JSON.stringify({ path, method: req.method, query, body })}` }) + '\n')
        const result = await pending
        if (result?.id !== id || result.filtered !== false) throw new Error('PluginUnavailable')
        if (!result.ok) { send(res, result.error === 'timeout' ? 504 : 500, 'PluginLimitOrFailure'); return }
        const output = JSON.parse(result.result)
        if (!output || Object.keys(output).sort().join(',') !== 'body,contentType,status' ||
            ![200, 400, 404, 500].includes(output.status) || !['text/html', 'text/plain', 'application/json'].includes(output.contentType) ||
            typeof output.body !== 'string' || Buffer.byteLength(output.body) > grant.responseBytes) { send(res, 500, 'PluginInvalidResponse'); return }
        const rendered = output.contentType === 'text/html' ? staticHtml(output.body, grant.responseBytes) : output.body
        send(res, output.status, rendered, output.contentType)
      } catch { send(res, 503, 'PluginUnavailable') }
      finally { clearTimeout(timer); busy = false; req.resume() }
    })
    // Node's headersTimeout sweeper is not a two-second socket deadline.
    // A hard connection timer also bounds partial headers and trickle traffic.
    server.on('connection', socket => {
      const timer = setTimeout(() => socket.destroy(), 2000)
      timer.unref()
      socket.once('close', () => clearTimeout(timer))
    })
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
    server.requestTimeout = 2000; server.headersTimeout = 2000
    server.maxConnections = 16; server.keepAliveTimeout = 1000
    server.listen(port, options.pluginAddress)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('listener unavailable')
    authority = `${options.pluginAddress}:${address.port}`
    const listener = server
    return { origin: `http://${authority}`, installationId: ready.installationId, runtimePid: worker.child.pid,
      close: async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); await worker.close(); occupied.delete(options.pluginAddress) } }
  } catch (error) {
    server?.closeAllConnections(); server?.close(); await runtime?.close()
    occupied.delete(options.pluginAddress); throw error
  }
}

if (process.argv[1] === (await import('node:url')).fileURLToPath(import.meta.url)) {
  const { values } = (await import('node:util')).parseArgs({ options: {
    host: { type: 'string' }, installation: { type: 'string' }, 'state-dir': { type: 'string' },
    'plugin-address': { type: 'string' }, 'pds-origin': { type: 'string' }, port: { type: 'string' }
  } })
  if (!values.host || !values.installation || !values['plugin-address'] || !values['pds-origin']) throw new Error('host, installation and local origins required')
  const port = Number(values.port ?? 3002)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port')
  const service = await startHttp({ host: values.host, installation: values.installation,
    stateDir: values['state-dir'], pluginAddress: values['plugin-address'], pdsOrigin: values['pds-origin'] }, port)
  console.log(JSON.stringify({ ready: true, ...service }))
  const close = () => void service.close().then(() => process.exit(0))
  process.once('SIGTERM', close); process.once('SIGINT', close)
}
