/**
 * ClawBoard Launcher — demarre backend + frontend via une page de login.
 * Usage : node launcher.mjs
 * Acces  : http://localhost:3999
 *
 * Mode PROD : si dist/ existe, lance uniquement server.mjs (qui sert le frontend)
 * Mode DEV  : lance backend + Vite separement
 */

import { createServer, request as httpRequest } from 'http';
import { copyFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PORT = 3999;

// ── Detection mode prod/dev ────────────────────────────────────────────────

const isProd = existsSync(join(__dirname, 'dist'));

// ── Charge .env manuellement (pas besoin de dependance) ─────────────────────

function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '.env'), 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return out;
  } catch { return {}; }
}

function writeEnvKey(key, value) {
  const envPath = join(__dirname, '.env');
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { content = ''; }
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(key + '=') || l.startsWith(key + ' ='));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function writeEnvKeys(pairs) {
  const envPath = join(__dirname, '.env');
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { content = ''; }
  let lines = content.split('\n');
  for (const [key, value] of Object.entries(pairs)) {
    const idx = lines.findIndex(l => l.startsWith(key + '=') || l.startsWith(key + ' ='));
    if (idx >= 0) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

// ── Creation automatique de la base de donnees ───────────────────────────────

async function createDbAndTest(dbUrl) {
  try {
    // Parse l'URL pour extraire le nom de la DB
    const u     = new URL(dbUrl);
    const dbName = u.pathname.replace(/^\//, '');
    if (!dbName) return { ok: false, message: 'Nom de base de donnees manquant dans l\'URL.' };

    // Se connecte a la base "postgres" pour creer la DB cible
    const adminUrl = new URL(dbUrl);
    adminUrl.pathname = '/postgres';

    const { default: pgModule } = await import('pg');
    const { Client } = pgModule;

    const adminClient = new Client({ connectionString: adminUrl.toString() });
    await adminClient.connect();

    // Verifie si la DB existe
    const check = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]
    );
    if (check.rows.length === 0) {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      await adminClient.end();
      return { ok: true, message: `Base "${dbName}" creee avec succes.` };
    } else {
      await adminClient.end();
      return { ok: true, message: `Base "${dbName}" deja existante. OK.` };
    }
  } catch (e) {
    return { ok: false, message: `Connexion echouee : ${e.message}` };
  }
}

const env = loadEnv();
let LAUNCHER_USER = env.LAUNCHER_USER || 'admin';
let LAUNCHER_PASS = env.LAUNCHER_PASS || 'admin';
const FRONTEND_PORT = isProd ? (env.PORT || 4000) : (env.VITE_PORT || 5173);
const BACKEND_PORT  = env.PORT || 4000;
const SETUP_DONE    = env.SETUP_DONE === 'true';

// Premier lancement : credentials encore par defaut ET setup pas encore fait
let isFirstLaunch = !SETUP_DONE && LAUNCHER_USER === 'admin' && LAUNCHER_PASS === 'admin';

// ── Etat ─────────────────────────────────────────────────────────────────────

let backendProc  = null;
let frontendProc = null;
let backendPid   = null;
let frontendPid  = null;
let state        = 'idle'; // idle | starting | running | stopped
let logs         = [];
const sseClients = new Set();

function addLog(msg, type = 'info') {
  const clean = msg.replace(/\x1B\[[0-9;]*m/g, '').trim(); // strip ANSI
  if (!clean) return;
  const entry = { msg: clean, type, t: new Date().toLocaleTimeString('fr-FR') };
  logs.push(entry);
  if (logs.length > 500) logs = logs.slice(-500);
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch (_) {} }
}

function broadcastState() {
  const data = `data: ${JSON.stringify({ __state: state })}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch (_) {} }
}

// ── Poll /api/health jusqu'a ce que le backend reponde ───────────────────────

function pollBackendHealth(maxAttempts = 60, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let aborted  = false;

    // Permet d'annuler le poll si le processus backend crash avant d'etre pret
    const abort = (reason) => { aborted = true; reject(new Error(reason)); };

    function tryOnce() {
      if (aborted) return;
      attempts++;
      const req = httpRequest(
        { hostname: 'localhost', port: BACKEND_PORT, path: '/api/health', method: 'GET', timeout: 400 },
        res => {
          // Consomme le body pour eviter de laisser le socket ouvert
          res.resume();
          // Exige 200 — evite les faux positifs sur un autre serveur (ex: 401 d'une ancienne instance)
          if (res.statusCode === 200) resolve();
          else schedule();
        }
      );
      req.on('error', schedule);
      req.on('timeout', () => { req.destroy(); schedule(); });
      req.end();
    }
    function schedule() {
      if (aborted) return;
      if (attempts >= maxAttempts) { reject(new Error('Backend non disponible apres ' + maxAttempts + ' tentatives')); return; }
      setTimeout(tryOnce, intervalMs);
    }
    tryOnce();

    // Expose abort pour l'annulation externe
    pollBackendHealth._abort = abort;
  });
}

// ── Verifie que .env existe, sinon cree un minimal ────────────────────────────

function ensureEnv() {
  const envPath     = join(__dirname, '.env');
  const examplePath = join(__dirname, '.env.example');
  if (!existsSync(envPath)) {
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, envPath);
      addLog('⚠ .env absent — copie depuis .env.example. Verifiez DATABASE_URL.', 'warn');
    } else {
      writeFileSync(envPath, '# ClawBoard — configuration minimale\nPORT=4000\n', 'utf8');
      addLog('⚠ .env absent — fichier minimal cree. Configurez DATABASE_URL avant de relancer.', 'warn');
    }
    return false;
  }
  return true;
}

// ── Kill propre (Windows: taskkill /F /T pour tuer l'arbre complet) ───────────

function killByPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    }
  } catch (_) {}
}

function killProc(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      // taskkill /F /T tue le processus ET tous ses enfants (arbre complet)
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
    }
  } catch (_) {}
}

// ── Libere un port en tuant le processus qui l'occupe (Windows) ───────────────

function freePort(port) {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue).OwningProcess; if($p){Stop-Process -Id $p -Force -EA SilentlyContinue}`,
    ], { stdio: 'ignore' });
  } catch (_) {}
}

