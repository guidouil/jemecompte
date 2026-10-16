import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { readPrivateJson, RequestFailure, writeRequest } from '../../src/lib/server/http';
import { withReadBudget } from '../../src/lib/server/abuse';

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
    const response = await writeRequest(async () => { throw new Error('PRIVATE_SENTINEL coordinates and SQL values'); });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
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
