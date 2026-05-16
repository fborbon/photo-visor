import {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import { PhotoEntry, AlbumRef, TagEntry, UserTags, SharedTagEntry, SharedTags } from '../types';

interface TagsCtx {
  // Own private tags
  tags:            Record<string, TagEntry>;
  tagNames:        string[];
  // Shared tags from all family members
  sharedTags:      Record<string, SharedTagEntry>;
  sharedTagNames:  string[];

  addPhotoToTag:   (photo: PhotoEntry, tagName: string, shared: boolean) => Promise<void>;
  addAlbumToTag:   (album: AlbumRef,  tagName: string, shared: boolean) => Promise<void>;
  removePhotoTag:  (hash: string,     tagName: string, shared: boolean) => Promise<void>;
  removeAlbumTag:  (albumKey: string, tagName: string, shared: boolean) => Promise<void>;
  deleteTag:       (tagName: string,  shared: boolean) => Promise<void>;

  getComment:      (hash: string) => string;
  setComment:      (hash: string, text: string) => Promise<void>;
  commentTimes:    Record<string, string>;

  // helpers
  ownerKey:        string;
  isMySharedTag:   (tagName: string) => boolean;
}

const TagsContext = createContext<TagsCtx>({
  tags: {}, tagNames: [], sharedTags: {}, sharedTagNames: [],
  addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
  removePhotoTag: async () => {}, removeAlbumTag: async () => {},
  deleteTag:   async () => {},
  getComment:  () => '', setComment: async () => {},
  commentTimes: {},
  ownerKey: '', isMySharedTag: () => false,
});

const SHARED_KEY = 'index/tags/shared.json';
const emptyPrivate: UserTags   = { updated: '', tags: {}, comments: {}, commentTimes: {} };
const emptyShared:  SharedTags = { updated: '', tags: {} };

function emailToKey(email: string) {
  return 'index/tags/' + email.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.json';
}
function emailToOwnerKey(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

async function getS3(region: string, creds: unknown) {
  return new S3Client({ region, credentials: creds as never });
}

async function putJson(s3: S3Client, key: string, data: unknown) {
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName, Key: key,
    Body: JSON.stringify(data), ContentType: 'application/json',
  }));
}

export function TagsProvider({ children }: { children: ReactNode }) {
  const [privateData, setPrivateData] = useState<UserTags>(emptyPrivate);
  const [sharedData,  setSharedData]  = useState<SharedTags>(emptyShared);
  const [s3Key,       setS3Key]       = useState('');
  const [myOwnerKey,  setMyOwnerKey]  = useState('');
  const [myEmail,     setMyEmail]     = useState('');

  // Load own private tags
  useEffect(() => {
    getCurrentUser().then(u => {
      const email = u.signInDetails?.loginId ?? '';
      const key   = emailToKey(email);
      const okey  = emailToOwnerKey(email);
      setS3Key(key);
      setMyOwnerKey(okey);
      setMyEmail(email);
      fetch(config.cloudFrontUrl + '/' + key + '?t=' + Date.now())
        .then(r => (r.ok ? r.json() as Promise<UserTags> : emptyPrivate))
        .then((d: UserTags) => setPrivateData({ ...d, comments: d.comments ?? {}, commentTimes: d.commentTimes ?? {} }))
        .catch(() => setPrivateData(emptyPrivate));
    }).catch(() => {});
  }, []);

  // Load shared tags (all users)
  useEffect(() => {
    fetch(config.cloudFrontUrl + '/' + SHARED_KEY + '?t=' + Date.now())
      .then(r => (r.ok ? r.json() as Promise<SharedTags> : emptyShared))
      .then(setSharedData)
      .catch(() => setSharedData(emptyShared));
  }, []);

  // ── Persist helpers ────────────────────────────────────────────────
  const persistPrivate = useCallback(async (next: UserTags) => {
    setPrivateData(next);
    const session = await fetchAuthSession();
    if (!session.credentials || !s3Key) return;
    const s3 = await getS3(config.region, session.credentials);
    await putJson(s3, s3Key, next);
  }, [s3Key]);

  const persistShared = useCallback(async (next: SharedTags) => {
    setSharedData(next);
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
  const getComment = useCallback((hash: string) =>
    privateData.comments[hash] ?? '', [privateData.comments]);

  const setComment = useCallback(async (hash: string, text: string) => {
    const now = new Date().toISOString();
    const comments = text.trim()
      ? { ...privateData.comments, [hash]: text.trim() }
      : Object.fromEntries(Object.entries(privateData.comments).filter(([k]) => k !== hash));
    const commentTimes = text.trim()
      ? { ...privateData.commentTimes, [hash]: now }
      : Object.fromEntries(Object.entries(privateData.commentTimes).filter(([k]) => k !== hash));
    await persistPrivate({ ...privateData, updated: now, comments, commentTimes });
  }, [privateData, persistPrivate]);

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
      getComment, setComment,
      commentTimes: privateData.commentTimes,
      ownerKey: myOwnerKey,
      isMySharedTag,
    }}>
      {children}
    </TagsContext.Provider>
  );
}

export function useTags() { return useContext(TagsContext); }
