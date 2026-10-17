import type { RequestHandler } from './$types';
import { counterStream, StreamUnavailable } from '#lib/server/realtime';
import { guardPeer, parseEventId, privateJson, RequestFailure } from '#lib/server/http';
import { record, recordHttpResponse, type UnavailableReason } from '#lib/server/observability';

export const GET: RequestHandler = async (event) => {
  let response: Response;
  let reason: UnavailableReason | undefined;
  try {
    const id = parseEventId(event.params.id);
    guardPeer(event, id, 'read');
    response = await counterStream(id, event.request.signal, event.getClientAddress()) ?? privateJson({ status: 'not_found' }, 404);
  } catch (failure) {
    if (failure instanceof RequestFailure) response = failure.response;
    else if (failure instanceof StreamUnavailable && failure.peerLimited) {
      record('rate_limited');
      response = privateJson({ status: 'rate_limited', retryAfter: 5 }, 429, 5);
    } else {
      reason = failure instanceof StreamUnavailable ? 'stream_capacity' : 'stream_failure';
      if (reason === 'stream_failure') record('server_error');
      response = privateJson({ status: 'temporarily_unavailable', retryAfter: 5 }, 503, 5);
    }
  }
  // Records only stream admission. A later disconnect cannot change the HTTP status already sent.
  recordHttpResponse('stream', response.status, reason);
  return response;
};
