import type { RequestHandler } from './$types';
import { participationPayloadSchema } from '#lib/shared/contracts';
import { registerPresence } from '#lib/server/participation';
import { guardIdentity, guardPeer, parseEventId, privateJson, readPrivateJson, writeRequest } from '#lib/server/http';
import { record } from '#lib/server/observability';

export const POST: RequestHandler = (event) => writeRequest(async () => {
  const id = parseEventId(event.params.id);
  guardPeer(event, id);
  const payload = await readPrivateJson(event, participationPayloadSchema);
  guardIdentity(id, payload.anonymousEventId);
  const result = await registerPresence(id, payload);
  if (result.status === 'counted' || result.status === 'already_counted') {
    record(result.status);
    return privateJson(result);
  }
  record('rejected');
  return privateJson(result, result.status === 'not_found' ? 404 : result.status === 'real_events_disabled' ? 403 : 409);
});
