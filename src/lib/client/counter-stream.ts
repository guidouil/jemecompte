import { mergeCounterSnapshots, parseCounterSnapshot } from './counter-snapshot';
import type { CounterSnapshot } from '../shared/types';

type ConnectionState = 'live' | 'reconnecting' | 'offline';

interface CounterSubscriptionOptions {
  onSnapshot: (snapshot: CounterSnapshot) => void;
  onConnectionChange: (state: ConnectionState) => void;
}

export function subscribeCounters(eventId: string, options: CounterSubscriptionOptions): () => void {
  const path = `/api/events/${encodeURIComponent(eventId)}`;
  let disposed = false;
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let failures = 0;
  let lastSnapshot: CounterSnapshot | undefined;
  let lastConnectionState: ConnectionState | undefined;

  const visible = () => !globalThis.document || document.visibilityState !== 'hidden';
  const online = () => globalThis.navigator?.onLine !== false;
  const active = () => !disposed && visible() && online();

  function connection(state: ConnectionState): void {
    if (!disposed && lastConnectionState !== state) {
      lastConnectionState = state;
      options.onConnectionChange(state);
    }
  }

  function accept(value: unknown): boolean {
    const snapshot = parseCounterSnapshot(value);
    if (!snapshot || snapshot.eventId !== eventId || !active()) return false;
    lastSnapshot = mergeCounterSnapshots(lastSnapshot, snapshot);
    options.onSnapshot(lastSnapshot);
    return true;
  }

  function stop(): void {
    source?.close();
    source = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    reconnectTimer = pollTimer = undefined;
    silenceTimer = undefined;
    requestController?.abort();
    requestController = undefined;
  }

  function schedulePoll(): void {
    if (!active() || pollTimer !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void poll();
    }, 15_000 * (0.85 + Math.random() * 0.3));
  }

  async function poll(): Promise<void> {
    if (!active() || requestController) return;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${path}/counters`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (response.ok) {
        const value: unknown = await response.json();
        if (accept(value)) connection('live');
        else connection('reconnecting');
      } else {
        connection('reconnecting');
      }
    } catch {
      if (active()) connection(online() ? 'reconnecting' : 'offline');
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = undefined;
      if (!source) schedulePoll();
    }
  }

  function reconnect(): void {
    if (!active()) return;
    connection('reconnecting');
    if (failures >= 3 || !globalThis.EventSource) {
      void poll();
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1)) *
      (0.8 + Math.random() * 0.4);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openStream();
    }, delay);
  }

  function openStream(): void {
    if (!active() || source) return;
    if (!globalThis.EventSource) {
      void poll();
      return;
    }
    let opened: EventSource;
    try {
      opened = new EventSource(`${path}/stream`, { withCredentials: false });
    } catch {
      failures += 1;
      reconnect();
      return;
    }
    source = opened;
    const armSilenceTimeout = () => {
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (source !== opened || !active()) return;
        opened.close();
        source = undefined;
        failures += 1;
        reconnect();
      }, 45_000);
    };
    opened.onopen = () => {
      if (source === opened && active()) {
        connection('live');
        armSilenceTimeout();
      }
    };
    opened.addEventListener('counters', (event) => {
      if (source !== opened || !active()) return;
      const data = (event as MessageEvent<unknown>).data;
      if (typeof data !== 'string' || data.length > 16_384) return;
      try {
        if (accept(JSON.parse(data))) {
          failures = 0;
          armSilenceTimeout();
        }
      } catch {
        // An invalid message is ignored, never reflected into a local counter increment.
      }
    });
    // Keep-alive comments are handled by EventSource itself, not exposed as MessageEvents.
    opened.onerror = () => {
      if (source !== opened || disposed) return;
      opened.close();
      source = undefined;
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      silenceTimer = undefined;
      failures += 1;
      reconnect();
    };
  }

  function start(): void {
    stop();
    if (disposed || !visible()) return;
    if (!online()) {
      connection('offline');
      return;
    }
    failures = 0;
    connection('reconnecting');
    openStream();
  }

  function visibilityChanged(): void {
    if (visible()) start();
    else stop();
  }

  function wentOffline(): void {
    stop();
    connection('offline');
  }

  globalThis.document?.addEventListener('visibilitychange', visibilityChanged);
  globalThis.window?.addEventListener('online', start);
  globalThis.window?.addEventListener('offline', wentOffline);
  start();

  return () => {
    disposed = true;
    stop();
    lastSnapshot = undefined;
    globalThis.document?.removeEventListener('visibilitychange', visibilityChanged);
    globalThis.window?.removeEventListener('online', start);
    globalThis.window?.removeEventListener('offline', wentOffline);
  };
}
