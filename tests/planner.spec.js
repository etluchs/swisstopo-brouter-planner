import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const leg = JSON.parse(
  readFileSync(new URL('./fixtures/brouter-leg.json', import.meta.url), 'utf-8')
);
const profile = JSON.parse(
  readFileSync(new URL('./fixtures/swisstopo-profile.json', import.meta.url), 'utf-8')
);

// 1x1 transparent PNG used to satisfy tile <img> loads deterministically.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function stubTiles(page, status = 200) {
  await page.route(/wmts\.geo\.admin\.ch/, (r) =>
    status === 200
      ? r.fulfill({ body: PNG, contentType: 'image/png' })
      : r.fulfill({ status, contentType: 'text/plain', body: '' })
  );
  await page.route(/tile\.opentopomap\.org/, (r) =>
    r.fulfill({ body: PNG, contentType: 'image/png' })
  );
}
async function stubBrouter(page, onCall) {
  await page.route(/\/brouter/, (r) => {
    onCall?.();
    return r.fulfill({ json: leg });
  });
}
// swisstopo DEM profile service used by direct-leg elevation; stubbed so the
// suite stays deterministic and offline.
async function stubHeight(page, onCall) {
  await page.route(/profile\.json/, (r) => {
    onCall?.();
    return r.fulfill({ json: profile });
  });
}
const MAP = '#map';

test.describe('bootstrap', () => {
  test('loads and initialises Leaflet', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await expect(page.locator('h1')).toHaveText(/Topo Route Planner/);
  });

  test('requests swisstopo tiles with the documented URL shape', async ({ page }) => {
    await stubBrouter(page);
    const urls = [];
    await page.route(/wmts\.geo\.admin\.ch/, (r) => {
      urls.push(r.request().url());
      return r.fulfill({ body: PNG, contentType: 'image/png' });
    });
    await page.route(/tile\.opentopomap\.org/, (r) =>
      r.fulfill({ body: PNG, contentType: 'image/png' })
    );
    await page.goto('/');
    await expect.poll(() => urls.length).toBeGreaterThan(0);
    expect(urls[0]).toMatch(
      /ch\.swisstopo\.pixelkarte-farbe\/default\/current\/2056\/\d+\/\d+\/\d+\.jpeg/
    );
  });

  test('warns when swisstopo tiles fail to load', async ({ page }) => {
    await stubBrouter(page);
    await stubTiles(page, 404);
    await page.goto('/');
    await expect(page.locator('#warn')).toHaveClass(/show/, { timeout: 10_000 });
    await expect(page.locator('#warn')).toContainText(/swisstopo tiles didn.t load/i);
  });
});

test.describe('route editing', () => {
  test('clicking the map adds waypoints', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
    await expect(page.locator('#legList li')).toHaveCount(2);
  });

  test('a routed leg calls BRouter and draws a path', async ({ page }) => {
    let called = false;
    await stubTiles(page);
    await stubBrouter(page, () => (called = true));
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await expect.poll(() => called).toBe(true);
    await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1);
    await expect(page.locator('#statDist')).not.toHaveText('0.0');
  });

  test('multiple routed legs each fetch and draw (concurrent)', async ({ page }) => {
    let calls = 0;
    await stubTiles(page);
    await stubBrouter(page, () => (calls += 1));
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 200, y: 180 } });
    await page.locator(MAP).click({ position: { x: 340, y: 260 } });
    await page.locator(MAP).click({ position: { x: 470, y: 360 } });
    // 3 waypoints => 2 routed legs => 2 drawn paths; both legs hit BRouter
    // (>=2; rapid clicks can race the leg cache and refetch, which is fine)
    await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(2);
    await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#legList li')).toHaveCount(3);
  });

  test('a direct leg draws dashed WITHOUT calling BRouter', async ({ page }) => {
    let called = false;
    await stubTiles(page);
    await stubBrouter(page, () => (called = true));
    await stubHeight(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator('#modeSeg button[data-mode="direct"]').click();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    const path = page.locator('.leaflet-overlay-pane path').first();
    await expect(path).toBeVisible();
    await expect(path).toHaveAttribute('stroke-dasharray', /\d/);
    expect(called).toBe(false);
  });

  test('a direct leg samples the swisstopo DEM for ascent', async ({ page }) => {
    let heightCalled = false;
    await stubTiles(page);
    await stubBrouter(page);
    await stubHeight(page, () => (heightCalled = true));
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator('#modeSeg button[data-mode="direct"]').click();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    // fixture profile climbs 500→530→525→560 ⇒ +30 +35 = 65 m of ascent
    await expect(page.locator('#statAsc')).toHaveText('65');
    expect(heightCalled).toBe(true);
  });

  test('toggling a leg switches it to direct', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await expect(page.locator('#legList .mini.route')).toHaveCount(1);
    await page.locator('#legList .mini').first().click();
    await expect(page.locator('#legList .mini.direct')).toHaveCount(1);
  });

  test('clear removes all waypoints and route', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await page.locator('#btnClear').click();
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(0);
    await expect(page.locator('#legList li')).toHaveCount(0);
    await expect(page.locator('#statDist')).toHaveText('0.0');
  });
});
