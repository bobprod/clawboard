/**
 * useApiKeys — BYOK (Bring Your Own Key) management hook.
 *
 * Keys are stored in localStorage (persist across sessions) under
 * 'clawboard-api-keys' and synced to the backend (POST /api/settings/keys)
 * so the Node server can use them when calling LLM APIs on behalf of the user.
 *
 * ⚠️  Keys never leave the user's machine to any third party.
 *     They are sent only to localhost:4000 (the ClawBoard backend).
 *
 * On mount, the hook fetches backend status (GET /api/settings/keys) so that
 * keys persisted in Postgres but absent from localStorage still show as
 * configured (e.g. after clearing browser data or on a new device).
 */

import { useState, useCallback, useEffect } from 'react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';
const STORAGE_KEY = 'clawboard-api-keys';

export type ApiKeyStore = Record<string, string>;

const load = (): ApiKeyStore => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
};

const save = (keys: ApiKeyStore) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
};

export const useApiKeys = () => {
  const [keys, setKeysState] = useState<ApiKeyStore>(load);
  const [backendStatus, setBackendStatus] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // On mount: fetch which keys the backend already has in DB.
  // Merges with localStorage so the UI reflects reality even if localStorage
  // was cleared (new browser, private mode, etc.).
  useEffect(() => {
    apiFetch(`${BASE}/api/settings/keys`)
      .then(r => r.json())
      .then((data: { configured?: Record<string, boolean> }) => {
        setBackendStatus(data.configured || {});
      })
      .catch(() => {});
  }, []);

  /** Update a single key in state + localStorage (not yet synced to backend). */
  const setKey = useCallback((provider: string, value: string) => {
    setKeysState(prev => {
      const next = { ...prev };
      if (value.trim()) next[provider] = value.trim();
      else delete next[provider];
      save(next);
      return next;
    });
  }, []);

  /** Remove a key locally and from backend. */
  const clearKey = useCallback((provider: string) => {
    setKeysState(prev => {
      const next = { ...prev };
      delete next[provider];
      save(next);
      return next;
    });
    // Also remove from backend status so UI updates immediately
    setBackendStatus(prev => { const n = { ...prev }; delete n[provider]; return n; });
  }, []);

  /** Push all current keys to the backend so Lia can use them. */
  const syncToBackend = useCallback(async (): Promise<boolean> => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await apiFetch(`${BASE}/api/settings/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keys),
      });
      if (!res.ok) throw new Error(`Backend error ${res.status}`);
      // Refresh backend status after sync
      const data = await res.json();
      if (data.configured) {
        setBackendStatus(Object.fromEntries((data.configured as string[]).map((k: string) => [k, true])));
      }
      setLastSync(new Date());
      return true;
    } catch (e: any) {
      setSyncError(e.message);
      return false;
    } finally {
      setSyncing(false);
    }
  }, [keys]);

  /** Fetch which keys are already configured on the backend (status only, not values). */
  const fetchBackendStatus = useCallback(async (): Promise<Record<string, boolean>> => {
    try {
      const res = await apiFetch(`${BASE}/api/settings/keys`);
      const data = await res.json();
      const status = data.configured || {};
      setBackendStatus(status);
      return status;
    } catch {
      return {};
    }
  }, []);

  // A provider is configured if it has a local value OR the backend has it in DB
  const isConfigured = (provider: string) =>
    Boolean(keys[provider]?.trim()) || Boolean(backendStatus[provider]);

  // Count unique configured providers across both sources
  const allConfigured = new Set([
    ...Object.keys(keys).filter(p => keys[p]?.trim()),
    ...Object.keys(backendStatus).filter(p => backendStatus[p]),
  ]);
  const configuredCount = allConfigured.size;

  return {
    keys, setKey, clearKey, syncToBackend, fetchBackendStatus,
    syncing, lastSync, syncError, isConfigured, configuredCount,
    backendStatus,
  };
};
