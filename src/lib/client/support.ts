import { getDailySupportIdentity, getEventIdentity, IdentityError } from './identity';
import { parseCounterSnapshot } from './counter-snapshot';
import type { CounterSnapshot, PublicEvent } from '../shared/types';

export interface SupportFlowState {
  phase: 'idle' | 'submitting' | 'supported' | 'present' | 'pending' | 'error';
  message: string;
  eventId?: string;
  code?: string;
}

interface FlowOptions {
  getEvents: () => PublicEvent[];
  onChange: (state: SupportFlowState) => void;
  onSnapshot: (snapshot: CounterSnapshot) => void;
}

interface Attempt {
  event: PublicEvent;
  anonymousEventId: string;
}

const messages = {
  not_open: 'Le soutien ouvrira au début du comptage.',
  ended: 'Le comptage est terminé. Aucun nouveau soutien ne peut être ajouté.',
  paused: 'Les soutiens sont suspendus pour le moment.',
  event_updated: 'Les informations de cet événement ont changé. Rechargez la page puis réessayez.',
  invalid_request: 'La demande est invalide. Rechargez la page puis réessayez.',
  not_found: 'Cet événement est introuvable.',
  rate_limited: 'Le service reçoit beaucoup de demandes. Patientez un instant puis réessayez.',
  temporarily_unavailable: 'Le service est temporairement indisponible. Réessayez dans un instant.',
  real_events_disabled: 'Le soutien n’est pas disponible pour cet événement.',
  scope_confirmation_required: 'Ce comptage couvre une commune entière. Rechargez sa page et vérifiez sa portée avant de le soutenir.',
  details_expired: 'Les détails individuels ne sont plus conservés. Le total public reste disponible.',
  daily_limit_reached: 'Ce navigateur a déjà soutenu un autre événement aujourd’hui. Un seul événement peut être soutenu par jour, selon l’heure de Paris.',
  day_changed: 'Le jour de comptage a changé. Réessayez pour soutenir l’événement à la date actuelle, selon l’heure de Paris.',
  offline: 'Vous êtes hors connexion. Retrouvez du réseau puis réessayez.',
  network_error: 'La confirmation n’est pas arrivée. Votre soutien n’est pas encore confirmé.'
};

class RequestError extends Error {
  constructor(public readonly code: string, public readonly retryAfter = 0) {
    super(messages[code as keyof typeof messages] ?? messages.temporarily_unavailable);
  }
}

function responseCode(body: Record<string, unknown>): string {
  return typeof body.status === 'string' && body.status in messages
    ? body.status : 'temporarily_unavailable';
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
    ? Math.max(0, body.retryAfter) : 0;
}

