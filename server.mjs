import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join as pathJoin, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import pool, { checkConnection } from './src/db/client.js';
import { pub as redisClient, connectRedis, cacheGet, cacheSet, cacheDel } from './src/lib/redis.js';

const PORT    = process.env.PORT    ? Number(process.env.PORT) : 4000;
const SECRET  = process.env.CLAWBOARD_SECRET || '';
const KEK_HEX = process.env.CLAWBOARD_KEK   || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim()).filter(Boolean);
const BODY_LIMIT = 1 * 1024 * 1024; // 1 MB

if (!SECRET) console.warn('[SECURITY] CLAWBOARD_SECRET not set — all routes are unauthenticated!');
if (!KEK_HEX) console.warn('[SECURITY] CLAWBOARD_KEK not set — API keys stored in plaintext!');

// ─── Security helpers ─────────────────────────────────────────────────────────

const PUBLIC_PREFIXES = ['/api/ping', '/api/health', '/api/vitals', '/api/quota', '/api/logs/', '/api/auth/login'];

function checkAuth(req) {
  if (!SECRET) return true;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  try {
    const a = Buffer.from(SECRET.padEnd(64), 'utf8');
    const b = Buffer.from(token.padEnd(64),  'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b) && token === SECRET;
  } catch { return false; }
}

function requireAuth(req, res) {
  if (checkAuth(req)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const BANNED = new Set(['__proto__', 'constructor', 'prototype']);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !BANNED.has(k)));
}

// ─── AES-256-GCM ──────────────────────────────────────────────────────────────

const KEK = KEK_HEX.length === 64 ? Buffer.from(KEK_HEX, 'hex') : null;

function encryptKey(plaintext) {
  if (!KEK || !plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEK, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptKey(stored) {
  if (!KEK || !stored || !stored.startsWith('enc:')) return stored;
  try {
    const [, ivHex, tagHex, encHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEK, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const H = 3600000, M = 60000;

// ─── DB Row Mappers ───────────────────────────────────────────────────────────

function rowToModele(r) {
  return {
    id: r.id,
    name: r.name || r.nom,
    description: r.description || '',
    instructions: r.instructions || '',
    skillName: r.skill_name || null,
    agent: r.agent || 'main',
    canal: r.canal || null,
    destinataire: r.destinataire || null,
    llmModel: r.llm_model || 'claude-sonnet-4-6',
    disablePreInstructions: r.disable_pre_instructions || false,
    executionCount: r.execution_count || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRecurrence(r) {
  return {
    id: r.id,
    name: r.name || r.nom,
    cronExpr: r.cron_expr || r.cron,
    human: r.human || r.human_label || r.cron_expr,
    timezone: r.timezone || 'UTC',
    modeleId: r.modele_id || null,
    llmModel: r.llm_model || null,
    active: r.active ?? r.actif,
    nextRun: r.next_run || null,
    lastRun: r.last_run || null,
    runCount: r.run_count || 0,
  };
}

function rowToActivity(r) {
  return {
    type: r.type,
    label: r.label || r.message || r.type,
    ts: r.created_at,
  };
}

function rowToExecution(r) {
  return {
    id: String(r.id),
    taskId: r.task_id,
    startedAt: r.started_at || r.created_at,
    duration: r.duration || r.duree_ms || null,
    promptTokens: r.prompt_tokens || r.tokens_in || 0,
    completionTokens: r.completion_tokens || r.tokens_out || 0,
    cost: r.cout || 0,
    exitCode: r.exit_code ?? (r.statut === 'completed' ? 0 : null),
    stdout: r.stdout || '',
  };
}

function rowToTask(r, activities = [], executions = []) {
  return {
    id: r.id,
    name: r.titre,
    modeleId: r.modele_id || r.modele || null,
    status: r.statut,
    agent: r.agent || 'main',
    skillName: r.skill_name || null,
    instructions: r.instructions || '',
    scheduledAt: r.scheduled_at || r.created_at,
    createdAt: r.created_at,
    recurrenceHuman: r.recurrence_human || null,
    activity: activities,
    executions: executions,
    tokensUsed: { prompt: r.tokens_in || 0, completion: r.tokens_out || 0 },
    cost: r.cout || 0,
  };
}

// ─── DB Query Functions ───────────────────────────────────────────────────────

async function getAllModeles() {
  const { rows } = await pool.query('SELECT * FROM modeles ORDER BY created_at ASC');
  return rows.map(rowToModele);
}

async function getAllRecurrences() {
  const { rows } = await pool.query('SELECT * FROM recurrences ORDER BY created_at ASC');
  return rows.map(rowToRecurrence);
}

const TASKS_CACHE_KEY = 'clawboard:tasks';
const TASKS_CACHE_TTL = 4; // secondes

async function getAllTasks() {
  // Lit depuis le cache Redis si disponible
  const cached = await cacheGet(TASKS_CACHE_KEY).catch(() => null);
  if (cached) return cached;

  const { rows: tasks } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
  if (tasks.length === 0) {
    await cacheSet(TASKS_CACHE_KEY, [], TASKS_CACHE_TTL).catch(() => {});
    return [];
  }
  const ids = tasks.map(t => t.id);
  const { rows: acts } = await pool.query(
    'SELECT * FROM task_activities WHERE task_id = ANY($1) ORDER BY created_at ASC', [ids]
  );
  const { rows: execs } = await pool.query(
    'SELECT * FROM task_executions WHERE task_id = ANY($1) ORDER BY created_at DESC', [ids]
  );
  const actsByTask = {}, execsByTask = {};
  for (const a of acts)  (actsByTask[a.task_id]  ??= []).push(rowToActivity(a));
  for (const e of execs) (execsByTask[e.task_id] ??= []).push(rowToExecution(e));
  const result = tasks.map(t => rowToTask(t, actsByTask[t.id] || [], execsByTask[t.id] || []));
  await cacheSet(TASKS_CACHE_KEY, result, TASKS_CACHE_TTL).catch(() => {});
  return result;
}

/** Invalide le cache des tâches — à appeler après chaque write. */
async function invalidateTasksCache() {
  await cacheDel(TASKS_CACHE_KEY).catch(() => {});
}

/** Invalide le cache, recharge les tâches depuis DB et broadcast SSE. */
async function broadcastTasks() {
  await invalidateTasksCache();
  const tasks = await getAllTasks();
  broadcast(sseClients.tasks, tasks);
  return tasks;
}

async function getTaskById(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const { rows: acts }  = await pool.query('SELECT * FROM task_activities WHERE task_id=$1 ORDER BY created_at ASC', [id]);
  const { rows: execs } = await pool.query('SELECT * FROM task_executions WHERE task_id=$1 ORDER BY created_at DESC', [id]);
  return rowToTask(rows[0], acts.map(rowToActivity), execs.map(rowToExecution));
}

async function getPreInstructions() {
  const { rows } = await pool.query('SELECT * FROM pre_instructions WHERE id=1');
  return rows[0] ? { content: rows[0].content, savedAt: rows[0].saved_at } : { content: '', savedAt: null };
}

async function getAllSkills() {
  const { rows } = await pool.query('SELECT * FROM skills ORDER BY created_at ASC');
  return rows.map(r => ({ id: r.id, name: r.name || r.nom, description: r.description, contenu: r.content || r.contenu, tags: r.tags || [], createdAt: r.created_at, updatedAt: r.updated_at }));
}

async function getAllMemoryDocs() {
  const { rows } = await pool.query('SELECT * FROM memory_docs ORDER BY created_at ASC');
  return rows.map(r => ({ id: r.id, title: r.titre, content: r.content, chars: r.chars, embedding: r.embedding, tags: r.tags || [], createdAt: r.created_at, updatedAt: r.updated_at }));
}

async function getAllGuardrails() {
  const { rows } = await pool.query('SELECT * FROM guardrails ORDER BY id ASC');
  return rows.map(r => ({ id: r.id, name: r.name || r.nom, description: r.description, enabled: r.enabled ?? r.actif, type: r.type, config: r.config || {} }));
}

async function getPipeline() {
  const { rows } = await pool.query('SELECT * FROM pipeline WHERE id=1');
  return rows[0] ? { nodes: rows[0].nodes, edges: rows[0].edges, savedAt: rows[0].updated_at } : { nodes: [], edges: [], savedAt: null };
}

// ─── Phase 2 migration (idempotent ALTER TABLE) ───────────────────────────────

async function runPhase2Migration() {
  await pool.query(`
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS skill_name TEXT;
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS agent TEXT DEFAULT 'main';
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS canal TEXT;
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS destinataire TEXT;
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS llm_model TEXT;
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS disable_pre_instructions BOOLEAN DEFAULT false;
    ALTER TABLE modeles ADD COLUMN IF NOT EXISTS execution_count INTEGER DEFAULT 0;

    ALTER TABLE recurrences ADD COLUMN IF NOT EXISTS human_label TEXT;
    ALTER TABLE recurrences ADD COLUMN IF NOT EXISTS llm_model TEXT;

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS modele_id TEXT;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent TEXT DEFAULT 'main';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skill_name TEXT;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_human TEXT;

    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS duration INTEGER;
    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0;
    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0;
    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS exit_code INTEGER;
    ALTER TABLE task_executions ADD COLUMN IF NOT EXISTS stdout TEXT;

    ALTER TABLE task_activities ADD COLUMN IF NOT EXISTS label TEXT;

    CREATE TABLE IF NOT EXISTS crons (
      id TEXT PRIMARY KEY,
      nom TEXT NOT NULL,
      interval TEXT NOT NULL DEFAULT '1h',
      agent_id TEXT DEFAULT 'agent-main',
      llm_mode TEXT DEFAULT 'hybrid',
      mode TEXT DEFAULT 'always',
      mode_config JSONB DEFAULT '{}',
      actif BOOLEAN DEFAULT true,
      last_run TIMESTAMPTZ,
      next_run TIMESTAMPTZ,
      run_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // pgvector : migrer embedding JSONB → vector(1536) si disponible
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const embCol = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='memory_docs' AND column_name='embedding'`);
    if (embCol.rows[0]?.data_type === 'jsonb') {
      await pool.query(`ALTER TABLE memory_docs DROP COLUMN embedding`);
      await pool.query(`ALTER TABLE memory_docs ADD COLUMN embedding vector(1536)`);
      console.log('[DB] memory_docs.embedding migré JSONB → vector(1536)');
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS memory_docs_embedding_hnsw ON memory_docs USING hnsw (embedding vector_cosine_ops)`);
  } catch (e) {
    console.warn('[DB] pgvector non disponible — fonctionnalités embeddings désactivées:', e.message);
  }

  // Table settings (TOTP + configs générales clé/valeur)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  // Colonne status/category dans skills (pour plugins)
  await pool.query(`
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'local';
  `).catch(() => {});

  // run_count dans recurrences
  await pool.query(`
    ALTER TABLE recurrences ADD COLUMN IF NOT EXISTS run_count INTEGER DEFAULT 0;
  `).catch(() => {});

  console.log('[DB] Phase 2 migration OK');
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

const SEED_MODELES = [
  { id: 'mod_001', name: 'Check InBox',            skillName: 'inbox-monitor',              instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: true,  executionCount: 9  },
  { id: 'mod_002', name: 'X Trends',               skillName: 'twitter-trends-analyzer',    instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: false, executionCount: 2  },
  { id: 'mod_003', name: 'YouTube Trends',          skillName: 'youtube-competitor-watch',   instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: false, executionCount: 2  },
  { id: 'mod_004', name: 'Backlog Idées YouTube',   skillName: 'youtube-ideas-backlog',      instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: true,  executionCount: 2  },
  { id: 'mod_005', name: 'Planning du jour',        skillName: 'morning-briefing',           instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'kimi-k2.5',                                 disablePreInstructions: false, executionCount: 12 },
  { id: 'mod_006', name: 'Mémoire Quotidienne',     skillName: null, instructions: "Rédige la note mémoire du jour. Résume ce qui s'est passé aujourd'hui ou indique que c'était un jour de maintenance routinière.", agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'kimi-k2.5', disablePreInstructions: false, executionCount: 3 },
  { id: 'mod_007', name: 'Sauvegarde OpenClaw',     skillName: null, instructions: 'bash /Users/mireillemonin/.openclaw/workspace/scripts/backup-openclaw.sh', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'kimi-k2.5', disablePreInstructions: false, executionCount: 0 },
  { id: 'mod_008', name: 'Analyse Accélérateur IA', skillName: 'accélérateur-ia-analyse',    instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: false, executionCount: 2  },
  { id: 'mod_009', name: 'MAJ OpenClaw / ClawHub',  skillName: 'update-openclaw',            instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: true,  executionCount: 2  },
  { id: 'mod_010', name: 'Audit Newsletter',         skillName: 'newsletter-audit',           instructions: '', agent: 'main', canal: 'discord', destinataire: '147873345753440121', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', disablePreInstructions: false, executionCount: 3  },
];

const SEED_RECURRENCES = [
  { id: 'rec_001', name: 'Analyse Accélérateur IA', cronExpr: '0 10 1,15 * *',           human: '1 et 15 du mois à 10h',        timezone: 'Europe/Paris', modeleId: 'mod_008', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: true,  nextRun: '2026-03-15T10:00:00' },
  { id: 'rec_002', name: 'Sauvegarde OpenClaw',      cronExpr: '0 3 * * *',               human: 'Quotidien à 3h',               timezone: 'Europe/Paris', modeleId: 'mod_007', llmModel: 'kimi-k2.5',                                 active: true,  nextRun: '2026-03-06T03:00:00' },
  { id: 'rec_003', name: 'Mémoire Quotidienne',      cronExpr: '45 2 * * *',              human: 'Quotidien à 2h45',             timezone: 'Europe/Paris', modeleId: 'mod_006', llmModel: 'kimi-k2.5',                                 active: true,  nextRun: '2026-03-06T02:45:00' },
  { id: 'rec_004', name: 'X Trends',                 cronExpr: '0 7 * * *',               human: 'Quotidien à 7h',               timezone: 'Europe/Paris', modeleId: 'mod_002', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: true,  nextRun: '2026-03-06T07:00:00' },
  { id: 'rec_005', name: 'YouTube Trends',            cronExpr: '10 7 * * *',              human: 'Quotidien à 7h10',             timezone: 'Europe/Paris', modeleId: 'mod_003', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: false, nextRun: null },
  { id: 'rec_006', name: 'Backlog Idées YouTube',     cronExpr: '30 7 * * *',              human: 'Quotidien à 7h30',             timezone: 'Europe/Paris', modeleId: 'mod_004', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: true,  nextRun: '2026-03-06T07:30:00' },
  { id: 'rec_007', name: 'MAJ OpenClaw / ClawHub',   cronExpr: '0 4 * * 0',               human: 'Dimanche à 4h',                timezone: 'Europe/Paris', modeleId: 'mod_009', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: true,  nextRun: '2026-03-06T04:00:00' },
  { id: 'rec_008', name: 'Planning du jour',          cronExpr: '43 7 * * 1-5',            human: 'Lun-Ven à 7h43',               timezone: 'Europe/Paris', modeleId: 'mod_005', llmModel: 'kimi-k2.5',                                 active: true,  nextRun: '2026-03-06T07:43:00' },
  { id: 'rec_009', name: 'Check InBox',               cronExpr: '0 7,11,15,19 * * 1-5',   human: 'Lun-Ven à 7h, 11h, 15h, 19h', timezone: 'Europe/Paris', modeleId: 'mod_001', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: true,  nextRun: '2026-03-05T19:00:00' },
  { id: 'rec_010', name: 'Audit Newsletter',           cronExpr: '0 9 1 * *',               human: 'Mensuel le 1er à 9h',          timezone: 'Europe/Paris', modeleId: 'mod_010', llmModel: 'openrouter/anthropic/claude-sonnet-4.6', active: false, nextRun: null },
];

const SEED_PREINSTRUCTIONS = `IMPORTANT : Si tu rencontres des erreurs, des blocages ou des instructions confuses, signale-les dans ton rapport final.

Ne tente PAS d'envoyer de messages Discord toi-même. La delivery est gérée automatiquement par le système cron.

## Output

Chaque exécution produit UN SEUL fichier Markdown dans ~/.openclaw/workspace/reports/. Nomme-le avec la date et le nom de la tâche (ex : 2026-03-02-analyse-twitter.md). Écris tout dans ce fichier unique : résultats, analyses, notes. Ne crée pas d'autres fichiers sauf si la tâche le demande explicitement.`;

const SEED_GUARDRAILS = [
  { id: 'npm',        nom: 'NPM Packages (Allowlist)',   actif: true  },
  { id: 'pypi',       nom: 'PyPI Packages (Allowlist)',  actif: true  },
  { id: 'network',    nom: 'Network Outbound (All)',      actif: false },
  { id: 'filesystem', nom: 'File System (Root Access)',   actif: false },
  { id: 'pii',        nom: 'PII Privacy Router',          actif: true  },
  { id: 'sandbox',    nom: 'Code Sandbox',                actif: true  },
];

const SEED_QUOTAS = [
  { modele: 'claude-sonnet-4.6', used: 0, limit_val: 100000, cost: 0, is_local: false },
  { modele: 'kimi-k2.5',         used: 0, limit_val: 50000,  cost: 0, is_local: false },
  { modele: 'ollama/qwen2.5',    used: 0, limit_val: null,   cost: 0, is_local: true  },
];

async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM modeles');
  if (parseInt(rows[0].cnt) > 0) { console.log('[DB] Tables already seeded.'); return; }
  console.log('[DB] Seeding initial data...');

  for (const m of SEED_MODELES) {
    await pool.query(
      `INSERT INTO modeles (id, name, instructions, skill_name, agent, canal, destinataire, llm_model, disable_pre_instructions, execution_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [m.id, m.name, m.instructions, m.skillName, m.agent, m.canal, m.destinataire, m.llmModel, m.disablePreInstructions, m.executionCount]
    );
  }

  for (const r of SEED_RECURRENCES) {
    await pool.query(
      `INSERT INTO recurrences (id, name, cron_expr, human, timezone, modele_id, llm_model, active, next_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [r.id, r.name, r.cronExpr, r.human, r.timezone, r.modeleId, r.llmModel, r.active, r.nextRun]
    );
  }

  await pool.query(
    `INSERT INTO pre_instructions (id, content, saved_at) VALUES (1,$1,NOW()) ON CONFLICT DO NOTHING`,
    [SEED_PREINSTRUCTIONS]
  );

  for (const g of SEED_GUARDRAILS) {
    await pool.query(
      `INSERT INTO guardrails (id, name, enabled) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [g.id, g.nom, g.actif]
    );
  }

  for (const q of SEED_QUOTAS) {
    await pool.query(
      `INSERT INTO quotas (modele, used, limit_val, cost, is_local) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [q.modele, q.used, q.limit_val, q.cost, q.is_local]
    );
  }

  await pool.query(`INSERT INTO pipeline (id, nodes, edges) VALUES (1,'[]','[]') ON CONFLICT DO NOTHING`);
  console.log('[DB] Seed complete.');
}

// ─── In-memory cache (API keys + quotas — loaded from DB at startup) ──────────

let apiKeys = {};
let quotas  = {};
let totalCost24h = 0;

// ─── Agents — in-memory fleet (enrichi depuis /api/tasks quand branché) ───────

const AGENTS = new Map([
  ['main',  { id: 'main',  label: 'NemoClaw Router',  role: 'Main Orchestrator',   model: 'claude-sonnet-4-6', status: 'active',  parentId: null,   position: { x: 300, y: 50  } }],
  ['sub1',  { id: 'sub1',  label: 'Code Architect',   role: 'Software Engineer',   model: 'llama-3.2',         status: 'active',  parentId: 'main', position: { x: 50,  y: 300 } }],
  ['sub2',  { id: 'sub2',  label: 'Data Analyst',     role: 'Data processing',     model: 'claude-haiku-4-5',  status: 'offline', parentId: 'main', position: { x: 300, y: 300 } }],
  ['sub3',  { id: 'sub3',  label: 'Security Scanner', role: 'Vulnerability check', model: 'qwen-2.5',          status: 'active',  parentId: 'main', position: { x: 550, y: 300 } }],
]);

// ─── Notifications config — in-memory (persisted to DB as a memory doc optionally) ─

let notificationsConfig = {
  telegram_token: '', telegram_chat_id: '',
  discord_webhook: '',
  email_smtp: '', email_from: '', email_to: '',
  webhook_url: '',
  notify_on_task_done: true, notify_on_task_failed: true, notify_on_approval: true,
};

async function loadApiKeys() {
  const { rows } = await pool.query('SELECT provider, encrypted_value FROM api_keys');
  apiKeys = {};
  for (const r of rows) apiKeys[r.provider] = r.encrypted_value;
}

async function loadQuotas() {
  const { rows } = await pool.query('SELECT * FROM quotas');
  quotas = {}; totalCost24h = 0;
  for (const r of rows) {
    quotas[r.modele] = { used: r.used, limit: r.limit_val, cost: r.cost, local: r.is_local };
    totalCost24h += r.cost || 0;
  }
}

// ─── SSE + vitals ─────────────────────────────────────────────────────────────

const sseClients = { vitals: new Set(), quota: new Set(), tasks: new Set(), logs: {}, approvals: new Set() };

// ─── Approval queue (in-memory, Human-in-the-loop) ────────────────────────────
const approvalQueue = new Map(); // id -> ApprovalRequest

// Poll OpenShell every 20s for blocked sandbox requests
setInterval(() => {
  const cmd = `wsl -d Ubuntu -- bash -c "curl -sk https://127.0.0.1:8080/api/v1/requests?status=blocked 2>/dev/null"`;
  exec(cmd, { timeout: 8000 }, (err, stdout) => {
    if (!stdout) return;
    try {
      const raw = JSON.parse(stdout);
      const requests = (Array.isArray(raw) ? raw : (raw.requests || raw.items || []));
      for (const r of requests) {
        const id = `os_${r.id || r.requestId}`;
        if (approvalQueue.has(id)) continue;
        const item = {
          id, taskId: r.sandbox || 'my-assistant', taskName: `Sandbox ${r.sandbox || 'my-assistant'}`,
          agent: r.sandbox || 'my-assistant',
          reason: `Requête réseau bloquée : ${r.method || 'GET'} ${r.url || r.host || 'inconnu'}`,
          riskLevel: 'medium', requestedAt: r.timestamp || new Date().toISOString(),
          payload: r, _openShellId: r.id || r.requestId,
        };
        approvalQueue.set(id, item);
        const event = `event: approval\ndata: ${JSON.stringify(item)}\n\n`;
        for (const c of sseClients.approvals) { try { c.write(event); } catch { sseClients.approvals.delete(c); } }
      }
    } catch { /* OpenShell not responding or no blocked requests */ }
  });
}, 20000);

function broadcast(set, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(msg); } catch (_) {} }
}

let prevCpu = os.cpus();
function getCpuUsage() {
  const cpus = os.cpus(); let idle = 0, tick = 0;
  cpus.forEach((c, i) => {
    const p = prevCpu[i] || c;
    for (const k in c.times) tick += c.times[k] - (p.times[k] || 0);
    idle += c.times.idle - (p.times.idle || 0);
  });
  prevCpu = cpus;
  return tick === 0 ? 0 : Math.round((1 - idle / tick) * 100);
}

function getVitals() {
  const tot = os.totalmem(), fr = os.freemem(), used = tot - fr;
  return { cpu: getCpuUsage(), ram: { used: Math.round(used/1024/1024), total: Math.round(tot/1024/1024), pct: Math.round(used/tot*100) }, uptime: Math.round(os.uptime()), platform: os.platform(), hostname: os.hostname() };
}

setInterval(async () => {
  broadcast(sseClients.vitals, getVitals());
  broadcast(sseClients.quota, { quotas, totalCost24h });
  try {
    const allTasks = await getAllTasks();
    broadcast(sseClients.tasks, allTasks);
  } catch (e) { console.error('[SSE] broadcast tasks:', e.message); }
}, 2000);

// ─── Lia Chat — system prompt + tools ────────────────────────────────────────

const LIA_SYSTEM = `Tu es Lia, l'assistante IA agentique intégrée à ClawBoard (Nemoclaw). Tu AGIS, tu ne décris pas.

RÈGLE ABSOLUE — TOUJOURS AGIR :
- Quand l'utilisateur demande de créer des tâches → appeler batch_create_tasks ou create_task IMMÉDIATEMENT
- Quand il demande un plan/roadmap → créer les tâches ET les modèles avec create_modele
- Quand il demande d'automatiser → créer les CRONs avec create_cron
- Quand il dit "mémorise" ou "retiens" → appeler save_note
- Ne JAMAIS lister des actions à faire — les FAIRE avec les outils disponibles
- Ne JAMAIS demander confirmation sauf pour une suppression définitive
- Ne JAMAIS répondre "je vais créer..." sans l'avoir fait

OUTILS DISPONIBLES (utiliser sans attendre) :
• batch_create_tasks — créer plusieurs tâches d'un coup
• create_task — créer une tâche
• create_modele — créer un modèle/template réutilisable
• create_cron — créer une récurrence planifiée (CRON)
• save_note — sauvegarder une note en mémoire
• list_tasks / get_task / start_task / patch_task / delete_task
• list_modeles / list_recurrences
• list_directory / read_file — analyser des fichiers locaux

FORMAT DE RÉPONSE :
- Toujours en français
- Concis et direct (pas de raisonnement interne affiché)
- Après avoir agi : résumer ce qui a été fait ("✅ J'ai créé X tâches : ...")
- Markdown pour la mise en forme
- Si chemin de fichier mentionné → utiliser list_directory ou read_file directement`;

const LIA_TOOLS = [
  { name: 'list_tasks',       description: 'Liste toutes les tâches du système.',              input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_task',         description: 'Récupère les détails complets d\'une tâche.',        input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'create_task',      description: 'Crée une nouvelle tâche.',                          input_schema: { type: 'object', properties: { name: { type: 'string' }, modeleId: { type: 'string' }, agent: { type: 'string' }, skillName: { type: 'string' }, scheduledAt: { type: 'string' } }, required: ['name'] } },
  { name: 'start_task',       description: 'Démarre l\'exécution d\'une tâche existante.',      input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'delete_task',      description: 'Supprime définitivement une tâche.',                input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'patch_task',       description: 'Modifie les champs d\'une tâche existante.',        input_schema: { type: 'object', properties: { taskId: { type: 'string' }, updates: { type: 'object' } }, required: ['taskId', 'updates'] } },
  { name: 'list_modeles',     description: 'Liste tous les modèles/templates disponibles.',     input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_recurrences', description: 'Liste toutes les récurrences CRON configurées.',    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_directory',    description: 'Liste le contenu d\'un dossier local (chemin absolu).', input_schema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] } },
  { name: 'read_file',         description: 'Lit le contenu d\'un fichier texte local.', input_schema: { type: 'object', properties: { path: { type: 'string' }, maxLines: { type: 'number' } }, required: ['path'] } },
  { name: 'batch_create_tasks',description: 'Crée plusieurs tâches d\'un seul coup. Utiliser quand l\'utilisateur demande de créer un plan ou plusieurs tâches.', input_schema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, agent: { type: 'string' }, skillName: { type: 'string' } }, required: ['name'] }, description: 'Liste des tâches à créer' } }, required: ['tasks'] } },
  { name: 'create_modele',     description: 'Crée un modèle/template de tâche réutilisable avec instructions.', input_schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' }, agent: { type: 'string' }, llmModel: { type: 'string' } }, required: ['name', 'instructions'] } },
  { name: 'create_cron',       description: 'Crée une récurrence CRON planifiée. Utiliser pour automatiser des tâches périodiques.', input_schema: { type: 'object', properties: { name: { type: 'string' }, cronExpr: { type: 'string', description: 'Expression CRON, ex: "0 9 * * 1-5" pour lun-ven à 9h' }, human: { type: 'string', description: 'Description humaine du CRON' }, modeleId: { type: 'string' }, timezone: { type: 'string', description: 'Fuseau horaire, ex: Europe/Paris' } }, required: ['name', 'cronExpr'] } },
  { name: 'save_note',         description: 'Sauvegarde une note importante en mémoire (NOTES.md). Utiliser pour retenir des infos projet, décisions, contexte.', input_schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, category: { type: 'string', description: 'Ex: projet, décision, tâche, bug' } }, required: ['title', 'content'] } },
];

