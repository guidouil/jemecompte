import type { RequestHandler } from './$types';
import { presenceStatusPayloadSchema } from '#lib/shared/contracts';
import { getSupportStatus } from '#lib/server/participation';
import { guardIdentity, privateJson, privateRequest } from '#lib/server/http';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => privateRequest(event, presenceStatusPayloadSchema, async (payload, id) => {
  guardIdentity(id, payload.anonymousEventId);
  const result = await getSupportStatus(id, payload.anonymousEventId, !realEventsApproved());
  return result ? privateJson(result) : privateJson({ status: 'not_found' }, 404);
}, { readOnly: true, peerBudget: 'read' });
