/**
 * Unit tests — ApprovalsWidget (SSE + polling + approve/reject).
 *
 * We mock both EventSource and global.fetch.
 * Tests cover:
 *  - Mock fallback when endpoint is absent
 *  - SSE connection on mount, cleanup on unmount
 *  - approval / decision / snapshot custom events
 *  - Error recovery → polling fallback
 *  - SSE status badges (Temps réel / Démo / Polling)
 *  - Approve & reject actions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ApprovalsWidget } from '../../src/components/ApprovalsWidget';

// ─── Mock EventSource ────────────────────────────────────────────────────────

type EventHandler = (e: Event | MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0;
  onopen:  ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private _listeners: Map<string, EventHandler[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventHandler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: EventHandler) {
    const list = this._listeners.get(type) ?? [];
    this._listeners.set(type, list.filter(h => h !== handler));
  }

  close() { this.readyState = 2; }

  /** Emit a named custom event (approval / decision / snapshot) */
  dispatch(type: string, data: unknown) {
    const handlers = this._listeners.get(type) ?? [];
    const evt = new MessageEvent(type, { data: JSON.stringify(data) });
    handlers.forEach(h => h(evt));
  }

  triggerOpen() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  triggerError() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
}

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const mockFetch = vi.fn();

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  MockEventSource.instances = [];
  mockFetch.mockReset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_HIGH = {
  id: 'apr-1', taskId: 't1', taskName: 'Suppression DB',
  reason: 'Destructive', riskLevel: 'high' as const,
  requestedAt: new Date().toISOString(),
  agent: 'db-cleaner',
};

const MOCK_MED = {
  id: 'apr-2', taskId: 't2', taskName: 'Envoi rapport',
  reason: 'Email externe', riskLevel: 'medium' as const,
  requestedAt: new Date().toISOString(),
};

// Make fetch fail → triggers mock fallback
const failFetch = () => mockFetch.mockRejectedValue(new Error('Network error'));

// Render widget and trigger SSE error so REST fallback runs
const renderAndFallback = async () => {
  render(<ApprovalsWidget />);
  // SSE errors immediately → calls fetchApprovals() which uses mockFetch
  await act(async () => {
    if (MockEventSource.instances.length > 0) {
      MockEventSource.instances[0].triggerError();
    }
  });
};

// Make fetch succeed with empty list
const succeedFetch = (list = []) =>
  mockFetch.mockResolvedValue(makeRes(list));

// ─── Tests: mock fallback ─────────────────────────────────────────────────────

