import { test, expect } from '@playwright/test';

// Hits the REAL swisstopo endpoint. Skipped unless E2E_NETWORK=1, so CI and
// offline runs stay green. Run with: npm run test:smoke
test.describe('live swisstopo (network)', () => {
  test.skip(!process.env.E2E_NETWORK, 'set E2E_NETWORK=1 to run network smoke tests');

  test('swisstopo serves a real topo tile (HTTP 200, image/*)', async ({ page }) => {
    const tile = page.waitForResponse(
      (res) =>
        /wmts\.geo\.admin\.ch/.test(res.url()) &&
        res.status() === 200 &&
        (res.headers()['content-type'] || '').startsWith('image/'),
      { timeout: 15_000 }
    );
    await page.goto('/');
    const res = await tile;
    expect(res.ok()).toBeTruthy();
    // no fallback banner should appear when real tiles load
    await expect(page.locator('#warn')).not.toHaveClass(/show/);
  });
});
