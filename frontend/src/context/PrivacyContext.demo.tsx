import { createContext, useContext, ReactNode } from 'react';

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

export function PrivacyProvider({ children }: { children: ReactNode }) {
  return <PrivacyContext.Provider value={{
    isOwner:        false,
    isPhotoPrivate: () => false,
    isAlbumPrivate: () => false,
    togglePhoto:    async () => {},
    toggleAlbum:    async () => {},
  }}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy() { return useContext(PrivacyContext); }
