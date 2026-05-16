import { useEffect, useState } from 'react';
import { PhotoEntry } from '../types';
import { useLang }    from '../context/LangContext';
import { useTags }    from '../context/TagsContext';
import ContextMenu    from './ContextMenu';
import config from '../config';

interface Props {
  photo:       PhotoEntry;
  onClose:     () => void;
  onPrev:      (() => void) | null;
  onNext:      (() => void) | null;
  onAddTag:    (photo: PhotoEntry) => void;
  onAddComment:(photo: PhotoEntry) => void;
}

export default function PhotoModal({ photo, onClose, onPrev, onNext, onAddTag, onAddComment }: Props) {
  const { tr }         = useLang();
  const { getComment } = useTags();
  const [fullLoaded, setFullLoaded] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => { setFullLoaded(false); }, [photo.hash]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape')               onClose();
      if (e.key === 'ArrowLeft'  && onPrev) onPrev();
      if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onPrev, onNext]);

  const thumbUrl = photo.thumb  ? config.cloudFrontUrl + '/' + photo.thumb  : null;
  const fullUrl  = photo.s3_key ? config.cloudFrontUrl + '/' + photo.s3_key : thumbUrl;

  const date = photo.dt ? (() => {
    const d = new Date(photo.dt!);
    return String(d.getDate()).padStart(2, '0') + '/' + tr.months[d.getMonth() + 1] + '/' + d.getFullYear();
  })() : null;

  const place   = [photo.city, photo.country].filter(Boolean).join(', ')
    || photo.folder?.split('/').pop() || null;
  const comment = getComment(photo.hash);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>

        <button className="modal-close" onClick={onClose}>✕</button>
        {onPrev && <button className="modal-prev" onClick={onPrev}>‹</button>}
        {onNext && <button className="modal-next" onClick={onNext}>›</button>}

        <div
          className="modal-image-wrap"
          onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        >
          {thumbUrl && !fullLoaded && (
            <img className="modal-img modal-thumb-bg" src={thumbUrl} alt="" aria-hidden />
          )}
          {fullUrl && (
            <img
              className="modal-img"
              src={fullUrl}
              alt={date || 'photo'}
              onLoad={() => setFullLoaded(true)}
              style={{ opacity: fullLoaded ? 1 : 0, transition: 'opacity .3s' }}
            />
          )}
          {!fullLoaded && <div className="modal-spinner">{tr.loading}</div>}
        </div>

        {/* Metadata + comment below the image */}
        <div className="modal-footer">
          {(place || date) && (
            <div className="modal-meta">
              {place && <span className="modal-place">📍 {place}</span>}
              {date  && <span className="modal-date">{date}</span>}
            </div>
          )}
          {comment && (
            <div className="modal-comment">💬 {comment}</div>
          )}
        </div>

      </div>

      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          items={[
            { label: '🏷 ' + tr.addTag,
              onClick: () => onAddTag(photo) },
            { label: '💬 ' + (comment ? tr.editComment : tr.addComment),
              onClick: () => onAddComment(photo) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
