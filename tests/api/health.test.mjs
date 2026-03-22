/**
 * Health, CORS, and cross-cutting API contract tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from '../setup/server.mjs';

const BASE = 'http://localhost:4000';

describe('Health & Cross-cutting', () => {
  before(setup);
  after(teardown);

  test('GET /api/ping → 200 + { ok: true, ts: number }', async () => {
    const r    = await fetch(`${BASE}/api/ping`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.ts === 'number', 'ts should be a number timestamp');
    assert.ok(body.ts > 0);
  });

  test('CORS: Access-Control-Allow-Origin: * on every response', async () => {
    const r = await fetch(`${BASE}/api/ping`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  test('OPTIONS preflight → 200 with CORS headers', async () => {
    const r = await fetch(`${BASE}/api/ping`, { method: 'OPTIONS' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-methods').includes('GET'), true);
    assert.equal(r.headers.get('access-control-allow-headers').includes('Content-Type'), true);
  });

  test('Unknown route → 404', async () => {
    const r = await fetch(`${BASE}/api/does-not-exist-xyz`);
    assert.equal(r.status, 404);
  });

  test('Content-Type: application/json on all JSON endpoints', async () => {
    for (const path of ['/api/ping', '/api/tasks', '/api/modeles', '/api/recurrences']) {
      const r = await fetch(`${BASE}${path}`);
      assert.ok(
        r.headers.get('content-type')?.startsWith('application/json'),
        `${path} should return application/json, got: ${r.headers.get('content-type')}`
      );
    }
  });

  test('Server responds within 500ms under normal load', async () => {
    const start = Date.now();
    await fetch(`${BASE}/api/ping`);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Response took ${elapsed}ms — too slow`);
  });
});
