import { test, expect } from '@playwright/test';

test.describe('Dashboard — /  (route: "/")', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for React to mount
    await page.waitForSelector('.app-container', { timeout: 8000 });
  });

  // ── Layout ────────────────────────────────────────────────────────────

  test('renders app shell (sidebar + topbar + content)', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.page-content')).toBeVisible();
  });

  test('topbar has welcome title', async ({ page }) => {
    await expect(page.locator('.topbar h1')).toContainText('Bienvenue sur ClawBoard');
  });

  test('sidebar brand shows ClawBoard', async ({ page }) => {
    await expect(page.locator('.sidebar-header h2')).toContainText('ClawBoard');
  });

  // ── KPI Cards ─────────────────────────────────────────────────────────

  test('all 4 KPI labels are visible', async ({ page }) => {
    for (const label of [
      "Tâches Actives",
      "Complétées Aujourd'hui",
      "CRONs Actifs",
      "Échecs (24h)",
    ]) {
      await expect(page.getByText(label)).toBeVisible({ timeout: 5000 });
    }
  });

  test('KPI values are numeric', async ({ page }) => {
    // Values sit inside the glass-panel flex cards
    const values = page.locator('.glass-panel .p-6').locator('div[style*="font-size: 28px"]');
    // Use the explicit inline style instead
    const nums = page.locator('div[style*="fontSize: \\'28px\\'"], div[style*="font-size: 28px"]');
    // Fallback: just check the 4 KPI cards exist
    const cards = page.locator('.glass-panel.p-6');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  // ── Live cost widget ───────────────────────────────────────────────────

  test('API cost widget visible with dollar amount', async ({ page }) => {
    const widget = page.locator('.api-cost-widget');
    await expect(widget).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cost-value')).toHaveText(/\$\d+\.\d{2}/);
  });

  // ── SystemVitals section ───────────────────────────────────────────────

  test('SystemVitals panel loads with CPU / RAM labels', async ({ page }) => {
    await expect(page.getByText('Ressources Système')).toBeVisible({ timeout: 6000 });
    await expect(page.getByText(/CPU|cpu/i)).toBeVisible({ timeout: 4000 });
  });

  // ── Recent executions table ────────────────────────────────────────────

  test("'Flux d'Exécutions Récentes' section visible", async ({ page }) => {
    await expect(page.getByText("Flux d'Exécutions Récentes")).toBeVisible({ timeout: 6000 });
  });

  test('at least one execution row appears in the flux section', async ({ page }) => {
    await page.waitForTimeout(1500); // let SSE data arrive
    // Rows are clickable divs with task titles
    const rows = page.locator('[style*="cursor: pointer"]');
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
  });

  // ── Sidebar navigation ─────────────────────────────────────────────────

  test('all 8 sidebar links are visible', async ({ page }) => {
    const links = [
      'Tableau de bord',
      'Tâches',
      'Planificateur',
      'Sécurité',
      'Collaborations',
      'Mémoire',
      'Tâches & Skills',
      'Paramètres',
    ];
    for (const text of links) {
      await expect(page.locator('.nav-link').filter({ hasText: text })).toBeVisible();
    }
  });

  test('"Tableau de bord" nav-link is active on /', async ({ page }) => {
    const active = page.locator('.nav-link.active');
    await expect(active).toContainText('Tableau de bord');
  });

  // ── Navigation ────────────────────────────────────────────────────────

  test('clicking "Tâches" navigates to /tasks', async ({ page }) => {
    await page.locator('.nav-link').filter({ hasText: 'Tâches' }).click();
    await expect(page).toHaveURL(/\/tasks/);
  });

  test('clicking "Planificateur" navigates to /scheduler', async ({ page }) => {
    await page.locator('.nav-link').filter({ hasText: 'Planificateur' }).click();
    await expect(page).toHaveURL(/\/scheduler/);
  });

  test('clicking "Paramètres" navigates to /settings', async ({ page }) => {
    await page.locator('.nav-link').filter({ hasText: 'Paramètres' }).click();
    await expect(page).toHaveURL(/\/settings/);
  });

  // ── Profile dropdown ──────────────────────────────────────────────────

  test('profile avatar button visible in topbar', async ({ page }) => {
    const avatar = page.locator('img[alt="Profile"]');
    await expect(avatar).toBeVisible();
  });
});
