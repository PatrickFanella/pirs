import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { fixture, host, manifest } from './fixtures.ts'
import { startHttp, POLICY } from './server.ts'

test('installed HTTP origin bounds requests and excludes credentials and route shadowing', { timeout: 60_000 }, async () => {
  const f = await fixture()
  const options = { host, installation: f.installation, pluginAddress: '127.0.0.2', pdsOrigin: 'http://127.0.0.1:43141' }
  const one = await startHttp(options)
  const otherManifest = structuredClone(manifest); otherManifest.id = 'second-plugin'
  Object.assign(otherManifest.capabilities[1].constraints, { routes: ['/second'], requestBytes: 10, responseBytes: 512 })
  const f2 = await fixture(otherManifest)
  let two: Awaited<ReturnType<typeof startHttp>> | undefined
  try {
    assert.equal((await readFile(`/proc/${one.runtimePid}/environ`)).length, 0)
    await assert.rejects(startHttp(options), /already assigned/)
    for (const pluginAddress of ['127.0.0.1', 'localhost', 'example.com', '0.0.0.0']) await assert.rejects(startHttp({ ...options, pluginAddress }), /dedicated local/)
    await assert.rejects(startHttp({ ...options, pluginAddress: '127.0.0.3', pdsOrigin: 'http://localhost:43141' }))
    two = await startHttp({ ...options, installation: f2.installation, pluginAddress: '127.0.0.3' })
    const success = await fetch(`${one.origin}/echo?value=ok`, { method: 'POST', headers: { cookie: 'PDS_SESSION=SECRET', authorization: 'Bearer SECRET', 'proxy-authorization': 'SECRET', 'atproto-proxy': 'SECRET', 'x-forwarded-host': '127.0.0.1:43141', 'content-type': 'text/plain' }, body: 'hello' })
    assert.equal(success.status, 200)
    const echoed = JSON.parse(await success.text())
    assert.deepEqual(echoed, { path: '/echo', method: 'POST', query: 'value=ok', body: 'hello' })
    assert.equal(success.headers.get('content-security-policy'), POLICY)
    for (const name of ['set-cookie', 'location', 'access-control-allow-origin']) assert.equal(success.headers.get(name), null)
    for (const route of ['/xrpc/com.atproto.server.createSession', '/oauth/authorize', '/other-plugin', '/echo/../hostile', '/%65cho', '//echo']) {
      const status = await new Promise<number>(resolve => { const req = request(`${one.origin}`, { path: route }, res => { res.resume(); resolve(res.statusCode!) }); req.end() })
      assert.ok([400, 404].includes(status), route)
    }
    assert.equal((await fetch(`${two.origin}/echo`)).status, 404)
    assert.equal((await fetch(`${one.origin}/second`)).status, 404)
    assert.equal((await fetch(`${two.origin}/second`, { method: 'POST', body: 'x'.repeat(10) })).status, 200)
    assert.equal((await fetch(`${two.origin}/second`, { method: 'POST', body: 'x'.repeat(11) })).status, 413)
    const confused = await new Promise<number>(resolve => { const req = request(`${one.origin}/echo`, { headers: { host: new URL(two!.origin).host } }, res => { res.resume(); resolve(res.statusCode!) }); req.end() })
    assert.equal(confused, 400)
    assert.equal((await fetch(`${one.origin}/echo`, { method: 'DELETE' })).status, 405)
    assert.equal((await fetch(`${one.origin}/echo`, { method: 'POST', body: 'x'.repeat(1025) })).status, 413)
    assert.equal((await fetch(`${one.origin}/echo`, { method: 'POST', body: 'x'.repeat(1024) })).status, 200)
    const started = Date.now()
    assert.equal((await fetch(`${one.origin}/loop`)).status, 504)
    assert.ok(Date.now() - started < 2000)
    for (const route of ['/flood', '/invalid', '/headers']) assert.equal((await fetch(`${one.origin}${route}`)).status, 500)
    assert.equal((await fetch(`${one.origin}/echo`)).status, 200, 'same worker recovers')
    const page = await fetch(`${one.origin}/hostile`)
    assert.equal(page.status, 200); assert.match(await page.text(), /credentials:'include'/)
    // Runtime enforces the grant before Store allocation when the supervisor is bypassed.
    for (const call of [ { path: '/ungranted', method: 'GET', query: '', body: '' },
      { path: '/echo', method: 'POST', query: '', body: 'x'.repeat(1025) },
      { path: '/echo', method: 'GET', query: '', body: '', headers: { cookie: 'SECRET' } } ]) {
      const rows = execFileSync(host, ['--installation', f.installation], { input: JSON.stringify({ id: 1, input: `http:${JSON.stringify(call)}` }) + '\n', encoding: 'utf8' }).trim().split('\n').map(s => JSON.parse(s))
      assert.equal(rows[1].error, 'invalid_request'); assert.equal(rows[1].peak_memory_bytes, 0)
    }
    const slow = connect(Number(new URL(one.origin).port), '127.0.0.2')
    await new Promise<void>(resolve => slow.once('connect', resolve))
    slow.on('error', () => {})
    slow.write(`POST /echo HTTP/1.1\r\nHost: ${new URL(one.origin).host}\r\nContent-Length: 100\r\n\r\nx`)
    const stalled = Date.now()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await fetch(`${one.origin}/echo`)).status, 503)
    await new Promise<void>(resolve => { slow.resume(); slow.once('close', () => resolve()) })
    assert.ok(Date.now() - stalled < 3000, 'stalled request has a deadline')
    assert.equal((await fetch(`${one.origin}/echo`)).status, 200)
    const upgrade = await new Promise<string>(resolve => { const socket = connect(Number(new URL(one.origin).port), '127.0.0.2'); let data = ''; socket.on('data', c => data += c); socket.on('end', () => resolve(data)); socket.on('connect', () => socket.write(`GET /echo HTTP/1.1\r\nHost: ${new URL(one.origin).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)) })
    assert.match(upgrade, /400 Bad Request/)
  } finally { await one.close(); await two?.close(); await f2.close(); await f.close() }
})

test('HTTP installation rejects unsupported routes, limits and missing hook', async () => {
  for (const change of [ { routes: [] }, { routes: ['/', '/'] }, { routes: ['/xrpc'] }, { routes: ['/oauth/authorize'] }, { routes: ['/../secret'] }, { routes: ['/%65cho'] }, { requestBytes: 8193 }, { responseBytes: 16385 }, { deadlineMs: 1001 }, { unexpected: true } ]) {
    const bad = structuredClone(manifest); Object.assign(bad.capabilities[1].constraints, change)
    await assert.rejects(fixture(bad))
  }
  const bad = structuredClone(manifest); bad.hooks = []; await assert.rejects(fixture(bad))
})
