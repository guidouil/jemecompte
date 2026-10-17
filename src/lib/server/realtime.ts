import type { CounterSnapshot } from '../shared/types';
import { getCounterSnapshot } from './counters';
import { realEventsApproved } from './db';
import { PeerCapacityError, TemporaryPeerCapacity } from './abuse';

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  close: () => void;
  expiresAt: number;
}
interface Channel {
  id: string;
  isTest: boolean;
  snapshot: CounterSnapshot | null;
  subscribers: Set<Subscriber>;
  pending: Promise<CounterSnapshot | null> | null;
  touchedAt: number;
  closed?: boolean;
}
const channels = new Map<string, Channel>();
const encoder = new TextEncoder();
let scheduler: ReturnType<typeof setInterval> | undefined;
let ticking = false;
const MAX_CLIENTS = 6_000;
const MAX_CHANNELS = 100;
const MAX_STREAM_AGE_MS = 5 * 60_000;
const streamCapacity = new TemporaryPeerCapacity(MAX_CLIENTS, 64);

export class StreamUnavailable extends Error {
  constructor(public readonly peerLimited = false) { super('Stream temporarily unavailable'); }
}

function clientCount(): number {
  let count = 0;
  for (const channel of channels.values()) count += channel.subscribers.size;
  return count;
}

function stopIfIdle(): void {
  if (clientCount() === 0 && scheduler) {
    clearInterval(scheduler);
    scheduler = undefined;
  }
}

function enqueue(subscriber: Subscriber, message: Uint8Array): void {
  try {
    if ((subscriber.controller.desiredSize ?? 0) <= 0) {
      subscriber.close();
      return;
    }
    subscriber.controller.enqueue(message);
  } catch { subscriber.close(); }
}

async function refresh(channel: Channel): Promise<CounterSnapshot | null> {
  if (channel.pending) return channel.pending;
  channel.pending = getCounterSnapshot(channel.id, channel.isTest);
  try {
    const snapshot = await channel.pending;
    // A pre-deletion read must not resurrect a closed channel.
    channel.snapshot = channel.closed ? null : snapshot;
    channel.touchedAt = Date.now();
    return channel.snapshot;
  } finally { channel.pending = null; }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await Promise.all([...channels.entries()].map(async ([key, channel]) => {
      for (const subscriber of [...channel.subscribers]) {
        if (subscriber.expiresAt <= Date.now()) subscriber.close();
      }
      if (channel.subscribers.size === 0) {
        if (Date.now() - channel.touchedAt > 30_000) channels.delete(key);
        return;
      }
      try {
        const snapshot = await refresh(channel);
        if (!snapshot) {
          for (const subscriber of [...channel.subscribers]) subscriber.close();
          return;
        }
        const frame = encoder.encode(`event: counters\ndata: ${JSON.stringify(snapshot)}\n\n`);
        for (const subscriber of [...channel.subscribers]) enqueue(subscriber, frame);
      } catch {
        // No error object or SQL parameters on a public stream. Reconnection gets durable state.
        for (const subscriber of [...channel.subscribers]) subscriber.close();
      }
    }));
  } finally {
    ticking = false;
    stopIfIdle();
  }
}

export async function counterStream(eventId: string, signal: AbortSignal, peer: string): Promise<Response | null> {
  let release: () => void;
  try { release = streamCapacity.acquire(peer); }
  catch (failure) {
    if (failure instanceof PeerCapacityError) throw new StreamUnavailable(failure.kind === 'peer');
    throw failure;
  }
  let leaseTransferred = false;
  try {
    const isTest = !realEventsApproved();
    const key = `${isTest}:${eventId}`;
    let channel = channels.get(key);
    if (!channel) {
      for (const [id, candidate] of channels) {
        if (!candidate.subscribers.size && !candidate.pending) channels.delete(id);
        if (channels.size < MAX_CHANNELS) break;
      }
      if (channels.size >= MAX_CHANNELS) throw new StreamUnavailable();
      channel = { id: eventId, isTest, snapshot: null, subscribers: new Set(), pending: null, touchedAt: 0 };
      channels.set(key, channel);
    }
    if (!channel.snapshot || Date.now() - channel.touchedAt > 3_000) await refresh(channel);
    if (channel.closed || !channel.snapshot) {
      if (!channel.subscribers.size) channels.delete(key);
      return null;
    }
    // Pending initial DB reads can resolve together; recheck before admitting each client.
    if (clientCount() >= MAX_CLIENTS) throw new StreamUnavailable();
    const activeChannel = channel;
    let close: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const subscriber: Subscriber = { controller, close: () => close?.(), expiresAt: Date.now() + MAX_STREAM_AGE_MS };
        close = () => {
          if (closed) return;
          closed = true;
          signal.removeEventListener('abort', subscriber.close);
          activeChannel.subscribers.delete(subscriber);
          release();
          activeChannel.touchedAt = Date.now();
          try { controller.close(); } catch { /* already cancelled */ }
          stopIfIdle();
        };
        leaseTransferred = true;
        if (signal.aborted) { close(); return; }
        activeChannel.subscribers.add(subscriber);
        signal.addEventListener('abort', subscriber.close, { once: true });
        enqueue(subscriber, encoder.encode(`retry: 5000\nevent: counters\ndata: ${JSON.stringify(activeChannel.snapshot)}\n\n`));
        if (!scheduler) {
          scheduler = setInterval(() => void tick(), 3_000);
          scheduler.unref();
        }
      },
      cancel() { close?.(); }
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no'
      }
    });
  } finally {
    if (!leaseTransferred) release();
  }
}

export function realtimeMetrics() {
  return { connections: clientCount(), channels: channels.size };
}

export function closeEventStreams(eventId: string): void {
  for (const [key, channel] of channels) {
    if (channel.id !== eventId) continue;
    channel.closed = true;
    channel.snapshot = null;
    for (const subscriber of [...channel.subscribers]) subscriber.close();
    channels.delete(key);
  }
  stopIfIdle();
}
