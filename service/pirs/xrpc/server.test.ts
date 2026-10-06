import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { DidResolver } from '@atproto/identity'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { startPlcFixture } from '../plc-fixture.ts'
import { startXrpc } from './server.ts'

const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
const plugin = fileURLToPath(new URL('../host/target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm', import.meta.url))
const serviceDid = `did:plc:${'b'.repeat(24)}`
const nsids = ['tv.123.echo', 'Tv.Test.echo2', 'tv.test.echo', 'tv.test.trap', 'tv.test.loop', 'tv.test.memory', 'tv.test.response', 'tv.test.log', 'tv.test.invalid']

test('installed host verifies service auth and serves a real PDS proxy call', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pirs-xrpc-'))
  const plc = await startPlcFixture()
  let service: Awaited<ReturnType<typeof startXrpc>> | undefined
  let strict: Awaited<ReturnType<typeof startXrpc>> | undefined
  let pds: ChildProcess | undefined
  const keypair = await Secp256k1Keypair.create()
  const rogueDid = `did:plc:${'a'.repeat(24)}`
  const directory = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && decodeURIComponent(req.url ?? "") === `/${serviceDid}`) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: serviceDid, service: [{ id: '#pirs', type: 'PirsPluginService', serviceEndpoint: `http://localhost:${service!.port}` }] }))
        return
      }
      if (req.method === 'GET' && decodeURIComponent(req.url ?? "") === `/${rogueDid}`) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: rogueDid, verificationMethod: [{ id: `${rogueDid}#atproto`, controller: rogueDid,
          type: 'Multikey', publicKeyMultibase: keypair.did().split(':').at(-1) }] }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await fetch(`${plc.url}${req.url}`, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text())
    } catch { res.writeHead(400).end() }
  })
  directory.listen(0, '127.0.0.1')
  await once(directory, 'listening')
  const address = directory.address()
  assert.ok(address && typeof address !== 'string')
  const plcUrl = `http://localhost:${address.port}`
  // Only this disposable fixture opts out of resolver SSRF protection.
  const resolver = new DidResolver({ plcUrl, timeout: 1000, fetch })
  const manifest = { schemaVersion: 1, id: 'xrpc-fixture', minSpecLevel: 1, hooks: ['xrpc.serve'], capabilities: [
    { name: 'diagnostics.log', constraints: {} }, { name: 'xrpc.serve', constraints: { nsids } }
  ] }
  const manifestPath = join(root, 'manifest.json')
  const install = async (value = manifest, success = true) => {
    await writeFile(manifestPath, JSON.stringify(value))
    if (!success) {
      assert.throws(() => execFileSync(host, ['--plugin', plugin, '--manifest', manifestPath, '--install-dir', join(root, 'installs')], { stdio: 'pipe' }))
      return ''
    }
    return JSON.parse(execFileSync(host, ['--plugin', plugin, '--manifest', manifestPath, '--install-dir', join(root, 'installs')], { encoding: 'utf8' })).installed as string
  }
  try {
    const installation = await install()
    for (const invalid of [[], ['tv.test.echo', 'tv.test.echo'], ['com.atproto.repo.createRecord'], ['app.bsky.feed.getTimeline'], ['bad'], ['tv.test.*'], ['tv.test.bad-name'], ['Com.Atproto.repo.describeRepo'], ['APP.Bsky.feed.getTimeline']]) {
      const bad = structuredClone(manifest); bad.capabilities[1].constraints = { nsids: invalid }
      await install(bad, false)
    }
    const missingHook = structuredClone(manifest); missingHook.hooks = []
    await install(missingHook, false)
    const lowerLevel = structuredClone(manifest); lowerLevel.minSpecLevel = 0
    await install(lowerLevel, false)
    const unknownConstraint = structuredClone(manifest)
    Object.assign(unknownConstraint.capabilities[1].constraints, { methods: ['GET'] })
    await install(unknownConstraint, false)
    const options = { host, installation, serviceDid, serviceId: 'pirs', resolver }
    strict = await startXrpc(options)
    service = await startXrpc({ ...options, legacyBareAudience: true })
    assert.deepEqual(service.nsids, nsids)
    assert.equal((await readFile(`/proc/${service.runtimePid}/environ`)).length, 0)
    let invoked = 0
    const request = async (token?: string, method = 'tv.test.echo', extra: RequestInit = {}, target = service!) => {
      const res = await fetch(`http://127.0.0.1:${target.port}/xrpc/${method}`, { ...extra,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers }, signal: AbortSignal.timeout(10_000) })
      return { status: res.status, body: await res.json() }
    }
    const sign = (overrides: Record<string, unknown> = {}) => createServiceJwt({ iss: rogueDid, aud: `${serviceDid}#pirs`, lxm: 'tv.test.echo', keypair, ...overrides })
    const good = await sign()
    const success = await request(good, 'tv.test.echo?hello=world')
    assert.equal(success.status, 200)
    assert.deepEqual(success.body, { nsid: 'tv.test.echo', method: 'GET', issuer: rogueDid, query: 'hello=world', body: null })
    invoked++
    for (const method of ['tv.123.echo', 'Tv.Test.echo2']) {
      const response = await request(await sign({ lxm: method }), method)
      assert.equal(response.status, 200)
      assert.equal(response.body.nsid, method)
      invoked++
    }
    for (const method of ['tv.test.bad-name', 'Com.Atproto.repo.describeRepo', 'APP.Bsky.feed.getTimeline', 'tv.test.echo2']) {
      assert.equal((await request(await sign({ lxm: method }), method)).body.error, 'MethodNotImplemented')
      const direct = JSON.parse(execFileSync(host, ['--installation', installation], { encoding: 'utf8',
        input: JSON.stringify({ id: 1, input: `xrpc:${JSON.stringify({ nsid: method, method: 'GET', issuer: rogueDid, query: '', body: null })}` }) + '\n'
      }).trim().split('\n')[1])
      assert.equal(direct.error, 'invalid_request')
      assert.equal(direct.peak_memory_bytes, 0)
      assert.deepEqual(direct.logs, [])
    }
    assert.equal((await request(good)).body.error, 'InvalidToken', 'replay refused')
    assert.equal((await request()).status, 401)
    assert.equal((await request(await sign(), 'tv.test.undeclared')).body.error, 'MethodNotImplemented')
    const now = Math.floor(Date.now() / 1000)
    for (const overrides of [
      { aud: `did:plc:${'c'.repeat(24)}` }, { aud: `${serviceDid}#other` }, { lxm: 'tv.test.other' },
      { exp: now - 1, iat: now - 60 }, { iss: `did:plc:${'c'.repeat(24)}` }, { exp: now + 120 },
      { iat: now + 20, exp: now + 60 }, { lxm: null }, { iss: `${rogueDid}#other` }
    ]) assert.equal((await request(await sign(overrides))).status, 401, JSON.stringify(overrides))
    const parts = (await sign()).split('.')
    parts[2] = Buffer.alloc(64).toString('base64url')
    assert.equal((await request(parts.join('.'))).status, 401)
    assert.equal((await request(await sign({ aud: serviceDid }), 'tv.test.echo', {}, strict)).status, 401, 'strict mode refuses bare audience')
    assert.equal((await request(await sign({ aud: serviceDid }))).status, 200, 'explicit legacy audience accepted')
    invoked++
    // Wrong kid, missing nonce and nonnumeric dates are signed hostile tokens.
    const rawSign = async (header: object, payload: object) => {
      const message = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
      return `${message}.${Buffer.from(await keypair.sign(Buffer.from(message))).toString('base64url')}`
    }
    for (const [header, payload] of [
      [{ typ: 'JWT', alg: 'ES256K', kid: '#other' }, { iss: rogueDid, aud: serviceDid, lxm: 'tv.test.echo', iat: now, exp: now + 60, jti: 'kid' }],
      [{ typ: 'JWT', alg: 'ES256K' }, { iss: rogueDid, aud: serviceDid, lxm: 'tv.test.echo', iat: now, exp: now + 60 }],
      [{ typ: 'JWT', alg: 'ES256K' }, { iss: rogueDid, aud: serviceDid, lxm: 'tv.test.echo', iat: now, exp: 'Infinity', jti: 'date' }]
    ]) assert.equal((await request(await rawSign(header, payload))).status, 401)
    for (const [name, status, error] of [
      ['trap', 500, 'PluginFailed'], ['loop', 504, 'PluginTimeout'], ['memory', 500, 'PluginLimitExceeded'],
      ['response', 500, 'PluginLimitExceeded'], ['log', 500, 'PluginLimitExceeded'], ['invalid', 500, 'PluginInvalidResponse']
    ] as const) {
      const method = `tv.test.${name}`
      const failed = await request(await sign({ lxm: method }), method)
      assert.deepEqual(failed, { status, body: { error } })
      assert.equal((await request(await sign())).status, 200, `recovery after ${name}`)
      invoked += 2
    }
    const post = await request(await sign(), 'tv.test.echo', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'private', 'x-secret': 'private' }, body: '{"hello":1}' })
    assert.equal(post.status, 200)
    assert.deepEqual(post.body, { nsid: 'tv.test.echo', method: 'POST', issuer: rogueDid, query: '', body: { hello: 1 } })
    invoked++
    assert.equal((await request(await sign(), 'tv.test.echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(8193) })).status, 413)
    assert.equal((await request(await sign(), 'tv.test.echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
    assert.equal((await request(await sign(), 'tv.test.echo', { method: 'POST', headers: { 'content-type': 'text/html' }, body: 'hi' })).status, 400)
    assert.equal((await request(await sign(), 'tv.test.echo', { method: 'PUT' })).status, 405)
    // Resolution occupies admission, and expiration is checked after the wait.
    let entered = false
    let release: (() => void) | undefined
    const stalled = await startXrpc({ ...options, resolver: { resolveAtprotoKey: async (...args) => {
      entered = true
      await new Promise<void>(resolve => { release = resolve })
      return resolver.resolveAtprotoKey(...args)
    } } })
    try {
      const shortNow = Math.floor(Date.now() / 1000)
      const pending = request(await sign({ iat: shortNow, exp: shortNow + 1 }), 'tv.test.echo', {}, stalled)
      const resolutionDeadline = Date.now() + 5000
      while (!entered && Date.now() < resolutionDeadline) await new Promise(resolve => setTimeout(resolve, 5))
      if (!entered) assert.fail(`resolver was not entered: ${JSON.stringify(await pending)}`)
      assert.equal((await request(await sign(), 'tv.test.echo', {}, stalled)).body.error, 'PluginBusy')
      await new Promise(resolve => setTimeout(resolve, 1100))
      release!()
      assert.equal((await pending).status, 401, 'token expires during resolution before guest invocation')
    } finally { release?.(); await stalled.close() }
    process.kill(strict.runtimePid!, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal((await request(await sign(), 'tv.test.echo', {}, strict)).body.error, 'PluginUnavailable')
    // A direct runtime request bypasses HTTP but still cannot escape NSID grants.
    const direct = JSON.parse(execFileSync(host, ['--installation', installation], { encoding: 'utf8', input: JSON.stringify({ id: 1, input: `xrpc:${JSON.stringify({ nsid: 'tv.test.undeclared', method: 'GET', issuer: rogueDid, query: '', body: null })}` }) + '\n' }).trim().split('\n')[1])
    assert.equal(direct.error, 'invalid_request'); assert.equal(direct.peak_memory_bytes, 0); assert.deepEqual(direct.logs, [])
    await mkdir(join(root, 'pds'), { mode: 0o700 })
    const fixturePath = fileURLToPath(new URL('../events/pds-fixture.ts', import.meta.url))
    pds = spawn(process.execPath, [fixturePath, join(root, 'pds'), join(root, 'transport/events.sock'), plcUrl], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    pds.stdout!.on('data', chunk => { output += chunk }); pds.stderr!.on('data', chunk => { errors += chunk })
    const deadline = Date.now() + 20_000
    while (!output.includes('"ready":true') && Date.now() < deadline && pds.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(output.includes('"ready":true'), errors)
    const base = `http://127.0.0.1:${JSON.parse(output.trim().split('\n').at(-1)!).port}`
    const accountResponse = await fetch(`${base}/xrpc/com.atproto.server.createAccount`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'smoke.test', email: 'pirs-xrpc@example.com', password: randomBytes(24).toString('hex') }) })
    assert.equal(accountResponse.status, 200, await accountResponse.clone().text())
    const account = await accountResponse.json()
    assert.equal((await request(await sign({ iss: account.did }))).status, 401, 'known account issuer with another signing key refused')
    const proxied = await fetch(`${base}/xrpc/tv.test.echo?through=pds`, { headers: { authorization: `Bearer ${account.accessJwt}`, 'atproto-proxy': `${serviceDid}#pirs`, cookie: 'must-not-reach-guest' } })
    assert.equal(proxied.status, 200, await proxied.clone().text())
    assert.deepEqual(await proxied.json(), { nsid: 'tv.test.echo', method: 'GET', issuer: account.did, query: 'through=pds', body: null })
    const numericProxy = await fetch(`${base}/xrpc/tv.123.echo`, { headers: { authorization: `Bearer ${account.accessJwt}`, 'atproto-proxy': `${serviceDid}#pirs` } })
    assert.equal(numericProxy.status, 200, await numericProxy.clone().text())
    assert.equal((await numericProxy.json()).nsid, 'tv.123.echo')
    assert.equal((await fetch(`${base}/xrpc/tv.test.undeclared`, { headers: { authorization: `Bearer ${account.accessJwt}`, 'atproto-proxy': `${serviceDid}#pirs` } })).status, 400)
    assert.equal((await fetch(`${base}/xrpc/tv.test.echo`, { headers: { 'atproto-proxy': `${serviceDid}#pirs` } })).status, 401)
    const proxyPost = await fetch(`${base}/xrpc/tv.test.echo`, { method: 'POST', headers: { authorization: `Bearer ${account.accessJwt}`, 'atproto-proxy': `${serviceDid}#pirs`, 'content-type': 'application/json' }, body: '{"through":"pds"}' })
    assert.equal(proxyPost.status, 200, await proxyPost.clone().text())
    assert.deepEqual((await proxyPost.json()).body, { through: 'pds' })
    console.log(JSON.stringify({ realPdsProxy: ['GET', 'POST'], issuer: account.did, audience: 'explicit legacy bare DID',
      nativeGrantBypassRefused: true, guestFailureRecoveryPairs: 6, authNegativeCases: 18, installNegativeCases: 12, directInvocations: invoked,
      runtimeEnvironmentEmpty: true, productionOrHostedClaim: false }))
  } finally {
    if (pds && pds.exitCode === null && pds.signalCode === null) { const exit = once(pds, 'exit'); pds.kill('SIGKILL'); await exit }
    await service?.close(); await strict?.close()
    directory.closeAllConnections(); await new Promise<void>(resolve => directory.close(() => resolve()))
    await plc.close(); await rm(root, { recursive: true, force: true })
  }
})
