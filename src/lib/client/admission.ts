import type { AdmissionAction, AdmissionChallenge, AdmissionProof } from '../shared/admission';

export class AdmissionClientError extends Error {
  constructor(public readonly code: string, public readonly retryAfter = 0) { super(code); }
}

/** Called only following a user action, never while browsing, locating or recovering a status. */
export async function getAdmissionProof(action: AdmissionAction, eventId: string | undefined, payload: object, signal?: AbortSignal): Promise<AdmissionProof> {
  const response = await fetch('/api/admission', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
    signal, body: JSON.stringify({ action, ...(eventId ? { eventId } : {}), payload })
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const status = value && typeof value === 'object' && 'status' in value ? String(value.status) : 'temporarily_unavailable';
    throw new AdmissionClientError(status, Math.min(3600, Math.max(0, Number(response.headers.get('retry-after')) || 0)));
  }
  const challenge = value as AdmissionChallenge;
  if (!challenge || challenge.status !== 'challenge' || challenge.algorithm !== 'sha256-v1' ||
      typeof challenge.token !== 'string' || challenge.token.length > 800 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(challenge.token) ||
      !Number.isInteger(challenge.difficulty) || challenge.difficulty < 16 || challenge.difficulty > 20 ||
      !Number.isSafeInteger(challenge.expiresAt)) throw new AdmissionClientError('temporarily_unavailable');
  try {
    const { solveAdmission } = await import('./admission-work');
    return { token: challenge.token, nonce: await solveAdmission(challenge, signal) };
  } catch { throw new AdmissionClientError(signal?.aborted ? 'network_error' : 'admission_timeout'); }
}
