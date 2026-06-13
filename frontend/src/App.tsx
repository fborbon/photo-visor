import { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Tab, Summary } from './types';
import { displayNameForEmail, isFemaleEmail } from './config';
import { LangProvider, useLang }       from './context/LangContext';
import { PrivacyProvider, usePrivacy } from './context/PrivacyContext';
import { TagsProvider }                from './context/TagsContext';
import { TrashProvider }               from './context/TrashContext';
import { AnalyticsProvider, useAnalytics } from './context/AnalyticsContext';
import { useIndex }     from './hooks/useIndex';
import { useSync }      from './hooks/useSync';
import { NavProvider, DeepLinkHandler } from './context/NavContext';
import { FavoritesProvider } from './context/FavoritesContext';
import MapView          from './components/MapView';
import TimelineView     from './components/TimelineView';
import TagsView         from './components/TagsView';
import LatestView       from './components/LatestView';
import SlotMachineView  from './components/SlotMachineView';
import StatisticsView   from './components/StatisticsView';
import SyncView         from './components/SyncView';
import TrashView        from './components/TrashView';
import UsageView        from './components/UsageView';
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;

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
  const { status: syncStatus, lastSync, autoSync, setAutoSync, sync, syncDesktop, loadAlbums, stopSync, fixing, fixResult, markNonCameraPrivate } = useSync(makePhotosPrivate, makePhotosPublic);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const { trackEvent } = useAnalytics();

  // ── Display name ─────────────────────────────────────────────────
  const [displayName, setDisplayNameState] = useState(() => displayNameForEmail(email));
  const welcomeWord = isFemaleEmail(email) ? tr.welcomeFemale : tr.welcome;

  useEffect(() => {
    if (email) setDisplayNameState(displayNameForEmail(email));
  }, [email]);

  // Track tab switches
  useEffect(() => { trackEvent('nav_tab', { tab }); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

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

        {displayName && (
          <span className="topbar-welcome">{welcomeWord} {displayName}!</span>
        )}

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
          {isOwner && (
            <button className={'tab-btn' + (tab === 'usage'  ? ' active' : '')} onClick={() => setTab('usage')}>
              📈 {tr.tabUsage}
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
        <NavProvider setTab={setTab}>
        <DeepLinkHandler />
        <FavoritesProvider>
        <TagsProvider>
          <TrashProvider>
            {tab === 'map'      && <MapView displayName={displayName ? `${welcomeWord} ${displayName}!` : undefined} />}
            {tab === 'timeline' && <TimelineView initialYear={timelineNav?.year} initialMonth={timelineNav?.month} />}
            {tab === 'tags'     && <TagsView />}
            {tab === 'latest'   && <LatestView />}
            {tab === 'slots'    && <SlotMachineView />}
            {tab === 'stats'    && <StatisticsView onNavigate={(year, month) => { setTimelineNav({ year, month }); setTab('timeline'); }} />}
{tab === 'trash'    && <TrashView />}
            {tab === 'usage'    && isOwner && <UsageView />}
            {tab === 'sync'     && (
              <SyncView
                status={syncStatus}
                lastSync={lastSync}
                onSyncNow={sync}
                onSyncDesktop={syncDesktop}
                onStopSync={stopSync}
                onLoadAlbums={loadAlbums}
                isNative={Capacitor.isNativePlatform()}
              />
            )}
          </TrashProvider>
        </TagsProvider>
        </FavoritesProvider>
        </NavProvider>
      </main>

      {summary?.generated && (
        <footer className="app-footer">
          🕐 Last indexed: <strong>{new Date(summary.generated).toLocaleString(lang === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
        </footer>
      )}


    </div>
  );
}

function Shell() {
  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => {
        const email = user?.signInDetails?.loginId ?? '';
        return (
          <AnalyticsProvider userId={email}>
            <AppInner signOut={signOut ?? (() => {})} email={email} />
          </AnalyticsProvider>
        );
      }}
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
