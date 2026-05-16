import { useEffect, useRef } from 'react';

export interface MenuItem {
  label:   string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  x:       number;
  y:       number;
  items:   MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if ('key' in e && e.key !== 'Escape') return;
      if ('key' in e || !ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown',   close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown',   close);
    };
  }, [onClose]);

  // Keep menu inside viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    top:      Math.min(y, window.innerHeight - 120),
    left:     Math.min(x, window.innerWidth  - 200),
  };

  return (
    <div ref={ref} className="ctx-menu" style={style}>
      {items.map(item => (
        <button
          key={item.label}
          className={'ctx-item' + (item.danger ? ' danger' : '')}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
