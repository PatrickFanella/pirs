import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { startPlcFixture } from '../plc-fixture.ts'

const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
const plugin = fileURLToPath(new URL('../host/target/public-read.wasm', import.meta.url))
const collection = 'tv.123.asset'
const deniedCollection = 'tv.other.asset'

test('installed guest enforces public-read grants and HTTP observation semantics against real local PDS', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pirs-public-read-'))
  const plc = await startPlcFixture(2)
  const admin = randomBytes(24).toString('hex')
  await mkdir(join(root, 'data'))
  const pds = spawn(process.execPath, [fileURLToPath(new URL('./pds-fixture.ts', import.meta.url)), join(root, 'data'), plc.url,
    ...(process.env.PIRS_READ_PDS_MODULE ? [process.env.PIRS_READ_PDS_MODULE] : [])],
    { env: { PATH: process.env.PATH, PIRS_FIXTURE_ADMIN: admin }, stdio: ['ignore', 'pipe', 'pipe'] })
  let runtime: ReturnType<typeof spawn> | undefined
  let proxy: ReturnType<typeof createServer> | undefined
  const checks: Record<string, boolean> = {}
  try {
    let output = '', errors = ''
    pds.stdout!.on('data', chunk => { output += chunk }); pds.stderr!.on('data', chunk => { errors += chunk })
    const deadline = Date.now() + 20_000
    while (!output.includes('"ready":true') && Date.now() < deadline && pds.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(output.includes('"ready":true'), errors)
    const base = `http://127.0.0.1:${JSON.parse(output.trim().split('\n').at(-1)!).port}`
    const post = async (method: string, body: unknown, authorization?: string) => {
      const res = await fetch(`${base}/xrpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      assert.equal(res.status, 200, `${method}: ${await res.clone().text()}`)
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    }
    const account = async (name: string) => post('com.atproto.server.createAccount', { handle: `${name}.test`, email: `${name}@example.com`, password: randomBytes(24).toString('hex') })
    const alice = await account('alice'), bob = await account('bob')
    const upload = async (account: any, bytes: Uint8Array) => {
      const res = await fetch(`${base}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${account.accessJwt}` }, body: bytes as any })
      assert.equal(res.status, 200); return (await res.json()).blob
    }
    const put = async (account: any, col: string, rkey: string, value: any) => post('com.atproto.repo.putRecord', { repo: account.did, collection: col, rkey, validate: false, record: { $type: col, ...value } }, `Bearer ${account.accessJwt}`)
    const blob = await upload(alice, Buffer.from('public bytes'))
    const foreignBlob = await upload(bob, Buffer.from('bob only bytes'))
    const largeBlob = await upload(alice, Buffer.alloc(65536, 120))
    const overBlob = await upload(alice, Buffer.alloc(65537, 121))
    const original = await put(alice, collection, 'page', { text: 'allowed record', nested: [{ file: blob }] })
    await put(bob, collection, 'page', { text: 'bob record', file: foreignBlob })
    await put(alice, deniedCollection, 'secret', { file: blob })
    await put(alice, collection, 'plain', { text: 'no blob ref', link: blob.ref })
    await put(alice, collection, 'large', { file: largeBlob })
    await put(alice, collection, 'over', { file: overBlob })
    await put(alice, collection, 'large-record', { text: 'x'.repeat(65536) })
    const manifest: any = { schemaVersion: 1, id: 'public-reader', minSpecLevel: 0, hooks: ['event.commit'], capabilities: [
      { name: 'events.subscribe', constraints: { eventTypes: ['commit'], collections: ['*'] } },
      { name: 'records.read', constraints: { collections: [collection] } },
      { name: 'blobs.read', constraints: { collections: [collection] } }
    ] }
    const manifestPath = join(root, 'manifest.json')
    const install = async (value = manifest, success = true) => {
      await writeFile(manifestPath, JSON.stringify(value))
      const args = ['--plugin', plugin, '--manifest', manifestPath, '--install-dir', join(root, 'installs')]
      if (!success) { assert.throws(() => execFileSync(host, args, { stdio: 'pipe' })); return '' }
      return JSON.parse(execFileSync(host, args, { encoding: 'utf8' })).installed as string
    }
    const installation = await install()
    for (const operation of ['records.read', 'blobs.read']) {
      const missing = structuredClone(manifest); missing.capabilities = missing.capabilities.filter((c: any) => c.name !== operation)
      await install(missing, false)
      for (const collections of [[], ['*'], [collection, collection], ['invalid'], ['tv.test.bad-name']]) {
        const bad = structuredClone(manifest); bad.capabilities.find((c: any) => c.name === operation).constraints = { collections }
        await install(bad, false)
      }
    }
    checks.install_scopes_and_imports = true
    assert.throws(() => execFileSync(host, ['--installation', installation], { stdio: 'pipe' }))
    checks.missing_pds_fails_before_readiness = true
    const directInput = (action: string) => JSON.stringify({ id: 1, input: `event:${JSON.stringify({ seq: 1, type: 'commit', time: 'now', evt: { repo: [action, alice.did, collection, 'page', blob.ref.$link].join('|'), ops: [{ path: `${collection}/trigger`, action: 'create' }] } })}` }) + '\n'
    for (const action of ['get', 'blob']) {
      const rows = execFileSync(host, ['--installation', installation, '--public-pds', base, '--deadline-ms', '1000'], { encoding: 'utf8', input: directInput(action) }).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(rows[1].ok, true)
      if (action === 'get') assert.equal(JSON.parse(rows[1].result).value.text, 'allowed record')
      else assert.equal(rows[1].result, `blob:12:${Buffer.from('public bytes').toString('hex')}`)
      const raw = execFileSync(host, ['--plugin', plugin, '--qualification-only'], { encoding: 'utf8', input: directInput(action) }).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(raw[1].result, 'denied:public read capability denied')
    }
    checks.direct_stock_api_record_blob_and_raw_capability_refusal = true
    // A forwarding fixture drives mutations during real stock API reads and
    // hostile wire responses. Shipping host has no fixture flag or bypass.
    let mode = '', recordCalls = 0, blobCalls = 0, requestCount = 0
    const moderation = (subject: any, flags: any) => post('com.atproto.admin.updateSubjectStatus', { subject, ...flags }, `Basic ${Buffer.from(`admin:${admin}`).toString('base64')}`)
    const repo = { $type: 'com.atproto.admin.defs#repoRef', did: alice.did }
    proxy = createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, undefined)
        assert.equal(req.headers.cookie, undefined)
        requestCount++
        const url = new URL(req.url!, base)
        if (mode === 'redirect') { res.writeHead(302, { location: `${base}/xrpc/com.atproto.repo.getRecord` }).end(); return }
        if (mode === 'oversize-wire' && url.pathname.endsWith('getRecord')) { res.writeHead(200); res.end('x'.repeat(65537)); return }
        if (mode === 'suspended' && url.pathname.endsWith('getRepoStatus')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ did: alice.did, active: false, status: 'suspended' })); return }
        if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 600))
        if (url.pathname.endsWith('getRecord')) {
          recordCalls++
          if (mode === 'record-takedown' && recordCalls === 2) await moderation({ $type: 'com.atproto.repo.strongRef', ...original }, { takedown: { applied: true } })
          if (mode === 'rev-change' && recordCalls === 2) await put(alice, collection, 'other', { text: 'revision changed' })
        }
        const upstream = await fetch(`${base}${req.url}`)
        const bytes = Buffer.from(await upstream.arrayBuffer())
        if (mode === 'late-account-deactivate' && url.pathname.endsWith('getRepoStatus') && recordCalls === 2) await moderation(repo, { deactivated: { applied: true } })
        if (url.pathname.endsWith('getBlob')) {
          blobCalls++
          if (mode === 'late-record-takedown' && blobCalls === 2) await moderation({ $type: 'com.atproto.repo.strongRef', ...original }, { takedown: { applied: true } })
          if (mode === 'late-blob-takedown' && blobCalls === 2) await moderation({ $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: true } })
          if (mode === 'blob-takedown' && blobCalls === 1) await moderation({ $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: true } })
          if (mode === 'account-deactivate') await moderation(repo, { deactivated: { applied: true } })
          if (mode === 'ref-delete') await put(alice, collection, 'page', { text: 'reference removed' })
        }
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(bytes)
      } catch { res.writeHead(500).end() }
    })
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
    const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string')
    runtime = spawn(host, ['--installation', installation, '--public-pds', `http://127.0.0.1:${proxyAddress.port}`, '--deadline-ms', '400', '--response-bytes', '8192'], { env: {}, stdio: 'pipe' })
    runtime.stderr!.resume()
    const lines = createInterface({ input: runtime.stdout! })[Symbol.asyncIterator]()
    assert.equal(JSON.parse((await lines.next()).value!).ready, true)
    assert.equal((await readFile(`/proc/${runtime.pid}/environ`)).length, 0)
    let sequence = 0
    const call = async (action = 'get', did = alice.did, col = collection, key = 'page', cid = blob.ref.$link) => {
      recordCalls = 0; blobCalls = 0
      const id = ++sequence
      runtime!.stdin!.write(JSON.stringify({ id, input: `event:${JSON.stringify({ seq: id, type: 'commit', time: 'now', evt: { repo: [action, did, col, key, cid].join('|'), ops: [{ path: `${collection}/trigger`, action: 'create' }] } })}` }) + '\n')
      const row = JSON.parse((await lines.next()).value!)
      assert.equal(row.id, id)
      return row
    }
    const allowed = await call(); assert.equal(allowed.ok, true)
    assert.equal(JSON.parse(allowed.result).value.text, 'allowed record')
    const bytes = await call('blob'); assert.equal(bytes.result, `blob:12:${Buffer.from('public bytes').toString('hex')}`)
    checks.real_allowed_record_and_blob = true
    const denied = async (...args: Parameters<typeof call>) => {
      const row = await call(...args); assert.equal(row.ok, true); assert.match(row.result, /^denied:/); return row
    }
    const before = requestCount
    await denied('get', alice.did, deniedCollection, 'secret')
    await denied('blob', alice.did, deniedCollection, 'secret')
    await denied('get', 'alice.test')
    await denied('get', alice.did, collection, '../page')
    assert.equal(requestCount, before, 'scope refusal makes no PDS request')
    checks.undeclared_collection_handle_and_path_denied_before_io = true
    await denied('get', `did:plc:${'a'.repeat(24)}`)
    checks.nonlocal_did_denied = true
    await denied('blob', bob.did)
    await denied('blob', alice.did, collection, 'page', foreignBlob.ref.$link)
    await denied('blob', alice.did, collection, 'plain')
    await denied('blob', alice.did, collection, 'missing')
    checks.cid_without_current_account_collection_record_ownership_denied = true
    assert.equal((await call('blob', bob.did, collection, 'page', foreignBlob.ref.$link)).result, `blob:14:${Buffer.from('bob only bytes').toString('hex')}`)
    checks.other_local_active_account_allowed = true
    await denied('get', alice.did, collection, 'large-record')
    await denied('blob', alice.did, collection, 'over', overBlob.ref.$link)
    assert.equal((await call('blob', alice.did, collection, 'large', largeBlob.ref.$link)).result, 'blob:65536:')
    const budget = await call('budget', alice.did, collection, 'large', largeBlob.ref.$link)
    assert.equal(budget.result, 'blob:65536:blob:65536:denied:public read quota exceeded')
    const flood = await call('flood'); assert.match(flood.result, /^(allowed;){8}denied:public read quota exceeded$/)
    checks.result_64k_call_8_and_total_128k_limits = true
    await moderation({ $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: true } })
    await denied('blob')
    await moderation({ $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: false } })
    checks.blob_takedown_denied = true
    for (const flags of [{ deactivated: { applied: true } }, { takedown: { applied: true } }]) {
      await moderation(repo, flags)
      await denied('get'); await denied('blob')
      await moderation(repo, { deactivated: { applied: false }, takedown: { applied: false } })
      assert.equal((await call()).ok, true)
    }
    checks.deactivated_and_suspended_taken_down_account_denied = true
    await post('com.atproto.server.deactivateAccount', {}, `Bearer ${alice.accessJwt}`)
    await denied('get'); await denied('blob')
    await moderation(repo, { deactivated: { applied: false } })
    checks.real_self_deactivation_denied = true
    mode = 'blob-takedown'; await denied('blob'); mode = ''
    await moderation({ $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: false } })
    mode = 'account-deactivate'; await denied('blob'); mode = ''
    await moderation(repo, { deactivated: { applied: false } })
    mode = 'ref-delete'; await denied('blob'); mode = ''
    await put(alice, collection, 'page', { text: 'allowed record', nested: [{ file: blob }] })
    mode = 'record-takedown'; await denied('blob'); mode = ''
    await moderation({ $type: 'com.atproto.repo.strongRef', ...original }, { takedown: { applied: false } })
    mode = 'rev-change'; await denied(); mode = ''
    checks.inflight_account_blob_record_and_revision_changes_denied = true
    // Accepted observation semantics: moderation after the final sample cannot
    // retract a buffered response. Subsequent anonymous requests must refuse it.
    for (const late of ['late-record-takedown', 'late-blob-takedown']) {
      mode = late
      const delivered = await call('blob'); mode = ''
      assert.equal(delivered.result, `blob:12:${Buffer.from('public bytes').toString('hex')}`)
      const hiddenMethod = late === 'late-record-takedown' ? `com.atproto.repo.getRecord?repo=${alice.did}&collection=${collection}&rkey=page` : `com.atproto.sync.getBlob?did=${alice.did}&cid=${blob.ref.$link}`
      const hidden = await fetch(`${base}/xrpc/${hiddenMethod}`)
      assert.notEqual(hidden.status, 200)
      console.log(JSON.stringify({reviewProbe: late, guestResult: delivered.result, anonymousApiAfterTakedown: hidden.status, moderationCompletedBeforeSecondBlobResponse: true}))
      await moderation(late === 'late-record-takedown' ? { $type: 'com.atproto.repo.strongRef', ...original } : { $type: 'com.atproto.admin.defs#repoBlobRef', did: alice.did, cid: blob.ref.$link }, { takedown: { applied: false } })
    }
    mode = 'late-account-deactivate'
    const lateAccount = await call('get'); mode = ''
    assert.equal(JSON.parse(lateAccount.result).value.text, 'allowed record')
    const inactiveStatus = await (await fetch(`${base}/xrpc/com.atproto.sync.getRepoStatus?did=${alice.did}`)).json()
    assert.equal(inactiveStatus.active, false)
    console.log(JSON.stringify({reviewProbe: 'late-account-deactivate', guestReceivedRecord: true, actualActiveAtGuestDelivery: inactiveStatus.active, actualStatus: inactiveStatus.status, deactivationCompletedBeforeFinalStatusResponse: true}))
    await moderation(repo, { deactivated: { applied: false } })
    checks.buffered_final_responses_follow_accepted_observation_semantics = true
    mode = 'suspended'; await denied(); await denied('blob'); mode = ''
    checks.explicit_suspended_status_denied = true
    mode = 'redirect'; await denied(); mode = ''
    mode = 'oversize-wire'; await denied(); mode = ''
    mode = 'slow'; const timeout = await call(); assert.equal(timeout.error, 'timeout'); mode = ''
    assert.equal(JSON.parse((await call()).result).value.text, 'allowed record')
    checks.redirect_stream_size_deadline_and_same_process_recovery = true
    checks.runtime_empty_environment_no_database_or_paths = true
    assert.equal((await call()).result.includes(root), false)
    const report = { checks, calls: sequence, pdsModule: process.env.PIRS_READ_PDS_MODULE ? 'explicit stock package' : 'selected package',
      hostSha256: createHash('sha256').update(await readFile(host)).digest('hex'), pluginSha256: createHash('sha256').update(await readFile(plugin)).digest('hex'),
      productionOrHostedClaim: false }
    if (process.env.PIRS_READ_REPORT) await writeFile(process.env.PIRS_READ_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  } finally {
    if (runtime && runtime.exitCode === null && runtime.signalCode === null) { const exit = once(runtime, 'exit'); runtime.kill('SIGKILL'); await exit }
    proxy?.closeAllConnections(); await new Promise<void>(resolve => proxy ? proxy.close(() => resolve()) : resolve())
    if (pds.exitCode === null && pds.signalCode === null) { const exit = once(pds, 'exit'); pds.kill('SIGTERM'); await exit }
    await plc.close(); await rm(root, { recursive: true, force: true })
  }
})
