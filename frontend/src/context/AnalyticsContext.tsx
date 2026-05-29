import {
  createContext, useContext, useEffect, useRef, useCallback, ReactNode,
} from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';

export interface AEvent {
  ts:   number;               // Unix ms
  type: string;               // login | nav_tab | view_album | view_photo
  data: Record<string, string>;
}

export interface DayLog {
  userId: string;
  date:   string;             // YYYY-MM-DD
  events: AEvent[];
}

interface AnalyticsCtx {
  trackEvent: (type: string, data?: Record<string, string>) => void;
}

const AnalyticsContext = createContext<AnalyticsCtx>({ trackEvent: () => {} });

export function useAnalytics() { return useContext(AnalyticsContext); }

function todayKey() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}
function s3Key(date: string, userKey: string) {
  return `analytics/${date}/${userKey}.json`;
}
function sanitize(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
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

const FLUSH_INTERVAL_MS = 2 * 60 * 1000;

export function AnalyticsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const buffer  = useRef<AEvent[]>([]);
  const uid     = userId.toLowerCase();   // normalize case
  const userKey = sanitize(uid);
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (flushing.current || buffer.current.length === 0) return;
    flushing.current = true;
    const events = buffer.current.splice(0);
    const date   = todayKey();
    const key    = s3Key(date, userKey);
    try {
      const session = await fetchAuthSession();
      if (!session.credentials) { buffer.current.unshift(...events); return; }
      const s3 = new S3Client({ region: config.region, credentials: session.credentials });

      // Merge with existing daily file
      let existing: DayLog = { userId, date, events: [] };
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
        const text = await streamToText(res.Body as ReadableStream);
        existing = JSON.parse(text) as DayLog;
      } catch { /* 404 or first write today */ }

      const merged: DayLog = {
        userId: uid,
        date,
        events: [...existing.events, ...events],
      };
      await s3.send(new PutObjectCommand({
        Bucket:      config.bucketName,
        Key:         key,
        Body:        JSON.stringify(merged),
        ContentType: 'application/json',
        CacheControl: 'no-cache',
      }));
    } catch (e) {
      // Re-queue on failure so we don't lose events
      buffer.current.unshift(...events);
    } finally {
      flushing.current = false;
    }
  }, [userId, userKey]);

  // Periodic flush
  useEffect(() => {
    const id = setInterval(flush, FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [flush]);

  // Flush on page unload
  useEffect(() => {
    const handler = () => { flush(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [flush]);

  // Record login on mount
  useEffect(() => {
    buffer.current.push({ ts: Date.now(), type: 'login', data: {} });
  }, []);

  const trackEvent = useCallback((type: string, data: Record<string, string> = {}) => {
    buffer.current.push({ ts: Date.now(), type, data });
  }, []);

  return (
    <AnalyticsContext.Provider value={{ trackEvent }}>
      {children}
    </AnalyticsContext.Provider>
  );
}
