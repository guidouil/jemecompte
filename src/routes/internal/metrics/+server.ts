import { timingSafeEqual } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { operationalMetrics } from '#lib/server/observability';
import { realtimeMetrics } from '#lib/server/realtime';
import { getPool } from '#lib/server/db/index';

export const GET: RequestHandler = ({ request }) => {
  const token = process.env.METRICS_TOKEN;
  const received = request.headers.get('authorization');
  const expected = token ? `Bearer ${token}` : '';
  if (!token || !received || Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const pool = getPool();
  return json({
    ...operationalMetrics(), realtime: realtimeMetrics(),
    database: { connections: pool.totalCount, idle: pool.idleCount, queued: pool.waitingCount }
  }, { headers: { 'cache-control': 'no-store' } });
};
