#!/usr/bin/env node
// src/db/migrate.js
// Script de migration — crée toutes les tables ClawBoard (idempotent).
//
// Usage :
//   node src/db/migrate.js
//
// Pré-requis :
//   - DATABASE_URL défini dans .env ou dans l'environnement
//   - L'extension pgvector installée dans PostgreSQL
//     (voir instructions dans database/schema.sql)

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

// Charger .env si disponible (optionnel — pas de dépendance dotenv)
// Si vous utilisez dotenv : import 'dotenv/config'; avant ce script.
const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL non défini.');
  console.error('   Ajoutez-le dans votre .env ou exportez-le avant de lancer ce script.');
  console.error('   Exemple : DATABASE_URL=postgresql://postgres:motdepasse@localhost:5432/clawboard');
  process.exit(1);
}

const schemaPath = resolve(__dirname, '../../database/schema.sql');

let schemaSql;
try {
  schemaSql = readFileSync(schemaPath, 'utf8');
} catch (err) {
  console.error(`❌  Impossible de lire ${schemaPath} :`, err.message);
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

async function migrate() {
  console.log('🔄  Connexion à PostgreSQL…');
  const client = await pool.connect();

  try {
    console.log('🔄  Vérification de l\'extension pgvector…');

    // Tester si pgvector est disponible avant d'appliquer le schéma
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
      console.log('✅  Extension pgvector activée.');
    } catch (err) {
      console.error('❌  pgvector non disponible :', err.message);
      console.error('');
      console.error('   Pour installer pgvector sur Windows avec PostgreSQL 18 :');
      console.error('   1. Téléchargez le binaire depuis https://github.com/pgvector/pgvector/releases');
      console.error('      (choisissez la version compatible PG18)');
      console.error('   2. Copiez vector.dll dans C:\\Program Files\\PostgreSQL\\18\\lib\\');
      console.error('   3. Copiez vector.control et les fichiers SQL dans C:\\Program Files\\PostgreSQL\\18\\share\\extension\\');
      console.error('   4. Relancez ce script.');
      console.error('');
      console.error('   Alternative : la table memory_docs sera créée sans index vectoriel.');
      console.error('   Les embeddings resteront stockés mais les recherches seront plus lentes.');
    }

    console.log('🔄  Application du schéma…');
    await client.query('BEGIN');

    try {
      await client.query(schemaSql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    // Vérification des tables créées
    const { rows } = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const expected = [
      'api_keys', 'audit_logs', 'guardrails', 'memory_docs',
      'modeles', 'pipeline', 'pre_instructions', 'quotas',
      'recurrences', 'skills', 'task_activities', 'task_executions', 'tasks',
    ];

    const found = rows.map(r => r.tablename);
    const missing = expected.filter(t => !found.includes(t));

    console.log('');
    console.log('📋  Tables présentes dans la base :');
    for (const t of found) {
      const ok = expected.includes(t);
      console.log(`   ${ok ? '✅' : '  '} ${t}`);
    }

    if (missing.length > 0) {
      console.warn('');
      console.warn('⚠️   Tables attendues mais absentes :', missing.join(', '));
    } else {
      console.log('');
      console.log('✅  Migration terminée — toutes les tables sont en place.');
    }

  } catch (err) {
    console.error('');
    console.error('❌  Erreur pendant la migration :', err.message);
    console.error('   Détail :', err.detail || '(aucun détail)');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
