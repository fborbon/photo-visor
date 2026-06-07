import { createContext, useCallback, useContext, useState, useEffect } from 'react';
import { getCurrentUser, fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';

const LS_KEY = 'photo_visor_favorites';

interface FavData { updated: string; items: string[]; }

interface FavoritesCtx {
  favorites:      Set<string>;
  toggleFavorite: (path: string) => void;
  isFavorite:     (path: string) => boolean;
}

const Ctx = createContext<FavoritesCtx>({
  favorites: new Set(), toggleFavorite: () => {}, isFavorite: () => false,
});

function lsLoad(): FavData {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') ?? { updated: '', items: [] }; }
  catch { return { updated: '', items: [] }; }
}
function lsSave(d: FavData) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch { /* quota */ }
}
function favS3Key(ownerKey: string) { return `index/favorites/${ownerKey}.json`; }

async function s3Put(ownerKey: string, creds: unknown, data: FavData) {
  const s3 = new S3Client({ region: config.region, credentials: creds as never });
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName, Key: favS3Key(ownerKey),
    Body: JSON.stringify(data), ContentType: 'application/json',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
}

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [data,     setData]     = useState<FavData>(() => lsLoad());
  const [ownerKey, setOwnerKey] = useState('');
  const [creds,    setCreds]    = useState<unknown>(null);

  // Resolve identity, get S3 credentials, pull from S3 on mount
  useEffect(() => {
    getCurrentUser().then(u => {
      const email = u.signInDetails?.loginId ?? '';
      const okey  = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      setOwnerKey(okey);
      fetchAuthSession().then(s => setCreds(s.credentials ?? null)).catch(() => {});

      fetch(config.cloudFrontUrl + '/' + favS3Key(okey) + '?nc=' + Date.now())
        .then(r => (r.ok ? r.json() as Promise<FavData> : null))
        .then((remote: FavData | null) => {
          if (!remote || !Array.isArray(remote.items)) return;
          setData(local => {
            const winner = (local.updated && remote.updated && local.updated > remote.updated)
              ? local : remote;
            lsSave(winner);
            return winner;
          });
        })
        .catch(() => {});
    }).catch(() => {});
  }, []);

  const toggleFavorite = useCallback((path: string) => {
    const items = new Set(data.items);
    if (items.has(path)) items.delete(path); else items.add(path);
    const next: FavData = { updated: new Date().toISOString(), items: [...items] };
    setData(next);
    lsSave(next);
    if (ownerKey && creds) s3Put(ownerKey, creds, next).catch(() => {});
  }, [data, ownerKey, creds]);

  const isFavorite = useCallback((path: string) => (data.items ?? []).includes(path), [data]);
  const favorites  = new Set(data.items ?? []);

  return (
    <Ctx.Provider value={{ favorites, toggleFavorite, isFavorite }}>
      {children}
    </Ctx.Provider>
  );
}

export const useFavorites = () => useContext(Ctx);