describe('ApprovalsWidget — mock fallback', () => {
  it('shows mock approvals when API is unavailable', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => {
      expect(screen.getByText(/Nettoyage base de données prod/i)).toBeInTheDocument();
    });
  });

  it('shows "Démo" badge when using mock data', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => {
      expect(screen.getByText('Démo')).toBeInTheDocument();
    });
  });

  it('shows correct risk level badge for high-risk mock item', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => {
      expect(screen.getByText('Élevé')).toBeInTheDocument();
    });
  });

  it('shows correct risk level badge for medium-risk mock item', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => {
      expect(screen.getByText('Moyen')).toBeInTheDocument();
    });
  });

  it('shows pending count badge', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => {
      expect(screen.getByText(/2 en attente/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: SSE connection ────────────────────────────────────────────────────

describe('ApprovalsWidget — SSE lifecycle', () => {
  it('creates an EventSource on mount', () => {
    failFetch();
    render(<ApprovalsWidget />);
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
  });

  it('SSE URL ends with /api/approvals?stream=1', () => {
    failFetch();
    render(<ApprovalsWidget />);
    const es = MockEventSource.instances[0];
    expect(es.url).toMatch(/\/api\/approvals\?stream=1/);
  });

  it('shows "Temps réel" badge when SSE opens', async () => {
    failFetch();
    render(<ApprovalsWidget />);
    act(() => { MockEventSource.instances[0].triggerOpen(); });
    await waitFor(() => {
      expect(screen.getByText('Temps réel')).toBeInTheDocument();
    });
  });

  it('closes EventSource on unmount', () => {
    failFetch();
    const { unmount } = render(<ApprovalsWidget />);
    const es = MockEventSource.instances[0];
    unmount();
    expect(es.readyState).toBe(2); // CLOSED
  });
});

// ─── Tests: SSE events ───────────────────────────────────────────────────────

describe('ApprovalsWidget — SSE events', () => {
  it('approval event adds new request to list', async () => {
    failFetch();
    render(<ApprovalsWidget />);
    act(() => {
      MockEventSource.instances[0].triggerOpen();
      MockEventSource.instances[0].dispatch('approval', MOCK_HIGH);
    });
    await waitFor(() => {
      expect(screen.getByText('Suppression DB')).toBeInTheDocument();
    });
  });

  it('approval event does not add duplicate', async () => {
    failFetch();
    render(<ApprovalsWidget />);
    act(() => {
      MockEventSource.instances[0].triggerOpen();
      MockEventSource.instances[0].dispatch('approval', MOCK_HIGH);
      MockEventSource.instances[0].dispatch('approval', MOCK_HIGH); // duplicate
    });
    await waitFor(() => {
      const items = screen.getAllByText('Suppression DB');
      expect(items.length).toBe(1);
    });
  });

  it('decision event removes request by id', async () => {
    failFetch();
    render(<ApprovalsWidget />);

    // First add via snapshot
    act(() => {
      MockEventSource.instances[0].triggerOpen();
      MockEventSource.instances[0].dispatch('snapshot', [MOCK_HIGH, MOCK_MED]);
    });
    await waitFor(() => screen.getByText('Suppression DB'));

    // Then remove via decision
    act(() => {
      MockEventSource.instances[0].dispatch('decision', { id: 'apr-1' });
    });
    await waitFor(() => {
      expect(screen.queryByText('Suppression DB')).not.toBeInTheDocument();
    });
  });

  it('snapshot event replaces entire list', async () => {
    failFetch();
    render(<ApprovalsWidget />);
    act(() => {
      MockEventSource.instances[0].triggerOpen();
      MockEventSource.instances[0].dispatch('snapshot', [MOCK_MED]);
    });
    await waitFor(() => {
      expect(screen.getByText('Envoi rapport')).toBeInTheDocument();
      // Mock fallback data (Nettoyage) should be gone
      expect(screen.queryByText('Nettoyage base de données prod')).not.toBeInTheDocument();
    });
  });

  it('snapshot sets loading=false', async () => {
    failFetch();
    render(<ApprovalsWidget />);
    act(() => {
      MockEventSource.instances[0].triggerOpen();
      MockEventSource.instances[0].dispatch('snapshot', []);
    });
    await waitFor(() => {
      expect(screen.getByText(/Aucune approbation en attente/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: SSE error recovery ───────────────────────────────────────────────

describe('ApprovalsWidget — SSE error / polling fallback', () => {
  it('falls back to fetch when SSE errors', async () => {
    succeedFetch([MOCK_MED]);
    render(<ApprovalsWidget />);
    act(() => { MockEventSource.instances[0].triggerError(); });
    await waitFor(() => {
      expect(screen.getByText('Envoi rapport')).toBeInTheDocument();
    });
  });

  it('retries SSE after 15s on error', async () => {
    vi.useFakeTimers();
    failFetch();
    render(<ApprovalsWidget />);
    act(() => { MockEventSource.instances[0].triggerError(); });

    // After 15s retry
    await act(async () => { vi.advanceTimersByTime(15001); });
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Tests: approve / reject ─────────────────────────────────────────────────

describe('ApprovalsWidget — approve / reject actions', () => {
  beforeEach(() => {
    // GET fails (show mock fallback), POST decisions succeed
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/api/approvals/')) {
        return Promise.resolve(makeRes({ success: true }));
      }
      return Promise.reject(new Error('No fetch'));
    });
  });

  it('approve button calls POST /api/approvals/:id with approve', async () => {
    await renderAndFallback();
    await waitFor(() => screen.getAllByRole('button', { name: /Approuver/i }));

    fireEvent.click(screen.getAllByRole('button', { name: /Approuver/i })[0]);

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit)?.method === 'POST'
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(postCalls[0][1]?.body as string);
      expect(body.decision).toBe('approve');
    });
  });

  it('reject button calls POST with reject decision', async () => {
    await renderAndFallback();
    await waitFor(() => screen.getAllByRole('button', { name: /Rejeter/i }));

    fireEvent.click(screen.getAllByRole('button', { name: /Rejeter/i })[0]);

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit)?.method === 'POST'
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(postCalls[0][1]?.body as string);
      expect(body.decision).toBe('reject');
    });
  });

  it('removes item from list after approve (optimistic)', async () => {
    await renderAndFallback();
    await waitFor(() => screen.getByText('Nettoyage base de données prod'));

    const approveButtons = screen.getAllByRole('button', { name: /Approuver/i });
    fireEvent.click(approveButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Nettoyage base de données prod')).not.toBeInTheDocument();
    });
  });

  it('removes item from list after reject (optimistic)', async () => {
    await renderAndFallback();
    await waitFor(() => screen.getByText('Nettoyage base de données prod'));

    const rejectButtons = screen.getAllByRole('button', { name: /Rejeter/i });
    fireEvent.click(rejectButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Nettoyage base de données prod')).not.toBeInTheDocument();
    });
  });

  it('shows empty state after all requests are handled', async () => {
    await renderAndFallback();

    // Approve first item
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Approuver/i }).length).toBe(2)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Approuver/i })[0]);

    // Approve second item once first is removed
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Approuver/i }).length).toBe(1)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Approuver/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(/Aucune approbation en attente/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: expand payload ───────────────────────────────────────────────────

describe('ApprovalsWidget — payload expansion', () => {
  it('info button toggles payload details', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => screen.getByText('Nettoyage base de données prod'));

    const infoButtons = screen.getAllByTitle('Détails');
    expect(infoButtons.length).toBeGreaterThan(0);
    fireEvent.click(infoButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/Payload/i)).toBeInTheDocument();
    });
  });

  it('info button collapses payload on second click', async () => {
    failFetch();
    await renderAndFallback();
    await waitFor(() => screen.getByText('Nettoyage base de données prod'));

    const infoBtn = screen.getAllByTitle('Détails')[0];
    fireEvent.click(infoBtn);
    await waitFor(() => screen.getByText(/Payload/i));

    fireEvent.click(infoBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Payload/i)).not.toBeInTheDocument();
    });
  });
});
