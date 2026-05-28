import { useState } from 'react';
import { useLang } from '../context/LangContext';

interface Props {
  onSave: (name: string) => void;
}

export default function DisplayNameModal({ onSave }: Props) {
  const { tr } = useLang();
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) onSave(trimmed);
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 9999 }}>
      <div className="display-name-modal">
        <div className="display-name-icon">👋</div>
        <h2 className="display-name-title">{tr.welcomeTitle}</h2>
        <p className="display-name-hint">{tr.welcomeHint}</p>
        <form onSubmit={handleSubmit}>
          <input
            className="display-name-input"
            type="text"
            placeholder={tr.yourNamePlaceholder}
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
            maxLength={40}
          />
          <button
            className="display-name-save"
            type="submit"
            disabled={!name.trim()}
          >
            {tr.continueBtn}
          </button>
        </form>
      </div>
    </div>
  );
}
