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

// ── Demo photo stubs (hashes match dist-demo/index/recent.json) ──────
const p = (hash: string, s3pfx: string, dt: string, lat: number, lng: number,
           w: number, h: number, country: string, city: string, folder: string,
           month: number, day: number): PhotoEntry => ({
  hash, s3_key: `seed/${s3pfx}/1200/800`, thumb: `seed/${s3pfx}/${w > h ? '400/300' : '300/400'}`,
  dt, lat, lng, w, h, country, city, folder, month, day,
});

const photos: PhotoEntry[] = [
  p('8b54b5abae7591e2036ea5a17120ff3a9b71163bc689527c22d4017621c82a14','8b54b5ab','2025-12-23T16:29:00Z',40.72722,-73.88476,4000,3000,'USA','New York','Travel/USA/New York',12,23),
  p('0b23b8a3a21aa3b84e93f1928ab1d654708e8fb7d1fc1ceb05b7a9ac4e809c5b','0b23b8a3','2025-12-20T06:45:00Z',48.8297,2.40151,5000,3333,'France','Paris','Travel/France/Paris',12,20),
  p('a2905429a3f5aaa4cb539fbdba0ed688b192c8fbd7a53aae44dc9df8c02cb737','a2905429','2025-10-22T18:01:00Z',-34.57713,-58.30107,5000,3333,'Argentina','Buenos Aires','Travel/Argentina/Buenos Aires',10,22),
  p('030c6a98641f3988e01e11330f81b588ce917aeead2ea711f24b922bea2d9da1','030c6a98','2025-09-24T15:40:00Z',40.64238,-74.13675,3000,4000,'USA','New York','Travel/USA/New York',9,24),
  p('d62d0390911c211803b78295c7e0be122d3297360985875b3092c09d28f70989','d62d0390','2025-09-21T00:42:00Z',-34.62603,-58.47373,3840,2160,'Argentina','Buenos Aires','Travel/Argentina/Buenos Aires',9,21),
  p('b9a835643e306d6430484b90143ab6dc62e8ad3ec67b3114633dc4a87b1d64f5','b9a83564','2025-09-09T03:55:00Z',-33.84778,151.20082,4000,3000,'Australia','Sydney','Travel/Australia/Sydney',9,9),
  p('bfe5a1d64a4bc446cf6e43bfb1e0311e78d852912925009dadfb294b59fdb7dc','bfe5a1d6','2025-09-07T17:02:00Z',-1.36957,36.87532,4000,3000,'Kenya','Nairobi','Travel/Kenya/Nairobi',9,7),
  p('13619f3ca0fc10ff2b826a3a4bbc07edf93ef362eeb3c1d28d4a16e05a51fa1e','13619f3c','2025-09-04T09:47:00Z',-1.19873,36.8105,5000,3333,'Kenya','Nairobi','Travel/Kenya/Nairobi',9,4),
  p('f95e2717f1cb4957470c0c95cac7173dd18dd61094235fca23d3017f6b9f3467','f95e2717','2025-08-27T09:43:00Z',-1.41784,36.95357,3000,4000,'Kenya','Nairobi','Travel/Kenya/Nairobi',8,27),
  p('bda55b54f67c292199aa5f3413de8eab8068312406f4add43fb3dbc0bcbd8d0a','bda55b54','2025-08-21T02:43:00Z',-33.74283,151.29635,3000,4000,'Australia','Sydney','Travel/Australia/Sydney',8,21),
  p('381b6002939abe664b09c48f7aba4259f14a72c6c96b3eb644d8f97f8215fb86','381b6002','2025-08-04T08:53:00Z',35.68109,139.76471,4000,3000,'Japan','Tokyo','Travel/Japan/Tokyo',8,4),
  p('a584a29fbbc9cfc1827ba1f3d012095c0a1d83334bf38b600a27938259d9b438','a584a29f','2025-08-02T19:38:00Z',-33.78729,151.17411,3000,4000,'Australia','Sydney','Travel/Australia/Sydney',8,2),
  p('b8160e5e8b91d362d9a456298193b21ad731cd4c87dda415ef2a0b8083e44343','b8160e5e','2025-07-15T19:43:00Z',-1.2907,36.84495,3000,4000,'Kenya','Nairobi','Travel/Kenya/Nairobi',7,15),
  p('4a9d16e8f80f9b3e81c5e090759dc05277ce942d1fc725cf556191684294d087','4a9d16e8','2025-06-22T03:05:00Z',41.26901,2.27425,3840,2160,'Spain','Barcelona','Travel/Spain/Barcelona',6,22),
  p('18ece92a76b0b80938a5783a7079c3d2d629d18390c4d26ca554c3930e80ef0d','18ece92a','2025-05-02T05:26:00Z',48.85441,2.4594,3840,2160,'France','Paris','Travel/France/Paris',5,2),
  p('d27377ec10b0b5d0adc9f88ab68f47c48410d68a20c56660285b12af7a05d778','d27377ec','2025-04-28T19:51:00Z',-1.3743,36.72704,5000,3333,'Kenya','Nairobi','Travel/Kenya/Nairobi',4,28),
  p('d4cc5db78fcfd86b072b0b7e534eddd7b4bf4515035e7353cdf9f887a249e78d','d4cc5db7','2025-04-06T02:38:00Z',48.91256,2.27056,4000,3000,'France','Paris','Travel/France/Paris',4,6),
  p('ae288d3ae940b7f2d40a854ee582355bfc671958716958af3ae053389be05e2e','ae288d3a','2025-03-28T21:05:00Z',40.71464,-73.97012,5000,3333,'USA','New York','Travel/USA/New York',3,28),
  p('297dd0b33f851bec8fedc785d77f58d02b8830fe90084a7ac3fe55378c7adb6b','297dd0b3','2025-02-25T07:12:00Z',48.87089,2.24205,3000,4000,'France','Paris','Travel/France/Paris',2,25),
  p('b9a65f9c8ef8ddbc237cf5886c44d37731e11218bf2a1090bf7bb20afe290254','b9a65f9c','2025-02-21T12:17:00Z',41.43071,2.12945,3840,2160,'Spain','Barcelona','Travel/Spain/Barcelona',2,21),
];

