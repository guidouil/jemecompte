import type { RequestHandler } from './$types';
import { createEventPayloadSchema } from '#lib/shared/event-creation';
import { createPublicEvent } from '#lib/server/event-creation';
import { creationLimiter } from '#lib/server/event-creation-abuse';
import { privateJson, readPrivateJson, writeRequest } from '#lib/server/http';
import { record } from '#lib/server/observability';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => writeRequest(async () => {
  const payload = await readPrivateJson(event, createEventPayloadSchema);
  const allowance = creationLimiter.allow(event.getClientAddress());
  if (!allowance.allowed) {
    record('rate_limited');
    return privateJson({ status: 'rate_limited', retryAfter: allowance.retryAfter }, 429, allowance.retryAfter);
  }
  const result = await createPublicEvent(payload);
  // An idempotent retry keeps its original mode. Never redirect a public client
  // to a fixture hidden after activation, or return a real event in test mode.
  if ('event' in result && result.event.isTest !== !realEventsApproved()) {
    return privateJson({ status: 'event_mode_changed' }, 409);
  }
  const status = result.status === 'created' ? 201 : result.status === 'already_created' ? 200 :
    result.status === 'invalid_schedule' ? 400 : 409;
  return privateJson(result, status);
});
