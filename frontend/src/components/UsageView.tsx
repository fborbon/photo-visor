import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DayLog, AEvent } from '../context/AnalyticsContext';
import config, { displayNameForEmail } from '../config';

const KNOWN_EMAILS = [
  'correoprincipal2021@hotmail.com',
  'ferborbon77@hotmail.com',
  'rogui1900@gmail.com',
  'borgui11@gmail.com',
];
const DAYS = 30;

function sanitize(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
async function streamToText(stream: ReadableStream | NodeJS.ReadableStream): Promise<string> {
  const reader = (stream as ReadableStream).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce((a, b) => { const m = new Uint8Array(a.length + b.length); m.set(a); m.set(b, a.length); return m; }, new Uint8Array(0))
  );
}

interface AggrDay {
  date:        string;
  logins:      Record<string, boolean>;  // userId → logged in
  photosSeen:  number;
  albumsSeen:  number;
  tabs:        Record<string, number>;
}

interface AlbumStat {
  key:    string;
  title:  string;
  photos: number;
  visits: number;    // unique user-days
}

interface UsageData {
  days:       AggrDay[];
  albumStats: AlbumStat[];
}

function aggregate(logs: DayLog[]): UsageData {
  const dayMap: Record<string, AggrDay> = {};
  const albumMap: Record<string, AlbumStat> = {};

  for (const log of logs) {
    const day = dayMap[log.date] ?? (dayMap[log.date] = {
      date: log.date, logins: {}, photosSeen: 0, albumsSeen: 0, tabs: {},
    });

    // Track unique album visits per user-day
    const visitedAlbumsToday = new Set<string>();

    for (const ev of log.events) {
      if (ev.type === 'login') {
        day.logins[log.userId] = true;
      } else if (ev.type === 'view_photo') {
        day.photosSeen++;
        const albumKey = ev.data.albumKey ?? '';
        if (albumKey && !visitedAlbumsToday.has(albumKey)) {
          visitedAlbumsToday.add(albumKey);
          day.albumsSeen++;
          const as = albumMap[albumKey] ?? (albumMap[albumKey] = {
            key: albumKey, title: ev.data.albumTitle ?? albumKey, photos: 0, visits: 0,
          });
          as.photos++;
          as.visits++;
        } else if (albumKey) {
          (albumMap[albumKey] ??= { key: albumKey, title: ev.data.albumTitle ?? albumKey, photos: 0, visits: 0 }).photos++;
        }
      } else if (ev.type === 'view_album') {
        const albumKey = ev.data.albumKey ?? '';
        if (albumKey && !visitedAlbumsToday.has(albumKey)) {
          visitedAlbumsToday.add(albumKey);
          day.albumsSeen++;
          (albumMap[albumKey] ??= { key: albumKey, title: ev.data.albumTitle ?? albumKey, photos: 0, visits: 0 }).visits++;
        }
      } else if (ev.type === 'nav_tab') {
        const t = ev.data.tab ?? '';
        if (t) day.tabs[t] = (day.tabs[t] ?? 0) + 1;
      }
    }
  }

  const days = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));
  const albumStats = Object.values(albumMap).sort((a, b) => b.photos - a.photos);
  return { days, albumStats };
}

export default function UsageView() {
  const [data,    setData]    = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    (async () => {
      try {
        const session = await fetchAuthSession();
        if (!session.credentials) { setError('Not authenticated'); setLoading(false); return; }
        const s3 = new S3Client({ region: config.region, credentials: session.credentials });

        const logs: DayLog[] = [];
        const dates = Array.from({ length: DAYS }, (_, i) => dateStr(i));

        await Promise.all(
          dates.flatMap(date =>
            KNOWN_EMAILS.map(async email => {
              const key = `analytics/${date}/${sanitize(email)}.json`;
              try {
                const res = await s3.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
                const text = await streamToText(res.Body as ReadableStream);
                logs.push(JSON.parse(text) as DayLog);
              } catch { /* file doesn't exist yet */ }
            })
          )
        );

        setData(aggregate(logs));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="usage-wrap"><p className="usage-loading">Loading analytics…</p></div>;
  if (error)   return <div className="usage-wrap"><p className="usage-error">Error: {error}</p></div>;
  if (!data || data.days.length === 0) return <div className="usage-wrap"><p className="usage-empty">No usage data yet. Data will appear after users interact with the app.</p></div>;

  const allTabs: Record<string, number> = {};
  for (const d of data.days) {
    for (const [t, n] of Object.entries(d.tabs)) allTabs[t] = (allTabs[t] ?? 0) + n;
  }
  const tabEntries = Object.entries(allTabs).sort((a, b) => b[1] - a[1]);

  const top3Photos  = data.albumStats.slice(0, 3);
  const top3Revisit = [...data.albumStats].sort((a, b) => b.visits - a.visits).slice(0, 3);

  const activeDays = data.days.filter(d => Object.keys(d.logins).length > 0);

  return (
    <div className="usage-wrap">
      <h2 className="usage-title">Usage Analytics</h2>

      {/* ── Daily activity ──────────────────────────────────────── */}
      <section className="usage-section">
        <h3>Daily Activity (last {DAYS} days)</h3>
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Date</th>
                {KNOWN_EMAILS.map(e => <th key={e}>{displayNameForEmail(e)}</th>)}
                <th>Photos seen</th>
                <th>Albums visited</th>
              </tr>
            </thead>
            <tbody>
              {activeDays.map(d => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  {KNOWN_EMAILS.map(e => (
                    <td key={e} className={d.logins[e.toLowerCase()] ? 'usage-logged-in' : ''}>
                      {d.logins[e.toLowerCase()] ? '✓' : ''}
                    </td>
                  ))}
                  <td>{d.photosSeen || ''}</td>
                  <td>{d.albumsSeen || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Tab navigation ──────────────────────────────────────── */}
      {tabEntries.length > 0 && (
        <section className="usage-section">
          <h3>Tab Navigation (all time)</h3>
          <div className="usage-tab-bars">
            {tabEntries.map(([tab, count]) => {
              const max = tabEntries[0][1];
              return (
                <div key={tab} className="usage-bar-row">
                  <span className="usage-bar-label">{tab}</span>
                  <div className="usage-bar-track">
                    <div className="usage-bar-fill" style={{ width: `${(count / max) * 100}%` }} />
                  </div>
                  <span className="usage-bar-value">{count}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Top albums ──────────────────────────────────────────── */}
      <div className="usage-top-row">
        <section className="usage-section usage-top-section">
          <h3>Top 3 Albums — Most Photos Seen</h3>
          <ol className="usage-top-list">
            {top3Photos.map(a => (
              <li key={a.key}>
                <span className="usage-album-title">{a.title || a.key}</span>
                <span className="usage-album-count">{a.photos} photos</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="usage-section usage-top-section">
          <h3>Top 3 Albums — Most Revisited</h3>
          <ol className="usage-top-list">
            {top3Revisit.map(a => (
              <li key={a.key}>
                <span className="usage-album-title">{a.title || a.key}</span>
                <span className="usage-album-count">{a.visits} visits</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
