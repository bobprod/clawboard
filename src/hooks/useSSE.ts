import { useState, useEffect } from 'react';

const BASE = 'http://localhost:4000';

export function useSSE<T>(path: string, initialValue: T): { data: T; connected: boolean } {
  const [data, setData] = useState<T>(initialValue);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = `${BASE}${path}`;
    let es: EventSource;
    let retryTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource(url);

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try { setData(JSON.parse(e.data)); } catch (_) {}
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        retryTimeout = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [path]);

  return { data, connected };
}
