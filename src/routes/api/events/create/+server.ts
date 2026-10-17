import type { RequestHandler } from './$types';
import { createEventPayloadSchema } from '#lib/shared/event-creation';
import { createPublicEvent } from '#lib/server/event-creation';
import { creationLimiter } from '#lib/server/event-creation-abuse';
import { privateJson, privateRequest } from '#lib/server/http';
import { record } from '#lib/server/observability';
import { realEventsApproved } from '#lib/server/db/index';
import { withAdmission } from '#lib/shared/admission';
import { verifyAdmission } from '#lib/server/admission';

export const POST: RequestHandler = (event) => privateRequest(event, withAdmission(createEventPayloadSchema), async ({ payload, admission }) => {
  const verified = verifyAdmission(admission, 'create', undefined, payload);
  if (!verified) return privateJson({ status: 'admission_required' }, 409);
  const allowance = creationLimiter.allow(event.getClientAddress());
  if (!allowance.allowed) {
    record('rate_limited');
    return privateJson({ status: 'rate_limited', retryAfter: allowance.retryAfter }, 429, allowance.retryAfter);
  }
  const result = await createPublicEvent(payload, verified);
  if (result.status === 'temporarily_unavailable') {
    return privateJson(result, 503, 3);
  }
  // An idempotent retry keeps its original mode. Never redirect a public client
  // to a fixture hidden after activation, or return a real event in test mode.
  if ('event' in result && result.event.isTest !== !realEventsApproved()) {
    return privateJson({ status: 'event_mode_changed' }, 409);
  }
  const status = result.status === 'created' ? 201 : result.status === 'already_created' ? 200 :
    result.status === 'invalid_schedule' || result.status === 'invalid_location' ? 400 : 409;
  return privateJson(result, status);
}, { scope: 'create' });
