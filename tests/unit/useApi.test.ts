/**
 * Unit tests for the useApi module.
 *
 * We stub `global.fetch` with vi.stubGlobal so no real HTTP requests are made.
 * Tests validate correct URL construction, method, headers, body, and
 * return-value parsing for each api.* method.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Helper: build a fake Response-like object
const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Dynamic import AFTER stubbing so the module picks up the stubbed fetch
const { api } = await import('../../src/hooks/useApi');

const BASE = 'http://localhost:4000';

// ─── api.ping ────────────────────────────────────────────────────────────────

describe('api.ping()', () => {
  it('returns true when fetch resolves with ok=true', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ ok: true }));
    expect(await api.ping()).toBe(true);
  });

  it('returns true for any 2xx response', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}, 204));
    expect(await api.ping()).toBe(true);
  });

  it('returns false when fetch rejects (server down)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await api.ping()).toBe(false);
  });

  it('returns false on 5xx error', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ error: 'crash' }, 503));
    expect(await api.ping()).toBe(false);
  });

  it('calls the correct URL', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ ok: true }));
    await api.ping();
    // ping() may or may not pass options — just check the URL
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/ping`);
  });
});

// ─── api.patchTask ────────────────────────────────────────────────────────────

describe('api.patchTask()', () => {
  it('sends PATCH to /api/tasks/:id', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ id: 'tsk_001', status: 'running' }));
    await api.patchTask('tsk_001', { status: 'running' });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}/api/tasks/tsk_001`,
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('sends JSON body', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}));
    await api.patchTask('tsk_002', { status: 'completed', cost: 0.42 });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBe(JSON.stringify({ status: 'completed', cost: 0.42 }));
  });

  it('sets Content-Type: application/json header', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}));
    await api.patchTask('tsk_001', {});
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('returns parsed JSON response', async () => {
    const payload = { id: 'tsk_001', status: 'completed', cost: 0.99 };
    mockFetch.mockResolvedValueOnce(makeRes(payload));
    const result = await api.patchTask('tsk_001', { status: 'completed' });
    expect(result).toEqual(payload);
  });
});

// ─── api.createTask ───────────────────────────────────────────────────────────

describe('api.createTask()', () => {
  it('sends POST to /api/tasks', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ id: 'tsk_new', status: 'planned' }, 201));
    await api.createTask({ name: 'New Task', modeleId: 'mod_001' });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}/api/tasks`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('serialises task payload to JSON body', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}));
    const payload = { name: 'My Task', modeleId: 'mod_005', agent: 'main' };
    await api.createTask(payload);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBe(JSON.stringify(payload));
  });

  it('returns the created task', async () => {
    const created = { id: 'tsk_xyz', status: 'planned', name: 'Test' };
    mockFetch.mockResolvedValueOnce(makeRes(created, 201));
    const result = await api.createTask({ name: 'Test' });
    expect(result).toEqual(created);
  });
});

// ─── URL construction ─────────────────────────────────────────────────────────

describe('URL construction', () => {
  it('patchTask uses id in URL path', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}));
    await api.patchTask('tsk_abc_123', {});
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/tasks/tsk_abc_123`);
  });

  it('ping uses /api/ping path', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ ok: true }));
    await api.ping();
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/ping`);
  });

  it('createTask uses /api/tasks path', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ id: 'x' }));
    await api.createTask({});
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/tasks`);
  });
});
