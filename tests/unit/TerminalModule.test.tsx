/**
 * Unit tests — TerminalModule.
 *
 * Tests cover:
 *  - Initial banner / welcome message
 *  - Builtin commands: help, clear, version, echo, date
 *  - API commands: status/health, tasks, run, logs
 *  - Unknown command fallback to /api/shell error
 *  - Command history navigation (↑ / ↓)
 *  - Ctrl+L clears terminal
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalModule } from '../../src/components/TerminalModule';

// jsdom doesn't implement scrollIntoView — mock it globally
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

const makeRes = (body: unknown, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: (h: string) => h === 'content-type' ? contentType : null },
  body: null,
});

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('Network error')); // default: all fail
  vi.stubGlobal('fetch', mockFetch);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const renderTerminal = () => render(<TerminalModule />);

const getInput = () =>
  screen.getByPlaceholderText(/Entrez une commande/i) as HTMLInputElement;

const submit = (cmd: string) => {
  const input = getInput();
  fireEvent.change(input, { target: { value: cmd } });
  fireEvent.submit(input.closest('form')!);
};

// ─── Tests: initial state ─────────────────────────────────────────────────────

describe('TerminalModule — initial render', () => {
  it('shows "Terminal Nemoclaw" in header', () => {
    renderTerminal();
    expect(screen.getByText('Terminal Nemoclaw')).toBeInTheDocument();
  });

  it('shows Nemoclaw Terminal in welcome banner', async () => {
    renderTerminal();
    await waitFor(() => {
      expect(screen.getByText(/Nemoclaw Terminal/i)).toBeInTheDocument();
    });
  });

  it('shows help hint message', async () => {
    renderTerminal();
    await waitFor(() => {
      expect(screen.getByText(/Tapez "help"/i)).toBeInTheDocument();
    });
  });

  it('renders command input', () => {
    renderTerminal();
    expect(getInput()).toBeInTheDocument();
  });

  it('renders Exec submit button', () => {
    renderTerminal();
    expect(screen.getByText('Exec')).toBeInTheDocument();
  });

  it('shows keyboard shortcut hints', () => {
    renderTerminal();
    expect(screen.getByText(/Historique/i)).toBeInTheDocument();
  });
});

// ─── Tests: builtin commands ─────────────────────────────────────────────────

describe('TerminalModule — builtin commands', () => {
  it('help command shows available commands list', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      const items = screen.queryAllByText(/Commandes disponibles/i);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it('help output mentions "clear" builtin', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      const items = screen.queryAllByText(/Effacer le terminal/i);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it('help output mentions "status" command', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      const items = screen.queryAllByText(/Statut du gateway/i);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it('version command shows Nemoclaw version string', async () => {
    renderTerminal();
    submit('version');
    await waitFor(() => {
      expect(screen.getByText(/Nemoclaw v/i)).toBeInTheDocument();
    });
  });

  it('echo command repeats input text', async () => {
    renderTerminal();
    submit('echo bonjour monde');
    await waitFor(() => {
      const items = screen.queryAllByText(/bonjour monde/);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it('clear command wipes previous output', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      const items = screen.queryAllByText(/Commandes disponibles/i);
      expect(items.length).toBeGreaterThan(0);
    });

    submit('clear');
    await waitFor(() => {
      expect(screen.queryAllByText(/Commandes disponibles/i)).toHaveLength(0);
    });
  });

  it('date command outputs current year', async () => {
    renderTerminal();
    submit('date');
    await waitFor(() => {
      expect(screen.getByText(/2026/)).toBeInTheDocument();
    });
  });
});

// ─── Tests: API commands ─────────────────────────────────────────────────────

describe('TerminalModule — API commands', () => {
  it('status command calls GET /api/health', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/health'))
        return Promise.resolve(makeRes({ status: 'ok', uptime: 3600, version: '2.4.1' }));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('status');

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/health'))).toBe(true);
    });
  });

  it('health command also calls GET /api/health', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/health'))
        return Promise.resolve(makeRes({ status: 'ok' }));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('health');

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/health'))).toBe(true);
    });
  });

  it('tasks command calls GET /api/tasks?status=running', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/tasks')) return Promise.resolve(makeRes([]));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('tasks');

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/tasks'))).toBe(true);
    });
  });

  it('run <id> command calls POST /api/tasks/:id/run', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/tasks/tsk_99/run') && (init as RequestInit)?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('run tsk_99');

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        ([url, init]) =>
          (url as string).includes('/api/tasks/tsk_99/run') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it('run shows success message on 200', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/tasks/tsk_99/run') && (init as RequestInit)?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('run tsk_99');

    await waitFor(() => {
      expect(screen.getByText(/relancée avec succès/i)).toBeInTheDocument();
    });
  });

  it('logs <id> command calls GET /api/tasks/:id/logs', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/tasks/tsk_42/logs'))
        return Promise.resolve(makeRes('line1\nline2', 200, 'text/plain'));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('logs tsk_42');

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/tasks/tsk_42/logs'))).toBe(true);
    });
  });
});

// ─── Tests: unknown command ───────────────────────────────────────────────────

describe('TerminalModule — unknown command via /api/shell', () => {
  it('unknown command returns error when /api/shell fails with 404', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/shell'))
        return Promise.resolve(makeRes({ error: 'not found' }, 404));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('xyzzy');

    await waitFor(() => {
      expect(screen.getByText(/Commande inconnue/i)).toBeInTheDocument();
    });
  });

  it('error message includes the command name', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/shell'))
        return Promise.resolve(makeRes({ error: 'not found' }, 404));
      return Promise.reject(new Error('unhandled'));
    });

    renderTerminal();
    submit('xyzzy');

    await waitFor(() => {
      expect(screen.getByText(/xyzzy/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: history navigation ────────────────────────────────────────────────

describe('TerminalModule — command history', () => {
  it('ArrowUp navigates to previous command', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      expect(screen.queryAllByText(/Commandes disponibles/i).length).toBeGreaterThan(0);
    });

    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    await waitFor(() => {
      expect(input.value).toBe('help');
    });
  });

  it('ArrowDown after ArrowUp returns to empty input', async () => {
    renderTerminal();
    submit('version');
    await waitFor(() => {
      expect(screen.queryAllByText(/Nemoclaw v/i).length).toBeGreaterThan(0);
    });

    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input.value).toBe('version'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('stores multiple commands and navigates between them', async () => {
    renderTerminal();

    submit('help');
    await waitFor(() => {
      expect(screen.queryAllByText(/Commandes disponibles/i).length).toBeGreaterThan(0);
    });

    submit('version');
    await waitFor(() => {
      expect(screen.queryAllByText(/Nemoclaw v/i).length).toBeGreaterThan(0);
    });

    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // → version
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // → help

    await waitFor(() => {
      expect(input.value).toBe('help');
    });
  });
});

// ─── Tests: Ctrl+L shortcut ───────────────────────────────────────────────────

describe('TerminalModule — keyboard shortcuts', () => {
  it('Ctrl+L clears the terminal output', async () => {
    renderTerminal();
    submit('help');
    await waitFor(() => {
      expect(screen.queryAllByText(/Commandes disponibles/i).length).toBeGreaterThan(0);
    });

    const input = getInput();
    fireEvent.keyDown(input, { key: 'l', ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryAllByText(/Commandes disponibles/i)).toHaveLength(0);
    });
  });
});
