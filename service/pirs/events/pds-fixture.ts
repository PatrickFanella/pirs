// Qualification only: persistent disposable data permits a SIGKILL/restart
// rehearsal. The parent owns the loopback PLC and all cleanup.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { PDS, readEnv } from '@atproto/pds'
import { attachEvents, attachRoutes } from '../bridge.ts'

const [data, socket, plc] = process.argv.slice(2)
if (!data || !socket || !plc?.startsWith('http://localhost:')) throw new Error('disposable fixture arguments required')
for (const key of Object.keys(process.env)) if (key.startsWith('PDS_')) delete process.env[key]
Object.assign(process.env, {
  PDS_HOSTNAME: 'localhost', PDS_DEV_MODE: 'true', PDS_PORT: '0',
  PDS_DATA_DIRECTORY: data, PDS_BLOBSTORE_DISK_LOCATION: join(data, 'blocks'),
  PDS_JWT_SECRET: '0'.repeat(64), PDS_ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: randomBytes(32).toString('hex'),
  PDS_DID_PLC_URL: plc, PDS_INVITE_REQUIRED: 'false', PDS_CRAWLERS: '',
  PIRS_EVENT_SOCKET: socket, LOG_ENABLED: 'false'
})
await PDS.run({
  env: readEnv(),
  onCreated(pds) {
    const listen = pds.app.listen.bind(pds.app)
    pds.app.listen = ((port: number) => listen(port, '127.0.0.1')) as typeof pds.app.listen
    attachRoutes(pds)
  },
  async onStarted(pds) {
    await attachEvents(pds)
    const address = pds.server!.address()
    if (!address || typeof address === 'string') throw new Error('fixture has no address')
    console.log(JSON.stringify({ ready: true, port: address.port }))
  }
})
