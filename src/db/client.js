// src/db/client.js
// Pool de connexions PostgreSQL — partagé par tout le backend.
//
// Configuration via la variable d'environnement DATABASE_URL :
//   postgresql://user:password@localhost:5432/clawboard
//
// Usage :
//   import pool from './src/db/client.js';
//   const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('[DB] DATABASE_URL non configuré — la persistance PostgreSQL est désactivée.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Taille du pool : 2 connexions min, 10 max (suffisant pour un serveur solo)
  min: 2,
  max: 10,
  // Délai avant de libérer une connexion idle (30s)
  idleTimeoutMillis: 30_000,
  // Timeout si aucune connexion disponible dans le pool (5s)
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Erreur inattendue sur une connexion idle :', err.message);
});

pool.on('connect', () => {
  // Vérification silencieuse — log seulement au démarrage
});

/**
 * Teste la connexion à la base. Lance une exception si la BDD est inaccessible.
 * Appelé au démarrage du serveur pour un fail-fast explicite.
 */
export async function checkConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('[DB] Connexion PostgreSQL établie.');
  } finally {
    client.release();
  }
}

export default pool;
