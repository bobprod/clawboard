/**
 * Unit tests — SettingsModule
 *
 * Tests cover:
 *  - Section navigation (server / apikeys / security / notifications / profile)
 *  - Security section: fetches guardrails, renders toggles
 *  - Security section: PATCH on toggle click
 *  - Security section: demo fallback when fetch fails
 *  - Notifications section: renders all channel cards
 *  - Notifications section: save calls POST /api/settings/notifications
 *  - Notifications section: test button calls POST .../test
 *  - Profile section: shows username from localStorage
 *  - Profile section: save updates localStorage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsModule } from '../../src/components/SettingsModule';

// ─── Mock heavy sub-components ────────────────────────────────────────────────

vi.mock('../../src/hooks/useApiKeys', () => ({
  useApiKeys: () => ({
    keys: {}, setKey: vi.fn(), clearKey: vi.fn(),
    syncing: false, lastSync: null, syncError: null,
    syncToBackend: vi.fn().mockResolvedValue(undefined),
    configuredCount: 0, isConfigured: () => false,
  }),
}));

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('Network error'));
  localStorage.setItem('clawboard-user', JSON.stringify({
    username: 'alice', displayName: 'Alice', role: 'admin', avatar: null,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderSettings(tab = '') {
  render(
    <MemoryRouter initialEntries={[`/settings${tab ? `?tab=${tab}` : ''}`]}>
      <SettingsModule />
    </MemoryRouter>,
  );
}

// ─── Guardrails fixture ───────────────────────────────────────────────────────

const GUARDRAILS = [
  { id: 1, name: 'Blocage injections SQL',  description: 'Détecte SQL.',    enabled: true,  category: 'Inputs'        },
  { id: 2, name: 'Rate limiting par agent', description: 'Limite req/min.', enabled: false, category: 'Rate Limiting' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsModule — navigation', () => {
  it('renders the settings page title', () => {
    renderSettings();
    expect(screen.getByText(/paramètres systèmes/i)).toBeInTheDocument();
  });

  it('switches to API Keys section when nav item clicked', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /clés api/i }));
    // ApiKeysSection shows provider names
    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });
  });

  it('switches to Profile section when nav item clicked', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /profil/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
    });
  });
});

describe('SettingsModule — Security section', () => {
  it('fetches and displays guardrails', async () => {
    // Only the guardrails fetch matters here (no ping when tab=security)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GUARDRAILS });

    renderSettings('security');
    await waitFor(() => {
      expect(screen.getByText('Blocage injections SQL')).toBeInTheDocument();
      expect(screen.getByText('Rate limiting par agent')).toBeInTheDocument();
    });
  });

  it('shows demo fallback guardrails when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    renderSettings('security');
    await waitFor(() => {
      expect(screen.getByText(/blocage injections sql/i)).toBeInTheDocument();
    });
  });

  it('shows enabled/disabled counts', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GUARDRAILS });

    renderSettings('security');
    await waitFor(() => {
      // 1 enabled, 1 disabled from GUARDRAILS fixture
      expect(screen.getByText((_, el) =>
        el?.textContent?.match(/^1 actif$/) !== null
      )).toBeInTheDocument();
      expect(screen.getByText((_, el) =>
        el?.textContent?.match(/^1 désactivé$/) !== null
      )).toBeInTheDocument();
    });
  });

  it('calls PATCH /api/security/guardrails on toggle', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => GUARDRAILS })
      .mockResolvedValueOnce({ ok: true, json: async () => GUARDRAILS.map(g => g.id === 1 ? { ...g, enabled: false } : g) });

    renderSettings('security');
    await waitFor(() => screen.getByText('Blocage injections SQL'));

    const toggleButtons = screen.getAllByTitle(/activer|désactiver/i);
    fireEvent.click(toggleButtons[0]);

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(c =>
        String(c[0]).includes('/api/security/guardrails') && c[1]?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });
  });
});

describe('SettingsModule — Notifications section', () => {
  const NOTIF_RESPONSE = {
    telegram_token: '', telegram_chat_id: '',
    discord_webhook: '', email_smtp: '', email_from: '', email_to: '',
    webhook_url: '', notify_on_task_done: true, notify_on_task_failed: true, notify_on_approval: true,
  };

  it('renders all channel cards', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => NOTIF_RESPONSE });
    renderSettings('notifications');
    await waitFor(() => {
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('Discord')).toBeInTheDocument();
      expect(screen.getByText(/email.*smtp/i)).toBeInTheDocument();
      expect(screen.getByText(/webhook générique/i)).toBeInTheDocument();
    });
  });

  it('calls POST /api/settings/notifications on save', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => NOTIF_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    renderSettings('notifications');
    await waitFor(() => screen.getByText('Telegram'));

    // Click the Notifications-section-specific save button (last "Enregistrer")
    const saveButtons = screen.getAllByRole('button', { name: /enregistrer/i });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      const saveCall = mockFetch.mock.calls.find(c =>
        String(c[0]).includes('/api/settings/notifications') &&
        c[1]?.method === 'POST' &&
        !String(c[0]).includes('/test')
      );
      expect(saveCall).toBeDefined();
    });
  });

  it('calls POST .../notifications/test on Tester button', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => NOTIF_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, message: 'Message test envoyé via telegram.' }) });

    renderSettings('notifications');
    await waitFor(() => screen.getByText('Telegram'));

    const testButtons = screen.getAllByRole('button', { name: /tester/i });
    fireEvent.click(testButtons[0]);

    await waitFor(() => {
      const testCall = mockFetch.mock.calls.find(c => String(c[0]).includes('/test'));
      expect(testCall).toBeDefined();
    });
  });

  it('shows success message after successful test', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => NOTIF_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, message: 'Message test envoyé via telegram.' }) });

    renderSettings('notifications');
    await waitFor(() => screen.getByText('Telegram'));

    fireEvent.click(screen.getAllByRole('button', { name: /tester/i })[0]);
    await waitFor(() => {
      // The success message contains "Message test envoyé" split with channel name
      expect(screen.getByText(/message test envoyé/i)).toBeInTheDocument();
    });
  });
});

describe('SettingsModule — Profile section', () => {
  it('shows username from localStorage', async () => {
    renderSettings('profile');
    await waitFor(() => {
      expect(screen.getByDisplayValue('alice')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
    });
  });

  it('save updates clawboard-user in localStorage', async () => {
    renderSettings('profile');
    await waitFor(() => screen.getByDisplayValue('Alice'));

    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Alice Dupont' } });

    // Click the save button inside the identity card (not the global page button)
    const saveButtons = screen.getAllByRole('button', { name: /enregistrer/i });
    // The first one in ProfileSection is the identity save (not the global Enregistrer at top)
    const profileSave = saveButtons.find(b => b.closest('.glass-panel'));
    fireEvent.click(profileSave ?? saveButtons[0]);

    await waitFor(() => {
      const user = JSON.parse(localStorage.getItem('clawboard-user') ?? '{}');
      expect(user.displayName).toBe('Alice Dupont');
    });
  });
});
