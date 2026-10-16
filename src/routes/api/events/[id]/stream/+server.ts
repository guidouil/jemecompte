import type { RequestHandler } from './$types';
import { counterStream } from '#lib/server/realtime';
import { guardPeer, parseEventId, privateJson, RequestFailure } from '#lib/server/http';

export const GET: RequestHandler = async (event) => {
  try {
    const id = parseEventId(event.params.id);
    guardPeer(event, id);
    return await counterStream(id, event.request.signal) ?? privateJson({ status: 'not_found' }, 404);
  } catch (failure) {
    if (failure instanceof RequestFailure) return failure.response;
    return privateJson({ status: 'temporarily_unavailable', retryAfter: 5 }, 503, 5);
  }
};
