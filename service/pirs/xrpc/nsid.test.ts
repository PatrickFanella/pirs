import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { startXrpc } from './server.ts'

// Resolve the frozen transitive validator without changing the dependency graph.
const require = createRequire(import.meta.url)
const upstream = createRequire(require.resolve('@atproto/identity'))('@atproto/syntax')
const syntaxPath = createRequire(require.resolve('@atproto/identity')).resolve('@atproto/syntax')
assert.equal(JSON.parse(await readFile(new URL('../package.json', `file://${syntaxPath}`), 'utf8')).version, '0.7.6')
const cases = [
  ['tv.123.echo', true], ['tv.a-b.echo', true], ['Tv.Test.echo2', true],
  ['tv.test.bad-name', false], ['1tv.test.echo', false], ['tv.-test.echo', false],
  ['tv.test-.echo', false], ['tv.test.1echo', false], ['tv..echo', false],
  ['Com.Atproto.repo.describeRepo', false], ['APP.Bsky.feed.getTimeline', false],
] as const
const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
const plugin = fileURLToPath(new URL('../host/target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm', import.meta.url))
for (const [nsid, allowed] of cases) {
  test(`native manifest NSID ${nsid}`, async () => {
    assert.equal(upstream.isValidNsid(nsid), allowed || /^(com\.atproto|app\.bsky)\./i.test(nsid))
    const root = await mkdtemp(join(tmpdir(), 'pirs-nsid-'))
    try {
      const manifest = join(root, 'manifest.json')
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, id: 'nsid', minSpecLevel: 1,
        hooks: ['xrpc.serve'], capabilities: [{ name: 'diagnostics.log', constraints: {} },
          { name: 'xrpc.serve', constraints: { nsids: [nsid] } }] }))
      const install = () => execFileSync(host, ['--plugin', plugin, '--manifest', manifest, '--install-dir', join(root, 'installs')], { stdio: 'pipe' })
      if (allowed) assert.doesNotThrow(install)
      else assert.throws(install)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test(`supervisor readiness NSID ${nsid}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pirs-ready-'))
    let service: Awaited<ReturnType<typeof startXrpc>> | undefined
    try {
      // A trusted-runtime stub isolates the supervisor's independent validation.
      const stub = join(root, 'runtime')
      await writeFile(stub, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ ready: true, installationId: 'a'.repeat(64), xrpcNsids: [nsid] }))}); setInterval(() => {}, 1000)\n`, { mode: 0o700 })
      const start = () => startXrpc({ host: stub, installation: root, serviceDid: `did:plc:${'b'.repeat(24)}`, serviceId: 'pirs' })
      if (allowed) service = await start()
      else await assert.rejects(async () => { service = await start() }, /verified XRPC installation required/)
    } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
  })
}
