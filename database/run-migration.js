import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: 'postgresql://postgres:admin@localhost:5432/clawboard' });

const SQL = `
CREATE TABLE IF NOT EXISTS modeles (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  priorite TEXT DEFAULT 'normale',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recurrences (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  description TEXT,
  cron TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  modele_id TEXT,
  actif BOOLEAN DEFAULT true,
  mode TEXT DEFAULT 'always',
  last_run TIMESTAMPTZ,
  next_run TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT,
  statut TEXT DEFAULT 'planifie',
  priorite TEXT DEFAULT 'normale',
  modele TEXT,
  llm TEXT,
  temperature FLOAT DEFAULT 0.7,
  max_tokens INTEGER,
  instructions TEXT,
  resultat TEXT,
  erreur TEXT,
  cout FLOAT DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  duree_ms INTEGER,
  tags TEXT[] DEFAULT '{}',
  recurrence_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_activities (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_executions (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  statut TEXT NOT NULL,
  cout FLOAT DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  duree_ms INTEGER,
  erreur TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pre_instructions (
  id INTEGER PRIMARY KEY DEFAULT 1,
  content TEXT,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  description TEXT,
  contenu TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_docs (
  id TEXT PRIMARY KEY,
  titre TEXT,
  content TEXT NOT NULL,
  chars INTEGER,
  embedding JSONB,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guardrails (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  description TEXT,
  actif BOOLEAN DEFAULT true,
  type TEXT,
  config JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline (
  id INTEGER PRIMARY KEY DEFAULT 1,
  nodes JSONB DEFAULT '[]',
  edges JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  provider TEXT UNIQUE NOT NULL,
  encrypted_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotas (
  id SERIAL PRIMARY KEY,
  modele TEXT UNIQUE NOT NULL,
  used FLOAT DEFAULT 0,
  limit_val FLOAT,
  cost FLOAT DEFAULT 0,
  is_local BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  resource TEXT,
  resource_id TEXT,
  user_ip TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_statut ON tasks(statut);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_activities_task ON task_activities(task_id);
CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
`;

async function migrate() {
  try {
    await pool.query(SQL);
    console.log('✅ Migration réussie — toutes les tables sont créées');
    const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    console.log('Tables:', res.rows.map(r => r.tablename).join(', '));
  } catch (err) {
    console.error('❌ Erreur migration:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
