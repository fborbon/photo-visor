import { useState, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import type { UserTags, PhotoEntry } from '../types';

function emailToTagsKey(email: string) {
  return 'index/tags/' + email.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.json';
}

const CURSOR_KEY      = 'photo_sync_cursor';
const AUTO_SYNC_KEY   = 'photo_sync_auto';
const RECENT_SYNC_KEY = 'photo_sync_recent';

const IMAGE_EXTS = /\.(jpg|jpeg|png|heic|heif|mp4|mov|gif|webp)$/i;

async function quickHash(blob: Blob): Promise<string> {
  const CHUNK = 65536;
  const sizeBuf = new ArrayBuffer(8);
  new DataView(sizeBuf).setBigUint64(0, BigInt(blob.size), false);
  const head  = await blob.slice(0, CHUNK).arrayBuffer();
  const parts: ArrayBuffer[] = [sizeBuf, head];
  if (blob.size > CHUNK * 2) parts.push(await blob.slice(-CHUNK).arrayBuffer());
  let off = 0;
  const merged = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  for (const p of parts) { merged.set(new Uint8Array(p), off); off += p.byteLength; }
  const digest = await crypto.subtle.digest('SHA-256', merged);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function s3Key(hash: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase() || '.jpg';
  return `photos/${hash.slice(0, 2)}/${hash}${ext}`;
}

function isCameraAlbum(albumIdentifier: string, albumName: string): boolean {
  return /\/DCIM\/Camera\b/i.test(albumIdentifier) || albumName.trim().toLowerCase() === 'camera';
}

export interface SyncStatus {
  phase:     'idle' | 'enumerating' | 'syncing' | 'done' | 'error';
  total:     number;
  processed: number;
  uploaded:  number;
  skipped:   number;
  failed:    number;
  message:   string;
}

const IDLE: SyncStatus = {
  phase: 'idle', total: 0, processed: 0, uploaded: 0, skipped: 0, failed: 0, message: '',
};

export function useSync(
  makePhotosPrivate: (hashes: string[]) => Promise<void>,
  makePhotosPublic:  (hashes: string[]) => Promise<void>,
) {
  const [status,   setStatus]   = useState<SyncStatus>(IDLE);
  const [lastSync, setLastSync] = useState<Date | null>(() => {
    const ts = localStorage.getItem(CURSOR_KEY);
    return ts ? new Date(ts) : null;
  });
  const [autoSync, setAutoSyncState] = useState<boolean>(
    () => localStorage.getItem(AUTO_SYNC_KEY) !== 'false'
  );
  const running  = useRef(false);
  const stopFlag = useRef(false);

  const stopSync = useCallback(() => { stopFlag.current = true; }, []);

  const setAutoSync = useCallback((val: boolean) => {
    setAutoSyncState(val);
    localStorage.setItem(AUTO_SYNC_KEY, String(val));
  }, []);

  const sync = useCallback(async () => {
    if (running.current) return;
    if (!Capacitor.isNativePlatform()) {
      setStatus({ ...IDLE, phase: 'error', message: 'web-only' });
      return;
    }

    running.current  = true;
    stopFlag.current = false;
    const patch = (p: Partial<SyncStatus>) => setStatus(prev => ({ ...prev, ...p }));

    // Keep the screen awake and JS running while sync is in progress.
    // Screen Wake Lock prevents Android from auto-dimming/locking during a long sync.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wakeLock: any = null;
    const acquireWakeLock = async () => {
      if ('wakeLock' in navigator) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { wakeLock = await (navigator as any).wakeLock.request('screen'); } catch { /* ignore */ }
      }
    };
    await acquireWakeLock();
    // Re-acquire if the lock is released (e.g. tab hidden then shown again)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && running.current) acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    try {
      // ── 0. Request gallery permission ────────────────────────────────
      const { Camera } = await import('@capacitor/camera');
      const perm = await Camera.requestPermissions({ permissions: ['photos'] });
      if (perm.photos !== 'granted') {
        patch({ phase: 'error', message: 'permission' });
        running.current = false;
        return;
      }

      // ── 1. Get album folder paths ─────────────────────────────────────
      patch({ phase: 'enumerating', message: '' });
      const { Media } = await import('@capacitor-community/media');
      const { albums } = await Media.getAlbums();

      // ── 2. List files in each album folder via Filesystem ────────────
      const { Filesystem } = await import('@capacitor/filesystem');
      const cursorStr = localStorage.getItem(CURSOR_KEY);
      const cursor    = cursorStr ? new Date(cursorStr) : null;

      type FileItem = { path: string; name: string; isCamera: boolean; albumName: string };
      const allItems: FileItem[] = [];
      const seenPaths = new Set<string>();

      const debugLines: string[] = [];

      for (const album of albums) {
        try {
          patch({ phase: 'enumerating', message: `Reading: ${album.name}…` });
          const { files } = await Filesystem.readdir({ path: album.identifier });
          const isCamera = isCameraAlbum(album.identifier, album.name);
          const imgFiles = files.filter(f => IMAGE_EXTS.test(f.name));
          debugLines.push(`✓ ${album.name}: ${imgFiles.length} photos`);

          for (const f of imgFiles) {
            const fullPath = album.identifier.replace(/\/$/, '') + '/' + f.name;
            if (seenPaths.has(fullPath)) continue;
            seenPaths.add(fullPath);
            if (cursor && f.mtime) {
              if (new Date(f.mtime) <= cursor) continue;
            }
            allItems.push({ path: fullPath, name: f.name, isCamera, albumName: album.name });
          }
        } catch (e) {
          debugLines.push(`✗ ${album.name}: ${String(e).slice(0, 60)}`);
          continue;
        }
      }

      // Show debug summary in the UI so we can diagnose without DevTools
      if (allItems.length === 0) {
        patch({ phase: 'error', message: 'debug:' + debugLines.join('\n') });
        running.current = false;
        return;
      }

      // Shuffle so each sync run processes different photos first
      for (let i = allItems.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allItems[i], allItems[j]] = [allItems[j], allItems[i]];
      }

      patch({ phase: 'syncing', total: allItems.length });

      if (allItems.length === 0) {
        if (cursor) {
          const ts = new Date().toISOString();
          localStorage.setItem(CURSOR_KEY, ts);
          setLastSync(new Date(ts));
        }
        patch({ phase: 'done', message: 'none' });
        running.current = false;
        return;
      }

      // ── 3. Get S3 client (credential provider auto-refreshes on expiry) ─
      const s3 = new S3Client({
        region: config.region,
        credentials: async () => {
          const s = await fetchAuthSession();
          if (!s.credentials) throw new Error('Not authenticated');
          return s.credentials as never;
        },
      });

      let uploaded = 0, skipped = 0, failed = 0;
      const privateHashes: string[] = [];
      // album name → list of {hash, s3_key} for auto-tagging
      const tagMap: Record<string, { hash: string; s3_key: string }[]> = {};
      const syncNow   = new Date().toISOString();
      const syncBatch: { hash: string; s3_key: string; syncedAt: string }[] = [];

      for (let i = 0; i < allItems.length; i++) {
        if (stopFlag.current) {
          patch({ phase: 'done', message: '' });
          running.current = false;
          return;
        }
        const { path, name, isCamera, albumName } = allItems[i];
        patch({ processed: i + 1, uploaded, skipped, failed, message: name });

        try {
          const webUrl = Capacitor.convertFileSrc(path);
          const r = await fetch(webUrl);
          if (!r.ok) throw new Error(`fetch ${r.status}`);
          const blob = await r.blob();
          const hash = await quickHash(blob);
          const key  = s3Key(hash, name);

          try {
            await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
            skipped++;
            if (!isCamera) privateHashes.push(hash);
            if (!tagMap[albumName]) tagMap[albumName] = [];
            tagMap[albumName].push({ hash, s3_key: key });
            syncBatch.push({ hash, s3_key: key, syncedAt: syncNow });
            patch({ skipped });
            continue;
          } catch { /* not found — upload */ }

          const buf = await blob.arrayBuffer();
          await s3.send(new PutObjectCommand({
            Bucket:       config.bucketName,
            Key:          key,
            Body:         new Uint8Array(buf),
            ContentType:  blob.type || 'image/jpeg',
            StorageClass: 'GLACIER_IR',
          }));

          uploaded++;
          if (!isCamera) privateHashes.push(hash);
          if (!tagMap[albumName]) tagMap[albumName] = [];
          tagMap[albumName].push({ hash, s3_key: key });
          syncBatch.push({ hash, s3_key: key, syncedAt: syncNow });
          patch({ uploaded });

        } catch {
          failed++;
          patch({ failed });
        }
      }

      // Persist synced records for Latest tab (newest first, capped at 100)
      if (syncBatch.length > 0) {
        try {
          const prev: { hash: string; s3_key: string; syncedAt: string }[] =
            JSON.parse(localStorage.getItem(RECENT_SYNC_KEY) ?? '[]');
          const prevHashes = new Set(prev.map(e => e.hash));
          const newOnes = syncBatch.filter(e => !prevHashes.has(e.hash));
          localStorage.setItem(RECENT_SYNC_KEY,
            JSON.stringify([...newOnes, ...prev].slice(0, 100)));
        } catch { /* ignore */ }
      }

      if (privateHashes.length > 0) {
        await makePhotosPrivate(privateHashes);
      }

      // ── Auto-tag photos with their album/folder name ──────────────────
      if (Object.keys(tagMap).length > 0) {
        patch({ message: 'Saving tags…' });
        const user    = await getCurrentUser();
        const email   = user.signInDetails?.loginId ?? '';
        const tagsKey = emailToTagsKey(email);
        const now     = new Date().toISOString();

        let existing: UserTags = { updated: '', tags: {}, comments: {}, commentTimes: {} };
        try {
          const r = await fetch(config.cloudFrontUrl + '/' + tagsKey + '?nc=' + Date.now());
          if (r.ok) existing = await r.json() as UserTags;
        } catch { /* start fresh */ }

        const updatedTags = { ...existing.tags };
        for (const [albumName, photos] of Object.entries(tagMap)) {
          const prev       = updatedTags[albumName] ?? { photos: [], albums: [], createdAt: now };
          const prevHashes = new Set((prev.photos as PhotoEntry[]).map(p => p.hash));
          const newPhotos: PhotoEntry[] = photos
            .filter(p => !prevHashes.has(p.hash))
            .map(({ hash, s3_key }) => ({
              hash, s3_key, thumb: null, dt: null,
              lat: null, lng: null, w: null, h: null,
            }));
          if (newPhotos.length === 0) continue;
          updatedTags[albumName] = { ...prev, photos: [...prev.photos, ...newPhotos] };
        }

        await s3.send(new PutObjectCommand({
          Bucket:       config.bucketName,
          Key:          tagsKey,
          Body:         JSON.stringify({ ...existing, updated: now, tags: updatedTags }),
          ContentType:  'application/json',
          CacheControl: 'no-cache, no-store, must-revalidate',
        }));
      }

      const ts = new Date().toISOString();
      localStorage.setItem(CURSOR_KEY, ts);
      setLastSync(new Date(ts));
      patch({ phase: 'done', message: '' });

    } catch (e) {
      patch({ phase: 'error', message: String(e) });
    } finally {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { await wakeLock?.release(); } catch { /* ignore */ }
      running.current = false;
    }
  }, [makePhotosPrivate]);

  const reset = useCallback(() => setStatus(IDLE), []);

  // One-time retroactive fix: hash all non-camera album files and mark them private
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState('');

  const markNonCameraPrivate = useCallback(async () => {
    if (fixing) return;
    setFixing(true);
    setFixResult('Reading albums…');
    try {
      const { Media }      = await import('@capacitor-community/media');
      const { Filesystem } = await import('@capacitor/filesystem');
      const { albums }     = await Media.getAlbums();

      const privateHashes: string[] = [];
      const cameraHashes:  string[] = [];
      const tagMap: Record<string, { hash: string; s3_key: string }[]> = {};
      let filesDone = 0;

      // Process ALL albums — mark non-camera private + tag everything
      for (const album of albums) {
        let files: { name: string }[] = [];
        try { ({ files } = await Filesystem.readdir({ path: album.identifier })); }
        catch { continue; }

        const isCamera = isCameraAlbum(album.identifier, album.name);

        for (const f of files) {
          if (!IMAGE_EXTS.test(f.name)) continue;
          const fullPath = album.identifier.replace(/\/$/, '') + '/' + f.name;
          try {
            const webUrl = Capacitor.convertFileSrc(fullPath);
            const r      = await fetch(webUrl);
            if (!r.ok) continue;
            const blob   = await r.blob();
            const hash   = await quickHash(blob);
            const ext    = f.name.slice(f.name.lastIndexOf('.')).toLowerCase() || '.jpg';
            const s3_key = `photos/${hash.slice(0, 2)}/${hash}${ext}`;

            if (isCamera) cameraHashes.push(hash);
            else          privateHashes.push(hash);
            if (!tagMap[album.name]) tagMap[album.name] = [];
            tagMap[album.name].push({ hash, s3_key });

            filesDone++;
            if (filesDone % 20 === 0)
              setFixResult(`Processed ${filesDone} files…`);
          } catch { continue; }
        }
      }

      // Remove camera hashes from private.json (fix any wrongly-marked photos)
      if (cameraHashes.length > 0) {
        setFixResult(`Removing ${cameraHashes.length} camera photos from private list…`);
        await makePhotosPublic(cameraHashes);
      }

      // Add non-camera hashes to private.json
      if (privateHashes.length > 0) {
        setFixResult(`Marking ${privateHashes.length} non-camera photos private…`);
        await makePhotosPrivate(privateHashes);
      }

      // Write tags
      if (Object.keys(tagMap).length > 0) {
        setFixResult(`Writing tags for ${filesDone} photos…`);
        {
          const s3 = new S3Client({
            region: config.region,
            credentials: async () => {
              const s = await fetchAuthSession();
              if (!s.credentials) throw new Error('Not authenticated');
              return s.credentials as never;
            },
          });
          const user    = await getCurrentUser();
          const email   = user.signInDetails?.loginId ?? '';
          const tagsKey = emailToTagsKey(email);
          const now     = new Date().toISOString();

          let existing: UserTags = { updated: '', tags: {}, comments: {}, commentTimes: {} };
          try {
            const r = await fetch(config.cloudFrontUrl + '/' + tagsKey + '?nc=' + Date.now());
            if (r.ok) existing = await r.json() as UserTags;
          } catch { /* start fresh */ }

          const updatedTags = { ...existing.tags };
          for (const [albumName, photos] of Object.entries(tagMap)) {
            const prev       = updatedTags[albumName] ?? { photos: [], albums: [], createdAt: now };
            const prevHashes = new Set((prev.photos as PhotoEntry[]).map(p => p.hash));
            const newPhotos: PhotoEntry[] = photos
              .filter(p => !prevHashes.has(p.hash))
              .map(({ hash, s3_key }) => ({
                hash, s3_key, thumb: null, dt: null,
                lat: null, lng: null, w: null, h: null,
              }));
            if (newPhotos.length === 0) continue;
            updatedTags[albumName] = { ...prev, photos: [...prev.photos, ...newPhotos] };
          }

          await s3.send(new PutObjectCommand({
            Bucket:       config.bucketName,
            Key:          tagsKey,
            Body:         JSON.stringify({ ...existing, updated: now, tags: updatedTags }),
            ContentType:  'application/json',
            CacheControl: 'no-cache, no-store, must-revalidate',
          }));
        }
      }

      setFixResult(`✅ Done — ${cameraHashes.length} camera unprivated, ${privateHashes.length} non-camera private, ${filesDone} tagged`);
    } catch (e) {
      setFixResult(`Error: ${String(e)}`);
    } finally {
      setFixing(false);
    }
  }, [fixing, makePhotosPrivate, makePhotosPublic]);

  return { status, lastSync, autoSync, setAutoSync, sync, stopSync, reset, isRunning: running, fixing, fixResult, markNonCameraPrivate };
}
