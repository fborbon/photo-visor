import {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import { PhotoEntry, AlbumRef, TagEntry, UserTags, SharedTagEntry, SharedTags, SharedComment, SystemTagIndex } from '../types';

interface TagsCtx {
  tags:            Record<string, TagEntry>;
  tagNames:        string[];
  sharedTags:      Record<string, SharedTagEntry>;
  sharedTagNames:  string[];
  systemTagIndex:  SystemTagIndex;
  systemTagsLoading: boolean;

  addPhotoToTag:   (photo: PhotoEntry, tagName: string, shared: boolean) => Promise<void>;
  addAlbumToTag:   (album: AlbumRef,  tagName: string, shared: boolean) => Promise<void>;
  removePhotoTag:  (hash: string,     tagName: string, shared: boolean) => Promise<void>;
  removeAlbumTag:  (albumKey: string, tagName: string, shared: boolean) => Promise<void>;
  deleteTag:       (tagName: string,  shared: boolean) => Promise<void>;

  getComment:        (hash: string) => string;
  getCommentShared:  (hash: string) => boolean;
  setComment:        (hash: string, text: string, shared: boolean) => Promise<void>;
  commentTimes:      Record<string, string>;
  sharedCommentTimes: Record<string, string>;

  ownerKey:        string;
  isMySharedTag:   (tagName: string) => boolean;
}

const emptySystemIndex: SystemTagIndex = { updated: '', tags: {} };

const TagsContext = createContext<TagsCtx>({
  tags: {}, tagNames: [], sharedTags: {}, sharedTagNames: [],
  systemTagIndex: emptySystemIndex, systemTagsLoading: false,
  addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
  removePhotoTag: async () => {}, removeAlbumTag: async () => {},
  deleteTag:   async () => {},
  getComment:  () => '', getCommentShared: () => false, setComment: async () => {},
  commentTimes: {}, sharedCommentTimes: {},
  ownerKey: '', isMySharedTag: () => false,
});

const SHARED_KEY     = 'index/tags/shared.json';
const SYSTEM_IDX_KEY = 'index/tags/system.json';
const emptyPrivate: UserTags      = { updated: '', tags: {}, comments: {}, commentTimes: {} };
const emptyShared:  SharedTags    = { updated: '', tags: {}, comments: {}, commentTimes: {} };

// ── localStorage keys ──────────────────────────────────────────────
function lsPrivateKey(ownerKey: string) { return 'pv_tags_' + ownerKey; }
const LS_SHARED_KEY = 'pv_tags_shared';

function lsGet<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : null; }
  catch { return null; }
}
function lsSet(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* quota exceeded — ignore */ }
}

