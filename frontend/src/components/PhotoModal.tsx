import { useEffect, useState, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { PhotoEntry } from '../types';
import { useLang }    from '../context/LangContext';
import { useTags }    from '../context/TagsContext';
import config from '../config';

const heicCache = new Map<string, string>();

async function decodeHeic(url: string): Promise<string> {
  if (heicCache.has(url)) return heicCache.get(url)!;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();
  const heic2any = (await import('heic2any')).default;
  const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.88 });
  const jpegBlob = Array.isArray(result) ? result[0] : result;
  const objectUrl = URL.createObjectURL(jpegBlob);
  heicCache.set(url, objectUrl);
  return objectUrl;
}

const VIDEO_EXTS = /\.(mp4|mov|avi|3gp|wmv|mp3|mpg|vob)$/i;

/** Fire-and-forget preload for the previous/next photo. */
export function preloadPhoto(photo: PhotoEntry) {
  if (!photo.s3_key || VIDEO_EXTS.test(photo.s3_key)) return;
  const url    = config.cloudFrontUrl + '/' + photo.s3_key;
  const isHeic = /\.(heic|heif)$/i.test(photo.s3_key);
  if (isHeic) {
    if (!heicCache.has(url)) decodeHeic(url).catch(() => { /* pre-warm only */ });
  } else {
    // Warm the browser cache; if already cached the browser ignores it.
    const img = new Image();
    img.src = url;
  }
}

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
  const isNative = Capacitor.isNativePlatform();

  const [fullLoaded,   setFullLoaded]   = useState(false);
  const [decoding,     setDecoding]     = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [displayUrl,   setDisplayUrl]   = useState<string | null>(null);
  const [isMuted,      setIsMuted]      = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isVideo = VIDEO_EXTS.test(photo.s3_key ?? '');

  // React's `muted` prop is broken for <video> — must set via DOM ref.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = isMuted;
  }, [isMuted]);

  const thumbUrl = photo.thumb  ? config.cloudFrontUrl + '/' + photo.thumb  : null;
  const isHeic   = /\.(heic|heif)$/i.test(photo.s3_key ?? '');
  const rawUrl   = photo.s3_key ? config.cloudFrontUrl + '/' + photo.s3_key : null;

  // ── Zoom / pan state (all via refs for use inside event handlers) ──
  const scaleRef   = useRef(1);
  const txRef      = useRef(0);
  const tyRef      = useRef(0);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const wrapRef    = useRef<HTMLDivElement>(null);
  const touchRef   = useRef<{
    dist: number; panX: number; panY: number;
    txStart: number; tyStart: number;
  } | null>(null);
  const gestured = useRef(false);

  const applyTransform = useCallback((scale: number, x: number, y: number) => {
    const s  = Math.min(5, Math.max(1, scale));
    const tx = s <= 1 ? 0 : x;
    const ty = s <= 1 ? 0 : y;
    scaleRef.current = s;
    txRef.current    = tx;
    tyRef.current    = ty;
    setTransform({ scale: s, x: tx, y: ty });
  }, []);

  // Reset zoom + image on photo change
  useEffect(() => {
    scaleRef.current = 1; txRef.current = 0; tyRef.current = 0;
    setTransform({ scale: 1, x: 0, y: 0 });
    setFullLoaded(false);
    setDecoding(false);
    setDecodeFailed(false);
    if (isVideo) {
      setDisplayUrl(rawUrl);
      return;
    }
    if (isHeic) {
      setDisplayUrl(thumbUrl);
      setDecoding(true);
      decodeHeic(rawUrl ?? '').then(url => {
        setDisplayUrl(url);
      }).catch(() => {
        setDecodeFailed(true);
        setDisplayUrl(thumbUrl);
      }).finally(() => setDecoding(false));
    } else {
      setDisplayUrl(rawUrl ?? thumbUrl);
    }
  }, [photo.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape')               onClose();
      if (e.key === 'ArrowLeft'  && onPrev) onPrev();
      if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onPrev, onNext]);

  // Scroll-to-zoom (desktop)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      applyTransform(scaleRef.current * factor, txRef.current, tyRef.current);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyTransform]);

  // Pinch-to-zoom + pan (mobile)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      gestured.current = false;
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchRef.current = {
          dist:    Math.sqrt(dx * dx + dy * dy),
          panX:    0, panY: 0,
          txStart: txRef.current,
          tyStart: tyRef.current,
        };
      } else if (e.touches.length === 1 && scaleRef.current > 1) {
        touchRef.current = {
          dist:    0,
          panX:    e.touches[0].clientX,
          panY:    e.touches[0].clientY,
          txStart: txRef.current,
          tyStart: tyRef.current,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touchRef.current) return;
      gestured.current = true;
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx   = e.touches[0].clientX - e.touches[1].clientX;
        const dy   = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ratio = dist / touchRef.current.dist;
        touchRef.current.dist = dist;
        applyTransform(scaleRef.current * ratio, txRef.current, tyRef.current);
      } else if (e.touches.length === 1 && scaleRef.current > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - touchRef.current.panX;
        const dy = e.touches[0].clientY - touchRef.current.panY;
        applyTransform(
          scaleRef.current,
          touchRef.current.txStart + dx,
          touchRef.current.tyStart + dy,
        );
      }
    };

    const onTouchEnd = () => { touchRef.current = null; };

    // Mouse drag to pan (desktop)
    const onMouseDown = (e: MouseEvent) => {
      if (scaleRef.current <= 1) return;
      e.preventDefault();
      const startX  = e.clientX;
      const startY  = e.clientY;
      const startTx = txRef.current;
      const startTy = tyRef.current;
      let moved = false;
      document.body.style.cursor = 'grabbing';

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        applyTransform(scaleRef.current, startTx + dx, startTy + dy);
      };
      const onUp = () => {
        document.body.style.cursor = '';
        if (moved) gestured.current = true;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove',  onTouchMove,  { passive: false });
    el.addEventListener('touchend',   onTouchEnd);
    el.addEventListener('mousedown',  onMouseDown);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchend',   onTouchEnd);
      el.removeEventListener('mousedown',  onMouseDown);
    };
  }, [applyTransform]);

  const loadFullRes = useCallback(async () => {
    if (!rawUrl || !isHeic || decoding) return;
    setDecoding(true);
    setDecodeFailed(false);
    setFullLoaded(false);
    try {
      const url = await decodeHeic(rawUrl);
      setDisplayUrl(url);
    } catch {
      setDecodeFailed(true);
    } finally {
      setDecoding(false);
    }
  }, [rawUrl, isHeic, decoding]);

  const handleOverlayClick = useCallback(() => {
    if (gestured.current) { gestured.current = false; return; }
    if (scaleRef.current > 1) {
      applyTransform(1, 0, 0);
    } else {
      onClose();
    }
  }, [applyTransform, onClose]);

  const date = photo.dt ? (() => {
    const d = new Date(photo.dt!);
    return String(d.getDate()).padStart(2, '0') + '/' + tr.months[d.getMonth() + 1] + '/' + d.getFullYear();
  })() : null;

  const place   = [photo.city, photo.country].filter(Boolean).join(', ')
    || photo.folder?.split('/').pop() || null;
  const comment = getComment(photo.hash);

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>

        <button className="modal-close" onClick={onClose}>✕</button>
        {onPrev && <button className="modal-prev" onClick={onPrev}>‹</button>}
        {onNext && <button className="modal-next" onClick={onNext}>›</button>}

        <div className="modal-image-wrap" ref={wrapRef}>
          {isVideo && rawUrl ? (
            <>
              <video
                ref={el => {
                  videoRef.current = el;
                  if (el) el.muted = isMuted;
                }}
                className="modal-video"
                src={photo.video_proxy ? config.cloudFrontUrl + '/' + photo.video_proxy : rawUrl}
                controls
                autoPlay
                onLoadedData={() => setFullLoaded(true)}
                onError={() => setFullLoaded(true)}
                style={{ opacity: fullLoaded ? 1 : 0, transition: fullLoaded ? 'opacity .3s' : 'none' }}
              />
              <button
                className="modal-mute-btn"
                onClick={() => setIsMuted(m => !m)}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? '🔇' : '🔊'}
              </button>
            </>
          ) : displayUrl ? (
            <img
              className="modal-img"
              src={displayUrl}
              alt={date || 'photo'}
              onLoad={() => setFullLoaded(true)}
              onError={() => setFullLoaded(true)}
              style={{
                opacity:         fullLoaded ? 1 : 0,
                transition:      fullLoaded ? 'opacity .3s' : 'none',
                transform:       `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                transformOrigin: 'center center',
                cursor:          transform.scale > 1 ? 'grab' : 'default',
                userSelect:      'none',
              }}
            />
          ) : null}
          {!fullLoaded && (
            <div className="modal-spinner">
              {decoding ? '🔄 Decoding…' : tr.loading}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {isHeic && (isNative || decodeFailed) && !decoding && !heicCache.has(rawUrl ?? '') && (
            <button className="modal-hd-btn" onClick={loadFullRes}>
              {decodeFailed ? '🔄 Retry full resolution' : '🔍 Load full resolution'}
            </button>
          )}
          {(place || date) && (
            <div className="modal-meta">
              {place && <span className="modal-place">{place}</span>}
              {date  && <span className="modal-date">{date}</span>}
            </div>
          )}
          {comment && (
            <div className="modal-comment">💬 {comment}</div>
          )}
        </div>

      </div>
    </div>
  );
}
