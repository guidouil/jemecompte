import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

// Local synthetic smoke test, not a production capacity benchmark. No application DB fallback.
const HOST = '127.0.0.1';
const PORT = 5177;
const ORIGIN = `http://${HOST}:${PORT}`;
const BUILD = fileURLToPath(new URL('../build/index.js', import.meta.url));
const MAX_ATTEMPTS = 8;

function parameter(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is mandatory; no application connection is used.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('TEST_DATABASE_URL is invalid.'); }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !decodeURIComponent(url.pathname).endsWith('_test') ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  ) {
    throw new Error('A loopback PostgreSQL database with a name ending in _test is required.');
  }
  return value;
}

type RequestKind = 'readers' | 'admissions' | 'replays' | 'metrics';
interface Metrics {
  memoryBytes: number;
  realtime: { connections: number; channels: number };
}
interface ReaderHandle {
  controller: AbortController;
  finished: Promise<void>;
  frames: number;
  closed: boolean;
  lastTotal: bigint;
}

async function main(): Promise<void> {
  const total = parameter('TOTAL', 1_000, 1, 20_000);
  const readerCount = parameter('READERS', 200, 0, 6_000);
  const concurrency = parameter('CONCURRENCY', 64, 1, 128);
  const databaseUrl = testDatabaseUrl();
  const metricsToken = randomBytes(32).toString('base64url');
  const fixtureId = randomUUID();
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 3_000, statement_timeout: 8_000 });
  pool.on('error', () => {});
  const readers: ReaderHandle[] = [];
  const requestControllers = new Set<AbortController>();
  const statuses: Record<RequestKind, Record<string, number>> = {
    readers: {}, admissions: {}, replays: {}, metrics: {}
  };
  const businessStatuses: Record<string, number> = {};
  const confirmations: number[] = [];
  let child: ChildProcess | undefined;
  let createdFixture = false;
  let stopping = false;
  let interrupted = false;
  let readerFailures = 0;
  let networkFailures = 0;
  let metricFailures = 0;
  let peakRss = 0;
  let peakConnections = 0;
  let peakChannels = 0;
  let metricTimer: ReturnType<typeof setInterval> | undefined;
  let pendingMetric: Promise<void> | undefined;
  let completed = false;
  let cleanupSucceeded = false;
  const globalStart = performance.now();

  const onInterrupt = () => {
    interrupted = true;
    stopping = true;
    for (const controller of requestControllers) controller.abort();
    for (const reader of readers) reader.controller.abort();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  function ensureRunning(): void {
    if (stopping || interrupted) throw new Error('Local smoke test interrupted.');
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('The isolated smoke server exited unexpectedly.');
    }
  }

  function recordHttp(kind: RequestKind, status: number): void {
    const key = String(status);
    statuses[kind][key] = (statuses[kind][key] ?? 0) + 1;
  }

  async function request(path: string, kind: RequestKind, init: RequestInit = {}, timeout = 15_000) {
    ensureRunning();
    const controller = new AbortController();
    requestControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path, ORIGIN), { ...init, signal: controller.signal });
      recordHttp(kind, response.status);
      return response;
    } finally {
      clearTimeout(timer);
      requestControllers.delete(controller);
    }
  }

  function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function retryDelay(response: Response | undefined, attempt: number): number {
    const header = response?.headers.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    const date = header && !Number.isFinite(seconds) ? Date.parse(header) : NaN;
    const advised = Number.isFinite(seconds) ? Math.max(0, seconds) * 1_000 :
      Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
    return Math.max(advised, Math.min(5_000, 150 * 2 ** attempt)) + Math.random() * 250;
  }

  async function boundedJobs(count: number, work: (index: number) => Promise<void>, limit = concurrency): Promise<void> {
    let next = 0;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(count, limit) }, async () => {
      while (!failure && next < count) {
        const index = next++;
        try { ensureRunning(); await work(index); }
        catch (error) { failure = error; }
      }
    }));
    if (failure) throw failure;
  }

  async function sampleMetrics(): Promise<void> {
    const response = await request('/internal/metrics', 'metrics', {
      headers: { Authorization: `Bearer ${metricsToken}` }, cache: 'no-store'
    }, 3_000);
    if (!response.ok) throw new Error('Authenticated smoke metrics are unavailable.');
    const metrics = await response.json() as Metrics;
    if (!Number.isFinite(metrics.memoryBytes) || !Number.isFinite(metrics.realtime?.connections)) {
      throw new Error('The isolated server returned invalid operational metrics.');
    }
    peakRss = Math.max(peakRss, metrics.memoryBytes);
    peakConnections = Math.max(peakConnections, metrics.realtime.connections);
    peakChannels = Math.max(peakChannels, metrics.realtime.channels);
  }

  async function openReader(): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      ensureRunning();
      const controller = new AbortController();
      requestControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let response: Response | undefined;
      try {
        response = await fetch(`${ORIGIN}/api/events/${fixtureId}/stream`, {
          headers: { Accept: 'text/event-stream', Origin: ORIGIN }, signal: controller.signal
        });
        recordHttp('readers', response.status);
        if (response.status === 429 || response.status === 503) {
          await response.body?.cancel();
          clearTimeout(timeout);
          requestControllers.delete(controller);
          await sleep(retryDelay(response, attempt));
          continue;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
          throw new Error(`An SSE reader was refused with HTTP ${response.status}.`);
        }
        clearTimeout(timeout);
        requestControllers.delete(controller);
        const streamReader = response.body.getReader();
        const handle: ReaderHandle = { controller, finished: Promise.resolve(), frames: 0, closed: false, lastTotal: 0n };
        readers.push(handle);
        handle.finished = (async () => {
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (true) {
              const part = await streamReader.read();
              if (part.done) break;
              buffer += decoder.decode(part.value, { stream: true });
              if (buffer.length > 65_536) throw new Error('Oversized SSE frame.');
              let boundary: number;
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (!frame.includes('event: counters')) continue;
                const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
                if (!line) continue;
                const value = JSON.parse(line.slice(6)) as { eventId?: string; total?: string };
                if (value.eventId !== fixtureId || typeof value.total !== 'string' || !/^\d+$/.test(value.total)) {
                  throw new Error('Invalid public SSE snapshot.');
                }
                handle.lastTotal = BigInt(value.total);
                handle.frames += 1;
              }
            }
            if (!stopping) readerFailures += 1;
          } catch {
            if (!stopping) readerFailures += 1;
          } finally {
            handle.closed = true;
            try { streamReader.releaseLock(); } catch { /* Disposed read. */ }
          }
        })();
        return;
      } catch (error) {
        if (error instanceof Error && /refused|Oversized|Invalid public/.test(error.message)) throw error;
        networkFailures += 1;
        if (attempt === MAX_ATTEMPTS - 1) throw new Error('An SSE reader could not connect after bounded retries.');
        await sleep(retryDelay(response, attempt));
      } finally {
        clearTimeout(timeout);
        requestControllers.delete(controller);
      }
    }
    throw new Error('An SSE reader exhausted its retry budget.');
  }

  async function submit(anonymousEventId: string, replay: boolean): Promise<void> {
    const started = performance.now();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await request(`/api/events/${fixtureId}/presences`, replay ? 'replays' : 'admissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
          body: JSON.stringify({ anonymousEventId, geofenceVersion: 1, protocolVersion: 1, insideZone: true })
        });
        if (response.status === 429 || response.status === 503) {
          await response.body?.cancel();
          await sleep(retryDelay(response, attempt));
          continue;
        }
        if (!response.ok) throw new Error(`A participation was refused with HTTP ${response.status}.`);
        const reply = await response.json() as { status?: string };
        if (reply.status !== 'counted' && reply.status !== 'already_counted') {
          throw new Error('The server did not confirm the participation.');
        }
        if (replay && reply.status !== 'already_counted') {
          throw new Error('A replay was admitted as a new participation.');
        }
        businessStatuses[reply.status] = (businessStatuses[reply.status] ?? 0) + 1;
        if (!replay) confirmations.push(performance.now() - started);
        return;
      } catch (error) {
        if (error instanceof Error && /refused|did not confirm|replay was/.test(error.message)) throw error;
        networkFailures += 1;
        if (attempt === MAX_ATTEMPTS - 1) throw new Error('A participation exhausted its network retry budget.');
        await sleep(retryDelay(response, attempt));
      }
    }
    throw new Error('A participation exhausted its HTTP retry budget.');
  }

  async function stopChild(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
    current.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => {
      timer = setTimeout(() => { current.kill('SIGKILL'); resolve(); }, 5_000);
    })]);
    if (timer) clearTimeout(timer);
    if (current.exitCode === null && current.signalCode === null) await exited;
  }

  try {
    await access(BUILD);
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', (error) => reject(new Error(
        'code' in error && error.code === 'EADDRINUSE'
          ? 'Port 5177 is occupied; no existing server will be touched.'
          : 'Cannot bind loopback port 5177 in this environment.'
      )));
      probe.listen(PORT, HOST, () => probe.close((error) => error ? reject(error) : resolve()));
    });
    const polygon = { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] };
    await pool.query(`INSERT INTO events
      (id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,status,is_test)
      VALUES ($1,$2,'CHARGE LOCALE FICTIVE — AUCUNE MANIFESTATION',$3,'Ville fictive',
      'Synthetic local smoke fixture; no people or actual positions.',$4::jsonb,
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '30 minutes','published',true)`,
    [fixtureId, `load-smoke-${fixtureId}`, fixtureId.slice(0, 8), JSON.stringify(polygon)]);
    createdFixture = true;
    const initial = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [fixtureId]);
    if (initial.rows[0]?.count !== '0') throw new Error('The synthetic fixture must start at zero.');

    child = spawn(process.execPath, [BUILD], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl, REAL_EVENTS_APPROVED: 'false',
        HOST, PORT: String(PORT), ORIGIN, METRICS_TOKEN: metricsToken },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Drain child output without echoing payloads, credentials or private operational details.
    child.stdout?.resume();
    child.stderr?.resume();
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    const startupDeadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < startupDeadline) {
      ensureRunning();
      if (spawnFailed) throw new Error('The isolated smoke server could not start.');
      try { await sampleMetrics(); ready = true; break; } catch { await sleep(100); }
    }
    if (!ready) throw new Error('The isolated server did not become ready on port 5177.');
    const startupMs = performance.now() - globalStart;
    metricTimer = setInterval(() => {
      if (!pendingMetric && !stopping) {
        pendingMetric = sampleMetrics().catch(() => { metricFailures += 1; }).finally(() => { pendingMetric = undefined; });
      }
    }, 500);

    const workloadStart = performance.now();
    await boundedJobs(readerCount, () => openReader());
    await sampleMetrics();
    if (peakConnections < readerCount) throw new Error('The requested SSE reader count was not reached.');
    const identifiers = Array.from({ length: total }, () => randomBytes(32).toString('base64url'));
    await boundedJobs(total, (index) => submit(identifiers[index]!, false));
    const replays = Math.min(100, total);
    await boundedJobs(replays, (index) => submit(identifiers[index]!, true));

    const verification = await pool.query<{ presences: string; counter: string }>(`
      SELECT (SELECT count(*)::text FROM presences WHERE event_id=$1) AS presences,
        (SELECT COALESCE(sum(count),0)::text FROM event_counters WHERE event_id=$1) AS counter`, [fixtureId]);
    const result = verification.rows[0];
    if (!result || result.presences !== String(total) || result.counter !== String(total)) {
      throw new Error('Presence count and transactional counter diverged from the synthetic total.');
    }
    // Allow the grouped 3-second broadcaster to deliver the final absolute value to every reader.
    const deliveryDeadline = Date.now() + 8_000;
    while (readerCount > 0 && readers.some((reader) => !reader.closed && reader.lastTotal !== BigInt(total)) && Date.now() < deliveryDeadline) {
      await sleep(100);
    }
    await sampleMetrics();
    const liveReaders = readers.filter((reader) => !reader.closed).length;
    const readersAtFinalTotal = readers.filter((reader) => !reader.closed && reader.lastTotal === BigInt(total)).length;
    if (liveReaders !== readerCount || readersAtFinalTotal !== readerCount || readerFailures !== 0) {
      throw new Error('At least one SSE reader disconnected or missed the final snapshot.');
    }
    confirmations.sort((left, right) => left - right);
    const p95 = confirmations[Math.max(0, Math.ceil(confirmations.length * 0.95) - 1)] ?? 0;
    completed = true;
    console.log(JSON.stringify({
      localSyntheticSmoke: true, productionCapacityClaim: false, total, requestedReaders: readerCount, concurrency,
      startupMs: Math.round(startupMs), workloadMs: Math.round(performance.now() - workloadStart),
      confirmationP95IncludingRetriesMs: Math.round(p95), confirmedDistinct: confirmations.length,
      replayedIdentities: replays, presenceRows: result.presences, transactionalCounter: result.counter,
      sampledPeakRssBytes: peakRss, sampledPeakRssMiB: Math.round(peakRss / 1024 / 1024 * 10) / 10,
      sampledPeakSseConnections: peakConnections, sampledPeakSseChannels: peakChannels,
      liveReaders, readersAtFinalTotal, sseFrames: readers.reduce((sum, reader) => sum + reader.frames, 0),
      httpStatuses: statuses, businessStatuses, networkFailures, readerFailures, metricFailures,
      totalBeforeCleanupMs: Math.round(performance.now() - globalStart)
    }, null, 2));
  } finally {
    stopping = true;
    if (metricTimer) clearInterval(metricTimer);
    for (const controller of requestControllers) controller.abort();
    for (const reader of readers) reader.controller.abort();
    try {
      await Promise.allSettled(readers.map((reader) => reader.finished));
      if (pendingMetric) await pendingMetric;
      await stopChild();
      if (createdFixture) {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          for (const table of ['admin_audit', 'presences', 'event_counters']) {
            await connection.query(`DELETE FROM ${table} WHERE event_id=$1`, [fixtureId]);
          }
          await connection.query('DELETE FROM events WHERE id=$1 AND is_test=true', [fixtureId]);
          await connection.query('COMMIT');
          cleanupSucceeded = true;
        } catch {
          await connection.query('ROLLBACK');
          throw new Error('Synthetic fixture cleanup failed; inspect the dedicated test database.');
        } finally { connection.release(); }
      }
    } finally {
      await pool.end();
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      console.log(JSON.stringify({ smokeCompleted: completed, ownFixtureDeleted: cleanupSucceeded,
        isolatedServerStopped: !child || child.exitCode !== null || child.signalCode !== null,
        ...(!completed ? {
          total, requestedReaders: readerCount, openedReaders: readers.length,
          confirmedDistinct: confirmations.length, sampledPeakRssBytes: peakRss,
          sampledPeakSseConnections: peakConnections, sampledPeakSseChannels: peakChannels,
          httpStatuses: statuses, networkFailures, readerFailures, metricFailures,
          totalBeforeCleanupMs: Math.round(performance.now() - globalStart)
        } : {})
      }));
    }
  }
}

try {
  await main();
} catch (error) {
  // Never serialize pg diagnostics, request bodies, environment variables or event identifiers.
  console.error(error instanceof Error && !('severity' in error) ? error.message : 'Local smoke failed; check the dedicated test database and local server.');
  process.exitCode = 1;
}
