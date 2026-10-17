import type { RequestHandler } from './$types';
import { participationPayloadSchema } from '#lib/shared/contracts';
import { registerPresence } from '#lib/server/participation';
import { guardIdentity, privateJson, privateRequest } from '#lib/server/http';
import { withAdmission } from '#lib/shared/admission';
import { verifyAdmission } from '#lib/server/admission';
import { recordAdmissionEvent } from '#lib/server/integrity-metrics';
import { record } from '#lib/server/observability';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => privateRequest(event, withAdmission(participationPayloadSchema), async ({ payload, admission }, id) => {
  guardIdentity(id, payload.anonymousEventId);
  const verified = verifyAdmission(admission, 'presence', id, payload);
  if (!verified) { recordAdmissionEvent(id, 'proof_rejected'); return privateJson({ status: 'admission_required' }, 409); }
  const result = await registerPresence(id, payload, !realEventsApproved(), verified);
  if (result.status === 'counted' || result.status === 'already_counted') {
    record(result.status);
    return privateJson(result);
  }
  record('rejected');
  return privateJson(result, result.status === 'not_found' ? 404 : result.status === 'real_events_disabled' ? 403 : 409);
});
