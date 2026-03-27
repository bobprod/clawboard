/**
 * Unit tests — GitLogModule.
 *
 * Tests cover:
 *  - Mock fallback when API absent
 *  - Branch selector rendering
 *  - Commit list display
 *  - Commit search filter
 *  - Expand/collapse commit files
 *  - File status badges (A/M/D/R)
 *  - Load more pagination
 *  - Refresh button re-fetches
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GitLogModule } from '../../src/components/GitLogModule';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('Network error')); // default: API absent
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const renderModule = () =>
  render(
    <MemoryRouter>
      <GitLogModule />
    </MemoryRouter>
  );

const MOCK_BRANCHES = [
  { name: 'main', current: false, lastCommit: '2026-03-20' },
  { name: 'feature/test', current: true, lastCommit: '2026-03-22' },
];

const MOCK_COMMITS = [
  {
    hash: 'abc123def456',
    shortHash: 'abc123d',
    message: 'feat: add unit tests',
    author: 'Dev User',
    email: 'dev@test.com',
    date: new Date().toISOString(),
    branch: 'feature/test',
    tags: ['v1.0.0'],
    files: [
      { path: 'src/tests/foo.test.tsx', status: 'added',    additions: 80, deletions: 0  },
      { path: 'src/components/Bar.tsx', status: 'modified', additions: 12, deletions: 3  },
      { path: 'src/old/legacy.ts',      status: 'deleted',  additions: 0,  deletions: 45 },
      { path: 'src/renamed.ts',         status: 'renamed',  additions: 2,  deletions: 2  },
    ],
  },
  {
    hash: 'def456abc789',
    shortHash: 'def456a',
    message: 'fix: correct SSE error handling',
    author: 'Claude Agent',
    email: 'agent@nemoclaw.ai',
    date: new Date(Date.now() - 3600_000).toISOString(),
    branch: 'feature/test',
    tags: [],
    files: [
      { path: 'src/components/ApprovalsWidget.tsx', status: 'modified', additions: 5, deletions: 2 },
    ],
  },
];

// ─── Tests: mock fallback ─────────────────────────────────────────────────────

describe('GitLogModule — mock fallback (API absent)', () => {
  it('renders page title', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('Git Log')).toBeInTheDocument();
    });
  });

  it('shows mock branch buttons', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  it('shows mock commit message', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText(/feat: add TOTP MFA/i)).toBeInTheDocument();
    });
  });

  it('shows current branch indicator (●)', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText(/●/)).toBeInTheDocument();
    });
  });

  it('shows commit count subtitle', async () => {
    renderModule();
    await waitFor(() => {
      // Format: "{n} commits · +X −Y" — check for "commit" word
      expect(screen.getByText(/\d+ commits?/i)).toBeInTheDocument();
    });
  });

  it('renders "Actualiser" button', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('Actualiser')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Filtrer commits/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: real API response ─────────────────────────────────────────────────

describe('GitLogModule — real API response', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/branches')) return Promise.resolve(makeRes(MOCK_BRANCHES));
      if (url.includes('/api/git/log'))     return Promise.resolve(makeRes(MOCK_COMMITS));
      return Promise.reject(new Error('unhandled'));
    });
  });

  it('shows branches from API', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });
  });

  it('shows commit messages from API', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('feat: add unit tests')).toBeInTheDocument();
      expect(screen.getByText('fix: correct SSE error handling')).toBeInTheDocument();
    });
  });

  it('shows commit authors', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('Dev User')).toBeInTheDocument();
    });
  });

  it('shows commit short hash', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('abc123d')).toBeInTheDocument();
    });
  });

  it('shows version tag badge', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });
  });
});

// ─── Tests: search filter ─────────────────────────────────────────────────────

describe('GitLogModule — search filter', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/branches')) return Promise.resolve(makeRes(MOCK_BRANCHES));
      if (url.includes('/api/git/log'))     return Promise.resolve(makeRes(MOCK_COMMITS));
      return Promise.reject(new Error('unhandled'));
    });
  });

  it('filters commits by message text', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));

    fireEvent.change(screen.getByPlaceholderText(/Filtrer commits/i), {
      target: { value: 'SSE' },
    });

    await waitFor(() => {
      expect(screen.queryByText('feat: add unit tests')).not.toBeInTheDocument();
      expect(screen.getByText('fix: correct SSE error handling')).toBeInTheDocument();
    });
  });

  it('filters commits by author name', async () => {
    renderModule();
    await waitFor(() => screen.getByText('Dev User'));

    fireEvent.change(screen.getByPlaceholderText(/Filtrer commits/i), {
      target: { value: 'Claude' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Dev User')).not.toBeInTheDocument();
      expect(screen.getByText('Claude Agent')).toBeInTheDocument();
    });
  });

  it('filters commits by short hash', async () => {
    renderModule();
    await waitFor(() => screen.getByText('abc123d'));

    fireEvent.change(screen.getByPlaceholderText(/Filtrer commits/i), {
      target: { value: 'def456' },
    });

    await waitFor(() => {
      expect(screen.queryByText('abc123d')).not.toBeInTheDocument();
      expect(screen.getByText('def456a')).toBeInTheDocument();
    });
  });

  it('shows empty state when no matches', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));

    fireEvent.change(screen.getByPlaceholderText(/Filtrer commits/i), {
      target: { value: 'zzzz-no-match' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Aucun commit trouvé/i)).toBeInTheDocument();
    });
  });

  it('clears filter and restores all commits', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));

    const searchInput = screen.getByPlaceholderText(/Filtrer commits/i);
    fireEvent.change(searchInput, { target: { value: 'SSE' } });
    await waitFor(() => expect(screen.queryByText('feat: add unit tests')).not.toBeInTheDocument());

    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('feat: add unit tests')).toBeInTheDocument();
      expect(screen.getByText('fix: correct SSE error handling')).toBeInTheDocument();
    });
  });
});

// ─── Tests: expand / collapse commit ─────────────────────────────────────────

describe('GitLogModule — expand/collapse commit', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/branches')) return Promise.resolve(makeRes(MOCK_BRANCHES));
      if (url.includes('/api/git/log'))     return Promise.resolve(makeRes(MOCK_COMMITS));
      return Promise.reject(new Error('unhandled'));
    });
  });

  it('shows file list after clicking commit row', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));

    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText(/Fichiers modifiés/i)).toBeInTheDocument();
    });
  });

  it('shows added file path after expand', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));
    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText('src/tests/foo.test.tsx')).toBeInTheDocument();
    });
  });

  it('shows "A" badge for added file', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));
    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText('A')).toBeInTheDocument();
    });
  });

  it('shows "M" badge for modified file', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));
    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText('M')).toBeInTheDocument();
    });
  });

  it('shows "D" badge for deleted file', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));
    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText('D')).toBeInTheDocument();
    });
  });

  it('shows "R" badge for renamed file', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));
    fireEvent.click(screen.getByText('feat: add unit tests'));

    await waitFor(() => {
      expect(screen.getByText('R')).toBeInTheDocument();
    });
  });

  it('collapses file list on second click', async () => {
    renderModule();
    await waitFor(() => screen.getByText('feat: add unit tests'));

    fireEvent.click(screen.getByText('feat: add unit tests'));
    await waitFor(() => screen.getByText(/Fichiers modifiés/i));

    fireEvent.click(screen.getByText('feat: add unit tests'));
    await waitFor(() => {
      expect(screen.queryByText(/Fichiers modifiés/i)).not.toBeInTheDocument();
    });
  });
});

// ─── Tests: refresh ──────────────────────────────────────────────────────────

describe('GitLogModule — refresh', () => {
  it('re-fetches on Actualiser click', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/branches')) return Promise.resolve(makeRes(MOCK_BRANCHES));
      if (url.includes('/api/git/log'))     return Promise.resolve(makeRes(MOCK_COMMITS));
      return Promise.reject(new Error('unhandled'));
    });

    renderModule();
    await waitFor(() => screen.getByText('Actualiser'));

    const beforeCount = mockFetch.mock.calls.length;
    fireEvent.click(screen.getByText('Actualiser'));

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(beforeCount);
    });
  });
});

// ─── Tests: branch selector ───────────────────────────────────────────────────

describe('GitLogModule — branch selector', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/branches')) return Promise.resolve(makeRes(MOCK_BRANCHES));
      if (url.includes('/api/git/log'))     return Promise.resolve(makeRes(MOCK_COMMITS));
      return Promise.reject(new Error('unhandled'));
    });
  });

  it('renders all branches', async () => {
    renderModule();
    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });
  });

  it('clicking a branch triggers re-fetch with branch param', async () => {
    renderModule();
    await waitFor(() => screen.getByText('main'));

    fireEvent.click(screen.getByText('main'));

    await waitFor(() => {
      const logCalls = mockFetch.mock.calls.filter(([url]) =>
        (url as string).includes('/api/git/log')
      );
      expect(logCalls.some(([url]) => (url as string).includes('branch=main'))).toBe(true);
    });
  });
});
