import { createHash } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { nonceBytes, sufficientWork, workPrefix } from '../../src/lib/shared/admission-work';
import type { AdmissionAction, AdmissionChallenge } from '../../src/lib/shared/admission';

/** Real HTTP challenge and real work for synthetic browser/API fixtures only. */
export async function admittedBody(request: APIRequestContext, action: AdmissionAction, payload: object, eventId?: string) {
  const response = await request.post('/api/admission', { headers: { Origin: 'http://127.0.0.1:5175' },
    data: { action, payload, ...(eventId ? { eventId } : {}) } });
  if (!response.ok()) throw new Error(`Synthetic challenge rejected (${response.status()})`);
  const challenge = await response.json() as AdmissionChallenge;
  const prefix = createHash('sha256').update(workPrefix(challenge.token));
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    if (sufficientWork(prefix.copy().update(nonceBytes(nonce)).digest(), challenge.difficulty)) {
      return { ...payload, admission: { token: challenge.token, nonce } };
    }
  }
  throw new Error('Synthetic work exhausted');
}
