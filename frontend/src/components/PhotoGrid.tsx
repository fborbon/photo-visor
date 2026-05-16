import { useState, useRef } from 'react';
import { PhotoEntry } from '../types';
import { usePrivacy }      from '../context/PrivacyContext';
import { useTags }         from '../context/TagsContext';
import { useLang }         from '../context/LangContext';
import PhotoModal          from './PhotoModal';
import ContextMenu, { MenuItem } from './ContextMenu';
import AddTagModal         from './AddTagModal';
import AddCommentModal     from './AddCommentModal';
import config from '../config';

interface Props {
  photos:    PhotoEntry[];
  albumKey?: string;
  title?:    string;
}

interface MenuState { x: number; y: number; forSelection: boolean; singlePhoto: PhotoEntry | null; }

function formatDate(dt: string | null, months: readonly string[]): string {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + months[d.getMonth() + 1] + '/' + d.getFullYear();
}

function formatPlace(photo: PhotoEntry): string {
  return [photo.city, photo.country].filter(Boolean).join(', ')
    || photo.folder?.split('/').pop()
    || '';
}

function commentPreview(text: string, max = 38): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export default function PhotoGrid({ photos, albumKey, title }: Props) {
  const [modalIdx,     setModalIdx]     = useState<number | null>(null);
  const [selection,    setSelection]    = useState<Set<number>>(new Set());
  const lastClickedRef                  = useRef<number | null>(null);
  const [menu,         setMenu]         = useState<MenuState | null>(null);
  const [addTagTarget, setAddTagTarget] = useState<PhotoEntry[] | null>(null);
  const [commentPhoto, setCommentPhoto] = useState<PhotoEntry | null>(null);

  const { isOwner, isPhotoPrivate, isAlbumPrivate, togglePhoto } = usePrivacy();
  const { addPhotoToTag, getComment, setComment } = useTags();
  const { tr } = useLang();

  const albumPrivate = albumKey ? isAlbumPrivate(albumKey) : false;
  const visible = photos.filter(p =>
    isOwner || (!isPhotoPrivate(p.hash) && !albumPrivate)
  );

  if (!visible.length) return null;

  const hasSelection = selection.size > 0;
  const current      = modalIdx !== null ? visible[modalIdx] : null;

  // ── Click handler with Shift/Ctrl support ────────────────────────
  const handleClick = (e: React.MouseEvent, idx: number) => {
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
    }
    return items;
  };

  return (
    <div className="photo-grid-wrap">
      {title && <h3 className="grid-title">{title}</h3>}

      {/* ── Selection toolbar ──────────────────────────────── */}
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
          <button className="sel-clear"
            onClick={() => setSelection(new Set())}>
            ✕ {tr.clearSelection}
          </button>
        </div>
      )}

      {/* ── Photo grid ─────────────────────────────────────── */}
      <div className={'photo-grid' + (hasSelection ? ' has-selection' : '')}>
        {visible.map((p, i) => {
          const locked   = isPhotoPrivate(p.hash) || albumPrivate;
          const place    = formatPlace(p);
          const dateFmt  = formatDate(p.dt, tr.months);
          const comment  = getComment(p.hash);
          const isSelected = selection.has(i);

          return (
            <div
              key={p.hash}
              className={'thumb-cell' + (isSelected ? ' selected' : '')}
              onContextMenu={e => handleContextMenu(e, i)}
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

                {/* Centered hover overlay */}
                {(place || dateFmt || comment) && (
                  <div className="thumb-tooltip">
                    {place   && <span className="tt-place">{place}</span>}
                    {dateFmt && <span className="tt-date">{dateFmt}</span>}
                    {comment && <span className="tt-comment">{commentPreview(comment)}</span>}
                  </div>
                )}

                {/* Selection indicator — shown when any selection is active */}
                <div className={'thumb-select-check' + (isSelected ? ' checked' : '')}>
                  {isSelected && '✓'}
                </div>

                {locked && <div className="thumb-lock-overlay">🔒</div>}
              </button>

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
