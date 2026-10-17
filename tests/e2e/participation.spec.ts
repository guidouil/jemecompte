import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const pool = new Pool({ connectionString: testUrl, max: 3 });
const eventId = randomUUID();
const slug = `e2e-${eventId}`;
const eventName = 'Rassemblement fictif de recette';
const polygon = { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] };

async function insertEvent(id: string, eventSlug: string, name: string) {
  await pool.query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,$3,'75056','Paris',$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
    [id, eventSlug, name, polygon]);
}
async function removeEvent(id: string) {
  await pool.query('DELETE FROM presences WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM event_counters WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM events WHERE id=$1', [id]);
}
async function total() {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [eventId]);
  return Number(result.rows[0]?.count ?? '0');
}
async function openEvent(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 48.865, longitude: 2.365, accuracy: 20 });
  await page.goto(`/evenements/${slug}`);
  await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toBeEnabled();
}

test.beforeAll(async () => { await insertEvent(eventId, slug, eventName); });
test.afterAll(async () => { await removeEvent(eventId); await pool.end(); });

test('one click sends no coordinates and reload keeps the same anonymous identity', async ({ page }) => {
  const before = await total();
  await page.addInitScript(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    let calls = 0;
    Object.defineProperty(window, '__geoCalls', { get: () => calls });
    navigator.geolocation.getCurrentPosition = (...args) => { calls++; return original(...args); };
  });
  const submissions: Record<string, unknown>[] = [];
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/presences')) submissions.push(request.postDataJSON() as Record<string, unknown>);
    if (!request.url().startsWith('http://127.0.0.1:5175/') && !request.url().startsWith('ws://127.0.0.1:5175/')) external.push(request.url());
  });
  await openEvent(page);
  expect(await page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls)).toBe(0);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(Object.keys(submissions[0] ?? {}).sort()).toEqual(['admission', 'anonymousEventId', 'geofenceVersion', 'insideZone', 'protocolVersion']);
  expect(external).toEqual([]);
  expect(await total()).toBe(before + 1);
  await page.reload();
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText('déjà compté');
  expect(submissions[1]?.anonymousEventId).toBe(submissions[0]?.anonymousEventId);
  expect(await total()).toBe(before + 1);
});

test('two tabs initially opened together result in one participation', async ({ page, context }) => {
  const before = await total();
  await openEvent(page);
  const other = await context.newPage();
  await other.goto(`/evenements/${slug}`);
  const firstButton = page.getByRole('button', { name: /^JE ME COMPTE/ });
  const secondButton = other.getByRole('button', { name: /^JE ME COMPTE/ });
  await expect(secondButton).toBeEnabled();
  await Promise.all([firstButton.click(), secondButton.click()]);
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  await expect(other.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect(await total()).toBe(before + 1);
});

test('refused geolocation sends no participation', async ({ page }) => {
  const before = await total();
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_success, failure) => failure?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  });
  await openEvent(page);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText(/autorisation|refus/i);
  expect(await total()).toBe(before);
});

test('outside the zone sends no participation', async ({ page }) => {
  const before = await total();
  await openEvent(page);
  await page.context().setGeolocation({ latitude: 48.84, longitude: 2.28, accuracy: 10 });
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText(/périmètre|zone/);
  expect(await total()).toBe(before);
});

test('ambiguous geofences require an explicit event choice', async ({ page, request }) => {
  const otherId = randomUUID();
  const otherName = 'Second rassemblement fictif';
  await insertEvent(otherId, `e2e-${otherId}`, otherName);
  try {
    await expect.poll(async () => {
      const response = await request.get('/api/events');
      const body = await response.json();
      return body.events?.some((event: { id: string }) => event.id === otherId);
    }, { timeout: 12_000 }).toBe(true);
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 48.865, longitude: 2.365, accuracy: 20 });
    await page.goto('/');
    await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
    await expect(page.getByRole('heading', { name: 'Quel rassemblement ?' })).toBeVisible();
    const before = await total();
    await page.getByRole('button', { name: new RegExp(eventName) }).click();
    await expect(page.locator('#participation-feedback')).toContainText('Vous êtes compté');
    expect(await total()).toBe(before + 1);
  } finally { await removeEvent(otherId); }
});

test('response lost after commit is recovered without incrementing twice', async ({ page }) => {
  const before = await total();
  let first = true;
  await page.route('**/presences', async (route) => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort('failed');
    } else { await route.continue(); }
  });
  await openEvent(page);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText(/confirmation|confirmée/i);
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible({ timeout: 15_000 });
  expect(await total()).toBe(before + 1);
});

test('individual status never creates a presence and coordinate properties are rejected', async ({ request }) => {
  const before = await total();
  const anonymousEventId = randomBytes(32).toString('base64url');
  const headers = { Origin: 'http://127.0.0.1:5175' };
  const status = await request.post(`/api/events/${eventId}/presence-status`, { data: { anonymousEventId }, headers });
  expect(status.status()).toBe(200);
  expect((await status.json()).status).toBe('not_counted');
  const invalid = await request.post(`/api/events/${eventId}/presences`, {
    data: { anonymousEventId, insideZone: true, geofenceVersion: 1, protocolVersion: 1, latitude: 48.865 }, headers
  });
  expect(invalid.status()).toBe(400);
  const foreign = await request.post(`/api/events/${eventId}/presences`, {
    data: { anonymousEventId, insideZone: true, geofenceVersion: 1, protocolVersion: 1 }, headers: { Origin: 'https://elsewhere.example' }
  });
  expect(foreign.status()).toBe(403);
  expect(await total()).toBe(before);
});

test('mobile pages are accessible and contain no horizontal overflow', async ({ page }) => {
  for (const path of [`/evenements/${slug}`, '/comment-ca-marche', '/confidentialite']) {
    await page.goto(path);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
    const headings = await new AxeBuilder({ page }).withRules(['heading-order']).analyze();
    expect(headings.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/evenements/${slug}`);
  expect((await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()).violations).toEqual([]);
});

test('a previously committed participation can be verified after closure without GPS', async ({ page }) => {
  await openEvent(page);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  const before = await total();
  await pool.query("UPDATE events SET status='closed', metadata_version=metadata_version+1 WHERE id=$1", [eventId]);
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = () => { throw new Error('GPS must not be requested for recovery'); };
  });
  await page.reload();
  await expect(page.getByRole('button', { name: /Vérifier si je suis déjà/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Vérifier si je suis déjà/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText('déjà compté');
  expect(await total()).toBe(before);
});