async function executeTool(name, input, permissions) {
  if (permissions[name] === false) {
    return { __denied: true, message: `Permission "${name}" désactivée. Activez-la dans le panneau de permissions.` };
  }
  switch (name) {
    case 'list_tasks': {
      const tasks = await getAllTasks();
      return { tasks: tasks.map(t => ({ id: t.id, name: t.name, status: t.status, agent: t.agent, cost: t.cost, tokensUsed: t.tokensUsed, scheduledAt: t.scheduledAt })) };
    }
    case 'get_task': {
      const t = await getTaskById(input.taskId);
      return t || { error: `Tâche "${input.taskId}" introuvable.` };
    }
    case 'create_task': {
      const id = `tsk_${Date.now()}`;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO tasks (id, titre, modele_id, statut, agent, skill_name, scheduled_at, created_at, updated_at, cout, tokens_in, tokens_out)
         VALUES ($1,$2,$3,'planned',$4,$5,$6,$7,$7,0,0,0)`,
        [id, input.name, input.modeleId || null, input.agent || 'main', input.skillName || null, input.scheduledAt || now, now]
      );
      await pool.query(
        `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'created','Tâche créée par Lia','Tâche créée par Lia',$2)`,
        [id, now]
      );
      await broadcastTasks();
      return { created: { id, name: input.name, status: 'planned' } };
    }
    case 'start_task': {
      const task = await getTaskById(input.taskId);
      if (!task) return { error: `Tâche "${input.taskId}" introuvable.` };
      const now = new Date().toISOString();
      await pool.query(`UPDATE tasks SET statut='running', updated_at=$2 WHERE id=$1`, [task.id, now]);
      await pool.query(
        `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'launched','Exécution lancée par Lia','Exécution lancée par Lia',$2)`,
        [task.id, now]
      );
      await pool.query(
        `INSERT INTO task_executions (task_id, statut, cout, tokens_in, tokens_out, started_at, prompt_tokens, completion_tokens) VALUES ($1,'running',0,0,0,$2,0,0)`,
        [task.id, now]
      );
      await broadcastTasks();
      setTimeout(async () => {
        try {
          const dur = Math.floor(Math.random() * 60 + 10);
          const doneNow = new Date().toISOString();
          const cost = Math.round(Math.random() * 0.4 * 10000) / 10000;
          const tokIn = Math.floor(Math.random() * 30000 + 3000);
          const tokOut = Math.floor(Math.random() * 1500 + 100);
          await pool.query(
            `UPDATE tasks SET statut='completed', updated_at=$2, cout=$3, tokens_in=$4, tokens_out=$5, completed_at=$2 WHERE id=$1`,
            [task.id, doneNow, cost, tokIn, tokOut]
          );
          await pool.query(
            `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'completed',$2,$2,$3)`,
            [task.id, `Terminée en ${dur}s`, doneNow]
          );
          await broadcastTasks();
        } catch (e) { console.error('[executeTool.start_task]', e.message); }
      }, 3000);
      return { ok: true, taskId: task.id, status: 'running' };
    }
    case 'delete_task': {
      const { rowCount } = await pool.query('DELETE FROM tasks WHERE id=$1', [input.taskId]);
      if (!rowCount) return { error: `Tâche "${input.taskId}" introuvable.` };
      await broadcastTasks();
      return { ok: true, deleted: input.taskId };
    }
    case 'patch_task': {
      const task = await getTaskById(input.taskId);
      if (!task) return { error: `Tâche "${input.taskId}" introuvable.` };
      const safe = sanitizeObject(input.updates);
      const setClauses = [], vals = [input.taskId];
      if (safe.status       !== undefined) setClauses.push(`statut=$${vals.push(safe.status)}`);
      if (safe.name         !== undefined) setClauses.push(`titre=$${vals.push(safe.name)}`);
      if (safe.instructions !== undefined) setClauses.push(`instructions=$${vals.push(safe.instructions)}`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE tasks SET ${setClauses.join(',')}, updated_at=NOW() WHERE id=$1`, vals);
      }
      const updated = await getTaskById(input.taskId);
      await broadcastTasks();
      return { ok: true, updated };
    }
    case 'list_modeles': {
      const mods = await getAllModeles();
      return { modeles: mods.map(m => ({ id: m.id, name: m.name, skillName: m.skillName, llmModel: m.llmModel, executionCount: m.executionCount })) };
    }
    case 'list_recurrences': {
      const recs = await getAllRecurrences();
      return { recurrences: recs.map(r => ({ id: r.id, name: r.name, human: r.human, active: r.active, nextRun: r.nextRun })) };
    }
    case 'batch_create_tasks': {
      const tasks = input.tasks || [];
      if (!tasks.length) return { error: 'Aucune tâche à créer.' };
      const created = [];
      for (const t of tasks.slice(0, 20)) {
        const id = `tsk_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        const now = new Date().toISOString();
        const fullName = t.name + (t.description ? ` — ${t.description}` : '');
        await pool.query(
          `INSERT INTO tasks (id, titre, modele_id, statut, agent, skill_name, scheduled_at, created_at, updated_at, cout, tokens_in, tokens_out)
           VALUES ($1,$2,$3,'planned',$4,$5,$6,$7,$7,0,0,0)`,
          [id, fullName.slice(0, 200), null, t.agent || 'main', t.skillName || null, now, now]
        );
        await pool.query(`INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'created','Créée par Lia','Créée par Lia',$2)`, [id, now]);
        created.push({ id, name: fullName, agent: t.agent || 'main' });
        await new Promise(r => setTimeout(r, 30));
      }
      await broadcastTasks();
      return { created, count: created.length };
    }
    case 'create_modele': {
      const id = `mod_${Date.now()}`;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO modeles (id, name, description, instructions, agent, llm_model, created_at, updated_at, execution_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0)
         ON CONFLICT (id) DO NOTHING`,
        [id, input.name, input.description || '', input.instructions || '', input.agent || 'main', input.llmModel || 'meta/llama-3.3-70b-instruct', now]
      ).catch(async () => {
        // Fallback if table schema differs
        await pool.query(`INSERT INTO modeles (id, nom, description, instructions, agent, llm_model, created_at, updated_at, execution_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0)`, [id, input.name, input.description || '', input.instructions || '', input.agent || 'main', input.llmModel || 'meta/llama-3.3-70b-instruct', now]);
      });
      return { created: { id, name: input.name } };
    }
    case 'create_cron': {
      const id = `rec_${Date.now()}`;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO recurrences (id, name, cron_expr, human, timezone, modele_id, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)`,
        [id, input.name, input.cronExpr, input.human || input.cronExpr, input.timezone || 'Europe/Paris', input.modeleId || null, now]
      ).catch(() => {}); // table might have different schema
      return { created: { id, name: input.name, cronExpr: input.cronExpr, human: input.human || input.cronExpr } };
    }
    case 'save_note': {
      const timestamp = new Date().toLocaleString('fr-FR');
      const entry = `\n## [${input.category || 'note'}] ${input.title}\n*${timestamp}*\n\n${input.content}\n`;
      const { rows } = await pool.query(`SELECT id, content FROM memory WHERE filename='NOTES.md' LIMIT 1`).catch(() => ({ rows: [] }));
      if (rows.length) {
        await pool.query(`UPDATE memory SET content=$1, updated_at=NOW() WHERE id=$2`, [(rows[0].content || '') + entry, rows[0].id]);
      } else {
        await pool.query(`INSERT INTO memory (id, filename, content, type, created_at, updated_at) VALUES ($1,'NOTES.md',$2,'note',NOW(),NOW())`, [`mem_${Date.now()}`, `# Notes Lia\n${entry}`]).catch(() => {});
      }
      return { saved: true, title: input.title };
    }
    case 'list_directory': {
      try {
        const dirPath = input.path;
        if (!isPathAllowed(dirPath)) return { __denied: true, message: `⛔ Accès refusé : \`${dirPath}\` n'est pas dans les chemins autorisés. Configurez les accès dans **Paramètres → Accès Fichiers**.` };
        if (!existsSync(dirPath)) return { error: `Dossier introuvable : ${dirPath}` };
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) return { error: `Ce chemin n'est pas un dossier : ${dirPath}` };
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const files = entries.map(e => {
          try {
            const fullPath = pathJoin(dirPath, e.name);
            const s = statSync(fullPath);
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? s.size : null, ext: e.isFile() ? extname(e.name) : null };
          } catch { return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' }; }
        });
        const dirs = files.filter(f => f.type === 'dir');
        const fileList = files.filter(f => f.type === 'file');
        if (input.recursive) {
          const walk = (p, depth = 0) => {
            if (depth > 3) return [];
            try { return readdirSync(p, { withFileTypes: true }).flatMap(e => { const fp = pathJoin(p, e.name); return e.isDirectory() ? [{ name: fp.replace(dirPath, ''), type: 'dir' }, ...walk(fp, depth + 1)] : [{ name: fp.replace(dirPath, ''), type: 'file', ext: extname(e.name) }]; }); } catch { return []; }
          };
          return { path: dirPath, total: files.length, entries: walk(dirPath).slice(0, 200) };
        }
        return { path: dirPath, total: files.length, dirs: dirs.map(d => d.name), files: fileList.map(f => `${f.name} (${f.size != null ? (f.size > 1024 ? Math.round(f.size/1024)+'KB' : f.size+'B') : '?'})`) };
      } catch (e) { return { error: `Erreur lecture dossier : ${e.message}` }; }
    }
    case 'read_file': {
      try {
        const filePath = input.path;
        if (!isPathAllowed(filePath)) return { __denied: true, message: `⛔ Accès refusé : \`${filePath}\` n'est pas dans les chemins autorisés. Configurez les accès dans **Paramètres → Accès Fichiers**.` };
        if (!existsSync(filePath)) return { error: `Fichier introuvable : ${filePath}` };
        const stat = statSync(filePath);
        if (stat.isDirectory()) return { error: `C'est un dossier, pas un fichier. Utilisez list_directory.` };
        if (stat.size > 500 * 1024) return { error: `Fichier trop grand (${Math.round(stat.size/1024)}KB). Max 500KB.` };
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const maxL = input.maxLines || 150;
        const truncated = lines.length > maxL;
        return { path: filePath, lines: lines.length, truncated, content: lines.slice(0, maxL).join('\n') + (truncated ? `\n\n… [${lines.length - maxL} lignes supplémentaires tronquées]` : '') };
      } catch (e) { return { error: `Erreur lecture fichier : ${e.message}` }; }
    }
    default:
      return { error: `Outil inconnu: ${name}` };
  }
}

