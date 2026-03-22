// src/lib/redis.js
// Client Redis/Memurai partagé par tout le backend.
//
// Usage :
//   import { pub, sub, cache } from './src/lib/redis.js';
//
// pub  → écriture (SET, PUBLISH, DEL…)
// sub  → abonnements (SUBSCRIBE) — connexion dédiée obligatoire
// cache → helpers get/set avec TTL

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function makeClient(name) {
  const client = createClient({ url: REDIS_URL });
  client.on('error', err => console.error(`[Redis:${name}]`, err.message));
  client.on('ready', () => console.log(`[Redis:${name}] connecté → ${REDIS_URL}`));
  return client;
}

export const pub = makeClient('pub');
export const sub = makeClient('sub');

// ─── Helpers cache ────────────────────────────────────────────────────────────

/**
 * Lit une valeur JSON depuis Redis.
 * Retourne null si absente ou expirée.
 */
export async function cacheGet(key) {
  const raw = await pub.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Écrit une valeur JSON dans Redis avec TTL en secondes (défaut 5s).
 */
export async function cacheSet(key, value, ttlSeconds = 5) {
  await pub.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

/**
 * Invalide une clé de cache.
 */
export async function cacheDel(key) {
  await pub.del(key);
}

/**
 * Connecte les deux clients. À appeler au démarrage.
 */
export async function connectRedis() {
  await pub.connect();
  await sub.connect();
}
