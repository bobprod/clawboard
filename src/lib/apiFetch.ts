/**
 * apiFetch — wrapper fetch qui injecte le token Bearer.
 *
 * Priorité :
 *   1. localStorage `clawboard-token`  (défini après login)
 *   2. Variable d'environnement VITE_AUTH_TOKEN (CI / déploiement)
 *   3. Aucun header Authorization (accès public)
 */
const ENV_TOKEN: string = import.meta.env.VITE_AUTH_TOKEN ?? '';

function getToken(): string {
  return localStorage.getItem('clawboard-token') ?? ENV_TOKEN;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // Token invalide — on vide le localStorage et on redirige vers login
    localStorage.removeItem('clawboard-token');
    window.location.href = '/';
  }
  return res;
}
