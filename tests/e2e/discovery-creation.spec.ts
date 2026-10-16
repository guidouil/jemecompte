import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { distanceMeters, type GeoPoint } from '../../src/lib/shared/geo';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('Creation browser tests require a dedicated TEST_DATABASE_URL ending in _test.');
}
const pool = new Pool({ connectionString: testUrl, max: 2 });
const createdEventIds = new Set<string>();
const discoveryId = randomUUID();
const discoveryName = `Découverte fictive ${discoveryId.slice(0, 8)}`;
const publicCenter = [2.365, 48.865] as const;
const privateFix = { latitude: 48.865987, longitude: 2.366234, accuracy: 20 };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

interface CreationBody {
  requestId: string;
  name: string;
  cityCode: string;
  cityName: string;
  publicCenter: [number, number];
  radiusMeters: number;
  durationMinutes: number;
  publicLocationConfirmed: true;
  startsAt?: string;
}

interface ScheduleInput { date: string; time: string; utc: string }

function parisInput(instant: Date): ScheduleInput {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`, utc: instant.toISOString() };
}

function futureParisAfternoon(): ScheduleInput {
  // Independent browser expectation; safe afternoon, avoiding the DST gap/repeated hour.
  const reference = new Date(Date.now() + 3 * 86_400_000);
  reference.setUTCHours(12, 0, 0, 0);
  const date = parisInput(reference).date;
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', timeZoneName: 'longOffset'
  }).formatToParts(reference).find((part) => part.type === 'timeZoneName')!.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!match) throw new Error('Expected an explicit modern Europe/Paris UTC offset.');
  const offsetMinutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  const utc = new Date(Date.parse(`${date}T14:30:00.000Z`) - offsetMinutes * 60_000).toISOString();
  return { date, time: '14:30', utc };
}

function recentUnambiguousParisStart(): ScheduleInput {
  for (const hoursAgo of [2, 1, 3]) {
    const instant = new Date(Date.now() - hoursAgo * 3_600_000);
    instant.setUTCSeconds(0, 0);
    const input = parisInput(instant);
    const sameWallTime = (other: Date) => {
      const parts = parisInput(other);
      return parts.date === input.date && parts.time === input.time;
    };
    if (!sameWallTime(new Date(instant.getTime() - 3_600_000)) && !sameWallTime(new Date(instant.getTime() + 3_600_000))) return input;
  }
  throw new Error('Expected an unambiguous recent Paris start.');
}

function reviewField(page: Page, label: string) {
  return page.locator('dl.review > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
}

async function removeOwnEvent(id: string): Promise<void> {
  await pool.query('DELETE FROM admin_audit WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM presences WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM event_counters WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM events WHERE id=$1', [id]);
}

async function presenceCount(id: string): Promise<number> {
  const result = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM presences WHERE event_id=$1', [id]);
  return Number(result.rows[0]?.total ?? '0');
}

async function observeGeolocation(page: Page): Promise<void> {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(privateFix);
  await page.addInitScript(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    let calls = 0;
    Object.defineProperty(window, '__creationGeoCalls', { get: () => calls });
    navigator.geolocation.getCurrentPosition = (...args) => { calls += 1; return original(...args); };
  });
}

async function geoCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __creationGeoCalls: number }).__creationGeoCalls);
}

async function mockPublicMapProviders(page: Page): Promise<void> {
  await page.route('**/api/places?**', (route) => route.fulfill({
    json: { places: [{ code: '75056', name: 'Paris', center: [...publicCenter] }] }
  }));
  await page.route('**/api/map/tiles/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
}

async function expectCompleteZoneVisible(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.creation-map').evaluate((container) => {
    const outline = container.querySelector('svg path');
    if (!outline) return false;
    const mapBounds = container.getBoundingClientRect();
    const zoneBounds = outline.getBoundingClientRect();
    return zoneBounds.width > 20 && zoneBounds.height > 20 &&
      zoneBounds.left >= mapBounds.left && zoneBounds.top >= mapBounds.top &&
      zoneBounds.right <= mapBounds.right && zoneBounds.bottom <= mapBounds.bottom;
  })).toBe(true);
}

async function chooseCreationPlace(page: Page, mapClick = false): Promise<void> {
  await page.goto('/creer');
  await expect(page.getByRole('heading', { name: 'Choisissez un lieu public' })).toBeVisible();
  await page.getByLabel('Ville du rassemblement').fill('Paris');
  await page.getByRole('button', { name: 'Chercher', exact: true }).click();
  await page.getByRole('button', { name: /^Paris Code commune 75056/ }).click();
  const placeAtCenter = page.getByRole('button', { name: /Placer la zone au centre de la carte/ });
  await expect(placeAtCenter).toBeEnabled();
  if (mapClick) await page.locator('.creation-map').click({ position: { x: 100, y: 160 } });
  else await placeAtCenter.click();
  await expect(page.getByText(/Zone sélectionnée à Paris/)).toBeVisible();
  await page.getByRole('button', { name: /^Continuer/ }).click();
}

async function setSchedule(page: Page, schedule: ScheduleInput): Promise<void> {
  await page.getByRole('radio', { name: 'Choisir la date et l’heure', exact: true }).check();
  await page.getByLabel('Date de début', { exact: true }).fill(schedule.date);
  await page.getByLabel('Heure de début', { exact: true }).fill(schedule.time);
}

async function prepareCreation(
  page: Page,
  name: string,
  mapClick = false,
  radiusMeters = 750,
  checkInvalidRadii = false,
  durationMinutes = 240,
  schedule?: ScheduleInput
): Promise<void> {
  await chooseCreationPlace(page, mapClick);
  await page.getByLabel('Nom public du rassemblement').fill(name);
  const radius = page.getByLabel('Rayon autour du lieu');
  const verify = page.getByRole('button', { name: /^Vérifier le comptage/ });
  await expect(radius).toHaveValue('500');
  await expect(radius).toHaveAttribute('min', '100');
  await expect(radius).toHaveAttribute('max', '10000');
  await expect(radius).toHaveAttribute('step', '1');
  if (checkInvalidRadii) {
    await radius.fill('10001');
    await expect(verify).toBeDisabled();
    await radius.fill('99');
    await expect(verify).toBeDisabled();
    // Native number inputs sanitize a non-number to an empty value/valueAsNumber NaN.
    await radius.evaluate((input: HTMLInputElement) => {
      input.value = 'NaN';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await radius.evaluate((input: HTMLInputElement) => Number.isNaN(input.valueAsNumber))).toBe(true);
    await expect(verify).toBeDisabled();
    await radius.fill('');
    await expect(verify).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Délimitez le comptage' })).toBeVisible();
    await radius.fill('100');
    await expect(verify).toBeEnabled();
  }
  await radius.fill(String(radiusMeters));
  await expect(verify).toBeEnabled();
  const duration = page.getByLabel('Durée du comptage', { exact: true });
  await expect(duration).toHaveValue('240');
  expect(await duration.locator('option').allTextContents()).toEqual([
    '1 heure', '2 heures', '4 heures', '8 heures', '12 heures', '24 heures', '48 heures', '72 heures'
  ]);
  if (durationMinutes !== 240) await duration.selectOption(String(durationMinutes));
  await expect(page.getByRole('radio', { name: 'Maintenant', exact: true })).toBeChecked();
  if (schedule) await setSchedule(page, schedule);
  await verify.click();
  await expect(page.getByRole('heading', { name: 'Vérifiez avant de publier' })).toBeVisible();
  await expect(reviewField(page, 'Durée')).toContainText(`${durationMinutes / 60} heure${durationMinutes > 60 ? 's' : ''}`);
  await expect(page.getByText(radiusMeters === 10_000
    ? /^Cercle de (?:10[\s\u202f]?000 mètres|10 km) de rayon$/
    : `Cercle de ${radiusMeters} mètres de rayon`, { exact: true })).toBeVisible();
  await expectCompleteZoneVisible(page);
  await expect(page.getByRole('button', { name: /^Créer le comptage/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Je confirme que cette zone correspond/ }).check();
  await expect(page.getByRole('button', { name: /^Créer le comptage/ })).toBeEnabled();
}

test.beforeAll(async () => {
  await pool.query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,$3,'75056','Paris',$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
  [discoveryId, `discovery-${discoveryId}`, discoveryName,
    { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] }]);
});

test.afterEach(async () => {
  for (const id of createdEventIds) await removeOwnEvent(id);
  createdEventIds.clear();
});

test.afterAll(async () => {
  await removeOwnEvent(discoveryId);
  await pool.end();
});

test('creates a public map zone without GPS or a presence, then requires an explicit count action', async ({ page }) => {
  await observeGeolocation(page);
  await mockPublicMapProviders(page);
  const creations: CreationBody[] = [];
  const submissions: Record<string, unknown>[] = [];
  const urls: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
    if (request.url().endsWith('/api/events/create') && request.method() === 'POST') {
      const body = request.postDataJSON() as CreationBody;
      creations.push(body);
      createdEventIds.add(body.requestId);
    }
    if (request.url().endsWith('/presences')) submissions.push(request.postDataJSON() as Record<string, unknown>);
  });
  const name = `Recette création ${randomUUID().slice(0, 8)}`;
  await prepareCreation(page, name, false, 750, true, 60);
  expect(creations).toEqual([]);
  expect(submissions).toEqual([]);
  expect(await geoCalls(page)).toBe(0);

  const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/events/create'));
  await page.getByRole('button', { name: /^Créer le comptage/ }).click();
  expect((await createdResponse).status()).toBe(201);
  await expect(page).toHaveURL(/\/evenements\//);
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  expect(creations).toHaveLength(1);
  const body = creations[0]!;
  expect(Object.keys(body).sort()).toEqual([
    'cityCode', 'cityName', 'durationMinutes', 'name', 'publicCenter', 'publicLocationConfirmed', 'radiusMeters', 'requestId'
  ]);
  expect(body).toMatchObject({ name, cityCode: '75056', cityName: 'Paris', publicCenter: [...publicCenter],
    radiusMeters: 750, durationMinutes: 60, publicLocationConfirmed: true });
  expect(body.publicCenter).not.toEqual([privateFix.longitude, privateFix.latitude]);
  expect(await geoCalls(page)).toBe(0);
  expect(await presenceCount(body.requestId)).toBe(0);
  expect(submissions).toEqual([]);
  const row = await pool.query<{ is_test: boolean; creation_source: string; duration: string }>(`
    SELECT is_test, creation_source, EXTRACT(EPOCH FROM ends_at-starts_at)::text AS duration
    FROM events WHERE id=$1`, [body.requestId]);
  expect(row.rows[0]).toMatchObject({ is_test: true, creation_source: 'community' });
  expect(Number(row.rows[0]?.duration)).toBe(3_600);

  await page.context().setGeolocation({ latitude: publicCenter[1], longitude: publicCenter[0], accuracy: 20 });
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect(await presenceCount(body.requestId)).toBe(1);
  expect(submissions).toHaveLength(1);
  expect(Object.keys(submissions[0]!).sort()).toEqual(['anonymousEventId', 'geofenceVersion', 'insideZone', 'protocolVersion']);
  const sent = JSON.stringify({ creations, submissions, urls });
  expect(sent).not.toContain(String(privateFix.longitude));
  expect(sent).not.toContain(String(privateFix.latitude));
});

test('retries a creation response lost after commit using the same requestId and a single event', async ({ page }) => {
  await observeGeolocation(page);
  await mockPublicMapProviders(page);
  const bodies: CreationBody[] = [];
  let first = true;
  await page.route('**/api/events/create', async (route) => {
    const body = route.request().postDataJSON() as CreationBody;
    bodies.push(body);
    createdEventIds.add(body.requestId);
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  const schedule = futureParisAfternoon();
  await prepareCreation(page, `Reprise création ${randomUUID().slice(0, 8)}`, true, 10_000, false, 4_320, schedule);
  await page.getByRole('button', { name: /^Créer le comptage/ }).click();
  await expect(page.getByText(/La confirmation n’est pas arrivée\. Réessayez ici/)).toBeVisible();
  expect(bodies).toHaveLength(1);
  const id = bodies[0]!.requestId;
  expect(bodies[0]!.radiusMeters).toBe(10_000);
  expect(bodies[0]!.durationMinutes).toBe(4_320);
  expect(bodies[0]!.startsAt).toBe(schedule.utc);
  const stored = await pool.query<{ geofence: { coordinates: [GeoPoint[]] }; starts_at: Date; elapsed_seconds: string }>(
    'SELECT geofence, starts_at, EXTRACT(EPOCH FROM (ends_at-starts_at))::text AS elapsed_seconds FROM events WHERE id=$1', [id]
  );
  expect(stored.rowCount).toBe(1);
  expect(stored.rows[0]!.starts_at.toISOString()).toBe(schedule.utc);
  expect(Number(stored.rows[0]!.elapsed_seconds)).toBe(72 * 3_600);
  const firstVertex = stored.rows[0]!.geofence.coordinates[0][0]!;
  expect(distanceMeters(bodies[0]!.publicCenter, firstVertex)).toBeCloseTo(10_000, 2);
  expect(await presenceCount(id)).toBe(0);
  const retryResponse = page.waitForResponse((response) => response.url().endsWith('/api/events/create'));
  await page.getByRole('button', { name: /^Réessayer la création/ }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/evenements\//);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect((await pool.query('SELECT 1 FROM events WHERE id=$1', [id])).rowCount).toBe(1);
  expect(await presenceCount(id)).toBe(0);
  expect(await geoCalls(page)).toBe(0);
});

test.describe('explicit Paris scheduling', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('publishes a future four-hour event in Paris time without GPS or counting before opening', async ({ page }) => {
    await observeGeolocation(page);
    await mockPublicMapProviders(page);
    const creations: CreationBody[] = [];
    const participationRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/events/create' && request.method() === 'POST') {
        const body = request.postDataJSON() as CreationBody;
        creations.push(body);
        createdEventIds.add(body.requestId);
      }
      if (/\/presences$|\/presence-status$/.test(path)) participationRequests.push(path);
    });
    const schedule = futureParisAfternoon();
    const name = `Horaire Paris ${randomUUID().slice(0, 8)}`;
    await prepareCreation(page, name, false, 500, false, 240, schedule);
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/Los_Angeles');
    await expect(reviewField(page, 'Début')).toContainText('14:30');
    await expect(reviewField(page, 'Fin')).toContainText('18:30');
    await expect(reviewField(page, 'Durée')).toContainText('4 heures');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await geoCalls(page)).toBe(0);
    expect(creations).toEqual([]);

    const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/events/create'));
    await page.getByRole('button', { name: /^Créer le comptage/ }).click();
    expect((await createdResponse).status()).toBe(201);
    await expect(page).toHaveURL(/\/evenements\//);
    await expect(page.getByRole('button', { name: 'BIENTÔT OUVERT', exact: true })).toBeDisabled();
    expect(creations).toHaveLength(1);
    const body = creations[0]!;
    expect(Object.keys(body).sort()).toEqual([
      'cityCode', 'cityName', 'durationMinutes', 'name', 'publicCenter', 'publicLocationConfirmed',
      'radiusMeters', 'requestId', 'startsAt'
    ]);
    expect(body).toMatchObject({ name, publicCenter: [...publicCenter], radiusMeters: 500,
      durationMinutes: 240, startsAt: schedule.utc, publicLocationConfirmed: true });
    const stored = await pool.query<{ starts_at: Date; ends_at: Date }>(
      'SELECT starts_at,ends_at FROM events WHERE id=$1', [body.requestId]
    );
    expect(stored.rows[0]!.starts_at.toISOString()).toBe(schedule.utc);
    expect(stored.rows[0]!.ends_at.getTime() - stored.rows[0]!.starts_at.getTime()).toBe(4 * 3_600_000);
    expect(await presenceCount(body.requestId)).toBe(0);

    await page.goto('/#rassemblements');
    await page.getByLabel('Nom ou ville').fill(name);
    await page.getByLabel('Quand ?', { exact: true }).selectOption('upcoming');
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    expect(await geoCalls(page)).toBe(0);
    expect(participationRequests).toEqual([]);
    expect(await presenceCount(body.requestId)).toBe(0);
    expect(JSON.stringify(creations)).not.toContain(String(privateFix.latitude));
    expect(JSON.stringify(creations)).not.toContain(String(privateFix.longitude));
  });

  test('rejects a finished schedule while accepting a past start whose four-hour window remains open', async ({ page, request }) => {
    await observeGeolocation(page);
    await mockPublicMapProviders(page);
    const creations: CreationBody[] = [];
    const participationRequests: string[] = [];
    page.on('request', (browserRequest) => {
      const path = new URL(browserRequest.url()).pathname;
      if (path === '/api/events/create' && browserRequest.method() === 'POST') {
        const body = browserRequest.postDataJSON() as CreationBody;
        creations.push(body);
        createdEventIds.add(body.requestId);
      }
      if (/\/presences$|\/presence-status$/.test(path)) participationRequests.push(path);
    });
    await chooseCreationPlace(page);
    const name = `Début passé ${randomUUID().slice(0, 8)}`;
    await page.getByLabel('Nom public du rassemblement').fill(name);
    await expect(page.getByLabel('Durée du comptage', { exact: true })).toHaveValue('240');
    const expiredStart = new Date(Date.now() - 2 * 86_400_000);
    expiredStart.setUTCHours(12, 0, 0, 0);
    const expired = parisInput(expiredStart);
    await setSchedule(page, expired);
    await expect(page.getByRole('button', { name: /^Vérifier le comptage/ })).toBeDisabled();
    await expect(page.getByText(/le comptage serait déjà terminé/)).toBeVisible();
    expect(creations).toEqual([]);
    const rejectedId = randomUUID();
    createdEventIds.add(rejectedId);
    const expiredResponse = await request.post('/api/events/create', {
      headers: { Origin: 'http://127.0.0.1:5175' },
      data: { requestId: rejectedId, name, cityCode: '75056', cityName: 'Paris',
        publicCenter: [...publicCenter], radiusMeters: 500, durationMinutes: 240,
        publicLocationConfirmed: true, startsAt: expired.utc }
    });
    expect(expiredResponse.status()).toBe(400);
    expect(await expiredResponse.json()).toEqual({ status: 'invalid_schedule' });
    expect((await pool.query('SELECT 1 FROM events WHERE id=$1', [rejectedId])).rowCount).toBe(0);

    const stillOpen = recentUnambiguousParisStart();
    await setSchedule(page, stillOpen);
    await expect(page.getByRole('button', { name: /^Vérifier le comptage/ })).toBeEnabled();
    await page.getByRole('button', { name: /^Vérifier le comptage/ }).click();
    await expect(reviewField(page, 'Durée')).toContainText('4 heures');
    await expect(page.getByText(/sera déjà en cours à sa création/)).toBeVisible();
    await page.getByRole('checkbox', { name: /Je confirme que cette zone correspond/ }).check();
    const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/events/create'));
    await page.getByRole('button', { name: /^Créer le comptage/ }).click();
    expect((await createdResponse).status()).toBe(201);
    await expect(page).toHaveURL(/\/evenements\//);
    await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toBeEnabled();
    expect(creations).toHaveLength(1);
    expect(creations[0]!).toMatchObject({ durationMinutes: 240, startsAt: stillOpen.utc });
    const id = creations[0]!.requestId;
    const stored = await pool.query<{ starts_at: Date; ends_at: Date }>(
      'SELECT starts_at,ends_at FROM events WHERE id=$1', [id]
    );
    expect(stored.rows[0]!.starts_at.toISOString()).toBe(stillOpen.utc);
    expect(stored.rows[0]!.ends_at.getTime() - stored.rows[0]!.starts_at.getTime()).toBe(4 * 3_600_000);
    expect(await presenceCount(id)).toBe(0);
    expect(await geoCalls(page)).toBe(0);
    expect(participationRequests).toEqual([]);
  });
});

test('discovery filters and proximity use one local fix without sending it or creating a presence', async ({ page }) => {
  await observeGeolocation(page);
  const sent: { url: string; body: string | null }[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) sent.push({ url: request.url(), body: request.postData() });
  });
  await page.goto('/');
  await page.getByLabel('Nom ou ville').fill(discoveryName);
  await expect(page.getByRole('link', { name: new RegExp(discoveryName) })).toBeVisible();
  expect(await geoCalls(page)).toBe(0);
  await page.getByRole('button', { name: /^Autour de moi/ }).click();
  await expect(page.getByText(/Recherche de proximité activée/)).toBeVisible();
  expect(await geoCalls(page)).toBe(1);
  await expect(page.getByRole('link', { name: new RegExp(discoveryName) })).toBeVisible();
  await page.getByRole('button', { name: 'Ne plus utiliser ma position' }).click();
  await expect(page.getByText(/La position n’est plus utilisée/)).toBeVisible();
  const network = JSON.stringify(sent);
  expect(network).not.toContain(String(privateFix.longitude));
  expect(network).not.toContain(String(privateFix.latitude));
  expect(sent.some((entry) => /\/presences|\/presence-status|\/events\/create/.test(entry.url))).toBe(false);
  expect(await presenceCount(discoveryId)).toBe(0);
});