// ── Nettoyage garanti meme si la fenetre CMD est fermee brutalement ────────────

process.on('exit', () => {
  killByPid(frontendPid);
  killByPid(backendPid);
});

// ── Demarrage des processus ───────────────────────────────────────────────────

function startAll() {
  if (state === 'running' || state === 'starting') return;
  state = 'starting';
  broadcastState();
  logs = [];

  // Verifie .env avant tout
  const envOk = ensureEnv();
  if (!envOk) {
    addLog('⚠ Verifiez le fichier .env (DATABASE_URL, etc.) puis relancez.', 'warn');
  }

  const nodeExe  = process.execPath;
  const envArgs  = existsSync(join(__dirname, '.env')) ? ['--env-file=.env'] : [];

  // Libere le port backend si un ancien processus l'occupe encore
  addLog(`⚙ Liberation port ${BACKEND_PORT}...`, 'sys');
  freePort(BACKEND_PORT);

  if (isProd) {
    addLog('▶ Mode Production — demarrage du backend...', 'sys');

    backendProc = spawn(nodeExe, [...envArgs, 'server.mjs'], {
      cwd: __dirname, env: { ...process.env },
    });
    backendPid = backendProc.pid;
    backendProc.stdout.on('data', d => addLog(d.toString(), 'backend'));
    backendProc.stderr.on('data', d => addLog(d.toString(), 'warn'));
    // Si le backend crash avant d'etre pret, annule le poll immediatement
    backendProc.on('exit', code => {
      const msg = code === 1 ? 'Backend arrete (code 1) — port occupe ou erreur demarrage' : `Backend arrete (code ${code ?? '?'})`;
      addLog(msg, 'error');
      if (pollBackendHealth._abort) pollBackendHealth._abort('Backend crash avant readiness');
      state = 'stopped'; broadcastState();
    });

    // Poll health au lieu de regex sur stdout
    addLog('⏳ Attente readiness backend...', 'sys');
    pollBackendHealth().then(() => {
      state = 'running'; broadcastState();
      addLog(`✓ ClawBoard pret → http://localhost:${BACKEND_PORT}`, 'sys');
    }).catch(err => {
      addLog(`✗ Backend indisponible — ${err.message}`, 'error');
      addLog('  → Verifiez que le port 4000 est libre et que DATABASE_URL est correct.', 'warn');
      state = 'stopped'; broadcastState();
    });

  } else {
    addLog('▶ Mode Developpement — demarrage du backend Nemoclaw...', 'sys');

    backendProc = spawn(nodeExe, [...envArgs, 'server.mjs'], {
      cwd: __dirname, env: { ...process.env },
    });
    backendPid = backendProc.pid;
    backendProc.stdout.on('data', d => addLog(d.toString(), 'backend'));
    backendProc.stderr.on('data', d => addLog(d.toString(), 'warn'));

    // Si le backend crash avant d'etre pret, annule le poll immediatement
    backendProc.on('exit', code => {
      const msg = code === 1 ? 'Backend arrete (code 1) — port occupe ou erreur demarrage' : `Backend arrete (code ${code ?? '?'})`;
      addLog(msg, 'error');
      if (pollBackendHealth._abort) pollBackendHealth._abort('Backend crash avant readiness');
      state = 'stopped'; broadcastState();
    });

    // Attend que le backend soit UP via poll HTTP, puis demarre Vite
    addLog('⏳ Attente readiness backend...', 'sys');
    pollBackendHealth().then(() => {
      addLog('✓ Backend pret — demarrage du frontend Vite...', 'sys');

      const viteBin = join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
      frontendProc = spawn(nodeExe, [viteBin], {
        cwd: __dirname, env: { ...process.env },
      });
      frontendPid = frontendProc.pid;
      frontendProc.stdout.on('data', d => {
        const msg = d.toString();
        addLog(msg, 'frontend');
        if (msg.includes('Local:') || msg.includes('localhost:')) {
          state = 'running'; broadcastState();
          addLog(`✓ ClawBoard pret → http://localhost:${FRONTEND_PORT}`, 'sys');
        }
      });
      frontendProc.stderr.on('data', d => addLog(d.toString(), 'warn'));
      frontendProc.on('exit', code => addLog(`Frontend arrete (code ${code ?? '?'})`, 'error'));
    }).catch(err => {
      addLog(`✗ Backend indisponible — ${err.message}`, 'error');
      addLog('  → Verifiez que le port 4000 est libre et que DATABASE_URL est correct.', 'warn');
      state = 'stopped'; broadcastState();
    });
  }
}

