import { json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eventIdSchema } from '#lib/shared/contracts';
import { acquireParsingSlot, acquireWriteSlot, limiter, readLimiter, PeerCapacityError, ReadCapacityError, withReadBudget } from './abuse';
import { record, recordHttpResponse, type UnavailableReason } from './observability';

const privateHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json' };

export function privateJson(value: unknown, status = 200, retryAfter?: number): Response {
  return json(value, { status, headers: { ...privateHeaders, ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) } });
}

export class RequestFailure extends Error {
  constructor(public readonly response: Response) { super('Request rejected'); }
}

export function parseEventId(value: string | undefined): string {
  const parsed = eventIdSchema.safeParse(value);
  if (!parsed.success) throw new RequestFailure(privateJson({ status: 'not_found' }, 404));
  return parsed.data;
}

export async function readPrivateJson<T>(event: RequestEvent, schema: z.ZodType<T>): Promise<T> {
  const { request, url } = event;
  const site = request.headers.get('sec-fetch-site');
  // A configured canonical origin is authoritative, including behind adapter-node/proxies.
  // adapter-node otherwise infers HTTPS even for a local HTTP production smoke test.
  const expectedOrigin = process.env.ORIGIN || url.origin;
  if (request.headers.get('origin') !== expectedOrigin || (site && site !== 'same-origin' && site !== 'none')) {
    throw new RequestFailure(privateJson({ status: 'invalid_request' }, 403));
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestFailure(privateJson({ status: 'invalid_request' }, 415));
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 2_048)) {
    throw new RequestFailure(privateJson({ status: 'invalid_request' }, 413));
  }
  let release: () => void;
  try { release = acquireParsingSlot(event.getClientAddress()); }
  catch (failure) {
    if (!(failure instanceof PeerCapacityError)) throw failure;
    void request.body?.cancel().catch(() => {});
    if (failure.kind === 'peer') {
      record('rate_limited');
      throw new RequestFailure(privateJson({ status: 'rate_limited', retryAfter: 3 }, 429, 3));
    }
    throw new RequestFailure(privateJson({ status: 'temporarily_unavailable', retryAfter: 3 }, 503, 3));
  }
  try { return await readBoundedJson(request, schema); }
  finally { release(); }
}

async function readBoundedJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestFailure(privateJson({ status: 'invalid_request' }, 400));
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    const read = async () => {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_048) {
          throw new RequestFailure(privateJson({ status: 'invalid_request' }, 413));
        }
        chunks.push(part.value);
      }
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        reject(new RequestFailure(privateJson({ status: 'invalid_request' }, 408)));
        void reader.cancel().catch(() => {});
      };
      timer = setTimeout(aborted, 3_000);
      if (request.signal.aborted) aborted();
      else request.signal.addEventListener('abort', aborted, { once: true });
    });
    await Promise.race([read(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (aborted) request.signal.removeEventListener('abort', aborted);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending reads are cancelled without holding an admission slot. */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestFailure(privateJson({ status: 'invalid_request' }, 400)); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestFailure(privateJson({ status: 'invalid_request' }, 400));
  return parsed.data;
}

export function guardPeer(event: RequestEvent, eventId: string, budget: 'write' | 'read' = 'write'): void {
  const networkLimiter = budget === 'read' ? readLimiter : limiter;
  if (!networkLimiter.allow('peer', eventId, event.getClientAddress())) {
    record('rate_limited');
    throw new RequestFailure(privateJson({ status: 'rate_limited', retryAfter: 2 }, 429, 2));
  }
}

export function guardIdentity(eventId: string, anonymousEventId: string): void {
  if (!limiter.allow('identity', eventId, anonymousEventId)) {
    record('rate_limited');
    throw new RequestFailure(privateJson({ status: 'rate_limited', retryAfter: 60 }, 429, 60));
  }
}

/** Parse before reserving scarce database capacity. Slow bodies have their own
 * bounded budget, including a per-network concurrency ceiling. */
export async function privateRequest<T>(
  event: RequestEvent,
  schema: z.ZodType<T>,
  work: (payload: T, eventId: string) => Promise<Response>,
  options: { scope?: string; readOnly?: boolean; peerBudget?: 'write' | 'read' } = {}
): Promise<Response> {
  try {
    const id = options.scope ?? parseEventId(event.params.id);
    // Database read capacity and network admission budgets have different
    // purposes: issuing an admission challenge still uses the write budget.
    guardPeer(event, id, options.peerBudget);
    const payload = await readPrivateJson(event, schema);
    if (!options.readOnly) return await writeRequest(() => work(payload, id));
    const response = await withReadBudget(() => work(payload, id));
    recordHttpResponse('write', response.status);
    return response;
  } catch (failure) {
    if (!(failure instanceof RequestFailure) && !(failure instanceof ReadCapacityError)) record('server_error');
    const response = failure instanceof RequestFailure ? failure.response
      : privateJson({ status: 'temporarily_unavailable', retryAfter: 3 }, 503, 3);
    recordHttpResponse('write', response.status);
    return response;
  }
}

export async function writeRequest(work: () => Promise<Response>): Promise<Response> {
  const release = acquireWriteSlot();
  let response: Response;
  let reason: UnavailableReason | undefined;
  if (!release) {
    reason = 'write_capacity';
    response = privateJson({ status: 'temporarily_unavailable', retryAfter: 2 }, 503, 2);
  } else {
    try { response = await work(); }
    catch (failure) {
      if (failure instanceof RequestFailure) response = failure.response;
      else {
        record('server_error');
        reason = 'write_failure';
        // Deliberately no automatic exception serialization: SQL errors can contain parameters.
        response = privateJson({ status: 'temporarily_unavailable', retryAfter: 3 }, 503, 3);
      }
    } finally { release(); }
  }
  recordHttpResponse('write', response.status, reason);
  return response;
}