// ── Helpers ────────────────────────────────────────────────────────
function emailToKey(email: string) {
  return 'index/tags/' + email.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.json';
}
function emailToOwnerKey(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

async function getS3(region: string, creds: unknown) {
  return new S3Client({ region, credentials: creds as never });
}

// CacheControl: no-cache ensures CloudFront never serves a stale version
// of a tag/comment file after it has been updated.
async function putJson(s3: S3Client, key: string, data: unknown) {
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName, Key: key,
    Body: JSON.stringify(data), ContentType: 'application/json',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
}

function mergePrivate(a: UserTags, b: UserTags): UserTags {
  // Return whichever has the later `updated` timestamp.
  // Falls back to `b` when timestamps are equal or missing.
  if (a.updated && b.updated && a.updated > b.updated) return a;
  return b;
}

export function TagsProvider({ children }: { children: ReactNode }) {
  const [privateData,      setPrivateData]      = useState<UserTags>(emptyPrivate);
  const [sharedData,       setSharedData]       = useState<SharedTags>(emptyShared);
  const [systemIndex,      setSystemIndex]      = useState<SystemTagIndex>(emptySystemIndex);
  const [sysTagsLoading,   setSysTagsLoading]   = useState(true);
  const [s3Key,            setS3Key]            = useState('');
  const [myOwnerKey,       setMyOwnerKey]       = useState('');
  const [myEmail,          setMyEmail]          = useState('');

  // ── Load private tags ──────────────────────────────────────────────
  useEffect(() => {
    getCurrentUser().then(u => {
      const email = u.signInDetails?.loginId ?? '';
      const key   = emailToKey(email);
      const okey  = emailToOwnerKey(email);
      setS3Key(key);
      setMyOwnerKey(okey);
      setMyEmail(email);

      // 1. Load from localStorage immediately — zero latency on refresh/upgrade
      const cached = lsGet<UserTags>(lsPrivateKey(okey));
      if (cached) {
        setPrivateData({
          ...cached,
          comments:     cached.comments     ?? {},
          commentTimes: cached.commentTimes ?? {},
        });
      }

      // 2. Fetch from S3 (bypassing CloudFront cache with timestamp)
      fetch(config.cloudFrontUrl + '/' + key + '?nc=' + Date.now())
        .then(r => (r.ok ? r.json() as Promise<UserTags> : null))
        .then((remote: UserTags | null) => {
          if (!remote) return;
          const remoteNorm: UserTags = {
            ...remote,
            comments:     remote.comments     ?? {},
            commentTimes: remote.commentTimes ?? {},
          };
          // Merge: keep whichever version is newer
          setPrivateData(local => {
            const winner = mergePrivate(local, remoteNorm);
            lsSet(lsPrivateKey(okey), winner);
            return winner;
          });
        })
        .catch(() => { /* keep whatever localStorage gave us */ });
    }).catch(() => {});
  }, []);

  // ── Load shared tags ───────────────────────────────────────────────
  useEffect(() => {
    const normShared = (d: SharedTags): SharedTags => ({
      ...d,
      comments:     d.comments     ?? {},
      commentTimes: d.commentTimes ?? {},
    });
    const cached = lsGet<SharedTags>(LS_SHARED_KEY);
    if (cached) setSharedData(normShared(cached));

    fetch(config.cloudFrontUrl + '/' + SHARED_KEY + '?nc=' + Date.now())
      .then(r => (r.ok ? r.json() as Promise<SharedTags> : null))
      .then((remote: SharedTags | null) => {
        if (!remote) return;
        const norm = normShared(remote);
        setSharedData(norm);
        lsSet(LS_SHARED_KEY, norm);
      })
      .catch(() => { /* keep cached */ });
  }, []);

  // ── Load system tag index (read-only, generated by bulk-ingest) ────
  useEffect(() => {
    setSysTagsLoading(true);
    fetch(config.cloudFrontUrl + '/' + SYSTEM_IDX_KEY + '?nc=' + Date.now())
      .then(r => (r.ok ? r.json() as Promise<SystemTagIndex> : null))
      .then((data: SystemTagIndex | null) => { if (data) setSystemIndex(data); })
      .catch(() => {})
      .finally(() => setSysTagsLoading(false));
  }, []);

  // ── Persist helpers ────────────────────────────────────────────────
  const persistPrivate = useCallback(async (next: UserTags) => {
    // Update state and localStorage synchronously
    setPrivateData(next);
    if (myOwnerKey) lsSet(lsPrivateKey(myOwnerKey), next);
    // Then persist to S3 asynchronously
    const session = await fetchAuthSession();
    if (!session.credentials || !s3Key) return;
    const s3 = await getS3(config.region, session.credentials);
    await putJson(s3, s3Key, next);
  }, [s3Key, myOwnerKey]);

  const persistShared = useCallback(async (next: SharedTags) => {
    setSharedData(next);
    lsSet(LS_SHARED_KEY, next);
    const session = await fetchAuthSession();
    if (!session.credentials) return;
    const s3 = await getS3(config.region, session.credentials);
    await putJson(s3, SHARED_KEY, next);
  }, []);

  // ── Add photo ──────────────────────────────────────────────────────
  const addPhotoToTag = useCallback(async (photo: PhotoEntry, tagName: string, shared: boolean) => {
    const now = new Date().toISOString();
    if (shared) {
      const existing = sharedData.tags[tagName] ?? { photos: [], albums: [], ownerKey: myOwnerKey, ownerEmail: myEmail, createdAt: now };
      if (existing.photos.some(p => p.hash === photo.hash)) return;
      await persistShared({
        ...sharedData, updated: now,
        tags: { ...sharedData.tags, [tagName]: { ...existing, photos: [...existing.photos, photo] } },
      });
    } else {
      const existing = privateData.tags[tagName] ?? { photos: [], albums: [], createdAt: now };
      if (existing.photos.some(p => p.hash === photo.hash)) return;
      await persistPrivate({
        ...privateData, updated: now,
        tags: { ...privateData.tags, [tagName]: { ...existing, photos: [...existing.photos, photo] } },
      });
    }
  }, [privateData, sharedData, persistPrivate, persistShared, myOwnerKey, myEmail]);

  // ── Add album ──────────────────────────────────────────────────────
  const addAlbumToTag = useCallback(async (album: AlbumRef, tagName: string, shared: boolean) => {
    if (shared) {
      const existing = sharedData.tags[tagName] ?? { photos: [], albums: [], ownerKey: myOwnerKey, ownerEmail: myEmail };
      if (existing.albums.some(a => a.key === album.key)) return;
      await persistShared({
        ...sharedData, updated: new Date().toISOString(),
        tags: { ...sharedData.tags, [tagName]: { ...existing, albums: [...existing.albums, album] } },
      });
    } else {
      const existing = privateData.tags[tagName] ?? { photos: [], albums: [] };
      if (existing.albums.some(a => a.key === album.key)) return;
      await persistPrivate({
        ...privateData, updated: new Date().toISOString(),
        tags: { ...privateData.tags, [tagName]: { ...existing, albums: [...existing.albums, album] } },
      });
    }
  }, [privateData, sharedData, persistPrivate, persistShared, myOwnerKey, myEmail]);

  // ── Remove photo ───────────────────────────────────────────────────
  const removePhotoTag = useCallback(async (hash: string, tagName: string, shared: boolean) => {
    if (shared) {
      const e = sharedData.tags[tagName]; if (!e) return;
      await persistShared({ ...sharedData, updated: new Date().toISOString(),
        tags: { ...sharedData.tags, [tagName]: { ...e, photos: e.photos.filter(p => p.hash !== hash) } } });
    } else {
      const e = privateData.tags[tagName]; if (!e) return;
      await persistPrivate({ ...privateData, updated: new Date().toISOString(),
        tags: { ...privateData.tags, [tagName]: { ...e, photos: e.photos.filter(p => p.hash !== hash) } } });
    }
  }, [privateData, sharedData, persistPrivate, persistShared]);

  // ── Remove album ───────────────────────────────────────────────────
  const removeAlbumTag = useCallback(async (albumKey: string, tagName: string, shared: boolean) => {
    if (shared) {
      const e = sharedData.tags[tagName]; if (!e) return;
      await persistShared({ ...sharedData, updated: new Date().toISOString(),
        tags: { ...sharedData.tags, [tagName]: { ...e, albums: e.albums.filter(a => a.key !== albumKey) } } });
    } else {
      const e = privateData.tags[tagName]; if (!e) return;
      await persistPrivate({ ...privateData, updated: new Date().toISOString(),
        tags: { ...privateData.tags, [tagName]: { ...e, albums: e.albums.filter(a => a.key !== albumKey) } } });
    }
  }, [privateData, sharedData, persistPrivate, persistShared]);

  // ── Delete tag ─────────────────────────────────────────────────────
  const deleteTag = useCallback(async (tagName: string, shared: boolean) => {
    if (shared) {
      const { [tagName]: _, ...rest } = sharedData.tags;
      await persistShared({ ...sharedData, updated: new Date().toISOString(), tags: rest });
    } else {
      const { [tagName]: _, ...rest } = privateData.tags;
      await persistPrivate({ ...privateData, updated: new Date().toISOString(), tags: rest });
    }
  }, [privateData, sharedData, persistPrivate, persistShared]);

  // ── Comments ───────────────────────────────────────────────────────
  const getComment = useCallback((hash: string) => {
    const sc = sharedData.comments[hash];
    if (sc) return sc.text;
    return privateData.comments[hash] ?? '';
  }, [privateData.comments, sharedData.comments]);

  const getCommentShared = useCallback((hash: string) =>
    hash in sharedData.comments, [sharedData.comments]);

  const setComment = useCallback(async (hash: string, text: string, shared: boolean) => {
    const now = new Date().toISOString();
    const trimmed = text.trim();
    if (shared) {
      const comments = trimmed
        ? { ...sharedData.comments, [hash]: { text: trimmed, ownerKey: myOwnerKey, ownerEmail: myEmail } as SharedComment }
        : Object.fromEntries(Object.entries(sharedData.comments).filter(([k]) => k !== hash));
      const commentTimes = trimmed
        ? { ...sharedData.commentTimes, [hash]: now }
        : Object.fromEntries(Object.entries(sharedData.commentTimes).filter(([k]) => k !== hash));
      // Remove from private if moving to shared
      const privComments = Object.fromEntries(Object.entries(privateData.comments).filter(([k]) => k !== hash));
      const privCommentTimes = Object.fromEntries(Object.entries(privateData.commentTimes).filter(([k]) => k !== hash));
      if (privComments !== privateData.comments) {
        await persistPrivate({ ...privateData, updated: now, comments: privComments, commentTimes: privCommentTimes });
      }
      await persistShared({ ...sharedData, updated: now, comments, commentTimes });
    } else {
      const comments = trimmed
        ? { ...privateData.comments, [hash]: trimmed }
        : Object.fromEntries(Object.entries(privateData.comments).filter(([k]) => k !== hash));
      const commentTimes = trimmed
        ? { ...privateData.commentTimes, [hash]: now }
        : Object.fromEntries(Object.entries(privateData.commentTimes).filter(([k]) => k !== hash));
      // Remove from shared if moving to private
      const sharedComments = Object.fromEntries(Object.entries(sharedData.comments).filter(([k]) => k !== hash));
      const sharedCommentTimes = Object.fromEntries(Object.entries(sharedData.commentTimes).filter(([k]) => k !== hash));
      if (Object.keys(sharedComments).length !== Object.keys(sharedData.comments).length) {
        await persistShared({ ...sharedData, updated: now, comments: sharedComments, commentTimes: sharedCommentTimes });
      }
      await persistPrivate({ ...privateData, updated: now, comments, commentTimes });
    }
  }, [privateData, sharedData, persistPrivate, persistShared, myOwnerKey, myEmail]);

  const isMySharedTag = useCallback((tagName: string) => {
    const e = sharedData.tags[tagName];
    return !!e && e.ownerKey === myOwnerKey;
  }, [sharedData, myOwnerKey]);

  return (
    <TagsContext.Provider value={{
      tags:           privateData.tags,
      tagNames:       Object.keys(privateData.tags).sort(),
      sharedTags:     sharedData.tags,
      sharedTagNames: Object.keys(sharedData.tags).sort(),
      addPhotoToTag, addAlbumToTag,
      removePhotoTag, removeAlbumTag, deleteTag,
      getComment, getCommentShared, setComment,
      commentTimes: privateData.commentTimes,
      sharedCommentTimes: sharedData.commentTimes,
      ownerKey: myOwnerKey,
      isMySharedTag,
      systemTagIndex: systemIndex,
      systemTagsLoading: sysTagsLoading,
    }}>
      {children}
    </TagsContext.Provider>
  );
}

export function useTags() { return useContext(TagsContext); }
