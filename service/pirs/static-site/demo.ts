// Disposable local M2 demo. Credentials stay in this trusted harness closure.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPlcFixture } from '../plc-fixture.ts'
import { startHttp } from '../http/server.ts'
import { fetchPage } from '../events/consumer.ts'

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
export const collection = 'tv.pirs.site.page'
export const initialHtml = '<!doctype html><title>Pirs local site</title><h1>A site from a repository</h1><p id="version">Version one</p><ul><li><strong>Public records and blobs</strong></li></ul><details><summary>How this page is served</summary><p>A separate installed WIT plugin reads the public page.</p></details>'
export const updatedHtml = initialHtml.replace('Version one', 'Version two — updated by a commit')

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await ended } finally { clearTimeout(timer) }
}
async function wait(check: () => Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('disposable demo readiness timed out')
}

export async function startDemo(port = 0) {
  const root = await mkdtemp(join(tmpdir(), 'pirs-static-site-'))
  let plc: Awaited<ReturnType<typeof startPlcFixture>> | undefined
  let pds: ChildProcess | undefined, consumer: ChildProcess | undefined
  let http: Awaited<ReturnType<typeof startHttp>> | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await stop(consumer); await http?.close(); await stop(pds); await plc?.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
  try {
    plc = await startPlcFixture(1)
    await mkdir(join(root, 'data'))
    const socket = join(root, 'events.sock'), cursor = join(root, 'cursor.json')
    pds = spawn(process.execPath, [path('../events/pds-fixture.ts'), join(root, 'data'), socket, plc.url],
      { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    pds.stdout!.on('data', chunk => { output += chunk })
    pds.stderr!.resume()
    await wait(async () => {
      if (pds!.exitCode !== null) throw new Error('disposable PDS startup failed')
      return output.includes('"ready":true')
    })
    const base = `http://127.0.0.1:${JSON.parse(output.trim().split('\n').at(-1)!).port}`
    const post = async (method: string, body: unknown, token?: string) => {
      const res = await fetch(`${base}/xrpc/${method}`, { method: 'POST', headers: {
        'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {})
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(`disposable ${method} returned ${res.status}: ${error.error}`)
      }
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    }
    const account = await post('com.atproto.server.createAccount', {
      handle: 'smoke.test', email: 'site@example.com', password: randomBytes(24).toString('hex')
    })
    const publish = async (rkey: string, body: string | Uint8Array, mime = 'text/html') => {
      const upload = await fetch(`${base}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST',
        headers: { 'content-type': mime, authorization: `Bearer ${account.accessJwt}` },
        body: (typeof body === 'string' ? Buffer.from(body) : body) as any, signal: AbortSignal.timeout(5000) })
      if (!upload.ok) throw new Error(`disposable upload returned ${upload.status}`)
      const { blob } = await upload.json()
      const record = await post('com.atproto.repo.putRecord', { repo: account.did, collection, rkey,
        validate: false, record: { $type: collection, file: blob } }, account.accessJwt)
      return record.commit.rev as string
    }
    const first = await publish('index', initialHtml)
    await publish('about', 'Local site served by an installed plugin.', 'text/plain')
    const build = spawn('python3', [path('../host/static-site/build.py'), '--did', account.did,
      '--output', join(root, 'component')], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    build.stderr!.resume()
    const [code] = await once(build, 'exit')
    if (code !== 0) throw new Error('static-site component build failed')
    const host = path('../host/target/release/pirs-host')
    const installed = JSON.parse(execFileSync(host, ['--plugin', join(root, 'component/plugin.wasm'),
      '--manifest', join(root, 'component/manifest.json'), '--install-dir', join(root, 'installs')],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }))
    http = await startHttp({ host, installation: installed.installed, publicPds: base,
      pluginAddress: '127.0.0.2', pdsOrigin: base }, port)
    consumer = spawn(process.execPath, [path('../events/consumer.ts'), '--socket', socket,
      '--cursor', cursor, '--host', host, '--installation', installed.installed, '--public-pds', base],
      { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    let progress = ''
    consumer.stdout!.on('data', chunk => { progress += chunk })
    consumer.stderr!.resume()
    const waitForCommit = async (rev: string) => {
      await wait(async () => {
        if (consumer!.exitCode !== null) throw new Error('site event consumer exited')
        const page = await fetchPage(socket, 0)
        const event = page.events.find(event => event.type === 'commit' && (event.evt as any).rev === rev)
        if (!event) return false
        try { return JSON.parse(await readFile(cursor, 'utf8')).seq >= event.seq }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      })
    }
    await waitForCommit(first)
    return { root, origin: http.origin, pdsOrigin: base, did: account.did, receipt: installed.receipt,
      pids: { pds: pds.pid, http: http.runtimePid, consumer: consumer.pid },
      publish, waitForCommit, progress: () => progress, close,
      deletePage: async (rkey: string) => {
        const record = await post('com.atproto.repo.deleteRecord', { repo: account.did, collection, rkey }, account.accessJwt)
        return record.commit.rev as string
      }
    }
  } catch (error) { await close(); throw error }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = await startDemo(43152)
  console.log(JSON.stringify({ ready: true, origin: demo.origin, did: demo.did, installationId: demo.receipt.installationId }))
  let updated = false
  process.once('SIGUSR1', async () => {
    if (updated) return
    updated = true
    try {
      const rev = await demo.publish('index', updatedHtml)
      await demo.waitForCommit(rev)
      console.log(JSON.stringify({ updated: true, revision: rev, pids: demo.pids }))
    } catch { console.error('disposable site update failed') }
  })
  const close = async () => { await demo.close(); process.exit(0) }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}
