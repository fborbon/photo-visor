import { useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { useLang } from '../context/LangContext';
import config from '../config';

// Detect if running inside Capacitor (native Android/iOS)
const isNative = () => !!(window as unknown as Record<string, unknown>).Capacitor;

type FileStatus = 'pending' | 'hashing' | 'uploading' | 'done' | 'exists' | 'error';

interface UploadItem {
  id:       string;
  file:     File;
  preview:  string;
  hash:     string | null;
  status:   FileStatus;
  progress: number;
  error:    string | null;
}

// SHA-256 of (8-byte big-endian size | first 64 KB | last 64 KB)
// Matches Python's quick_hash — same key in S3 → automatic deduplication
async function quickHash(file: File): Promise<string> {
  const CHUNK = 65536;
  const sizeBuf = new ArrayBuffer(8);
  new DataView(sizeBuf).setBigUint64(0, BigInt(file.size), false);
  const head  = await file.slice(0, CHUNK).arrayBuffer();
  const parts = [sizeBuf, head];
  if (file.size > CHUNK * 2) parts.push(await file.slice(-CHUNK).arrayBuffer());
  let off = 0;
  const merged = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  for (const p of parts) { merged.set(new Uint8Array(p), off); off += p.byteLength; }
  const digest = await crypto.subtle.digest('SHA-256', merged);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function s3Key(hash: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase() || '.jpg';
  return `photos/${hash.slice(0, 2)}/${hash}${ext}`;
}

async function getS3Client() {
  const session = await fetchAuthSession();
  const creds   = session.credentials;
  if (!creds) throw new Error('Not authenticated');
  return new S3Client({ region: config.region, credentials: creds });
}

export default function UploadView() {
  const { tr } = useLang();
  const [items,     setItems]     = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [allDone,   setAllDone]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef  = useRef<HTMLDivElement>(null);

  const update = (id: string, patch: Partial<UploadItem>) =>
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));

  const addFiles = useCallback((files: FileList | File[]) => {
    setAllDone(false);
    const fileArr = Array.from(files).filter(f =>
      /\.(jpg|jpeg|png|heic|heif|mp4|mov|gif)$/i.test(f.name)
    );
    const newItems: UploadItem[] = fileArr.map(f => ({
      id:       Math.random().toString(36).slice(2),
      file:     f,
      preview:  URL.createObjectURL(f),
      hash:     null,
      status:   'pending',
      progress: 0,
      error:    null,
    }));
    setItems(prev => [...prev, ...newItems]);
  }, []);

  const pickNative = async () => {
    try {
      const { Camera } = await import('@capacitor/camera');
      const { photos } = await Camera.pickImages({ quality: 90, limit: 50 });
      const files: File[] = await Promise.all(
        photos.map(async p => {
          const resp = await fetch(p.webPath!);
          const blob = await resp.blob();
          return new File([blob], p.path?.split('/').pop() || 'photo.jpg', { type: blob.type });
        })
      );
      addFiles(files);
    } catch (e) {
      console.warn('Camera plugin error:', e);
      inputRef.current?.click();
    }
  };

  const startUpload = async () => {
    const pending = items.filter(it => it.status === 'pending');
    if (!pending.length) return;
    setUploading(true);

    const s3 = await getS3Client();

    for (const item of pending) {
      // 1. Hash
      update(item.id, { status: 'hashing' });
      let hash: string;
      try {
        hash = await quickHash(item.file);
      } catch {
        update(item.id, { status: 'error', error: 'Hash failed' });
        continue;
      }
      update(item.id, { hash });

      const key = s3Key(hash, item.file.name);

      // 2. Check if already in S3 (deduplication)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
        update(item.id, { status: 'exists', progress: 100 });
        continue;
      } catch { /* not found – proceed */ }

      // 3. Upload
      update(item.id, { status: 'uploading', progress: 0 });
      try {
        const buf  = await item.file.arrayBuffer();
        const mime = item.file.type || 'image/jpeg';
        await s3.send(new PutObjectCommand({
          Bucket:       config.bucketName,
          Key:          key,
          Body:         new Uint8Array(buf),
          ContentType:  mime,
          StorageClass: 'GLACIER_IR',
        }));
        update(item.id, { status: 'done', progress: 100 });
      } catch (e) {
        update(item.id, { status: 'error', error: String(e) });
      }
    }

    setUploading(false);
    setAllDone(true);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragRef.current?.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  };

  const pendingCount = items.filter(it => it.status === 'pending').length;

  const statusIcon = (s: FileStatus) => ({
    pending: '⏳', hashing: '🔄', uploading: '⬆️',
    done: '✅', exists: '☑️', error: '❌',
  }[s]);

  return (
    <div className="upload-view">

      {/* Drop / pick zone */}
      <div
        ref={dragRef}
        className="drop-zone"
        onClick={() => isNative() ? pickNative() : inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); dragRef.current?.classList.add('drag-over'); }}
        onDragLeave={() => dragRef.current?.classList.remove('drag-over')}
        onDrop={onDrop}
      >
        <span className="drop-icon">📷</span>
        <span className="drop-hint">{tr.uploadHint}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={e => e.target.files && addFiles(e.target.files)}
      />

      {/* Preview grid */}
      {items.length > 0 && (
        <>
          <div className="upload-grid">
            {items.map(it => (
              <div key={it.id} className={'upload-cell status-' + it.status}>
                <img src={it.preview} alt="" className="upload-thumb" />
                <div className="upload-status-badge">{statusIcon(it.status)}</div>
                {it.status === 'uploading' && (
                  <div className="upload-progress-bar">
                    <div className="upload-progress-fill" style={{ width: it.progress + '%' }} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {!allDone && (
            <button
              className="upload-start-btn"
              onClick={startUpload}
              disabled={uploading || pendingCount === 0}
            >
              {uploading ? tr.uploading : tr.uploadBtn + ' ' + pendingCount + ' ' + tr.uploadCount}
            </button>
          )}

          {allDone && (
            <div className="upload-done-msg">
              ✅ {tr.uploadDone}
              <p className="upload-processing-hint">{tr.processingHint}</p>
              <button className="upload-start-btn" onClick={() => { setItems([]); setAllDone(false); }}>
                + {tr.uploadHint.split(',')[0]}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