// ── Smart mock (no API key) ───────────────────────────────────────────────────

async function smartMock(messages, permissions) {
  const last = messages.filter(m => m.role === 'user').pop()?.content || '';
  const text = (Array.isArray(last) ? last.find(c => c.type === 'text')?.text : last) || '';
  const lower = text.toLowerCase();
  const toolCalls = [];

  const run = async (name, input) => {
    const r = await executeTool(name, input, permissions);
    toolCalls.push({ tool: name, input, result: r });
    return r;
  };

  // ── Filesystem via smartMock ───────────────────────────────────────────────
  const paths = extractPaths(text);
  if (paths.length) {
    const toolCalls2 = [];
    const parts = [];
    for (const p of paths.slice(0, 2)) {
      try {
        const s = statSync(p);
        if (s.isDirectory()) {
          const r = await executeTool('list_directory', { path: p }, permissions);
          if (!r.error) { toolCalls2.push({ tool: 'list_directory', input: { path: p }, result: r }); parts.push(`**📁 \`${p}\`** — ${r.total} entrées\n\n**Dossiers :** ${r.dirs?.slice(0,15).join(', ') || 'aucun'}\n**Fichiers :** ${r.files?.slice(0,20).join('\n• ') || 'aucun'}`); }
        } else {
          const r = await executeTool('read_file', { path: p, maxLines: 60 }, permissions);
          if (!r.error) { toolCalls2.push({ tool: 'read_file', input: { path: p }, result: r }); parts.push(`**📄 \`${p}\`** — ${r.lines} lignes\n\n\`\`\`\n${r.content}\n\`\`\``); }
        }
      } catch { parts.push(`❌ Impossible d'accéder à \`${p}\``); }
    }
    if (parts.length) return { message: parts.join('\n\n'), toolCalls: toolCalls2 };
  }
  if (lower.match(/reexplique|ré-?explique|explain again|clarifi/)) {
    return { message: `Bien sûr ! Voici un résumé de ce qui s'est passé :\n\nJe suis **Lia**, l'assistante intégrée à ClawBoard. Pour l'instant, le modèle sélectionné ne répond pas correctement — je fonctionne en **mode démo**.\n\nEssayez de changer de modèle (ex: *Llama 3.3 70B* ou *Mixtral 8x22B*) dans le sélecteur en haut, puis répétez votre demande.`, toolCalls: [] };
  }
  if (lower.match(/bonjour|salut|hello|hey|coucou|lia/)) {
    return { message: `Bonjour ! Je suis **Lia**, votre assistante ClawBoard. 👋\n\nJe peux gérer vos tâches :\n• 📋 *"Liste mes tâches"*\n• ▶️ *"Démarre tsk_001"*\n• ➕ *"Crée une tâche nommée Test"*\n• 🗑️ *"Supprime tsk_005"*\n• 📊 *"Montre-moi les modèles"*\n\n> Mode démo — Ajoutez \`ANTHROPIC_API_KEY\` pour connecter le vrai Claude.`, toolCalls: [] };
  }
  if (lower.match(/tâches?|tasks?|liste|affich|montr|voir/)) {
    const r = await run('list_tasks', {});
    const tks = r.tasks || [];
    const groups = { planned: '📅', running: '▶️', completed: '✅', failed: '❌' };
    const lines = tks.map(t => `${groups[t.status] || '•'} **${t.name || t.id}** \`${t.id}\` — ${t.status}`).join('\n');
    return { message: `**${tks.length} tâches** dans le système :\n\n${lines || '_(aucune)_'}`, toolCalls };
  }
  if (lower.match(/démarre|lance|exécute|start|run/)) {
    const match = text.match(/tsk_\w+/i);
    if (match) {
      const r = await run('start_task', { taskId: match[0] });
      if (r.__denied) return { message: `⛔ ${r.message}`, toolCalls: [] };
      return { message: r.error ? `❌ ${r.error}` : `▶️ Tâche \`${match[0]}\` **démarrée** ! Elle passera en *completed* dans ~3s.`, toolCalls };
    }
  }
  if (lower.match(/supprim|delet|effac|remove/)) {
    const match = text.match(/tsk_\w+/i);
    if (match) {
      if (permissions.delete_task === false) return { message: `⛔ Permission **delete_task** désactivée.`, toolCalls: [] };
      const r = await run('delete_task', { taskId: match[0] });
      return { message: r.error ? `❌ ${r.error}` : `🗑️ Tâche \`${match[0]}\` **supprimée** du système.`, toolCalls };
    }
  }
  if (lower.match(/plan|roadmap|impl[eé]ment|int[eé]gr|crée?r?\s+(?:les?\s+)?t[aâ]ches?|plusieurs t[aâ]ches?/)) {
    // Extract task names from numbered lists in the message
    const lines = text.split('\n').filter(l => l.match(/^\s*[\d\-\*•]\s*[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ]/));
    const taskNames = lines.map(l => l.replace(/^\s*[\d\-\*•\.]+\s*/, '').trim()).filter(Boolean);
    if (taskNames.length >= 2) {
      const tasks = taskNames.slice(0, 10).map(name => ({ name, agent: 'main' }));
      const r = await run('batch_create_tasks', { tasks });
      if (r.__denied) return { message: `⛔ ${r.message}`, toolCalls: [] };
      return { message: `✅ **${r.count} tâches créées** !\n\n${r.created?.map((t, i) => `${i+1}. \`${t.id}\` — **${t.name}**`).join('\n') || ''}`, toolCalls };
    }
  }
  if (lower.match(/crée?r?|crée|nouveau|nouvelle|ajouter?|add/) && lower.match(/t[aâ]che|task/)) {
    const nameMatch = text.match(/(?:t[aâ]che|task)\s+(?:nommée?|appelée?|:)?\s*[«""]?([^"»\n]+)[»""]?/i);
    const name = nameMatch ? nameMatch[1].trim() : `Tâche Lia — ${new Date().toLocaleTimeString('fr-FR')}`;
    const r = await run('create_task', { name, agent: 'main' });
    if (r.__denied) return { message: `⛔ ${r.message}`, toolCalls: [] };
    return { message: `✅ Tâche **"${name}"** créée !\n\nID : \`${r.created?.id || '—'}\`\nStatut : *planifié*`, toolCalls };
  }
  if (lower.match(/modèle|modele|template/)) {
    const r = await run('list_modeles', {});
    const mods = (r.modeles || []).slice(0, 10);
    return { message: `**${r.modeles?.length || 0} modèles** disponibles :\n\n${mods.map(m => `• **${m.name}** \`${m.id}\` — ${m.skillName || 'instructions libres'}`).join('\n')}`, toolCalls };
  }
  if (lower.match(/récurrences?|cron|planif/)) {
    const r = await run('list_recurrences', {});
    const recs = r.recurrences || [];
    const active = recs.filter(r => r.active);
    return { message: `**${active.length} récurrences actives** sur ${recs.length} :\n\n${active.map(r => `• **${r.name}** — ${r.human}`).join('\n')}`, toolCalls };
  }
  return {
    message: `Je suis en **mode démo** (sans clé API Anthropic).\n\nEssayez :\n• *"Liste mes tâches"*\n• *"Crée une tâche nommée MonTest"*\n• *"Démarre tsk_001"*\n• *"Montre les modèles"*\n\nConfigurez \`ANTHROPIC_API_KEY\` pour le vrai Claude.`,
    toolCalls: [],
  };
}

// ── Ollama chat (local) ───────────────────────────────────────────────────────

async function callOllama(messages, model) {
  const ollamaModel = model.replace('ollama/', '');
  const resp = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))],
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`Ollama error ${resp.status}`);
  const data = await resp.json();
  return { message: data.message?.content || '', toolCalls: [] };
}

// ── Anthropic agentic loop ────────────────────────────────────────────────────

