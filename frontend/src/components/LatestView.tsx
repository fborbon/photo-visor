import { useState } from 'react';
import { useTags }   from '../context/TagsContext';
import { useLang }   from '../context/LangContext';
import { useIndex }  from '../hooks/useIndex';
import { RecentIndex, PhotoEntry } from '../types';
import PhotoGrid     from './PhotoGrid';
import config        from '../config';

type Subtab = 'added' | 'tags' | 'comments';

const LS_KEY = (s: Subtab) => 'latest_cleared_' + s;
const STRIP  = 6;   // max thumbs shown per tag strip

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

  // Modal state for comment photos
  const [modalPhoto,  setModalPhoto]  = useState<PhotoEntry | null>(null);

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
  const addedPhotos = recentIndex
    ? recentIndex.photos.filter(p => !clearedAdded || p.addedAt > clearedAdded)
    : [];

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
  const photoByHash: Record<string, PhotoEntry> = {};
  for (const e of Object.values(ctx.tags))       for (const p of e.photos) photoByHash[p.hash] = p;
  for (const e of Object.values(ctx.sharedTags)) for (const p of e.photos) photoByHash[p.hash] = p;
  if (recentIndex) for (const p of recentIndex.photos) photoByHash[p.hash] = p;

  const commentItems = Object.entries(ctx.commentTimes)
    .map(([hash, updatedAt]) => ({
      hash, updatedAt,
      text:  ctx.getComment(hash),
      photo: photoByHash[hash] ?? null,
    }))
    .filter(c => c.text && (!clearedComments || c.updatedAt > clearedComments))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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
            <PhotoGrid photos={addedPhotos} title={tr.latestAdded} />
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
                          {thumbPhotos.map(p => (
                            <img
                              key={p.hash}
                              className="latest-strip-thumb"
                              src={config.cloudFrontUrl + '/' + p.thumb}
                              alt=""
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
                {commentItems.map(c => (
                  <div key={c.hash} className="latest-comment-card"
                    onClick={() => c.photo && setModalPhoto(c.photo)}
                    style={{ cursor: c.photo ? 'pointer' : 'default' }}
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
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* Simple photo modal for comment photos */}
      {modalPhoto && (
        <div className="modal-overlay" onClick={() => setModalPhoto(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModalPhoto(null)}>✕</button>
            {modalPhoto.thumb && (
              <img
                className="modal-img"
                src={config.cloudFrontUrl + '/' + (modalPhoto.s3_key ?? modalPhoto.thumb)}
                alt=""
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
