import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { join as pathJoin, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
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

const sseClients = { vitals: new Set(), quota: new Set(), tasks: new Set(), logs: {} };

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

const LIA_SYSTEM = `Tu es Lia, l'assistante IA intégrée au tableau de bord ClawBoard.
Tu es intelligente, concise et parles principalement en français.
Tu as accès à des outils pour gérer les tâches, modèles et récurrences du système.
Quand l'utilisateur demande d'effectuer une action, utilise les outils appropriés sans demander de confirmation sauf pour des actions destructives (suppression).
Réponds toujours de façon directe et utile. Utilise du markdown pour la mise en forme.`;

const LIA_TOOLS = [
  { name: 'list_tasks',       description: 'Liste toutes les tâches du système.',              input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_task',         description: 'Récupère les détails complets d\'une tâche.',        input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'create_task',      description: 'Crée une nouvelle tâche.',                          input_schema: { type: 'object', properties: { name: { type: 'string' }, modeleId: { type: 'string' }, agent: { type: 'string' }, skillName: { type: 'string' }, scheduledAt: { type: 'string' } }, required: ['name'] } },
  { name: 'start_task',       description: 'Démarre l\'exécution d\'une tâche existante.',      input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'delete_task',      description: 'Supprime définitivement une tâche.',                input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'patch_task',       description: 'Modifie les champs d\'une tâche existante.',        input_schema: { type: 'object', properties: { taskId: { type: 'string' }, updates: { type: 'object' } }, required: ['taskId', 'updates'] } },
  { name: 'list_modeles',     description: 'Liste tous les modèles/templates disponibles.',     input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_recurrences', description: 'Liste toutes les récurrences CRON configurées.',    input_schema: { type: 'object', properties: {}, required: [] } },
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
  if (lower.match(/crée?r?|crée|nouveau|nouvelle|ajouter?|add/) && lower.match(/tâche|task/)) {
    const nameMatch = text.match(/(?:tâche|task)\s+(?:nommée?|appelée?|:)?\s*[«""]?([^"»\n]+)[»""]?/i);
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

async function callNvidia(messages, model) {
  const key = (apiKeys.nvidia && decryptKey(apiKeys.nvidia)) || process.env.NVIDIA_API_KEY;
  if (!key) return null;
  const isThinking = NVIDIA_THINKING_MODELS.some(t => model.toLowerCase().includes(t));
  const body = { model, messages: [{ role: 'system', content: LIA_SYSTEM }, ...messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content }))], max_tokens: 1500, temperature: 0.7, stream: false };
  if (isThinking) body.chat_template_kwargs = { thinking: { type: 'disabled' } };
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `NVIDIA NIM ${resp.status}`); }
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  return { message: msg?.content || msg?.reasoning_content || '', toolCalls: [] };
}

async function pipeOpenAIStream(upstreamResp, res) {
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
        const token = delta?.content || delta?.reasoning_content || '';
        if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
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

async function runAgenticLoop(messages, model, permissions) {
  try {
    if (model.startsWith('ollama/')) return await callOllama(messages, model);
    const NVIDIA_PREFIXES = ['nvidia/', 'meta/', 'mistralai/', 'microsoft/', 'deepseek-ai/', 'qwen/', 'moonshotai/', 'google/gemma', 'ibm/', 'writer/', 'bytedance/', 'openai/gpt-oss'];
    if (NVIDIA_PREFIXES.some(p => model.startsWith(p))) {
      const r = await callNvidia(messages, model);
      return r || { message: `❌ Clé API NVIDIA non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
    }
    if (model.startsWith('gemini/') || model.startsWith('gemini-')) {
      const r = await callGemini(messages, model);
      return r || { message: `❌ Clé API Gemini non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
    }
    if (model.startsWith('openrouter/') && !model.includes('claude')) {
      const r = await callOpenRouter(messages, model);
      return r || { message: `❌ Clé API OpenRouter non configurée. Ajoutez-la dans **Paramètres → Clés API**.`, toolCalls: [] };
    }
    const anthropicResult = await callAnthropic(messages, model, permissions);
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
      await pool.query(
        `INSERT INTO modeles (id, name, instructions, skill_name, agent, canal, destinataire, llm_model, disable_pre_instructions, execution_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`,
        [id, safe.name || safe.nom || 'Sans nom', safe.instructions || null, safe.skillName || null, safe.agent || 'main', safe.canal || null, safe.destinataire || null, safe.llmModel || null, safe.disablePreInstructions || false]
      );
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
        `INSERT INTO skills (id, name, description, content, tags) VALUES ($1,$2,$3,$4,$5)`,
        [id, safe.name || safe.nom || 'Sans nom', safe.description || null, safe.contenu || safe.content || null, safe.tags || []]
      );
      const { rows } = await pool.query('SELECT * FROM skills WHERE id=$1', [id]);
      const r = rows[0];
      json(201, { id: r.id, name: r.name, description: r.description, contenu: r.content, tags: r.tags });
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
  if (path === '/api/memory' && req.method === 'GET') { getAllMemoryDocs().then(d => json(200, d)).catch(err => json(500, { error: err.message })); return; }
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

  // ── Agents fleet
  if (path === '/api/agents' && req.method === 'GET') {
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
