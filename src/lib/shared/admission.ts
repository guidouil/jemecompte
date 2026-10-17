import { z } from 'zod';
import { participationPayloadSchema, supportPayloadSchema, eventIdSchema } from './contracts';
import { createEventPayloadSchema } from './event-creation';

export type AdmissionAction = 'presence' | 'support' | 'create';
export interface AdmissionProof { token: string; nonce: number }
export interface AdmissionChallenge {
  status: 'challenge'; algorithm: 'sha256-v1'; token: string; difficulty: number; expiresAt: number;
}
export const admissionProofSchema = z.object({
  token: z.string().min(100).max(800).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
  nonce: z.number().int().min(0).max(0xffffffff)
}).strict();
export const admissionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('presence'), eventId: eventIdSchema, payload: participationPayloadSchema }).strict(),
  z.object({ action: z.literal('support'), eventId: eventIdSchema, payload: supportPayloadSchema }).strict(),
  z.object({ action: z.literal('create'), payload: createEventPayloadSchema }).strict()
]);

/** Keep the declaration's existing strict allowlist, including rejection of coordinates. */
export function withAdmission<T>(schema: z.ZodType<T>) {
  return z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { admission, ...payload } = value as Record<string, unknown>;
    return { payload, admission };
  }, z.object({ payload: schema, admission: admissionProofSchema.optional() }).strict());
}

export { workPrefix, nonceBytes, sufficientWork } from './admission-work';
