// A smoke-only PLC creation/resolution fixture. It accepts a bounded number of signed genesis
// operations, validates it with the PLC library, and keeps the document in memory.
// It is not a PLC directory implementation and supports no identity updates.
import { createServer } from 'node:http'
import { once } from 'node:events'
import * as plc from '@did-plc/lib'

export async function startPlcFixture(accounts = 1) {
  if (!Number.isInteger(accounts) || accounts < 1 || accounts > 8) throw new Error("invalid fixture account bound")
  const documents = new Map<string, plc.DidDocument>()
  const creationData = new Map<string, Awaited<ReturnType<typeof plc.assureValidCreationOp>>>()
  let reads = 0
  const server = createServer(async (req, res) => {
    try {
      const [encodedDid, resource] = (req.url?.slice(1) ?? '').split('/')
      const did = decodeURIComponent(encodedDid)
      if (resource && resource !== 'data') { res.writeHead(404).end(); return }
      if (!/^did:plc:[a-z2-7]{24}$/.test(did)) {
        res.writeHead(404).end()
        return
      }
      if (req.method === 'POST' && !resource) {
        if (documents.size >= accounts || documents.has(did)) {
          res.writeHead(409).end()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 64 * 1024) throw new Error('operation too large')
          chunks.push(chunk)
        }
        const op = JSON.parse(Buffer.concat(chunks).toString())
        const data = await plc.assureValidCreationOp(did, op)
        documents.set(did, plc.formatDidDoc(data))
        creationData.set(did, data)
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } else if (req.method === 'GET' && documents.has(did)) {
        reads += 1
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(resource === 'data' ? creationData.get(did) : documents.get(did)))
      } else {
        res.writeHead(404).end()
      }
    } catch {
      res.writeHead(400).end()
    }
  })
  server.requestTimeout = 5_000
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture address')
  return {
    // The PDS resolver rejects IP-literal hosts even in development mode.
    // localhost resolves to this fixture's loopback listener.
    url: `http://localhost:${address.port}`,
    stats: () => ({ documents: documents.size, reads }),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve())
      })
      documents.clear()
      creationData.clear()
    }
  }
}
