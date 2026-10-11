import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { POLICY } from '../http/server.ts'
import { startDemo, updatedHtml } from './demo.ts'
import { fetchPage } from '../events/consumer.ts'

test('installed four-capability site serves real repository blobs and updates without restarts', { timeout: 120_000 }, async () => {
  const demo = await startDemo()
  try {
    assert.deepEqual(demo.receipt.imports, ['pirs:sandbox/blobs-read@0.1.0.get', 'pirs:sandbox/records-read@0.1.0.get'])
    const installation = join(demo.root, 'installs', demo.receipt.installationId)
    const manifest = JSON.parse(await readFile(join(installation, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.capabilities.map((c: any) => c.name), ['events.subscribe', 'records.read', 'blobs.read', 'http.serve'])
    assert.equal((await readFile(`/proc/${demo.pids.http}/environ`)).length, 0)
    const get = (route = '/') => fetch(`${demo.origin}${route}`, { signal: AbortSignal.timeout(5000) })
    const first = await get()
    assert.equal(first.status, 200); assert.equal(first.headers.get('content-security-policy'), POLICY)
    assert.match(await first.text(), /Version one/)
    const about = await get('/about'); assert.match(about.headers.get('content-type')!, /^text\/plain/)
    assert.equal(await about.text(), 'Local site served by an installed plugin.')
    const pids = { ...demo.pids }
    const rev = await demo.publish('index', updatedHtml)
    await demo.waitForCommit(rev)
    const event = (await fetchPage(join(demo.root, 'events.sock'), 0)).events.find(event => (event.evt as any).rev === rev)
    assert.ok(event)
    const rows = execFileSync(fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url)),
      ['--installation', installation, '--public-pds', demo.pdsOrigin],
      { env: {}, encoding: 'utf8', input: JSON.stringify({ id: 1, input: `event:${JSON.stringify(event)}` }) + '\n' }
    ).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows[1].result, 'site-commit', 'installed guest recognizes the actual site commit')
    assert.match(await (await get()).text(), /Version two/)
    assert.deepEqual(demo.pids, pids)
    for (const pid of Object.values(pids)) await access(`/proc/${pid}`)
    assert.match(demo.progress(), /"delivered":/)
    const hostile = '<h1>Static page</h1><a href="http://127.0.0.1/session">Guest link</a><script>alert(1)</script>'
    await demo.publish('index', hostile)
    const safe = await (await get()).text()
    assert.match(safe, /<h1>Static page<\/h1>/); assert.ok(!safe.includes('href=') && !safe.includes('<script'))
    for (const [mime, bytes] of [['image/svg+xml', Buffer.from('<svg/>')], ['text/plain', Buffer.alloc(8193,120)], ['text/plain', Buffer.from([255])]] as const) {
      await demo.publish('index', bytes, mime)
      assert.equal((await get()).status,404)
    }
    await demo.publish('index', Buffer.alloc(8192,120), 'text/plain')
    assert.equal((await get()).status,200)
    const deleted = await demo.deletePage('index'); await demo.waitForCommit(deleted)
    assert.equal((await get()).status,404)
    assert.equal((await get('/other')).status,404)
    assert.equal((await get('/?did=other')).status,400)
    await demo.publish('index', updatedHtml)
    assert.equal((await get()).status,200, 'same serving runtime recovers')
  } finally { await demo.close() }
  await assert.rejects(access(demo.root))
  for (const pid of Object.values(demo.pids)) await assert.rejects(access(`/proc/${pid}`))
})
