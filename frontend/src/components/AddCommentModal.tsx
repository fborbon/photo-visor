import { useState, useEffect, useRef } from 'react';
import { useLang } from '../context/LangContext';

interface Props {
  existing: string;
  existingShared: boolean;
  onSave:   (text: string, shared: boolean) => void;
  onClose:  () => void;
}

export default function AddCommentModal({ existing, existingShared, onSave, onClose }: Props) {
  const { tr } = useLang();
  const [value, setValue] = useState(existing);
  const [isShared, setIsShared] = useState(existing ? existingShared : true);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const save = () => { onSave(value, isShared); onClose(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-comment-modal" onClick={e => e.stopPropagation()}>
        <h3 className="add-tag-title">💬 {existing ? tr.editComment : tr.addComment}</h3>

        <textarea
          ref={ref}
          className="comment-textarea"
          placeholder={tr.commentPlaceholder}
          value={value}
          onChange={e => setValue(e.target.value)}
          rows={4}
        />

        <label className="tag-share-label">
          <input
            type="checkbox"
            checked={isShared}
            onChange={e => setIsShared(e.target.checked)}
          />
          <span>👨‍👩‍👧 {tr.shareComment}</span>
          <span className="tag-share-hint">
            {isShared ? tr.sharedTag : tr.privateTag}
          </span>
        </label>

        <div className="comment-modal-actions">
          <button className="add-tag-cancel" onClick={onClose}>{tr.cancel}</button>
          <button className="add-tag-create-btn" onClick={save}>{tr.saveComment}</button>
        </div>
      </div>
    </div>
  );
}
