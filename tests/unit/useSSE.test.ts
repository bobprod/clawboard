/**
 * Unit tests for the useSSE hook.
 *
 * We mock the global EventSource so no real HTTP request is made.
 * Tests cover: initial state, open/message/error events, reconnect,
 * JSON parse failure tolerance, and cleanup on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE } from '../../src/hooks/useSSE';

// ─── Mock EventSource ────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen:    ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror:   ((e: Event) => void) | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() { this.readyState = 2; /* CLOSED */ }

  /** Helper: trigger an event on this mock */
  emit(event: 'open' | 'message' | 'error', data?: string) {
    switch (event) {
      case 'open':
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        break;
      case 'message':
        this.onmessage?.(new MessageEvent('message', { data: data ?? '' }));
        break;
      case 'error':
        this.readyState = 0;
        this.onerror?.(new Event('error'));
        break;
    }
  }
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useSSE — initial state', () => {
  it('returns initialValue before any event', () => {
    const { result } = renderHook(() => useSSE('/api/tasks', null));
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it('uses the correct initialValue type', () => {
    const { result } = renderHook(() => useSSE('/api/tasks', [] as string[]));
    expect(result.current.data).toEqual([]);
  });
});

describe('useSSE — connection', () => {
  it('creates an EventSource with the full URL', () => {
    renderHook(() => useSSE('/api/vitals', null));
    expect(MockEventSource.instances[0].url).toBe('http://localhost:4000/api/vitals');
  });

  it('sets connected=true when onopen fires', () => {
    const { result } = renderHook(() => useSSE('/api/vitals', null));
    act(() => MockEventSource.instances[0].emit('open'));
    expect(result.current.connected).toBe(true);
  });
});

describe('useSSE — messages', () => {
  it('parses valid JSON and updates data', () => {
    const { result } = renderHook(() => useSSE<{ ok: boolean } | null>('/api/ping', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('message', JSON.stringify({ ok: true }));
    });
    expect(result.current.data).toEqual({ ok: true });
  });

  it('handles array payloads', () => {
    const { result } = renderHook(() => useSSE<string[] | null>('/api/test', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('message', JSON.stringify(['a', 'b', 'c']));
    });
    expect(result.current.data).toEqual(['a', 'b', 'c']);
  });

  it('replaces data on subsequent messages', () => {
    const { result } = renderHook(() => useSSE<number | null>('/api/test', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('message', '1');
      MockEventSource.instances[0].emit('message', '2');
      MockEventSource.instances[0].emit('message', '3');
    });
    expect(result.current.data).toBe(3);
  });

  it('silently ignores malformed JSON without crashing', () => {
    const { result } = renderHook(() => useSSE<string | null>('/api/test', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('message', '{{{not valid json}}}');
    });
    expect(result.current.data).toBeNull(); // unchanged
    expect(result.current.connected).toBe(true); // still connected
  });

  it('ignores empty string payload', () => {
    const { result } = renderHook(() => useSSE<string | null>('/api/test', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('message', '');
    });
    expect(result.current.data).toBeNull();
  });
});

describe('useSSE — error & reconnect', () => {
  it('sets connected=false when onerror fires', () => {
    const { result } = renderHook(() => useSSE('/api/test', null));
    act(() => {
      MockEventSource.instances[0].emit('open');
      MockEventSource.instances[0].emit('error');
    });
    expect(result.current.connected).toBe(false);
  });

  it('closes the errored EventSource', () => {
    renderHook(() => useSSE('/api/test', null));
    const first = MockEventSource.instances[0];
    act(() => first.emit('error'));
    expect(first.readyState).toBe(2); // CLOSED
  });

  it('creates a new EventSource after 3s reconnect delay', () => {
    vi.useFakeTimers();
    renderHook(() => useSSE('/api/test', null));
    act(() => MockEventSource.instances[0].emit('error'));
    expect(MockEventSource.instances.length).toBe(1);

    act(() => vi.advanceTimersByTime(3001));
    expect(MockEventSource.instances.length).toBe(2);
  });

  it('new EventSource reconnects to same URL', () => {
    vi.useFakeTimers();
    renderHook(() => useSSE('/api/quota', null));
    act(() => MockEventSource.instances[0].emit('error'));
    act(() => vi.advanceTimersByTime(3001));
    expect(MockEventSource.instances[1].url).toBe('http://localhost:4000/api/quota');
  });
});

describe('useSSE — cleanup', () => {
  it('closes EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE('/api/tasks', null));
    const es = MockEventSource.instances[0];
    unmount();
    expect(es.readyState).toBe(2); // CLOSED
  });

  it('cancels pending reconnect timer on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSSE('/api/test', null));
    act(() => MockEventSource.instances[0].emit('error'));

    unmount(); // should cancel the setTimeout

    // No new connection should be created after timeout
    act(() => vi.advanceTimersByTime(5000));
    expect(MockEventSource.instances.length).toBe(1); // only the original
  });
});
