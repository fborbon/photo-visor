import { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Tab, Summary } from './types';
import { displayNameForEmail } from './config';
import { LangProvider, useLang }       from './context/LangContext';
import { PrivacyProvider, usePrivacy } from './context/PrivacyContext';
import { TagsProvider }                from './context/TagsContext';
import { TrashProvider }               from './context/TrashContext';
import { useIndex }     from './hooks/useIndex';
import { useSync }      from './hooks/useSync';
import MapView          from './components/MapView';
import TimelineView     from './components/TimelineView';
import TagsView         from './components/TagsView';
import UploadView       from './components/UploadView';
import LatestView       from './components/LatestView';
import SlotMachineView  from './components/SlotMachineView';
import StatisticsView   from './components/StatisticsView';
import SyncView         from './components/SyncView';
import TrashView        from './components/TrashView';
import DisplayNameModal from './components/DisplayNameModal';

const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;

function nameKey(email: string) {
  return 'pv_name_' + email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

interface InnerProps {
  signOut: () => void;
  email:   string;
}

function AppInner({ signOut, email }: InnerProps) {
  const [tab, setTab] = useState<Tab>('map');
  const [timelineNav, setTimelineNav] = useState<{ year: number; month: number } | null>(null);
  const { lang, toggle, tr } = useLang();
  const { isOwner, makePhotosPrivate, makePhotosPublic } = usePrivacy();
  const { data: summary } = useIndex<Summary>('index/summary.json');
  const { status: syncStatus, lastSync, autoSync, setAutoSync, sync, stopSync, fixing, fixResult, markNonCameraPrivate } = useSync(makePhotosPrivate, makePhotosPublic);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // ── Display name ─────────────────────────────────────────────────
  const fixedName = email ? displayNameForEmail(email) : undefined;
  const isFixed   = !!email && fixedName !== email.split('@')[0];

  const key = nameKey(email);
  const [displayName, setDisplayNameState] = useState(() => isFixed ? fixedName! : (localStorage.getItem(key) ?? ''));
  const [showNameModal, setShowNameModal]   = useState(() => !isFixed && !localStorage.getItem(key));

  // email starts as '' while Amplify hydrates; once the real email resolves,
  // re-check storage so we don't re-ask for a name the user already provided.
  useEffect(() => {
    if (!email) return;
    const fn = displayNameForEmail(email);
    if (fn !== email.split('@')[0]) { setDisplayNameState(fn); setShowNameModal(false); return; }
    const stored = localStorage.getItem(nameKey(email));
    if (stored) {
      setDisplayNameState(stored);
      setShowNameModal(false);
    }
  }, [email]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDisplayName = (name: string) => {
    localStorage.setItem(key, name);
    setDisplayNameState(name);
    setShowNameModal(false);
  };

  // Auto-sync on app resume
  useEffect(() => {
    if (!isOwner) return;
    let removeListener: (() => void) | null = null;

    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
        if (!isActive) return;
        const lastTs  = localStorage.getItem('photo_sync_cursor');
        const elapsed = lastTs ? Date.now() - new Date(lastTs).getTime() : Infinity;
        const shouldAuto = localStorage.getItem('photo_sync_auto') !== 'false';
        if (shouldAuto && elapsed > AUTO_SYNC_INTERVAL_MS) syncRef.current();
      }).then((handle: { remove: () => void }) => {
        removeListener = () => handle.remove();
      });
    });

    return () => { removeListener?.(); };
  }, [isOwner]);

  return (
    <div className="app">

      <header className="topbar">
        <span className="topbar-logo">
          <span style={{ color: '#ff0084' }}>foto</span>visor
        </span>

        <nav className="tab-nav">
          <button className={'tab-btn' + (tab === 'map'      ? ' active' : '')} onClick={() => setTab('map')}>
            🗺 {tr.tabMap}
          </button>
          <button className={'tab-btn' + (tab === 'timeline' ? ' active' : '')} onClick={() => setTab('timeline')}>
            📅 {tr.tabTimeline}
          </button>
          <button className={'tab-btn' + (tab === 'tags'     ? ' active' : '')} onClick={() => setTab('tags')}>
            🏷 {tr.tabTags}
          </button>
          <button className={'tab-btn' + (tab === 'latest'   ? ' active' : '')} onClick={() => setTab('latest')}>
            🆕 {tr.tabLatest}
          </button>
          <button className={'tab-btn' + (tab === 'slots'    ? ' active' : '')} onClick={() => setTab('slots')}>
            🎰 {tr.tabSlots}
          </button>
          <button className={'tab-btn' + (tab === 'stats'  ? ' active' : '')} onClick={() => setTab('stats')}>
            📊 {tr.tabStats}
          </button>
          {isOwner && (
            <button className={'tab-btn' + (tab === 'upload' ? ' active' : '')} onClick={() => setTab('upload')}>
              ⬆️ {tr.tabUpload}
            </button>
          )}
          {isOwner && Capacitor.isNativePlatform() && (
            <button
              className={'tab-btn' + (tab === 'sync' ? ' active' : '') + (syncStatus.phase === 'syncing' || syncStatus.phase === 'enumerating' ? ' tab-btn--syncing' : '')}
              onClick={() => setTab('sync')}
            >
              🔄 {tr.tabSync}
            </button>
          )}
          {isOwner && (
            <button className={'tab-btn' + (tab === 'trash'  ? ' active' : '')} onClick={() => setTab('trash')}>
              🗑 {tr.tabTrash}
            </button>
          )}
        </nav>

        <div className="topbar-right">
          <button className="lang-toggle" onClick={toggle} title="Switch language">
            {lang === 'en' ? '🇪🇸 ES' : '🇬🇧 EN'}
          </button>
          <span className="topbar-user">{displayName || email}</span>
          <button className="signout-btn" onClick={signOut}>{tr.signOut}</button>
        </div>
      </header>

      <main className="main-content">
        <TagsProvider>
          <TrashProvider>
            {tab === 'map'      && <MapView />}
            {tab === 'timeline' && <TimelineView initialYear={timelineNav?.year} initialMonth={timelineNav?.month} />}
            {tab === 'tags'     && <TagsView />}
            {tab === 'latest'   && <LatestView />}
            {tab === 'slots'    && <SlotMachineView />}
            {tab === 'stats'    && <StatisticsView onNavigate={(year, month) => { setTimelineNav({ year, month }); setTab('timeline'); }} />}
            {tab === 'upload'   && <UploadView />}
            {tab === 'trash'    && <TrashView />}
            {tab === 'sync'     && (
              <SyncView
                status={syncStatus}
                lastSync={lastSync}
                autoSync={autoSync}
                setAutoSync={setAutoSync}
                onSyncNow={sync}
                onStopSync={stopSync}
                fixing={fixing}
                fixResult={fixResult}
                onMarkNonCameraPrivate={markNonCameraPrivate}
              />
            )}
          </TrashProvider>
        </TagsProvider>
      </main>

      {summary?.generated && (
        <footer className="app-footer">
          🕐 Last indexed: <strong>{new Date(summary.generated).toLocaleString(lang === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
        </footer>
      )}

      {showNameModal && <DisplayNameModal onSave={saveDisplayName} />}

    </div>
  );
}

function Shell() {
  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => (
        <AppInner
          signOut={signOut ?? (() => {})}
          email={user?.signInDetails?.loginId ?? ''}
        />
      )}
    </Authenticator>
  );
}

export default function App() {
  return (
    <LangProvider>
      <PrivacyProvider>
        <Shell />
      </PrivacyProvider>
    </LangProvider>
  );
}
