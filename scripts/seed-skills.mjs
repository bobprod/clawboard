#!/usr/bin/env node
/**
 * scripts/seed-skills.mjs
 * Importe les fichiers skills/*.md en base PostgreSQL (si absent).
 * Usage : node scripts/seed-skills.mjs
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ── Connexion DB ──────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL manquant. Ajoutez-le dans .env ou exportez-le.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Parse frontmatter YAML simple ────────────────────────────────────────────

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta  = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    if (!key) continue;
    const val = rest.join(':').trim();
    // tags: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key.trim()] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      meta[key.trim()] = val;
    }
  }

  return { meta, content: match[2].trim() };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const skillsDir = join(ROOT, 'skills');
  const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));

  console.log(`\n📦  Seed skills — ${files.length} fichiers trouvés\n`);

  let inserted = 0;
  let skipped  = 0;

  for (const file of files) {
    const raw    = readFileSync(join(skillsDir, file), 'utf8');
    const parsed = parseFrontmatter(raw);

    if (!parsed) {
      console.warn(`  ⚠️  ${file} — frontmatter invalide, ignoré`);
      continue;
    }

    const { meta, content } = parsed;
    const id       = meta.id       || file.replace('.md', '');
    const name     = meta.name     || id;
    const desc     = meta.description || '';
    const tags     = Array.isArray(meta.tags) ? meta.tags : [];
    const category = meta.category || 'general';
    const status   = meta.status   || 'active';

    // INSERT … ON CONFLICT DO NOTHING — ne touche pas les skills déjà présents
    const { rowCount } = await pool.query(
      `INSERT INTO skills (id, name, description, content, tags, category, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, desc, content, tags, category, status]
    );

    if (rowCount > 0) {
      console.log(`  ✅  ${id} — inséré`);
      inserted++;
    } else {
      console.log(`  ⏭️   ${id} — déjà présent, ignoré`);
      skipped++;
    }
  }

  console.log(`\n✔  Terminé — ${inserted} insérés, ${skipped} ignorés\n`);
  await pool.end();
}

main().catch(err => {
  console.error('❌  Erreur seed :', err.message);
  process.exit(1);
});
