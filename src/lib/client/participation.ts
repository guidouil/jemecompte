import { getEventIdentity, IdentityError } from './identity';
import { isEventOpen, locateEvents, LocationError } from './geolocation';
import { parseCounterSnapshot } from './counter-snapshot';
import type {
  CounterSnapshot,
  FlowState,
  ParticipationPayload,
  PublicEvent
} from '../shared/types';

interface FlowOptions {
  getEvents: () => PublicEvent[];
  onChange: (state: FlowState) => void;
  onEvent: (event: PublicEvent) => void;
  onSnapshot: (snapshot: CounterSnapshot) => void;
}

interface Attempt {
  event: PublicEvent;
  payload: ParticipationPayload;
  capturedAt: number;
  requests: number;
  needsUser: boolean;
}

const FRESHNESS_MS = 60_000;
const MAX_REQUESTS = 5;
const messages = {
  not_open: 'Le comptage de cet événement n’est pas ouvert.',
  ended: 'Le comptage est terminé. Aucune nouvelle participation ne peut être ajoutée.',
  paused: 'Le comptage est suspendu pour le moment.',
  event_updated: 'Le périmètre a changé. Réessayez pour vérifier de nouveau votre position.',
  invalid_request: 'La demande est invalide. Rechargez la page puis réessayez.',
  not_found: 'Cet événement est introuvable.',
  rate_limited: 'Le service reçoit beaucoup de demandes. Réessayez dans quelques instants.',
  temporarily_unavailable: 'Le service est temporairement indisponible. Réessayez dans un instant.',
  real_events_disabled: 'Le comptage n’est pas disponible pour cet événement.',
  scope_confirmation_required: 'Ce comptage couvre une commune entière. Rechargez la page, vérifiez sa portée et choisissez explicitement ce comptage avant de participer.',
  details_expired: 'Les détails individuels ne sont plus conservés. Le total public reste disponible.',
  offline: 'Vous êtes hors connexion. Retrouvez du réseau puis réessayez.',
  network_error: 'La confirmation n’est pas arrivée. Votre participation n’est pas encore confirmée.',
  outside_zone: 'Votre position ne correspond pas au périmètre de cet événement.',
  position_expired: 'Votre position doit être vérifiée de nouveau. Appuyez sur Réessayer.'
};

function messageFor(code: string): string {
  return messages[code as keyof typeof messages] ?? messages.temporarily_unavailable;
}

class RequestError extends Error {
  constructor(public readonly code: string, public readonly retryAfter = 0) {
    super(messageFor(code));
  }
}

function isVisible(): boolean {
  return !globalThis.document || document.visibilityState !== 'hidden';
}

function retryAfterSeconds(response: Response, body: Record<string, unknown>): number {
  const header = response.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1_000);
  }
  return typeof body.retryAfter === 'number' && Number.isFinite(body.retryAfter)
    ? Math.max(0, body.retryAfter)
    : 0;
}

