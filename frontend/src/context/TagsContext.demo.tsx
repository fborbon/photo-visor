import { createContext, useContext, ReactNode } from 'react';
import { PhotoEntry, AlbumRef, TagEntry, SharedTagEntry } from '../types';

interface TagsCtx {
  tags:            Record<string, TagEntry>;
  tagNames:        string[];
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
  ownerKey:        string;
  isMySharedTag:   (tagName: string) => boolean;
}

const TagsContext = createContext<TagsCtx>({
  tags: {}, tagNames: [], sharedTags: {}, sharedTagNames: [],
  addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
  removePhotoTag: async () => {}, removeAlbumTag: async () => {},
  deleteTag: async () => {},
  getComment: () => '', setComment: async () => {},
  commentTimes: {},
  ownerKey: '', isMySharedTag: () => false,
});

export function TagsProvider({ children }: { children: ReactNode }) {
  return <TagsContext.Provider value={{
    tags: {}, tagNames: [], sharedTags: {}, sharedTagNames: [],
    addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
    removePhotoTag: async () => {}, removeAlbumTag: async () => {},
    deleteTag: async () => {},
    getComment: () => '', setComment: async () => {},
    commentTimes: {},
    ownerKey: '', isMySharedTag: () => false,
  }}>{children}</TagsContext.Provider>;
}

export function useTags() { return useContext(TagsContext); }
