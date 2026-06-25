import { useState, useRef, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PhotoEntry } from '../types';
import { useNav, PendingNav } from '../context/NavContext';
import { usePrivacy }      from '../context/PrivacyContext';
import { useTags }         from '../context/TagsContext';
import { useTrash }        from '../context/TrashContext';
import { useLang }         from '../context/LangContext';
import { useAnalytics }    from '../context/AnalyticsContext';
import PhotoModal, { preloadPhoto } from './PhotoModal';
import ContextMenu, { MenuItem } from './ContextMenu';
import AddTagModal         from './AddTagModal';
import AddCommentModal     from './AddCommentModal';
import config from '../config';

/** Which cross-tab nav icons to show on each thumbnail. */
export type NavMode = 'map' | 'timeline' | 'path' | 'tags' | 'latest' | 'slots';

interface Props {
  photos:         PhotoEntry[];
  albumKey?:      string;
  title?:         string;
  placeFallback?: string;
  // Cross-tab navigation
  navMode?:       NavMode;    // which tab this grid lives in (controls which icons appear)
  navTagName?:    string;     // Map: full sysTag name (e.g. "España/Pamplona/Concierto Malu")
  defaultSort?:   SortOrder;  // initial sort order (default: 'oldest')
  hideHeader?:    boolean;    // hide title + sort buttons
}

interface MenuState { x: number; y: number; forSelection: boolean; singlePhoto: PhotoEntry | null; }

function formatDate(dt: string | null, months: readonly string[]): string {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + months[d.getMonth() + 1] + '/' + d.getFullYear();
}

// Reject values that are clearly not human-readable place names
function isValidPlace(s: string): boolean {
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;          // pure numeric (OSM IDs)
  if (s.includes('/')) return false;           // folder path
  if (s.length > 60) return false;             // excessively long
  if (/^[A-Za-z]+\d+$/.test(s)) return false; // identifier like "Camera1"
  return true;
}

function formatPlace(photo: PhotoEntry, fallback = ''): string {
  const city    = isValidPlace(photo.city    ?? '') ? photo.city    : null;
  const country = isValidPlace(photo.country ?? '') ? photo.country : null;
  const parts   = [city, country].filter(Boolean);
  return parts.length ? parts.join(', ') : fallback;
}

function commentPreview(text: string, max = 38): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Extract the descriptive part of a photo path using the location-description
 * splitting schema: Camera/Continent/Country/[Region]/[City]/[Place]/DESCRIPTION...
 * Finds the last segment matching city or country, returns everything after it.
 */
function extractDescription(folder: string | undefined | null,
                             city:   string | undefined | null,
                             country: string | undefined | null): string | null {
  if (!folder) return null;
  const segs = folder.split('/').filter(s => s.length > 0);
  if (segs.length === 0) return null;

  // Try city first, then country as the geographic anchor
  const geoAnchor = (city && isValidPlace(city) ? city : null)
                 ?? (country && isValidPlace(country) ? country : null);
  if (geoAnchor) {
    const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
    const anchorNorm = norm(geoAnchor);
    let splitIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      const sn = norm(segs[i]);
      if (sn === anchorNorm || sn.startsWith(anchorNorm) || anchorNorm.startsWith(sn)) {
        splitIdx = i;
      }
    }
    if (splitIdx !== -1) {
      const descSegs = segs.slice(splitIdx + 1);
      if (descSegs.length > 0) return descSegs.join(' / ');
    }
  }

  // Fallback: GPS city not found in path — use last segment as the album name.
  // This ensures Row 1 always appears regardless of geocoding variation.
  return segs[segs.length - 1];
}

function shortModel(model: string): string {
  return model.replace(/^SM-/i, '').replace(/^DMC-/i, '').slice(0, 7);
}

type SortOrder = 'default' | 'oldest' | 'newest';

