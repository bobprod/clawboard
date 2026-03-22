import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';

export const api = {
  async patchTask(id: string, updates: Record<string, unknown>) {
    const res = await apiFetch(`${BASE}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return res.json();
  },

  async createTask(task: Record<string, unknown>) {
    const res = await apiFetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task)
    });
    return res.json();
  },

  async createCron(cron: Record<string, unknown>) {
    const res = await apiFetch(`${BASE}/api/crons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cron)
    });
    return res.json();
  },

  async patchCron(id: string, updates: Record<string, unknown>) {
    const res = await apiFetch(`${BASE}/api/crons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return res.json();
  },

  async deleteCron(id: string) {
    await apiFetch(`${BASE}/api/crons/${id}`, { method: 'DELETE' });
  },

  async runCron(id: string) {
    const res = await apiFetch(`${BASE}/api/crons/${id}/run`, { method: 'POST' });
    return res.json();
  },

  async ping(): Promise<boolean> {
    try {
      const res = await apiFetch(`${BASE}/api/ping`);
      return res.ok;
    } catch {
      return false;
    }
  }
};
