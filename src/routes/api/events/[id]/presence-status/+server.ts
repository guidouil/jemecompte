import type { RequestHandler } from './$types';
import { presenceStatusPayloadSchema } from '#lib/shared/contracts';
import { getPresenceStatus } from '#lib/server/participation';
import { guardIdentity, guardPeer, parseEventId, privateJson, readPrivateJson, writeRequest } from '#lib/server/http';

export const POST: RequestHandler = (event) => writeRequest(async () => {
  const id = parseEventId(event.params.id);
  guardPeer(event, id);
  const payload = await readPrivateJson(event, presenceStatusPayloadSchema);
  guardIdentity(id, payload.anonymousEventId);
  const result = await getPresenceStatus(id, payload.anonymousEventId);
  return result ? privateJson(result) : privateJson({ status: 'not_found' }, 404);
});
