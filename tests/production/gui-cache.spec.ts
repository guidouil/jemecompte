import { test, expect } from '@playwright/test';

test('built private GUI never enters the public offline cache and clears its session on logout', async ({ page, context, request }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    const list: string[] = [];
    Object.defineProperty(window, '__guiCsp', { get: () => list });
    window.addEventListener('securitypolicyviolation', (event) => list.push(event.violatedDirective));
  });
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const response = await page.goto('/gui');
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  const encoded = await request.get('/%67ui');
  expect(encoded.headers()['cache-control']).toContain('no-store');
  await expect(page.locator('.admin-page')).toHaveAttribute('data-enhanced', 'true');
  await page.getByLabel('Mot de passe d’administration', { exact: true }).fill(process.env.TEST_ADMIN_PASSWORD ?? 'e2e-admin-password-local-only');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Se déconnecter', exact: true })).toBeVisible();
  const data = await page.request.get('/gui/__data.json');
  expect(data.headers()['cache-control']).toContain('no-store');
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const entry of await (await caches.open(name)).keys()) urls.push(new URL(entry.url).pathname);
    return urls;
  });
  expect(cached.some((path) => /\/(gui|admin)(\/|$)/.test(path))).toBe(false);
  violations.push(...await page.evaluate(() => (window as unknown as { __guiCsp: string[] }).__guiCsp));
  expect(violations).toEqual([]);
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  await expect(offlinePage.goto('http://127.0.0.1:5176/gui')).rejects.toThrow();
  await offlinePage.close();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connexion', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'jemecompte_gui')).toBe(false);
});