/** Supporting never asks for a position and never queues or retries an action in the background. */
export function createSupportFlow(options: FlowOptions) {
  let destroyed = false;
  let busy = false;
  let activeEventId: string | undefined;
  let pending: Attempt | undefined;
  let nextAllowedAt = 0;
  let controller: AbortController | undefined;

  function emit(state: SupportFlowState) {
    if (!destroyed) options.onChange(state);
  }

  function fail(code: string, message?: string) {
    emit({ phase: 'error', eventId: activeEventId, code,
      message: message ?? messages[code as keyof typeof messages] ?? messages.temporarily_unavailable });
  }

  function hold(code: string, retryAfter = 0) {
    nextAllowedAt = Date.now() + retryAfter * 1_000;
    emit({ phase: 'pending', eventId: activeEventId, code,
      message: messages[code as keyof typeof messages] ?? messages.temporarily_unavailable });
  }

  async function run(action: () => Promise<void>) {
    if (busy || destroyed) return;
    busy = true;
    try {
      if (globalThis.navigator?.onLine === false) throw new RequestError('offline');
      await action();
    } catch (error) {
      if (destroyed) return;
      if (error instanceof IdentityError) fail(error.code, error.message);
      else if (error instanceof RequestError && pending) hold(error.code, error.retryAfter);
      else if (error instanceof RequestError) fail(error.code, error.message);
      else if (pending) hold('network_error');
      else fail('temporarily_unavailable');
    } finally {
      busy = false;
    }
  }

  async function request(path: string, body: object) {
    const activeController = new AbortController();
    controller = activeController;
    const timeout = setTimeout(() => activeController.abort(), 12_000);
    try {
      const response = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store',
        signal: activeController.signal
      });
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestError('temporarily_unavailable');
      }
      return { response, body: value as Record<string, unknown> };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(globalThis.navigator?.onLine === false ? 'offline' : 'network_error');
    } finally {
      clearTimeout(timeout);
      if (controller === activeController) controller = undefined;
    }
  }

  function publishSnapshot(value: unknown, eventId: string) {
    const snapshot = parseCounterSnapshot(value);
    if (!snapshot || snapshot.eventId !== eventId) return;
    if (!destroyed) options.onSnapshot(snapshot);
    return snapshot;
  }

  function finish(eventId: string, phase: 'supported' | 'present', already = false) {
    pending = undefined;
    nextAllowedAt = 0;
    emit({ phase, eventId, message: phase === 'present'
      ? 'Votre présence est déjà comptée pour cet événement. Aucun soutien supplémentaire n’est ajouté.'
      : already ? 'Votre soutien est déjà compté pour cet événement.' : 'Votre soutien à distance est compté.' });
  }

  async function status(attempt: Attempt) {
    const { response, body } = await request(`/api/events/${attempt.event.id}/support-status`, {
      anonymousEventId: attempt.anonymousEventId
    });
    if (destroyed) return;
    if (!response.ok) throw new RequestError(responseCode(body), retryAfterSeconds(response, body));
    if (!['supported', 'present', 'not_supported', 'details_expired'].includes(body.status as string)) {
      throw new RequestError('temporarily_unavailable');
    }
    const snapshot = publishSnapshot(body.snapshot, attempt.event.id);
    if (!snapshot) throw new RequestError('temporarily_unavailable');
    return { status: body.status as 'supported' | 'present' | 'not_supported' | 'details_expired', snapshot };
  }

  function closedCode(snapshot: CounterSnapshot): string | undefined {
    if (snapshot.eventStatus === 'paused' || snapshot.integrityStatus === 'suspended') return 'paused';
    if (snapshot.eventStatus === 'closed' || snapshot.eventStatus === 'cancelled' || Date.parse(snapshot.serverTime) >= Date.parse(snapshot.endsAt)) return 'ended';
    if (snapshot.eventStatus !== 'published' || Date.parse(snapshot.serverTime) < Date.parse(snapshot.startsAt)) return 'not_open';
  }

  async function verifyAttempt(attempt: Attempt, submitIfMissing: boolean, mayRefreshDay = true): Promise<void> {
    emit({ phase: 'submitting', eventId: attempt.event.id, message: 'Vérification de votre soutien…' });
    const result = await status(attempt);
    if (!result || destroyed) return;
    if (result.status === 'supported' || result.status === 'present') {
      finish(attempt.event.id, result.status, true);
      return;
    }
    if (result.status === 'details_expired') {
      pending = undefined;
      fail('details_expired');
      return;
    }
    pending = undefined;
    const unavailable = closedCode(result.snapshot);
    if (unavailable) {
      fail(unavailable);
      return;
    }
    if (!submitIfMissing) {
      emit({ phase: 'idle', eventId: attempt.event.id, message: 'Aucun soutien confirmé sur ce navigateur pour cet événement.' });
      return;
    }
    // The server's Paris day, rather than the device clock, determines the daily token.
    const anonymousDayId = await getDailySupportIdentity(result.snapshot.day);
    if (destroyed) return;
    pending = attempt;
    emit({ phase: 'submitting', eventId: attempt.event.id, message: 'Enregistrement de votre soutien…' });
    const { body, response } = await request(`/api/events/${attempt.event.id}/supports`, {
      anonymousEventId: attempt.anonymousEventId, anonymousDayId,
      day: result.snapshot.day, protocolVersion: 1,
      ...(attempt.event.countingScope === 'city' ? { countingScope: 'city' } : {})
    });
    if (destroyed) return;
    publishSnapshot(body.snapshot, attempt.event.id);
    if (response.ok && (body.status === 'supported' || body.status === 'already_supported')) {
      finish(attempt.event.id, 'supported', body.status === 'already_supported');
    } else if (response.ok && body.status === 'already_present') {
      finish(attempt.event.id, 'present');
    } else if (body.status === 'day_changed' && mayRefreshDay) {
      // Midnight can pass between status and admission. Refresh once; never loop.
      await verifyAttempt(attempt, true, false);
    } else {
      const code = responseCode(body);
      if (response.status === 429 || response.status === 503 || code === 'temporarily_unavailable') {
        hold(code, retryAfterSeconds(response, body));
      } else {
        pending = undefined;
        fail(code);
      }
    }
  }

  async function begin(eventId: string, submitIfMissing: boolean) {
    activeEventId = eventId;
    const event = options.getEvents().find((candidate) => candidate.id === eventId);
    if (!event) { fail('not_found'); return; }
    emit({ phase: 'submitting', eventId, message: 'Vérification de votre soutien…' });
    const anonymousEventId = await getEventIdentity(eventId);
    if (!destroyed) await verifyAttempt({ event, anonymousEventId }, submitIfMissing);
  }

  return {
    support: (eventId: string) => run(() => begin(eventId, true)),
    verify: (eventId: string) => run(() => begin(eventId, false)),
    retry: () => run(async () => {
      if (Date.now() < nextAllowedAt) { hold('rate_limited', (nextAllowedAt - Date.now()) / 1_000); return; }
      if (pending) await verifyAttempt(pending, true);
      else if (activeEventId) await begin(activeEventId, true);
    }),
    markPresent: (eventId: string) => {
      if (!destroyed) finish(eventId, 'present');
    },
    destroy: () => {
      destroyed = true;
      controller?.abort();
      pending = undefined;
    }
  };
}
