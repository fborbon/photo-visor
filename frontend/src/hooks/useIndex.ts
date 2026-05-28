import { useState, useEffect } from 'react';
import config from '../config';

const cache = new Map<string, unknown>();

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/json-parse.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e: MessageEvent<{ data?: T; error?: string }>) => {
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.data as T);
    };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
    worker.postMessage({ url });
  });
}

export function useIndex<T>(path: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData]       = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;

    if (cache.has(path)) {
      setData(cache.get(path) as T);
      return;
    }

    setLoading(true);
    setError(null);

    fetchJson<T>(config.cloudFrontUrl + '/' + path)
      .then(d => {
        cache.set(path, d);
        setData(d);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [path]);

  return { data, loading, error };
}
