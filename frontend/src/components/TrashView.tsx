import { useState } from 'react';
import { useLang }  from '../context/LangContext';
import { useTrash } from '../context/TrashContext';
import { PhotoEntry } from '../types';
import config from '../config';

export default function TrashView() {
  const { tr } = useLang();
  const { trashedPhotos, restorePhotos, deleteForever } = useTrash();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const allSelected = trashedPhotos.length > 0 && selected.size === trashedPhotos.length;

  const toggleOne = (hash: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(hash) ? next.delete(hash) : next.add(hash);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected
      ? new Set()
      : new Set(trashedPhotos.map(p => p.hash))
    );
  };

  const handleRestore = async () => {
    await restorePhotos([...selected]);
    setSelected(new Set());
  };

  const handleDeleteForever = async () => {
    const toDelete = trashedPhotos.filter(p => selected.has(p.hash));
    await deleteForever(toDelete);
    setSelected(new Set());
    setConfirmDelete(false);
  };

  if (trashedPhotos.length === 0) {
    return (
      <div className="trash-empty">
        <span>🗑</span>
        <p>{tr.trashEmpty}</p>
      </div>
    );
  }

  return (
    <div className="trash-view">
      <div className="trash-toolbar">
        <label className="trash-select-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          {tr.trashSelectAll}
        </label>
        <span className="trash-count">{selected.size} / {trashedPhotos.length}</span>
        <button
          className="trash-btn restore"
          disabled={selected.size === 0}
          onClick={handleRestore}
        >
          ♻️ {tr.trashRestore}
        </button>
        <button
          className="trash-btn delete-forever"
          disabled={selected.size === 0}
          onClick={() => setConfirmDelete(true)}
        >
          🗑 {tr.trashDeleteForever}
        </button>
      </div>

      <div className="trash-grid">
        {trashedPhotos.map((photo: PhotoEntry) => {
          const isSelected = selected.has(photo.hash);
          return (
            <div
              key={photo.hash}
              className={'trash-cell' + (isSelected ? ' selected' : '')}
              onClick={() => toggleOne(photo.hash)}
            >
              {photo.thumb
                ? <img
                    src={config.cloudFrontUrl + '/' + photo.thumb}
                    alt=""
                    loading="lazy"
                    className="trash-img"
                    style={{ aspectRatio: photo.w && photo.h ? photo.w / photo.h : '4/3' }}
                  />
                : <div className="thumb-placeholder">🎬</div>
              }
              <div className={'trash-check' + (isSelected ? ' checked' : '')}>
                {isSelected ? '✓' : ''}
              </div>
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <p>🗑 Delete {selected.size} photo{selected.size !== 1 ? 's' : ''} permanently from S3? This cannot be undone.</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setConfirmDelete(false)}>
                {tr.cancel}
              </button>
              <button className="confirm-delete" onClick={handleDeleteForever}>
                {tr.trashDeleteForever}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
