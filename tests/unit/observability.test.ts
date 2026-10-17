import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readLimiter } from '../../src/lib/server/abuse';
import { operationalMetrics, recordHttpResponse } from '../../src/lib/server/observability';

const mocked = vi.hoisted(() => ({ counterStream: vi.fn(), StreamUnavailable: class extends Error {} }));
vi.mock('../../src/lib/server/realtime', () => mocked);
import { GET } from '../../src/routes/api/events/[id]/stream/+server';

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
function streamRequest(id = eventId): Parameters<typeof GET>[0] {
  const request = new Request(`https://example.invalid/api/events/${id}/stream?private=PRIVATE_SENTINEL`);
  return { request, url: new URL(request.url), params: { id }, getClientAddress: () => 'PRIVATE_SENTINEL' } as Parameters<typeof GET>[0];
}

beforeEach(() => mocked.counterStream.mockReset());

describe('bounded operational HTTP metrics', () => {
  it('reports a per-network stream quota as rate limited without a server error', async () => {
    const before = operationalMetrics();
    mocked.counterStream.mockRejectedValueOnce(Object.assign(new mocked.StreamUnavailable(), { peerLimited: true }));
    const response = await GET(streamRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    const after = operationalMetrics();
    expect(after.httpResponses.stream['429'] - before.httpResponses.stream['429']).toBe(1);
    expect(after.unavailable).toBe(before.unavailable);
    expect(after.server_error).toBe(before.server_error);
    expect(JSON.stringify(after)).not.toContain('PRIVATE_SENTINEL');
  });
  it('counts successful stream admission without reading or retaining the stream body', async () => {
    const before = operationalMetrics();
    mocked.counterStream.mockResolvedValue(new Response('PRIVATE_SENTINEL', {
      headers: { 'content-type': 'text/event-stream' }
    }));
    const event = streamRequest();
    const response = await GET(event);
    expect(response.status).toBe(200);
    expect(mocked.counterStream).toHaveBeenCalledExactlyOnceWith(eventId, event.request.signal, 'PRIVATE_SENTINEL');
    const after = operationalMetrics();
    expect(after.httpResponses.stream['2xx'] - before.httpResponses.stream['2xx']).toBe(1);
    expect(after.unavailable).toBe(before.unavailable);
    expect(JSON.stringify(after)).not.toContain('PRIVATE_SENTINEL');
    expect(await response.text()).toBe('PRIVATE_SENTINEL');
  });

  it('distinguishes stream capacity refusals from unexpected failures, counting each 503 once', async () => {
    const before = operationalMetrics();
    mocked.counterStream.mockRejectedValueOnce(new mocked.StreamUnavailable('PRIVATE_SENTINEL'));
    const capacityResponse = await GET(streamRequest());
    expect(capacityResponse.status).toBe(503);
    expect(capacityResponse.headers.get('retry-after')).toBe('5');
    expect(await capacityResponse.text()).not.toContain('PRIVATE_SENTINEL');
    const capacity = operationalMetrics();
    expect(capacity.server_error).toBe(before.server_error);
    expect(capacity.unavailabilityReasons.stream_capacity - before.unavailabilityReasons.stream_capacity).toBe(1);

    mocked.counterStream.mockRejectedValueOnce(new Error('PRIVATE_SENTINEL SQL values and coordinates'));
    const failureResponse = await GET(streamRequest());
    expect(failureResponse.status).toBe(503);
    expect(await failureResponse.text()).not.toContain('PRIVATE_SENTINEL');
    const after = operationalMetrics();
    expect(after.unavailable - before.unavailable).toBe(2);
    expect(after.httpResponses.stream['503'] - before.httpResponses.stream['503']).toBe(2);
    expect(after.unavailabilityReasons.stream_failure - before.unavailabilityReasons.stream_failure).toBe(1);
    expect(after.server_error - before.server_error).toBe(1);
    expect(JSON.stringify(after)).not.toContain('PRIVATE_SENTINEL');
  });

  it('keeps missing events and rate limits out of unavailable and server errors', async () => {
    const before = operationalMetrics();
    mocked.counterStream.mockResolvedValue(null);
    expect((await GET(streamRequest())).status).toBe(404);
    expect((await GET(streamRequest('invalid-id'))).status).toBe(404);
    vi.spyOn(readLimiter, 'allow').mockReturnValue(false);
    const limited = await GET(streamRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    const after = operationalMetrics();
    expect(after.httpResponses.stream['4xx'] - before.httpResponses.stream['4xx']).toBe(2);
    expect(after.httpResponses.stream['429'] - before.httpResponses.stream['429']).toBe(1);
    expect(after.unavailable).toBe(before.unavailable);
    expect(after.server_error).toBe(before.server_error);
    expect(mocked.counterStream).toHaveBeenCalledTimes(1);
  });

  it('keeps fixed categories for arbitrary statuses and returns independent metric snapshots', () => {
    const before = operationalMetrics();
    for (let status = 200; status < 600; status++) recordHttpResponse('write', status);
    const after = operationalMetrics();
    expect(Object.keys(after.httpResponses.write)).toEqual(Object.keys(before.httpResponses.write));
    expect(Object.keys(after.unavailabilityReasons)).toEqual(Object.keys(before.unavailabilityReasons));
    expect(after.httpResponses.write['2xx'] - before.httpResponses.write['2xx']).toBe(100);
    expect(after.httpResponses.write['3xx'] - before.httpResponses.write['3xx']).toBe(100);
    expect(after.httpResponses.write['4xx'] - before.httpResponses.write['4xx']).toBe(99);
    expect(after.httpResponses.write['5xx'] - before.httpResponses.write['5xx']).toBe(99);
    expect(after.httpResponses.write['429'] - before.httpResponses.write['429']).toBe(1);
    expect(after.httpResponses.write['503'] - before.httpResponses.write['503']).toBe(1);
    expect(after.unavailabilityReasons.other - before.unavailabilityReasons.other).toBe(1);
    after.httpResponses.write['503'] = -1;
    after.unavailabilityReasons.other = -1;
    expect(operationalMetrics().httpResponses.write['503']).toBe(before.httpResponses.write['503'] + 1);
    expect(operationalMetrics().unavailabilityReasons.other).toBe(before.unavailabilityReasons.other + 1);
  });
});
