import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const pool = new Pool({ connectionString: testUrl, max: 2 });
const ids = [randomUUID(), randomUUID()];
const slugs = ids.map((id) => `support-e2e-${id}`);
const polygon = { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] };

test.beforeAll(async () => {
  for (let i = 0; i < ids.length; i++) {
    await pool.query(`INSERT INTO events
      (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
      VALUES ($1,$2,$3,'75056','Paris',$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
    [ids[i], slugs[i], `Rassemblement fictif avec soutiens ${i + 1}`, polygon]);
  }
});
test.afterAll(async () => {
  try {
    for (const id of ids) {
      for (const table of ['supports', 'support_counters', 'presences', 'event_counters', 'admin_audit']) {
        await pool.query(`DELETE FROM ${table} WHERE event_id=$1`, [id]);
      }
      await pool.query('DELETE FROM events WHERE id=$1', [id]);
    }
  } finally { await pool.end(); }
});

async function counts(id: string) {
  const { rows } = await pool.query<{ presences: string; supports: string }>(`SELECT
    (SELECT count(*)::text FROM presences WHERE event_id=$1) AS presences,
    (SELECT count(*)::text FROM supports WHERE event_id=$1) AS supports`, [id]);
  return { presences: Number(rows[0]!.presences), supports: Number(rows[0]!.supports) };
}

test('remote support needs no GPS or account, increments combined counter, and survives reload', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = () => { throw new Error('Support must not request GPS'); };
  });
  const requests: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/supports')) requests.push(request.postDataJSON() as Record<string, unknown>);
  });
  const before = await counts(ids[0]!);
  await page.goto(`/evenements/${slugs[0]}`);
  await page.getByRole('button', { name: 'Je soutiens à distance', exact: true }).click();
  await expect(page.locator('#support-feedback')).toContainText(/soutien.*compté|soutenez/i);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]!).sort()).toEqual(['anonymousDayId', 'anonymousEventId', 'day', 'protocolVersion']);
  expect(await counts(ids[0]!)).toEqual({ presences: before.presences, supports: before.supports + 1 });
  await expect(page.locator('.counter-number')).toHaveText(new Intl.NumberFormat('fr-FR').format(before.presences + before.supports + 1));
  await expect(page.locator('.counter-caption')).toContainText('soutiens');
  await expect(page.locator('.counter-breakdown')).toContainText('distance');
  await page.reload();
  await page.getByRole('button', { name: /Vérifier mon soutien/i }).click();
  await expect(page.locator('#support-feedback')).toContainText(/déjà|soutenez|enregistré/i);
  expect(requests).toHaveLength(1);
  expect((await counts(ids[0]!)).supports).toBe(before.supports + 1);
  const combinedNational = await page.locator('.national-count > strong').textContent();
  await expect.poll(async () => {
    await page.goto('/');
    return page.locator('.counter-number').textContent();
  }, { timeout: 10_000 }).toBe(combinedNational);
  await expect(page.locator('.counter-breakdown')).toContainText('soutiens à distance');
});

test('one browser cannot support a second event on the same Paris day', async ({ page }) => {
  const before = await counts(ids[1]!);
  await page.goto(`/evenements/${slugs[0]}`);
  await page.getByRole('button', { name: 'Je soutiens à distance', exact: true }).click();
  await expect(page.locator('#support-feedback')).toContainText(/soutien.*compté|soutenez/i);
  await page.goto(`/evenements/${slugs[1]}`);
  await page.getByRole('button', { name: 'Je soutiens à distance', exact: true }).click();
  await expect(page.locator('#support-feedback')).toContainText(/déjà soutenu|un seul événement|autre événement/i);
  expect(await counts(ids[1]!)).toEqual(before);
});

test('joining on site replaces remote support without inflating the combined count', async ({ page, context }) => {
  const before = await counts(ids[0]!);
  await page.goto(`/evenements/${slugs[0]}`);
  await page.getByRole('button', { name: 'Je soutiens à distance', exact: true }).click();
  await expect(page.locator('#support-feedback')).toContainText(/soutien.*compté|soutenez/i);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 48.865, longitude: 2.365, accuracy: 20 });
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.locator('#participation-feedback')).toContainText('Vous êtes compté');
  expect(await counts(ids[0]!)).toEqual({ presences: before.presences + 1, supports: before.supports });
  await expect(page.locator('.counter-number')).toHaveText(new Intl.NumberFormat('fr-FR').format(before.presences + before.supports + 1));
  await expect(page.locator('.support-button')).toBeDisabled();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('supports-mobile.png'), fullPage: true });
});
