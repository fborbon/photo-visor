import { useState, useRef } from 'react';
import { SyncStatus, deriveTagName } from '../hooks/useSync';
import type { AlbumConfig, AlbumItem } from '../types';
import { useLang } from '../context/LangContext';

const ALBUM_CONFIG_KEY = 'photo_sync_album_configs';

interface Props {
  status:        SyncStatus;
  lastSync:      Date | null;
  onSyncNow:     (albumConfigs: Record<string, AlbumConfig>) => void;
  onSyncDesktop: (files: File[], cfg: AlbumConfig, folderName: string) => void;
  onStopSync:    () => void;
  onLoadAlbums:  () => Promise<AlbumItem[]>;
  isNative:      boolean;
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
  try {
    const saved: Record<string, AlbumConfig> = JSON.parse(localStorage.getItem(ALBUM_CONFIG_KEY) ?? '{}');
    // Migration: if every saved album has sync:true, the old default leaked into storage — reset.
    const entries = Object.values(saved);
    // Only wipe the old "all auto-enabled with no path configured" default state.
    // A config with a location or forcePath is a legitimate user setting — preserve it.
    if (entries.length > 0 && entries.every(c => c.sync && !c.location && !(c.forcePath ?? ''))) {
      localStorage.removeItem(ALBUM_CONFIG_KEY);
      return {};
    }
    return saved;
  } catch { return {}; }
}

function saveConfigs(configs: Record<string, AlbumConfig>) {
  localStorage.setItem(ALBUM_CONFIG_KEY, JSON.stringify(configs));
}

function defaultConfig(): AlbumConfig {
  return { sync: false, location: '', forcePath: '', createFolder: true };
}

export default function SyncView({
  status, lastSync,
  onSyncNow, onSyncDesktop, onStopSync,
  onLoadAlbums, isNative,
}: Props) {
  const { tr } = useLang();

  // Mobile: loaded album list
  const [albums,        setAlbums]        = useState<AlbumItem[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);

  // Per-album configs
  const [albumConfigs, setAlbumConfigs] = useState<Record<string, AlbumConfig>>(loadSavedConfigs);

  // Desktop: files selected via folder picker
  const [desktopFiles,      setDesktopFiles]      = useState<File[]>([]);
  const [desktopFolderName, setDesktopFolderName] = useState('');
  const [desktopConfig,     setDesktopConfig]     = useState<AlbumConfig>(defaultConfig());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = status.phase === 'enumerating' || status.phase === 'syncing';
  const pct = status.total > 0
    ? Math.round((status.processed / status.total) * 100)
    : 0;

  const getConfig = (album: AlbumItem): AlbumConfig =>
    ({ ...defaultConfig(), ...albumConfigs[album.identifier] });

  const updateAlbumConfig = (id: string, patch: Partial<AlbumConfig>) => {
    setAlbumConfigs(prev => {
      const next = { ...prev, [id]: { ...defaultConfig(), ...prev[id], ...patch } };
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
    setDesktopConfig(defaultConfig());
  };

  const handleSyncNow = () => {
    if (isNative) {
      onSyncNow(albumConfigs);
    } else {
      onSyncDesktop(desktopFiles, desktopConfig, desktopFolderName);
    }
  };

  const canSync = isNative
    ? albums.length > 0 && albums.some(a => getConfig(a).sync)
    : desktopFiles.length > 0;

  const imageCount = isNative
    ? null
    : desktopFiles.filter(f => /\.(jpg|jpeg|png|heic|heif|mp4|mov|gif|webp)$/i.test(f.name)).length;

  return (
    <div className="sync-view">
      <h2 className="sync-heading">
        {isNative ? tr.syncTitle : tr.syncDesktopTitle}
      </h2>

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
              <div className="sync-album-select-all">
                <button
                  className="sync-select-all-btn"
                  disabled={isRunning}
                  onClick={() => {
                    const noneChecked = albums.every(a => !albumConfigs[a.identifier]?.sync);
                    albums.forEach(a => {
                      if (!a.isCamera) updateAlbumConfig(a.identifier, { sync: noneChecked });
                    });
                  }}
                >
                  {albums.every(a => a.isCamera || albumConfigs[a.identifier]?.sync)
                    ? 'Deselect all' : 'Select all'}
                </button>
              </div>
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
                          placeholder="Force path (e.g. Camera/Europa/España/Pamplona)"
                          value={cfg.forcePath}
                          onChange={e => updateAlbumConfig(album.identifier, { forcePath: e.target.value.replace(/\/+$/, '') })}
                          disabled={isRunning}
                        />
                        {(cfg.forcePath ?? '').trim() && (
                          <label className="sync-album-create-folder">
                            <input
                              type="checkbox"
                              checked={cfg.createFolder}
                              onChange={e => updateAlbumConfig(album.identifier, { createFolder: e.target.checked })}
                              disabled={isRunning}
                            />
                            Create subfolder "{album.name}" inside path
                          </label>
                        )}
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
                placeholder="Force path (e.g. Camera/Europa/España/Pamplona)"
                value={desktopConfig.forcePath}
                onChange={e => setDesktopConfig(p => ({ ...p, forcePath: e.target.value.replace(/\/+$/, '') }))}
                disabled={isRunning}
              />
              {desktopConfig.forcePath.trim() && (
                <label className="sync-album-create-folder">
                  <input
                    type="checkbox"
                    checked={desktopConfig.createFolder}
                    onChange={e => setDesktopConfig(p => ({ ...p, createFolder: e.target.checked }))}
                    disabled={isRunning}
                  />
                  Create subfolder "{desktopFolderName}" inside path
                </label>
              )}
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
            <>
              <div className="sync-stats">
                {status.uploaded > 0 && <span className="sync-stat sync-stat--up">⬆ {status.uploaded} {tr.syncUploaded}</span>}
                {status.skipped  > 0 && <span className="sync-stat sync-stat--skip">☑ {status.skipped} {tr.syncSkipped}</span>}
                {status.failed   > 0 && <span className="sync-stat sync-stat--fail">✕ {status.failed} {tr.syncFailed}</span>}
              </div>
              {status.failedFiles.length > 0 && (
                <div className="sync-failed-files">
                  <div className="sync-failed-files-label">Could not read ({status.failedFiles.length}) — open each in gallery to download from cloud, then re-sync:</div>
                  {status.failedFiles.map(f => <div key={f} className="sync-failed-file">{f}</div>)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