export default function PhotoGrid({ photos, albumKey, title, placeFallback = '', navMode, navTagName, defaultSort = 'oldest', hideHeader }: Props) {
  const [modalIdx,     setModalIdx]     = useState<number | null>(null);
  const [selection,    setSelection]    = useState<Set<number>>(new Set());
  const lastClickedRef                  = useRef<number | null>(null);
  const [menu,         setMenu]         = useState<MenuState | null>(null);
  const longPressTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPos     = useRef<{ x: number; y: number } | null>(null);
  const longPressDidFire = useRef(false);
  const [addTagTarget, setAddTagTarget] = useState<PhotoEntry[] | null>(null);
  const [commentPhoto, setCommentPhoto] = useState<PhotoEntry | null>(null);
  const [sortOrder,    setSortOrder]    = useState<SortOrder>(defaultSort);
  const [mobileNavIdx, setMobileNavIdx] = useState<number | null>(null);
  const longPressTimer2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { navigate } = useNav();
  const { isOwner, dateCutoff, isTagAllowed, isPhotoPrivate, isAlbumPrivate, togglePhoto } = usePrivacy();
  const { addPhotoToTag, getComment, getCommentShared, setComment, tags, sharedTags, systemTagIndex } = useTags();
  const { trashPhotos, isTrashed } = useTrash();
  const { tr } = useLang();
  const { trackEvent } = useAnalytics();

  const albumPrivate = albumKey ? isAlbumPrivate(albumKey) : false;
  const filtered = photos.filter(p => {
    if (isTrashed(p.hash)) return false;
    if (dateCutoff && p.dt && p.dt < dateCutoff) return false;
    if (isOwner) return true;
    const photoPath = p.path ?? p.folder ?? '';
    if (isTagAllowed(photoPath)) return true;
    return !isPhotoPrivate(p.hash) && !albumPrivate;
  });
  const visible = sortOrder === 'default' ? filtered : [...filtered].sort((a, b) => {
    const da = a.dt ?? '', db = b.dt ?? '';
    return sortOrder === 'oldest' ? da.localeCompare(db) : db.localeCompare(da);
  });

  // Track album view on mount / albumKey change
  useEffect(() => {
    if (albumKey) trackEvent('view_album', { albumKey, albumTitle: title ?? albumKey });
  }, [albumKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track photo views and preload neighbors
  useEffect(() => {
    if (modalIdx === null) return;
    const p = visible[modalIdx];
    if (p) trackEvent('view_photo', { albumKey: albumKey ?? '', albumTitle: title ?? albumKey ?? '' });
    if (modalIdx > 0)                   preloadPhoto(visible[modalIdx - 1]);
    if (modalIdx < visible.length - 1)  preloadPhoto(visible[modalIdx + 1]);
  }, [modalIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible.length) return null;

  const hasSelection = selection.size > 0;
  const current      = modalIdx !== null ? visible[modalIdx] : null;

  // ── Click handler with Shift/Ctrl support ────────────────────────
  const handleClick = (e: React.MouseEvent, idx: number) => {
    if (longPressDidFire.current) { longPressDidFire.current = false; return; }
    const isCtrl  = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isCtrl) {
      e.preventDefault();
      const next = new Set(selection);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      setSelection(next);
      lastClickedRef.current = idx;
      return;
    }

    if (isShift && lastClickedRef.current !== null) {
      e.preventDefault();
      const lo   = Math.min(lastClickedRef.current, idx);
      const hi   = Math.max(lastClickedRef.current, idx);
      const next = new Set(selection);
      for (let i = lo; i <= hi; i++) next.add(i);
      setSelection(next);
      return;
    }

    // Plain click — open modal, clear selection
    setSelection(new Set());
    lastClickedRef.current = idx;
    setModalIdx(idx);
  };

  // ── Context menu ─────────────────────────────────────────────────
  const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window;
  const touchIdxRef = useRef<number | null>(null);
  const touchStartTime = useRef(0);

  const handleContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    // On touch devices, the 2s/4s long-press timers handle nav icons and menu.
    // Suppress the browser's early (~500ms) contextmenu to avoid conflict.
    if (isTouchDevice) return;
    const forSelection = hasSelection && selection.has(idx);
    setMenu({
      x: e.clientX, y: e.clientY,
      forSelection,
      singlePhoto: forSelection ? null : visible[idx],
    });
    if (!forSelection) {
      setSelection(new Set());
      lastClickedRef.current = idx;
    }
  };

  // ── Long-press (mobile): 2–4s → nav icons, >4s → context menu ───
  // Hold 2s: nav icons appear and persist after lifting finger.
  // Hold 4s: nav icons hide, context menu appears.
  const clearTimers = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    if (longPressTimer2.current) { clearTimeout(longPressTimer2.current); longPressTimer2.current = null; }
  };

  const handleTouchStart = (idx: number) => (e: React.TouchEvent) => {
    longPressDidFire.current = false;
    touchIdxRef.current = idx;
    touchStartTime.current = Date.now();
    if (mobileNavIdx !== null && mobileNavIdx !== idx) setMobileNavIdx(null);
    const t = e.touches[0];
    longPressPos.current = { x: t.clientX, y: t.clientY };
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      if (!longPressPos.current) return;
      longPressDidFire.current = true;
      setMobileNavIdx(idx);
    }, 2000);
    longPressTimer2.current = setTimeout(() => {
      longPressTimer2.current = null;
      if (!longPressPos.current) return;
      longPressDidFire.current = true;
      setMobileNavIdx(null);
      const { x, y } = longPressPos.current;
      const forSelection = hasSelection && selection.has(idx);
      setMenu({ x, y, forSelection, singlePhoto: forSelection ? null : visible[idx] });
      if (!forSelection) { setSelection(new Set()); lastClickedRef.current = idx; }
    }, 4000);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if ((!longPressTimer.current && !longPressTimer2.current) || !longPressPos.current) return;
    const t = e.touches[0];
    const dx = t.clientX - longPressPos.current.x;
    const dy = t.clientY - longPressPos.current.y;
    if (dx * dx + dy * dy > 64) { clearTimers(); touchIdxRef.current = null; }
  };

  const handleTouchEnd = () => {
    clearTimers();
    // Quick taps are handled by the browser's native click event (handleClick).
    // Touch handlers only manage long-press (2s nav icons, 4s context menu).
    touchIdxRef.current = null;
  };
  const handleTouchCancel = () => { clearTimers(); touchIdxRef.current = null; };

  const selectedPhotos = (): PhotoEntry[] =>
    [...selection].map(i => visible[i]).filter(Boolean);

  const menuItems = (state: MenuState): MenuItem[] => {
    const targets = state.forSelection ? selectedPhotos() : [state.singlePhoto!];
    const comment = !state.forSelection && state.singlePhoto
      ? getComment(state.singlePhoto.hash) : '';
    const items: MenuItem[] = [
      {
        label: '🏷 ' + tr.addTag,
        onClick: () => setAddTagTarget(targets),
      },
    ];
    if (!state.forSelection) {
      items.push({
        label: '💬 ' + (comment ? tr.editComment : tr.addComment),
        onClick: () => setCommentPhoto(state.singlePhoto!),
      });
    }
    if (isOwner) {
      items.push({
        label: '🔒 ' + (state.forSelection ? tr.privateSelected : tr.makePhotoPrivate),
        onClick: () => targets.forEach(p => {
          if (!isPhotoPrivate(p.hash)) togglePhoto(p.hash);
        }),
      });
      items.push({
        label: '🔓 ' + (state.forSelection ? tr.publicSelected : tr.makePhotoPublic),
        onClick: () => targets.forEach(p => {
          if (isPhotoPrivate(p.hash)) togglePhoto(p.hash);
        }),
      });
      items.push({
        label: '🗑 ' + tr.deletePhoto,
        onClick: () => { trashPhotos(targets); setSelection(new Set()); setMenu(null); },
      });
    }
    return items;
  };

  return (
    <div className="photo-grid-wrap">
      {!hideHeader && <div className="grid-header">
        {title && <h3 className="grid-title">{title} <span className="grid-count">· {photos.length}</span></h3>}
        <div className="grid-sort-btns">
          <button
            className={'grid-sort-btn' + (sortOrder === 'oldest' ? ' active' : '')}
            onClick={() => setSortOrder(s => s === 'oldest' ? 'default' : 'oldest')}
          >⬆ Oldest</button>
          <button
            className={'grid-sort-btn' + (sortOrder === 'newest' ? ' active' : '')}
            onClick={() => setSortOrder(s => s === 'newest' ? 'default' : 'newest')}
          >⬇ Newest</button>
        </div>
      </div>}

      {/* ── Selection toolbar ─────────────────────────────── */}
      {hasSelection && (
        <div className="selection-bar">
          <span className="sel-count">{selection.size} {tr.selected}</span>
          <button className="sel-action"
            onClick={() => setAddTagTarget(selectedPhotos())}>
            🏷 {tr.tagSelected}
          </button>
          {isOwner && (
            <>
              <button className="sel-action"
                onClick={() => { selectedPhotos().forEach(p => { if (!isPhotoPrivate(p.hash)) togglePhoto(p.hash); }); }}>
                🔒 {tr.privateSelected}
              </button>
              <button className="sel-action"
                onClick={() => { selectedPhotos().forEach(p => { if (isPhotoPrivate(p.hash)) togglePhoto(p.hash); }); }}>
                🔓 {tr.publicSelected}
              </button>
            </>
          )}
          {isOwner && (
            <button className="sel-action"
              onClick={() => { trashPhotos(selectedPhotos()); setSelection(new Set()); }}>
              🗑 {tr.deletePhoto}
            </button>
          )}
          <button className="sel-clear"
            onClick={() => setSelection(new Set())}>
            ✕ {tr.clearSelection}
          </button>
        </div>
      )}

      {/* ── Photo grid ─────────────────────────────────────── */}
      <div className={'photo-grid' + (hasSelection ? ' has-selection' : '')}>
        {visible.map((p, i) => {
          const photoPath   = p.path ?? p.folder ?? '';
          const locked      = (isPhotoPrivate(p.hash) || albumPrivate) && !isTagAllowed(photoPath);
          const place       = formatPlace(p, placeFallback);
          const description = extractDescription(p.folder, p.city, p.country);
          const dateFmt     = formatDate(p.dt, tr.months);
          const comment     = getComment(p.hash);
          const isSelected  = selection.has(i);

          // ── Cross-tab nav icons ─────────────────────────────────
          const goTimeline = navMode !== 'timeline' ? () => {
            const dt = p.dt ? new Date(p.dt) : null;
            navigate('timeline', {
              hash: p.hash,
              year:  dt?.getFullYear(),
              month: dt ? dt.getMonth() + 1 : undefined,
            });
          } : null;

          const goMap = navMode !== 'map' ? () => {
            // Match system tag against photo path. System tags use Country/City/Album
            // while photo paths use Camera/Continent/Country/Region/City/Album.
            // Check if every segment of the tag name appears in the path in order.
            const pathStr = p.path ?? p.folder ?? '';
            const derivedTag = Object.keys(systemTagIndex.tags).find(name => {
              if (pathStr.includes(name)) return true;
              const tagSegs = name.split('/');
              let searchFrom = 0;
              for (const seg of tagSegs) {
                const idx = pathStr.indexOf(seg, searchFrom);
                if (idx === -1) return false;
                searchFrom = idx + seg.length;
              }
              return true;
            });
            navigate('map', {
              hash:       p.hash,
              tagName:    derivedTag ?? navTagName,
              mapCountry: p.country ?? undefined,
              mapCity:    p.city    ?? undefined,
            });
          } : null;

          const goPath = navMode !== 'path' ? () => {
            navigate('tags', {
              hash:       p.hash,
              // photo.path is the full relative disk path (e.g. "Camera/Europa/...")
              // Derive folder by stripping the filename — this matches path_tags.json display keys.
              folderPath: p.path
                ? p.path.split('/').slice(0, -1).join('/')
                : p.folder
                  ? (p.folder.startsWith('Camera/') ? p.folder : 'Camera/' + p.folder)
                  : undefined,
            });
          } : null;

          return (
            <div
              key={p.hash}
              data-photo-hash={p.hash}
              className={'thumb-cell' + (isSelected ? ' selected' : '')}
              onContextMenu={e => handleContextMenu(e, i)}
              onTouchStart={handleTouchStart(i)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
            >
              <button
                className="thumb-btn"
                onClick={e => handleClick(e, i)}
                title={hasSelection ? undefined : undefined}
              >
                {p.thumb
                  ? <img
                      src={config.cloudFrontUrl + '/' + p.thumb}
                      alt=""
                      loading="lazy"
                      className="thumb-img"
                      style={{ aspectRatio: p.w && p.h ? p.w / p.h : '4/3' }}
                    />
                  : <div className="thumb-placeholder">🎬</div>
                }

                {/* Centered hover overlay — 3 lines: description / city,country / date */}
                {(description || place || dateFmt) && (
                  <div className="thumb-tooltip">
                    {description && <span className="tt-desc">{description}</span>}
                    {place       && <span className="tt-place">{place}</span>}
                    {dateFmt     && <span className="tt-date">{dateFmt}</span>}
                  </div>
                )}

                {/* Selection indicator — shown when any selection is active */}
                <div className={'thumb-select-check' + (isSelected ? ' checked' : '')}>
                  {isSelected && '✓'}
                </div>

                {locked && <div className="thumb-lock-overlay">🔒</div>}
              </button>

              {/* Cross-tab navigation icons — hover on desktop, 2s long-press on mobile */}
              {navMode && (goTimeline || goMap || goPath) && (
                <div
                  className={'thumb-nav-icons' + (mobileNavIdx === i ? ' mobile-visible' : '')}
                  onClick={e => e.stopPropagation()}
                  onTouchStart={e => e.stopPropagation()}
                >
                  {goTimeline && (
                    <button className="thumb-nav-btn" title="Go to Timeline"
                      onClick={() => { setMobileNavIdx(null); goTimeline(); }}
                      onTouchEnd={e => { e.preventDefault(); e.stopPropagation(); setMobileNavIdx(null); goTimeline(); }}
                    >📅</button>
                  )}
                  {goMap && (
                    <button className="thumb-nav-btn" title="Go to Map pin"
                      onClick={() => { setMobileNavIdx(null); goMap(); }}
                      onTouchEnd={e => { e.preventDefault(); e.stopPropagation(); setMobileNavIdx(null); goMap(); }}
                    >📍</button>
                  )}
                  {goPath && (
                    <button className="thumb-nav-btn" title="Go to folder"
                      onClick={() => { setMobileNavIdx(null); goPath(); }}
                      onTouchEnd={e => { e.preventDefault(); e.stopPropagation(); setMobileNavIdx(null); goPath(); }}
                    >📂</button>
                  )}
                </div>
              )}

              <div className="thumb-bottom-right">
                {p.model && (
                  <span
                    className="thumb-cam-badge"
                    title={[p.make, p.model].filter(Boolean).join(' ')}
                  >
                    {shortModel(p.model)}
                  </span>
                )}

                {isOwner && (
                  <button
                    className={'thumb-privacy-btn' + (locked ? ' is-private' : '')}
                    title={locked ? tr.makePhotoPublic : tr.makePhotoPrivate}
                    onClick={e => { e.stopPropagation(); togglePhoto(p.hash); }}
                  >
                    {locked ? '🔒' : '🔓'}
                  </button>
                )}
                {isOwner && (
                  <button
                    className="thumb-debug-btn"
                    title="Copy path"
                    onClick={e => {
                      e.stopPropagation();
                      const text = p.path ?? p.folder ?? p.hash;
                      navigator.clipboard.writeText(text).catch(() => {});
                    }}
                  >📋</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Context menu */}
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Add Tag modal — applies to all targets */}
      {addTagTarget && (
        <AddTagModal
          onAdd={(tagName, shared) => addTagTarget.forEach(p => addPhotoToTag(p, tagName, shared))}
          onClose={() => setAddTagTarget(null)}
        />
      )}

      {/* Comment modal — single photo only */}
      {commentPhoto && (
        <AddCommentModal
          existing={getComment(commentPhoto.hash)}
          existingShared={getCommentShared(commentPhoto.hash)}
          onSave={(text, shared) => setComment(commentPhoto.hash, text, shared)}
          onClose={() => setCommentPhoto(null)}
        />
      )}

      {/* Full-screen modal */}
      {current && (
        <PhotoModal
          photo={current}
          onClose={() => setModalIdx(null)}
          onPrev={modalIdx! > 0                ? () => setModalIdx(modalIdx! - 1) : null}
          onNext={modalIdx! < visible.length - 1 ? () => setModalIdx(modalIdx! + 1) : null}
          onAddTag={p => setAddTagTarget([p])}
          onAddComment={p => setCommentPhoto(p)}
        />
      )}
    </div>
  );
}
