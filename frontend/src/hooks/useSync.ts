import { useState, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import type { AlbumConfig, AlbumItem, UserTags, PhotoEntry, SystemTagMeta } from '../types';

export type { AlbumConfig, AlbumItem };

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

function thumbS3Key(hash: string): string {
  return `thumbs/${hash.slice(0, 2)}/${hash}.jpg`;
}

// Matches Python: re.sub(r"[^\w\-]", "_", tagName) in Unicode mode
function tagToSlug(tagName: string): string {
  return tagName.replace(/[^\p{L}\p{N}_\-]/gu, '_');
}

async function generateThumbBlob(blob: Blob): Promise<Blob | null> {
  const SIZE = 300;
  return new Promise<Blob | null>(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const scale = Math.min(SIZE / img.naturalWidth, SIZE / img.naturalHeight, 1);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.naturalWidth  * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, 'image/jpeg', 0.75);
      } catch { resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Upload thumbnail to S3 and return its key (or null on failure).
async function ensureThumb(s3: S3Client, hash: string, blob: Blob): Promise<string | null> {
  const key = thumbS3Key(hash);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
    return key; // already exists
  } catch { /* not found — generate */ }
  try {
    const thumbBlob = await generateThumbBlob(blob);
    if (!thumbBlob) return null;
    const buf = await thumbBlob.arrayBuffer();
    await s3.send(new PutObjectCommand({
      Bucket: config.bucketName, Key: key,
      Body: new Uint8Array(buf), ContentType: 'image/jpeg',
    }));
    return key;
  } catch { return null; }
}

// Merge new photos into index/sys/{slug}.json and update index/tags/system.json.
async function updateSysIndex(
  s3: S3Client,
  sysTagPhotos: Record<string, { hash: string; s3_key: string; thumbKey: string | null }[]>,
): Promise<void> {
  const updatedCounts: Record<string, { slug: string; newCount: number }> = {};

  for (const [tagName, photos] of Object.entries(sysTagPhotos)) {
    const slug = tagToSlug(tagName);
    let existing: PhotoEntry[] = [];
    try {
      const r = await fetch(config.cloudFrontUrl + '/index/sys/' + slug + '.json?nc=' + Date.now());
      if (r.ok) existing = await r.json() as PhotoEntry[];
    } catch { /* new tag */ }

    const existingHashes = new Set(existing.map(p => p.hash));
    const newPhotos: PhotoEntry[] = photos
      .filter(p => !existingHashes.has(p.hash))
      .map(p => ({
        hash: p.hash, s3_key: p.s3_key, thumb: p.thumbKey,
        dt: null, lat: null, lng: null, w: null, h: null,
      }));

    const merged = newPhotos.length ? [...existing, ...newPhotos] : existing;
    if (newPhotos.length) {
      await s3.send(new PutObjectCommand({
        Bucket: config.bucketName, Key: 'index/sys/' + slug + '.json',
        Body: JSON.stringify(merged), ContentType: 'application/json',
        CacheControl: 'no-cache, no-store, must-revalidate',
      }));
    }
    updatedCounts[tagName] = { slug, newCount: merged.length };
  }

  // Update master system tag index
  let sysIdx: { updated: string; tags: Record<string, SystemTagMeta> } = { updated: '', tags: {} };
  try {
    const r = await fetch(config.cloudFrontUrl + '/index/tags/system.json?nc=' + Date.now());
    if (r.ok) sysIdx = await r.json();
  } catch { /* new index */ }

  const now = new Date().toISOString();
  const updatedTags = { ...sysIdx.tags };
  for (const [tagName, { slug, newCount }] of Object.entries(updatedCounts)) {
    updatedTags[tagName] = {
      ...updatedTags[tagName],
      slug, count: newCount,
      public: tagName.startsWith('Camera/'),
    };
  }
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName, Key: 'index/tags/system.json',
    Body: JSON.stringify({ ...sysIdx, updated: now, tags: updatedTags }),
    ContentType: 'application/json', CacheControl: 'no-cache, no-store, must-revalidate',
  }));
}

// Slug allowing Unicode letters/digits, hyphens, and slashes (mirrors Python re.sub for path keys)
function pathSegSlug(path: string): string {
  return path.replace(/[^\p{L}\p{N}_\-/]/gu, '_');
}

