import { useState, useMemo } from 'react';
import { useTags }        from '../context/TagsContext';
import { useLang }        from '../context/LangContext';
import { useNav }         from '../context/NavContext';
import { useIndex }       from '../hooks/useIndex';
import { RecentIndex, PhotoEntry } from '../types';
import PhotoGrid          from './PhotoGrid';
import config             from '../config';

const STRIP = 12;

type Subtab = 'added' | 'tags' | 'comments';

const LS_KEY = (s: Subtab) => 'latest_cleared_' + s;

function loadCleared(s: Subtab): string {
  return localStorage.getItem(LS_KEY(s)) ?? '';
}

function fmt(dt: string, months: readonly string[]): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return dt.slice(0, 10);
  return String(d.getDate()).padStart(2, '0') + '/' + months[d.getMonth() + 1] + '/' + d.getFullYear();
}

export default function LatestView() {
  const { tr }  = useLang();
  const ctx     = useTags();
  const { navigate } = useNav();
  const [subtab, setSubtab] = useState<Subtab>('added');

  const [clearedAdded,    setClearedAdded]    = useState(() => loadCleared('added'));
  const [clearedTags,     setClearedTags]     = useState(() => loadCleared('tags'));
  const [clearedComments, setClearedComments] = useState(() => loadCleared('comments'));


  function clear(s: Subtab) {
    const now = new Date().toISOString();
    localStorage.setItem(LS_KEY(s), now);
    if (s === 'added')    setClearedAdded(now);
    if (s === 'tags')     setClearedTags(now);
    if (s === 'comments') setClearedComments(now);
  }

  const months = tr.months;

  // ── Added subtab ──────────────────────────────────────────────────
  const { data: recentIndex, loading: recentLoading } = useIndex<RecentIndex>(
    subtab === 'added' || subtab === 'comments' ? 'index/recent.json' : null
  );

  // Read the most-recent 100 records saved by useSync (refreshes on each tab visit)
  const [syncedRecords] = useState((): { hash: string; s3_key: string; syncedAt: string }[] => {
    try { return JSON.parse(localStorage.getItem('photo_sync_recent') ?? '[]'); }
    catch { return []; }
  });

  // ── Shared photo lookup (used by both Added and Comments) ──────────
  const commentHashes = useMemo(() => {
    const hashes = new Set<string>();
    for (const h of Object.keys(ctx.sharedCommentTimes)) hashes.add(h);
    for (const h of Object.keys(ctx.commentTimes)) hashes.add(h);
    return hashes;
  }, [ctx.sharedCommentTimes, ctx.commentTimes]);

  const photoByHash = useMemo((): Record<string, PhotoEntry> => {
    const map: Record<string, PhotoEntry> = {};
    for (const e of Object.values(ctx.tags))       for (const p of e.photos) map[p.hash] = p;
    for (const e of Object.values(ctx.sharedTags)) for (const p of e.photos) map[p.hash] = p;
    if (recentIndex) for (const p of recentIndex.photos) map[p.hash] = p;
    // For commented photos not found in tags/recent, construct a stub with the
    // standard thumb path so thumbnails display in the Comments subtab.
    // s3_key is null because we don't know the actual extension (.heic/.jpg).
    for (const h of commentHashes) {
      if (!map[h]) {
        map[h] = {
          hash: h, s3_key: null,
          thumb: `thumbs/${h.slice(0, 2)}/${h}.jpg`,
          dt: null, lat: null, lng: null, w: null, h: null,
        };
      }
    }
    return map;
  }, [ctx.tags, ctx.sharedTags, recentIndex, commentHashes]);

  const clearedAddedMs = clearedAdded ? Date.parse(clearedAdded) : 0;

  // Merge localStorage sync log + recent.json, deduplicated, newest first.
  // Always show at least 30 photos from recent.json even if the user has cleared.
  const addedPhotos = useMemo((): PhotoEntry[] => {
    const seen  = new Set<string>();
    const items: { photo: PhotoEntry; sort: string }[] = [];

    for (const rec of syncedRecords) {
      if (seen.has(rec.hash)) continue;
      if (clearedAdded && rec.syncedAt <= clearedAdded) continue;
      seen.add(rec.hash);
      const photo: PhotoEntry = photoByHash[rec.hash] ?? {
        hash: rec.hash, s3_key: rec.s3_key, thumb: null,
        dt: null, lat: null, lng: null, w: null, h: null,
      };
      items.push({ photo, sort: rec.syncedAt });
    }

    if (recentIndex) {
      for (const p of recentIndex.photos) {
        if (seen.has(p.hash)) continue;
        if (clearedAdded) {
          const ts = Date.parse(p.addedAt);
          if (!isNaN(ts) && ts <= clearedAddedMs) continue;
        }
        seen.add(p.hash);
        items.push({ photo: p, sort: p.addedAt });
      }
    }

    // Fallback: if filtered list is empty, show newest 30 from recent.json
    if (items.length === 0 && recentIndex) {
      for (const p of recentIndex.photos.slice(0, 30)) {
        if (!seen.has(p.hash)) {
          seen.add(p.hash);
          items.push({ photo: p, sort: p.addedAt });
        }
      }
    }

    return items
      .sort((a, b) => b.sort.localeCompare(a.sort))
      .slice(0, 100)
      .map(x => x.photo);
  }, [syncedRecords, photoByHash, recentIndex, clearedAdded, clearedAddedMs]);

  // ── Tags subtab ───────────────────────────────────────────────────
  const allTagsSorted = [
    ...Object.entries(ctx.tags).map(([name, e]) => ({
      name, shared: false, createdAt: e.createdAt ?? '',
      photos: e.photos, albums: e.albums,
    })),
    ...Object.entries(ctx.sharedTags).map(([name, e]) => ({
      name, shared: true, createdAt: e.createdAt ?? '',
      photos: e.photos, albums: e.albums,
    })),
  ]
    .filter(t => t.createdAt && (!clearedTags || t.createdAt > clearedTags))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // ── Comments subtab ───────────────────────────────────────────────
  const commentItems = useMemo(() => {
    const seen = new Set<string>();
    const items: { hash: string; updatedAt: string; text: string; photo: PhotoEntry | null; shared: boolean }[] = [];
    for (const [hash, updatedAt] of Object.entries(ctx.sharedCommentTimes)) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      const text = ctx.getComment(hash);
      if (!text) continue;
      if (clearedComments && updatedAt <= clearedComments) continue;
      items.push({ hash, updatedAt, text, photo: photoByHash[hash] ?? null, shared: true });
    }
    for (const [hash, updatedAt] of Object.entries(ctx.commentTimes)) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      const text = ctx.getComment(hash);
      if (!text) continue;
      if (clearedComments && updatedAt <= clearedComments) continue;
      items.push({ hash, updatedAt, text, photo: photoByHash[hash] ?? null, shared: false });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [ctx.commentTimes, ctx.sharedCommentTimes, ctx.getComment, photoByHash, clearedComments]);


  const canClear =
    (subtab === 'added'    && addedPhotos.length > 0) ||
    (subtab === 'tags'     && allTagsSorted.length > 0) ||
    (subtab === 'comments' && commentItems.length > 0);


  return (
    <div className="latest-layout">

      {/* Subtab pills + clear button */}
      <div className="latest-subtabs">
        {(['added', 'tags', 'comments'] as Subtab[]).map(s => (
          <button
            key={s}
            className={'latest-pill' + (subtab === s ? ' active' : '')}
            onClick={() => setSubtab(s)}
          >
            {s === 'added' ? `📸 ${tr.latestAdded}` : s === 'tags' ? `🏷 ${tr.latestTags}` : `💬 ${tr.latestComments}`}
          </button>
        ))}
        {canClear && (
          <button className="latest-clear-btn" onClick={() => clear(subtab)}>
            ✕ {tr.clearList}
          </button>
        )}
      </div>

      {/* ── Added ─────────────────────────────────────────────────── */}
      {subtab === 'added' && (
        <div className="latest-body">
          {recentLoading && <p className="panel-loading">{tr.loading}</p>}
          {!recentLoading && addedPhotos.length === 0 && (
            <p className="panel-loading">{tr.noRecentPhotos}</p>
          )}
          {addedPhotos.length > 0 && (
            <PhotoGrid photos={addedPhotos} title={tr.latestAdded} navMode="latest" defaultSort="newest" />
          )}
        </div>
      )}

      {/* ── Tags ──────────────────────────────────────────────────── */}
      {subtab === 'tags' && (
        <div className="latest-body">
          {allTagsSorted.length === 0
            ? <p className="panel-loading">{tr.noRecentTags}</p>
            : (
              <div className="latest-tag-cards">
                {allTagsSorted.map(t => {
                  const thumbPhotos = t.photos.filter(p => p.thumb).slice(0, STRIP);
                  const extra = t.photos.length - thumbPhotos.length;
                  const total = t.photos.length + t.albums.length;
                  return (
                    <div key={(t.shared ? 's:' : 'p:') + t.name} className="latest-tag-card">
                      <div className="latest-tag-header">
                        <span className="latest-tag-icon">{t.shared ? '👨‍👩‍👧' : '🔒'}</span>
                        <span className="latest-tag-name">{t.name}</span>
                        <span className="latest-tag-meta">{total} {tr.taggedPhotos}</span>
                        <span className="latest-item-date">{fmt(t.createdAt, months)}</span>
                      </div>
                      {thumbPhotos.length > 0 && (
                        <div className="latest-strip">
                          {thumbPhotos.map(p => {
                            const dt = p.dt ? new Date(p.dt) : null;
                            return (
                              <div key={p.hash} className="latest-strip-cell">
                                <img
                                  className="latest-strip-thumb"
                                  src={config.cloudFrontUrl + '/' + p.thumb}
                                  alt=""
                                />
                                <div className="latest-strip-nav">
                                  <button title="Timeline" onClick={() => navigate('timeline', { hash: p.hash, year: dt?.getFullYear(), month: dt ? dt.getMonth()+1 : undefined })}>📅</button>
                                  <button title="Map" onClick={() => navigate('map', { hash: p.hash, mapCountry: p.country ?? undefined, mapCity: p.city ?? undefined })}>📍</button>
                                  <button title="Folder" onClick={() => navigate('tags', { hash: p.hash, folderPath: p.path ? p.path.split('/').slice(0,-1).join('/') : undefined })}>📂</button>
                                </div>
                                <button className="latest-strip-clip" title="Copy path"
                                  onClick={() => navigator.clipboard.writeText(p.path ?? p.folder ?? p.hash).catch(()=>{})}>📋</button>
                              </div>
                            );
                          })}
                          {extra > 0 && (
                            <div className="latest-strip-more">+{extra}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          }
        </div>
      )}

      {/* ── Comments ──────────────────────────────────────────────── */}
      {subtab === 'comments' && (
        <div className="latest-body">
          {commentItems.length === 0
            ? <p className="panel-loading">{tr.noRecentComments}</p>
            : (
              <>
                {commentItems.map(c => (
                  <div key={c.hash} className="latest-comment-card">
                    <div className="latest-comment-header">
                      <span className="latest-comment-text">💬 "{c.text}"</span>
                    </div>
                    {c.photo && <PhotoGrid photos={[c.photo]} navMode="latest" hideHeader />}
                  </div>
                ))}
              </>
            )
          }
        </div>
      )}

    </div>
  );
}
