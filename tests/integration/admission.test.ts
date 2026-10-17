import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closeDatabase, transaction } from '../../src/lib/server/db';
import { migrate } from '../../scripts/migrate';
import { consumeAdmission, issueAdmission, verifyAdmission, type VerifiedAdmission } from '../../src/lib/server/admission';
import { nonceBytes, sufficientWork, workPrefix } from '../../src/lib/shared/admission';
import { registerPresence, registerSupport } from '../../src/lib/server/participation';
import { getCounterSnapshot } from '../../src/lib/server/counters';
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required');
const ids: string[] = []; const claims: Buffer[] = []; const daily: Buffer[] = [];
const old = { url: process.env.DATABASE_URL, difficulty: process.env.ADMISSION_DIFFICULTY, real: process.env.REAL_EVENTS_APPROVED };
async function fixture() {
  const id = randomUUID(); ids.push(id);
  await getPool().query(`INSERT INTO events(id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES($1,$2,'Admission fictive','AUDIT','Ville fictive',$3,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
  [id, `work-${id}`, { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] }]); return id;
}
function work(id: string, payload: object, action: 'presence' | 'support' = 'presence'): VerifiedAdmission {
  const challenge = issueAdmission(action, id, payload); const prefix = createHash('sha256').update(workPrefix(challenge.token));
  for (let nonce = 0; ; nonce++) if (sufficientWork(prefix.copy().update(nonceBytes(nonce)).digest(), challenge.difficulty)) {
    const verified = verifyAdmission({ token: challenge.token, nonce }, action, id, payload)!; claims.push(verified.nonceHash); return verified;
  }
}
const token = () => randomBytes(32).toString('base64url');
const presence = () => ({ anonymousEventId: token(), geofenceVersion: 1, protocolVersion: 1 as const, insideZone: true as const });

describe.skipIf(!testUrl)('atomic spent-work markers on PostgreSQL', () => {
  beforeAll(async () => { process.env.DATABASE_URL = testUrl; process.env.ADMISSION_DIFFICULTY = '16'; process.env.REAL_EVENTS_APPROVED = 'false'; await closeDatabase(); await migrate(); });
  afterAll(async () => {
    for (const table of ['presences','supports','event_counters','support_counters','admin_audit']) await getPool().query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [ids]);
    await getPool().query('DELETE FROM events WHERE id=ANY($1::uuid[])',[ids]);
    await getPool().query('DELETE FROM admission_claims WHERE nonce_hash=ANY($1::bytea[])',[claims]);
    await getPool().query('DELETE FROM daily_support_claims WHERE anonymous_day_id=ANY($1::bytea[])',[daily]);
    await closeDatabase();
    for (const [key,value] of Object.entries({ DATABASE_URL: old.url, ADMISSION_DIFFICULTY: old.difficulty, REAL_EVENTS_APPROVED: old.real })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  it('accepts concurrent retries exactly once with the same verified work', async () => {
    const id = await fixture(); const payload = presence(); const proof = work(id,payload);
    const results = await Promise.all(Array.from({ length: 12 }, () => registerPresence(id,payload,true,proof)));
    expect(results.filter(r => r.status === 'counted')).toHaveLength(1);
    expect(results.filter(r => r.status === 'already_counted')).toHaveLength(11);
    expect((await getCounterSnapshot(id,true))?.total).toBe('1');
    expect(await transaction(c => consumeAdmission(c,proof))).toBe(false);
  });
  it('rolls spent work back together with a failed transaction', async () => {
    const proof = work(await fixture(),presence());
    await expect(transaction(async client => { expect(await consumeAdmission(client,proof)).toBe(true); throw new Error('synthetic rollback'); })).rejects.toThrow('synthetic rollback');
    expect(await transaction(c => consumeAdmission(c,proof))).toBe(true);
  });
  it('uses the DB clock to reject an expired proof without an increment', async () => {
    const id = await fixture(); const payload = presence(); const proof = work(id,payload); proof.expiresAt = new Date(0);
    expect((await registerPresence(id,payload,true,proof)).status).toBe('admission_required');
    expect((await getCounterSnapshot(id,true))?.total).toBe('0');
  });
  it('never consumes the daily support right when work has already been spent', async () => {
    const id = await fixture(); const day = (await getPool().query("SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS day")).rows[0].day;
    const payload = { anonymousEventId: token(), anonymousDayId: token(), day, protocolVersion: 1 as const };
    const dayId = Buffer.from(payload.anonymousDayId,'base64url'); daily.push(dayId); const proof = work(id,payload,'support');
    expect(await transaction(c=>consumeAdmission(c,proof))).toBe(true);
    expect((await registerSupport(id,payload,true,proof)).status).toBe('admission_required');
    expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE anonymous_day_id=$1',[dayId])).rowCount).toBe(0);
    expect((await getCounterSnapshot(id,true))?.supportTotal).toBe('0');
  });
  it('stores no event reference, IP or participant token in spent-work markers', async () => {
    const columns = await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='admission_claims' ORDER BY ordinal_position");
    expect(columns.rows.map(r=>r.column_name)).toEqual(['nonce_hash','expires_at']);
  });
  it('works with only SELECT and INSERT and leaves deletion to maintenance', async () => {
    const proof = work(await fixture(),presence());
    const role = `work_test_${randomUUID().replaceAll('-','')}`;
    const client = await getPool().connect();
    try {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT,INSERT ON admission_claims TO ${role}`);
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
      expect(await consumeAdmission(client,proof)).toBe(true);
      await expect(client.query('DELETE FROM admission_claims')).rejects.toMatchObject({code:'42501'});
    } finally {
      await client.query('ROLLBACK');
      await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); client.release();
    }
  });
});
