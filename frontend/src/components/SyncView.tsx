import { SyncStatus } from '../hooks/useSync';
import { useLang } from '../context/LangContext';

interface Props {
  status:                SyncStatus;
  lastSync:              Date | null;
  autoSync:              boolean;
  setAutoSync:           (v: boolean) => void;
  onSyncNow:             () => void;
  onStopSync:            () => void;
  fixing:                boolean;
  fixResult:             string;
  onMarkNonCameraPrivate:() => void;
}

function formatRelative(date: Date): string {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1)   return 'just now';
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)    return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

export default function SyncView({ status, lastSync, autoSync, setAutoSync, onSyncNow, onStopSync, fixing, fixResult, onMarkNonCameraPrivate }: Props) {
  const { tr } = useLang();

  const isRunning = status.phase === 'enumerating' || status.phase === 'syncing';
  const pct = status.total > 0
    ? Math.round((status.processed / status.total) * 100)
    : 0;

  return (
    <div className="sync-view">
      <h2 className="sync-heading">{tr.syncTitle}</h2>

      {/* Auto-sync toggle */}
      <label className="sync-auto-toggle">
        <input
          type="checkbox"
          checked={autoSync}
          onChange={e => setAutoSync(e.target.checked)}
          disabled={isRunning}
        />
        {tr.syncAutoToggle}
      </label>

      {/* Last sync info */}
      <div className="sync-last">
        {tr.syncLastSync}{' '}
        <strong>{lastSync ? formatRelative(lastSync) : tr.syncNever}</strong>
      </div>

      {/* Privacy notes */}
      <div className="sync-notes">
        <div className="sync-note sync-note--public">📷 {tr.syncCameraNote}</div>
        <div className="sync-note sync-note--private">🔒 {tr.syncOtherNote}</div>
      </div>

      {/* One-time retroactive fix */}
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

      {/* First-run notice */}
      {!lastSync && (
        <div className="sync-first-run">{tr.syncFirstRun}</div>
      )}

      {/* Sync Now / Stop button */}
      {isRunning ? (
        <button className="sync-btn sync-btn--stop" onClick={onStopSync}>
          ⏹ Stop sync
        </button>
      ) : (
        <button className="sync-btn" onClick={onSyncNow}>
          {tr.syncNow}
        </button>
      )}

      {/* Progress */}
      {(status.phase === 'enumerating' || status.phase === 'syncing') && (
        <div className="sync-progress">
          {status.phase === 'enumerating' ? (
            <span className="sync-enum-msg">Reading gallery…</span>
          ) : (
            <>
              <div className="sync-progress-bar">
                <div className="sync-progress-fill" style={{ width: pct + '%' }} />
              </div>
              <div className="sync-progress-label">
                {status.processed} {tr.syncOf} {status.total}
                {status.message && <span className="sync-current-file"> — {status.message}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Results */}
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
    </div>
  );
}
