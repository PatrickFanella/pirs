import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export const host = fileURLToPath(new URL('../host/target/release/pirs-host', import.meta.url))
export const plugin = fileURLToPath(new URL('../host/target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm', import.meta.url))
export const grant = { routes: ['/', '/echo', '/hostile', '/loop', '/flood', '/invalid', '/headers', '/tiny'], requestBytes: 1024, responseBytes: 4096, deadlineMs: 100 }
export const manifest = { schemaVersion: 1, id: 'http-fixture', minSpecLevel: 1, hooks: ['http.serve'], capabilities: [
  { name: 'diagnostics.log', constraints: {} }, { name: 'http.serve', constraints: grant }
] }
export async function fixture(value: unknown = manifest) {
  const root = await mkdtemp(join(tmpdir(), 'pirs-http-'))
  try {
    const path = join(root, 'manifest.json'); await writeFile(path, JSON.stringify(value))
    const installed = JSON.parse(execFileSync(host, ['--plugin', plugin, '--manifest', path, '--install-dir', join(root, 'installs')], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }))
    return { root, installation: installed.installed as string, receipt: installed.receipt, close: () => rm(root, { recursive: true, force: true }) }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
