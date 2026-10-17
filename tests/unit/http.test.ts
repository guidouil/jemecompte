import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { guardPeer, privateRequest as handlePrivateRequest, readPrivateJson, RequestFailure, writeRequest } from '../../src/lib/server/http';
import { limiter, readLimiter, withReadBudget } from '../../src/lib/server/abuse';
import { operationalMetrics } from '../../src/lib/server/observability';

function eventFor(request: Request): RequestEvent {
  return { request, url: new URL(request.url), params: { id: 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a' }, getClientAddress: () => 'http-tests-peer' } as unknown as RequestEvent;
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
  it('keeps read traffic and admission quotas independent for the same shared network', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const event = { getClientAddress: () => 'crowd-network-read-budget' } as RequestEvent;
    for (let i = 0; i < 120; i++) guardPeer(event, 'crowd-event', 'read');
    expect(() => guardPeer(event, 'crowd-event', 'read')).toThrow(RequestFailure);
    expect(() => guardPeer(event, 'crowd-event')).not.toThrow();
    const other = { getClientAddress: () => 'crowd-network-write-budget' } as RequestEvent;
    for (let i = 0; i < 120; i++) guardPeer(other, 'crowd-event');
    expect(() => guardPeer(other, 'crowd-event')).toThrow(RequestFailure);
    expect(() => guardPeer(other, 'crowd-event', 'read')).not.toThrow();
  });
  it('uses explicit read network quotas for statuses while challenges retain admission quotas despite database reads', async () => {
    vi.spyOn(readLimiter, 'allow').mockReturnValue(false);
    const writeQuota = vi.spyOn(limiter, 'allow').mockReturnValue(true);
    const schema = z.object({ ok: z.boolean() });
    const work = async () => new Response(null, { status: 204 });
    expect((await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, work,
      { readOnly: true, peerBudget: 'read' })).status).toBe(429);
    expect((await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, work,
      { scope: 'admission', readOnly: true })).status).toBe(204);
    expect(writeQuota).toHaveBeenCalledWith('peer', 'admission', 'http-tests-peer');
  });
  it('cancels disconnected bodies promptly and removes their abort listeners', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const request = new Request(privateRequest(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })), {
      signal: controller.signal
    });
    const removeListener = vi.spyOn(request.signal, 'removeEventListener');
    const work = vi.fn(async () => new Response(null));
    const response = handlePrivateRequest(eventFor(request), z.unknown(), work);
    controller.abort();
    expect((await response).status).toBe(408);
    expect(cancelled).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(work).not.toHaveBeenCalled();
    expect((await handlePrivateRequest(eventFor(privateRequest('{}')), z.unknown(), work)).status).toBe(200);
  });
  it('isolates slow-body parsing from database slots and from another network', async () => {
    vi.useFakeTimers();
    const schema = z.object({ ok: z.boolean() }).strict();
    const work = vi.fn(async () => new Response(null, { status: 204 }));
    const pending = Array.from({ length: 8 }, () => handlePrivateRequest(
      eventFor(privateRequest(new ReadableStream<Uint8Array>())), schema, work
    ));
    const sameNetwork = await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, work);
    expect(sameNetwork.status).toBe(429);
    const anotherNetwork = {
      ...eventFor(privateRequest('{"ok":true}')), getClientAddress: () => 'another-http-peer'
    } as RequestEvent;
    expect((await handlePrivateRequest(anotherNetwork, schema, work)).status).toBe(204);
    expect((await writeRequest(async () => new Response(null, { status: 204 }))).status).toBe(204);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await Promise.all(pending)).every((response) => response.status === 408)).toBe(true);
    expect((await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, work)).status).toBe(204);
  });
  it('bounds parsing globally while keeping database capacity available and releases every parser', async () => {
    vi.useFakeTimers();
    const schema = z.object({ ok: z.boolean() }).strict();
    const pending = Array.from({ length: 128 }, (_, index) => handlePrivateRequest({
      ...eventFor(privateRequest(new ReadableStream<Uint8Array>())), getClientAddress: () => `parser-peer-${Math.floor(index / 8)}`
    } as RequestEvent, schema, async () => new Response(null)));
    expect((await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, async () => new Response(null))).status).toBe(503);
    expect((await writeRequest(async () => new Response(null, { status: 204 }))).status).toBe(204);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await Promise.all(pending)).every((response) => response.status === 408)).toBe(true);
    expect((await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), schema, async () => new Response(null))).status).toBe(200);
  });
  it('keeps status reads available when all database write slots are occupied', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = Array.from({ length: 128 }, () => writeRequest(async () => { await gate; return new Response(null); }));
    try {
      const response = await handlePrivateRequest(eventFor(privateRequest('{"ok":true}')), z.object({ ok: z.boolean() }),
        async () => new Response(null, { status: 204 }), { readOnly: true });
      expect(response.status).toBe(204);
    } finally { release(); await Promise.all(pending); }
  });
  it('releases the admission slot after a body that never finishes', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const response = writeRequest(async () => {
      await readPrivateJson(eventFor(privateRequest(body)), z.object({ ok: z.boolean() }).strict());
      return new Response(null);
    });
    await vi.advanceTimersByTimeAsync(3_000);
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