async function callAnthropic(messages, model, permissions) {
  const apiKey = (apiKeys.anthropic && decryptKey(apiKeys.anthropic)) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const anthropicModel = model.startsWith('claude') ? model : 'claude-sonnet-4-6';
  const allowedTools = LIA_TOOLS.filter(t => permissions[t.name] !== false);
  const allToolCalls = [];
  let msgs = messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content : m.content }));

  for (let i = 0; i < 8; i++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: anthropicModel, max_tokens: 1500, system: LIA_SYSTEM, tools: allowedTools, messages: msgs }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API ${resp.status}`);
    }
    const data = await resp.json();

    if (data.stop_reason === 'end_turn') {
      const text = data.content.find(c => c.type === 'text')?.text || '';
      return { message: text, toolCalls: allToolCalls };
    }
    if (data.stop_reason === 'tool_use') {
      const uses = data.content.filter(c => c.type === 'tool_use');
      const results = [];
      for (const tu of uses) {
        const result = await executeTool(tu.name, tu.input, permissions);
        allToolCalls.push({ tool: tu.name, input: tu.input, result });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      msgs = [...msgs, { role: 'assistant', content: data.content }, { role: 'user', content: results }];
    }
  }
  return { message: 'Boucle agentique : limite atteinte.', toolCalls: allToolCalls };
}

async function callOpenRouter(messages, model) {
  const key = (apiKeys.openrouter && decryptKey(apiKeys.openrouter)) || process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'ClawBoard Lia' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))], max_tokens: 1500 }),
  });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `OpenRouter ${resp.status}`); }
  const data = await resp.json();
  return { message: data.choices?.[0]?.message?.content || '', toolCalls: [] };
}

const NVIDIA_THINKING_MODELS = ['nemotron-ultra', 'nemotron-super', 'qwq', 'deepseek-r1', 'deepseek-v3'];

async function callNvidia(messages, model, activeTools = null) {
  const key = (apiKeys.nvidia && decryptKey(apiKeys.nvidia)) || process.env.NVIDIA_API_KEY;
  if (!key) return null;
  const isThinking = NVIDIA_THINKING_MODELS.some(t => model.toLowerCase().includes(t));
  // Models that support OpenAI-compatible function calling
  const TOOL_CAPABLE = ['llama-3', 'llama-4', 'mistral', 'mixtral', 'nemotron', 'qwen'];
  const supportsTools = TOOL_CAPABLE.some(t => model.toLowerCase().includes(t));
  // Use dynamic (filtered) tools if provided, otherwise all tools
  const toolsToSend = (activeTools || LIA_TOOLS);
  const nvidiaTools = toolsToSend.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const msgs = [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))];
  const body = { model, messages: msgs, max_tokens: 2000, temperature: 0.7, stream: false };
  if (supportsTools) { body.tools = nvidiaTools; body.tool_choice = 'auto'; }
  if (isThinking) body.chat_template_kwargs = { thinking: { type: 'disabled' } };
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `NVIDIA NIM ${resp.status}`); }
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  // Handle tool calls from the model (structured field)
  if (msg?.tool_calls?.length) {
    return { message: null, _toolCalls: msg.tool_calls, _msgs: msgs };
  }
  const raw = msg?.content || msg?.reasoning_content || '';
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Fallback: detect tool call JSON written in text content (some models output JSON instead of tool_calls field)
  // Supports: {"type":"function","name":"...","parameters":{...}} or multiple objects
  const syntheticToolCalls = [];
  const jsonPattern = /\{[\s\S]*?"type"\s*:\s*"function"[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?\}/g;
  let jsonMatch;
  let textToParse = clean;
  while ((jsonMatch = jsonPattern.exec(textToParse)) !== null) {
    try {
      // Find balanced JSON object
      let start = jsonMatch.index, depth = 0, end = -1;
      for (let i = start; i < textToParse.length; i++) {
        if (textToParse[i] === '{') depth++;
        else if (textToParse[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;
      const obj = JSON.parse(textToParse.slice(start, end + 1));
      const fnName = obj.name || obj.function?.name;
      const fnArgs = obj.parameters || obj.arguments || obj.input || {};
      if (fnName) {
        syntheticToolCalls.push({ id: `call_${Date.now()}_${syntheticToolCalls.length}`, function: { name: fnName, arguments: JSON.stringify(fnArgs) } });
      }
    } catch { /* ignore malformed */ }
  }
  if (syntheticToolCalls.length) {
    return { message: null, _toolCalls: syntheticToolCalls, _msgs: msgs };
  }
  return { message: clean, toolCalls: [] };
}

async function pipeOpenAIStream(upstreamResp, res) {
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let thinkBuf = '';   // accumulates <think> block
  let inThink = false; // true while inside <think>...</think>
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta;
        // Ignore reasoning_content (internal thinking) — only use content
        let token = delta?.content || '';
        if (!token) continue;
        // Filter <think>...</think> blocks streamed token by token
        thinkBuf += token;
        let out = '';
        while (true) {
          if (inThink) {
            const end = thinkBuf.indexOf('</think>');
            if (end === -1) { thinkBuf = thinkBuf.slice(-20); break; } // keep tail in case tag split
            inThink = false;
            thinkBuf = thinkBuf.slice(end + 8);
          } else {
            const start = thinkBuf.indexOf('<think>');
            if (start === -1) { out += thinkBuf; thinkBuf = ''; break; }
            out += thinkBuf.slice(0, start);
            inThink = true;
            thinkBuf = thinkBuf.slice(start + 7);
          }
        }
        if (out) res.write(`data: ${JSON.stringify({ token: out })}\n\n`);
      } catch { /* skip malformed */ }
    }
  }
}

async function simulateStream(text, res) {
  const words = text.split(/(?<= )/);
  for (const word of words) {
    res.write(`data: ${JSON.stringify({ token: word })}\n\n`);
    await new Promise(r => setTimeout(r, 12));
  }
}

async function streamNvidia(messages, model, res) {
  const key = (apiKeys.nvidia && decryptKey(apiKeys.nvidia)) || process.env.NVIDIA_API_KEY;
  if (!key) { await simulateStream('❌ Clé API NVIDIA non configurée. Ajoutez-la dans **Paramètres → Clés API**.', res); return; }
  const isThinking = NVIDIA_THINKING_MODELS.some(t => model.toLowerCase().includes(t));
  const body = { model, messages: [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))], max_tokens: 1500, temperature: 0.7, stream: true };
  if (isThinking) body.chat_template_kwargs = { thinking: { type: 'disabled' } };
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify(body) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); await simulateStream(`❌ Erreur NVIDIA : ${e.error?.message || resp.status}`, res); return; }
  await pipeOpenAIStream(resp, res);
}

async function streamAnthropic(messages, model, permissions, res) {
  const key = (apiKeys.anthropic && decryptKey(apiKeys.anthropic)) || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const mock = await smartMock(messages, permissions);
    await simulateStream(mock.message, res);
    res.write(`data: ${JSON.stringify({ done: true, toolCalls: mock.toolCalls || [] })}\n\n`);
    return;
  }
  const fullResult = await callAnthropic(messages, model, permissions);
  await simulateStream(fullResult?.message || '', res);
  res.write(`data: ${JSON.stringify({ done: true, toolCalls: fullResult?.toolCalls || [] })}\n\n`);
}

async function callGemini(messages, model) {
  const key = (apiKeys.gemini && decryptKey(apiKeys.gemini)) || process.env.GEMINI_API_KEY;
  if (!key) return null;
  const geminiModel = model.replace('gemini/', '') || 'gemini-2.0-flash';
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }] }));
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: LIA_SYSTEM }] }, contents }) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `Gemini ${resp.status}`); }
  const data = await resp.json();
  return { message: data.candidates?.[0]?.content?.parts?.[0]?.text || '', toolCalls: [] };
}

// ── Kimi (MoonshotAI) — clé DB: "moonshot" ───────────────────────────────────
async function callKimi(messages, model) {
  const key = (apiKeys.moonshot && decryptKey(apiKeys.moonshot)) || (apiKeys.kimi && decryptKey(apiKeys.kimi));
  if (!key) return null;
  const kimiModel = model.replace('kimi/', '') || 'kimi-latest';
  const msgs = [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))];
  const resp = await fetch('https://api.moonshot.cn/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: kimiModel, messages: msgs, max_tokens: 1500, temperature: 0.7 }) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `Kimi ${resp.status}`); }
  const data = await resp.json();
  const clean = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { message: clean, toolCalls: [] };
}

// ── MiniMax ───────────────────────────────────────────────────────────────────
async function callMinimax(messages, model) {
  const key = apiKeys.minimax && decryptKey(apiKeys.minimax);
  if (!key) return null;
  const mmModel = model.replace('minimax/', '') || 'MiniMax-Text-01';
  const msgs = [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))];
  // MiniMax uses OpenAI-compatible endpoint
  const resp = await fetch('https://api.minimaxi.chat/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: mmModel, messages: msgs, max_tokens: 1500, temperature: 0.7 }) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `MiniMax ${resp.status}`); }
  const data = await resp.json();
  const clean = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { message: clean, toolCalls: [] };
}

// ── Zhipu AI (GLM) ────────────────────────────────────────────────────────────
async function callZhipu(messages, model) {
  const key = apiKeys.zhipu && decryptKey(apiKeys.zhipu);
  if (!key) return null;
  const glmModel = model.replace('zhipu/', '') || 'glm-4-flash';
  const msgs = [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))];
  const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: glmModel, messages: msgs, max_tokens: 1500, temperature: 0.7 }) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `Zhipu ${resp.status}`); }
  const data = await resp.json();
  const clean = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { message: clean, toolCalls: [] };
}

// ── DeepSeek (direct API) — clé DB: "deepseek" ───────────────────────────────
async function callDeepSeek(messages, model) {
  const key = apiKeys.deepseek && decryptKey(apiKeys.deepseek);
  if (!key) return null;
  const dsModel = model.replace('deepseek/', '') || 'deepseek-chat';
  const msgs = [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))];
  const resp = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: dsModel, messages: msgs, max_tokens: 1500, temperature: 0.7 }) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `DeepSeek ${resp.status}`); }
  const data = await resp.json();
  const clean = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { message: clean, toolCalls: [] };
}

// ── Filesystem Access Control ─────────────────────────────────────────────────
// Chemins TOUJOURS bloqués (sensibles OS / credentials)
const FS_BLOCKED = [
  'windows', 'system32', 'syswow64', 'program files', 'programdata',
  'appdata\\roaming', 'appdata\\local\\microsoft', 'appdata\\local\\google',
  '/.ssh', '/.gnupg', '/etc/passwd', '/etc/shadow', '/etc/hosts',
  'node_modules', '.git\\objects', '.env', 'secrets', 'credentials',
  'id_rsa', 'id_ed25519', '.pem', '.key', '.pfx', '.p12',
];
// Chemins autorisés par défaut (Desktop et projet en cours)
let fsAllowedPaths = [
  'C:\\Users\\BOB\\Desktop',
  'C:\\Users\\BOB\\Documents',
  pathJoin(dirname(fileURLToPath(import.meta.url))), // répertoire du projet
];
let fsGlobalEnabled = true; // peut être désactivé globalement

function isPathAllowed(p) {
  if (!fsGlobalEnabled) return false;
  const norm = p.replace(/\//g, '\\').toLowerCase();
  // Blocked keywords
  if (FS_BLOCKED.some(b => norm.includes(b.toLowerCase()))) return false;
  // Must be under an allowed root
  const allowed = fsAllowedPaths.some(root => norm.startsWith(root.replace(/\//g, '\\').toLowerCase()));
  return allowed;
}

// ── Filesystem context injection for non-tool-calling models ──────────────────
function extractPaths(text) {
  const paths = [];
  // Windows paths — greedy match, stops at quotes/newlines (allows spaces in dir names)
  // Order: quoted paths first, then unquoted
  const winQuoted = [...text.matchAll(/[""`]([A-Za-z]:\\[^"'`\n]+)[""`]/g)].map(m => m[1]);
  const winUnquoted = [...text.matchAll(/(?<![\\])([A-Za-z]:\\(?:[^"'`\n<>|?*]+\\)*[^"'`\n<>|?*]*)/g)].map(m => m[1].trimEnd().replace(/[.,;:!?)]+$/, ''));
  // Unix paths (Linux/Mac style)
  const unixMatches = [...text.matchAll(/(?:^|[\s"'`])((?:\/[\w.\- ]+)+)/g)].map(m => m[1]);
  for (const p of [...winQuoted, ...winUnquoted, ...unixMatches]) {
    const clean = p.trim();
    if (clean.length > 3) {
      // Try exact match, then trimmed versions
      if (existsSync(clean)) { paths.push(clean); continue; }
      // Try removing trailing word (path might include part of sentence)
      const parent = clean.replace(/\\[^\\]+$/, '');
      if (parent.length > 3 && existsSync(parent)) paths.push(parent);
    }
  }
  return [...new Set(paths)];
}

async function injectFilesystemContext(messages) {
  const last = messages.filter(m => m.role === 'user').pop()?.content || '';
  const text = (Array.isArray(last) ? last.find(c => c.type === 'text')?.text : last) || '';
  const paths = extractPaths(text);
  if (!paths.length) return messages;
  const contextParts = [];
  for (const p of paths.slice(0, 3)) {
    try {
      const stat = statSync(p);
      if (stat.isDirectory()) {
        const result = await executeTool('list_directory', { path: p }, {});
        if (!result.error) {
          const dirs = result.dirs?.slice(0, 20).join(', ') || '';
          const files = result.files?.slice(0, 30).join(', ') || '';
          contextParts.push(`**Dossier \`${p}\`** (${result.total} entrées) :\n📁 Sous-dossiers : ${dirs || 'aucun'}\n📄 Fichiers : ${files || 'aucun'}`);
        }
      } else {
        const result = await executeTool('read_file', { path: p, maxLines: 80 }, {});
        if (!result.error) contextParts.push(`**Fichier \`${p}\`** (${result.lines} lignes) :\n\`\`\`\n${result.content}\n\`\`\``);
      }
    } catch { /* skip */ }
  }
  if (!contextParts.length) return messages;
  // Inject as assistant context message before the last user message
  const injected = { role: 'user', content: `[CONTEXTE SYSTÈME — Contenu des fichiers/dossiers mentionnés]\n\n${contextParts.join('\n\n')}\n\n[Fin du contexte]` };
  const allButLast = messages.slice(0, -1);
  const lastMsg = messages[messages.length - 1];
  return [...allButLast, injected, lastMsg];
}

// ── Token optimization helpers ────────────────────────────────────────────────

// 1. Sliding window: garder seulement les N derniers messages (économise 30-50%)
const MAX_HISTORY_MESSAGES = 20;

// 2. Dynamic tool loading: inclure seulement les outils pertinents au contexte
function selectRelevantTools(userText, allTools) {
  const t = userText.toLowerCase();
  const always = ['list_tasks', 'create_task', 'batch_create_tasks', 'save_note'];
  const conditional = {
    'get_task|tsk_': ['get_task'],
    'start|démarre|lance|exécute': ['start_task'],
    'supprim|delet|efface': ['delete_task'],
    'modif|patch|change': ['patch_task'],
    'modèle|template|modele': ['list_modeles', 'create_modele'],
    'récurr|cron|planif|auto': ['list_recurrences', 'create_cron'],
    'dossier|fichier|chemin|c:\\\\|/home/|/var/': ['list_directory', 'read_file'],
  };
  const needed = new Set(always);
  for (const [pattern, tools] of Object.entries(conditional)) {
    if (t.match(new RegExp(pattern, 'i'))) tools.forEach(n => needed.add(n));
  }
  return allTools.filter(tool => needed.has(tool.name));
}

// 3. Trim large tool results (évite l'accumulation dans la boucle agentique)
function trimToolResult(result, maxChars = 800) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= maxChars) return result;
  try { return JSON.parse(str.slice(0, maxChars) + '...'); } catch { return str.slice(0, maxChars) + '…'; }
}

// 4. Sliding window sur l'historique
function applySliding(messages) {
  const system = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  if (nonSystem.length <= MAX_HISTORY_MESSAGES) return messages;
  // Always keep first user message as context anchor
  const first = nonSystem[0];
  const recent = nonSystem.slice(-MAX_HISTORY_MESSAGES + 1);
  return [...system, first, ...recent];
}

async function runAgenticLoop(messages, model, permissions) {
  try {
    if (model.startsWith('ollama/')) return await callOllama(messages, model);
    const NVIDIA_PREFIXES = ['nvidia/', 'meta/', 'mistralai/', 'microsoft/', 'deepseek-ai/', 'qwen/', 'moonshotai/', 'google/gemma', 'ibm/', 'writer/', 'bytedance/', 'openai/gpt-oss', 'minimaxai/', 'z-ai/', 'stepfun-ai/', 'thudm/', 'ai21labs/', 'databricks/', 'snowflake/', 'tiiuae/', 'upstage/', 'bigcode/', 'rakuten/', 'sarvamai/'];
    if (NVIDIA_PREFIXES.some(p => model.startsWith(p))) {
      // Optimisation 1: sliding window sur l'historique
      const windowed = applySliding(messages);
      // Optimisation 2: injection filesystem si chemin détecté
      const enriched = await injectFilesystemContext(windowed);
      // Optimisation 3: dynamic tool selection (réduire les tokens de tools)
      const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
      const userText = Array.isArray(lastUserMsg) ? lastUserMsg.find(c => c.type === 'text')?.text || '' : lastUserMsg;
      // Agentic loop with tool calling (up to 5 rounds)
      let currentMsgs = enriched;
      const allToolCalls = [];
      for (let round = 0; round < 5; round++) {
        const r = await callNvidia(currentMsgs, model, selectRelevantTools(userText, LIA_TOOLS));
        if (!r) return { message: `❌ Clé API NVIDIA non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
        if (!r._toolCalls) return { message: r.message || '', toolCalls: allToolCalls };
        // Execute tool calls
        const toolResultMsgs = [];
        for (const tc of r._toolCalls) {
          const fnName = tc.function?.name;
          let fnInput = {};
          try { fnInput = JSON.parse(tc.function?.arguments || '{}'); } catch { fnInput = {}; }
          const result = await executeTool(fnName, fnInput, permissions);
          // Optimisation 4: tronquer les résultats volumineux
          const trimmed = trimToolResult(result);
          allToolCalls.push({ tool: fnName, input: fnInput, result });
          toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, name: fnName, content: JSON.stringify(trimmed) });
        }
        currentMsgs = [...currentMsgs, { role: 'assistant', tool_calls: r._toolCalls, content: null }, ...toolResultMsgs];
      }
      return { message: '✅ Actions effectuées.', toolCalls: allToolCalls };
    }
    // Apply sliding window to all providers
    const slim = applySliding(messages);
    if (model.startsWith('gemini/') || model.startsWith('gemini-')) {
      const r = await callGemini(slim, model);
      return r || { message: `❌ Clé API Gemini non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
    }
    if (model.startsWith('kimi/')) {
      const r = await callKimi(slim, model);
      return r || { message: `❌ Clé API Kimi non configurée. Ajoutez-la dans **Paramètres → Clés API** (provider : kimi).`, toolCalls: [] };
    }
    if (model.startsWith('minimax/')) {
      const r = await callMinimax(slim, model);
      return r || { message: `❌ Clé API MiniMax non configurée. Ajoutez-la dans **Paramètres → Clés API** (provider : minimax).`, toolCalls: [] };
    }
    if (model.startsWith('zhipu/')) {
      const r = await callZhipu(slim, model);
      return r || { message: `❌ Clé API Zhipu non configurée. Ajoutez-la dans **Paramètres → Clés API** (provider : zhipu).`, toolCalls: [] };
    }
    if (model.startsWith('deepseek/')) {
      const r = await callDeepSeek(slim, model);
      return r || { message: `❌ Clé API DeepSeek non configurée. Ajoutez-la dans **Paramètres → Clés API** (provider : deepseek).`, toolCalls: [] };
    }
    if (model.startsWith('openrouter/') && !model.includes('claude')) {
      const r = await callOpenRouter(slim, model);
      return r || { message: `❌ Clé API OpenRouter non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
    }
    const anthropicResult = await callAnthropic(slim, model, permissions);
    if (anthropicResult) return anthropicResult;
    return await smartMock(messages, permissions);
  } catch (e) {
    return { message: `❌ Erreur API : ${e.message}`, toolCalls: [] };
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const origin = req.headers['origin'] || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const isPublic = !path.startsWith('/api/')
    || PUBLIC_PREFIXES.some(p => path.startsWith(p))
    || (path === '/api/tasks' && req.method === 'GET' && url.searchParams.get('stream') === '1');
  if (!isPublic && !requireAuth(req, res)) return;

  const sse = (set) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':ok\n\n'); set.add(res); req.on('close', () => set.delete(res));
  };
  const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const body = (cb) => {
    let b = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { req.destroy(); json(413, { error: 'Payload too large (max 1MB)' }); return; }
      b += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(b);
        Promise.resolve(cb(parsed)).catch(err => {
          console.error('[ROUTE]', err.message);
          if (!res.writableEnded) json(500, { error: err.message });
        });
      } catch { json(400, { error: 'Bad JSON' }); }
    });
  };

  // ── Ping / Health
  if (path === '/api/ping')   return json(200, { ok: true, ts: Date.now() });
  if (path === '/api/health') return json(200, { status: 'ok', ts: Date.now(), db: 'postgres', version: '1.0.0' });

  // ── Proxy ping (pour éviter CORS dans CollaborationModule) ──────────────────
  if (path === '/api/proxy-ping' && req.method === 'POST') {
    body(async ({ url, apiKey }) => {
      if (!url) return json(400, { error: 'url required' });
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        let data = {};
        try { data = await r.json(); } catch (_) {}
        json(r.ok ? 200 : 502, { ok: r.ok, status: r.status, data });
      } catch (e) { json(502, { ok: false, error: e.message }); }
    });
    return;
  }

  // ── Ollama management ────────────────────────────────────────────────────────
  const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';

  if (path === '/api/ollama/status' && req.method === 'GET') {
    (async () => {
      try {
        const r = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return json(200, { running: false });
        const d = await r.json();
        json(200, { running: true, version: d.version });
      } catch { json(200, { running: false }); }
    })();
    return;
  }

  if (path === '/api/ollama/models' && req.method === 'GET') {
    (async () => {
      try {
        const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return json(503, { error: 'Ollama unreachable' });
        const d = await r.json();
        json(200, { models: d.models || [] });
      } catch (e) { json(503, { error: e.message }); }
    })();
    return;
  }

  if (path === '/api/ollama/pull' && req.method === 'POST') {
    body(async ({ name }) => {
      if (!name) return json(400, { error: 'name required' });
      try {
        const r = await fetch(`${OLLAMA}/api/pull`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, stream: true }),
        });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try { res.write(`data: ${line}\n\n`); } catch (_) {}
          }
        }
        res.write('data: {"status":"done"}\n\n');
        res.end();
      } catch (e) { try { json(503, { error: e.message }); } catch (_) {} }
    });
    return;
  }

  if (path.startsWith('/api/ollama/models/') && req.method === 'DELETE') {
    const modelName = decodeURIComponent(path.slice('/api/ollama/models/'.length));
    (async () => {
      try {
        const r = await fetch(`${OLLAMA}/api/delete`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName }),
        });
        r.ok ? json(200, { ok: true }) : json(503, { error: 'Delete failed' });
      } catch (e) { json(503, { error: e.message }); }
    })();
    return;
  }

  if (path === '/api/ollama/start' && req.method === 'POST') {
    (async () => {
      try {
        const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: true });
        proc.unref();
        let started = false;
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const r = await fetch('http://localhost:11434/api/version', { signal: AbortSignal.timeout(1000) });
            if (r.ok) { started = true; break; }
          } catch { /* still starting */ }
        }
        json(200, { ok: started, message: started ? 'Ollama démarré' : 'Démarrage en cours…' });
      } catch (e) { json(500, { ok: false, error: e.message }); }
    })();
    return;
  }

  // ── SSE streams
  if (path === '/api/vitals') { sse(sseClients.vitals); res.write(`data: ${JSON.stringify(getVitals())}\n\n`); return; }
  if (path === '/api/quota')  { sse(sseClients.quota);  res.write(`data: ${JSON.stringify({ quotas, totalCost24h })}\n\n`); return; }
  if (path === '/api/tasks' && req.method === 'GET' && url.searchParams.get('stream') === '1') {
    sse(sseClients.tasks);
    getAllTasks().then(t => { try { res.write(`data: ${JSON.stringify(t)}\n\n`); } catch (_) {} });
    return;
  }

  // ── Tasks REST
  if (path === '/api/tasks' && req.method === 'GET') {
    getAllTasks().then(t => json(200, t)).catch(err => json(500, { error: err.message }));
    return;
  }
  if (path === '/api/tasks' && req.method === 'POST') {
    body(async b => {
      const id  = `tsk_${Date.now()}`;
      const now = new Date().toISOString();
      const safe = sanitizeObject(b);
      await pool.query(
        `INSERT INTO tasks (id, titre, modele_id, statut, priorite, agent, skill_name, instructions, scheduled_at, recurrence_human, created_at, updated_at, cout, tokens_in, tokens_out)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,0,0,0)`,
        [id, safe.name || safe.titre || 'Sans titre', safe.modeleId || null, safe.status || 'planifie', safe.priorite || 'normale', safe.agent || 'main', safe.skillName || null, safe.instructions || null, safe.scheduledAt || now, safe.recurrenceHuman || null, now]
      );
      await pool.query(
        `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'created','Tâche créée','Tâche créée',$2)`,
        [id, now]
      );
      await broadcastTasks();
      const task = await getTaskById(id);
      json(201, task);
    });
    return;
  }

  const taskMatch    = path.match(/^\/api\/tasks\/([^/]+)$/);
  const taskRunMatch = path.match(/^\/api\/tasks\/([^/]+)\/run$/);

  if (taskRunMatch && req.method === 'POST') {
    getTaskById(taskRunMatch[1]).then(async task => {
      if (!task) return json(404, { error: 'Not found' });
      const now = new Date().toISOString();
      await pool.query(`UPDATE tasks SET statut='running', updated_at=$2, started_at=$2 WHERE id=$1`, [task.id, now]);
      await pool.query(
        `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'launched','Exécution lancée','Exécution lancée',$2)`,
        [task.id, now]
      );
      await pool.query(
        `INSERT INTO task_executions (task_id, statut, cout, tokens_in, tokens_out, started_at, prompt_tokens, completion_tokens) VALUES ($1,'running',0,0,0,$2,0,0)`,
        [task.id, now]
      );
      await broadcastTasks();
      json(200, { ok: true });
      setTimeout(async () => {
        try {
          const dur = Math.floor(Math.random() * 60 + 10);
          const doneNow = new Date().toISOString();
          const cost  = Math.round(Math.random() * 0.5 * 10000) / 10000;
          const tokIn  = Math.floor(Math.random() * 50000 + 5000);
          const tokOut = Math.floor(Math.random() * 2000 + 200);
          const stdout = `✅ Tâche relancée manuellement\n\nDurée : ${dur}s\n\n## Résultat\nExécution complétée avec succès.`;
          await pool.query(
            `UPDATE tasks SET statut='completed', updated_at=$2, cout=$3, tokens_in=$4, tokens_out=$5, completed_at=$2 WHERE id=$1`,
            [task.id, doneNow, cost, tokIn, tokOut]
          );
          await pool.query(
            `UPDATE task_executions SET statut='completed', cout=$3, tokens_in=$4, tokens_out=$5, duration=$6, exit_code=0, stdout=$7 WHERE task_id=$1 AND started_at=$2`,
            [task.id, now, cost, tokIn, tokOut, dur * 1000, stdout]
          );
          await pool.query(
            `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'completed',$2,$2,$3)`,
            [task.id, `Exécution terminée en ${dur}s`, doneNow]
          );
          await broadcastTasks();
        } catch (e) { console.error('[/run]', e.message); }
      }, 3000);
    }).catch(err => json(500, { error: err.message }));
    return;
  }

  if (taskMatch && req.method === 'GET') {
    getTaskById(taskMatch[1]).then(t => json(t ? 200 : 404, t || { error: 'Not found' })).catch(err => json(500, { error: err.message }));
    return;
  }
  if (taskMatch && req.method === 'PATCH') {
    body(async b => {
      const { executions: _e, activity: _a, tokensUsed: _tk, ...rest } = b;
      const safe = sanitizeObject(rest);
      const setClauses = [], vals = [taskMatch[1]];
      if (safe.status       !== undefined) setClauses.push(`statut=$${vals.push(safe.status)}`);
      if (safe.name         !== undefined) setClauses.push(`titre=$${vals.push(safe.name)}`);
      if (safe.titre        !== undefined) setClauses.push(`titre=$${vals.push(safe.titre)}`);
      if (safe.description  !== undefined) setClauses.push(`description=$${vals.push(safe.description)}`);
      if (safe.instructions !== undefined) setClauses.push(`instructions=$${vals.push(safe.instructions)}`);
      if (safe.priorite     !== undefined) setClauses.push(`priorite=$${vals.push(safe.priorite)}`);
      if (safe.llm          !== undefined) setClauses.push(`llm=$${vals.push(safe.llm)}`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE tasks SET ${setClauses.join(',')}, updated_at=NOW() WHERE id=$1`, vals);
      }
      await broadcastTasks();
      const task = await getTaskById(taskMatch[1]);
      json(200, task);
    });
    return;
  }
  if (taskMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM tasks WHERE id=$1', [taskMatch[1]])
      .then(async () => { await broadcastTasks(); json(200, { ok: true }); })
      .catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Logs SSE
  const logMatch = path.match(/^\/api\/logs\/([^/]+)$/);
  if (logMatch && req.method === 'GET') {
    if (!sseClients.logs[logMatch[1]]) sseClients.logs[logMatch[1]] = new Set();
    sse(sseClients.logs[logMatch[1]]);
    getTaskById(logMatch[1]).then(task => {
      const lines = [`[BOOT] Task ${logMatch[1]} initialized`, `[INIT] Agent: ${task?.agent || 'main'}`, `[NET]  Connecting to inference backend...`, `[NET]  TLS handshake OK`, `[EXEC] Starting execution...`];
      let i = 0;
      const iv = setInterval(() => {
        const line = i < lines.length ? lines[i++] : `[LLM]  Completion chunk +${Math.floor(Math.random()*80+20)} tokens`;
        try { res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`); } catch (_) { clearInterval(iv); }
      }, 400);
      req.on('close', () => clearInterval(iv));
    }).catch(() => {
      const iv = setInterval(() => {
        try { res.write(`data: ${JSON.stringify({ line: `[LLM]  Chunk +${Math.floor(Math.random()*80+20)} tokens`, ts: new Date().toISOString() })}\n\n`); } catch (_) { clearInterval(iv); }
      }, 400);
      req.on('close', () => clearInterval(iv));
    });
    return;
  }

  // ── Modèles
  if (path === '/api/modeles' && req.method === 'GET') { getAllModeles().then(m => json(200, m)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/modeles' && req.method === 'POST') {
    body(async b => {
      const id = `mod_${Date.now()}`;
      const safe = sanitizeObject(b);
      const nomVal = safe.name || safe.nom || 'Sans nom';
      await pool.query(
        `INSERT INTO modeles (id, nom, name, description, instructions, skill_name, agent, canal, destinataire, llm_model, disable_pre_instructions, execution_count)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)`,
        [id, nomVal, safe.description || null, safe.instructions || null, safe.skillName || null, safe.agent || 'main', safe.canal || null, safe.destinataire || null, safe.llmModel || null, safe.disablePreInstructions || false]
      ).catch(async () => {
        // Fallback si certaines colonnes n'existent pas
        await pool.query(
          `INSERT INTO modeles (id, nom, instructions, agent, llm_model, execution_count) VALUES ($1,$2,$3,$4,$5,0)`,
          [id, nomVal, safe.instructions || null, safe.agent || 'main', safe.llmModel || null]
        );
      });
      const { rows } = await pool.query('SELECT * FROM modeles WHERE id=$1', [id]);
      json(201, rowToModele(rows[0]));
    });
    return;
  }
  const modMatch    = path.match(/^\/api\/modeles\/([^/]+)$/);
  const modRunMatch = path.match(/^\/api\/modeles\/([^/]+)\/run$/);

  if (modRunMatch && req.method === 'POST') {
    pool.query('SELECT * FROM modeles WHERE id=$1', [modRunMatch[1]]).then(async ({ rows }) => {
      if (!rows[0]) return json(404, { error: 'Not found' });
      const mod = rowToModele(rows[0]);
      const id  = `tsk_${Date.now()}`;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO tasks (id, titre, modele_id, statut, agent, skill_name, instructions, scheduled_at, recurrence_human, created_at, updated_at, started_at, cout, tokens_in, tokens_out)
         VALUES ($1,$2,$3,'running',$4,$5,$6,$7,'Manuel',$8,$8,$8,0,0,0)`,
        [id, mod.name, mod.id, mod.agent, mod.skillName, mod.instructions, now, now]
      );
      await pool.query(
        `INSERT INTO task_activities (task_id, type, label, message, created_at) VALUES ($1,'created','Tâche créée','Tâche créée',$2), ($1,'launched','Exécution lancée','Exécution lancée',$2)`,
        [id, now]
      );
      await pool.query(`UPDATE modeles SET execution_count=execution_count+1, updated_at=NOW() WHERE id=$1`, [mod.id]);
      await broadcastTasks();
      json(201, { ok: true, taskId: id });
    }).catch(err => json(500, { error: err.message }));
    return;
  }
  if (modMatch && req.method === 'PATCH') {
    body(async b => {
      const safe = sanitizeObject(b);
      const setClauses = [], vals = [modMatch[1]];
      if (safe.name                   !== undefined) setClauses.push(`nom=$${vals.push(safe.name)}`);
      if (safe.nom                    !== undefined) setClauses.push(`nom=$${vals.push(safe.nom)}`);
      if (safe.description            !== undefined) setClauses.push(`description=$${vals.push(safe.description)}`);
      if (safe.instructions           !== undefined) setClauses.push(`instructions=$${vals.push(safe.instructions)}`);
      if (safe.skillName              !== undefined) setClauses.push(`skill_name=$${vals.push(safe.skillName)}`);
      if (safe.agent                  !== undefined) setClauses.push(`agent=$${vals.push(safe.agent)}`);
      if (safe.canal                  !== undefined) setClauses.push(`canal=$${vals.push(safe.canal)}`);
      if (safe.destinataire           !== undefined) setClauses.push(`destinataire=$${vals.push(safe.destinataire)}`);
      if (safe.llmModel               !== undefined) setClauses.push(`llm_model=$${vals.push(safe.llmModel)}`);
      if (safe.disablePreInstructions !== undefined) setClauses.push(`disable_pre_instructions=$${vals.push(safe.disablePreInstructions)}`);
      if (safe.executionCount         !== undefined) setClauses.push(`execution_count=$${vals.push(safe.executionCount)}`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE modeles SET ${setClauses.join(',')}, updated_at=NOW() WHERE id=$1`, vals);
      }
      const { rows } = await pool.query('SELECT * FROM modeles WHERE id=$1', [modMatch[1]]);
      json(200, rows[0] ? rowToModele(rows[0]) : null);
    });
    return;
  }
  if (modMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM modeles WHERE id=$1', [modMatch[1]]).then(() => json(200, { ok: true })).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Récurrences
  if (path === '/api/recurrences' && req.method === 'GET') { getAllRecurrences().then(r => json(200, r)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/recurrences' && req.method === 'POST') {
    body(async b => {
      const id = `rec_${Date.now()}`;
      const safe = sanitizeObject(b);
      await pool.query(
        `INSERT INTO recurrences (id, name, cron_expr, human, timezone, modele_id, llm_model, active, next_run)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, safe.name || safe.nom || 'Sans nom', safe.cronExpr || safe.cron || '* * * * *', safe.human || null, safe.timezone || 'UTC', safe.modeleId || null, safe.llmModel || null, safe.active !== false, safe.nextRun || null]
      );
      const { rows } = await pool.query('SELECT * FROM recurrences WHERE id=$1', [id]);
      json(201, rowToRecurrence(rows[0]));
    });
    return;
  }
  const recMatch = path.match(/^\/api\/recurrences\/([^/]+)$/);
  if (recMatch && req.method === 'PATCH') {
    body(async b => {
      const safe = sanitizeObject(b);
      const setClauses = [], vals = [recMatch[1]];
      if (safe.name     !== undefined) setClauses.push(`name=$${vals.push(safe.name)}`);
      if (safe.nom      !== undefined) setClauses.push(`nom=$${vals.push(safe.nom)}`);
      if (safe.cronExpr !== undefined) setClauses.push(`cron=$${vals.push(safe.cronExpr)}`);
      if (safe.cron     !== undefined) setClauses.push(`cron=$${vals.push(safe.cron)}`);
      if (safe.human    !== undefined) setClauses.push(`human=$${vals.push(safe.human)}`);
      if (safe.timezone !== undefined) setClauses.push(`timezone=$${vals.push(safe.timezone)}`);
      if (safe.modeleId !== undefined) setClauses.push(`modele_id=$${vals.push(safe.modeleId)}`);
      if (safe.llmModel !== undefined) setClauses.push(`llm_model=$${vals.push(safe.llmModel)}`);
      if (safe.active   !== undefined) setClauses.push(`active=$${vals.push(safe.active)}`);
      if (safe.nextRun  !== undefined) setClauses.push(`next_run=$${vals.push(safe.nextRun)}`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE recurrences SET ${setClauses.join(',')} WHERE id=$1`, vals);
      }
      const { rows } = await pool.query('SELECT * FROM recurrences WHERE id=$1', [recMatch[1]]);
      json(200, rows[0] ? rowToRecurrence(rows[0]) : null);
    });
    return;
  }
  if (recMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM recurrences WHERE id=$1', [recMatch[1]]).then(() => json(200, { ok: true })).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Crons (Planificateur)
  if (path === '/api/crons' && req.method === 'GET') {
    pool.query('SELECT * FROM crons ORDER BY created_at ASC').then(({ rows }) => {
      json(200, rows.map(r => ({ id: r.id, name: r.nom, interval: r.interval, agentId: r.agent_id, llmMode: r.llm_mode, mode: r.mode, modeConfig: r.mode_config || {}, active: r.actif, lastRun: r.last_run, nextRun: r.next_run, runCount: r.run_count })));
    }).catch(err => json(500, { error: err.message }));
    return;
  }
  if (path === '/api/crons' && req.method === 'POST') {
    body(async b => {
      const id = `cron_${Date.now()}`;
      const safe = sanitizeObject(b);
      await pool.query(
        `INSERT INTO crons (id, nom, interval, agent_id, llm_mode, mode, mode_config, actif)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
        [id, safe.name || 'Sans nom', safe.interval || '1h', safe.agentId || 'agent-main', safe.llmMode || 'hybrid', safe.mode || 'always', safe.modeConfig || {}]
      );
      const { rows } = await pool.query('SELECT * FROM crons WHERE id=$1', [id]);
      const r = rows[0];
      json(201, { id: r.id, name: r.nom, interval: r.interval, agentId: r.agent_id, llmMode: r.llm_mode, mode: r.mode, modeConfig: r.mode_config || {}, active: r.actif, lastRun: r.last_run, nextRun: r.next_run, runCount: r.run_count });
    });
    return;
  }
  const cronMatch    = path.match(/^\/api\/crons\/([^/]+)$/);
  const cronRunMatch = path.match(/^\/api\/crons\/([^/]+)\/run$/);
  if (cronRunMatch && req.method === 'POST') {
    pool.query(`UPDATE crons SET last_run=NOW(), run_count=run_count+1 WHERE id=$1 RETURNING *`, [cronRunMatch[1]])
      .then(({ rows }) => {
        if (!rows[0]) return json(404, { error: 'Not found' });
        const r = rows[0];
        json(200, { ok: true, id: r.id, runCount: r.run_count });
      }).catch(err => json(500, { error: err.message }));
    return;
  }
  if (cronMatch && req.method === 'PATCH') {
    body(async b => {
      const safe = sanitizeObject(b);
      const setClauses = [], vals = [cronMatch[1]];
      if (safe.name     !== undefined) setClauses.push(`name=$${vals.push(safe.name)}`);
      if (safe.interval !== undefined) setClauses.push(`interval=$${vals.push(safe.interval)}`);
      if (safe.agentId  !== undefined) setClauses.push(`agent_id=$${vals.push(safe.agentId)}`);
      if (safe.llmMode  !== undefined) setClauses.push(`llm_mode=$${vals.push(safe.llmMode)}`);
      if (safe.mode     !== undefined) setClauses.push(`mode=$${vals.push(safe.mode)}`);
      if (safe.active   !== undefined) setClauses.push(`actif=$${vals.push(safe.active)}`);
      if (safe.nextRun  !== undefined) setClauses.push(`next_run=$${vals.push(safe.nextRun)}`);
      if (setClauses.length > 0) await pool.query(`UPDATE crons SET ${setClauses.join(',')} WHERE id=$1`, vals);
      const { rows } = await pool.query('SELECT * FROM crons WHERE id=$1', [cronMatch[1]]);
      const r = rows[0];
      json(200, r ? { id: r.id, name: r.nom, interval: r.interval, agentId: r.agent_id, llmMode: r.llm_mode, mode: r.mode, modeConfig: r.mode_config || {}, active: r.actif, lastRun: r.last_run, nextRun: r.next_run, runCount: r.run_count } : null);
    });
    return;
  }
  if (cronMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM crons WHERE id=$1', [cronMatch[1]]).then(() => json(200, { ok: true })).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Pré-instructions
  if (path === '/api/preinstructions' && req.method === 'GET') { getPreInstructions().then(p => json(200, p)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/preinstructions' && req.method === 'PUT') {
    body(async b => {
      const content = b.content || '';
      await pool.query(
        `INSERT INTO pre_instructions (id, content, saved_at) VALUES (1,$1,NOW()) ON CONFLICT (id) DO UPDATE SET content=$1, saved_at=NOW()`,
        [content]
      );
      json(200, { content, savedAt: new Date().toISOString() });
    });
    return;
  }

  // ── Archives (exécutions des tâches complétées)
  if (path === '/api/archives' && req.method === 'GET') {
    pool.query(`
      SELECT te.id, te.task_id, te.statut, te.cout, te.tokens_in, te.tokens_out, te.duree_ms,
             te.started_at, te.duration, te.prompt_tokens, te.completion_tokens, te.exit_code, te.stdout,
             t.titre AS task_name, t.skill_name
      FROM task_executions te
      JOIN tasks t ON t.id = te.task_id
      ORDER BY COALESCE(te.started_at, te.created_at) DESC
      LIMIT 100
    `).then(({ rows }) => {
      json(200, rows.map(r => ({
        id: String(r.id),
        taskName: r.task_name,
        skillName: r.skill_name,
        startedAt: r.started_at || r.created_at,
        duration: r.duration || r.duree_ms,
        promptTokens: r.prompt_tokens || r.tokens_in || 0,
        completionTokens: r.completion_tokens || r.tokens_out || 0,
        cost: r.cout || 0,
        exitCode: r.exit_code ?? (r.statut === 'completed' ? 0 : null),
        status: r.statut === 'completed' || r.exit_code === 0 ? 'ok' : 'error',
      })));
    }).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Skills
  if (path === '/api/skills' && req.method === 'GET') { getAllSkills().then(s => json(200, s)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/skills' && req.method === 'POST') {
    body(async b => {
      const id = `skl_${Date.now()}`;
      const safe = sanitizeObject(b);
      await pool.query(
        `INSERT INTO skills (id, nom, description, content, tags) VALUES ($1,$2,$3,$4,$5)`,
        [id, safe.name || safe.nom || 'Sans nom', safe.description || null, safe.contenu || safe.content || null, safe.tags || []]
      );
      const { rows } = await pool.query('SELECT * FROM skills WHERE id=$1', [id]);
      const r = rows[0];
      json(201, { id: r.id, name: r.nom || r.name, description: r.description, contenu: r.content, tags: r.tags });
    });
    return;
  }
  const sklMatch = path.match(/^\/api\/skills\/([^/]+)$/);
  if (sklMatch && req.method === 'PATCH') {
    body(async b => {
      const safe = sanitizeObject(b);
      const setClauses = [], vals = [sklMatch[1]];
      if (safe.name        !== undefined) setClauses.push(`nom=$${vals.push(safe.name)}`);
      if (safe.nom         !== undefined) setClauses.push(`nom=$${vals.push(safe.nom)}`);
      if (safe.description !== undefined) setClauses.push(`description=$${vals.push(safe.description)}`);
      if (safe.contenu     !== undefined) setClauses.push(`contenu=$${vals.push(safe.contenu)}`);
      if (safe.tags        !== undefined) setClauses.push(`tags=$${vals.push(safe.tags)}`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE skills SET ${setClauses.join(',')}, updated_at=NOW() WHERE id=$1`, vals);
      }
      const { rows } = await pool.query('SELECT * FROM skills WHERE id=$1', [sklMatch[1]]);
      const r = rows[0];
      json(200, r ? { id: r.id, name: r.nom, description: r.description, contenu: r.contenu, tags: r.tags } : null);
    });
    return;
  }
  if (sklMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM skills WHERE id=$1', [sklMatch[1]]).then(() => json(200, { ok: true })).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Memory (QMD)
  if (path === '/api/memory' && req.method === 'GET') {
    const q = url.searchParams.get('q');
    if (q && q.length >= 2) {
      pool.query(
        `SELECT * FROM memory_docs WHERE titre ILIKE $1 OR content ILIKE $1 OR $1 = ANY(tags::text[]) ORDER BY updated_at DESC LIMIT 30`,
        [`%${q}%`]
      ).then(({ rows }) => {
        json(200, rows.map(r => ({ id: r.id, title: r.titre, type: r.type || 'Document', content: r.content, chars: r.chars, tags: r.tags || [], createdAt: r.created_at, updatedAt: r.updated_at })));
      }).catch(err => json(500, { error: err.message }));
    } else {
      getAllMemoryDocs().then(d => json(200, d)).catch(err => json(500, { error: err.message }));
    }
    return;
  }
  if (path === '/api/memory' && req.method === 'POST') {
    body(async b => {
      const id = `mem_${Date.now()}`;
      const safe = sanitizeObject(b);
      const chars = (safe.content || '').length;
      const embeddingVal = Array.isArray(safe.embedding) ? `[${safe.embedding.join(',')}]` : null;
      await pool.query(
        `INSERT INTO memory_docs (id, titre, content, chars, tags, embedding) VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        [id, safe.title || safe.titre || null, safe.content || '', chars, safe.tags || [], embeddingVal]
      );
      const { rows } = await pool.query('SELECT * FROM memory_docs WHERE id=$1', [id]);
      const r = rows[0];
      json(201, { id: r.id, title: r.titre, content: r.content, chars: r.chars, tags: r.tags, hasEmbedding: r.embedding !== null, createdAt: r.created_at, updatedAt: r.updated_at });
    });
    return;
  }

  // ── Memory search (cosine similarity)
  if (path === '/api/memory/search' && req.method === 'POST') {
    body(async b => {
      const safe = sanitizeObject(b);
      if (!Array.isArray(safe.embedding) || safe.embedding.length === 0) return json(400, { error: 'embedding array requis' });
      const limit = Math.min(safe.limit || 5, 20);
      const vec = `[${safe.embedding.join(',')}]`;
      const { rows } = await pool.query(`
        SELECT id, titre, content, chars, tags, created_at,
               1 - (embedding <=> $1::vector) AS similarity
        FROM memory_docs
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vec, limit]);
      json(200, rows.map(r => ({
        id: r.id, title: r.titre, content: r.content, chars: r.chars,
        tags: r.tags, similarity: r.similarity, createdAt: r.created_at
      })));
    });
    return;
  }

  const memMatch = path.match(/^\/api\/memory\/([^/]+)$/);
  if (memMatch && req.method === 'PATCH') {
    body(async b => {
      const safe = sanitizeObject(b);
      const setClauses = [], vals = [memMatch[1]];
      if (safe.title   !== undefined) setClauses.push(`titre=$${vals.push(safe.title)}`);
      if (safe.titre   !== undefined) setClauses.push(`titre=$${vals.push(safe.titre)}`);
      if (safe.content !== undefined) {
        setClauses.push(`content=$${vals.push(safe.content)}`);
        setClauses.push(`chars=$${vals.push(safe.content.length)}`);
      }
      if (safe.tags !== undefined) setClauses.push(`tags=$${vals.push(safe.tags)}`);
      if (Array.isArray(safe.embedding)) setClauses.push(`embedding=$${vals.push(`[${safe.embedding.join(',')}]`)}::vector`);
      if (setClauses.length > 0) {
        await pool.query(`UPDATE memory_docs SET ${setClauses.join(',')}, updated_at=NOW() WHERE id=$1`, vals);
      }
      const { rows } = await pool.query('SELECT * FROM memory_docs WHERE id=$1', [memMatch[1]]);
      const r = rows[0];
      json(200, r ? { id: r.id, title: r.titre, content: r.content, chars: r.chars, tags: r.tags, hasEmbedding: r.embedding !== null, updatedAt: r.updated_at } : null);
    });
    return;
  }
  if (memMatch && req.method === 'DELETE') {
    pool.query('DELETE FROM memory_docs WHERE id=$1', [memMatch[1]]).then(() => json(200, { ok: true })).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Security guardrails
  if (path === '/api/security/guardrails' && req.method === 'GET') { getAllGuardrails().then(g => json(200, g)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/security/guardrails' && req.method === 'PATCH') {
    body(async b => {
      await pool.query(`UPDATE guardrails SET enabled=$2, updated_at=NOW() WHERE id=$1`, [b.id, b.enabled]);
      const g = await getAllGuardrails();
      json(200, g);
    });
    return;
  }
  if (path === '/api/security/events' && req.method === 'GET') {
    pool.query(`
      SELECT ta.created_at AS ts, ta.type, ta.label, ta.message, ta.task_id, t.titre AS task_name
      FROM task_activities ta
      JOIN tasks t ON t.id = ta.task_id
      ORDER BY ta.created_at DESC
      LIMIT 40
    `).then(({ rows }) => {
      json(200, rows.map(r => ({
        ts: r.ts,
        time: new Date(r.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: r.type === 'failed' ? 'block' : 'allow',
        desc: `${r.label || r.message || r.type} — ${r.task_name}`,
        reason: r.type === 'launched' ? 'Agent Exec' : r.type === 'completed' ? 'Succès' : r.type === 'failed' ? 'Erreur' : 'Info',
        taskId: r.task_id,
      })));
    }).catch(err => json(500, { error: err.message }));
    return;
  }

  // ── Pipeline
  if (path === '/api/pipeline' && req.method === 'GET') { getPipeline().then(p => json(200, p)).catch(err => json(500, { error: err.message })); return; }
  if (path === '/api/pipeline' && req.method === 'PUT') {
    body(async b => {
      const safe = sanitizeObject(b);
      await pool.query(
        `INSERT INTO pipeline (id, nodes, edges, updated_at) VALUES (1,$1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET nodes=$1, edges=$2, updated_at=NOW()`,
        [safe.nodes || [], safe.edges || []]
      );
      json(200, { nodes: safe.nodes || [], edges: safe.edges || [], savedAt: new Date().toISOString() });
    });
    return;
  }

  // ── Suggest Model (smart LLM router)
  if (path === '/api/suggest-model' && req.method === 'POST') {
    body(b => {
      const text = ((b.instructions || '') + ' ' + (b.name || '')).toLowerCase();
      const routes = [
        { keywords: ['code', 'script', 'fonction', 'function', 'bug', 'debug', 'python', 'javascript', 'typescript', 'api', 'programme', 'implement', 'refactor', 'sql', 'regex', 'algorithme', 'unit test'], model: 'meta/llama-3.1-405b-instruct', reason: 'code détecté' },
        { keywords: ['analyse', 'analyze', 'research', 'rapport', 'résumé', 'summarize', 'insight', 'données', 'data', 'compare', 'évalue', 'audit', 'benchmark', 'synthèse'], model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', reason: 'analyse détectée' },
        { keywords: ['rédige', 'écris', 'traduit', 'email', 'article', 'blog', 'contenu', 'rédaction', 'write', 'letter', 'documentation', 'readme', 'copywriting'], model: 'claude-sonnet-4-6', reason: 'rédaction détectée' },
        { keywords: ['math', 'calcul', 'equation', 'statistique', 'formula', 'calcule', 'résoudre', 'solve', 'theorem', 'probability', 'intégrale', 'dérivée'], model: 'deepseek-ai/deepseek-v3.2', reason: 'maths/raisonnement détecté' },
      ];
      for (const { keywords, model, reason } of routes) {
        if (keywords.some(k => text.includes(k))) return json(200, { model, reason });
      }
      json(200, { model: null, reason: 'Aucun pattern détecté — sélection manuelle recommandée' });
    });
    return;
  }

  // ── Enhance Prompt (AI)
  if (path === '/api/enhance-prompt' && req.method === 'POST') {
    body(async b => {
      const raw = (b.instructions || '').trim();
      if (!raw) return json(400, { error: 'instructions required' });
      const hasKey = (apiKeys.anthropic && decryptKey(apiKeys.anthropic)) || process.env.ANTHROPIC_API_KEY;
      if (hasKey) {
        const messages = [{ role: 'user', content: `Tu es un expert en prompt engineering. Améliore le prompt suivant en le rendant plus précis, structuré et efficace pour un agent IA. Conserve l'intention originale, ajoute du contexte utile, des étapes claires si nécessaire. Réponds UNIQUEMENT avec le prompt amélioré, sans commentaire ni explication.\n\nPrompt original :\n${raw}` }];
        const result = await runAgenticLoop(messages, 'claude-sonnet-4-6', {});
        const msg = result.message || '';
        if (msg && !msg.includes('mode démo') && !msg.startsWith('❌')) return json(200, { enhanced: msg });
      }
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const verb = lines[0].split(' ')[0];
      const enhanced = `## Objectif\n${lines[0]}\n\n## Instructions détaillées\n${lines.slice(1).length ? lines.slice(1).map(l => `- ${l}`).join('\n') : `- ${verb} de manière exhaustive et structurée\n- Produire un rapport clair et actionnable\n- Inclure les métriques clés et recommandations`}\n\n## Format de sortie\nRépondre en français, structuré avec des sections claires. Être concis et précis.`;
      json(200, { enhanced, demo: true });
    });
    return;
  }

  // ── Settings — API Keys (BYOK)
  // ── Filesystem access settings
  if (path === '/api/settings/filesystem' && req.method === 'GET') {
    return json(200, { enabled: fsGlobalEnabled, allowedPaths: fsAllowedPaths, blocked: FS_BLOCKED });
  }
  if (path === '/api/settings/filesystem' && req.method === 'POST') {
    body(b => {
      if (typeof b.enabled === 'boolean') fsGlobalEnabled = b.enabled;
      if (Array.isArray(b.allowedPaths)) fsAllowedPaths = b.allowedPaths.filter(p => typeof p === 'string' && p.length > 2);
      if (b.addPath && typeof b.addPath === 'string' && b.addPath.length > 2 && !fsAllowedPaths.includes(b.addPath)) fsAllowedPaths.push(b.addPath);
      if (b.removePath) fsAllowedPaths = fsAllowedPaths.filter(p => p !== b.removePath);
      json(200, { ok: true, enabled: fsGlobalEnabled, allowedPaths: fsAllowedPaths });
    });
    return;
  }

  if (path === '/api/settings/keys' && req.method === 'GET') {
    const status = Object.fromEntries(Object.entries(apiKeys).map(([k, v]) => [k, v && v.trim().length > 0]));
    return json(200, { configured: status });
  }
  if (path === '/api/settings/keys' && req.method === 'POST') {
    body(async b => {
      const sanitized = sanitizeObject(b);
      for (const [k, v] of Object.entries(sanitized)) {
        if (typeof v === 'string' && v.trim().length > 0) {
          const encrypted = encryptKey(v.trim());
          apiKeys[k] = encrypted;
          await pool.query(
            `INSERT INTO api_keys (provider, encrypted_value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (provider) DO UPDATE SET encrypted_value=$2, updated_at=NOW()`,
            [k, encrypted]
          );
        } else {
          delete apiKeys[k];
          await pool.query('DELETE FROM api_keys WHERE provider=$1', [k]);
        }
      }
      json(200, { ok: true, configured: Object.keys(apiKeys) });
    });
    return;
  }
  if (path === '/api/settings/keys' && req.method === 'DELETE') {
    body(async b => {
      if (b.provider) {
        delete apiKeys[b.provider];
        await pool.query('DELETE FROM api_keys WHERE provider=$1', [b.provider]);
      }
      json(200, { ok: true });
    });
    return;
  }

  // ── Chat (Lia AI assistant)
  if (path === '/api/chat' && req.method === 'POST') {
    body(async b => {
      try {
        const { messages = [], model = 'claude-sonnet-4-6', permissions = {} } = b;
        const result = await runAgenticLoop(messages, model, permissions);
        json(200, result);
      } catch (err) { json(500, { error: err.message }); }
    });
    return;
  }

  // ── Streaming chat
  if (path === '/api/chat/stream' && req.method === 'POST') {
    body(async b => {
      const { messages = [], model = 'claude-sonnet-4-6', permissions = {} } = b;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(':ok\n\n');
      try {
        const result = await runAgenticLoop(messages, model, permissions);
        const text = result?.message || '';
        const toolCalls = result?.toolCalls || [];
        await simulateStream(text, res);
        res.write(`data: ${JSON.stringify({ done: true, toolCalls })}\n\n`);
      } catch (err) {
        await simulateStream(`❌ Erreur : ${err.message}`, res);
        res.write(`data: ${JSON.stringify({ done: true, toolCalls: [] })}\n\n`);
      }
      res.end();
    });
    return;
  }

  // ── Auth — login / change password
  if (path === '/api/auth/login' && req.method === 'POST') {
    body(b => {
      const { username, password } = b;
      if (!username || !password) return json(400, { message: 'Identifiant et mot de passe requis.' });
      if (SECRET && password !== SECRET) return json(401, { message: 'Identifiants incorrects.' });
      const token = SECRET || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      json(200, {
        token,
        user: { username, displayName: username, role: username === 'admin' ? 'admin' : 'user', avatar: null },
      });
    });
    return;
  }
  if (path === '/api/auth/password' && req.method === 'POST') {
    body(b => {
      const { current, next } = b;
      if (!current || !next) return json(400, { message: 'Champs requis.' });
      if (SECRET && current !== SECRET) return json(401, { message: 'Mot de passe actuel incorrect.' });
      if (next.length < 6) return json(400, { message: 'Le mot de passe doit contenir au moins 6 caractères.' });
      json(200, { ok: true });
    });
    return;
  }

  // ── NemoClaw sandbox bridge ────────────────────────────────────────────────

  // Helper: run a nemoclaw CLI command via WSL and return stdout
  function runNemoClawCmd(args) {
    return new Promise((resolve, reject) => {
      // Try native first, then WSL fallback
      const cmd = `wsl -d Ubuntu -- bash -lc "nemoclaw ${args}" 2>&1`;
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve((stdout || '').trim());
      });
    });
  }

  // Parse `nemoclaw list` text output into JSON array
  function parseNemoClawList(raw) {
    const sandboxes = [];
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line === 'Sandboxes:' || line === 'No sandboxes found.') { i++; continue; }
      // Name line: "my-assistant *" or "my-assistant"
      if (!line.startsWith('model:') && !line.startsWith('[') && !line.startsWith('Run:') && !line.startsWith('Status:') && !line.startsWith('Logs:')) {
        const isDefault = line.endsWith('*');
        const name = isDefault ? line.slice(0, -1).trim() : line;
        const sandbox = { name, default: isDefault, model: '', provider: '', gpu: false, policies: 'none', status: 'active' };
        // Next line has metadata
        if (lines[i + 1]?.startsWith('model:')) {
          const meta = lines[i + 1];
          sandbox.model    = (meta.match(/model:\s*(\S+)/) || [])[1] || '';
          sandbox.provider = (meta.match(/provider:\s*(\S+)/) || [])[1] || '';
          sandbox.gpu      = /GPU/.test(meta) && !/CPU/.test(meta);
          sandbox.policies = (meta.match(/policies:\s*(.+)$/) || [])[1]?.trim() || 'none';
          i++;
        }
        sandboxes.push(sandbox);
      }
      i++;
    }
    return sandboxes;
  }

  // Parse `nemoclaw <name> status` text output into JSON
  function parseNemoClawStatus(raw) {
    const get = (key) => (raw.match(new RegExp(`${key}:\\s*(.+)`, 'i')) || [])[1]?.trim() || '';
    return {
      model:    get('Model'),
      provider: get('Provider'),
      gpu:      /yes/i.test(get('GPU')),
      policies: get('Policies'),
      healthy:  /yes/i.test(get('Healthy')),
      status:   /yes/i.test(get('Healthy')) ? 'active' : 'offline',
      raw,
    };
  }

  // Convert NemoClaw sandboxes to the Agent shape the frontend expects
  function sandboxesToAgents(sandboxes) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(sandboxes.length)));
    return sandboxes.map((s, i) => ({
      id:       s.name,
      label:    s.name,
      role:     s.default ? 'Default Sandbox' : 'NemoClaw Sandbox',
      model:    s.model || 'nemotron',
      provider: s.provider,
      gpu:      s.gpu,
      policies: s.policies,
      status:   s.status,
      parentId: null,
      position: { x: (i % cols) * 280 + 50, y: Math.floor(i / cols) * 220 + 50 },
    }));
  }

  // ── Approvals (Human-in-the-loop + OpenShell blocked requests) ───────────
  // In-memory approval queue (populated from NemoClaw/OpenShell polling)
  // GET /api/approvals — list pending approvals
  if (path === '/api/approvals' && req.method === 'GET') {
    const isSSE = url.searchParams.get('stream') === '1';
    if (isSSE) {
      sse(sseClients.approvals);
      // Send current snapshot immediately
      res.write(`event: snapshot\ndata: ${JSON.stringify([...approvalQueue.values()])}\n\n`);
    } else {
      json(200, [...approvalQueue.values()]);
    }
    return;
  }

  // POST /api/approvals/:id — approve or reject
  const approvalDecisionMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalDecisionMatch && req.method === 'POST') {
    body(b => {
      const id = approvalDecisionMatch[1];
      const decision = b.decision; // 'approve' | 'reject'
      if (!decision) return json(400, { error: 'decision required' });
      const item = approvalQueue.get(id);
      if (!item) return json(404, { error: 'approval not found' });
      approvalQueue.delete(id);
      // Notify SSE clients of the decision
      const event = `event: decision\ndata: ${JSON.stringify({ id, decision })}\n\n`;
      for (const c of sseClients.approvals) { try { c.write(event); } catch { sseClients.approvals.delete(c); } }
      // If this is an OpenShell request, call OpenShell to allow/deny
      if (item._openShellId) {
        const action = decision === 'approve' ? 'allow' : 'deny';
        const cmd = `wsl -d Ubuntu -- bash -c "source /home/bob/.nvm/nvm.sh && curl -sk -X POST https://127.0.0.1:8080/api/v1/requests/${item._openShellId}/${action} 2>/dev/null"`;
        exec(cmd, { timeout: 5000 }, () => {}); // fire-and-forget
      }
      json(200, { ok: true, id, decision });
    });
    return;
  }

  // GET /api/nemoclaw/:name/approvals — poll OpenShell for blocked requests
  const ncApprovalsMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/approvals$/);
  if (ncApprovalsMatch && req.method === 'GET') {
    const sbName = ncApprovalsMatch[1].replace(/[^a-z0-9-]/gi, '');
    // Try OpenShell REST API for blocked requests
    const cmd = `wsl -d Ubuntu -- bash -c "curl -sk https://127.0.0.1:8080/api/v1/requests?status=blocked 2>/dev/null"`;
    exec(cmd, { timeout: 8000 }, (err, stdout) => {
      try {
        const raw = JSON.parse(stdout || '[]');
        const requests = (Array.isArray(raw) ? raw : (raw.requests || raw.items || [])).map(r => ({
          id: `os_${r.id || r.requestId || Math.random().toString(36).slice(2)}`,
          taskId: sbName,
          taskName: `Sandbox ${sbName}`,
          agent: sbName,
          reason: `Requête réseau bloquée : ${r.method || 'GET'} ${r.url || r.host || 'inconnu'}`,
          riskLevel: r.risk || 'medium',
          requestedAt: r.timestamp || new Date().toISOString(),
          payload: r,
          _openShellId: r.id || r.requestId,
        }));
        // Merge into global approvalQueue
        for (const req of requests) {
          if (!approvalQueue.has(req.id)) {
            approvalQueue.set(req.id, req);
            const event = `event: approval\ndata: ${JSON.stringify(req)}\n\n`;
            for (const c of sseClients.approvals) { try { c.write(event); } catch { sseClients.approvals.delete(c); } }
          }
        }
        json(200, requests);
      } catch {
        json(200, []); // graceful — OpenShell may not have blocked requests
      }
    });
    return;
  }

  // GET /api/nemoclaw/sandboxes
  if (path === '/api/nemoclaw/sandboxes' && req.method === 'GET') {
    try {
      const raw = await runNemoClawCmd('list');
      const sandboxes = parseNemoClawList(raw);
      json(200, sandboxes);
    } catch (e) {
      json(503, { error: 'NemoClaw non disponible', detail: e.message });
    }
    return;
  }

  // GET /api/nemoclaw/:name/status
  const ncStatusMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/status$/);
  if (ncStatusMatch && req.method === 'GET') {
    try {
      const raw = await runNemoClawCmd(`${ncStatusMatch[1]} status`);
      json(200, parseNemoClawStatus(raw));
    } catch (e) {
      json(503, { error: 'NemoClaw non disponible', detail: e.message });
    }
    return;
  }

  // GET /api/nemoclaw/:name/logs — SSE streaming
  const ncLogsMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/logs$/);
  if (ncLogsMatch && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':ok\n\n');
    let child;
    try {
      child = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-lc', `nemoclaw ${ncLogsMatch[1]} logs --follow`], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => res.write(`data: ${JSON.stringify({ line: d.toString() })}\n\n`));
      child.stderr.on('data', d => res.write(`data: ${JSON.stringify({ line: d.toString() })}\n\n`));
      child.on('close', () => { res.write('data: {"done":true}\n\n'); res.end(); });
      req.on('close', () => child.kill());
    } catch (e) {
      res.write(`data: ${JSON.stringify({ line: `Erreur: ${e.message}` })}\n\n`);
      res.end();
    }
    return;
  }

  // POST /api/nemoclaw/:name/destroy
  const ncDestroyMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/destroy$/);
  if (ncDestroyMatch && req.method === 'POST') {
    try {
      await runNemoClawCmd(`${ncDestroyMatch[1]} destroy --yes`);
      json(200, { ok: true });
    } catch (e) {
      json(503, { error: e.message });
    }
    return;
  }

  // POST /api/nemoclaw/:name/run-skill — execute a skill inside sandbox (SSE streaming)
  const ncRunSkillMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/run-skill$/);
  if (ncRunSkillMatch && req.method === 'POST') {
    const sbName = ncRunSkillMatch[1].replace(/[^a-z0-9-]/gi, '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':ok\n\n');
    body(b => {
      const skill   = (b.skill   || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const prompt  = (b.prompt  || '').slice(0, 2000);
      const model   = (b.model   || 'nvidia/nemotron-3-super-120b-a12b').replace(/[^a-zA-Z0-9_./-]/g, '');
      const nvidiaKey = (apiKeys?.nvidia && decryptKey(apiKeys.nvidia)) || process.env.NVIDIA_API_KEY || '';
      const envPrefix = nvidiaKey ? `export NVIDIA_API_KEY="${nvidiaKey}" && ` : '';
      // Try nemoclaw run, fallback to openclaw agent --local
      const safePrompt = prompt.replace(/"/g, '\\"').replace(/\$/g, '\\$');
      const cmd = `wsl -d Ubuntu -- bash -c "${envPrefix}source /home/bob/.nvm/nvm.sh && /home/bob/.local/bin/nemoclaw ${sbName} run${skill ? ` --skill ${skill}` : ''} --model ${model} -- \\"${safePrompt}\\" 2>&1"`;
      const proc = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c',
        `${envPrefix}source /home/bob/.nvm/nvm.sh && /home/bob/.local/bin/nemoclaw ${sbName} run${skill ? ` --skill ${skill}` : ''} --model ${model} -- "${safePrompt}" 2>&1`
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', chunk => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try { res.write(`data: ${JSON.stringify({ line })}\n\n`); } catch { proc.kill(); }
        }
      });
      proc.stderr.on('data', chunk => {
        try { res.write(`data: ${JSON.stringify({ error: chunk.toString() })}\n\n`); } catch { proc.kill(); }
      });
      proc.on('close', code => {
        try { res.write(`data: ${JSON.stringify({ done: true, exitCode: code })}\n\n`); res.end(); } catch {}
      });
      req.on('close', () => { try { proc.kill(); } catch {} });
    });
    return;
  }

  // GET /api/nemoclaw/:name/memory/:file — read memory file from sandbox
  const ncMemGetMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/memory\/([^/]+)$/);
  if (ncMemGetMatch && req.method === 'GET') {
    const [, sbName, fileName] = ncMemGetMatch;
    // Allowed memory files only
    const ALLOWED_MEM = ['MEMORY.md', 'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'CLAUDE.md', 'NOTES.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'];
    if (!ALLOWED_MEM.includes(fileName)) return json(400, { error: 'File not allowed' });
    const safeBox = sbName.replace(/[^a-z0-9-]/gi, '');
    const safeFile = fileName.replace(/[^A-Z0-9_.]/gi, '');
    // Try: nemoclaw <name> exec -- cat /workspace/<file>
    // Fallback: docker exec via container label
    const cmd = `wsl -d Ubuntu -- bash -c "source /home/bob/.nvm/nvm.sh && /home/bob/.local/bin/nemoclaw ${safeBox} exec -- cat /workspace/${safeFile} 2>/dev/null || docker exec \\$(docker ps --filter label=nemoclaw.sandbox=${safeBox} -q | head -1) cat /workspace/${safeFile} 2>/dev/null"`;
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return json(200, { content: '', sandbox: safeBox, file: safeFile, empty: true });
      json(200, { content: stdout || '', sandbox: safeBox, file: safeFile });
    });
    return;
  }

  // POST /api/nemoclaw/:name/memory/:file — write memory file to sandbox
  const ncMemPostMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/memory\/([^/]+)$/);
  if (ncMemPostMatch && req.method === 'POST') {
    const [, sbName, fileName] = ncMemPostMatch;
    const ALLOWED_MEM = ['MEMORY.md', 'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'CLAUDE.md', 'NOTES.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'];
    if (!ALLOWED_MEM.includes(fileName)) return json(400, { error: 'File not allowed' });
    const safeBox = sbName.replace(/[^a-z0-9-]/gi, '');
    const safeFile = fileName.replace(/[^A-Z0-9_.]/gi, '');
    body(b => {
      const content = (b.content || '').replace(/'/g, "'\\''");
      const cmd = `wsl -d Ubuntu -- bash -c "source /home/bob/.nvm/nvm.sh && (CONTAINER=\\$(docker ps --filter label=nemoclaw.sandbox=${safeBox} -q | head -1) && [ -n \\"\\$CONTAINER\\" ] && printf '%s' '${content}' | docker exec -i \\$CONTAINER sh -c 'cat > /workspace/${safeFile}' && echo OK) 2>&1"`;
      exec(cmd, { timeout: 10000 }, (err, stdout) => {
        if (err && !stdout?.includes('OK')) return json(503, { error: 'Could not write to sandbox — is it running?' });
        json(200, { ok: true, sandbox: safeBox, file: safeFile });
      });
    });
    return;
  }

  // POST /api/nemoclaw/onboard — launch onboarding (non-interactive with env vars)
  if (path === '/api/nemoclaw/onboard' && req.method === 'POST') {
    body(async b => {
      const { name = 'main', provider = 'nvidia', model = '' } = b || {};
      const safe = name.replace(/[^a-z0-9-]/gi, '');
      try {
        // Non-interactive onboard requires NVIDIA_API_KEY in WSL env
        const nvidiaKey = (apiKeys.nvidia && decryptKey(apiKeys.nvidia)) || process.env.NVIDIA_API_KEY || '';
        const envExport = nvidiaKey ? `NVIDIA_API_KEY=${nvidiaKey}` : '';
        const cmd = `wsl -d Ubuntu -- bash -lc "${envExport ? `export ${envExport} && ` : ''}nemoclaw onboard --non-interactive --name ${safe} --provider ${provider}${model ? ` --model ${model}` : ''}" 2>&1`;
        exec(cmd, { timeout: 120000 }, (err, stdout) => {
          if (err && !stdout) return json(500, { error: err.message });
          json(200, { ok: true, output: stdout });
        });
      } catch (e) {
        json(500, { error: e.message });
      }
    });
    return;
  }

  // ── Agents fleet (NemoClaw-aware: tries NemoClaw first, falls back to mock)
  if (path === '/api/agents' && req.method === 'GET') {
    try {
      const raw = await runNemoClawCmd('list');
      const sandboxes = parseNemoClawList(raw);
      if (sandboxes.length > 0) {
        json(200, sandboxesToAgents(sandboxes));
        return;
      }
    } catch { /* NemoClaw not installed, fall through to mock */ }
    json(200, [...AGENTS.values()]);
    return;
  }
  const agentRunMatch  = path.match(/^\/api\/agents\/([^/]+)\/run$/);
  const agentStopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (agentRunMatch && req.method === 'POST') {
    const agent = AGENTS.get(agentRunMatch[1]);
    if (!agent) return json(404, { error: 'Agent not found' });
    agent.status = 'active';
    json(200, agent);
    return;
  }
  if (agentStopMatch && req.method === 'POST') {
    const agent = AGENTS.get(agentStopMatch[1]);
    if (!agent) return json(404, { error: 'Agent not found' });
    agent.status = 'offline';
    json(200, agent);
    return;
  }

  // ── Notifications settings
  if (path === '/api/settings/notifications' && req.method === 'GET') {
    json(200, notificationsConfig);
    return;
  }
  if (path === '/api/settings/notifications' && req.method === 'POST') {
    body(b => {
      const safe = sanitizeObject(b);
      notificationsConfig = { ...notificationsConfig, ...safe };
      json(200, { ok: true, config: notificationsConfig });
    });
    return;
  }
  // ── Notifications test
  if (path === '/api/settings/notifications/test' && req.method === 'POST') {
    body(b => {
      const { channel } = sanitizeObject(b);
      const cfg = notificationsConfig;
      const missing = channel === 'telegram' ? (!cfg.telegram_token || !cfg.telegram_chat_id) :
                      channel === 'discord'  ? !cfg.discord_webhook :
                      channel === 'email'    ? (!cfg.email_smtp || !cfg.email_to) :
                      channel === 'webhook'  ? !cfg.webhook_url : true;
      if (missing) return json(400, { message: `Configuration ${channel} incomplète.` });
      // Demo: simulate success (real integration would call external APIs)
      setTimeout(() => {}, 0);
      json(200, { ok: true, message: `Message test envoyé via ${channel}.` });
    });
    return;
  }

  // ── NemoClaw CLI proxy endpoints ────────────────────────────────────────────

  // GET /api/nemoclaw/status
  if (path === '/api/nemoclaw/status' && req.method === 'GET') {
    json(200, {
      installed: false,
      version: null,
      sandboxes: [],
      message: 'NemoClaw not installed on this host. Run "nemoclaw onboard" to set up.',
    });
    return;
  }

  // GET /api/nemoclaw/logs
  if (path === '/api/nemoclaw/logs' && req.method === 'GET') {
    json(200, {
      installed: false,
      logs: [
        '[demo] NemoClaw is not installed on this server.',
        '[demo] Install it via: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash',
        '[demo] Then run: nemoclaw onboard',
      ],
    });
    return;
  }

  // POST /api/nemoclaw/onboard
  if (path === '/api/nemoclaw/onboard' && req.method === 'POST') {
    json(200, {
      installed: false,
      message: 'NemoClaw is not installed on this server. To install it on your machine, run:\n  curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\nThen rerun "nemoclaw onboard" in your local terminal.',
    });
    return;
  }

  // POST /api/nemoclaw/launch
  if (path === '/api/nemoclaw/launch' && req.method === 'POST') {
    json(200, {
      installed: false,
      message: 'NemoClaw is not installed. Install it first, then run "nemoclaw launch".',
    });
    return;
  }

  // POST /api/nemoclaw/:name/connect
  const connectMatch = path.match(/^\/api\/nemoclaw\/([^/]+)\/connect$/);
  if (connectMatch && req.method === 'POST') {
    const sandboxName = connectMatch[1];
    json(200, {
      installed: false,
      sandbox: sandboxName,
      message: `Sandbox "${sandboxName}" not found. NemoClaw is not installed on this server.`,
    });
    return;
  }

  // GET /api/nemoclaw/openshell/term
  if (path === '/api/nemoclaw/openshell/term' && req.method === 'GET') {
    json(200, {
      installed: false,
      message: 'openshell is part of the NemoClaw toolkit. Install NemoClaw to use it.',
    });
    return;
  }

  // GET /api/nemoclaw/openclaw/tui
  if (path === '/api/nemoclaw/openclaw/tui' && req.method === 'GET') {
    json(200, {
      installed: false,
      message: 'openclaw TUI requires NemoClaw to be installed locally. Use the Agent Chat module instead.',
    });
    return;
  }

  // ─── P1-1: GET /api/health/probes — état réel des providers LLM ─────────────
  if (path === '/api/health/probes' && req.method === 'GET') {
    const providers = [
      { id: 'anthropic',   label: 'Anthropic Claude', url: 'https://api.anthropic.com',         authHeader: () => apiKeys.anthropic ? `x-api-key: ${decryptKey(apiKeys.anthropic)}` : null },
      { id: 'openai',      label: 'OpenAI',            url: 'https://api.openai.com',            authHeader: () => apiKeys.openai    ? `Bearer ${decryptKey(apiKeys.openai)}`     : null },
      { id: 'nvidia',      label: 'NVIDIA NIM',        url: 'https://integrate.api.nvidia.com',  authHeader: () => apiKeys.nvidia    ? `Bearer ${decryptKey(apiKeys.nvidia)}`     : null },
      { id: 'nemoclaw',    label: 'NemoClaw (local)',   url: `http://localhost:${PORT}/api/ping`, authHeader: () => null },
      { id: 'ollama',      label: 'Ollama (local)',     url: 'http://localhost:11434/api/version', authHeader: () => null },
    ];
    const results = await Promise.all(providers.map(async p => {
      const start = Date.now();
      try {
        const headers = { 'Content-Type': 'application/json' };
        const auth = p.authHeader();
        if (auth) {
          const [k, v] = auth.split(': ');
          headers[k] = v;
        }
        const r = await fetch(p.url, { headers, signal: AbortSignal.timeout(4000), method: 'GET' });
        const latency = Date.now() - start;
        return { id: p.id, label: p.label, status: r.ok || r.status < 500 ? 'up' : 'degraded', latency, httpStatus: r.status };
      } catch (e) {
        const latency = Date.now() - start;
        return { id: p.id, label: p.label, status: 'down', latency, error: e.message };
      }
    }));
    json(200, results);
    return;
  }

  // ─── P1-2: GET /api/presence — agents actifs/connectés ──────────────────────
  if (path === '/api/presence' && req.method === 'GET') {
    try {
      const raw = await runNemoClawCmd('list');
      const sandboxes = parseNemoClawList(raw);
      const agents = sandboxesToAgents(sandboxes);
      json(200, agents.map(a => ({
        id: a.id, label: a.label, status: a.status,
        model: a.model, provider: a.provider, lastSeen: new Date().toISOString(),
      })));
    } catch {
      // Fallback: retourne les agents in-memory
      const agentList = [...AGENTS.values()].map(a => ({
        id: a.id, label: a.name || a.id,
        status: a.status === 'active' ? 'connected' : a.status === 'offline' ? 'offline' : 'idle',
        model: 'unknown', provider: 'local', lastSeen: new Date().toISOString(),
      }));
      json(200, agentList);
    }
    return;
  }

  // ─── P1-3: GET /api/git/branches + GET /api/git/log ──────────────────────────
  if (path === '/api/git/branches' && req.method === 'GET') {
    const repoDir = dirname(fileURLToPath(import.meta.url));
    exec(`git -C "${repoDir}" branch -a --format="%(refname:short)"`, { timeout: 8000 }, (err, stdout) => {
      if (err) return json(200, { branches: ['main'], current: 'main', error: err.message });
      const branches = stdout.trim().split('\n').map(b => b.trim()).filter(Boolean);
      exec(`git -C "${repoDir}" rev-parse --abbrev-ref HEAD`, { timeout: 3000 }, (e2, cur) => {
        json(200, { branches, current: (cur || 'main').trim() });
      });
    });
    return;
  }
  if (path === '/api/git/log' && req.method === 'GET') {
    const repoDir = dirname(fileURLToPath(import.meta.url));
    const branch  = (url.searchParams.get('branch') || 'HEAD').replace(/[^a-zA-Z0-9/_.-]/g, '');
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);
    const fmt = '--pretty=format:{"hash":"%H","short":"%h","subject":"%s","author":"%an","email":"%ae","date":"%aI","refs":"%D"}';
    exec(`git -C "${repoDir}" log ${branch} ${fmt} -n ${limit}`, { timeout: 10000 }, (err, stdout) => {
      if (err) return json(200, []);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const commits = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      json(200, commits);
    });
    return;
  }

  // ─── P1-4: POST /api/shell — exécution de commandes whitelistées ────────────
  if (path === '/api/shell' && req.method === 'POST') {
    body(async b => {
      const cmd = (b.command || '').trim();
      if (!cmd) return json(400, { error: 'command required' });
      // Whitelist de commandes autorisées (sécurité)
      const ALLOWED_CMDS = [
        /^ls(\s|$)/, /^pwd$/, /^echo\s/, /^cat\s[\w./-]+$/, /^node\s-e\s/,
        /^npm\s(list|run|test|start)\b/, /^git\s(log|status|branch|diff|show)\b/,
        /^ps\s/, /^top\s/, /^df\s/, /^du\s/, /^env$/, /^date$/,
        /^curl\s/, /^ping\s-c\s\d+\s/,
      ];
      const allowed = ALLOWED_CMDS.some(re => re.test(cmd));
      if (!allowed) {
        return json(403, { error: `Commande non autorisée : "${cmd.slice(0, 60)}"`, hint: 'Seules les commandes de lecture/diagnostic sont permises.' });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(':ok\n\n');
      const child = spawn('bash', ['-c', cmd], { cwd: dirname(fileURLToPath(import.meta.url)), timeout: 30000 });
      child.stdout.on('data', d => res.write(`data: ${JSON.stringify({ stdout: d.toString() })}\n\n`));
      child.stderr.on('data', d => res.write(`data: ${JSON.stringify({ stderr: d.toString() })}\n\n`));
      child.on('close', code => {
        res.write(`data: ${JSON.stringify({ exit: code })}\n\n`);
        res.end();
      });
      req.on('close', () => { try { child.kill(); } catch (_) {} });
    });
    return;
  }

  // ─── P1-5: GET /api/traces — traces OTel depuis DB task_activities ───────────
  if (path === '/api/traces' && req.method === 'GET') {
    const limitT = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    pool.query(`
      SELECT ta.id, ta.type, ta.label, ta.message, ta.created_at,
             t.id AS task_id, t.titre AS task_name, t.agent, t.cout, t.tokens_in, t.tokens_out, t.llm_model
      FROM task_activities ta
      JOIN tasks t ON t.id = ta.task_id
      ORDER BY ta.created_at DESC
      LIMIT $1
    `, [limitT]).then(({ rows }) => {
      const spans = rows.map(r => ({
        traceId:   `tr_${r.id}`,
        spanId:    r.id,
        operation: r.label || r.type,
        status:    r.type === 'failed' ? 'error' : 'ok',
        durationMs: null,
        model:      r.llm_model || null,
        agent:      r.agent,
        taskId:     r.task_id,
        taskName:   r.task_name,
        cost:       r.cout,
        tokensIn:   r.tokens_in,
        tokensOut:  r.tokens_out,
        ts:         r.created_at,
      }));
      json(200, { spans, total: spans.length });
    }).catch(err => json(500, { error: err.message }));
    return;
  }

  // ─── P1-6: GET /api/pairing/qr — génère un token JWT signé pour pairing ──────
  if (path === '/api/pairing/qr' && req.method === 'GET') {
    if (!SECRET) return json(503, { error: 'CLAWBOARD_SECRET requis pour le pairing sécurisé' });
    const canal    = url.searchParams.get('canal') || 'telegram';
    const dest     = url.searchParams.get('destinataire') || '';
    const ttlSec   = 300; // 5 minutes
    const expiresAt = Date.now() + ttlSec * 1000;
    // Token signé HMAC-SHA256 (pas besoin de JWT complet)
    const payload  = JSON.stringify({ canal, dest, expiresAt, iss: 'clawboard', iat: Date.now() });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const token = `${payloadB64}.${sig}`;
    // URL de pairing selon le canal
    let pairingUrl;
    if (canal === 'telegram')      pairingUrl = `https://t.me/nemoclaw_bot?start=${token}`;
    else if (canal === 'discord')  pairingUrl = `https://discord.com/oauth2/authorize?token=${token}`;
    else if (canal === 'whatsapp') pairingUrl = `https://wa.me/?text=nemoclaw:${token}`;
    else                           pairingUrl = `${token}`;
    json(200, { token, pairingUrl, canal, dest, expiresIn: ttlSec, expiresAt: new Date(expiresAt).toISOString() });
    return;
  }

  // ─── P1-7: POST /api/channels/:id/test — test connectivité canal ─────────────
  const channelTestMatch = path.match(/^\/api\/channels\/([^/]+)\/test$/);
  if (channelTestMatch && req.method === 'POST') {
    body(async b => {
      const channelId = channelTestMatch[1];
      const cfg = sanitizeObject(b) || {};
      try {
        if (channelId === 'telegram') {
          if (!cfg.token) return json(400, { ok: false, error: 'token manquant' });
          const r = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`, { signal: AbortSignal.timeout(5000) });
          const data = await r.json();
          if (!data.ok) return json(200, { ok: false, error: data.description || 'Token invalide' });
          json(200, { ok: true, name: data.result?.first_name, username: data.result?.username });
        } else if (channelId === 'discord') {
          if (!cfg.webhookUrl) return json(400, { ok: false, error: 'webhookUrl manquant' });
          const r = await fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '✅ Test Clawboard — connexion OK' }), signal: AbortSignal.timeout(5000) });
          json(200, { ok: r.ok, httpStatus: r.status });
        } else if (channelId === 'slack') {
          if (!cfg.webhookUrl) return json(400, { ok: false, error: 'webhookUrl manquant' });
          const r = await fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '✅ Test Clawboard — connexion OK' }), signal: AbortSignal.timeout(5000) });
          json(200, { ok: r.ok, httpStatus: r.status });
        } else {
          // Canal générique / webhook custom
          const targetUrl = cfg.webhookUrl || cfg.serverUrl || cfg.url;
          if (!targetUrl) return json(400, { ok: false, error: 'URL du canal manquante' });
          const r = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
          json(200, { ok: r.ok || r.status < 500, httpStatus: r.status });
        }
      } catch (e) {
        json(200, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ─── P1-8: POST /api/recurrences/:id/run — déclenche manuellement ────────────
  const recRunMatch = path.match(/^\/api\/recurrences\/([^/]+)\/run$/);
  if (recRunMatch && req.method === 'POST') {
    const recId = recRunMatch[1];
    pool.query('SELECT * FROM recurrences WHERE id=$1', [recId]).then(async ({ rows }) => {
      if (!rows.length) return json(404, { error: 'Récurrence introuvable' });
      const rec = rows[0];
      // Crée une tâche à partir du modèle associé
      let taskData = null;
      if (rec.modele_id) {
        const { rows: mRows } = await pool.query('SELECT * FROM modeles WHERE id=$1', [rec.modele_id]);
        if (mRows.length) {
          const m = mRows[0];
          const taskId = `tsk_rec_${Date.now()}`;
          await pool.query(
            `INSERT INTO tasks (id, titre, modele_id, statut, agent, skill_name, instructions, recurrence_human, created_at, updated_at)
             VALUES ($1,$2,$3,'planifie',$4,$5,$6,$7,NOW(),NOW())`,
            [taskId, `[Récurrence] ${m.name || m.nom}`, rec.modele_id, m.agent || 'main', m.skill_name || null, m.instructions || null, rec.name]
          );
          // Mise à jour last_run de la récurrence
          await pool.query(`UPDATE recurrences SET last_run=NOW(), run_count=COALESCE(run_count,0)+1 WHERE id=$1`, [recId]);
          taskData = { id: taskId, titre: `[Récurrence] ${m.name || m.nom}` };
        }
      }
      json(200, { ok: true, recurrenceId: recId, task: taskData, message: taskData ? 'Tâche créée depuis la récurrence' : 'Récurrence déclenchée (sans modèle associé)' });
    }).catch(err => json(500, { error: err.message }));
    return;
  }

  // ─── P1-9: POST /api/plugins/install — installe/active un plugin en DB ───────
  if (path === '/api/plugins/install' && req.method === 'POST') {
    body(async b => {
      const safe = sanitizeObject(b);
      const pkg  = safe.pkg || safe.id;
      if (!pkg) return json(400, { error: 'pkg requis' });
      // Upsert dans la table skills (réutilisation — les plugins sont des skills npm)
      const id = `plugin_${pkg.replace(/[^a-z0-9]/gi, '_')}`;
      await pool.query(
        `INSERT INTO skills (id, nom, description, tags, status, category)
         VALUES ($1,$2,$3,$4,'active','npm')
         ON CONFLICT (id) DO UPDATE SET status='active', updated_at=NOW()`,
        [id, safe.name || pkg, safe.description || `Plugin npm : ${pkg}`, ['plugin', 'npm']]
      ).catch(() => {
        // Si la colonne status/category n'existe pas encore, fallback simple
        return pool.query(
          `INSERT INTO skills (id, nom, description, tags) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
          [id, safe.name || pkg, safe.description || `Plugin npm : ${pkg}`, ['plugin', 'npm']]
        );
      });
      json(200, { ok: true, id, pkg, message: `Plugin "${pkg}" enregistré en base.` });
    });
    return;
  }

  // ─── P1-10: TOTP MFA — setup / verify / disable / status ────────────────────
  // Implémentation HMAC-SHA1 TOTP (RFC 6238) sans dépendance externe
  function totpGenerateSecret() {
    return crypto.randomBytes(20).toString('base64').replace(/[^A-Z2-7]/gi, 'A').toUpperCase().slice(0, 32);
  }
  function totpHotp(secretBase32, counter) {
    const key = Buffer.from(secretBase32.replace(/\s/g,'').toUpperCase().padEnd(32,'='), 'base64');
    const buf = Buffer.alloc(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
    const mac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = mac[mac.length - 1] & 0x0f;
    const code = ((mac[offset] & 0x7f) << 24 | (mac[offset+1] & 0xff) << 16 | (mac[offset+2] & 0xff) << 8 | (mac[offset+3] & 0xff)) % 1_000_000;
    return String(code).padStart(6, '0');
  }
  function totpVerify(secret, token, window = 1) {
    const counter = Math.floor(Date.now() / 30000);
    for (let i = -window; i <= window; i++) {
      if (totpHotp(secret, counter + i) === token) return true;
    }
    return false;
  }

  if (path === '/api/security/totp/status' && req.method === 'GET') {
    pool.query(`SELECT value FROM settings WHERE key='totp_enabled' LIMIT 1`).then(({ rows }) => {
      json(200, { enabled: rows[0]?.value === 'true' });
    }).catch(() => json(200, { enabled: false }));
    return;
  }
  if (path === '/api/security/totp/setup' && req.method === 'POST') {
    const secret = totpGenerateSecret();
    // Stocke le secret temporaire en attendant vérification
    pool.query(`INSERT INTO settings (key,value) VALUES ('totp_pending_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [secret])
      .catch(() => {}); // table settings peut ne pas avoir updated_at
    const otpAuthUrl = `otpauth://totp/ClawBoard:admin?secret=${secret}&issuer=ClawBoard&algorithm=SHA1&digits=6&period=30`;
    json(200, { secret, otpAuthUrl });
    return;
  }
  if (path === '/api/security/totp/verify' && req.method === 'POST') {
    body(async b => {
      const token = String(b.token || '').trim();
      if (!/^\d{6}$/.test(token)) return json(400, { error: 'Token invalide (6 chiffres requis)' });
      const { rows } = await pool.query(`SELECT value FROM settings WHERE key='totp_pending_secret' LIMIT 1`).catch(() => ({ rows: [] }));
      const secret = rows[0]?.value;
      if (!secret) return json(400, { error: 'Aucun setup TOTP en cours. Relancez /api/security/totp/setup.' });
      if (!totpVerify(secret, token)) return json(401, { error: 'Code incorrect ou expiré' });
      // Active le TOTP et enregistre le secret définitif
      await pool.query(`INSERT INTO settings (key,value) VALUES ('totp_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [secret]).catch(() => {});
      await pool.query(`INSERT INTO settings (key,value) VALUES ('totp_enabled','true') ON CONFLICT (key) DO UPDATE SET value='true'`).catch(() => {});
      await pool.query(`DELETE FROM settings WHERE key='totp_pending_secret'`).catch(() => {});
      json(200, { ok: true, message: 'TOTP activé avec succès' });
    });
    return;
  }
  if (path === '/api/security/totp/disable' && req.method === 'POST') {
    Promise.all([
      pool.query(`INSERT INTO settings (key,value) VALUES ('totp_enabled','false') ON CONFLICT (key) DO UPDATE SET value='false'`),
      pool.query(`DELETE FROM settings WHERE key IN ('totp_secret','totp_pending_secret')`),
    ]).then(() => json(200, { ok: true, message: 'TOTP désactivé' }))
      .catch(err => json(500, { error: err.message }));
    return;
  }

  // ─── Static files (production — sert dist/ si present) ──────────────────────
  {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const distDir = pathJoin(__dir, 'dist');
    if (existsSync(distDir)) {
      const MIME = {
        '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
        '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
        '.webp': 'image/webp', '.gz': 'application/gzip',
      };
      let filePath = pathJoin(distDir, path === '/' ? 'index.html' : path);
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = pathJoin(distDir, 'index.html');
      }
      if (existsSync(filePath)) {
        const ext = extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const data = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000' });
        res.end(data);
        return;
      }
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  await checkConnection();
  await runPhase2Migration();
  await seedIfEmpty();
  await loadApiKeys();
  await loadQuotas();
  connectRedis().catch(err => console.warn('[Redis] connexion échouée (dégradé sans cache):', err.message));

  server.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   ClawBoard Backend  →  :${PORT}        ║`);
    console.log(`  ║   DB: PostgreSQL (clawboard)         ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}

startup().catch(err => {
  console.error('[FATAL] Startup failed:', err.message);
  process.exit(1);
});
