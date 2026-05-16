import { useState, useEffect, useRef } from 'react';
import { useLang } from '../context/LangContext';
import { useTags } from '../context/TagsContext';

interface Props {
  onAdd:   (tagName: string, shared: boolean) => void;
  onClose: () => void;
}

export default function AddTagModal({ onAdd, onClose }: Props) {
  const { tr }       = useLang();
  const { tagNames, sharedTagNames } = useTags();
  const [value,    setValue]    = useState('');
  const [isShared, setIsShared] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const submit = (name: string, shared: boolean) => {
    const clean = name.trim();
    if (clean) { onAdd(clean, shared); onClose(); }
  };

  // Determine if an existing tag is shared or private
  const existingShared = (name: string) => sharedTagNames.includes(name);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-tag-modal" onClick={e => e.stopPropagation()}>
        <h3 className="add-tag-title">🏷 {tr.addTag}</h3>

        <div className="add-tag-input-row">
          <input
            ref={inputRef}
            className="add-tag-input"
            placeholder={tr.tagName}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit(value, isShared)}
          />
          <button
            className="add-tag-create-btn"
            onClick={() => submit(value, isShared)}
            disabled={!value.trim()}
          >
            {tr.createTag}
          </button>
        </div>

        {/* Share toggle — only shown for new tag names */}
        <label className="tag-share-label">
          <input
            type="checkbox"
            checked={isShared}
            onChange={e => setIsShared(e.target.checked)}
          />
          <span>👨‍👩‍👧 {tr.shareTag}</span>
          <span className="tag-share-hint">
            {isShared ? tr.sharedTag : tr.privateTag}
          </span>
        </label>

        {(tagNames.length > 0 || sharedTagNames.length > 0) && (
          <>
            <p className="add-tag-or">{tr.orSelectExisting}</p>
            <div className="add-tag-existing">
              {tagNames.map(t => (
                <button key={'p:' + t} className="existing-tag-btn" onClick={() => submit(t, false)}>
                  🔒 {t}
                </button>
              ))}
              {sharedTagNames.map(t => (
                <button key={'s:' + t} className="existing-tag-btn shared" onClick={() => submit(t, true)}>
                  👨‍👩‍👧 {t}
                </button>
              ))}
            </div>
          </>
        )}

        <button className="add-tag-cancel" onClick={onClose}>{tr.cancel}</button>
      </div>
    </div>
  );
}