function stopAll() {
  addLog('⏹ Arret de ClawBoard...', 'sys');
  [frontendProc, backendProc].forEach(killProc);
  frontendProc = null;
  backendProc  = null;
  frontendPid  = null;
  backendPid   = null;
  state = 'idle';
  broadcastState();
}

// ── Auth simple ───────────────────────────────────────────────────────────────

function checkAuth(user, pass) {
  return user === LAUNCHER_USER && pass === LAUNCHER_PASS;
}

// ── HTML Launcher ─────────────────────────────────────────────────────────────

const getHTML = () => `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawBoard Launcher</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f0f17;
    --surface: #16162a;
    --border: rgba(255,255,255,0.08);
    --accent: #8b5cf6;
    --accent2: #a78bfa;
    --text: #e2e8f0;
    --muted: #64748b;
    --green: #10b981;
    --red: #ef4444;
    --yellow: #f59e0b;
    --mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }

  /* ── Login card ── */
  #login-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 24px;
    padding: 44px 40px; width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 24px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  .logo { display: flex; align-items: center; justify-content: center; gap: 14px; }
  .logo-icon { width: 52px; height: 52px; background: var(--accent); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 26px; }
  .logo-text { font-size: 1.6rem; font-weight: 800; letter-spacing: -0.5px; }
  .logo-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .mode-badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px;
    border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
    text-transform: uppercase; align-self: center;
  }
  .mode-badge.prod { background: rgba(16,185,129,0.12); color: var(--green); border: 1px solid rgba(16,185,129,0.25); }
  .mode-badge.dev  { background: rgba(245,158,11,0.12); color: var(--yellow); border: 1px solid rgba(245,158,11,0.25); }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
  .field input { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s; }
  .field input:focus { border-color: var(--accent); }
  #launch-btn {
    padding: 14px; background: var(--accent); border: none; border-radius: 12px; color: #fff;
    font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity 0.15s, transform 0.1s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  #launch-btn:hover { opacity: 0.9; transform: translateY(-1px); }
  #launch-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  #error-msg { color: var(--red); font-size: 13px; text-align: center; min-height: 18px; }

  /* ── Setup card ── */
  #setup-card {
    background: var(--surface); border: 2px solid rgba(139,92,246,0.4); border-radius: 24px;
    padding: 44px 40px; width: 100%; max-width: 500px; display: none; flex-direction: column; gap: 24px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  #setup-card.visible { display: flex; }
  .setup-title { text-align: center; }
  .setup-title h2 { font-size: 1.4rem; font-weight: 800; margin-bottom: 6px; }
  .setup-title p { font-size: 13px; color: var(--muted); }
  .setup-notice {
    background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.2);
    border-radius: 10px; padding: 12px 16px; font-size: 12px; color: var(--accent2); line-height: 1.5;
  }
  #setup-btn {
    padding: 14px; background: var(--accent); border: none; border-radius: 12px; color: #fff;
    font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity 0.15s, transform 0.1s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  #setup-btn:hover { opacity: 0.9; transform: translateY(-1px); }
  #setup-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  #setup-error { color: var(--red); font-size: 13px; text-align: center; min-height: 18px; }
  #setup-success {
    background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.25);
    border-radius: 10px; padding: 14px 16px; color: var(--green); font-size: 13px;
    font-weight: 600; text-align: center; display: none;
  }
  #setup-success.visible { display: block; }

  /* ── Console card ── */
  #console-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 24px;
    padding: 32px; width: 100%; max-width: 860px; display: none; flex-direction: column; gap: 20px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  .console-header { display: flex; align-items: center; justify-content: space-between; }
  .console-title { display: flex; align-items: center; gap: 12px; font-size: 1.1rem; font-weight: 700; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: background 0.3s; }
  .status-dot.starting { background: var(--yellow); animation: pulse 1s infinite; }
  .status-dot.running  { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .status-dot.stopped  { background: var(--red); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .status-label { font-size: 12px; color: var(--muted); font-weight: 600; }
  .btn-row { display: flex; gap: 10px; }
  .btn { padding: 8px 18px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); transition: all 0.15s; }
  .btn-open  { background: var(--accent); color: #fff; border-color: transparent; }
  .btn-stop  { background: rgba(239,68,68,0.12); color: var(--red); border-color: rgba(239,68,68,0.25); }
  .btn-open:hover  { opacity: 0.85; }
  .btn-stop:hover  { background: rgba(239,68,68,0.2); }
  #console-log {
    background: #0a0a12; border: 1px solid var(--border); border-radius: 12px;
    padding: 16px; height: 340px; overflow-y: auto; font-family: var(--mono); font-size: 12px;
    line-height: 1.6; display: flex; flex-direction: column; gap: 1px;
  }
  .log-line { display: flex; gap: 10px; }
  .log-time { color: var(--muted); flex-shrink: 0; }
  .log-msg  { flex: 1; word-break: break-all; white-space: pre-wrap; }
  .log-sys      .log-msg { color: var(--accent2); }
  .log-backend  .log-msg { color: #67e8f9; }
  .log-frontend .log-msg { color: #86efac; }
  .log-warn     .log-msg { color: var(--yellow); }
  .log-error    .log-msg { color: var(--red); }
  .log-info     .log-msg { color: var(--text); }
  #open-link { display: none; }
  #open-link.visible { display: block; }
  .link-banner {
    background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.25);
    border-radius: 12px; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between;
    gap: 14px;
  }
  .link-banner span { color: var(--green); font-weight: 700; }
  .link-banner a { color: #fff; background: var(--green); padding: 8px 20px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 13px; }
</style>
</head>
<body>

<!-- SETUP WIZARD (premier lancement uniquement) -->
<div id="setup-card" ${isFirstLaunch ? 'class="visible"' : ''}>
  <div class="logo">
    <div class="logo-icon">🐾</div>
    <div>
      <div class="logo-text">ClawBoard</div>
      <div class="logo-sub">Installation initiale</div>
    </div>
  </div>
  <div class="setup-title">
    <h2>Installation de ClawBoard</h2>
    <p>Configurez votre instance avant le premier demarrage.</p>
  </div>

  <!-- Prerequis -->
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin-bottom:10px;">Prerequis requis</div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:#10b981;font-size:15px;">✓</span>
        <span style="color:#e2e8f0;">Node.js ${process.version}</span>
        <span style="color:#10b981;font-size:11px;font-weight:700;">DETECTE</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:#f59e0b;font-size:15px;">↓</span>
          <span style="color:#e2e8f0;">PostgreSQL 14+</span>
          <span style="color:#f59e0b;font-size:11px;font-weight:700;">REQUIS</span>
        </div>
        <a href="https://www.postgresql.org/download/" target="_blank" style="color:#8b5cf6;font-size:11px;text-decoration:none;border:1px solid rgba(139,92,246,0.3);padding:2px 8px;border-radius:5px;">Telecharger</a>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:#64748b;font-size:15px;">○</span>
          <span style="color:#94a3b8;">Redis (via Docker)</span>
          <span style="color:#64748b;font-size:11px;font-weight:700;">OPTIONNEL</span>
        </div>
        <a href="https://docs.docker.com/get-docker/" target="_blank" style="color:#64748b;font-size:11px;text-decoration:none;border:1px solid rgba(100,116,139,0.3);padding:2px 8px;border-radius:5px;">Docker</a>
      </div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#64748b;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
      Redis optionnel : ClawBoard fonctionne sans. Ajoute du cache et du pub/sub.<br>
      Pour Redis via Docker : <code style="background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;">docker run -d -p 6379:6379 redis:alpine</code>
    </div>
  </div>

  <div class="setup-notice">
    Les cles CLAWBOARD_SECRET et CLAWBOARD_KEK seront generees automatiquement.<br>
    La base de donnees et les tables seront creees automatiquement.
  </div>

  <div class="field">
    <label>Identifiant administrateur</label>
    <input id="setup-user" type="text" value="admin" autocomplete="username" />
  </div>
  <div class="field">
    <label>Nouveau mot de passe</label>
    <input id="setup-pass1" type="password" placeholder="Minimum 8 caracteres" autocomplete="new-password" />
  </div>
  <div class="field">
    <label>Confirmer le mot de passe</label>
    <input id="setup-pass2" type="password" placeholder="Repeter le mot de passe" autocomplete="new-password" />
  </div>
  <div class="field">
    <label>URL PostgreSQL</label>
    <div style="display:flex;gap:8px;">
      <input id="setup-db" type="text" placeholder="postgresql://postgres:admin@localhost:5432/clawboard" style="flex:1;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-size:13px;font-family:monospace;outline:none;" />
      <button onclick="testDb()" id="test-db-btn" style="padding:10px 14px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);border-radius:10px;color:#a78bfa;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;">Tester</button>
    </div>
    <div id="db-status" style="font-size:12px;margin-top:5px;min-height:16px;"></div>
  </div>
  <div class="field">
    <label>Origines autorisees (CORS)</label>
    <input id="setup-origins" type="text" value="http://localhost:4000,http://localhost:5173" />
  </div>
  <div id="setup-error"></div>
  <div id="setup-success">Installation terminee ! Redirection vers la page de connexion...</div>
  <div id="setup-progress" style="display:none;font-size:12px;color:#a78bfa;text-align:center;padding:8px 0;"></div>
  <button id="setup-btn" onclick="doSetup()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    Installer et creer la base de donnees
  </button>
</div>

<!-- LOGIN -->
<div id="login-card" ${isFirstLaunch ? 'style="display:none"' : ''}>
  <div class="logo">
    <div class="logo-icon">🐾</div>
    <div>
      <div class="logo-text">ClawBoard</div>
      <div class="logo-sub">Launcher — Nemoclaw</div>
    </div>
  </div>
  <div class="mode-badge ${isProd ? 'prod' : 'dev'}">
    ${isProd ? '● Mode Production' : '◎ Mode Developpement'}
  </div>
  <div class="field">
    <label>Identifiant</label>
    <input id="inp-user" type="text" value="admin" autocomplete="username" />
  </div>
  <div class="field">
    <label>Mot de passe</label>
    <input id="inp-pass" type="password" placeholder="••••••••" autocomplete="current-password" />
  </div>
  <div id="error-msg"></div>
  <button id="launch-btn" onclick="doLaunch()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Demarrer ClawBoard
  </button>
</div>

<!-- CONSOLE -->
<div id="console-card">
  <div class="console-header">
    <div class="console-title">
      <span class="status-dot" id="dot"></span>
      <span>ClawBoard</span>
      <span class="status-label" id="status-label">Demarrage...</span>
    </div>
    <div class="btn-row">
      <button id="restart-btn" class="btn" onclick="doRestart()" style="display:none;background:rgba(16,185,129,0.12);color:#10b981;border-color:rgba(16,185,129,0.25)">▶ Redémarrer</button>
      <button class="btn btn-stop" onclick="doStop()">⏹ Arreter</button>
    </div>
  </div>
  <div id="console-log"></div>
  <div id="open-link">
    <div class="link-banner">
      <span>ClawBoard est pret !</span>
      <a href="http://localhost:${FRONTEND_PORT}" target="_blank">Ouvrir l'application →</a>
    </div>
  </div>
</div>

<script>
let evtSource = null;

async function testDb() {
  const dbUrl = document.getElementById('setup-db').value.trim();
  const el    = document.getElementById('db-status');
  const btn   = document.getElementById('test-db-btn');
  if (!dbUrl) { el.style.color = '#ef4444'; el.textContent = 'Entrez une URL PostgreSQL.'; return; }
  btn.textContent = '...';
  btn.disabled = true;
  el.style.color = '#94a3b8';
  el.textContent = 'Test en cours...';
  try {
    const r = await fetch('/test-db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dbUrl }) });
    const d = await r.json();
    el.style.color = d.ok ? '#10b981' : '#ef4444';
    el.textContent = (d.ok ? '✓ ' : '✗ ') + (d.message || (d.ok ? 'Connexion OK' : 'Echec'));
  } catch (e) {
    el.style.color = '#ef4444';
    el.textContent = 'Erreur : ' + e.message;
  }
  btn.textContent = 'Tester';
  btn.disabled = false;
}

async function doSetup() {
  const user    = document.getElementById('setup-user').value.trim();
  const pass1   = document.getElementById('setup-pass1').value;
  const pass2   = document.getElementById('setup-pass2').value;
  const db      = document.getElementById('setup-db').value.trim();
  const origins = document.getElementById('setup-origins').value.trim();
  const btn     = document.getElementById('setup-btn');
  const err     = document.getElementById('setup-error');
  const prog    = document.getElementById('setup-progress');

  err.textContent = '';

  if (!user) { err.textContent = 'Identifiant requis.'; return; }
  if (pass1.length < 8) { err.textContent = 'Mot de passe trop court (minimum 8 caracteres).'; return; }
  if (pass1 !== pass2)  { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }

  btn.disabled = true;
  prog.style.display = 'block';
  prog.textContent = 'Generation des cles de securite...';

  try {
    prog.textContent = 'Creation de la base de donnees et des tables...';
    const r = await fetch('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass: pass1, db, origins }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      err.textContent = d.error || 'Erreur installation.';
      btn.disabled = false;
      prog.style.display = 'none';
      return;
    }
    prog.textContent = (d.dbMsg || '') + ' | ' + (d.migrateMsg || '');
    document.getElementById('setup-success').classList.add('visible');
    btn.style.display = 'none';
    setTimeout(() => {
      document.getElementById('setup-card').style.display = 'none';
      document.getElementById('login-card').style.display = 'flex';
      document.getElementById('inp-user').value = user;
    }, 3000);
  } catch (e) {
    err.textContent = 'Erreur reseau : ' + e.message;
    btn.disabled = false;
    prog.style.display = 'none';
  }
}

async function doLaunch() {
  const user = document.getElementById('inp-user').value.trim();
  const pass = document.getElementById('inp-pass').value;
  const btn  = document.getElementById('launch-btn');
  const err  = document.getElementById('error-msg');

  err.textContent = '';
  btn.disabled = true;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Demarrage...';

  try {
    const r = await fetch('/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      err.textContent = d.error || 'Identifiants incorrects';
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Demarrer ClawBoard';
      return;
    }
    // Succes → affiche la console
    document.getElementById('login-card').style.display = 'none';
    const cc = document.getElementById('console-card');
    cc.style.display = 'flex';
    startSSE();
  } catch (e) {
    err.textContent = 'Erreur reseau : ' + e.message;
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Demarrer ClawBoard';
  }
}

function startSSE() {
  evtSource = new EventSource('/logs');
  const logEl = document.getElementById('console-log');

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    // State update
    if (data.__state) {
      const dot   = document.getElementById('dot');
      const label = document.getElementById('status-label');
      dot.className = 'status-dot ' + data.__state;
      const labels = { idle: 'Arrete', starting: 'Demarrage...', running: 'En ligne', stopped: 'Arrete' };
      label.textContent = labels[data.__state] || data.__state;
      if (data.__state === 'running') {
        document.getElementById('open-link').classList.add('visible');
      }
      // Afficher un bouton Redémarrer quand arrêté
      const restartBtn = document.getElementById('restart-btn');
      if (restartBtn) {
        restartBtn.style.display = (data.__state === 'stopped' || data.__state === 'idle') ? 'inline-flex' : 'none';
      }
      return;
    }

    // Log line
    const line = document.createElement('div');
    line.className = 'log-line log-' + (data.type || 'info');
    line.innerHTML = '<span class="log-time">' + data.t + '</span><span class="log-msg">' + escHtml(data.msg) + '</span>';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };
}

async function doStop() {
  const btn = document.querySelector('.btn-stop');
  btn.disabled = true;
  btn.textContent = '⏳ Arrêt...';
  try {
    await fetch('/stop', { method: 'POST' });
  } catch (_) {}
  document.getElementById('open-link').classList.remove('visible');
  // Revenir à l'écran de démarrage après 1.5s
  setTimeout(() => {
    document.getElementById('console-card').style.display = 'none';
    document.getElementById('login-card').style.display = 'flex';
    const launchBtn = document.getElementById('launch-btn');
    if (launchBtn) { launchBtn.disabled = false; launchBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Demarrer ClawBoard'; }
    btn.disabled = false;
    btn.textContent = '⏹ Arreter';
  }, 1500);
}

async function doRestart() {
  // Revenir à l'écran login pour saisir les identifiants et relancer
  document.getElementById('console-card').style.display = 'none';
  document.getElementById('login-card').style.display = 'flex';
  const launchBtn = document.getElementById('launch-btn');
  if (launchBtn) { launchBtn.disabled = false; launchBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Demarrer ClawBoard'; }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Enter key on password field
document.addEventListener('DOMContentLoaded', () => {
  const passEl = document.getElementById('inp-pass');
  if (passEl) passEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLaunch();
  });
});
</script>
</body>
</html>`;

