import type { RequestEvent } from '@sveltejs/kit';

export function sameAdminOrigin(event: Pick<RequestEvent, 'request' | 'url'>): boolean {
  const site = event.request.headers.get('sec-fetch-site');
  return event.request.headers.get('origin') === (process.env.ORIGIN || event.url.origin)
    && (!site || site === 'same-origin' || site === 'none');
}

/** Small forms only; never serialize a password or submitted values into action data. */
export async function readAdminForm(request: Request): Promise<FormData | undefined> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(type)) return;
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2_048)) return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_048) throw new Error('Form too large');
        chunks.push(part.value);
      }
    };
    await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Form timeout')); void reader.cancel().catch(() => {}); }, 5_000);
    })]);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return await new Request('http://localhost', { method: 'POST', headers: { 'content-type': type }, body: bytes }).formData();
  } catch { return; }
  finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A pending read is cancelled. */ }
  }
}
