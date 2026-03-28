/**
 * Modèles REST API — CRUD + run contract tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from '../setup/server.mjs';

const BASE = 'http://localhost:4000';
const postJson = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Modèles API — GET (list)', () => {
  before(setup);
  after(teardown);

  test('returns an array of at least 10 seed modeles', async () => {
    const r = await fetch(`${BASE}/api/modeles`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 10, `expected >= 10 modeles, got ${body.length}`);
  });

  test('every modele has required fields', async () => {
    const modeles = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    for (const m of modeles) {
      assert.ok(typeof m.id === 'string',                   `${m.id}: id`);
      assert.ok(typeof m.name === 'string',                 `${m.id}: name`);
      assert.ok(typeof m.agent === 'string',                `${m.id}: agent`);
      assert.ok(typeof m.executionCount === 'number',       `${m.id}: executionCount`);
      assert.ok(typeof m.disablePreInstructions === 'boolean', `${m.id}: disablePreInstructions`);
      assert.ok(typeof m.llmModel === 'string',             `${m.id}: llmModel`);
    }
  });

  test('no modele has a negative executionCount', async () => {
    const modeles = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    for (const m of modeles) {
      assert.ok(m.executionCount >= 0, `${m.id}: executionCount should be >= 0`);
    }
  });

  test('all modeles target discord canal', async () => {
    const modeles = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    for (const m of modeles) {
      assert.equal(m.canal, 'discord', `${m.id}: canal should be discord`);
    }
  });
});

describe('Modèles API — CRUD lifecycle', () => {
  before(setup);
  after(teardown);

  let createdId;

  test('POST /api/modeles → creates modele with executionCount=0', async () => {
    const r = await fetch(`${BASE}/api/modeles`, postJson({
      name: '[TEST] Modele CRUD',
      skillName: 'test-skill',
      agent: 'main',
      canal: 'discord',
      destinataire: '123456789',
      llmModel: 'kimi-k2.5',
      disablePreInstructions: false,
    }));
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(typeof body.id === 'string');
    assert.equal(body.executionCount, 0);
    assert.equal(body.name, '[TEST] Modele CRUD');
    createdId = body.id;
  });

  test('created modele appears in GET /api/modeles', async () => {
    const list = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    assert.ok(list.find(m => m.id === createdId), 'created modele in list');
  });

  test('PATCH /api/modeles/:id → updates name', async () => {
    const r = await fetch(`${BASE}/api/modeles/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '[TEST] Modele Updated' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.name, '[TEST] Modele Updated');
    assert.equal(body.id, createdId);
  });

  test('PATCH /api/modeles/:id → updates llmModel', async () => {
    const r = await fetch(`${BASE}/api/modeles/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmModel: 'openrouter/anthropic/claude-sonnet-4.6' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.llmModel, 'openrouter/anthropic/claude-sonnet-4.6');
  });

  test('PATCH preserves unmodified fields', async () => {
    const r = await fetch(`${BASE}/api/modeles/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disablePreInstructions: true }),
    });
    const body = await r.json();
    assert.equal(body.skillName, 'test-skill', 'skillName preserved');
    assert.equal(body.agent, 'main',           'agent preserved');
  });

  test('DELETE /api/modeles/:id → removes modele', async () => {
    const r = await fetch(`${BASE}/api/modeles/${createdId}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const list = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    assert.ok(!list.find(m => m.id === createdId), 'modele removed from list');
  });
});

describe('Modèles API — /run', () => {
  before(setup);
  after(teardown);

  let runModId;
  let createdTaskId;

  before(async () => {
    const r = await fetch(`${BASE}/api/modeles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '[TEST] Modele Run',
        agent: 'main',
        llmModel: 'kimi-k2.5',
        disablePreInstructions: false,
      }),
    });
    runModId = (await r.json()).id;
  });

  after(async () => {
    if (createdTaskId) await fetch(`${BASE}/api/tasks/${createdTaskId}`, { method: 'DELETE' });
    if (runModId)      await fetch(`${BASE}/api/modeles/${runModId}`, { method: 'DELETE' });
  });

  test('POST /api/modeles/:id/run → 201 { ok:true, taskId }', async () => {
    const r = await fetch(`${BASE}/api/modeles/${runModId}/run`, { method: 'POST' });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.taskId === 'string', 'taskId returned');
    createdTaskId = body.taskId;
  });

  test('created task has status=running and links back to modele', async () => {
    const task = await fetch(`${BASE}/api/tasks/${createdTaskId}`).then(r => r.json());
    assert.equal(task.status, 'running',  'task status = running');
    assert.equal(task.modeleId, runModId, 'task links to modele');
  });

  test('modele executionCount incremented after /run', async () => {
    const list   = await fetch(`${BASE}/api/modeles`).then(r => r.json());
    const modele = list.find(m => m.id === runModId);
    assert.ok(modele.executionCount >= 1, 'executionCount incremented');
  });

  test('/run on unknown modele → 404', async () => {
    const r = await fetch(`${BASE}/api/modeles/ghost_mod_xyz/run`, { method: 'POST' });
    assert.equal(r.status, 404);
  });
});
