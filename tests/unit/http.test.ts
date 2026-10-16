import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { readPrivateJson, RequestFailure, writeRequest } from '../../src/lib/server/http';
import { withReadBudget } from '../../src/lib/server/abuse';
import { operationalMetrics } from '../../src/lib/server/observability';

function eventFor(request: Request): RequestEvent {
  return { request, url: new URL(request.url) } as RequestEvent;
}
function privateRequest(body: BodyInit): Request {
  return new Request('http://localhost/api/events/test/presences', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body, ...{ duplex: 'half' }
  });
}

beforeEach(() => vi.stubEnv('ORIGIN', 'http://localhost'));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('bounded HTTP handling', () => {
  it('releases the admission slot after a body that never finishes', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const response = writeRequest(async () => {
      await readPrivateJson(eventFor(privateRequest(body)), z.object({ ok: z.boolean() }).strict());
      return new Response(null);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).status).toBe(408);
    expect(cancelled).toBe(true);
    expect((await writeRequest(async () => new Response('ready'))).status).toBe(200);
  });
  it('enforces the streaming body size without trusting content-length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2_049)); controller.close(); }
    });
    await expect(readPrivateJson(eventFor(privateRequest(body)), z.unknown())).rejects.toMatchObject({
      response: expect.objectContaining({ status: 413 })
    });
  });
  it('rejects additional fields without returning the rejected payload', async () => {
    try {
      await readPrivateJson(eventFor(privateRequest(JSON.stringify({ ok: true, latitude: 'PRIVATE_SENTINEL' }))), z.object({ ok: z.boolean() }).strict());
      expect.unreachable();
    } catch (failure) {
      expect(failure).toBeInstanceOf(RequestFailure);
      const response = (failure as RequestFailure).response;
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
    }
  });
  it('does not serialize raw infrastructure errors', async () => {
    const before = operationalMetrics();
    const response = await writeRequest(async () => { throw new Error('PRIVATE_SENTINEL coordinates and SQL values'); });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
    const after = operationalMetrics();
    expect(after.unavailable - before.unavailable).toBe(1);
    expect(after.server_error - before.server_error).toBe(1);
    expect(after.unavailabilityReasons.write_failure - before.unavailabilityReasons.write_failure).toBe(1);
    expect(after.httpResponses.write['503'] - before.httpResponses.write['503']).toBe(1);
    expect(JSON.stringify(after)).not.toContain('PRIVATE_SENTINEL');
  });
  it('records capacity refusal once without running the rejected work and releases all write slots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const before = operationalMetrics();
    const pending = Array.from({ length: 128 }, () => writeRequest(async () => {
      await gate;
      return new Response(null, { status: 204 });
    }));
    try {
      const rejectedWork = vi.fn(async () => new Response(null));
      const response = await writeRequest(rejectedWork);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('2');
      expect(rejectedWork).not.toHaveBeenCalled();
      const metrics = operationalMetrics();
      expect(metrics.unavailable - before.unavailable).toBe(1);
      expect(metrics.server_error).toBe(before.server_error);
      expect(metrics.unavailabilityReasons.write_capacity - before.unavailabilityReasons.write_capacity).toBe(1);
      expect(metrics.httpResponses.write['503'] - before.httpResponses.write['503']).toBe(1);
    } finally {
      release();
      await Promise.all(pending);
    }
    expect((await writeRequest(async () => new Response(null))).status).toBe(200);
    expect(operationalMetrics().httpResponses.write['2xx'] - before.httpResponses.write['2xx']).toBe(129);
  });
  it('records expected HTTP failures separately from infrastructure errors', async () => {
    const before = operationalMetrics();
    expect((await writeRequest(async () => { throw new RequestFailure(new Response(null, { status: 400 })); })).status).toBe(400);
    expect((await writeRequest(async () => new Response(null, { status: 429 }))).status).toBe(429);
    expect((await writeRequest(async () => new Response(null, { status: 503 }))).status).toBe(503);
    const after = operationalMetrics();
    expect(after.httpResponses.write['4xx'] - before.httpResponses.write['4xx']).toBe(1);
    expect(after.httpResponses.write['429'] - before.httpResponses.write['429']).toBe(1);
    expect(after.httpResponses.write['503'] - before.httpResponses.write['503']).toBe(1);
    expect(after.unavailabilityReasons.other - before.unavailabilityReasons.other).toBe(1);
    expect(after.unavailable - before.unavailable).toBe(1);
    expect(after.server_error).toBe(before.server_error);
  });
  it('checks the runtime canonical origin rather than an inferred proxy protocol', async () => {
    const request = privateRequest(JSON.stringify({ ok: true }));
    const event = { ...eventFor(request), url: new URL('https://localhost/api/events/test/presences') };
    await expect(readPrivateJson(event, z.object({ ok: z.boolean() }).strict())).resolves.toEqual({ ok: true });
  });
  it('bounds queued read requests and releases capacity on failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = Array.from({ length: 128 }, () => withReadBudget(() => gate));
    await expect(withReadBudget(async () => 1)).rejects.toBeInstanceOf(Error);
    release();
    await Promise.all(pending);
    await expect(withReadBudget(async () => { throw new Error('expected'); })).rejects.toThrow('expected');
    await expect(withReadBudget(async () => 'available')).resolves.toBe('available');
  });
});
