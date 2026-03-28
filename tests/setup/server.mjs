/**
 * Test server lifecycle helper.
 * Starts server.mjs as a child process if not already running on :4000.
 * Safely reuses an already-running server (dev server, CI, etc.).
 */
import { spawn }       from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..', '..');
const BASE      = 'http://localhost:4000';

let proc          = null;
let ownedByTests  = false;

export async function setup() {
  // Reuse if already listening
  try {
    const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(600) });
    if (r.ok) return;
  } catch (_) { /* not up yet */ }

  proc = spawn('node', [join(ROOT, 'server.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  ownedByTests = true;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout (6s)')), 6000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('ClawBoard Backend')) { clearTimeout(t); resolve(); }
    });
    proc.stderr.on('data', (d) => {
      if (d.toString().includes('EADDRINUSE')) {
        // Someone else is on :4000 — that's fine
        clearTimeout(t); ownedByTests = false; resolve();
      }
    });
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export async function teardown() {
  if (proc && ownedByTests) {
    proc.kill('SIGTERM');
    proc = null;
    ownedByTests = false;
  }
}
