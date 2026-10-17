import type { RequestHandler } from './$types';
import { admissionRequestSchema } from '#lib/shared/admission';
import { issueAdmission } from '#lib/server/admission';
import { privateJson, privateRequest } from '#lib/server/http';
import { publicCounterSnapshot } from '#lib/server/public-data';
import { recordAdmissionEvent } from '#lib/server/integrity-metrics';

export const POST: RequestHandler = (event) => privateRequest(event, admissionRequestSchema, async (request) => {
  if (request.action !== 'create') {
    const snapshot = await publicCounterSnapshot(request.eventId);
    if (!snapshot) return privateJson({ status: 'not_found' }, 404);
    if (snapshot.eventStatus === 'paused' || snapshot.integrityStatus === 'suspended') return privateJson({ status: 'paused' }, 409);
    if (snapshot.eventStatus !== 'published' || Date.parse(snapshot.serverTime) >= Date.parse(snapshot.endsAt)) return privateJson({ status: 'ended' }, 409);
    if (Date.parse(snapshot.serverTime) < Date.parse(snapshot.startsAt)) return privateJson({ status: 'not_open' }, 409);
  }
  const challenge = issueAdmission(request.action, 'eventId' in request ? request.eventId : undefined, request.payload);
  if ('eventId' in request) recordAdmissionEvent(request.eventId, 'challenge_issued');
  return privateJson(challenge);
}, { scope: 'admission', readOnly: true });
