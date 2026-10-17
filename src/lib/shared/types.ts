import type { MultiPolygon, Polygon } from 'geojson';

export type EventStatus = 'draft' | 'published' | 'paused' | 'closed' | 'cancelled';
export type IntegrityStatus = 'normal' | 'anomaly' | 'suspended';
export type CountingScope = 'gathering' | 'city';
export type EventGeofence = Polygon | MultiPolygon;

export interface PublicEvent {
  id: string;
  slug: string;
  name: string;
  cityCode: string;
  cityName: string;
  description: string | null;
  geofence: EventGeofence;
  countingScope?: CountingScope;
  geofenceVersion: number;
  metadataVersion: number;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  integrityStatus: IntegrityStatus;
  protocolVersion: 1;
  isTest: boolean;
  creationSource?: 'team' | 'community';
  finalizedAt: string | null;
  presencesPurgedAt: string | null;
}

export interface CounterSnapshot {
  eventId: string;
  countingScope?: CountingScope;
  total: string;
  revision: string;
  day: string;
  nationalTotal: string;
  nationalRevision: string;
  cityTotal: string;
  cityRevision: string;
  supportTotal?: string;
  supportRevision?: string;
  nationalSupportTotal?: string;
  nationalSupportRevision?: string;
  citySupportTotal?: string;
  citySupportRevision?: string;
  epoch: string;
  serverTime: string;
  eventStatus: EventStatus;
  integrityStatus: IntegrityStatus;
  metadataVersion: number;
  startsAt: string;
  endsAt: string;
}

export type AdmissionStatus =
  | 'counted'
  | 'already_counted'
  | 'not_open'
  | 'ended'
  | 'paused'
  | 'event_updated'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'real_events_disabled'
  | 'scope_confirmation_required';

export interface ParticipationReply {
  status: AdmissionStatus;
  snapshot?: CounterSnapshot;
  retryAfter?: number;
}

export interface PresenceStatusReply {
  status: 'counted' | 'not_counted' | 'details_expired';
  snapshot: CounterSnapshot;
}

export interface SupportPayload {
  anonymousEventId: string;
  anonymousDayId: string;
  day: string;
  protocolVersion: 1;
  countingScope?: CountingScope;
}

export type SupportStatus = AdmissionStatus
  | 'supported'
  | 'already_supported'
  | 'already_present'
  | 'daily_limit_reached'
  | 'day_changed';

export interface SupportReply {
  status: SupportStatus;
  snapshot?: CounterSnapshot;
  retryAfter?: number;
}

export interface SupportStatusReply {
  status: 'supported' | 'present' | 'not_supported' | 'details_expired';
  snapshot: CounterSnapshot;
}

export interface ParticipationPayload {
  anonymousEventId: string;
  geofenceVersion: number;
  protocolVersion: 1;
  insideZone: true;
  countingScope?: CountingScope;
}

export type FlowPhase =
  | 'idle'
  | 'locating'
  | 'choosing'
  | 'submitting'
  | 'counted'
  | 'already_counted'
  | 'pending'
  | 'error';

export interface FlowState {
  phase: FlowPhase;
  message: string;
  code?: string;
  eventId?: string;
  choices?: PublicEvent[];
}
