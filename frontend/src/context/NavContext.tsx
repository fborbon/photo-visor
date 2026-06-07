import { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { Tab } from '../types';

export interface PendingNav {
  hash:        string;      // photo to scroll to + highlight
  year?:       number;      // Timeline: target year
  month?:      number;      // Timeline: target month
  folderPath?: string;      // PathTags: folder to open (disk path)
  tagName?:    string;      // Map: full sysTag name → identify the right pin
  mapCountry?: string;      // Map fallback: photo.country (English, e.g. "Spain")
  mapCity?:    string;      // Map fallback: photo.city   (e.g. "Pamplona")
}

interface NavCtxType {
  pendingNav: PendingNav | null;
  clearNav:   () => void;
  navigate:   (tab: Tab, nav: PendingNav) => void;
}

const NavCtx = createContext<NavCtxType>({
  pendingNav: null,
  clearNav:   () => {},
  navigate:   () => {},
});

/** Poll for [data-photo-hash] until found (max ~6 s), then scroll + flash. */
export function scrollToHash(
  hash: string,
  container?: HTMLElement | null,
  onFound?: () => void,
) {
  let attempts = 0;
  const MAX = 20;
  const tryScroll = () => {
    const root = container ?? document;
    const el   = root.querySelector<HTMLElement>(`[data-photo-hash="${hash}"]`);
    if (el) {
      if (container) {
        // Compute absolute offset of element from container top using the
        // offsetParent chain (reliable regardless of sticky headers / transforms).
        let absoluteTop = 0;
        let cur: HTMLElement | null = el;
        while (cur && cur !== container) {
          absoluteTop += cur.offsetTop;
          cur = cur.offsetParent as HTMLElement | null;
        }
        // Place the photo at 25% from the visible top so that most of the
        // panel shows photos below the highlighted one.
        const targetScrollTop = absoluteTop - container.clientHeight * 0.25;
        container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      el.classList.add('photo-nav-highlight');
      setTimeout(() => el.classList.remove('photo-nav-highlight'), 5000);
      onFound?.();
    } else if (++attempts < MAX) {
      setTimeout(tryScroll, 300);
    }
  };
  setTimeout(tryScroll, 100);
}

export function useNav() { return useContext(NavCtx); }

export function NavProvider({
  children,
  setTab,
}: {
  children: ReactNode;
  setTab:   (t: Tab) => void;
}) {
  const [pendingNav, setPendingNav] = useState<PendingNav | null>(null);

  function clearNav() { setPendingNav(null); }

  function navigate(tab: Tab, nav: PendingNav) {
    setPendingNav(nav);
    setTab(tab);
  }

  return (
    <NavCtx.Provider value={{ pendingNav, clearNav, navigate }}>
      {children}
    </NavCtx.Provider>
  );
}
