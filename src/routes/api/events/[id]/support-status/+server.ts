import type { RequestHandler } from './$types';
import { presenceStatusPayloadSchema } from '#lib/shared/contracts';
import { getSupportStatus } from '#lib/server/participation';
import { guardIdentity, guardPeer, parseEventId, privateJson, readPrivateJson, writeRequest } from '#lib/server/http';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => writeRequest(async () => {
  const id = parseEventId(event.params.id);
  guardPeer(event, id);
  const payload = await readPrivateJson(event, presenceStatusPayloadSchema);
  guardIdentity(id, payload.anonymousEventId);
  const result = await getSupportStatus(id, payload.anonymousEventId, !realEventsApproved());
  return result ? privateJson(result) : privateJson({ status: 'not_found' }, 404);
});
