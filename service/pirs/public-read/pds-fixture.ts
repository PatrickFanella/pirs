// Disposable qualification PDS only. No bridge or package patches are needed.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
const [data, plc, modulePath] = process.argv.slice(2)
if (!data || !plc?.startsWith('http://localhost:')) throw new Error('disposable arguments required')
const { PDS, readEnv } = await import(modulePath || '@atproto/pds')
const admin = process.env.PIRS_FIXTURE_ADMIN
if (!admin) throw new Error('disposable admin required')
for (const key of Object.keys(process.env)) if (key.startsWith('PDS_')) delete process.env[key]
Object.assign(process.env, {
  PDS_HOSTNAME: 'localhost', PDS_DEV_MODE: 'true', PDS_PORT: '0',
  PDS_DATA_DIRECTORY: data, PDS_BLOBSTORE_DISK_LOCATION: join(data, 'blocks'),
  PDS_JWT_SECRET: randomBytes(32).toString('hex'), PDS_ADMIN_PASSWORD: admin,
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: randomBytes(32).toString('hex'),
  PDS_DID_PLC_URL: plc, PDS_INVITE_REQUIRED: 'false', PDS_CRAWLERS: '', LOG_ENABLED: 'false'
})
const stop = new AbortController()
process.once('SIGTERM', () => stop.abort())
await PDS.run({ env: readEnv(), signal: stop.signal,
  onCreated(pds: any) {
    const listen = pds.app.listen.bind(pds.app)
    pds.app.listen = (port: number) => listen(port, '127.0.0.1')
  },
  onStarted(pds: any) {
    const address = pds.server.address()
    console.log(JSON.stringify({ ready: true, port: address.port }))
  }
})
