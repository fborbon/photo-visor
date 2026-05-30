import { useState, useRef } from 'react';
import { SyncStatus, deriveTagName } from '../hooks/useSync';
import type { AlbumConfig, AlbumItem } from '../types';
import { useLang } from '../context/LangContext';

const ALBUM_CONFIG_KEY = 'photo_sync_album_configs';

interface Props {
  status:                SyncStatus;
  lastSync:              Date | null;
  autoSync:              boolean;
  setAutoSync:           (v: boolean) => void;
  onSyncNow:             (albumConfigs: Record<string, AlbumConfig>) => void;
  onSyncDesktop:         (files: File[], cfg: AlbumConfig, folderName: string) => void;
  onStopSync:            () => void;
  fixing:                boolean;
  fixResult:             string;
  onMarkNonCameraPrivate:() => void;
  onLoadAlbums:          () => Promise<AlbumItem[]>;
  isNative:              boolean;
}

function formatRelative(date: Date): string {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function loadSavedConfigs(): Record<string, AlbumConfig> {
  try { return JSON.parse(localStorage.getItem(ALBUM_CONFIG_KEY) ?? '{}'); }
  catch { return {}; }
}

function saveConfigs(configs: Record<string, AlbumConfig>) {
  localStorage.setItem(ALBUM_CONFIG_KEY, JSON.stringify(configs));
}

function defaultConfig(album: AlbumItem): AlbumConfig {
  return { sync: true, private: !album.isCamera, location: '', description: '' };
}

export default function SyncView({
  status, lastSync, autoSync, setAutoSync,
  onSyncNow, onSyncDesktop, onStopSync,
  fixing, fixResult, onMarkNonCameraPrivate,
  onLoadAlbums, isNative,
}: Props) {
  const { tr } = useLang();

  // Mobile: loaded album list
  const [albums,       setAlbums]       = useState<AlbumItem[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);

  // Per-album configs (both mobile albums and desktop folder use same structure)
  const [albumConfigs, setAlbumConfigs] = useState<Record<string, AlbumConfig>>(loadSavedConfigs);

  // Desktop: files selected via folder picker
  const [desktopFiles,      setDesktopFiles]      = useState<File[]>([]);
  const [desktopFolderName, setDesktopFolderName] = useState('');
  const [desktopConfig,     setDesktopConfig]     = useState<AlbumConfig>({
    sync: true, private: false, location: '', description: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = status.phase === 'enumerating' || status.phase === 'syncing';
  const pct = status.total > 0
    ? Math.round((status.processed / status.total) * 100)
    : 0;

  // Get effective config for an album (fall back to sensible defaults)
  const getConfig = (album: AlbumItem): AlbumConfig =>
    albumConfigs[album.identifier] ?? defaultConfig(album);

  const updateAlbumConfig = (id: string, patch: Partial<AlbumConfig>) => {
    setAlbumConfigs(prev => {
      const album = albums.find(a => a.identifier === id);
      const base  = album ? defaultConfig(album) : { sync: true, private: false, location: '', description: '' };
      const next  = { ...prev, [id]: { ...base, ...prev[id], ...patch } };
      saveConfigs(next);
      return next;
    });
  };

  const handleLoadAlbums = async () => {
    setAlbumsLoading(true);
    const list = await onLoadAlbums();
    setAlbums(list);
    setAlbumsLoading(false);
  };

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const folderName = (files[0] as File & { webkitRelativePath?: string })
      .webkitRelativePath?.split('/')[0] ?? 'Folder';
    setDesktopFiles(files);
    setDesktopFolderName(folderName);
    setDesktopConfig({ sync: true, private: false, location: '', description: '' });
  };

  const handleSyncNow = () => {
    if (isNative) {
      onSyncNow(albumConfigs);
    } else {
      onSyncDesktop(desktopFiles, desktopConfig, desktopFolderName);
    }
  };

  const canSync = isNative
    ? albums.length === 0 || albums.some(a => getConfig(a).sync)
    : desktopFiles.length > 0;

  const imageCount = isNative
    ? null
    : desktopFiles.filter(f => /\.(jpg|jpeg|png|heic|heif|mp4|mov|gif|webp)$/i.test(f.name)).length;

  return (
    <div className="sync-view">
      <h2 className="sync-heading">
        {isNative ? tr.syncTitle : tr.syncDesktopTitle}
      </h2>

      {/* ── Auto-sync toggle (mobile only) ─────────────────────── */}
      {isNative && (
        <label className="sync-auto-toggle">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={e => setAutoSync(e.target.checked)}
            disabled={isRunning}
          />
          {tr.syncAutoToggle}
        </label>
      )}

      {/* ── Last sync info ──────────────────────────────────────── */}
      <div className="sync-last">
        {tr.syncLastSync}{' '}
        <strong>{lastSync ? formatRelative(lastSync) : tr.syncNever}</strong>
      </div>

      {/* ── MOBILE: album list ──────────────────────────────────── */}
      {isNative && (
        <div className="sync-albums-section">
          <button
            className="sync-load-btn"
            onClick={handleLoadAlbums}
            disabled={albumsLoading || isRunning}
          >
            {albumsLoading ? '⏳ Loading albums…' : albums.length > 0 ? '🔄 Reload albums' : `📷 ${tr.syncLoadAlbums}`}
          </button>

          {albums.length > 0 && (
            <div className="sync-album-list">
              {albums.map(album => {
                const cfg = getConfig(album);
                const tag = deriveTagName(cfg, album.name);
                return (
                  <div key={album.identifier} className={'sync-album-row' + (!cfg.sync ? ' sync-album-row--disabled' : '')}>
                    <div className="sync-album-header">
                      <label className="sync-album-check">
                        <input
                          type="checkbox"
                          checked={cfg.sync}
                          onChange={e => updateAlbumConfig(album.identifier, { sync: e.target.checked })}
                          disabled={isRunning}
                        />
                        <span className="sync-album-name">
                          {album.isCamera ? '📷' : '🗂'} {album.name}
                        </span>
                      </label>
                      <label className="sync-album-private-check">
                        <input
                          type="checkbox"
                          checked={cfg.private}
                          onChange={e => updateAlbumConfig(album.identifier, { private: e.target.checked })}
                          disabled={isRunning || !cfg.sync}
                        />
                        🔒 {tr.syncPrivate}
                      </label>
                    </div>
                    {cfg.sync && (
                      <div className="sync-album-fields">
                        <input
                          className="sync-album-input"
                          type="text"
                          placeholder={tr.syncLocationPlaceholder}
                          value={cfg.location}
                          onChange={e => updateAlbumConfig(album.identifier, { location: e.target.value })}
                          disabled={isRunning}
                        />
                        <input
                          className="sync-album-input"
                          type="text"
                          placeholder={tr.syncDescriptionPlaceholder}
                          value={cfg.description}
                          onChange={e => updateAlbumConfig(album.identifier, { description: e.target.value })}
                          disabled={isRunning}
                        />
                        <div className="sync-tag-preview">
                          🏷 {tag}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Privacy legend */}
          {albums.length === 0 && !albumsLoading && (
            <div className="sync-notes">
              <div className="sync-note sync-note--public">📷 {tr.syncCameraNote}</div>
              <div className="sync-note sync-note--private">🔒 {tr.syncOtherNote}</div>
            </div>
          )}
        </div>
      )}

      {/* ── DESKTOP: folder picker ──────────────────────────────── */}
      {!isNative && (
        <div className="sync-desktop-section">
          <button
            className="sync-load-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isRunning}
          >
            📁 {tr.syncSelectFolder}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is non-standard
            webkitdirectory=""
            multiple
            style={{ display: 'none' }}
            onChange={handleFolderSelect}
          />

          {desktopFiles.length > 0 && (
            <div className="sync-desktop-folder">
              <div className="sync-desktop-folder-name">
                📁 {desktopFolderName}
                <span className="sync-desktop-count">{imageCount} {tr.syncImageFiles}</span>
              </div>
              <label className="sync-album-private-check sync-album-private-check--desktop">
                <input
                  type="checkbox"
                  checked={desktopConfig.private}
                  onChange={e => setDesktopConfig(p => ({ ...p, private: e.target.checked }))}
                  disabled={isRunning}
                />
                🔒 {tr.syncPrivate}
              </label>
              <input
                className="sync-album-input"
                type="text"
                placeholder={tr.syncLocationPlaceholder}
                value={desktopConfig.location}
                onChange={e => setDesktopConfig(p => ({ ...p, location: e.target.value }))}
                disabled={isRunning}
              />
              <input
                className="sync-album-input"
                type="text"
                placeholder={tr.syncDescriptionPlaceholder}
                value={desktopConfig.description}
                onChange={e => setDesktopConfig(p => ({ ...p, description: e.target.value }))}
                disabled={isRunning}
              />
              <div className="sync-tag-preview">
                🏷 {deriveTagName(desktopConfig, desktopFolderName)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── First-run notice ────────────────────────────────────── */}
      {!lastSync && isNative && (
        <div className="sync-first-run">{tr.syncFirstRun}</div>
      )}

      {/* ── Sync Now / Stop ─────────────────────────────────────── */}
      {isRunning ? (
        <button className="sync-btn sync-btn--stop" onClick={onStopSync}>
          ⏹ {tr.syncStop}
        </button>
      ) : (
        <button
          className="sync-btn"
          onClick={handleSyncNow}
          disabled={!canSync}
        >
          {tr.syncNow}
        </button>
      )}

      {/* ── Progress ────────────────────────────────────────────── */}
      {(status.phase === 'enumerating' || status.phase === 'syncing') && (
        <div className="sync-progress">
          {status.phase === 'enumerating' ? (
            <span className="sync-enum-msg">
              {status.message || 'Reading gallery…'}
            </span>
          ) : (
            <>
              <div className="sync-progress-bar">
                <div className="sync-progress-fill" style={{ width: pct + '%' }} />
              </div>
              <div className="sync-progress-label">
                {status.processed} {tr.syncOf} {status.total}
                {status.message && (
                  <span className="sync-current-file"> — {status.message}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Results ─────────────────────────────────────────────── */}
      {(status.phase === 'done' || status.phase === 'error') && (
        <div className={'sync-result' + (status.phase === 'error' ? ' sync-result--error' : '')}>
          {status.phase === 'error' ? (
            <span style={{ whiteSpace: 'pre-wrap', fontSize: '.75rem', lineHeight: 1.6 }}>
              {status.message === 'web-only'
                ? tr.syncWebOnly
                : status.message.includes('permission') || status.message.includes('PERMISSION')
                  ? tr.syncPermission
                  : status.message.startsWith('debug:')
                    ? status.message.slice(6)
                    : status.message}
            </span>
          ) : status.message === 'none' ? (
            <span>✅ {tr.syncNoNew}</span>
          ) : (
            <div className="sync-stats">
              {status.uploaded > 0 && <span className="sync-stat sync-stat--up">⬆ {status.uploaded} {tr.syncUploaded}</span>}
              {status.skipped  > 0 && <span className="sync-stat sync-stat--skip">☑ {status.skipped} {tr.syncSkipped}</span>}
              {status.failed   > 0 && <span className="sync-stat sync-stat--fail">✕ {status.failed} {tr.syncFailed}</span>}
            </div>
          )}
        </div>
      )}

      {/* ── One-time retroactive fix (mobile only) ──────────────── */}
      {isNative && (
        <div className="sync-fix-section">
          <button
            className="sync-fix-btn"
            onClick={onMarkNonCameraPrivate}
            disabled={fixing || isRunning}
          >
            {fixing ? '🔒 Marking private…' : '🔒 Mark non-Camera photos as private'}
          </button>
          {fixResult && <div className="sync-fix-result">{fixResult}</div>}
        </div>
      )}
    </div>
  );
}
