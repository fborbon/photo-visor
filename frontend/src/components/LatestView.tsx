import { useState, useMemo } from 'react';
import { useTags }        from '../context/TagsContext';
import { useLang }        from '../context/LangContext';
import { useIndex }       from '../hooks/useIndex';
import { RecentIndex, PhotoEntry } from '../types';
import PhotoGrid          from './PhotoGrid';
import PhotoModal         from './PhotoModal';
import AddTagModal        from './AddTagModal';
import AddCommentModal    from './AddCommentModal';
import config             from '../config';

type Subtab = 'added' | 'tags' | 'comments';

const LS_KEY = (s: Subtab) => 'latest_cleared_' + s;
const STRIP  = 6;

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
  const [subtab, setSubtab] = useState<Subtab>('added');

  const [clearedAdded,    setClearedAdded]    = useState(() => loadCleared('added'));
  const [clearedTags,     setClearedTags]     = useState(() => loadCleared('tags'));
  const [clearedComments, setClearedComments] = useState(() => loadCleared('comments'));

  // ── Full-size modal state ──────────────────────────────────────────
  const [modalPhotos, setModalPhotos] = useState<PhotoEntry[]>([]);
  const [modalIdx,    setModalIdx]    = useState<number | null>(null);
  const [addTagPhoto, setAddTagPhoto] = useState<PhotoEntry | null>(null);
  const [commentPhoto,setCommentPhoto]= useState<PhotoEntry | null>(null);

  function openModal(photos: PhotoEntry[], idx: number) {
    setModalPhotos(photos);
    setModalIdx(idx);
  }
  function closeModal() { setModalIdx(null); setModalPhotos([]); }

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
    subtab === 'added' ? 'index/recent.json' : null
  );

  // Read the most-recent 100 records saved by useSync (refreshes on each tab visit)
  const [syncedRecords] = useState((): { hash: string; s3_key: string; syncedAt: string }[] => {
    try { return JSON.parse(localStorage.getItem('photo_sync_recent') ?? '[]'); }
    catch { return []; }
  });

  // ── Shared photo lookup (used by both Added and Comments) ──────────
  const photoByHash = useMemo((): Record<string, PhotoEntry> => {
    const map: Record<string, PhotoEntry> = {};
    for (const e of Object.values(ctx.tags))       for (const p of e.photos) map[p.hash] = p;
    for (const e of Object.values(ctx.sharedTags)) for (const p of e.photos) map[p.hash] = p;
    if (recentIndex) for (const p of recentIndex.photos) map[p.hash] = p;
    return map;
  }, [ctx.tags, ctx.sharedTags, recentIndex]);

  const clearedAddedMs = clearedAdded ? Date.parse(clearedAdded) : 0;

  // Merge localStorage sync log + recent.json, deduplicated, newest first, cap 100
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
  const commentItems = Object.entries(ctx.commentTimes)
    .map(([hash, updatedAt]) => ({
      hash, updatedAt,
      text:  ctx.getComment(hash),
      photo: photoByHash[hash] ?? null,
    }))
    .filter(c => c.text && (!clearedComments || c.updatedAt > clearedComments))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Navigable list of photos for the comments modal
  const commentPhotos = commentItems.map(c => c.photo).filter(Boolean) as PhotoEntry[];

  const canClear =
    (subtab === 'added'    && addedPhotos.length > 0) ||
    (subtab === 'tags'     && allTagsSorted.length > 0) ||
    (subtab === 'comments' && commentItems.length > 0);

  const currentPhoto = modalIdx !== null ? modalPhotos[modalIdx] : null;

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
            <PhotoGrid photos={addedPhotos} title={tr.latestAdded} navMode="latest" />
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
                  // Full navigable list for this tag (all photos with thumbs)
                  const tagPhotos = t.photos.filter(p => p.thumb);
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
                          {thumbPhotos.map(p => (
                            <img
                              key={p.hash}
                              className="latest-strip-thumb"
                              src={config.cloudFrontUrl + '/' + p.thumb}
                              alt=""
                              onClick={() => openModal(tagPhotos, tagPhotos.indexOf(p))}
                            />
                          ))}
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
              <div className="latest-comment-cards">
                {commentItems.map(c => {
                  const photoIdx = c.photo ? commentPhotos.indexOf(c.photo) : -1;
                  return (
                    <div
                      key={c.hash}
                      className={'latest-comment-card' + (c.photo ? ' clickable' : '')}
                      onClick={() => c.photo && photoIdx >= 0 && openModal(commentPhotos, photoIdx)}
                    >
                      {c.photo?.thumb
                        ? (
                          <img
                            className="latest-comment-thumb"
                            src={config.cloudFrontUrl + '/' + c.photo.thumb}
                            alt=""
                          />
                        )
                        : <div className="latest-comment-no-thumb">📷</div>
                      }
                      <div className="latest-comment-body">
                        <p className="latest-comment-text">"{c.text}"</p>
                        {c.photo && (
                          <p className="latest-comment-place">
                            {[c.photo.city, c.photo.country].filter(Boolean).join(', ')
                              || c.photo.folder?.split('/').pop() || ''}
                          </p>
                        )}
                      </div>
                      <span className="latest-item-date latest-comment-date">{fmt(c.updatedAt, months)}</span>
                    </div>
                  );
                })}
              </div>
            )
          }
        </div>
      )}

      {/* ── Full-size photo modal ──────────────────────────────────── */}
      {currentPhoto && (
        <PhotoModal
          photo={currentPhoto}
          onClose={closeModal}
          onPrev={modalIdx! > 0
            ? () => setModalIdx(i => i! - 1)
            : null}
          onNext={modalIdx! < modalPhotos.length - 1
            ? () => setModalIdx(i => i! + 1)
            : null}
          onAddTag={p  => setAddTagPhoto(p)}
          onAddComment={p => setCommentPhoto(p)}
        />
      )}

      {addTagPhoto && (
        <AddTagModal
          onAdd={(tagName, shared) => {
            ctx.addPhotoToTag(addTagPhoto, tagName, shared);
            setAddTagPhoto(null);
          }}
          onClose={() => setAddTagPhoto(null)}
        />
      )}

      {commentPhoto && (
        <AddCommentModal
          existing={ctx.getComment(commentPhoto.hash)}
          onSave={text => { ctx.setComment(commentPhoto.hash, text); setCommentPhoto(null); }}
          onClose={() => setCommentPhoto(null)}
        />
      )}
    </div>
  );
}
