/**
 * Unit tests — AgentsHierarchyModule
 *
 * Tests cover:
 *  - Renders page header (title, refresh button)
 *  - Fetch from /api/agents → shows agent count stats
 *  - Network failure → demo fallback + badge "Démo" visible
 *  - Start button calls POST /api/agents/:id/run
 *  - Stop button calls POST /api/agents/:id/stop
 *  - Refresh button re-fetches agents
 *  - ReactFlow canvas is rendered
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ─── Mock ReactFlow — use real useState so setNodes/setEdges work ─────────────

vi.mock('@xyflow/react', async () => {
  const { useState } = await import('react');
  return {
    ReactFlow: ({ nodes, nodeTypes }: { nodes?: Record<string, unknown>[]; nodeTypes?: Record<string, React.ComponentType<{ data: Record<string, unknown> }>> }) => (
      <div data-testid="reactflow">
        {(nodes ?? []).map((n) => {
          const Comp = nodeTypes?.[n.type as string];
          return Comp ? <Comp key={n.id as string} data={n.data as Record<string, unknown>} /> : null;
        })}
      </div>
    ),
    MiniMap:    () => <div data-testid="minimap" />,
    Controls:   () => <div data-testid="controls" />,
    Background: () => <div data-testid="background" />,
    Handle:     () => null,
    Position:   { Top: 'top', Bottom: 'bottom' },
    useNodesState: (init: unknown[]) => {
      const [nodes, setNodes] = useState(init);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (init: unknown[]) => {
      const [edges, setEdges] = useState(init);
      return [edges, setEdges, vi.fn()];
    },
  };
});

import { AgentsHierarchyModule } from '../../src/components/AgentsHierarchyModule';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_AGENTS = [
  { id: 'main', label: 'NemoClaw Router',  role: 'Main Orchestrator',   model: 'claude-sonnet-4-6', status: 'active',  parentId: null,   position: { x: 300, y: 50  } },
  { id: 'sub1', label: 'Code Architect',   role: 'Software Engineer',   model: 'llama-3.2',         status: 'active',  parentId: 'main', position: { x: 50,  y: 300 } },
  { id: 'sub2', label: 'Data Analyst',     role: 'Data processing',     model: 'claude-haiku-4-5',  status: 'offline', parentId: 'main', position: { x: 300, y: 300 } },
  { id: 'sub3', label: 'Security Scanner', role: 'Vulnerability check', model: 'qwen-2.5',          status: 'active',  parentId: 'main', position: { x: 550, y: 300 } },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentsHierarchyModule', () => {
  it('renders header with title and refresh button', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS });
    await act(async () => { render(<AgentsHierarchyModule />); });
    expect(screen.getByText(/hiérarchie des agents/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /actualiser/i })).toBeInTheDocument();
  });

  it('shows active and offline counts after successful fetch', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS });
    render(<AgentsHierarchyModule />);
    await waitFor(() => {
      expect(screen.getByText(/3 actifs/i)).toBeInTheDocument();
      expect(screen.getByText(/1 hors ligne/i)).toBeInTheDocument();
    });
  });

  it('shows Démo badge and falls back to mock data on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    render(<AgentsHierarchyModule />);
    await waitFor(() => {
      expect(screen.getByText('Démo')).toBeInTheDocument();
    });
    expect(screen.getByText(/3 actifs/i)).toBeInTheDocument();
  });

  it('shows Démo badge when API returns non-ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => { render(<AgentsHierarchyModule />); });
    await waitFor(() => expect(screen.getByText('Démo')).toBeInTheDocument());
  });

  it('renders ReactFlow canvas', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS });
    await act(async () => { render(<AgentsHierarchyModule />); });
    await waitFor(() => expect(screen.getByTestId('reactflow')).toBeInTheDocument());
  });

  it('calls POST /api/agents/:id/run when Start is clicked on offline agent', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MOCK_AGENTS[2], status: 'active' }) });

    render(<AgentsHierarchyModule />);
    // Wait for agent nodes to appear (Data Analyst is offline → has Start button)
    await waitFor(() => screen.getAllByText('Data Analyst'));

    const startButtons = screen.getAllByRole('button', { name: /start/i });
    expect(startButtons.length).toBeGreaterThan(0);
    fireEvent.click(startButtons[0]);

    await waitFor(() => {
      const runCall = mockFetch.mock.calls.find(c => String(c[0]).includes('/run'));
      expect(runCall).toBeDefined();
      expect(runCall?.[1]).toMatchObject({ method: 'POST' });
    });
  });

  it('calls POST /api/agents/:id/stop when Stop is clicked on active agent', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MOCK_AGENTS[0], status: 'offline' }) });

    render(<AgentsHierarchyModule />);
    await waitFor(() => screen.getAllByText('NemoClaw Router'));

    const stopButtons = screen.getAllByRole('button', { name: /stop/i });
    expect(stopButtons.length).toBeGreaterThan(0);
    fireEvent.click(stopButtons[0]);

    await waitFor(() => {
      const stopCall = mockFetch.mock.calls.find(c => String(c[0]).includes('/stop'));
      expect(stopCall).toBeDefined();
      expect(stopCall?.[1]).toMatchObject({ method: 'POST' });
    });
  });

  it('refresh button triggers a new fetch', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS })
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_AGENTS });

    render(<AgentsHierarchyModule />);
    await waitFor(() => screen.getByText(/3 actifs/i));

    fireEvent.click(screen.getByRole('button', { name: /actualiser/i }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
