// pnpm resolves workspace dependency keys concurrently. Canonicalize only
// package metadata and archive headers, preserving every built file byte.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
  return value
}
const artifact = process.argv[2]
if (!artifact) throw new Error('package archive path required')
const root = await mkdtemp(join(tmpdir(), 'pirs-pack-'))
try {
  execFileSync('tar', ['-xzf', artifact, '-C', root])
  const manifest = join(root, 'package', 'package.json')
  await writeFile(manifest, JSON.stringify(ordered(JSON.parse(await readFile(manifest, 'utf8'))), null, 2) + '\n')
  const tar = execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', root, 'package'], { maxBuffer: 32 * 1024 * 1024 })
  await writeFile(artifact, gzipSync(tar, { level: 9 }))
} finally {
  await rm(root, { recursive: true, force: true })
}
