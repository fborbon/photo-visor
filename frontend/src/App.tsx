import { useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Tab, Summary } from './types';
import { LangProvider, useLang }    from './context/LangContext';
import { PrivacyProvider, usePrivacy } from './context/PrivacyContext';
import { TagsProvider }             from './context/TagsContext';
import { useIndex }     from './hooks/useIndex';
import MapView      from './components/MapView';
import TimelineView from './components/TimelineView';
import TagsView     from './components/TagsView';
import UploadView   from './components/UploadView';
import LatestView        from './components/LatestView';
import SlotMachineView  from './components/SlotMachineView';
import StatisticsView   from './components/StatisticsView';

function Shell() {
  const [tab, setTab] = useState<Tab>('map');
  const { lang, toggle, tr } = useLang();
  const { isOwner } = usePrivacy();
  const { data: summary } = useIndex<Summary>('index/summary.json');

  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => (
        <div className="app">

          <header className="topbar">
            <span className="topbar-logo">
              <span style={{ color: '#ff0084' }}>foto</span>visor
            </span>

            <nav className="tab-nav">
              <button
                className={'tab-btn' + (tab === 'map'      ? ' active' : '')}
                onClick={() => setTab('map')}
              >
                🗺 {tr.tabMap}
              </button>
              <button
                className={'tab-btn' + (tab === 'timeline' ? ' active' : '')}
                onClick={() => setTab('timeline')}
              >
                📅 {tr.tabTimeline}
              </button>
              <button
                className={'tab-btn' + (tab === 'tags'     ? ' active' : '')}
                onClick={() => setTab('tags')}
              >
                🏷 {tr.tabTags}
              </button>
              <button
                className={'tab-btn' + (tab === 'latest'  ? ' active' : '')}
                onClick={() => setTab('latest')}
              >
                🆕 {tr.tabLatest}
              </button>
              <button
                className={'tab-btn' + (tab === 'slots'   ? ' active' : '')}
                onClick={() => setTab('slots')}
              >
                🎰 {tr.tabSlots}
              </button>
              <button
                className={'tab-btn' + (tab === 'stats'   ? ' active' : '')}
                onClick={() => setTab('stats')}
              >
                📊 {tr.tabStats}
              </button>
              {isOwner && (
                <button
                  className={'tab-btn' + (tab === 'upload' ? ' active' : '')}
                  onClick={() => setTab('upload')}
                >
                  ⬆️ {tr.tabUpload}
                </button>
              )}
            </nav>

            <div className="topbar-right">
              <button className="lang-toggle" onClick={toggle} title="Switch language">
                {lang === 'en' ? '🇪🇸 ES' : '🇬🇧 EN'}
              </button>
              <span className="topbar-user">{user?.signInDetails?.loginId}</span>
              <button className="signout-btn" onClick={signOut}>{tr.signOut}</button>
            </div>
          </header>

          <main className="main-content">
            <TagsProvider>
              {tab === 'map'      && <MapView />}
              {tab === 'timeline' && <TimelineView />}
              {tab === 'tags'     && <TagsView />}
              {tab === 'latest'   && <LatestView />}
              {tab === 'slots'    && <SlotMachineView />}
              {tab === 'stats'    && <StatisticsView />}
              {tab === 'upload'   && <UploadView />}
            </TagsProvider>
          </main>

          {summary?.generated && (
            <footer className="app-footer">
              🕐 Last indexed: <strong>{new Date(summary.generated).toLocaleString(lang === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
            </footer>
          )}

        </div>
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
