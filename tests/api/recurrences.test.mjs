/**
 * Récurrences REST API — full CRUD contract tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from '../setup/server.mjs';

const BASE = 'http://localhost:4000';

describe('Récurrences API — GET (list)', () => {
  before(setup);
  after(teardown);

  test('returns array of at least 10 seed recurrences', async () => {
    const r = await fetch(`${BASE}/api/recurrences`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 10, `expected >= 10, got ${body.length}`);
  });

  test('every recurrence has required fields with correct types', async () => {
    const recs = await fetch(`${BASE}/api/recurrences`).then(r => r.json());
    for (const rec of recs) {
      assert.ok(typeof rec.id === 'string',        `${rec.id}: id`);
      assert.ok(typeof rec.name === 'string',      `${rec.id}: name`);
      assert.ok(typeof rec.cronExpr === 'string',  `${rec.id}: cronExpr`);
      assert.ok(typeof rec.human === 'string',     `${rec.id}: human`);
      assert.ok(typeof rec.timezone === 'string',  `${rec.id}: timezone`);
      assert.ok(typeof rec.modeleId === 'string',  `${rec.id}: modeleId`);
      assert.ok(typeof rec.llmModel === 'string',  `${rec.id}: llmModel`);
      assert.ok(typeof rec.active === 'boolean',   `${rec.id}: active`);
    }
  });

  test('inactive recurrences must have nextRun = null', async () => {
    const recs = await fetch(`${BASE}/api/recurrences`).then(r => r.json());
    const inactive = recs.filter(r => !r.active);
    assert.ok(inactive.length > 0, 'seed data should have at least 1 inactive recurrence');
    for (const rec of inactive) {
      assert.equal(rec.nextRun, null, `inactive rec ${rec.id} should have null nextRun`);
    }
  });

  test('active recurrences should have a nextRun date string', async () => {
    const recs   = await fetch(`${BASE}/api/recurrences`).then(r => r.json());
    const active = recs.filter(r => r.active);
    for (const rec of active) {
      assert.ok(typeof rec.nextRun === 'string', `active rec ${rec.id} should have nextRun`);
      assert.ok(!isNaN(new Date(rec.nextRun).getTime()), `nextRun should be valid ISO date`);
    }
  });

  test('all recurrences reference an existing modele', async () => {
    const [recs, mods] = await Promise.all([
      fetch(`${BASE}/api/recurrences`).then(r => r.json()),
      fetch(`${BASE}/api/modeles`).then(r => r.json()),
    ]);
    const modIds = new Set(mods.map(m => m.id));
    for (const rec of recs) {
      assert.ok(modIds.has(rec.modeleId), `rec ${rec.id}: modeleId ${rec.modeleId} not in modeles`);
    }
  });
});

describe('Récurrences API — CRUD lifecycle', () => {
  before(setup);
  after(teardown);

  let createdId;

  test('POST /api/recurrences → creates with active=true', async () => {
    const r = await fetch(`${BASE}/api/recurrences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '[TEST] Recurrence CRUD',
        cronExpr: '0 9 * * 1',
        human: 'Lundi à 9h',
        timezone: 'Europe/Paris',
        modeleId: 'mod_001',
        llmModel: 'kimi-k2.5',
        nextRun: '2026-04-06T09:00:00',
      }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(typeof body.id === 'string', 'has id');
    assert.equal(body.active, true,               'active defaults to true');
    assert.equal(body.name, '[TEST] Recurrence CRUD');
    assert.equal(body.cronExpr, '0 9 * * 1');
    assert.equal(body.timezone, 'Europe/Paris');
    createdId = body.id;
  });

  test('created recurrence appears in GET list', async () => {
    const list = await fetch(`${BASE}/api/recurrences`).then(r => r.json());
    assert.ok(list.find(r => r.id === createdId), 'new rec in list');
  });

  test('PATCH → toggle active to false', async () => {
    const r = await fetch(`${BASE}/api/recurrences/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.active, false);
  });

  test('PATCH → update cronExpr and human label', async () => {
    const r = await fetch(`${BASE}/api/recurrences/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronExpr: '30 10 * * 1', human: 'Lundi à 10h30' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cronExpr, '30 10 * * 1');
    assert.equal(body.human, 'Lundi à 10h30');
  });

  test('PATCH preserves unmodified fields', async () => {
    const r = await fetch(`${BASE}/api/recurrences/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmModel: 'openrouter/anthropic/claude-sonnet-4.6' }),
    });
    const body = await r.json();
    assert.equal(body.modeleId, 'mod_001',      'modeleId preserved');
    assert.equal(body.timezone, 'Europe/Paris', 'timezone preserved');
  });

  test('DELETE removes recurrence from list', async () => {
    const r = await fetch(`${BASE}/api/recurrences/${createdId}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const list = await fetch(`${BASE}/api/recurrences`).then(r => r.json());
    assert.ok(!list.find(r => r.id === createdId), 'rec removed');
  });
});
