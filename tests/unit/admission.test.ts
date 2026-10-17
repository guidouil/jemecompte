import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueAdmission, verifyAdmission, ADMISSION_TTL_MS } from '../../src/lib/server/admission';
import { admissionRequestSchema, nonceBytes, sufficientWork, withAdmission, workPrefix } from '../../src/lib/shared/admission';
import { participationPayloadSchema } from '../../src/lib/shared/contracts';
import type { AdmissionChallenge, AdmissionProof } from '../../src/lib/shared/admission';

const mocked = vi.hoisted(() => ({ presence: vi.fn(), support: vi.fn() }));
vi.mock('../../src/lib/server/participation', () => ({ registerPresence: mocked.presence, registerSupport: mocked.support }));
import { POST as presencePost } from '../../src/routes/api/events/[id]/presences/+server';
import { POST as supportPost } from '../../src/routes/api/events/[id]/supports/+server';

const id = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const payload = { anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1 as const, insideZone: true as const };
function solve(challenge: AdmissionChallenge): AdmissionProof {
  const prefix = createHash('sha256').update(workPrefix(challenge.token));
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    if (sufficientWork(prefix.copy().update(nonceBytes(nonce)).digest(), challenge.difficulty)) return { token: challenge.token, nonce };
  }
  throw new Error('No work solution');
}
function request(body: object): Parameters<typeof presencePost>[0] {
  const url = new URL(`http://localhost/api/events/${id}/presences`);
  return { url, params: { id }, getClientAddress: () => 'synthetic-admission-network', request: new Request(url, {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
  }) } as Parameters<typeof presencePost>[0];
}
beforeEach(() => {
  vi.stubEnv('ADMISSION_SECRET', 'A'.repeat(43)); vi.stubEnv('ADMISSION_DIFFICULTY', '16');
  vi.stubEnv('REAL_EVENTS_APPROVED', 'false'); vi.stubEnv('ORIGIN', 'http://localhost'); vi.clearAllMocks();
  mocked.presence.mockResolvedValue({ status: 'counted' }); mocked.support.mockResolvedValue({ status: 'supported' });
});
afterEach(() => vi.unstubAllEnvs());

describe('first-party admission work', () => {
  it('uses the same SHA256 work format with real cryptographic verification', () => {
    const challenge = issueAdmission('presence', id, payload);
    expect(verifyAdmission(solve(challenge), 'presence', id, payload)).toMatchObject({ nonceHash: expect.any(Buffer), expiresAt: expect.any(Date) });
    expect(challenge.difficulty).toBe(16);
    expect(JSON.stringify(challenge)).not.toContain(payload.anonymousEventId);
    expect(Buffer.from(challenge.token.split('.')[0]!, 'base64url').toString()).not.toContain(payload.anonymousEventId);
  });
  it('binds work to one exact action, event, declaration and public collection mode', () => {
    const proof = solve(issueAdmission('presence', id, payload));
    expect(verifyAdmission(proof, 'support', id, payload)).toBeNull();
    expect(verifyAdmission(proof, 'presence', '5a52252e-28ae-49f6-ab20-98805d61d094', payload)).toBeNull();
    expect(verifyAdmission(proof, 'presence', id, { ...payload, anonymousEventId: randomBytes(32).toString('base64url') })).toBeNull();
    expect(verifyAdmission(proof, 'presence', id, { ...payload, geofenceVersion: 2 })).toBeNull();
    vi.stubEnv('REAL_EVENTS_APPROVED', 'true');
    expect(verifyAdmission(proof, 'presence', id, payload)).toBeNull();
  });
  it('rejects expiry, forged claims and a changed signing key', () => {
    const now = Date.now(); const challenge = issueAdmission('presence', id, payload, now); const proof = solve(challenge);
    expect(verifyAdmission(proof, 'presence', id, payload, now + ADMISSION_TTL_MS)).toBeNull();
    const [claims, signature] = challenge.token.split('.');
    const modified = JSON.parse(Buffer.from(claims!, 'base64url').toString()); modified[3] = 1;
    expect(verifyAdmission({ ...proof, token: `${Buffer.from(JSON.stringify(modified)).toString('base64url')}.${signature}` }, 'presence', id, payload)).toBeNull();
    vi.stubEnv('ADMISSION_SECRET', 'B'.repeat(43)); expect(verifyAdmission(proof, 'presence', id, payload)).toBeNull();
  });
  it('requires actual work and validates numeric and string boundaries', () => {
    const challenge = issueAdmission('presence', id, payload);
    let wrong = 0;
    while (sufficientWork(createHash('sha256').update(workPrefix(challenge.token)).update(nonceBytes(wrong)).digest(), 16)) wrong++;
    for (const nonce of [wrong, -1, 0x100000000, 1.5, NaN]) expect(verifyAdmission({ token: challenge.token, nonce }, 'presence', id, payload)).toBeNull();
    expect(verifyAdmission(undefined, 'presence', id, payload)).toBeNull();
    expect(verifyAdmission({ token: 'A'.repeat(801), nonce: 0 }, 'presence', id, payload)).toBeNull();
    vi.stubEnv('ADMISSION_DIFFICULTY', '0'); expect(() => issueAdmission('presence', id, payload)).toThrow();
  });
  it('retains strict privacy schemas around the additional proof', () => {
    const admission = solve(issueAdmission('presence', id, payload));
    expect(withAdmission(participationPayloadSchema).parse({ ...payload, admission })).toEqual({ payload, admission });
    expect(withAdmission(participationPayloadSchema).safeParse({ ...payload, admission, latitude: 48 }).success).toBe(false);
    expect(admissionRequestSchema.safeParse({ action: 'presence', eventId: id, payload: { ...payload, fingerprint: 'sentinel' } }).success).toBe(false);
  });
  it('closes both HTTP admission routes to old clients or requests without work', async () => {
    const support = { anonymousEventId: payload.anonymousEventId, anonymousDayId: randomBytes(32).toString('base64url'), day: '2026-10-17', protocolVersion: 1 };
    for (const response of [await presencePost(request(payload)),
      await supportPost(request(support) as unknown as Parameters<typeof supportPost>[0])]) {
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: 'admission_required' });
    }
    expect(mocked.presence).not.toHaveBeenCalled(); expect(mocked.support).not.toHaveBeenCalled();
  });
  it('passes only the strict declaration and verified work into the transaction service', async () => {
    const admission = solve(issueAdmission('presence', id, payload));
    expect((await presencePost(request({ ...payload, admission }))).status).toBe(200);
    expect(mocked.presence).toHaveBeenCalledWith(id, payload, true, expect.objectContaining({ nonceHash: expect.any(Buffer) }));
  });
});
