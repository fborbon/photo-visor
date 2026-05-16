import { useState, useEffect } from 'react';
import config from '../config';

const cache = new Map<string, unknown>();

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

    fetch(config.cloudFrontUrl + '/' + path)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
        return r.json() as Promise<T>;
      })
      .then(d => {
        cache.set(path, d);
        setData(d);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [path]);

  return { data, loading, error };
}
