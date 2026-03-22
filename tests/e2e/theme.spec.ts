import { test, expect } from '@playwright/test';

/**
 * Theme Switcher E2E tests.
 *
 * The theme system works by setting data-theme on <body> and persisting
 * the choice to localStorage under the key 'clawboard-theme'.
 */

test.describe('Theme Switcher', () => {
  test.beforeEach(async ({ page }) => {
    // Always start fresh in dark mode
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('clawboard-theme', 'dark');
      document.body.setAttribute('data-theme', 'dark');
    });
    await page.waitForSelector('.app-container', { timeout: 8000 });
  });

  // ── Presence ──────────────────────────────────────────────────────────

  test('theme switcher button visible in topbar', async ({ page }) => {
    // Button shows the current theme name (Dark / Light / Synthwave)
    const btn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('theme button shows current theme label', async ({ page }) => {
    // After setting dark theme in beforeEach
    const btn = page.locator('button').filter({ hasText: /^Dark$/ }).first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  // ── Dropdown ──────────────────────────────────────────────────────────

  test('clicking theme button opens dropdown with 3 options', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();

    // All 3 theme options visible
    await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Synthwave' })).toBeVisible();
  });

  test('dropdown closes when clicking outside', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await expect(page.getByRole('button', { name: 'Synthwave' })).toBeVisible({ timeout: 3000 });

    // Click somewhere outside the dropdown
    await page.locator('.topbar h1').click();
    await expect(page.getByRole('button', { name: 'Synthwave' })).not.toBeVisible({ timeout: 2000 });
  });

  // ── Switching to Light ─────────────────────────────────────────────────

  test('switching to Light applies data-theme="light" on body', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Light' }).last().click();

    const theme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    expect(theme).toBe('light');
  });

  test('Light theme persists in localStorage', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Light' }).last().click();

    const stored = await page.evaluate(() => localStorage.getItem('clawboard-theme'));
    expect(stored).toBe('light');
  });

  test('Light theme: background is pale (CSS var --bg-base changes)', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Light' }).last().click();

    // In light mode, --bg-base is #f1f5f9 (light slate)
    const bgColor = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--bg-base').trim()
    );
    expect(bgColor).toBe('#f1f5f9');
  });

  // ── Switching to Synthwave ─────────────────────────────────────────────

  test('switching to Synthwave applies data-theme="synthwave"', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Synthwave' }).last().click();

    const theme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    expect(theme).toBe('synthwave');
  });

  test('Synthwave theme persists in localStorage', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Synthwave' }).last().click();

    const stored = await page.evaluate(() => localStorage.getItem('clawboard-theme'));
    expect(stored).toBe('synthwave');
  });

  test('Synthwave: brand-accent CSS var is neon pink', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Synthwave' }).last().click();

    const accent = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--brand-accent').trim()
    );
    expect(accent).toBe('#ff2d78');
  });

  // ── Dark theme (default) ───────────────────────────────────────────────

  test('Dark theme: --bg-base is near-black', async ({ page }) => {
    // Already on dark from beforeEach
    const bgColor = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--bg-base').trim()
    );
    // Dark default is #09090b
    expect(bgColor).toBe('#09090b');
  });

  // ── Persistence across reloads ─────────────────────────────────────────

  test('Synthwave persists after hard reload', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Synthwave' }).last().click();

    await page.reload();
    await page.waitForSelector('.app-container', { timeout: 8000 });

    const theme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    expect(theme).toBe('synthwave');
  });

  test('Light persists after navigation to another route and back', async ({ page }) => {
    const triggerBtn = page.locator('button').filter({ hasText: /^(Dark|Light|Synthwave)$/ }).first();
    await triggerBtn.click();
    await page.getByRole('button', { name: 'Light' }).last().click();

    await page.locator('.nav-link').filter({ hasText: 'Tâches' }).click();
    await page.locator('.nav-link').filter({ hasText: 'Tableau de bord' }).click();
    await page.waitForTimeout(300);

    const theme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    expect(theme).toBe('light');
  });
});
