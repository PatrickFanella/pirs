// Disposable session canary, not a production PDS or identity fixture.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fixture, host } from './fixtures.ts'
import { startHttp } from './server.ts'
const f = await fixture()
const plugin = await startHttp({ host, installation: f.installation, pluginAddress: '127.0.0.2', pdsOrigin: 'http://127.0.0.1:43141' }, 43142)
let sessionCalls = 0, authenticatedCalls = 0
const requests: unknown[] = []
const pds = createServer((req, res) => {
  if (req.url === '/session') {
    sessionCalls++; const authenticated = req.headers.cookie?.includes('PDS_SESSION=disposable-canary') ?? false
    if (authenticated) authenticatedCalls++
    requests.push({ method: req.method, authenticated, origin: req.headers.origin ?? null })
    res.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/plain' }).end(authenticated ? 'visitor session' : 'no session'); return
  }
  if (req.url === '/evidence') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sessionCalls, authenticatedCalls, requests, pluginOrigin: plugin.origin, installationId: plugin.installationId })); return }
  res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'PDS_SESSION=disposable-canary; Path=/; SameSite=Lax' }).end(`<!doctype html><title>Pirs HTTP isolation fixture</title><h1>Disposable PDS session fixture</h1><p id="baseline">checking session</p><a href="${plugin.origin}/hostile">Open hostile installed plugin</a><pre id="evidence"></pre><script>fetch('/session',{credentials:'include'}).then(r=>r.text()).then(t=>document.querySelector('#baseline').textContent=t);setInterval(()=>fetch('/evidence').then(r=>r.json()).then(v=>document.querySelector('#evidence').textContent=JSON.stringify(v)),500)</script>`)
})
pds.listen(43141, '127.0.0.1'); await once(pds, 'listening')
console.log(JSON.stringify({ ready: true, pds: 'http://127.0.0.1:43141', plugin: plugin.origin, installationId: plugin.installationId }))
const close = async () => { pds.closeAllConnections(); await new Promise<void>(resolve => pds.close(() => resolve())); await plugin.close(); await f.close(); process.exit(0) }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close())
