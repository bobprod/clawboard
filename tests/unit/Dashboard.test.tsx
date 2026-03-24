/**
 * Unit tests — Dashboard component.
 *
 * Tests cover:
 *  - KPI cards rendering (labels + initial values)
 *  - Live task list display via SSE mock
 *  - Status badges
 *  - Empty state when no tasks
 *  - CRONs count from API
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── vi.hoisted: declare shared state BEFORE vi.mock hoisting ─────────────────
const mockSseData = vi.hoisted(() => ({ current: null as unknown }));

// ─── Mock heavy child components ─────────────────────────────────────────────
vi.mock('../../src/components/ActivityHeatmap',    () => ({ ActivityHeatmap:    () => <div data-testid="heatmap" /> }));
vi.mock('../../src/components/ModelCostBreakdown', () => ({ ModelCostBreakdown: () => <div data-testid="cost-breakdown" /> }));
vi.mock('../../src/components/ApprovalsWidget',    () => ({ ApprovalsWidget:    () => <div data-testid="approvals" /> }));
vi.mock('../../src/components/GatewayProbes',      () => ({ GatewayProbes:      () => <div data-testid="probes" /> }));
vi.mock('../../src/components/AgentChat',          () => ({ AgentChat:          () => <div data-testid="agent-chat" /> }));
vi.mock('../../src/components/AlertsBanner',       () => ({ AlertsBanner:       () => <div data-testid="alerts-banner" /> }));
vi.mock('../../src/components/DashboardTour',      () => ({ DashboardTour:      () => null }));
vi.mock('../../src/components/SystemVitals',       () => ({ SystemVitals:       () => <div data-testid="system-vitals" /> }));
vi.mock('../../src/components/FuelGauges',         () => ({ FuelGauges:         () => <div data-testid="fuel-gauges" /> }));

// ─── Mock useSSE ──────────────────────────────────────────────────────────────
vi.mock('../../src/hooks/useSSE', () => ({
  useSSE: () => ({ data: mockSseData.current }),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { Dashboard } from '../../src/components/Dashboard';

// ─── Mock fetch ───────────────────────────────────────────────────────────────
const mockFetch = vi.fn();

const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockSseData.current = null;
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue(makeRes([])); // default: empty recurrences
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );

const MOCK_TASKS = [
  {
    id: 'tsk_1', title: 'Analyse GitHub',
    status: 'running', agentId: 'agent-veille',
    llmMode: 'hybrid', cost: 0.0042,
    tokensUsed: { prompt: 100, completion: 50 },
    createdAt: new Date().toISOString(),
    channelTarget: { platform: 'telegram', targetId: '@user' },
    description: '',
  },
  {
    id: 'tsk_2', title: 'Rapport journalier',
    status: 'completed', agentId: 'agent-main',
    llmMode: 'cloud', cost: 0.001,
    tokensUsed: { prompt: 50, completion: 20 },
    createdAt: new Date().toISOString(),
    channelTarget: { platform: 'discord', targetId: '#general' },
    description: '',
  },
  {
    id: 'tsk_3', title: 'Scrape trending',
    status: 'failed', agentId: 'agent-support',
    llmMode: 'local',
    createdAt: new Date().toISOString(),
    channelTarget: { platform: 'webhook', targetId: 'https://x' },
    description: '',
  },
];

// ─── Tests: KPI cards ─────────────────────────────────────────────────────────

describe('Dashboard — KPI cards', () => {
  it('renders "Tâches Actives" card', () => {
    renderDashboard();
    expect(screen.getByText('Tâches Actives')).toBeInTheDocument();
  });

  it("renders \"Complétées Aujourd'hui\" card", () => {
    renderDashboard();
    expect(screen.getByText(/Complétées Aujourd'hui/i)).toBeInTheDocument();
  });

  it('renders "CRONs Actifs" card', () => {
    renderDashboard();
    expect(screen.getByText('CRONs Actifs')).toBeInTheDocument();
  });

  it('renders "Échecs (24h)" card', () => {
    renderDashboard();
    expect(screen.getByText(/Échecs \(24h\)/i)).toBeInTheDocument();
  });
});

// ─── Tests: CRONs from API ────────────────────────────────────────────────────

describe('Dashboard — CRONs API', () => {
  it('fetches recurrences on mount', async () => {
    renderDashboard();
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/recurrences'))).toBe(true);
    });
  });

  it('shows 0 when API fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    renderDashboard();
    await waitFor(() => {
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThan(0);
    });
  });
});

// ─── Tests: live tasks via SSE ────────────────────────────────────────────────

describe('Dashboard — live task list', () => {
  it('shows empty state when tasks array is empty', () => {
    mockSseData.current = [];
    renderDashboard();
    expect(screen.getByText(/Aucune tâche récente/i)).toBeInTheDocument();
  });

  it('shows task title when SSE provides tasks', () => {
    mockSseData.current = MOCK_TASKS;
    renderDashboard();
    expect(screen.getByText('Analyse GitHub')).toBeInTheDocument();
  });

  it('shows all task titles from SSE', () => {
    mockSseData.current = MOCK_TASKS;
    renderDashboard();
    expect(screen.getByText('Analyse GitHub')).toBeInTheDocument();
    expect(screen.getByText('Rapport journalier')).toBeInTheDocument();
    expect(screen.getByText('Scrape trending')).toBeInTheDocument();
  });

  it('shows empty state when SSE data is null', () => {
    mockSseData.current = null;
    renderDashboard();
    expect(screen.getByText(/Aucune tâche récente/i)).toBeInTheDocument();
  });

  it('KPI shows 1 active task (running)', () => {
    mockSseData.current = MOCK_TASKS; // 1 running
    renderDashboard();
    // The "1" value should appear in the Tâches Actives KPI
    expect(screen.getByText('Tâches Actives')).toBeInTheDocument();
    const ones = screen.getAllByText('1');
    expect(ones.length).toBeGreaterThan(0);
  });
});

// ─── Tests: status badges ─────────────────────────────────────────────────────

describe('Dashboard — status badges', () => {
  beforeEach(() => {
    mockSseData.current = MOCK_TASKS;
  });

  it('shows RUNNING badge', () => {
    renderDashboard();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });

  it('shows COMPLETED badge', () => {
    renderDashboard();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
  });

  it('shows FAILED badge', () => {
    renderDashboard();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
  });
});

// ─── Tests: Live indicator ────────────────────────────────────────────────────

describe('Dashboard — structure', () => {
  it('renders live indicator text when SSE is connected', () => {
    mockSseData.current = []; // non-null → liveTasks truthy → "Live" shown
    renderDashboard();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('renders heatmap widget', () => {
    renderDashboard();
    expect(screen.getByTestId('heatmap')).toBeInTheDocument();
  });

  it('renders cost breakdown widget', () => {
    renderDashboard();
    expect(screen.getByTestId('cost-breakdown')).toBeInTheDocument();
  });

  it('renders approvals widget', () => {
    renderDashboard();
    expect(screen.getByTestId('approvals')).toBeInTheDocument();
  });

  it('renders probes widget', () => {
    renderDashboard();
    expect(screen.getByTestId('probes')).toBeInTheDocument();
  });

  it('renders alerts banner', () => {
    renderDashboard();
    expect(screen.getByTestId('alerts-banner')).toBeInTheDocument();
  });
});
