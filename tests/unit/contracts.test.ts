import { describe, expect, it } from 'vitest';
import { anonymousEventIdSchema, participationPayloadSchema, presenceStatusPayloadSchema } from '../../src/lib/shared/contracts';
import { randomBytes } from 'node:crypto';

describe('privacy HTTP contracts', () => {
  it('accepts canonical 256-bit event identities and rejects non-canonical tail bits', () => {
    for (let i = 0; i < 100; i++) expect(anonymousEventIdSchema.safeParse(randomBytes(32).toString('base64url')).success).toBe(true);
    expect(anonymousEventIdSchema.safeParse('A'.repeat(42) + 'B').success).toBe(false);
  });
  it('rejects a location accidentally serialized into an admission', () => {
    const valid = { anonymousEventId: 'A'.repeat(43), geofenceVersion: 1, protocolVersion: 1, insideZone: true };
    expect(participationPayloadSchema.safeParse(valid).success).toBe(true);
    expect(participationPayloadSchema.safeParse({ ...valid, latitude: 48.867, longitude: 2.363 }).success).toBe(false);
    expect(participationPayloadSchema.safeParse({ ...valid, insideZone: false }).success).toBe(false);
  });
  it('keeps status checks separate from admission assertions', () => {
    expect(presenceStatusPayloadSchema.safeParse({ anonymousEventId: 'A'.repeat(43) }).success).toBe(true);
    expect(presenceStatusPayloadSchema.safeParse({ anonymousEventId: 'A'.repeat(43), insideZone: true }).success).toBe(false);
  });
});