// After a Camera/ sys-tag sync: update index/path_tags.json and index/general/*.json
async function updatePathTagsAndGeneralIndex(
  s3: S3Client,
  sysTagPhotos: Record<string, { hash: string; s3_key: string; thumbKey: string | null }[]>,
): Promise<void> {
  const newEntries: { display: string; s3: string }[] = [];
  const generalUpdates: Record<string, { hash: string; s3_key: string; thumbKey: string | null; folder: string }[]> = {};

  for (const [tagName, photos] of Object.entries(sysTagPhotos)) {
    if (!tagName.startsWith('Camera/')) continue;
    const inner = tagName.slice('Camera/'.length);
    const parts = inner.split('/');
    for (let d = 1; d <= parts.length; d++) {
      const ancestor = parts.slice(0, d).join('/');
      newEntries.push({ display: 'Camera/' + ancestor, s3: pathSegSlug(ancestor) });
    }
    const folderKey = pathSegSlug(inner);
    if (!generalUpdates[folderKey]) generalUpdates[folderKey] = [];
    generalUpdates[folderKey].push(...photos.map(p => ({ ...p, folder: inner })));
  }

  if (newEntries.length === 0) return;

  // Merge into path_tags.json
  let existingTags: { display: string; s3: string }[] = [];
  try {
    const r = await fetch(config.cloudFrontUrl + '/index/path_tags.json?nc=' + Date.now());
    if (r.ok) existingTags = await r.json();
  } catch { /* start fresh */ }
  const existingSet = new Set(existingTags.map(e => e.display));
  const toAdd = newEntries.filter(e => !existingSet.has(e.display));
  if (toAdd.length > 0) {
    await s3.send(new PutObjectCommand({
      Bucket: config.bucketName, Key: 'index/path_tags.json',
      Body: JSON.stringify([...existingTags, ...toAdd]),
      ContentType: 'application/json', CacheControl: 'no-cache, no-store, must-revalidate',
    }));
  }

  // Update general index file for each Camera/ folder
  for (const [folderKey, photos] of Object.entries(generalUpdates)) {
    let existing: { hash: string; dt?: string | null }[] = [];
    try {
      const r = await fetch(config.cloudFrontUrl + '/index/general/' + folderKey + '.json?nc=' + Date.now());
      if (r.ok) existing = await r.json();
    } catch { /* new */ }
    const existingHashes = new Set(existing.map(p => p.hash));
    const newPhotos = photos
      .filter(p => !existingHashes.has(p.hash))
      .map(p => ({
        hash: p.hash, s3_key: p.s3_key, thumb: p.thumbKey ?? null,
        dt: null, lat: null, lng: null, country: null, city: null,
        folder: p.folder,
        // path with dummy filename so PhotoGrid can strip it to get the Camera/ folder path
        path: 'Camera/' + p.folder + '/_',
        w: null, h: null, video_proxy: null,
      }));
    if (newPhotos.length > 0) {
      const merged = [...existing, ...newPhotos].sort((a, b) =>
        (a.dt ?? '￿').localeCompare(b.dt ?? '￿')
      );
      await s3.send(new PutObjectCommand({
        Bucket: config.bucketName, Key: 'index/general/' + folderKey + '.json',
        Body: JSON.stringify(merged),
        ContentType: 'application/json', CacheControl: 'no-cache, no-store, must-revalidate',
      }));
      // Re-copy each new stub photo in-place to add album-path metadata, triggering Lambda to fill EXIF.
      // Safe to run even if the photo was just uploaded (Lambda processes idempotently).
      for (const p of newPhotos) {
        const albumPath = encodeURI('Camera/' + p.folder);
        try {
          await s3.send(new CopyObjectCommand({
            Bucket:            config.bucketName,
            CopySource:        encodeURIComponent(config.bucketName) + '/' + p.s3_key,
            Key:               p.s3_key,
            MetadataDirective: 'REPLACE',
            StorageClass:      'GLACIER_IR',
            ContentType:       p.s3_key.match(/\.(mp4|mov)$/i) ? 'video/mp4' : 'image/jpeg',
            Metadata:          { 'album-path': albumPath },
          }));
        } catch { /* non-fatal: Lambda will process on next new upload if this fails */ }
      }
    }
  }
}

export function deriveTagName(cfg: AlbumConfig, fallback: string): string {
  const force = (cfg.forcePath ?? '').trim();
  if (force) return cfg.createFolder ? `${force}/${fallback}` : force;
  return (cfg.location ?? '').trim() || fallback;
}

