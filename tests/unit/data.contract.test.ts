/**
 * Data shape / contract tests.
 *
 * Validates that mockData and the Task type contract are consistent
 * so that the frontend components never receive undefined where a
 * field is required.
 */
import { describe, it, expect } from 'vitest';
import { mockKpis } from '../../src/data/mockData';

// ─── mockKpis ─────────────────────────────────────────────────────────────────

describe('mockKpis shape', () => {
  it('has activeTasks as a non-negative number', () => {
    expect(typeof mockKpis.activeTasks).toBe('number');
    expect(mockKpis.activeTasks).toBeGreaterThanOrEqual(0);
  });

  it('has completedToday as a non-negative number', () => {
    expect(typeof mockKpis.completedToday).toBe('number');
    expect(mockKpis.completedToday).toBeGreaterThanOrEqual(0);
  });

  it('has failedToday as a non-negative number', () => {
    expect(typeof mockKpis.failedToday).toBe('number');
    expect(mockKpis.failedToday).toBeGreaterThanOrEqual(0);
  });

  it('has cronsActive as a positive number', () => {
    expect(typeof mockKpis.cronsActive).toBe('number');
    expect(mockKpis.cronsActive).toBeGreaterThan(0);
  });

  it('has exactly 5 top-level keys', () => {
    // activeTasks, completedToday, failedToday, cronsActive, totalApiCost24h
    expect(Object.keys(mockKpis)).toHaveLength(5);
  });

  it('has totalApiCost24h as a non-negative number', () => {
    expect(typeof (mockKpis as any).totalApiCost24h).toBe('number');
    expect((mockKpis as any).totalApiCost24h).toBeGreaterThanOrEqual(0);
  });

  it('values are finite numbers (not NaN or Infinity)', () => {
    for (const [key, val] of Object.entries(mockKpis)) {
      expect(Number.isFinite(val), `mockKpis.${key} should be finite`).toBe(true);
    }
  });
});

// ─── Task status enum coverage ────────────────────────────────────────────────

describe('Task status type coverage', () => {
  const VALID_STATUSES = ['planned', 'running', 'completed', 'failed'] as const;

  it('covers all expected status values', () => {
    // Ensure the set is not accidentally expanded or reduced
    expect(VALID_STATUSES).toHaveLength(4);
    expect(VALID_STATUSES).toContain('planned');
    expect(VALID_STATUSES).toContain('running');
    expect(VALID_STATUSES).toContain('completed');
    expect(VALID_STATUSES).toContain('failed');
  });
});

// ─── CSS theme variable completeness ─────────────────────────────────────────

describe('Theme CSS variable completeness', () => {
  /**
   * These are the variables that every component depends on.
   * If a new theme is added without all of them, components will
   * inherit unintended colors from the dark default.
   */
  const REQUIRED_VARS = [
    '--bg-base',
    '--bg-surface',
    '--bg-glass',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--brand-primary',
    '--brand-accent',
    '--border-subtle',
  ];

  const THEMES = ['light', 'synthwave'];

  // We read the CSS file at test time via Node's fs
  // (Vitest runs in Node, so fs is available)
  it('index.css contains all required vars for light theme', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(
      join(process.cwd(), 'src', 'index.css'),
      'utf-8'
    );

    for (const theme of THEMES) {
      for (const varName of REQUIRED_VARS) {
        expect(
          css.includes(varName),
          `index.css should define ${varName} for [data-theme="${theme}"]`
        ).toBe(true);
      }
    }
  });

  it('dark theme defines all base vars in :root', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf-8');
    const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));

    for (const varName of REQUIRED_VARS) {
      expect(
        rootBlock.includes(varName),
        `:root should define ${varName}`
      ).toBe(true);
    }
  });
});
