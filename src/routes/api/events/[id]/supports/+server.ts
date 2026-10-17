import type { RequestHandler } from './$types';
import { supportPayloadSchema } from '#lib/shared/contracts';
import { registerSupport } from '#lib/server/participation';
import { guardIdentity, guardPeer, parseEventId, privateJson, readPrivateJson, writeRequest } from '#lib/server/http';
import { record } from '#lib/server/observability';
import { realEventsApproved } from '#lib/server/db/index';

export const POST: RequestHandler = (event) => writeRequest(async () => {
  const id = parseEventId(event.params.id);
  guardPeer(event, id);
  const payload = await readPrivateJson(event, supportPayloadSchema);
  guardIdentity(id, payload.anonymousEventId);
  const result = await registerSupport(id, payload, !realEventsApproved());
  if (result.status === 'supported' || result.status === 'already_supported' || result.status === 'already_present') {
    return privateJson(result);
  }
  record('rejected');
  return privateJson(result, result.status === 'not_found' ? 404 : result.status === 'real_events_disabled' ? 403 : 409);
});