export function createParticipationFlow(options: FlowOptions) {
  let destroyed = false;
  let busy = false;
  let activeEventId: string | undefined;
  let choices: PublicEvent[] = [];
  let chosenAt = 0;
  let refreshedEvents: PublicEvent[] | undefined;
  let pending: Attempt | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextAllowedAt = 0;
  let controller: AbortController | undefined;

  function emit(state: FlowState): void {
    if (!destroyed) options.onChange(state);
  }

  function clearTimer(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function events(): PublicEvent[] {
    return refreshedEvents ?? options.getEvents();
  }

  function fail(code: string, message?: string): void {
    clearTimer();
    emit({ phase: 'error', code, eventId: activeEventId, message: message ?? messageFor(code) });
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || destroyed) return;
    busy = true;
    clearTimer();
    try {
      await action();
    } catch (error) {
      if (destroyed) return;
      if (error instanceof IdentityError || error instanceof LocationError) {
        fail(error.code, error.message);
      } else if (error instanceof RequestError) {
        fail(error.code, error.message);
      } else {
        fail('temporarily_unavailable');
      }
    } finally {
      busy = false;
    }
  }

  async function request(
    path: string,
    body?: object
  ): Promise<{ body: Record<string, unknown>; response: Response }> {
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 12_000);
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: activeController.signal
      });
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestError('temporarily_unavailable');
      }
      return { body: value as Record<string, unknown>, response };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(globalThis.navigator?.onLine === false ? 'offline' : 'network_error');
    } finally {
      clearTimeout(timeout);
      if (controller === activeController) controller = undefined;
    }
  }

  function publishSnapshot(value: unknown, eventId: string): CounterSnapshot | undefined {
    const snapshot = parseCounterSnapshot(value);
    if (!snapshot || snapshot.eventId !== eventId) return;
    if (!destroyed) options.onSnapshot(snapshot);
    return snapshot;
  }

  function finish(eventId: string, alreadyCounted: boolean, snapshot?: unknown): void {
    clearTimer();
    pending = undefined;
    nextAllowedAt = 0;
    publishSnapshot(snapshot, eventId);
    emit({
      phase: alreadyCounted ? 'already_counted' : 'counted',
      eventId,
      message: alreadyCounted ? 'Vous êtes déjà compté pour cet événement.' : 'Vous êtes compté.'
    });
  }

  function scheduleRetry(attempt: Attempt, retryAfter = 0): void {
    const backoff = Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt.requests - 1));
    const delay = Math.max(backoff * (0.8 + Math.random() * 0.4), retryAfter * 1_000);
    nextAllowedAt = Date.now() + delay;
    if (attempt.requests >= MAX_REQUESTS || attempt.needsUser || !isVisible() || destroyed) return;
    retryTimer = setTimeout(() => void run(() => retryAttempt(false)), delay);
  }

  function hold(attempt: Attempt, code: string, retryAfter = 0): void {
    pending = attempt;
    emit({ phase: 'pending', code, eventId: attempt.event.id, message: messageFor(code) });
    scheduleRetry(attempt, retryAfter);
  }

  async function refreshCatalogue(): Promise<void> {
    try {
      const { body, response } = await request('/api/events');
      if (response.ok && Array.isArray(body.events)) {
        refreshedEvents = body.events as PublicEvent[];
        const event = refreshedEvents.find((candidate) => candidate.id === activeEventId);
        if (event && !destroyed) options.onEvent(event);
      }
    } catch {
      // The explicit retry can refresh again; a failed catalogue never authorizes admission.
    }
  }

  async function submit(attempt: Attempt): Promise<void> {
    if (destroyed) return;
    attempt.requests += 1;
    emit({ phase: 'submitting', eventId: attempt.event.id, message: 'Enregistrement…' });
    try {
      const { body, response } = await request(
        `/api/events/${attempt.event.id}/presences`,
        attempt.payload
      );
      if (destroyed) return;
      if (response.ok && (body.status === 'counted' || body.status === 'already_counted')) {
        finish(attempt.event.id, body.status === 'already_counted', body.snapshot);
        return;
      }
      const code = typeof body.status === 'string' && body.status in messages
        ? body.status
        : 'temporarily_unavailable';
      if (response.status === 429 || response.status === 503 || code === 'temporarily_unavailable') {
        hold(attempt, code, retryAfterSeconds(response, body));
      } else {
        pending = undefined;
        publishSnapshot(body.snapshot, attempt.event.id);
        if (code === 'event_updated') await refreshCatalogue();
        fail(code);
      }
    } catch (error) {
      if (destroyed) return;
      hold(attempt, error instanceof RequestError ? error.code : 'network_error');
    }
  }

  async function status(eventId: string, anonymousEventId: string) {
    const result = await request(`/api/events/${eventId}/presence-status`, { anonymousEventId });
    if (!result.response.ok) {
      const code = typeof result.body.status === 'string' && result.body.status in messages
        ? result.body.status
        : 'temporarily_unavailable';
      throw new RequestError(code, retryAfterSeconds(result.response, result.body));
    }
    if (!['counted', 'not_counted', 'details_expired'].includes(result.body.status as string)) {
      throw new RequestError('temporarily_unavailable');
    }
    const snapshot = publishSnapshot(result.body.snapshot, eventId);
    if (!snapshot) throw new RequestError('temporarily_unavailable');
    return { status: result.body.status as 'counted' | 'not_counted' | 'details_expired', snapshot };
  }

  function notOpenCode(event: PublicEvent): string {
    if (event.status === 'paused' || event.integrityStatus === 'suspended') return 'paused';
    if (event.status === 'closed' || event.status === 'cancelled' || Date.now() >= Date.parse(event.endsAt)) {
      return 'ended';
    }
    return 'not_open';
  }

  async function verifyOnly(eventId: string): Promise<void> {
    activeEventId = eventId;
    const event = events().find((candidate) => candidate.id === eventId);
    if (event && !destroyed) options.onEvent(event);
    emit({ phase: 'submitting', eventId, message: 'Vérification de votre participation…' });
    const identity = await getEventIdentity(eventId);
    if (destroyed) return;
    const result = await status(eventId, identity);
    if (destroyed) return;
    pending = undefined;
    if (result.status === 'counted') finish(eventId, true, result.snapshot);
    else if (result.status === 'details_expired') fail('details_expired');
    else if (event && !isEventOpen(event)) fail(notOpenCode(event));
    else emit({ phase: 'idle', eventId, message: 'Aucune participation confirmée. Vous pouvez vous compter.' });
  }

  async function admit(event: PublicEvent, capturedAt: number): Promise<void> {
    activeEventId = event.id;
    if (!destroyed) options.onEvent(event);
    const identity = await getEventIdentity(event.id);
    if (destroyed) return;
    if (Date.now() - capturedAt >= FRESHNESS_MS) {
      await locateAndCount(event.id);
      return;
    }
    const attempt: Attempt = {
      event,
      payload: {
        anonymousEventId: identity,
        geofenceVersion: event.geofenceVersion,
        protocolVersion: 1,
        insideZone: true,
        ...(event.countingScope === 'city' ? { countingScope: 'city' as const } : {})
      },
      capturedAt,
      requests: 0,
      needsUser: false
    };
    pending = attempt;
    await submit(attempt);
  }

  async function locateAndCount(selectedEventId?: string): Promise<void> {
    activeEventId = selectedEventId;
    if (globalThis.navigator?.onLine === false) {
      fail('offline');
      return;
    }
    const selected = selectedEventId
      ? events().find((event) => event.id === selectedEventId)
      : undefined;
    if (selectedEventId && !selected) {
      fail('not_found');
      return;
    }
    if (selected && !isEventOpen(selected)) {
      await verifyOnly(selected.id);
      return;
    }
    if (!events().some((event) => isEventOpen(event))) {
      fail('not_open');
      return;
    }
    emit({ phase: 'locating', eventId: selectedEventId, message: 'Vérification de votre position…' });
    const result = await locateEvents(events(), selectedEventId);
    if (destroyed) return;
    if (result.events.length === 0) {
      fail('outside_zone');
    } else if (result.events.length > 1 || (!selectedEventId && result.events[0]?.countingScope === 'city')) {
      choices = result.events;
      chosenAt = result.capturedAt;
      emit({ phase: 'choosing', message: result.events.length === 1
        ? 'Ce comptage couvre une commune entière. Confirmez votre choix avant de vous compter ; cette zone ne confirme aucun lieu de manifestation.'
        : 'Pour quel comptage souhaitez-vous déclarer votre participation ?', choices });
    } else {
      choices = [];
      await admit(result.events[0]!, result.capturedAt);
    }
  }

  async function retryAttempt(manual: boolean): Promise<void> {
    const attempt = pending;
    if (!attempt || destroyed) return;
    if (Date.now() < nextAllowedAt) {
      const remaining = (nextAllowedAt - Date.now()) / 1_000;
      hold(attempt, 'rate_limited', remaining);
      return;
    }
    if (!isVisible()) return;
    if (attempt.needsUser && !manual) return;
    const event = events().find((candidate) => candidate.id === attempt.event.id) ?? attempt.event;
    const stale = Date.now() - attempt.capturedAt >= FRESHNESS_MS;
    if (stale || !isEventOpen(event) || attempt.needsUser) {
      try {
        const result = await status(event.id, attempt.payload.anonymousEventId);
        if (destroyed) return;
        if (result.status === 'counted') {
          finish(event.id, true, result.snapshot);
        } else if (result.status === 'details_expired') {
          pending = undefined;
          fail('details_expired');
        } else if (
          result.snapshot.eventStatus !== 'published' ||
          result.snapshot.integrityStatus === 'suspended' ||
          Date.parse(result.snapshot.serverTime) >= Date.parse(result.snapshot.endsAt)
        ) {
          pending = undefined;
          fail(result.snapshot.eventStatus === 'paused' || result.snapshot.integrityStatus === 'suspended'
            ? 'paused'
            : 'ended');
        } else if (manual) {
          pending = undefined;
          await locateAndCount(event.id);
        } else {
          attempt.needsUser = true;
          emit({ phase: 'pending', eventId: event.id, code: 'position_expired', message: messages.position_expired });
        }
      } catch (error) {
        if (destroyed) return;
        if (error instanceof LocationError || error instanceof IdentityError) {
          pending = undefined;
          throw error;
        }
        attempt.requests += 1;
        hold(attempt, error instanceof RequestError ? error.code : 'network_error',
          error instanceof RequestError ? error.retryAfter : 0);
      }
    } else {
      await submit(attempt);
    }
  }

  const resume = () => {
    if (pending && !pending.needsUser && pending.requests < MAX_REQUESTS && isVisible()) {
      void run(() => retryAttempt(false));
    }
  };
  const visibility = () => {
    if (isVisible()) resume();
    else clearTimer();
  };
  globalThis.window?.addEventListener('online', resume);
  globalThis.document?.addEventListener('visibilitychange', visibility);

  return {
    count: (selectedEventId?: string) => run(async () => {
      if (pending) await retryAttempt(true);
      else await locateAndCount(selectedEventId);
    }),
    select: (eventId: string) => run(async () => {
      const event = choices.find((candidate) => candidate.id === eventId);
      if (!event) {
        fail('not_found');
        return;
      }
      choices = [];
      if (Date.now() - chosenAt >= FRESHNESS_MS) await locateAndCount(event.id);
      else await admit(event, chosenAt);
    }),
    retry: () => run(async () => {
      if (pending) await retryAttempt(true);
      else await locateAndCount(activeEventId);
    }),
    verify: (eventId: string) => run(() => verifyOnly(eventId)),
    destroy: () => {
      destroyed = true;
      clearTimer();
      controller?.abort();
      pending = undefined;
      choices = [];
      refreshedEvents = undefined;
      globalThis.window?.removeEventListener('online', resume);
      globalThis.document?.removeEventListener('visibilitychange', visibility);
    }
  };
}
