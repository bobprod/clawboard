/**
 * apiFetch — drop-in fetch wrapper that injects the Bearer token when
 * VITE_AUTH_TOKEN is set. Falls back to plain fetch if the variable is empty.
 */
const AUTH_TOKEN: string = import.meta.env.VITE_AUTH_TOKEN ?? '';

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!AUTH_TOKEN) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${AUTH_TOKEN}`);
  return fetch(url, { ...init, headers });
}
