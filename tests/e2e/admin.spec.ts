import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';

test.use({ viewport: { width: 320, height: 850 } });

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith('_test')) throw new Error('Private management browser tests require a dedicated _test database.');
const pool = new Pool({ connectionString: database, max: 2 });
const password = process.env.TEST_ADMIN_PASSWORD ?? 'e2e-admin-password-local-only';
const batch = randomUUID();
const ids = Array.from({ length: 42 }, () => randomUUID());
const slug = (index: number) => `gui-${batch}-${index}`;
const participantKeys = [randomBytes(32), randomBytes(32)];
const eventName = `Gestion fictive <img src=x onerror=alert(1)> ${batch.slice(0, 8)}`;
const polygon = { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] };

async function login(page: Page, enhanced = true) {
  await page.goto('/gui');
  if (enhanced) await expect(page.locator('.admin-page')).toHaveAttribute('data-enhanced', 'true');
  await page.getByLabel('Mot de passe d’administration', { exact: true }).fill(password);
  const button = page.getByRole('button', { name: 'Se connecter', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: 'Se déconnecter', exact: true })).toBeVisible();
}

async function search(page: Page, query: string) {
  await page.getByLabel('Rechercher par nom, ville ou lien public', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(query);
}

async function remaining(eventId: string) {
  const result = await pool.query<{ events: string; presences: string; counters: string }>(`
    SELECT (SELECT count(*) FROM events WHERE id=$1)::text AS events,
      (SELECT count(*) FROM presences WHERE event_id=$1)::text AS presences,
      (SELECT count(*) FROM event_counters WHERE event_id=$1)::text AS counters`, [eventId]);
  return result.rows[0]!;
}

test.beforeAll(async () => {
  for (let index = 0; index < ids.length; index += 1) {
    await pool.query(`INSERT INTO events
      (id,slug,name,city_code,city_name,geofence,counting_scope,starts_at,ends_at,status,is_test)
      VALUES ($1,$2,$3,'75056','Commune de recette privée',$4,$5,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',$6,$7)`,
    [ids[index], slug(index), index === 0 ? eventName : `Gestion fictive ${batch} ${index}`, polygon,
      index % 2 ? 'city' : 'gathering', index === 0 || index % 3 ? 'published' : 'draft', index % 2 === 0]);
  }
  for (const key of participantKeys) await pool.query(`INSERT INTO presences(event_id,anonymous_event_id,counting_day)
    VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date)`, [ids[0], key]);
  await pool.query(`INSERT INTO event_counters(event_id,counting_day,count,revision)
    VALUES($1,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date,2,2)`, [ids[0]]);
});

test.afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit WHERE event_id=ANY($1::uuid[])', [ids]);
    await pool.query("DELETE FROM admin_audit WHERE configuration->>'deletedEventId'=ANY($1::text[])", [ids]);
    await pool.query('DELETE FROM presences WHERE event_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM event_counters WHERE event_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM events WHERE id=ANY($1::uuid[])', [ids]);
  } finally { await pool.end(); }
});

