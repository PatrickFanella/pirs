import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const track = process.argv[2]
if (!['stock', 'patched'].includes(track)) throw new Error('stock or patched required')
const pins = JSON.parse(await readFile(new URL('./pins.json', import.meta.url), 'utf8'))
const artifact = await readFile(new URL(pins.artifact, import.meta.url))
if (createHash('sha256').update(artifact).digest('hex') !== pins.artifactSha256) throw new Error('patched package hash mismatch')
const url = new URL('../../package.json', import.meta.url)
const pkg = JSON.parse(await readFile(url, 'utf8'))
pkg.dependencies['@atproto/pds'] = track === 'stock' ? pins.packageVersion : `file:pirs/pds-patches/${pins.artifact}`
await writeFile(url, JSON.stringify(pkg, null, 2) + '\n')
await copyFile(new URL(`./${track}-lock.yaml`, import.meta.url), new URL('../../pnpm-lock.yaml', import.meta.url))
