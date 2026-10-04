import type { PDS } from '@atproto/pds'
import { startEventBridge } from './events/bridge-server.ts'

// Draft of the hook-point spec this build implements, see docs/spec/hook-points.md.
export const SPEC_DRAFT = '0'

type EventType = 'commit' | 'sync' | 'identity' | 'account'

const counts: Record<EventType, number> = {
  commit: 0,
  sync: 0,
  identity: 0,
  account: 0
}
let lastSeq: number | null = null
let listening = false

// Adds the bridge's own HTTP surface. Call from PDS.run's onCreated.
//
// Routes live under /_pirs so they can never collide with /xrpc, which the PDS
// forwards to the proxy handler for any method it does not know.
export function attachRoutes(pds: PDS) {
  pds.app.get('/_pirs/status', (_req, res) => {
    // Counters only: event bodies are never exposed on this route.
    res.json({
      specDraft: SPEC_DRAFT,
      pdsVersion: pds.ctx.cfg.service.version,
      events: { listening, lastSeq, counts }
    })
  })
}

// Subscribes to the PDS's local sequencer. Call from PDS.run's onStarted.
//
// Events arrive after they are persisted, so this is a post-commit observer and
// cannot veto a write. Optional host delivery reads persisted ranges on its
// own private listener; this synchronous callback only updates counters.
export async function attachEvents(pds: PDS) {
  pds.ctx.sequencer.on('events', (evts) => {
    for (const evt of evts) {
      counts[evt.type] += 1
      lastSeq = evt.seq
    }
  })
  listening = true
  if (process.env.PIRS_EVENT_SOCKET) {
    const bridge = await startEventBridge(pds.ctx.sequencer, process.env.PIRS_EVENT_SOCKET)
    pds.ctx.sequencer.once('close', () => { void bridge.close() })
  }
}