// ── Serveur HTTP ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Page principale
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
    return;
  }

  // POST /test-db — teste la connexion PostgreSQL et cree la DB si besoin
  if (req.method === 'POST' && url === '/test-db') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { dbUrl } = JSON.parse(body);
        if (!dbUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'URL manquante.' }));
          return;
        }
        const result = await createDbAndTest(dbUrl);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /setup — wizard premier lancement
  if (req.method === 'POST' && url === '/setup') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { user, pass, db, origins } = JSON.parse(body);
        if (!user || !pass || pass.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Donnees invalides.' }));
          return;
        }

        // Genere les cles cryptographiques
        const secret = randomBytes(32).toString('hex');
        const kek    = randomBytes(32).toString('hex');
        const dbUrl  = (db && db.trim()) ? db.trim() : (env.DATABASE_URL || '');

        const pairs = {
          LAUNCHER_USER:    user,
          LAUNCHER_PASS:    pass,
          CLAWBOARD_SECRET: secret,
          CLAWBOARD_KEK:    kek,
          VITE_AUTH_TOKEN:  secret,
          SETUP_DONE:       'true',
        };
        if (dbUrl)                     pairs.DATABASE_URL    = dbUrl;
        if (origins && origins.trim()) pairs.ALLOWED_ORIGINS = origins.trim();

        writeEnvKeys(pairs);
        LAUNCHER_USER  = user;
        LAUNCHER_PASS  = pass;
        isFirstLaunch  = false; // plus de wizard au prochain reload

        // Etape 1 : creer la base si elle n'existe pas
        let dbMsg = 'DB non configuree (ignoree).';
        if (dbUrl) {
          const dbResult = await createDbAndTest(dbUrl);
          dbMsg = dbResult.message || (dbResult.ok ? 'DB OK' : 'DB erreur');
        }

        // Etape 2 : migration (creation des tables)
        let migrateMsg = 'Migration ignoree.';
        if (dbUrl && existsSync(join(__dirname, 'src', 'db', 'migrate.js'))) {
          const migResult = spawnSync(process.execPath, ['src/db/migrate.js'], {
            cwd: __dirname,
            env: { ...process.env, DATABASE_URL: dbUrl },
            timeout: 30000,
            encoding: 'utf8',
          });
          migrateMsg = migResult.stdout?.trim() || migResult.stderr?.trim() || 'Migration terminee.';
          if (migResult.status !== 0) {
            migrateMsg = 'Migration echouee : ' + (migResult.stderr?.trim() || 'erreur inconnue');
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dbMsg, migrateMsg }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Requete invalide : ' + e.message }));
      }
    });
    return;
  }

  // POST /launch — authentification + demarrage
  if (req.method === 'POST' && url === '/launch') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { user, pass } = JSON.parse(body);
        if (!checkAuth(user, pass)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Identifiants incorrects.' }));
          return;
        }
        startAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Requete invalide.' }));
      }
    });
    return;
  }

  // POST /stop — arret
  if (req.method === 'POST' && url === '/stop') {
    stopAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /logs — SSE stream
  if (req.method === 'GET' && url === '/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n'); // flush headers

    // Envoie les logs existants
    for (const entry of logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    // Envoie l'etat actuel
    res.write(`data: ${JSON.stringify({ __state: state })}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // GET /status — etat JSON
  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state, frontendPort: FRONTEND_PORT, backendPort: BACKEND_PORT, isProd }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${LAUNCHER_PORT} deja occupe — une instance du launcher tourne deja.`);
    console.error(`  → Ouvrez http://localhost:${LAUNCHER_PORT} dans votre navigateur.\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(LAUNCHER_PORT, () => {
  const modeLabel = isProd ? 'PRODUCTION' : 'DEVELOPPEMENT';
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   ClawBoard Launcher                 ║');
  console.log(`  ║   http://localhost:${LAUNCHER_PORT}           ║`);
  console.log(`  ║   Mode : ${modeLabel.padEnd(28)}║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  if (isFirstLaunch) {
    console.log('  [SETUP] Premier lancement detecte — wizard d\'installation disponible.');
    console.log('');
  }

  // Ouvre le navigateur APRES que le launcher ecoute (plus fiable que le timeout du .bat)
  const url = `http://localhost:${LAUNCHER_PORT}`;
  const opener =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    process.platform === 'darwin' ? ['open', [url]] :
    ['xdg-open', [url]];
  try {
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {
    console.log(`  Ouvrez manuellement : ${url}`);
  }
});

// Nettoyage a la fermeture du launcher
process.on('SIGINT',  () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
