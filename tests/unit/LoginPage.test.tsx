/**
 * Unit tests — LoginPage
 *
 * Tests cover:
 *  - Renders form (username, password, submit button)
 *  - Empty-field validation (no API call made)
 *  - Successful login → localStorage set + onLogin called
 *  - 401 response → error message displayed
 *  - Network failure → demo fallback (demo token stored, onLogin called)
 *  - Password toggle show/hide
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginPage } from '../../src/components/LoginPage';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  localStorage.clear();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function renderLogin() {
  const onLogin = vi.fn();
  render(<LoginPage onLogin={onLogin} />);
  return { onLogin };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LoginPage', () => {
  it('renders username, password inputs and submit button', () => {
    renderLogin();
    expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument();
  });

  it('shows error when submitting with empty fields', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));
    expect(await screen.findByText(/identifiant et mot de passe requis/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows error when only username filled', async () => {
    renderLogin();
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));
    expect(await screen.findByText(/identifiant et mot de passe requis/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls POST /api/auth/login with credentials on submit', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'tok-123',
        user: { username: 'admin', displayName: 'Admin', role: 'admin', avatar: null },
      }),
    });

    const { onLogin } = renderLogin();
    fireEvent.change(screen.getByPlaceholderText('admin'),    { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'pass1' } });
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/login'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(localStorage.getItem('clawboard-token')).toBe('tok-123');
    const user = JSON.parse(localStorage.getItem('clawboard-user') ?? '{}');
    expect(user.username).toBe('admin');
    expect(user.demo).toBe(false);
  });

  it('shows error message on 401 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Identifiants incorrects.' }),
    });

    const { onLogin } = renderLogin();
    fireEvent.change(screen.getByPlaceholderText('admin'),    { target: { value: 'baduser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'badpass' } });
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));

    expect(await screen.findByText(/identifiants incorrects/i)).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('falls back to demo mode on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { onLogin } = renderLogin();
    fireEvent.change(screen.getByPlaceholderText('admin'),    { target: { value: 'myuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'anypass' } });
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(localStorage.getItem('clawboard-token')).toBe('demo-token');
    const user = JSON.parse(localStorage.getItem('clawboard-user') ?? '{}');
    expect(user.demo).toBe(true);
    expect(user.username).toBe('myuser');
  });

  it('toggles password visibility when eye button clicked', () => {
    renderLogin();
    const input = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    expect(input.type).toBe('password');

    // find the toggle button (has EyeOff or Eye icon, no text)
    const toggles = screen.getAllByRole('button');
    const eyeToggle = toggles.find(b => b.getAttribute('tabindex') === '-1')!;
    fireEvent.click(eyeToggle);
    expect(input.type).toBe('text');

    fireEvent.click(eyeToggle);
    expect(input.type).toBe('password');
  });

  it('clears error when user starts typing after an error', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /se connecter/i }));
    expect(await screen.findByText(/identifiant et mot de passe requis/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'a' } });
    expect(screen.queryByText(/identifiant et mot de passe requis/i)).not.toBeInTheDocument();
  });
});
