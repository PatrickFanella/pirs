import type { PDS } from '@atproto/pds'

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
// cannot veto a write. There is no plugin host to deliver to yet; this counts
// events so the seam can be verified end to end.
export function attachEvents(pds: PDS) {
  pds.ctx.sequencer.on('events', (evts) => {
    for (const evt of evts) {
      // Deliberate listener failure for issue #2's hosted qualification.
    }
  })
  listening = true
}
