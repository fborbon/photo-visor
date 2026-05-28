import {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import { PhotoEntry } from '../types';

interface TrashIndex {
  updated: string;
  photos:  PhotoEntry[];
}

interface TrashCtx {
  trashedPhotos: PhotoEntry[];
  isTrashed:      (hash: string) => boolean;
  trashPhotos:    (photos: PhotoEntry[]) => Promise<void>;
  restorePhotos:  (hashes: string[]) => Promise<void>;
  deleteForever:  (photos: PhotoEntry[]) => Promise<void>;
}

const TrashContext = createContext<TrashCtx>({
  trashedPhotos: [],
  isTrashed:     () => false,
  trashPhotos:   async () => {},
  restorePhotos: async () => {},
  deleteForever: async () => {},
});

const TRASH_KEY = 'index/trash.json';
const empty: TrashIndex = { updated: '', photos: [] };

async function getS3(): Promise<S3Client> {
  const session = await fetchAuthSession();
  return new S3Client({ region: config.region, credentials: session.credentials as never });
}

async function putTrash(s3: S3Client, data: TrashIndex) {
  await s3.send(new PutObjectCommand({
    Bucket:      config.bucketName,
    Key:         TRASH_KEY,
    Body:        JSON.stringify(data),
    ContentType: 'application/json',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
}

export function TrashProvider({ children }: { children: ReactNode }) {
  const [trashData, setTrashData] = useState<TrashIndex>(empty);

  useEffect(() => {
    fetch(config.cloudFrontUrl + '/' + TRASH_KEY + '?nc=' + Date.now())
      .then(r => (r.ok ? r.json() as Promise<TrashIndex> : null))
      .then((d: TrashIndex | null) => { if (d) setTrashData(d); })
      .catch(() => {});
  }, []);

  const isTrashed = useCallback((hash: string) =>
    trashData.photos.some(p => p.hash === hash), [trashData]);

  const trashPhotos = useCallback(async (photos: PhotoEntry[]) => {
    const existingHashes = new Set(trashData.photos.map(p => p.hash));
    const toAdd = photos.filter(p => !existingHashes.has(p.hash));
    if (!toAdd.length) return;
    const next: TrashIndex = {
      updated: new Date().toISOString(),
      photos: [...trashData.photos, ...toAdd],
    };
    setTrashData(next);
    try {
      const s3 = await getS3();
      await putTrash(s3, next);
    } catch (e) { console.error('Trash save failed:', e); }
  }, [trashData]);

  const restorePhotos = useCallback(async (hashes: string[]) => {
    const toRemove = new Set(hashes);
    const next: TrashIndex = {
      updated: new Date().toISOString(),
      photos: trashData.photos.filter(p => !toRemove.has(p.hash)),
    };
    setTrashData(next);
    try {
      const s3 = await getS3();
      await putTrash(s3, next);
    } catch (e) { console.error('Trash restore failed:', e); }
  }, [trashData]);

  const deleteForever = useCallback(async (photos: PhotoEntry[]) => {
    const hashes = new Set(photos.map(p => p.hash));
    const next: TrashIndex = {
      updated: new Date().toISOString(),
      photos: trashData.photos.filter(p => !hashes.has(p.hash)),
    };
    setTrashData(next);
    try {
      const s3 = await getS3();
      // Delete photo + thumb from S3
      for (const p of photos) {
        for (const key of [p.s3_key, p.thumb]) {
          if (!key) continue;
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
          } catch (e) { console.error('S3 delete failed:', key, e); }
        }
      }
      await putTrash(s3, next);
    } catch (e) { console.error('Delete forever failed:', e); }
  }, [trashData]);

  return (
    <TrashContext.Provider value={{ trashedPhotos: trashData.photos, isTrashed, trashPhotos, restorePhotos, deleteForever }}>
      {children}
    </TrashContext.Provider>
  );
}

export function useTrash() { return useContext(TrashContext); }
