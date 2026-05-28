import {
  createContext, useContext, useState, useEffect, useCallback,
  ReactNode,
} from 'react';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';

interface PrivateIndex {
  photos: string[];   // photo hashes
  albums: string[];   // album keys e.g. "Spain_Barcelona"
}

interface PrivacyCtx {
  isOwner:            boolean;
  isPhotoPrivate:     (hash: string) => boolean;
  isAlbumPrivate:     (albumKey: string) => boolean;
  togglePhoto:        (hash: string) => Promise<void>;
  toggleAlbum:        (albumKey: string) => Promise<void>;
  makePhotosPrivate:  (hashes: string[]) => Promise<void>;
  makePhotosPublic:   (hashes: string[]) => Promise<void>;
}

const PrivacyContext = createContext<PrivacyCtx>({
  isOwner:            false,
  isPhotoPrivate:     () => false,
  isAlbumPrivate:     () => false,
  togglePhoto:        async () => {},
  toggleAlbum:        async () => {},
  makePhotosPrivate:  async () => {},
  makePhotosPublic:   async () => {},
});

const PRIVATE_KEY = 'index/private.json';
const empty: PrivateIndex = { photos: [], albums: [] };

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [data, setData]       = useState<PrivateIndex>(empty);
  const [isOwner, setIsOwner] = useState(false);

  // Determine if current user is the owner — recheck on sign-in/sign-out
  useEffect(() => {
    const check = () =>
      getCurrentUser()
        .then(u => {
          const email = u.signInDetails?.loginId ?? '';
          setIsOwner(email.toLowerCase() === config.ownerEmail.toLowerCase());
        })
        .catch(() => setIsOwner(false));

    check();
    const unsub = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signedOut') check();
    });
    return unsub;
  }, []);

  // Load private.json — append cache-buster so CloudFront doesn't serve stale data
  useEffect(() => {
    fetch(config.cloudFrontUrl + '/' + PRIVATE_KEY + '?t=' + Date.now())
      .then(r => (r.ok ? r.json() : empty))
      .then((d: PrivateIndex) => setData(d))
      .catch(() => setData(empty));
  }, []);

  const save = useCallback(async (next: PrivateIndex) => {
    setData(next);
    const session = await fetchAuthSession();
    const creds   = session.credentials;
    if (!creds) return;
    const s3 = new S3Client({ region: config.region, credentials: creds });
    await s3.send(new PutObjectCommand({
      Bucket:      config.bucketName,
      Key:         PRIVATE_KEY,
      Body:        JSON.stringify(next),
      ContentType: 'application/json',
    }));
  }, []);

  const togglePhoto = useCallback(async (hash: string) => {
    const photos = data.photos.includes(hash)
      ? data.photos.filter(h => h !== hash)
      : [...data.photos, hash];
    await save({ ...data, photos });
  }, [data, save]);

  const toggleAlbum = useCallback(async (albumKey: string) => {
    const albums = data.albums.includes(albumKey)
      ? data.albums.filter(k => k !== albumKey)
      : [...data.albums, albumKey];
    await save({ ...data, albums });
  }, [data, save]);

  const isPhotoPrivate = useCallback((hash: string) =>
    data.photos.includes(hash), [data]);

  const isAlbumPrivate = useCallback((albumKey: string) =>
    data.albums.includes(albumKey), [data]);

  const makePhotosPrivate = useCallback(async (hashes: string[]) => {
    const existing = new Set(data.photos);
    const toAdd = hashes.filter(h => !existing.has(h));
    if (toAdd.length === 0) return;
    await save({ ...data, photos: [...data.photos, ...toAdd] });
  }, [data, save]);

  const makePhotosPublic = useCallback(async (hashes: string[]) => {
    const toRemove = new Set(hashes);
    const photos = data.photos.filter(h => !toRemove.has(h));
    if (photos.length === data.photos.length) return;
    await save({ ...data, photos });
  }, [data, save]);

  return (
    <PrivacyContext.Provider value={{ isOwner, isPhotoPrivate, isAlbumPrivate, togglePhoto, toggleAlbum, makePhotosPrivate, makePhotosPublic }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}
