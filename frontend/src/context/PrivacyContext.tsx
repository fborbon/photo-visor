import {
  createContext, useContext, useState, useEffect, useCallback,
  ReactNode,
} from 'react';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';

interface PrivateIndex {
  photos: string[];   // photo hashes
  albums: string[];   // album keys e.g. "Spain_Barcelona"
}

interface PrivacyCtx {
  isOwner:        boolean;
  isPhotoPrivate: (hash: string) => boolean;
  isAlbumPrivate: (albumKey: string) => boolean;
  togglePhoto:    (hash: string) => Promise<void>;
  toggleAlbum:    (albumKey: string) => Promise<void>;
}

const PrivacyContext = createContext<PrivacyCtx>({
  isOwner:        false,
  isPhotoPrivate: () => false,
  isAlbumPrivate: () => false,
  togglePhoto:    async () => {},
  toggleAlbum:    async () => {},
});

const PRIVATE_KEY = 'index/private.json';
const empty: PrivateIndex = { photos: [], albums: [] };

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [data, setData]       = useState<PrivateIndex>(empty);
  const [isOwner, setIsOwner] = useState(false);

  // Determine if current user is the owner
  useEffect(() => {
    getCurrentUser()
      .then(u => {
        const email = u.signInDetails?.loginId ?? '';
        setIsOwner(email.toLowerCase() === config.ownerEmail.toLowerCase());
      })
      .catch(() => setIsOwner(false));
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

  return (
    <PrivacyContext.Provider value={{ isOwner, isPhotoPrivate, isAlbumPrivate, togglePhoto, toggleAlbum }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}