// ── Dummy comments for all 20 photos ─────────────────────────────────
const COMMENTS: Record<string, string> = {
  [photos[0].hash]:  'The view from Brooklyn Bridge at golden hour — worth every step.',
  [photos[1].hash]:  'Stumbled upon this corner near Bastille. Perfect winter morning light.',
  [photos[2].hash]:  'San Telmo market on a Sunday. The empanadas here were incredible.',
  [photos[3].hash]:  'Lower East Side street art walk. Every block tells a different story.',
  [photos[4].hash]:  'Late night in Palermo. The energy here never really dies down.',
  [photos[5].hash]:  'Bondi to Coogee coastal walk at sunrise. Absolutely stunning.',
  [photos[6].hash]:  'Karura Forest — unexpected green oasis right inside the city.',
  [photos[7].hash]:  'Watching giraffes from the road on the way back from Ngong Hills.',
  [photos[8].hash]:  'Ngong Hills trail in the early morning. Cool air, incredible views.',
  [photos[9].hash]:  'Manly Beach after the crowds left. Quiet, warm, golden.',
  [photos[10].hash]: 'Senso-ji Temple at dusk. The lanterns glow beautifully in the blue hour.',
  [photos[11].hash]: 'Freshwater Beach — smaller and quieter than Bondi, and all the better for it.',
  [photos[12].hash]: 'Nairobi National Park. Had a cheetah cross the road in front of us.',
  [photos[13].hash]: 'Barceloneta sunset walk. The Mediterranean looked unreal this evening.',
  [photos[14].hash]: 'Canal Saint-Martin. Found this spot after getting lost, best kind of discovery.',
  [photos[15].hash]: 'Nairobi CBD from Uhuru Park. City is growing so fast.',
  [photos[16].hash]: 'Montmartre at dawn before the tourists arrived. Total magic.',
  [photos[17].hash]: 'The High Line in late March — cherry blossoms just starting to open.',
  [photos[18].hash]: 'Seine riverbank on a grey February morning. Still love Paris in winter.',
  [photos[19].hash]: 'Gracia neighbourhood evening stroll. These streets feel like a village.',
};

