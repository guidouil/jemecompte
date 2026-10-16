type Metric = 'requests' | 'counted' | 'already_counted' | 'rejected' | 'rate_limited' | 'unavailable' | 'server_error';
const counts: Record<Metric, number> = {
  requests: 0, counted: 0, already_counted: 0, rejected: 0,
  rate_limited: 0, unavailable: 0, server_error: 0
};
type HttpKind = 'write' | 'stream';
export type UnavailableReason = 'write_capacity' | 'write_failure' | 'stream_capacity' | 'stream_failure' | 'other';
const unavailabilityReasons: Record<UnavailableReason, number> = {
  write_capacity: 0, write_failure: 0, stream_capacity: 0, stream_failure: 0, other: 0
};
function responseBuckets() { return { '2xx': 0, '3xx': 0, '4xx': 0, '429': 0, '503': 0, '5xx': 0, other: 0 }; }
const httpResponses = { write: responseBuckets(), stream: responseBuckets() };
let durationTotal = 0;
let durationCount = 0;
const latencyBounds = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000];
const latencyBuckets = new Array<number>(latencyBounds.length + 1).fill(0);
const startedAt = new Date().toISOString();

export function record(metric: Metric): void { counts[metric]++; }
/** Fixed categories only: never retain paths, event IDs, peers, payloads or exception messages. */
export function recordHttpResponse(kind: HttpKind, status: number, reason: UnavailableReason = 'other'): void {
  const bucket = status === 429 ? '429' : status === 503 ? '503' :
    status >= 200 && status < 300 ? '2xx' : status >= 300 && status < 400 ? '3xx' :
    status >= 400 && status < 500 ? '4xx' : status >= 500 && status < 600 ? '5xx' : 'other';
  httpResponses[kind][bucket]++;
  if (status === 503) {
    record('unavailable');
    unavailabilityReasons[reason]++;
  }
}
export function recordDuration(milliseconds: number): void {
  durationCount++;
  durationTotal += milliseconds;
  const index = latencyBounds.findIndex((bound) => milliseconds <= bound);
  const bucket = index < 0 ? latencyBounds.length : index;
  latencyBuckets[bucket] = (latencyBuckets[bucket] ?? 0) + 1;
}
export function operationalMetrics() {
  return {
    startedAt,
    ...counts,
    httpResponses: { write: { ...httpResponses.write }, stream: { ...httpResponses.stream } },
    unavailabilityReasons: { ...unavailabilityReasons },
    meanRequestMilliseconds: durationCount ? Math.round(durationTotal / durationCount) : 0,
    latencyBuckets: latencyBuckets.map((count, index) => ({ upperBoundMs: latencyBounds[index] ?? null, count })),
    cpuMicroseconds: process.cpuUsage(),
    memoryBytes: process.memoryUsage().rss
  };
}
