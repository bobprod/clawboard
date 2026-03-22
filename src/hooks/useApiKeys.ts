/**
 * useApiKeys — BYOK (Bring Your Own Key) management hook.
 *
 * Keys are stored in sessionStorage (cleared on tab/browser close) under
 * 'clawboard-api-keys' and synced to the backend (POST /api/settings/keys)
 * so the Node server can use them when calling LLM APIs on behalf of the user.
 *
 * ⚠️  Keys never leave the user's machine to any third party.
 *     They are sent only to localhost:4000 (the ClawBoard backend).
 *
 * Security: sessionStorage is used instead of localStorage so keys are NOT
 * persisted across browser sessions. The backend stores them encrypted
 * (AES-256-GCM) in memory when CLAWBOARD_KEK is set.
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';
const STORAGE_KEY = 'clawboard-api-keys';

export type ApiKeyStore = Record<string, string>;

const load = (): ApiKeyStore => {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
};

const save = (keys: ApiKeyStore) => {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
};

export const useApiKeys = () => {
  const [keys, setKeysState] = useState<ApiKeyStore>(load);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

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

  /** Remove a key. */
  const clearKey = useCallback((provider: string) => {
    setKeysState(prev => {
      const next = { ...prev };
      delete next[provider];
      save(next);
      return next;
    });
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
      return data.configured || {};
    } catch {
      return {};
    }
  }, []);

  const isConfigured = (provider: string) => Boolean(keys[provider]?.trim());
  const configuredCount = Object.values(keys).filter(v => v?.trim()).length;

  return { keys, setKey, clearKey, syncToBackend, fetchBackendStatus, syncing, lastSync, syncError, isConfigured, configuredCount };
};