const COMMENT_TIMES: Record<string, string> = Object.fromEntries(
  photos.map((ph, i) => [ph.hash, `2025-${String(i + 1).padStart(2,'0')}-10T12:00:00Z`])
);

// ── Demo tags ─────────────────────────────────────────────────────────
const TAGS: Record<string, TagEntry> = {
  'Favorites': {
    createdAt: '2025-01-15T10:00:00Z',
    photos: [photos[0], photos[10], photos[13], photos[17], photos[19]],
    albums: [{ key: 'France_Paris', title: 'Paris, France' }],
  },
  'Sunsets': {
    createdAt: '2025-02-01T09:00:00Z',
    photos: [photos[1], photos[5], photos[9], photos[14], photos[16]],
    albums: [],
  },
  'City Life': {
    createdAt: '2025-03-10T08:00:00Z',
    photos: [photos[0], photos[2], photos[3], photos[17], photos[18]],
    albums: [{ key: 'USA_New_York', title: 'New York, USA' }],
  },
  'Nature Walks': {
    createdAt: '2025-04-05T11:00:00Z',
    photos: [photos[6], photos[7], photos[8], photos[12], photos[15]],
    albums: [{ key: 'Kenya_Nairobi', title: 'Nairobi, Kenya' }],
  },
};

// ── Shared / family tags ──────────────────────────────────────────────
const SHARED_TAGS: Record<string, SharedTagEntry> = {
  'Family Trips 2025': {
    createdAt: '2025-01-01T00:00:00Z',
    ownerKey: 'demo_user',
    ownerEmail: 'demo@example.com',
    photos: [photos[4], photos[10], photos[13], photos[19]],
    albums: [{ key: 'Spain_Barcelona', title: 'Barcelona, Spain' }],
  },
  'Best of 2025': {
    createdAt: '2025-06-01T00:00:00Z',
    ownerKey: 'demo_user',
    ownerEmail: 'demo@example.com',
    photos: [photos[0], photos[1], photos[5], photos[10], photos[14]],
    albums: [],
  },
};

// ── Context ───────────────────────────────────────────────────────────
const TagsContext = createContext<TagsCtx>({
  tags: TAGS,
  tagNames: Object.keys(TAGS).sort(),
  sharedTags: SHARED_TAGS,
  sharedTagNames: Object.keys(SHARED_TAGS).sort(),
  addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
  removePhotoTag: async () => {}, removeAlbumTag: async () => {},
  deleteTag: async () => {},
  getComment: (hash) => COMMENTS[hash] ?? '',
  setComment: async () => {},
  commentTimes: COMMENT_TIMES,
  ownerKey: 'demo_user',
  isMySharedTag: () => false,
});

export function TagsProvider({ children }: { children: ReactNode }) {
  return (
    <TagsContext.Provider value={{
      tags: TAGS,
      tagNames: Object.keys(TAGS).sort(),
      sharedTags: SHARED_TAGS,
      sharedTagNames: Object.keys(SHARED_TAGS).sort(),
      addPhotoToTag: async () => {}, addAlbumToTag:  async () => {},
      removePhotoTag: async () => {}, removeAlbumTag: async () => {},
      deleteTag: async () => {},
      getComment: (hash) => COMMENTS[hash] ?? '',
      setComment: async () => {},
      commentTimes: COMMENT_TIMES,
      ownerKey: 'demo_user',
      isMySharedTag: (name) => name in SHARED_TAGS,
    }}>
      {children}
    </TagsContext.Provider>
  );
}

export function useTags() { return useContext(TagsContext); }
