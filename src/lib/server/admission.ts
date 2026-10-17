import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { nonceBytes, sufficientWork, workPrefix } from '../shared/admission-work';
import type { AdmissionAction, AdmissionChallenge, AdmissionProof } from '../shared/admission';
import { realEventsApproved } from './db';

export const ADMISSION_TTL_MS = 120_000;
const ephemeralSecret = randomBytes(32);
function secret(): Buffer {
  const configured = process.env.ADMISSION_SECRET;
  if (configured === undefined || configured === '') return ephemeralSecret;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(configured)) throw new Error('Invalid admission secret');
  return Buffer.from(configured);
}
export function admissionDifficulty(): number {
  const value = process.env.ADMISSION_DIFFICULTY ?? '18';
  if (!/^(16|17|18|19|20)$/.test(value)) throw new Error('Invalid admission difficulty');
  return Number(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function binding(action: AdmissionAction, eventId: string | undefined, payload: object): string {
  return createHash('sha256').update(canonical([action, eventId ?? null, payload])).digest('hex');
}
export function issueAdmission(action: AdmissionAction, eventId: string | undefined, payload: object, now = Date.now()): AdmissionChallenge {
  const difficulty = admissionDifficulty();
  const expiresAt = now + ADMISSION_TTL_MS;
  const encoded = Buffer.from(JSON.stringify([1, randomBytes(24).toString('base64url'), expiresAt, difficulty,
    binding(action, eventId, payload), realEventsApproved()])).toString('base64url');
  const signature = createHmac('sha256', secret()).update(encoded).digest('base64url');
  return { status: 'challenge', algorithm: 'sha256-v1', token: `${encoded}.${signature}`, difficulty, expiresAt };
}
export interface VerifiedAdmission { nonceHash: Buffer; expiresAt: Date }
export function verifyAdmission(proof: AdmissionProof | undefined, action: AdmissionAction, eventId: string | undefined, payload: object, now = Date.now()): VerifiedAdmission | null {
  if (!proof || typeof proof.token !== 'string' || proof.token.length > 800 ||
      !Number.isInteger(proof.nonce) || proof.nonce < 0 || proof.nonce > 0xffffffff) return null;
  const parts = proof.token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const signature = Buffer.from(parts[1]!, 'base64url');
  const expected = createHmac('sha256', secret()).update(parts[0]!).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(claims) || claims.length !== 6 || claims[0] !== 1 || typeof claims[1] !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(claims[1]) || !Number.isSafeInteger(claims[2]) ||
      claims[2] <= now || claims[2] > now + ADMISSION_TTL_MS ||
      !Number.isInteger(claims[3]) || claims[3] < 16 || claims[3] > 20 ||
      claims[4] !== binding(action, eventId, payload) || claims[5] !== realEventsApproved()) return null;
  const hash = createHash('sha256').update(workPrefix(proof.token)).update(nonceBytes(proof.nonce)).digest();
  if (!sufficientWork(hash, claims[3])) return null;
  return { nonceHash: createHash('sha256').update(claims[1]).digest(), expiresAt: new Date(claims[2]) };
}

/** Spent work and counter changes commit or roll back together. No event or participant is stored. */
export async function consumeAdmission(client: PoolClient, admission: VerifiedAdmission): Promise<boolean> {
  const result = await client.query(`WITH consumed AS (
    INSERT INTO admission_claims(nonce_hash,expires_at)
    SELECT $1,$2::timestamptz WHERE clock_timestamp() < $2::timestamptz
    ON CONFLICT (nonce_hash) DO NOTHING RETURNING nonce_hash
  ) SELECT nonce_hash FROM consumed WHERE clock_timestamp() < $2::timestamptz`, [admission.nonceHash, admission.expiresAt]);
  return result.rowCount === 1;
}
