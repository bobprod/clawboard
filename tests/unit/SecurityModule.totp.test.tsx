/**
 * Unit tests — SecurityModule TOTP MFA panel.
 *
 * Strategy: stub global.fetch so no real HTTP requests are made.
 * We render the full SecurityModule (which embeds TotpMfaPanel) and
 * drive the complete setup → verify → enabled → disable flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SecurityModule } from '../../src/components/SecurityModule';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const mockFetch = vi.fn();

// Default stub: guardrails & events return empty; TOTP disabled
const setupFetchMock = (totpEnabled = false) => {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/security/guardrails')) return Promise.resolve(makeRes([]));
    if (url.includes('/api/security/events'))    return Promise.resolve(makeRes([]));
    if (url.includes('/api/security/totp/status')) return Promise.resolve(makeRes({ enabled: totpEnabled }));
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Render helper ────────────────────────────────────────────────────────────

const renderModule = () => render(<SecurityModule />);

// ─── Tests: initial state ─────────────────────────────────────────────────────

describe('TotpMfaPanel — initial render', () => {
  it('shows the TOTP section heading', async () => {
    setupFetchMock(false);
    renderModule();
    await waitFor(() => {
      expect(screen.getByText(/Authentification TOTP/i)).toBeInTheDocument();
    });
  });

  it('shows "Désactivé" badge when MFA is off', async () => {
    setupFetchMock(false);
    renderModule();
    await waitFor(() => {
      expect(screen.getByText(/Désactivé/i)).toBeInTheDocument();
    });
  });

  it('shows "Activé" badge when server reports MFA enabled', async () => {
    setupFetchMock(true);
    renderModule();
    await waitFor(() => {
      expect(screen.getByText(/Activé/i)).toBeInTheDocument();
    });
  });

  it('renders "Configurer le MFA" button when disabled', async () => {
    setupFetchMock(false);
    renderModule();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Configurer le MFA/i })).toBeInTheDocument();
    });
  });

  it('shows feature highlights before setup', async () => {
    setupFetchMock(false);
    renderModule();
    // "Compatible Google Authenticator" is the exact badge label (unique text)
    await waitFor(() => {
      expect(screen.getByText(/Compatible Google Authenticator/i)).toBeInTheDocument();
      expect(screen.getByText(/8 codes de secours générés/i)).toBeInTheDocument();
    });
  });
});

// ─── Tests: setup flow (API success) ─────────────────────────────────────────

describe('TotpMfaPanel — setup via API', () => {
  const MOCK_SETUP = {
    secret: 'JBSWY3DPEHPK3PXP',
    otpAuthUrl: 'otpauth://totp/ClawBoard:test@test.com?secret=JBSWY3DPEHPK3PXP&issuer=ClawBoard',
    backupCodes: ['AAAA-1111', 'BBBB-2222'],
  };

  beforeEach(() => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/security/guardrails')) return Promise.resolve(makeRes([]));
      if (url.includes('/api/security/events'))    return Promise.resolve(makeRes([]));
      if (url.includes('/api/security/totp/status')) return Promise.resolve(makeRes({ enabled: false }));
      if (url.includes('/api/security/totp/setup') && init?.method === 'POST')
        return Promise.resolve(makeRes(MOCK_SETUP));
      if (url.includes('/api/security/totp/verify') && init?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      if (url.includes('/api/security/totp/disable') && init?.method === 'POST')
        return Promise.resolve(makeRes({ success: true }));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  it('calls /api/security/totp/setup on button click', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));

    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(([url]) => url as string);
      expect(calls.some(u => u.includes('/api/security/totp/setup'))).toBe(true);
    });
  });

  it('shows QR code image after setup', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => {
      expect(screen.getByAltText(/QR TOTP/i)).toBeInTheDocument();
    });
  });

  it('QR image src contains encoded otpAuthUrl', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => {
      const img = screen.getByAltText(/QR TOTP/i) as HTMLImageElement;
      expect(img.src).toContain('api.qrserver.com');
      expect(img.src).toContain(encodeURIComponent(MOCK_SETUP.otpAuthUrl));
    });
  });

  it('shows "Clé secrète" label after setup', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    // Full label text is "Clé secrète (saisie manuelle)" — use full string for uniqueness
    await waitFor(() => {
      expect(screen.getByText(/Clé secrète \(saisie manuelle\)/i)).toBeInTheDocument();
    });
  });

  it('verify button is disabled until 6 digits are entered', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByRole('button', { name: /Vérifier/i }));

    const verifyBtn = screen.getByRole('button', { name: /Vérifier/i });
    expect(verifyBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '12345' } });
    expect(verifyBtn).toBeDisabled(); // still 5 digits

    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    expect(verifyBtn).not.toBeDisabled();
  });

  it('token input only accepts digits', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));

    const input = screen.getByPlaceholderText('000000') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc123' } });
    expect(input.value).toBe('123'); // letters stripped
  });

  it('calls /api/security/totp/verify with token on submit', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls;
      const verifyCall = calls.find(([url]) => (url as string).includes('/api/security/totp/verify'));
      expect(verifyCall).toBeDefined();
      const body = JSON.parse(verifyCall![1]?.body as string);
      expect(body.token).toBe('123456');
    });
  });

  it('shows "MFA activé" after successful verification', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => {
      expect(screen.getByText(/MFA activé avec succès/i)).toBeInTheDocument();
    });
  });

  it('shows "Désactiver le MFA" button after enabling', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Désactiver le MFA/i })).toBeInTheDocument();
    });
  });

  it('calls /api/security/totp/disable when disabling', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => screen.getByRole('button', { name: /Désactiver le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Désactiver le MFA/i }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls;
      expect(calls.some(([url]) => (url as string).includes('/api/security/totp/disable'))).toBe(true);
    });
  });

  it('returns to idle state after disabling MFA', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '112233' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => screen.getByRole('button', { name: /Désactiver le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Désactiver le MFA/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Configurer le MFA/i })).toBeInTheDocument();
    });
  });
});

// ─── Tests: setup flow (API fails — mock fallback) ────────────────────────────

describe('TotpMfaPanel — graceful mock fallback when API absent', () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/security/guardrails')) return Promise.resolve(makeRes([]));
      if (url.includes('/api/security/events'))    return Promise.resolve(makeRes([]));
      // All TOTP endpoints fail → trigger mock fallback
      return Promise.reject(new Error('Network error'));
    });
  });

  it('shows QR code using mock data when API fails', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => {
      expect(screen.getByAltText(/QR TOTP/i)).toBeInTheDocument();
    });
  });

  it('mock QR uses JBSWY3DPEHPK3PXP demo secret', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => {
      const img = screen.getByAltText(/QR TOTP/i) as HTMLImageElement;
      expect(img.src).toContain('JBSWY3DPEHPK3PXP');
    });
  });

  it('accepts any 6-digit code in mock mode', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /Vérifier/i }));

    await waitFor(() => {
      expect(screen.getByText(/MFA activé avec succès/i)).toBeInTheDocument();
    });
  });

  it('shows error for non-6-digit token in mock mode', async () => {
    renderModule();
    await waitFor(() => screen.getByRole('button', { name: /Configurer le MFA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configurer le MFA/i }));

    await waitFor(() => screen.getByPlaceholderText('000000'));
    // Enter letters (will be stripped to empty)
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: 'abc' } });

    const btn = screen.getByRole('button', { name: /Vérifier/i });
    expect(btn).toBeDisabled(); // guard: must have 6 digits
  });
});
