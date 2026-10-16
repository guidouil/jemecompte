type Metric = 'requests' | 'counted' | 'already_counted' | 'rejected' | 'rate_limited' | 'unavailable' | 'server_error';
const counts: Record<Metric, number> = {
  requests: 0, counted: 0, already_counted: 0, rejected: 0,
  rate_limited: 0, unavailable: 0, server_error: 0
};
let durationTotal = 0;
let durationCount = 0;
const latencyBounds = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000];
const latencyBuckets = new Array<number>(latencyBounds.length + 1).fill(0);
const startedAt = new Date().toISOString();

export function record(metric: Metric): void { counts[metric]++; }
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
    meanRequestMilliseconds: durationCount ? Math.round(durationTotal / durationCount) : 0,
    latencyBuckets: latencyBuckets.map((count, index) => ({ upperBoundMs: latencyBounds[index] ?? null, count })),
    cpuMicroseconds: process.cpuUsage(),
    memoryBytes: process.memoryUsage().rss
  };
}
