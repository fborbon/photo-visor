export interface PhotoEntry {
  hash:    string;
  s3_key:  string | null;   // S3 key for full-res e.g. "photos/ab/abc123.jpg"
  thumb:   string | null;   // S3 key for thumbnail e.g. "thumbs/ab/abc123.jpg"
  dt:      string | null;   // ISO datetime
  lat:     number | null;
  lng:     number | null;
  w:       number | null;
  h:       number | null;
  country?: string;
  city?:   string;
  folder?: string;
  path?:   string;          // relative path on hard drive e.g. "Camera/Europa/España/..."
  month?:  number;
  day?:    number;
  make?:   string;          // EXIF camera make e.g. "Samsung"
  model?:  string;          // EXIF camera model e.g. "SM-A326B"
  video_proxy?: string | null;  // S3 key for H.264 MP4 proxy of non-MP4 videos
  name?: string;               // original filename e.g. "IMG_20240101_120000.jpg" (phone-synced photos)
}

export interface LocationSummary {
  continent: string | null;
  country:   string | null;
  city:      string | null;
  count:     number;
  lat:       number | null;
  lng:       number | null;
}

export interface Summary {
  generated:       string;
  total:           number;
  locations:       LocationSummary[];
  years:           number[];
  general_folders: string[];
}

export type Tab = 'map' | 'timeline' | 'tags' | 'upload' | 'latest' | 'slots' | 'stats' | 'sync' | 'trash' | 'usage';

export interface AlbumConfig {
  sync:         boolean;
  location:     string;
  forcePath:    string;
  createFolder: boolean;
}

export interface AlbumItem {
  identifier: string;
  name:       string;
  isCamera:   boolean;
}

export interface MonthStat { ym: string; count: number; }
export interface StatsIndex {
  generated:         string;
  total:             number;
  no_date:           number;
  by_month:          MonthStat[];
  storage_gb?:       number;
  monthly_cost_usd?: number;
}

export interface AlbumRef {
  key:   string;   // e.g. "Spain_Barcelona"
  title: string;   // e.g. "Barcelona, Spain"
}

export interface TagEntry {
  photos:    PhotoEntry[];
  albums:    AlbumRef[];
  createdAt?: string;
}

export interface RecentIndex {
  updated: string;
  photos:  (PhotoEntry & { addedAt: string })[];
}

export interface UserTags {
  updated:      string;
  tags:         Record<string, TagEntry>;
  comments:     Record<string, string>;
  commentTimes: Record<string, string>;   // hash → ISO timestamp of last comment edit
}

export interface SharedTagEntry extends TagEntry {
  ownerKey:   string;   // normalised email key of creator
  ownerEmail: string;
}

export interface SharedComment {
  text:       string;
  ownerKey:   string;
  ownerEmail: string;
}

export interface SharedTags {
  updated:      string;
  tags:         Record<string, SharedTagEntry>;
  comments:     Record<string, SharedComment>;
  commentTimes: Record<string, string>;
}

export interface SystemTagMeta {
  count:  number;
  slug:   string;
  public?: boolean;  // true = Camera/ origin (visible to all); false/absent = .Amigos/.Whatsapp (owner only)
  lat?:   number | null;   // avg latitude  from photos with GPS — more accurate than hardcoded table
  lng?:   number | null;   // avg longitude from photos with GPS
}

export interface SystemTagIndex {
  updated: string;
  tags:    Record<string, SystemTagMeta>;
}
