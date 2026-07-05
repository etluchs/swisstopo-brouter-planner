import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const leg = JSON.parse(
  readFileSync(new URL('./fixtures/brouter-leg.json', import.meta.url), 'utf-8')
);
const profile = JSON.parse(
  readFileSync(new URL('./fixtures/swisstopo-profile.json', import.meta.url), 'utf-8')
);
const identify = JSON.parse(
  readFileSync(new URL('./fixtures/swisstopo-identify.json', import.meta.url), 'utf-8')
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
  // every route triggers a whole-route elevation profile POST — stub it so the
  // suite stays deterministic (individual tests may override to assert the call)
  test.beforeEach(async ({ page }) => {
    await page.route(/profile\.json/, (r) => r.fulfill({ json: profile }));
  });

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
    // visible route line only (each leg also has a transparent wide hit line)
    await expect(
      page.locator('.leaflet-overlay-pane path:not([stroke-opacity="0"])')
    ).toHaveCount(1);
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
    // 3 waypoints => 2 routed legs => 2 visible paths; both legs hit BRouter
    // (>=2; rapid clicks can race the leg cache and refetch, which is fine)
    await expect(
      page.locator('.leaflet-overlay-pane path:not([stroke-opacity="0"])')
    ).toHaveCount(2);
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

  test('toggling a swisstopo overlay requests its tiles', async ({ page }) => {
    const overlayUrls = [];
    await page.route(/wmts\.geo\.admin\.ch/, (r) => {
      const u = r.request().url();
      if (u.includes('ch.astra.veloland')) overlayUrls.push(u);
      return r.fulfill({ body: PNG, contentType: 'image/png' });
    });
    await page.route(/tile\.opentopomap\.org/, (r) =>
      r.fulfill({ body: PNG, contentType: 'image/png' })
    );
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    const veloland = page
      .locator('#overlayList label', { hasText: 'Veloland' })
      .locator('input');
    await veloland.check();
    await expect.poll(() => overlayUrls.length).toBeGreaterThan(0);
    expect(overlayUrls[0]).toMatch(
      /ch\.astra\.veloland\/default\/current\/2056\/\d+\/\d+\/\d+\.png/
    );
    // unchecking removes the layer (no assertion beyond no-throw / stays interactive)
    await veloland.uncheck();
    await expect(veloland).not.toBeChecked();
  });

  test('right-click identifies features without adding a waypoint', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.route(/MapServer\/identify/, (r) => r.fulfill({ json: identify }));
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 480, y: 300 }, button: 'right' });
    const popup = page.locator('.leaflet-popup-content');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('Zürich HB SZU');
    await expect(popup).toContainText('Münsterhof');
    // a Veloland route links to its SchweizMobil page, built from chmobil_route_number
    await expect(
      popup.locator('a.id-link[href="https://schweizmobil.ch/en/cycling-in-switzerland/route-66"]')
    ).toBeVisible();
    // right-click must NOT drop a waypoint
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(0);
    await expect(page.locator('#legList li')).toHaveCount(0);
  });

  test('a route renders an elevation profile chart', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    // whole-route profile (stubbed via beforeEach) renders an SVG under the stats
    await expect(page.locator('#profileGrp')).toBeVisible();
    await expect(page.locator('#profile svg.prof')).toBeVisible();
  });

  test('flags ascents steeper than 18% on the elevation profile', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    // Override the shared profile stub with one that climbs 500→560 over 200 m
    // (30% grade ⇒ steep) then eases to 562 over 500 m (0.4% ⇒ gentle). Only the
    // first segment should be marked, and the badge should call out its length.
    await page.route(/profile\.json/, (r) =>
      r.fulfill({
        json: [
          { alts: { COMB: 500.0 }, dist: 0 },
          { alts: { COMB: 560.0 }, dist: 200 },
          { alts: { COMB: 562.0 }, dist: 700 },
        ],
      })
    );
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await expect(page.locator('#profile svg.prof')).toBeVisible();
    // exactly one steep run marked, and the badge reports its 200 m length
    await expect(page.locator('#profile .prof-steep')).toHaveCount(1);
    await expect(page.locator('#profile .prof-steep-lbl')).toContainText('200 m');
    await expect(page.locator('#profile .prof-steep-lbl')).toContainText('18%');
  });

  test('a gentle route shows no steep-ascent marker', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    // default fixture tops out at ~14% grade — never crosses the 18% threshold
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    await expect(page.locator('#profile svg.prof')).toBeVisible();
    await expect(page.locator('#profile .prof-steep')).toHaveCount(0);
    await expect(page.locator('#profile .prof-steep-lbl')).toHaveCount(0);
  });

  test('“Send to phone” shares the GPX via the Web Share API', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    // mock Web Share before the app loads so the button reveals and share is captured
    await page.addInitScript(() => {
      window.__shared = null;
      Object.defineProperty(navigator, 'canShare', {
        value: (d) => !!(d && d.files && d.files.length),
        configurable: true,
      });
      Object.defineProperty(navigator, 'share', {
        value: async (d) => {
          const f = d.files[0];
          window.__shared = {
            name: f.name,
            type: f.type,
            count: d.files.length,
            keys: Object.keys(d).sort().join(','),
          };
        },
        configurable: true,
      });
    });
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.locator(MAP).click({ position: { x: 250, y: 220 } });
    await page.locator(MAP).click({ position: { x: 430, y: 340 } });
    const share = page.locator('#btnShare');
    await expect(share).toBeVisible();
    await share.click();
    await expect
      .poll(() => page.evaluate(() => window.__shared))
      // keys must be exactly "files": a title/text payload would add a second
      // shared item on iOS and hide file-only targets (e.g. Garmin Connect).
      .toEqual({ name: 'topo-route.gpx', type: 'application/gpx+xml', count: 1, keys: 'files' });
  });

  test('tapping near a leg (not on the thin line) inserts a mid waypoint', async ({ page }) => {
    await stubTiles(page);
    await stubBrouter(page);
    await stubHeight(page);
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    // direct legs draw a straight screen segment, so the geometry is predictable
    await page.locator('#modeSeg button[data-mode="direct"]').click();
    await page.locator(MAP).click({ position: { x: 300, y: 200 } });
    await page.locator(MAP).click({ position: { x: 500, y: 400 } });
    await expect(page.locator('#legList li')).toHaveCount(2);
    const finishCoord = await page
      .locator('#legList li')
      .last()
      .locator('.legmeta .d')
      .textContent();
    // click ~7px off the midpoint (400,300): outside the 4px line, inside the 28px band
    await page.locator(MAP).click({ position: { x: 405, y: 295 } });
    await expect(page.locator('#legList li')).toHaveCount(3);
    // inserted mid-route: the middle row is a Via and the Finish endpoint is unchanged
    await expect(page.locator('#legList li').nth(1).locator('.legmeta .n')).toHaveText('Via 1');
    await expect(page.locator('#legList li').last().locator('.legmeta .d')).toHaveText(finishCoord);
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
