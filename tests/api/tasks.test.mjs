/**
 * Tasks REST API — full CRUD + run + SSE stream contract tests.
 *
 * Test order matters: create → read → patch → run → delete
 * We isolate by creating our own task and deleting it at the end.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from '../setup/server.mjs';

const BASE = 'http://localhost:4000';

// ─── helpers ───────────────────────────────────────────────────────────────

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ─── suite ─────────────────────────────────────────────────────────────────

describe('Tasks API — GET (list)', () => {
  before(setup);
  after(teardown);

  test('returns a non-empty array', async () => {
    const r = await fetch(`${BASE}/api/tasks`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body), 'body should be array');
    assert.ok(body.length > 0, 'should have seed tasks');
  });

  test('every task has required fields', async () => {
    const tasks = await fetch(`${BASE}/api/tasks`).then(r => r.json());
    for (const t of tasks) {
      assert.ok(typeof t.id === 'string',          `task ${t.id}: id is string`);
      assert.ok(['planned','running','completed','failed'].includes(t.status),
        `task ${t.id}: status "${t.status}" is invalid`);
      assert.ok(Array.isArray(t.executions),       `task ${t.id}: executions is array`);
      assert.ok(Array.isArray(t.activity),         `task ${t.id}: activity is array`);
      assert.ok(typeof t.tokensUsed === 'object',  `task ${t.id}: tokensUsed is object`);
      assert.ok(typeof t.tokensUsed.prompt === 'number',     `task ${t.id}: tokensUsed.prompt`);
      assert.ok(typeof t.tokensUsed.completion === 'number', `task ${t.id}: tokensUsed.completion`);
    }
  });

  test('completed tasks have executions with correct shape', async () => {
    const tasks = await fetch(`${BASE}/api/tasks`).then(r => r.json());
    const completed = tasks.filter(t => t.status === 'completed');
    assert.ok(completed.length > 0, 'seed data should have completed tasks');
    for (const t of completed) {
      for (const e of t.executions) {
        assert.ok(typeof e.id === 'string',           `exec ${e.id}: id`);
        assert.ok(typeof e.taskId === 'string',       `exec ${e.id}: taskId`);
        assert.ok(typeof e.duration === 'number',     `exec ${e.id}: duration`);
        assert.ok(typeof e.promptTokens === 'number', `exec ${e.id}: promptTokens`);
        assert.ok(typeof e.cost === 'number',         `exec ${e.id}: cost`);
      }
    }
  });
});

describe('Tasks API — POST (create)', () => {
  before(setup);
  after(teardown);

  let createdId;

  test('POST creates task with status=planned and 201', async () => {
    const r = await fetch(`${BASE}/api/tasks`, json({
      name: '[TEST] Create Task',
      modeleId: 'mod_001',
      agent: 'main',
      skillName: 'test-skill',
    }));
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(typeof body.id === 'string',     'has id');
    assert.equal(body.status, 'planned',        'status defaults to planned');
    assert.equal(body.name, '[TEST] Create Task');
    assert.ok(Array.isArray(body.executions),  'executions initialized');
    assert.ok(Array.isArray(body.activity),    'activity initialized');
    assert.equal(body.tokensUsed.prompt, 0);
    assert.equal(body.tokensUsed.completion, 0);
    assert.equal(body.cost, 0);
    createdId = body.id;
  });

  test('created task appears in GET /api/tasks', async () => {
    const tasks = await fetch(`${BASE}/api/tasks`).then(r => r.json());
    assert.ok(tasks.find(t => t.id === createdId), 'task visible in list');
  });

  test('POST with invalid JSON body → 400', async () => {
    const r = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json !!!',
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error, 'error message present');
  });

  // Cleanup
  after(async () => {
    if (createdId) await fetch(`${BASE}/api/tasks/${createdId}`, { method: 'DELETE' });
  });
});

describe('Tasks API — GET /:id', () => {
  before(setup);
  after(teardown);

  test('GET /api/tasks/tsk_001 → returns task', async () => {
    const r = await fetch(`${BASE}/api/tasks/tsk_001`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 'tsk_001');
  });

  test('GET /api/tasks/:unknown → 200 with null body', async () => {
    const r = await fetch(`${BASE}/api/tasks/ghost_tsk_xxxxxx`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body, null, 'unknown task returns null');
  });
});

describe('Tasks API — PATCH /:id', () => {
  before(setup);
  after(teardown);

  let testTaskId;

  before(async () => {
    const r = await fetch(`${BASE}/api/tasks`, json({
      name: '[TEST] Patch Task',
      modeleId: 'mod_001',
      agent: 'main',
    }));
    const body = await r.json();
    testTaskId = body.id;
  });

  after(async () => {
    if (testTaskId) await fetch(`${BASE}/api/tasks/${testTaskId}`, { method: 'DELETE' });
  });

  test('PATCH status → returns updated task', async () => {
    const r = await fetch(`${BASE}/api/tasks/${testTaskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'running');
    assert.equal(body.id, testTaskId);
  });

  test('PATCH preserves unrelated fields', async () => {
    const r = await fetch(`${BASE}/api/tasks/${testTaskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    const body = await r.json();
    assert.equal(body.name, '[TEST] Patch Task', 'name preserved after PATCH');
    assert.equal(body.agent, 'main',             'agent preserved after PATCH');
  });

  test('PATCH with bad JSON → 400', async () => {
    const r = await fetch(`${BASE}/api/tasks/${testTaskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'NOT JSON',
    });
    assert.equal(r.status, 400);
  });
});

describe('Tasks API — POST /:id/run', () => {
  before(setup);
  after(teardown);

  let runTaskId;

  before(async () => {
    const r = await fetch(`${BASE}/api/tasks`, json({
      name: '[TEST] Run Task',
      modeleId: 'mod_001',
      agent: 'main',
    }));
    runTaskId = (await r.json()).id;
  });

  after(async () => {
    if (runTaskId) await fetch(`${BASE}/api/tasks/${runTaskId}`, { method: 'DELETE' });
  });

  test('POST /run → 200 { ok: true }', async () => {
    const r = await fetch(`${BASE}/api/tasks/${runTaskId}/run`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
  });

  test('task status is "running" immediately after /run', async () => {
    const task = await fetch(`${BASE}/api/tasks/${runTaskId}`).then(r => r.json());
    assert.equal(task.status, 'running', 'task should be running immediately');
  });

  test('task has a new execution after /run', async () => {
    const task = await fetch(`${BASE}/api/tasks/${runTaskId}`).then(r => r.json());
    assert.ok(task.executions.length > 0, 'task should have at least 1 execution');
    const latest = task.executions[0];
    assert.ok(latest.id, 'execution has id');
    assert.equal(latest.taskId, runTaskId, 'execution.taskId matches');
    assert.ok(latest.startedAt, 'execution has startedAt');
  });

  test('task status becomes "completed" after ~3s', async () => {
    await new Promise(r => setTimeout(r, 3500));
    const task = await fetch(`${BASE}/api/tasks/${runTaskId}`).then(r => r.json());
    assert.equal(task.status, 'completed', 'task should complete within 3.5s');
  });

  test('POST /run on unknown task → 404', async () => {
    const r = await fetch(`${BASE}/api/tasks/ghost_id_xyz/run`, { method: 'POST' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.ok(body.error, 'has error message');
  });
});

describe('Tasks API — DELETE /:id', () => {
  before(setup);
  after(teardown);

  let deleteId;

  before(async () => {
    const r = await fetch(`${BASE}/api/tasks`, json({ name: '[TEST] Delete Task' }));
    deleteId = (await r.json()).id;
  });

  test('DELETE → 200 { ok: true }', async () => {
    const r = await fetch(`${BASE}/api/tasks/${deleteId}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
  });

  test('deleted task no longer in list', async () => {
    const tasks = await fetch(`${BASE}/api/tasks`).then(r => r.json());
    assert.ok(!tasks.find(t => t.id === deleteId), 'task removed from list');
  });

  test('deleted task GET returns null', async () => {
    const body = await fetch(`${BASE}/api/tasks/${deleteId}`).then(r => r.json());
    assert.equal(body, null);
  });
});