test('private management authenticates, searches, paginates and deletes only after an exact public-slug confirmation', async ({ page, request }) => {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('http://localhost:5175/gui');
  await expect(page).toHaveURL('http://127.0.0.1:5175/gui');
  await expect(page.locator('.admin-page')).toHaveAttribute('data-enhanced', 'true');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('.primary-nav a[href="/gui"]')).toHaveCount(0);
  await expect(page.locator('.admin-events')).toHaveCount(0);
  await page.getByLabel('Mot de passe d’administration', { exact: true }).fill('incorrect-e2e-password');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Mot de passe incorrect');
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeEnabled();
  await page.getByLabel('Mot de passe d’administration', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Se déconnecter', exact: true })).toBeVisible();
  const cookie = (await page.context().cookies()).find((item) => item.name === 'jemecompte_gui');
  expect(Boolean(cookie)).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.path).toBe('/gui');

  await search(page, batch);
  await expect(page.locator('.admin-events > li')).toHaveCount(40);
  await page.getByRole('link', { name: 'Page suivante →', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  await expect(page.locator('.admin-events > li')).toHaveCount(2);
  await page.getByRole('link', { name: '← Page précédente', exact: true }).click();
  await expect(page.locator('.admin-events > li')).toHaveCount(40);
  await search(page, slug(0));
  const card = page.locator('.admin-event').filter({ has: page.getByRole('heading', { name: eventName, exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.admin-badges')).toContainText('Test');
  await expect(card.locator('.admin-badges')).toContainText('Rassemblement localisé');
  await expect(card.locator('.admin-counts dd')).toHaveText(['2', '2']);
  await expect(card.locator('h3 img')).toHaveCount(0);
  const html = await page.content();
  for (const key of participantKeys) {
    expect(html).not.toContain(key.toString('base64url'));
    expect(html).not.toContain(key.toString('hex'));
  }
  expect((await request.get(`/evenements/${slug(0)}`)).status()).toBe(200);
  expect(await remaining(ids[0]!)).toEqual({ events: '1', presences: '2', counters: '1' });
  await card.locator('summary').click();
  await expect(card.getByText(/Cette action est définitive/)).toBeVisible();
  await expect(card.getByText(/toutes ses participations et ses compteurs/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: '/tmp/jemecompte-gui-mobile-320.png', fullPage: true });
  const confirmation = card.getByLabel('Recopiez exactement le lien public pour confirmer', { exact: true });
  await confirmation.fill('wrong-public-slug');
  await card.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('texte de confirmation ne correspond pas');
  await expect(confirmation).toHaveValue('wrong-public-slug');
  await expect(card.locator('details')).toHaveJSProperty('open', true);
  expect(await remaining(ids[0]!)).toEqual({ events: '1', presences: '2', counters: '1' });
  await confirmation.fill(slug(0));
  await card.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
  await expect(page.locator('.admin-success')).toContainText('toutes ses participations et ses compteurs ont été supprimés');
  await expect(card).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('q')).toBe(slug(0));
  expect(await remaining(ids[0]!)).toEqual({ events: '0', presences: '0', counters: '0' });
  expect((await request.get(`/evenements/${slug(0)}`)).status()).toBe(404);
  expect(dialogs).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
  await expect(page.locator('.admin-events')).toHaveCount(0);
  expect((await page.context().cookies()).some((item) => item.name === 'jemecompte_gui')).toBe(false);
});

test('private login distinguishes refused, expired and limited requests from connection errors', async ({ page }) => {
  const cases = [
    { status: 403, body: { message: 'Refus simulé avant action.' }, message: 'La requête a été refusée. Rechargez cette page avant de réessayer.' },
    { status: 403, body: { type: 'error', status: 403, error: { message: 'Refus simulé.' } }, message: 'La requête a été refusée. Rechargez cette page avant de réessayer.' },
    { status: 401, body: { type: 'error', status: 401, error: { message: 'Session simulée expirée.' } }, message: 'Votre session a expiré. Rechargez cette page pour vous reconnecter.' },
    { status: 429, body: { type: 'error', status: 429, error: { message: 'Limite simulée.' } }, message: 'Trop de demandes. Patientez avant de réessayer.' },
    { status: 503, body: { type: 'error', status: 503, error: { message: 'Panne simulée.' } }, message: 'La réponse n’est pas arrivée. Vérifiez votre connexion puis réessayez.' }
  ];
  let intercepted = 0;
  await page.route((url) => url.pathname === '/gui' && url.searchParams.has('/login'), async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const current = cases[intercepted++]!;
    await route.fulfill({ status: current.status, json: current.body });
  });
  await page.goto('/gui');
  await expect(page.locator('.admin-page')).toHaveAttribute('data-enhanced', 'true');
  const input = page.getByLabel('Mot de passe d’administration', { exact: true });
  await input.fill('fixture-intercepted-without-authentication');
  for (const current of cases) {
    const submit = page.getByRole('button', { name: 'Se connecter', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator('.admin-error')).toHaveText(current.message);
    await expect(submit).toBeEnabled();
    await expect(input).toHaveValue('fixture-intercepted-without-authentication');
  }
  expect(intercepted).toBe(cases.length);
  expect((await page.context().cookies()).some((item) => item.name === 'jemecompte_gui')).toBe(false);
  await expect(page.locator('.admin-events')).toHaveCount(0);
});

test.describe('native private forms', () => {
  test.use({ javaScriptEnabled: false });

  test('login, inline confirmation failure and permanent deletion work without JavaScript', async ({ page }) => {
    await login(page, false);
    await search(page, slug(41));
    let card = page.locator('.admin-event');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.admin-badges')).toContainText('Réel');
    await expect(card.locator('.admin-badges')).toContainText('Commune entière');
    await card.locator('summary').click();
    await card.getByLabel('Recopiez exactement le lien public pour confirmer', { exact: true }).fill('wrong-native-slug');
    await card.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('texte de confirmation ne correspond pas');
    card = page.locator('.admin-event');
    await expect(card.locator('details')).toHaveJSProperty('open', true);
    const confirmation = card.getByLabel('Recopiez exactement le lien public pour confirmer', { exact: true });
    await expect(confirmation).toHaveValue('wrong-native-slug');
    await confirmation.fill(slug(41));
    await card.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
    await expect(page.locator('.admin-success')).toContainText('toutes ses participations et ses compteurs ont été supprimés');
    expect(await remaining(ids[41]!)).toEqual({ events: '0', presences: '0', counters: '0' });
    await expect(page.locator('.admin-events')).toHaveCount(0);
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
  });
});
