/**
 * Unit tests — TachesPage.
 *
 * Tests cover:
 *  - Tab navigation (Tâches, Modèles, Récurrences, Archives)
 *  - Task list display and status filters
 *  - Replay failed task (POST /api/tasks/:id/run)
 *  - Archives: search, status filter, CSV export button
 *  - Modèles: create form
 *  - Recurrences: list, manual run button
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── Mock react-joyride ───────────────────────────────────────────────────────
vi.mock('react-joyride', () => ({
  default: () => null,
  STATUS:  { FINISHED: 'finished', SKIPPED: 'skipped' },
  EVENTS:  { STEP_AFTER: 'step:after', TARGET_NOT_FOUND: 'error:target_not_found' },
}));

// ─── vi.hoisted: SSE state shared before mock hoisting ───────────────────────
const mockSseTasks = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../src/hooks/useSSE', () => ({
  useSSE: () => ({ data: mockSseTasks.current }),
}));

import { TachesPage } from '../../src/components/TachesPage';

// ─── Mock fetch ───────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
const mockNavigate = vi.fn();

const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockSseTasks.current = null;
  mockFetch.mockReset();
  mockNavigate.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/tasks'))          return Promise.resolve(makeRes([]));
    if (url.includes('/api/modeles'))        return Promise.resolve(makeRes([]));
    if (url.includes('/api/archives'))       return Promise.resolve(makeRes([]));
    if (url.includes('/api/recurrences'))    return Promise.resolve(makeRes([]));
    if (url.includes('/api/preinstructions')) return Promise.resolve(makeRes({ content: '' }));
    return Promise.reject(new Error(`Unhandled: ${url}`));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/tasks']}>
      <TachesPage />
    </MemoryRouter>
  );

// Tab click by data-tour attribute (unique identifiers)
const clickTab = (tourId: string) => {
  const btn = document.querySelector(`[data-tour="${tourId}"]`) as HTMLElement;
  if (btn) fireEvent.click(btn);
};

const MOCK_TASKS = [
  {
    id: 'tsk_001', title: 'Tâche en cours',
    status: 'running', agentId: 'agent-main',
    llmMode: 'cloud', createdAt: new Date().toISOString(),
    channelTarget: { platform: 'telegram', targetId: '@admin' },
    description: 'Test task',
  },
  {
    id: 'tsk_002', title: 'Tâche terminée',
    status: 'completed', agentId: 'agent-support',
    llmMode: 'local', createdAt: new Date().toISOString(),
    channelTarget: { platform: 'discord', targetId: '#general' },
    description: '',
  },
  {
    id: 'tsk_003', title: 'Tâche échouée',
    status: 'failed', agentId: 'agent-veille',
    llmMode: 'hybrid', createdAt: new Date().toISOString(),
    channelTarget: { platform: 'webhook', targetId: 'https://hook.example' },
    description: '',
  },
];

// Archives use `taskName` (or `name`) field
const MOCK_ARCHIVES = [
  {
    id: 'arc_001', taskId: 'tsk_001', taskName: 'Archive rapport',
    status: 'completed', agentId: 'agent-main',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    completedAt: new Date().toISOString(),
    tokensUsed: { prompt: 100, completion: 50 },
    cost: 0.002, llmModel: 'gpt-4',
  },
  {
    id: 'arc_002', taskId: 'tsk_002', taskName: 'Archive scrape',
    status: 'failed', agentId: 'agent-veille',
    startedAt: new Date(Date.now() - 7200_000).toISOString(),
    tokensUsed: { prompt: 200, completion: 0 },
    cost: 0, llmModel: 'claude-3',
  },
];

const MOCK_MODELES = [
  {
    id: 'mod_001', name: 'Morning Briefing', skill: 'briefing',
    llmModel: 'gpt-4', agentId: 'agent-main',
    canal: 'telegram', destinataire: '@admin',
    instructions: 'Daily morning summary',
    createdAt: new Date().toISOString(),
  },
];

// cronExpr is the field name used by TachesPage for cron expressions
const MOCK_RECURRENCES = [
  {
    id: 'rec_001', name: 'Daily Report', cronExpr: '0 8 * * *',
    modelId: 'mod_001', active: true,
    nextRun: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'Europe/Paris',
  },
];

// ─── Tests: page header ───────────────────────────────────────────────────────

describe('TachesPage — page header', () => {
  it('renders page title', () => {
    renderPage();
    // h1 heading is "Tâches"
    expect(screen.getByRole('heading', { name: /Tâches/i })).toBeInTheDocument();
  });

  it('renders "Lancer Tâche" link', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /Lancer Tâche/i })).toBeInTheDocument();
  });

  it('"Lancer Tâche" link points to /tasks/new', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Lancer Tâche/i }) as HTMLAnchorElement;
    expect(link.href).toMatch(/\/tasks\/new/);
  });
});

// ─── Tests: tab navigation ────────────────────────────────────────────────────

describe('TachesPage — tab navigation', () => {
  it('renders Modèles tab', () => {
    renderPage();
    expect(document.querySelector('[data-tour="tasks-tab-modeles"]')).toBeInTheDocument();
  });

  it('renders Récurrences tab', () => {
    renderPage();
    expect(document.querySelector('[data-tour="tasks-tab-recurrences"]')).toBeInTheDocument();
  });

  it('renders Archives tab', () => {
    renderPage();
    expect(document.querySelector('[data-tour="tasks-tab-archives"]')).toBeInTheDocument();
  });

  it('clicking Modèles tab shows model empty state', async () => {
    renderPage();
    clickTab('tasks-tab-modeles');
    await waitFor(() => {
      expect(screen.getByText(/Aucun modèle/i)).toBeInTheDocument();
    });
  });

  it('clicking Archives tab shows archives search', async () => {
    renderPage();
    clickTab('tasks-tab-archives');
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Rechercher par nom, skill/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: task list ─────────────────────────────────────────────────────────

describe('TachesPage — task list', () => {
  it('shows tasks from SSE', () => {
    mockSseTasks.current = MOCK_TASKS;
    renderPage();
    expect(screen.getByText('Tâche en cours')).toBeInTheDocument();
  });

  it('shows all tasks initially', () => {
    mockSseTasks.current = MOCK_TASKS;
    renderPage();
    expect(screen.getByText('Tâche en cours')).toBeInTheDocument();
    expect(screen.getByText('Tâche terminée')).toBeInTheDocument();
    expect(screen.getByText('Tâche échouée')).toBeInTheDocument();
  });

  it('search filters tasks by title', async () => {
    mockSseTasks.current = MOCK_TASKS;
    renderPage();
    await waitFor(() => screen.getByText('Tâche en cours'));

    // The search is in the task tab (placeholder: "Rechercher par nom, ID, skill, agent…")
    fireEvent.change(screen.getByPlaceholderText(/Rechercher par nom, ID/i), {
      target: { value: 'échouée' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Tâche en cours')).not.toBeInTheDocument();
      expect(screen.getByText('Tâche échouée')).toBeInTheDocument();
    });
  });

  it('shows "Rejouer" button for failed tasks', () => {
    mockSseTasks.current = MOCK_TASKS;
    renderPage();
    // Button has title="Relancer cette tâche" and text "Rejouer"
    expect(screen.getByTitle('Relancer cette tâche')).toBeInTheDocument();
  });

  it('Rejouer calls POST /api/tasks/:id/run', async () => {
    mockSseTasks.current = MOCK_TASKS;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/tasks/tsk_003/run') && (init as RequestInit)?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      return Promise.resolve(makeRes([]));
    });

    renderPage();
    await waitFor(() => screen.getByTitle('Relancer cette tâche'));

    fireEvent.click(screen.getByTitle('Relancer cette tâche'));

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        ([url, init]) =>
          (url as string).includes('/api/tasks/tsk_003/run') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it('shows empty state when SSE returns empty list', () => {
    mockSseTasks.current = [];
    renderPage();
    expect(screen.getByText(/Aucune tâche dans cette catégorie/i)).toBeInTheDocument();
  });
});

// ─── Tests: archives ─────────────────────────────────────────────────────────

describe('TachesPage — archives tab', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/archives'))    return Promise.resolve(makeRes(MOCK_ARCHIVES));
      if (url.includes('/api/modeles'))     return Promise.resolve(makeRes([]));
      if (url.includes('/api/recurrences')) return Promise.resolve(makeRes([]));
      return Promise.resolve(makeRes([]));
    });
  });

  it('shows archive entries', async () => {
    renderPage();
    clickTab('tasks-tab-archives');
    await waitFor(() => {
      expect(screen.getByText('Archive rapport')).toBeInTheDocument();
    });
  });

  it('shows export CSV button', async () => {
    renderPage();
    clickTab('tasks-tab-archives');
    await waitFor(() => {
      expect(screen.getByText(/Exporter CSV/i)).toBeInTheDocument();
    });
  });

  it('shows Succès / Échecs status filters', async () => {
    renderPage();
    clickTab('tasks-tab-archives');
    await waitFor(() => {
      expect(screen.getByText(/Succès/i)).toBeInTheDocument();
      expect(screen.getByText(/Échecs/i)).toBeInTheDocument();
    });
  });

  it('filters archives by search term', async () => {
    renderPage();
    clickTab('tasks-tab-archives');
    await waitFor(() => screen.getByText('Archive rapport'));

    fireEvent.change(screen.getByPlaceholderText(/Rechercher par nom, skill/i), {
      target: { value: 'scrape' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Archive rapport')).not.toBeInTheDocument();
      expect(screen.getByText('Archive scrape')).toBeInTheDocument();
    });
  });
});

// ─── Tests: modèles tab ───────────────────────────────────────────────────────

describe('TachesPage — modèles tab', () => {
  it('shows existing models', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/modeles'))  return Promise.resolve(makeRes(MOCK_MODELES));
      if (url.includes('/api/archives')) return Promise.resolve(makeRes([]));
      return Promise.resolve(makeRes([]));
    });

    renderPage();
    clickTab('tasks-tab-modeles');
    await waitFor(() => {
      expect(screen.getByText('Morning Briefing')).toBeInTheDocument();
    });
  });

  it('shows "+ Créer un modèle" button', async () => {
    renderPage();
    clickTab('tasks-tab-modeles');
    await waitFor(() => {
      expect(screen.getByText(/Créer un modèle/i)).toBeInTheDocument();
    });
  });

  it('clicking "+ Créer un modèle" shows name input form', async () => {
    renderPage();
    clickTab('tasks-tab-modeles');
    await waitFor(() => screen.getByText(/Créer un modèle/i));

    fireEvent.click(screen.getByText(/Créer un modèle/i));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Morning Briefing/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no models', async () => {
    renderPage();
    clickTab('tasks-tab-modeles');
    await waitFor(() => {
      expect(screen.getByText(/Aucun modèle/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: recurrences tab ───────────────────────────────────────────────────

describe('TachesPage — récurrences tab', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/recurrences')) return Promise.resolve(makeRes(MOCK_RECURRENCES));
      return Promise.resolve(makeRes([]));
    });
  });

  it('shows recurrence entries', async () => {
    renderPage();
    clickTab('tasks-tab-recurrences');
    await waitFor(() => {
      expect(screen.getByText('Daily Report')).toBeInTheDocument();
    });
  });

  it('shows cron expression', async () => {
    renderPage();
    clickTab('tasks-tab-recurrences');
    await waitFor(() => {
      expect(screen.getByText('0 8 * * *')).toBeInTheDocument();
    });
  });

  it('shows "Lancer" button to manually trigger', async () => {
    renderPage();
    clickTab('tasks-tab-recurrences');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Lancer/i })).toBeInTheDocument();
    });
  });

  it('Lancer calls POST /api/recurrences/:id/run', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/recurrences/rec_001/run') && (init as RequestInit)?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      if (url.includes('/api/recurrences')) return Promise.resolve(makeRes(MOCK_RECURRENCES));
      return Promise.resolve(makeRes([]));
    });

    renderPage();
    clickTab('tasks-tab-recurrences');
    await waitFor(() => screen.getByRole('button', { name: /Lancer/i }));

    fireEvent.click(screen.getByRole('button', { name: /Lancer/i }));

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        ([url, init]) =>
          (url as string).includes('/api/recurrences/rec_001/run') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });
});
