import type { RequestHandler } from './$types';
import { supportPayloadSchema } from '#lib/shared/contracts';
import { registerSupport } from '#lib/server/participation';
import { guardIdentity, privateJson, privateRequest } from '#lib/server/http';
import { withAdmission } from '#lib/shared/admission';
import { verifyAdmission } from '#lib/server/admission';
import { recordAdmissionEvent } from '#lib/server/integrity-metrics';
import { record } from '#lib/server/observability';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => privateRequest(event, withAdmission(supportPayloadSchema), async ({ payload, admission }, id) => {
  guardIdentity(id, payload.anonymousEventId);
  const verified = verifyAdmission(admission, 'support', id, payload);
  if (!verified) { recordAdmissionEvent(id, 'proof_rejected'); return privateJson({ status: 'admission_required' }, 409); }
  const result = await registerSupport(id, payload, !realEventsApproved(), verified);
  if (result.status === 'supported' || result.status === 'already_supported' || result.status === 'already_present') {
    return privateJson(result);
  }
  record('rejected');
  return privateJson(result, result.status === 'not_found' ? 404 : result.status === 'real_events_disabled' ? 403 : 409);
});
