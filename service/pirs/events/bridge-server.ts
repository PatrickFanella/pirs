import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import type { PDS } from '@atproto/pds'
import { listenPrivate } from './local-socket.ts'
import { EVENT_BYTES, PAGE_BYTES, PAGE_EVENTS, isSequence, type DeliveryEvent } from './protocol.ts'

type Sequencer = {
  requestSeqRange(options: Parameters<PDS['ctx']['sequencer']['requestSeqRange']>[0]): Promise<DeliveryEvent[]>
}

export async function startEventBridge(sequencer: Sequencer, socketPath: string) {
  let stream = ''
  let busy = false
  const metrics = { requests: 0, overloaded: 0, fullPages: 0, oversized: 0, maxBufferedEvents: 0, maxBufferedBytes: 0 }
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    const fail = (status: number, error: string) => { res.writeHead(status); res.end(JSON.stringify({ error })) }
    const url = new URL(req.url ?? '/', 'http://local')
    if (req.method !== 'GET' || url.pathname !== '/events') return fail(404, 'not_found')
    if (!stream) return fail(503, 'starting')
    const raw = url.searchParams.get('after')
    const after = raw !== null && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN
    if (!isSequence(after)) return fail(400, 'invalid_cursor')
    if (busy) { metrics.overloaded++; return fail(429, 'busy') }
    busy = true
    // Keep the slot until the response drains or the client disconnects, not
    // just until the DB query finishes. Slow readers cannot build a send queue.
    let queryDone = false
    let responseDone = false
    const release = () => { responseDone = true; if (queryDone) busy = false }
    res.once('close', release)
    res.once('finish', release)
    metrics.requests++
    try {
      const encoded: string[] = []
      let cursor = after
      let bytes = 128 // fixed envelope allowance, including stream/cursor
      let full = false
      while (encoded.length < PAGE_EVENTS) {
        const [event] = await sequencer.requestSeqRange({ earliestSeq: cursor, limit: 1 })
        if (!event || res.destroyed) break
        const body = JSON.stringify({ seq: event.seq, type: event.type, time: event.time, evt: event.evt }, (_key, value) => value instanceof Uint8Array
          ? { $bytes: Buffer.from(value).toString('base64') } : value)
        const size = Buffer.byteLength(body)
        if (size > EVENT_BYTES) {
          metrics.oversized++
          // Return preceding events first. The oversized event remains the
          // next event after that page's durable cursor; it is never skipped.
          if (!encoded.length) return fail(413, 'event_too_large')
          full = true
          break
        }
        if (bytes + size + 1 > PAGE_BYTES) { full = true; break }
        bytes += size + 1
        encoded.push(body)
        cursor = event.seq
      }
      full ||= encoded.length === PAGE_EVENTS
      if (full) metrics.fullPages++
      metrics.maxBufferedEvents = Math.max(metrics.maxBufferedEvents, encoded.length)
      metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, bytes)
      res.end(`{"stream":${JSON.stringify(stream)},"after":${after},"events":[${encoded.join(',')}],"full":${full}}`)
    } catch {
      if (!res.destroyed) fail(503, 'range_unavailable')
    } finally {
      queryDone = true
      if (responseDone || res.destroyed) busy = false
    }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxConnections = 4
  server.setTimeout(5000, (socket) => socket.destroy())
  const close = await listenPrivate(server, socketPath)
  try {
    const path = join(dirname(socketPath), 'stream.json')
    try {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify({ stream: randomUUID() })); await file.sync() }
      finally { await file.close() }
      const dir = await open(dirname(path), 'r')
      try { await dir.sync() } finally { await dir.close() }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || !('stream' in value) || typeof value.stream !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.stream)) throw new Error('invalid stream identity')
    stream = value.stream
  } catch (error) { await close(); throw error }
  return { close, metrics }
}
