import { sha256 } from '@noble/hashes/sha2.js';
import { nonceBytes, sufficientWork, workPrefix } from '../shared/admission-work';
import type { AdmissionChallenge } from '../shared/admission';

function yieldToBrowser(): Promise<void> {
  // Nested setTimeout calls are clamped to 4ms in browsers. A message task keeps
  // the interface responsive without multiplying that delay by every batch.
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}

/** Bounded, cooperative work: no hardware probe, timing report, storage or external request. */
export async function solveAdmission(challenge: AdmissionChallenge, signal?: AbortSignal): Promise<number> {
  const started = performance.now();
  const prefix = sha256.create().update(workPrefix(challenge.token));
  try {
    for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
      if (nonce % 2048 === 0) {
        if (signal?.aborted) throw new Error('aborted');
        if (performance.now() - started > 8_000) throw new Error('work_timeout');
        // Yield to input and rendering even on devices without Worker support.
        await yieldToBrowser();
      }
      if (sufficientWork(prefix.clone().update(nonceBytes(nonce)).digest(), challenge.difficulty)) return nonce;
    }
    throw new Error('work_timeout');
  } finally { prefix.destroy(); }
}
