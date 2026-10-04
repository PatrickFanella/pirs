export const PAGE_EVENTS = 32
export const PAGE_BYTES = 256 * 1024
export const EVENT_BYTES = 128 * 1024

export type DeliveryEvent = { seq: number; type: 'commit' | 'sync' | 'identity' | 'account'; time: string; evt: unknown }
export type EventPage = { stream: string; after: number; events: DeliveryEvent[]; full: boolean }

export function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parsePage(value: unknown, after: number): EventPage {
  if (!value || typeof value !== 'object' || !('stream' in value) || typeof value.stream !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.stream) || !('after' in value) || value.after !== after ||
    !('full' in value) || typeof value.full !== 'boolean' || !('events' in value) ||
    !Array.isArray(value.events) || value.events.length > PAGE_EVENTS) throw new Error('invalid event page')
  let last = after
  const events: DeliveryEvent[] = []
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || !isSequence(event.seq) || event.seq <= last ||
      !['commit', 'sync', 'identity', 'account'].includes(event.type) || typeof event.time !== 'string' ||
      !('evt' in event) || Buffer.byteLength(JSON.stringify(event)) > EVENT_BYTES) throw new Error('invalid event order or body')
    last = event.seq
    events.push(event)
  }
  return { stream: value.stream, after, events, full: value.full }
}
