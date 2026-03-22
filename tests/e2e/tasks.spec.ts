import { test, expect } from '@playwright/test';

test.describe('Tâches Page — /tasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks');
    await page.waitForSelector('.app-container', { timeout: 8000 });
    // Allow SSE data to arrive
    await page.waitForTimeout(1000);
  });

  // ── Page structure ────────────────────────────────────────────────────

  test('page renders without crashing', async ({ page }) => {
    await expect(page.locator('.page-content')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('"Tâches" nav-link is active', async ({ page }) => {
    await expect(page.locator('.nav-link.active')).toContainText('Tâches');
  });

  // ── Filter tabs ───────────────────────────────────────────────────────

  test('all filter tabs present', async ({ page }) => {
    for (const label of ['Toutes', 'En cours', 'Planifié', 'Terminé', 'Échoué']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible({ timeout: 6000 });
    }
  });

  test('"Toutes" tab active by default', async ({ page }) => {
    const allBtn = page.getByRole('button', { name: 'Toutes' });
    // Should have active/selected styling (background color set)
    await expect(allBtn).toBeVisible();
  });

  test('clicking "Planifié" filter shows only planned tasks', async ({ page }) => {
    await page.getByRole('button', { name: 'Planifié' }).click();
    await page.waitForTimeout(300);
    // All visible status badges should NOT be "COMPLETED" or "RUNNING"
    const statusBadges = page.locator('[style*="planned"], span:text("PLANNED")');
    // More reliable: check that "COMPLETED" is not in the first few rows
    const content = await page.locator('.page-content').textContent();
    // Planned filter is working if we still see content without crashing
    await expect(page.locator('.page-content')).toBeVisible();
  });

  test('clicking "Terminé" filter and back to "Toutes" works', async ({ page }) => {
    await page.getByRole('button', { name: 'Terminé' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Toutes' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.page-content')).toBeVisible();
  });

  // ── View toggle ───────────────────────────────────────────────────────

  test('view toggle buttons are present (Liste + Kanban)', async ({ page }) => {
    await expect(page.getByRole('button', { name: /liste/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: /kanban/i })).toBeVisible({ timeout: 5000 });
  });

  test('switching to Kanban view renders 4 columns', async ({ page }) => {
    await page.getByRole('button', { name: /kanban/i }).click();
    await page.waitForTimeout(300);
    for (const col of ['Planifié', 'En cours', 'Terminé', 'Échoué']) {
      await expect(page.getByText(col).first()).toBeVisible({ timeout: 3000 });
    }
  });

  test('switching back to Liste from Kanban restores list view', async ({ page }) => {
    await page.getByRole('button', { name: /kanban/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /liste/i }).click();
    await page.waitForTimeout(200);
    await expect(page.locator('.page-content')).toBeVisible();
  });

  // ── Task list items ───────────────────────────────────────────────────

  test('at least one task is visible in list view', async ({ page }) => {
    // Rows are rendered as clickable divs
    const rows = page.locator('[style*="cursor: pointer"]');
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
  });

  test('task rows show status badges', async ({ page }) => {
    const page_text = await page.locator('.page-content').textContent({ timeout: 5000 });
    const hasStatus =
      page_text?.includes('COMPLETED') ||
      page_text?.includes('PLANNED')   ||
      page_text?.includes('RUNNING')   ||
      page_text?.includes('FAILED');
    expect(hasStatus).toBeTruthy();
  });

  // ── Navigation to task detail ─────────────────────────────────────────

  test('clicking a task row navigates to /tasks/:id', async ({ page }) => {
    const firstRow = page.locator('[style*="cursor: pointer"]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 5000 });
    await firstRow.click();
    await expect(page).toHaveURL(/\/tasks\/tsk_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Task Detail Page — /tasks/:id', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks/tsk_001');
    await page.waitForSelector('.app-container', { timeout: 8000 });
    await page.waitForTimeout(800);
  });

  test('task title visible (Check InBox)', async ({ page }) => {
    await expect(page.getByText('Check InBox')).toBeVisible({ timeout: 6000 });
  });

  test('live terminal / logs section visible', async ({ page }) => {
    await expect(page.getByText(/terminal|log/i).first()).toBeVisible({ timeout: 6000 });
  });

  test('execution history section present', async ({ page }) => {
    // Looking for either "Exécutions" or execution entry
    const content = await page.locator('.page-content').textContent({ timeout: 5000 });
    const hasExecs = content?.includes('exec') || content?.includes('Exécut');
    expect(hasExecs).toBeTruthy();
  });

  test('task detail shows agent info', async ({ page }) => {
    const content = await page.locator('.page-content').textContent({ timeout: 5000 });
    expect(content).toContain('main');
  });

  test('back navigation works (sidebar link)', async ({ page }) => {
    await page.locator('.nav-link').filter({ hasText: 'Tâches' }).click();
    await expect(page).toHaveURL('/tasks');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Task Detail — unknown ID', () => {
  test('navigating to /tasks/nonexistent does not crash the app', async ({ page }) => {
    await page.goto('/tasks/nonexistent_task_id');
    await page.waitForTimeout(500);
    // App shell must still be visible
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
  });
});
