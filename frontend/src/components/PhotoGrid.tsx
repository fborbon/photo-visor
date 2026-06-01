import { useState, useRef, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PhotoEntry } from '../types';
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

interface Props {
  photos:         PhotoEntry[];
  albumKey?:      string;
  title?:         string;
  placeFallback?: string;  // shown when photo has no valid city/country
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
  const segs = folder.split('/');
  // Try city first, then country as the geographic anchor
  const geoAnchor = (city && isValidPlace(city) ? city : null)
                 ?? (country && isValidPlace(country) ? country : null);
  if (!geoAnchor) return null;
  const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
  const anchorNorm = norm(geoAnchor);
  let splitIdx = -1;
  for (let i = 0; i < segs.length; i++) {
    const sn = norm(segs[i]);
    if (sn === anchorNorm || sn.startsWith(anchorNorm) || anchorNorm.startsWith(sn)) {
      splitIdx = i;
    }
  }
  if (splitIdx === -1) return null;
  const descSegs = segs.slice(splitIdx + 1).filter(s => s.length > 0);
  return descSegs.length > 0 ? descSegs.join(' / ') : null;
}

function shortModel(model: string): string {
  return model.replace(/^SM-/i, '').replace(/^DMC-/i, '').slice(0, 7);
}

type SortOrder = 'default' | 'oldest' | 'newest';

export default function PhotoGrid({ photos, albumKey, title, placeFallback = '' }: Props) {
  const [modalIdx,     setModalIdx]     = useState<number | null>(null);
  const [selection,    setSelection]    = useState<Set<number>>(new Set());
  const lastClickedRef                  = useRef<number | null>(null);
  const [menu,         setMenu]         = useState<MenuState | null>(null);
  const longPressTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPos     = useRef<{ x: number; y: number } | null>(null);
  const longPressDidFire = useRef(false);
  const [addTagTarget, setAddTagTarget] = useState<PhotoEntry[] | null>(null);
  const [commentPhoto, setCommentPhoto] = useState<PhotoEntry | null>(null);
  const [sortOrder,    setSortOrder]    = useState<SortOrder>('oldest');

  const { isOwner, isPhotoPrivate, isAlbumPrivate, togglePhoto } = usePrivacy();
  const { addPhotoToTag, getComment, setComment, tags, sharedTags, systemTagIndex } = useTags();
  const { trashPhotos, isTrashed } = useTrash();
  const { tr } = useLang();
  const { trackEvent } = useAnalytics();

  const albumPrivate = albumKey ? isAlbumPrivate(albumKey) : false;
  const filtered = photos.filter(p =>
    !isTrashed(p.hash) &&
    (isOwner || (!isPhotoPrivate(p.hash) && !albumPrivate))
  );
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
  const handleContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    // If the right-clicked photo is part of an active selection, act on all selected
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

  // ── Long-press (mobile) ──────────────────────────────────────────
  const handleTouchStart = (idx: number) => (e: React.TouchEvent) => {
    longPressDidFire.current = false;
    const t = e.touches[0];
    longPressPos.current = { x: t.clientX, y: t.clientY };
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      if (!longPressPos.current) return;
      longPressDidFire.current = true;
      const { x, y } = longPressPos.current;
      const forSelection = hasSelection && selection.has(idx);
      setMenu({ x, y, forSelection, singlePhoto: forSelection ? null : visible[idx] });
      if (!forSelection) { setSelection(new Set()); lastClickedRef.current = idx; }
    }, 600);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!longPressTimer.current || !longPressPos.current) return;
    const t = e.touches[0];
    const dx = t.clientX - longPressPos.current.x;
    const dy = t.clientY - longPressPos.current.y;
    if (dx * dx + dy * dy > 64) {   // moved > ~8 px → treat as scroll
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

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
      <div className="grid-header">
        {title && <h3 className="grid-title">{title}</h3>}
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
      </div>

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
          const locked      = isPhotoPrivate(p.hash) || albumPrivate;
          const place       = formatPlace(p, placeFallback);
          const description = extractDescription(p.folder, p.city, p.country);
          const dateFmt     = formatDate(p.dt, tr.months);
          const comment     = getComment(p.hash);
          const isSelected  = selection.has(i);

          return (
            <div
              key={p.hash}
              className={'thumb-cell' + (isSelected ? ' selected' : '')}
              onContextMenu={Capacitor.isNativePlatform() ? undefined : e => handleContextMenu(e, i)}
              onTouchStart={Capacitor.isNativePlatform() ? handleTouchStart(i) : undefined}
              onTouchMove={Capacitor.isNativePlatform() ? handleTouchMove : undefined}
              onTouchEnd={Capacitor.isNativePlatform() ? handleTouchEnd : undefined}
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

              {isOwner && (
                <div className="thumb-bottom-left">
                  <button
                    className="thumb-debug-btn"
                    title="Copy debug info"
                    onClick={e => {
                      e.stopPropagation();
                      const sysTags = Object.keys(systemTagIndex.tags).filter(name =>
                        p.path?.includes(name) || p.folder?.includes(name)
                      );
                      const photoTags = [
                        ...Object.entries(tags).filter(([, v]) => v.photos.some(ph => ph.hash === p.hash)).map(([k]) => k),
                        ...Object.entries(sharedTags).filter(([, v]) => v.photos.some(ph => ph.hash === p.hash)).map(([k]) => k),
                        ...sysTags,
                      ];
                      const location = [p.city, p.country].filter(Boolean).join(', ')
                        || (p.lat != null && p.lng != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'n/a');
                      const text = [
                        `hash: ${p.hash}`,
                        `path: ${p.path ?? 'n/a'}`,
                        `tags: ${photoTags.length ? photoTags.join(', ') : 'none'}`,
                        `location: ${location}`,
                      ].join('\n');
                      navigator.clipboard.writeText(text).catch(() => {});
                    }}
                  >🔍</button>
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
          onSave={text => setComment(commentPhoto.hash, text)}
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
