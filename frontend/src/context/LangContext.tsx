import { createContext, useContext, useState, ReactNode } from 'react';
import t, { Lang } from '../i18n/translations';

interface LangCtx {
  lang:   Lang;
  toggle: () => void;
  tr:     typeof t['en'];
}

const LangContext = createContext<LangCtx>({
  lang:   'en',
  toggle: () => {},
  tr:     t.en,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const IS_DEMO = (import.meta.env.VITE_DEMO as string | undefined) === 'true';
  const stored = (localStorage.getItem('lang') as Lang | null) ?? (IS_DEMO ? 'en' : 'es');
  const [lang, setLang] = useState<Lang>(stored);

  const toggle = () => {
    const next: Lang = lang === 'en' ? 'es' : 'en';
    setLang(next);
    localStorage.setItem('lang', next);
  };

  return (
    <LangContext.Provider value={{ lang, toggle, tr: t[lang] as typeof t['en'] }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
