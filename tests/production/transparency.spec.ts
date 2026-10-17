import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('transparency explains its limits, publishes bounded metadata and fits a narrow screen', async ({ page, request }) => {
  const external: string[] = [];
  page.on('request', req => { if (new URL(req.url()).origin !== 'http://127.0.0.1:5176') external.push(req.url()); });
  await page.setViewportSize({width:320,height:850});
  const response = await page.goto('/transparence');
  expect(response?.headers()['cache-control']).toContain('no-store');
  await expect(page.getByRole('heading',{name:'Vérifier ce qui est publié',exact:true})).toBeVisible();
  await expect(page.getByText(/ne certifie pas la base de données/)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  expect(external).toEqual([]);
  const version = await request.get('/api/version');
  expect(version.headers()['cache-control']).toContain('no-store');
  const metadata = await version.json();
  expect(metadata.build.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(metadata.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(metadata.runtime.configuration).sort()).toEqual(['admissionDifficulty','counterEpoch','origin','realEventsApproved']);
  expect(JSON.stringify(metadata)).not.toMatch(/DATABASE_URL|ADMIN_SESSION_SECRET|ADMISSION_SECRET|anonymousEventId|nonceHash/);
  await page.screenshot({path:test.info().outputPath('transparency-mobile.png'),fullPage:true});
});
