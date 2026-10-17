import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CounterSnapshot, ParticipationReply } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const pool = new Pool({ connectionString: testUrl, max: 2 });
const eventId = randomUUID();
const slug = `recovery-${eventId}`;

async function total() {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [eventId]);
  return Number(result.rows[0]?.count ?? '0');
}

async function trackGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 48.865, longitude: 2.365, accuracy: 20 });
  await page.addInitScript(() => {
    let calls = 0;
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    Object.defineProperty(window, '__geoCalls', { get: () => calls });
    navigator.geolocation.getCurrentPosition = (...args) => {
      calls += 1;
      if (sessionStorage.getItem('deny-gps') === 'true') {
        args[1]?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        return;
      }
      return original(...args);
    };
  });
}

async function geolocationCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls);
}

test.beforeAll(async () => {
  await pool.query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,'Recette fictive de récupération','75056','Paris',$3,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
    [eventId, slug, { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] }]);
});

test.afterAll(async () => {
  await pool.query('DELETE FROM presences WHERE event_id=$1', [eventId]);
  await pool.query('DELETE FROM event_counters WHERE event_id=$1', [eventId]);
  await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
  await pool.end();
});

test('recovers an open-event confirmation after reload without GPS or a new submission', async ({ page }) => {
  await trackGeolocation(page);
  await page.goto(`/evenements/${slug}`);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  const before = await total();
  await page.evaluate(() => sessionStorage.setItem('deny-gps', 'true'));
  await page.reload();

  const submissions: string[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/presences')) submissions.push(request.url()); });
  let releaseStatus: () => void = () => {};
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  await page.route(`**/api/events/${eventId}/presence-status`, async (route) => {
    await statusGate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Vérifier ma participation', exact: true }).click();
  try {
    await expect(page.getByRole('button', { name: 'Vérification de ma participation…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'VÉRIFICATION EN COURS…', exact: true })).toBeDisabled();
    expect(await geolocationCalls(page)).toBe(0);
  } finally {
    releaseStatus();
  }
  await expect(page.locator('#participation-feedback')).toContainText('déjà compté');
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeDisabled();
  expect(await geolocationCalls(page)).toBe(0);
  expect(submissions).toEqual([]);
  expect(await total()).toBe(before);
});

test('a missing confirmation can be checked again and still requires an explicit GPS count', async ({ page }) => {
  await trackGeolocation(page);
  const before = await total();
  const submissions: string[] = [];
  const statusBodies: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/presences')) submissions.push(request.url());
    if (request.url().endsWith('/presence-status')) statusBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.goto(`/evenements/${slug}`);
  const verifyButton = page.getByRole('button', { name: 'Vérifier ma participation', exact: true });
  for (let index = 0; index < 2; index += 1) {
    await verifyButton.click();
    await expect(page.locator('#participation-feedback')).toContainText('Aucune participation confirmée');
    await expect(verifyButton).toBeEnabled();
  }
  expect(await geolocationCalls(page)).toBe(0);
  expect(submissions).toEqual([]);
  expect(statusBodies).toHaveLength(2);
  expect(statusBodies.every((body) => Object.keys(body).join(',') === 'anonymousEventId')).toBe(true);
  expect(await total()).toBe(before);

  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect(await geolocationCalls(page)).toBe(1);
  expect(submissions).toHaveLength(1);
  expect(await total()).toBe(before + 1);
});

test('shows the server update time in Paris and keeps an old-number warning until a fresh snapshot arrives', async ({ page, context, request }) => {
  await page.addInitScript(() => {
    const sources: ControlledEventSource[] = [];
    class ControlledEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() {
        super();
        sources.push(this);
        queueMicrotask(() => { if (!this.closed) this.onopen?.(new Event('open')); });
      }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { value: ControlledEventSource });
    Object.defineProperty(window, '__counterConnections', { get: () => sources.length });
    Object.defineProperty(window, '__emitCounter', { value: (snapshot: unknown) => {
      for (const source of sources) {
        if (!source.closed) source.dispatchEvent(new MessageEvent('counters', { data: JSON.stringify(snapshot) }));
      }
    } });
  });
  await page.goto(`/evenements/${slug}`);
  await expect(page.locator('.counter-footnote')).toContainText('Compteur connecté');
  const response = await request.get(`/api/events/${eventId}/counters`);
  expect(response.ok()).toBe(true);
  const current = await response.json() as CounterSnapshot;
  const oldSnapshot = { ...current, epoch: (BigInt(current.epoch) + 1n).toString(), serverTime: new Date(Date.now() - 125_000).toISOString() };
  const emit = (snapshot: CounterSnapshot) => page.evaluate((value) => {
    (window as unknown as { __emitCounter: (next: CounterSnapshot) => void }).__emitCounter(value);
  }, snapshot);
  await emit(oldSnapshot);
  const updated = page.locator('.counter-updated');
  await expect(updated.locator('time')).toHaveAttribute('datetime', oldSnapshot.serverTime);
  await expect(updated.locator('time')).toHaveText(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(oldSnapshot.serverTime)));
  await expect(updated).toContainText('il y a 2 min');
  await expect(page.locator('.counter-stale-warning')).toBeVisible();
  await expect(page.locator('.counter-footnote')).toContainText('Chiffre ancien');

  await context.setOffline(true);
  await expect(page.locator('.counter-footnote')).toContainText('Hors ligne');
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __counterConnections: number }).__counterConnections)).toBe(2);
  await expect(page.locator('.counter-stale-warning')).toBeVisible();
  await expect(page.locator('.counter-footnote')).toContainText('Chiffre ancien');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);

  const freshSnapshot = { ...oldSnapshot, serverTime: new Date().toISOString() };
  await emit(freshSnapshot);
  await expect(updated.locator('time')).toHaveAttribute('datetime', freshSnapshot.serverTime);
  await expect(updated).toContainText('moins d’une minute');
  await expect(page.locator('.counter-stale-warning')).toHaveCount(0);
  await expect(page.locator('.counter-footnote')).toContainText('Compteur connecté');
});

