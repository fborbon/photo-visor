import { useState, useEffect, useRef, useCallback } from 'react';
import { useLang }    from '../context/LangContext';
import { useTags }    from '../context/TagsContext';
import { useIndex }   from '../hooks/useIndex';
import { Summary, PhotoEntry } from '../types';
import PhotoModal     from './PhotoModal';
import AddTagModal    from './AddTagModal';
import AddCommentModal from './AddCommentModal';
import config         from '../config';

const SLOT_COUNT   = 10;
const SPIN_MS      = 100;   // interval between photo changes while spinning
const SPIN_DELAY   = 200;   // ms before first slot stops
const STOP_STAGGER = 320;   // ms between each successive slot stop

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

export default function SlotMachineView() {
  const { tr }   = useLang();
  const tagsCtx  = useTags();
  const { data: summary } = useIndex<Summary>('index/summary.json');

  // ── Photo pool ─────────────────────────────────────────────────────
  const poolRef      = useRef<PhotoEntry[]>([]);
  const loadedYears  = useRef<Set<number>>(new Set());

  const fetchYear = useCallback(async (year: number) => {
    if (loadedYears.current.has(year)) return;
    loadedYears.current.add(year);
    try {
      const r = await fetch(config.cloudFrontUrl + '/index/time/' + year + '.json');
      if (!r.ok) return;
      const photos = await r.json() as PhotoEntry[];
      const withThumb = photos.filter(p => p.thumb);
      poolRef.current = [...poolRef.current, ...withThumb];
      setPoolSize(poolRef.current.length);
    } catch { /* ignore */ }
  }, []);

  const [poolSize, setPoolSize] = useState(0);  // drives re-render when pool grows

  // Load 3 random years on mount
  useEffect(() => {
    if (!summary?.years?.length) return;
    const shuffled = [...summary.years].sort(() => Math.random() - 0.5);
    shuffled.slice(0, 3).forEach(y => fetchYear(y));
  }, [summary, fetchYear]);

  // ── Slot state ─────────────────────────────────────────────────────
  const [photos,   setPhotos]   = useState<(PhotoEntry | null)[]>(Array(SLOT_COUNT).fill(null));
  const spinningRef             = useRef<boolean[]>(Array(SLOT_COUNT).fill(false));
  const [spinMask, setSpinMask] = useState<boolean[]>(Array(SLOT_COUNT).fill(false));
  const [flashMask,setFlashMask]= useState<boolean[]>(Array(SLOT_COUNT).fill(false));
  const intervalRef             = useRef<ReturnType<typeof setInterval> | null>(null);

  const isSpinning = spinMask.some(Boolean);
  const ready      = poolSize >= SLOT_COUNT;

  // ── Modal / tag / comment state ────────────────────────────────────
  const [modalIdx,     setModalIdx]     = useState<number | null>(null);
  const [addTagPhoto,  setAddTagPhoto]  = useState<PhotoEntry | null>(null);
  const [commentPhoto, setCommentPhoto] = useState<PhotoEntry | null>(null);

  const landed = photos.filter(Boolean) as PhotoEntry[];

  // ── Spin handler ───────────────────────────────────────────────────
  function handleSpin() {
    const pool = poolRef.current;
    if (pool.length < SLOT_COUNT || isSpinning) return;

    // Pick final photos upfront
    const finals = Array.from({ length: SLOT_COUNT }, () => pick(pool));

    // Start spinning
    const allTrue = Array(SLOT_COUNT).fill(true);
    spinningRef.current = [...allTrue];
    setSpinMask([...allTrue]);
    setFlashMask(Array(SLOT_COUNT).fill(false));

    // Rapid cycling interval
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const p = poolRef.current;
      setPhotos(prev => prev.map((ph, i) =>
        spinningRef.current[i] ? pick(p) : ph
      ));
    }, SPIN_MS);

    // Stagger-stop each slot
    for (let i = 0; i < SLOT_COUNT; i++) {
      setTimeout(() => {
        spinningRef.current[i] = false;
        setSpinMask(m => { const n = [...m]; n[i] = false; return n; });
        setPhotos(p  => { const n = [...p]; n[i] = finals[i]; return n; });
        setFlashMask(f => { const n = [...f]; n[i] = true; return n; });
        setTimeout(() =>
          setFlashMask(f => { const n = [...f]; n[i] = false; return n; }), 450);

        if (i === SLOT_COUNT - 1 && intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      }, SPIN_DELAY + i * STOP_STAGGER);
    }

    // Opportunistically load another year for variety
    if (summary?.years) {
      const unloaded = summary.years.filter(y => !loadedYears.current.has(y));
      if (unloaded.length) fetchYear(pick(unloaded));
    }
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="slots-layout">
      <div className="slots-machine">

        {/* Decorative header */}
        <div className="slots-title">🎰 {tr.tabSlots}</div>

        {/* Slot grid */}
        <div className="slots-grid">
          {photos.map((photo, i) => (
            <div
              key={i}
              className={
                'slot-reel' +
                (spinMask[i]               ? ' spinning'  : '') +
                (flashMask[i]              ? ' landed'    : '') +
                (photo && !spinMask[i]     ? ' clickable' : '')
              }
              onClick={() => {
                if (!photo || spinMask[i]) return;
                const idx = landed.indexOf(photo);
                if (idx >= 0) setModalIdx(idx);
              }}
            >
              {photo ? (
                <img
                  key={photo.hash + i}   /* key forces img re-mount for animation */
                  className="slot-img"
                  src={config.cloudFrontUrl + '/' + photo.thumb}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="slot-empty">🎰</div>
              )}
            </div>
          ))}
        </div>

        {/* Lever */}
        <div className="slots-lever-row">
          {!ready && <p className="slots-hint">{tr.loading}</p>}
          {ready && (
            <button
              className={'slots-lever' + (isSpinning ? ' spinning' : '')}
              onClick={handleSpin}
              disabled={isSpinning}
            >
              {isSpinning ? tr.slotSpinning : tr.slotSpin}
            </button>
          )}
        </div>

        {ready && !isSpinning && landed.length === 0 && (
          <p className="slots-hint">{tr.slotHint}</p>
        )}
      </div>

      {/* Photo modal */}
      {modalIdx !== null && landed[modalIdx] && (
        <PhotoModal
          photo={landed[modalIdx]}
          onClose={() => setModalIdx(null)}
          onPrev={modalIdx > 0 ? () => setModalIdx(i => i! - 1) : null}
          onNext={modalIdx < landed.length - 1 ? () => setModalIdx(i => i! + 1) : null}
          onAddTag={p => setAddTagPhoto(p)}
          onAddComment={p => setCommentPhoto(p)}
        />
      )}

      {addTagPhoto && (
        <AddTagModal
          onAdd={(tagName, shared) => {
            tagsCtx.addPhotoToTag(addTagPhoto, tagName, shared);
            setAddTagPhoto(null);
          }}
          onClose={() => setAddTagPhoto(null)}
        />
      )}

      {commentPhoto && (
        <AddCommentModal
          existing={tagsCtx.getComment(commentPhoto.hash)}
          onSave={text => { tagsCtx.setComment(commentPhoto.hash, text); setCommentPhoto(null); }}
          onClose={() => setCommentPhoto(null)}
        />
      )}
    </div>
  );
}