function makeS3(): S3Client {
  return new S3Client({
    region: config.region,
    credentials: async () => {
      const s = await fetchAuthSession();
      if (!s.credentials) throw new Error('Not authenticated');
      return s.credentials as never;
    },
  });
}

export interface SyncStatus {
  phase:       'idle' | 'enumerating' | 'syncing' | 'done' | 'error';
  total:       number;
  processed:   number;
  uploaded:    number;
  skipped:     number;
  failed:      number;
  message:     string;
  failedFiles: string[];
}

const IDLE: SyncStatus = {
  phase: 'idle', total: 0, processed: 0, uploaded: 0, skipped: 0, failed: 0, message: '', failedFiles: [],
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

  // Shared finalization: persist recent list, mark private, write tags, update cursor
  const finalizeSyncBatch = useCallback(async (
    s3: S3Client,
    privateHashes: string[],
    tagMap: Record<string, { hash: string; s3_key: string; name?: string }[]>,
    syncBatch: { hash: string; s3_key: string; name?: string; syncedAt: string }[],
    patch: (p: Partial<SyncStatus>) => void,
  ) => {
    if (syncBatch.length > 0) {
      try {
        const prev: { hash: string; s3_key: string; syncedAt: string }[] =
          JSON.parse(localStorage.getItem(RECENT_SYNC_KEY) ?? '[]');
        const prevHashes = new Set(prev.map(e => e.hash));
        const newOnes = syncBatch.filter(e => !prevHashes.has(e.hash));
        localStorage.setItem(RECENT_SYNC_KEY, JSON.stringify([...newOnes, ...prev].slice(0, 100)));
      } catch { /* ignore */ }
    }

    if (privateHashes.length > 0) {
      await makePhotosPrivate(privateHashes);
    }

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
      for (const [tagName, photos] of Object.entries(tagMap)) {
        const prev      = updatedTags[tagName] ?? { photos: [], albums: [], createdAt: now };
        const prevPhotos = prev.photos as PhotoEntry[];
        const prevByHash = new Map(prevPhotos.map(p => [p.hash, p]));
        const incomingByHash = new Map(photos.map(p => [p.hash, p]));

        // Backfill `name` on existing entries that lack it (handles re-sync after fix)
        let nameUpdated = false;
        const mergedPrev = prevPhotos.map(p => {
          const inc = incomingByHash.get(p.hash);
          if (inc?.name && !p.name) { nameUpdated = true; return { ...p, name: inc.name }; }
          return p;
        });

        const newPhotos: PhotoEntry[] = photos
          .filter(p => !prevByHash.has(p.hash))
          .map(({ hash, s3_key, name }) => ({
            hash, s3_key, thumb: null, dt: null,
            lat: null, lng: null, w: null, h: null,
            ...(name ? { name } : {}),
          }));

        if (newPhotos.length === 0 && !nameUpdated) continue;
        updatedTags[tagName] = { ...prev, photos: [...mergedPrev, ...newPhotos] };
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
  }, [makePhotosPrivate, setLastSync]);

  // Enumerate phone gallery albums (mobile only)
  const loadAlbums = useCallback(async (): Promise<AlbumItem[]> => {
    if (!Capacitor.isNativePlatform()) return [];
    try {
      const { Camera } = await import('@capacitor/camera');
      const perm = await Camera.requestPermissions({ permissions: ['photos'] });
      if (perm.photos !== 'granted') return [];
      const { Media } = await import('@capacitor-community/media');
      const { albums } = await Media.getAlbums();
      return albums.map(a => ({
        identifier: a.identifier,
        name:       a.name,
        isCamera:   isCameraAlbum(a.identifier, a.name),
      }));
    } catch {
      return [];
    }
  }, []);

  // Mobile sync — reads from phone gallery using per-album AlbumConfig
  const sync = useCallback(async (albumConfigs: Record<string, AlbumConfig> = {}) => {
    if (running.current) return;
    if (!Capacitor.isNativePlatform()) {
      setStatus({ ...IDLE, phase: 'error', message: 'web-only' });
      return;
    }

    running.current  = true;
    stopFlag.current = false;
    const patch = (p: Partial<SyncStatus>) => setStatus(prev => ({ ...prev, ...p }));

    // Keep the screen awake and JS running while sync is in progress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wakeLock: any = null;
    const acquireWakeLock = async () => {
      if ('wakeLock' in navigator) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { wakeLock = await (navigator as any).wakeLock.request('screen'); } catch { /* ignore */ }
      }
    };
    await acquireWakeLock();
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

      type FileItem = {
        path: string; name: string;
        shouldBePrivate: boolean; tagName: string;
        isSystemPath: boolean;
      };
      const allItems: FileItem[] = [];
      const seenPaths = new Set<string>();
      const debugLines: string[] = [];

      for (const album of albums) {
        const cfg = albumConfigs[album.identifier];
        // Opt-in only: skip any album not explicitly enabled, and always skip Camera Roll
        if (!cfg || !cfg.sync) continue;
        if (isCameraAlbum(album.identifier, album.name)) continue;

        try {
          patch({ phase: 'enumerating', message: `Reading: ${album.name}…` });
          const { files } = await Filesystem.readdir({ path: album.identifier });
          const shouldBePrivate = false;
          const tagName         = deriveTagName(cfg, album.name);
          const hasForce        = (cfg.forcePath ?? '').trim();
          const isSystemPath    = tagName.startsWith('Camera/');
          const imgFiles        = files.filter(f => IMAGE_EXTS.test(f.name));
          debugLines.push(`✓ ${album.name}: ${imgFiles.length} photos`);

          for (const f of imgFiles) {
            const fullPath = album.identifier.replace(/\/$/, '') + '/' + f.name;
            if (seenPaths.has(fullPath)) continue;
            seenPaths.add(fullPath);
            // Camera/ path albums bypass cursor so missing index entries are always reconciled.
            if (!isSystemPath && cursor && f.mtime) {
              if (new Date(f.mtime) <= cursor) continue;
            }
            allItems.push({ path: fullPath, name: f.name, shouldBePrivate, tagName, isSystemPath });
          }
        } catch (e) {
          debugLines.push(`✗ ${album.name}: ${String(e).slice(0, 60)}`);
          continue;
        }
      }

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

      // ── 3. Upload ─────────────────────────────────────────────────────
      const s3 = makeS3();
      let uploaded = 0, skipped = 0, failed = 0;
      const failedFiles: string[] = [];
      const privateHashes: string[] = [];
      const tagMap: Record<string, { hash: string; s3_key: string; name?: string }[]> = {};
      const sysTagPhotos: Record<string, { hash: string; s3_key: string; thumbKey: string | null }[]> = {};
      let hasNewSysUploads = false;
      const syncNow   = new Date().toISOString();
      const syncBatch: { hash: string; s3_key: string; name?: string; syncedAt: string }[] = [];

      for (let i = 0; i < allItems.length; i++) {
        if (stopFlag.current) {
          patch({ phase: 'done', message: '' });
          running.current = false;
          return;
        }
        const { path, name, shouldBePrivate, tagName, isSystemPath } = allItems[i];
        patch({ processed: i + 1, uploaded, skipped, failed, message: name });

        try {
          const webUrl = Capacitor.convertFileSrc(path);
          const r = await fetch(webUrl);
          if (!r.ok) throw new Error(`fetch ${r.status}`);
          const blob = await r.blob();
          const hash = await quickHash(blob);
          const key  = s3Key(hash, name);

          // For force-path system albums: generate thumbnail and queue sys index update
          if (isSystemPath) {
            const thumbKey = await ensureThumb(s3, hash, blob);
            if (!sysTagPhotos[tagName]) sysTagPhotos[tagName] = [];
            sysTagPhotos[tagName].push({ hash, s3_key: key, thumbKey });
          }

          try {
            await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
            skipped++;
            if (shouldBePrivate) privateHashes.push(hash);
            syncBatch.push({ hash, s3_key: key, name, syncedAt: syncNow });
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
            Metadata:     {
              'original-filename': name,
              ...(isSystemPath ? { 'album-path': encodeURI(tagName) } : {}),
            },
          }));

          uploaded++;
          if (isSystemPath) hasNewSysUploads = true;
          if (shouldBePrivate) privateHashes.push(hash);
          syncBatch.push({ hash, s3_key: key, name, syncedAt: syncNow });
          patch({ uploaded });
        } catch {
          failed++;
          failedFiles.push(name);
          patch({ failed, failedFiles: [...failedFiles] });
        }
      }

      await finalizeSyncBatch(s3, privateHashes, tagMap, syncBatch, patch);

      // Update system tag index + path tree for any force-path Camera/ albums
      if (Object.keys(sysTagPhotos).length > 0) {
        patch({ message: 'Updating photo index…' });
        try { await updateSysIndex(s3, sysTagPhotos); } catch { /* non-fatal */ }
        try { await updatePathTagsAndGeneralIndex(s3, sysTagPhotos); } catch { /* non-fatal */ }
        // Signal the Lambda to send pending WhatsApp notifications only when new photos were uploaded
        if (hasNewSysUploads) {
          try {
            await s3.send(new PutObjectCommand({
              Bucket: config.bucketName, Key: 'photos/_notify_flush.json',
              Body: JSON.stringify({ ts: new Date().toISOString() }),
              ContentType: 'application/json',
            }));
          } catch { /* non-fatal */ }
        }
      }
      patch({ phase: 'done', message: '' });

    } catch (e) {
      patch({ phase: 'error', message: String(e) });
    } finally {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { await wakeLock?.release(); } catch { /* ignore */ }
      running.current = false;
    }
  }, [makePhotosPrivate, finalizeSyncBatch]);

  // Desktop sync — reads from a user-selected local folder (File objects from <input>)
  const syncDesktop = useCallback(async (files: File[], cfg: AlbumConfig, folderName: string) => {
    if (running.current) return;
    running.current  = true;
    stopFlag.current = false;
    const patch = (p: Partial<SyncStatus>) => setStatus(prev => ({ ...prev, ...p }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wakeLock: any = null;
    if ('wakeLock' in navigator) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { wakeLock = await (navigator as any).wakeLock.request('screen'); } catch { /* ignore */ }
    }

    try {
      const imageFiles = files.filter(f => IMAGE_EXTS.test(f.name));
      if (imageFiles.length === 0) {
        patch({ phase: 'done', message: 'none' });
        running.current = false;
        return;
      }

      patch({ phase: 'syncing', total: imageFiles.length });

      const s3      = makeS3();
      const tagName = deriveTagName(cfg, folderName);
      let uploaded = 0, skipped = 0, failed = 0;
      const privateHashes: string[] = [];
      const tagMap: Record<string, { hash: string; s3_key: string; name?: string }[]> = {};
      const syncNow   = new Date().toISOString();
      const syncBatch: { hash: string; s3_key: string; name?: string; syncedAt: string }[] = [];

      for (let i = 0; i < imageFiles.length; i++) {
        if (stopFlag.current) {
          patch({ phase: 'done', message: '' });
          running.current = false;
          return;
        }
        const file = imageFiles[i];
        patch({ processed: i + 1, uploaded, skipped, failed, message: file.name });

        try {
          const blob = file as Blob;
          const hash = await quickHash(blob);
          const key  = s3Key(hash, file.name);

          try {
            await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
            skipped++;
            syncBatch.push({ hash, s3_key: key, name: file.name, syncedAt: syncNow });
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
            Metadata:     {
              'original-filename': file.name,
              ...(tagName.startsWith('Camera/') ? { 'album-path': encodeURI(tagName) } : {}),
            },
          }));

          uploaded++;
          syncBatch.push({ hash, s3_key: key, name: file.name, syncedAt: syncNow });
          patch({ uploaded });
        } catch {
          failed++;
          patch({ failed });
        }
      }

      await finalizeSyncBatch(s3, privateHashes, tagMap, syncBatch, patch);
      patch({ phase: 'done', message: '' });

    } catch (e) {
      patch({ phase: 'error', message: String(e) });
    } finally {
      try { await wakeLock?.release(); } catch { /* ignore */ }
      running.current = false;
    }
  }, [makePhotosPrivate, finalizeSyncBatch]);

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

      if (cameraHashes.length > 0) {
        setFixResult(`Removing ${cameraHashes.length} camera photos from private list…`);
        await makePhotosPublic(cameraHashes);
      }

      if (privateHashes.length > 0) {
        setFixResult(`Marking ${privateHashes.length} non-camera photos private…`);
        await makePhotosPrivate(privateHashes);
      }

      if (Object.keys(tagMap).length > 0) {
        setFixResult(`Writing tags for ${filesDone} photos…`);
        {
          const s3 = makeS3();
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

  return {
    status, lastSync, autoSync, setAutoSync,
    sync, syncDesktop, loadAlbums,
    stopSync, reset, isRunning: running,
    fixing, fixResult, markNonCameraPrivate,
  };
}