test('shows the national gathering total on home after counting while keeping event and city totals separate', async ({ page, request }) => {
  const extraGatheringId = randomUUID();
  const cityId = randomUUID();
  const extraIds = [extraGatheringId, cityId];
  const formatCount = (value: string) => new Intl.NumberFormat('fr-FR').format(BigInt(value));
  try {
    for (const [id, scope] of [[extraGatheringId, 'gathering'], [cityId, 'city']] as const) {
      await pool.query(`INSERT INTO events
        (id,slug,name,city_code,city_name,geofence,counting_scope,starts_at,ends_at,status,is_test)
        VALUES ($1,$2,'Recette fictive du total national','75056','Paris',$3,$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
      [id, `national-${id}`, { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] }, scope]);
    }
    let cityNationalTotal = '';
    for (const [id, scope] of [[extraGatheringId, 'gathering'], [cityId, 'city']] as const) {
      const response = await request.post(`/api/events/${id}/presences`, {
        headers: { Origin: 'http://127.0.0.1:5175' },
        data: await admittedBody(request, 'presence', { anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1, insideZone: true, countingScope: scope }, id)
      });
      expect(response.ok()).toBe(true);
      const reply = await response.json() as ParticipationReply;
      expect(reply.status).toBe('counted');
      expect(reply.snapshot?.countingScope).toBe(scope);
      if (scope === 'city') cityNationalTotal = reply.snapshot!.nationalTotal;
    }

    await trackGeolocation(page);
    const before = await total();
    await page.goto(`/evenements/${slug}`);
    const confirmation = page.waitForResponse((response) => response.url().endsWith(`/api/events/${eventId}/presences`));
    await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
    const reply = await (await confirmation).json() as ParticipationReply;
    expect(reply.status).toBe('counted');
    const snapshot = reply.snapshot!;
    expect(BigInt(snapshot.nationalTotal)).toBeGreaterThan(BigInt(snapshot.total));
    await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
    await expect(page.locator('.counter-number')).toHaveText(formatCount(snapshot.total));
    expect(await total()).toBe(before + 1);

    await page.goto('/');
    const gatherings = page.locator('.counter-column[data-counting-scope="gathering"]');
    const cities = page.locator('.national-count[data-counting-scope="city"]');
    // The national SSR read has a three-second cache, so reload until the accepted write is visible.
    await expect.poll(async () => {
      await page.reload();
      return gatherings.locator('.counter-number').textContent();
    }, { timeout: 10_000 }).toBe(formatCount(snapshot.nationalTotal));
    await expect(page.locator('.counter-number')).toHaveText(formatCount(snapshot.nationalTotal));
    await expect(page.locator('.counter-number')).not.toHaveAttribute('aria-label', 'Aucun comptage sélectionné');
    await expect(page.locator('.counter-heading')).toContainText('RASSEMBLEMENTS LOCALISÉS');
    await expect(page.locator('.counter-caption')).toContainText('participations et soutiens');
    await expect(page.locator('.counter-caption')).toContainText('France');
    await expect(page.locator('.national-count')).toHaveCount(1);
    await expect(cities.locator('strong')).toHaveText(formatCount(cityNationalTotal));
    await expect(page.locator('.national-families-note')).toContainText('Une même personne peut contribuer aux deux familles');
    await expect(page.locator('.counter-footnote')).not.toContainText('après le choix d’un comptage');

    await page.goto(`/evenements/${slug}`);
    await expect(page.locator('.counter-number')).toHaveText(formatCount(snapshot.total));
    await expect(page.locator('.counter-heading')).toContainText('LE COMPTEUR DU RASSEMBLEMENT');
    expect(await total()).toBe(before + 1);
  } finally {
    await pool.query('DELETE FROM presences WHERE event_id=ANY($1::uuid[])', [extraIds]);
    await pool.query('DELETE FROM event_counters WHERE event_id=ANY($1::uuid[])', [extraIds]);
    await pool.query('DELETE FROM events WHERE id=ANY($1::uuid[])', [extraIds]);
  }
});

test('identifies when the home national total was loaded and how to refresh it', async ({ page }) => {
  await page.goto('/');
  const loaded = page.locator('.national-loaded-at');
  await expect(loaded).toContainText('Total chargé le');
  await expect(loaded).toContainText('(heure de Paris). Actualisez la page pour le mettre à jour.');
  const loadedAt = await loaded.locator('time').getAttribute('datetime');
  expect(loadedAt && Number.isFinite(Date.parse(loadedAt))).toBeTruthy();
  await expect(loaded.locator('time')).toHaveText(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(loadedAt!)));
  await expect(page.locator('.counter-updated')).toHaveCount(0);
});
import { admittedBody } from '../helpers/admission';
