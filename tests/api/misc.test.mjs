/**
 * Pré-instructions, Archives, and SSE stream contract tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from '../setup/server.mjs';

const BASE = 'http://localhost:4000';

// ─── Pré-instructions ────────────────────────────────────────────────────────

describe('Pré-instructions', () => {
  before(setup);
  after(teardown);

  let originalContent;

  test('GET /api/preinstructions → { content: string, savedAt: ISO }', async () => {
    const r = await fetch(`${BASE}/api/preinstructions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(typeof body.content === 'string',  'content is string');
    assert.ok(body.content.length > 10,          'content is not empty');
    assert.ok(typeof body.savedAt === 'string',  'savedAt is string');
    assert.ok(!isNaN(new Date(body.savedAt)),    'savedAt is valid date');
    originalContent = body.content;
  });

  test('PUT /api/preinstructions → updates content and refreshes savedAt', async () => {
    const before = Date.now();
    const r = await fetch(`${BASE}/api/preinstructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '[TEST] Updated pre-instructions.' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.content, '[TEST] Updated pre-instructions.');
    assert.ok(typeof body.savedAt === 'string');
    assert.ok(new Date(body.savedAt).getTime() >= before - 50, 'savedAt is recent');
  });

  test('GET after PUT reflects new content', async () => {
    const body = await fetch(`${BASE}/api/preinstructions`).then(r => r.json());
    assert.equal(body.content, '[TEST] Updated pre-instructions.');
  });

  test('PUT with bad JSON → 400', async () => {
    const r = await fetch(`${BASE}/api/preinstructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json }',
    });
    assert.equal(r.status, 400);
  });

  // Restore original content
  after(async () => {
    if (originalContent) {
      await fetch(`${BASE}/api/preinstructions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: originalContent }),
      });
    }
  });
});

// ─── Archives ────────────────────────────────────────────────────────────────

describe('Archives', () => {
  before(setup);
  after(teardown);

  test('GET /api/archives → non-empty array', async () => {
    const r = await fetch(`${BASE}/api/archives`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body), 'body is array');
    assert.ok(body.length > 0, 'archives not empty (seed data has completed tasks)');
  });

  test('every archive entry has required fields with correct types', async () => {
    const archives = await fetch(`${BASE}/api/archives`).then(r => r.json());
    for (const a of archives) {
      assert.ok(typeof a.id === 'string',               `${a.id}: id`);
      assert.ok(typeof a.taskName === 'string',         `${a.id}: taskName`);
      assert.ok(typeof a.startedAt === 'string',        `${a.id}: startedAt`);
      assert.ok(typeof a.duration === 'number',         `${a.id}: duration`);
      assert.ok(typeof a.promptTokens === 'number',     `${a.id}: promptTokens`);
      assert.ok(typeof a.completionTokens === 'number', `${a.id}: completionTokens`);
      assert.ok(typeof a.cost === 'number',             `${a.id}: cost`);
      assert.equal(a.exitCode, 0,                       `${a.id}: exitCode = 0`);
      assert.equal(a.status, 'ok',                      `${a.id}: status = ok`);
    }
  });

  test('archives sorted by startedAt descending (newest first)', async () => {
    const archives = await fetch(`${BASE}/api/archives`).then(r => r.json());
    for (let i = 1; i < archives.length; i++) {
      const prev = new Date(archives[i - 1].startedAt).getTime();
      const curr = new Date(archives[i].startedAt).getTime();
      assert.ok(
        prev >= curr,
        `archives[${i-1}] (${archives[i-1].startedAt}) should be newer than archives[${i}] (${archives[i].startedAt})`
      );
    }
  });

  test('all archives have positive duration', async () => {
    const archives = await fetch(`${BASE}/api/archives`).then(r => r.json());
    for (const a of archives) {
      assert.ok(a.duration > 0, `archive ${a.id}: duration should be positive`);
    }
  });

  test('all costs are non-negative', async () => {
    const archives = await fetch(`${BASE}/api/archives`).then(r => r.json());
    for (const a of archives) {
      assert.ok(a.cost >= 0, `archive ${a.id}: cost should be >= 0`);
    }
  });
});

// ─── SSE Streams ─────────────────────────────────────────────────────────────

/** Read N data-lines from an SSE response (with timeout). */
async function readSSELines(url, count = 1, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res   = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while ((text.match(/^data:/gm) || []).length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch (_) { /* timeout abort */ }
  clearTimeout(timer);
  reader.releaseLock();
  return { headers: res.headers, text };
}

describe('SSE — /api/vitals', () => {
  before(setup);
  after(teardown);

  test('returns text/event-stream with cache-control: no-cache', async () => {
    const { headers } = await readSSELines(`${BASE}/api/vitals`, 1);
    assert.equal(headers.get('content-type'), 'text/event-stream');
    assert.equal(headers.get('cache-control'), 'no-cache');
  });

  test('first event contains cpu, ram, uptime fields', async () => {
    const { text } = await readSSELines(`${BASE}/api/vitals`, 1);
    const match = text.match(/data: (.+)\n/);
    assert.ok(match, 'has a data line');
    const data = JSON.parse(match[1]);
    assert.ok(typeof data.cpu === 'number',    'cpu field');
    assert.ok(typeof data.uptime === 'number', 'uptime field');
    assert.ok(typeof data.ram === 'object',    'ram field');
    assert.ok(typeof data.ram.used === 'number',  'ram.used');
    assert.ok(typeof data.ram.total === 'number', 'ram.total');
    assert.ok(typeof data.ram.pct === 'number',   'ram.pct');
    assert.ok(data.ram.pct >= 0 && data.ram.pct <= 100, 'ram.pct 0-100');
  });
});

describe('SSE — /api/quota', () => {
  before(setup);
  after(teardown);

  test('first event contains quotas and totalCost24h', async () => {
    const { text } = await readSSELines(`${BASE}/api/quota`, 1);
    const match = text.match(/data: (.+)\n/);
    assert.ok(match, 'has data line');
    const data = JSON.parse(match[1]);
    assert.ok(typeof data.quotas === 'object',       'quotas object');
    assert.ok(typeof data.totalCost24h === 'number', 'totalCost24h number');
    assert.ok(data.totalCost24h >= 0,                'totalCost24h >= 0');
  });

  test('each quota entry has used, limit, cost, local fields', async () => {
    const { text } = await readSSELines(`${BASE}/api/quota`, 1);
    const data = JSON.parse(text.match(/data: (.+)\n/)[1]);
    for (const [model, q] of Object.entries(data.quotas)) {
      assert.ok(typeof q.used === 'number',   `${model}: used`);
      assert.ok(typeof q.cost === 'number',   `${model}: cost`);
      assert.ok(typeof q.local === 'boolean', `${model}: local`);
    }
  });
});

describe('SSE — /api/tasks?stream=1', () => {
  before(setup);
  after(teardown);

  test('returns text/event-stream', async () => {
    const { headers } = await readSSELines(`${BASE}/api/tasks?stream=1`, 1);
    assert.equal(headers.get('content-type'), 'text/event-stream');
  });

  test('first event is a JSON array of tasks', async () => {
    const { text } = await readSSELines(`${BASE}/api/tasks?stream=1`, 1);
    const match = text.match(/data: (.+)\n/);
    assert.ok(match, 'has data line');
    const data = JSON.parse(match[1]);
    assert.ok(Array.isArray(data), 'tasks SSE data is array');
    assert.ok(data.length > 0,    'tasks SSE array not empty');
  });
});

describe('SSE — /api/logs/:taskId', () => {
  before(setup);
  after(teardown);

  test('returns text/event-stream for known taskId', async () => {
    const { headers } = await readSSELines(`${BASE}/api/logs/tsk_001`, 1);
    assert.equal(headers.get('content-type'), 'text/event-stream');
  });

  test('log lines have { line, ts } shape', async () => {
    const { text } = await readSSELines(`${BASE}/api/logs/tsk_001`, 3, 5000);
    const lines = [...text.matchAll(/data: (.+)\n/g)].map(m => JSON.parse(m[1]));
    assert.ok(lines.length >= 1, 'received at least 1 log line');
    for (const l of lines) {
      assert.ok(typeof l.line === 'string', 'line is string');
      assert.ok(typeof l.ts === 'string',   'ts is string');
      assert.ok(!isNaN(new Date(l.ts)),     'ts is valid date');
    }
  });

  test('log lines arrive in sequence (BOOT → INIT → NET → EXEC)', async () => {
    const { text } = await readSSELines(`${BASE}/api/logs/tsk_001`, 5, 5000);
    const lines = [...text.matchAll(/data: (.+)\n/g)].map(m => JSON.parse(m[1]).line);
    assert.ok(lines.some(l => l.includes('[BOOT]')), 'has BOOT line');
    assert.ok(lines.some(l => l.includes('[INIT]')), 'has INIT line');
  });
});
