import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdmissionProof, AdmissionClientError } from '../../src/lib/client/admission';
import { solveAdmission } from '../../src/lib/client/admission-work';
import { issueAdmission, verifyAdmission } from '../../src/lib/server/admission';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const id = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const payload = { anonymousEventId: 'A'.repeat(43), geofenceVersion: 1, protocolVersion: 1, insideZone: true };
describe('local admission client', () => {
  it('solves a real signed challenge using local JS and sends only the intended declaration', async () => {
    vi.stubEnv('ADMISSION_DIFFICULTY', '16');
    const challenge = issueAdmission('presence',id,payload);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(challenge), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch',fetchMock);
    const proof = await getAdmissionProof('presence',id,payload);
    expect(verifyAdmission(proof,'presence',id,payload)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path,options] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/admission'); expect(options.cache).toBe('no-store');
    expect(JSON.parse(options.body)).toEqual({ action: 'presence', eventId:id, payload });
  });
  it('respects cancellation before starting work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(solveAdmission(issueAdmission('presence',id,payload),controller.signal)).rejects.toThrow('aborted');
  });
  it('stops local work after the fixed budget without lowering its difficulty', async () => {
    const challenge = issueAdmission('presence',id,payload);
    vi.spyOn(performance,'now').mockReturnValueOnce(0).mockReturnValue(8001);
    await expect(solveAdmission(challenge)).rejects.toThrow('work_timeout');
  });
  it('rejects unexpected algorithms or excessive work before loading the solver', async () => {
    const challenge = issueAdmission('presence',id,payload);
    for (const invalid of [{...challenge,difficulty:21},{...challenge,algorithm:'remote-captcha'}]) {
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid))));
      await expect(getAdmissionProof('presence',id,payload)).rejects.toBeInstanceOf(AdmissionClientError);
    }
  });
  it('keeps server retry delays and never sends a challenge to an external provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'rate_limited'}),{ status:429,headers:{'retry-after':'60'} }));
    vi.stubGlobal('fetch',fetchMock);
    await expect(getAdmissionProof('presence',id,payload)).rejects.toMatchObject({code:'rate_limited',retryAfter:60});
    expect(fetchMock.mock.calls.map(c=>c[0])).toEqual(['/api/admission']);
  });
});
