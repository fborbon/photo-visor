import { useState, useEffect, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { useLang } from '../context/LangContext';
import config from '../config';

interface FolderRule { allow: string[]; deny: string[]; }
interface UserConfig {
  email:        string;
  displayName:  string;
  female:       boolean;
  dateCutoff:   string;
  folderAccess: FolderRule | null;
}
interface UsersConfig {
  updated: string;
  users:   UserConfig[];
}

const CONFIG_KEY = 'index/users_config.json';

async function loadConfig(): Promise<UsersConfig> {
  try {
    const r = await fetch(config.cloudFrontUrl + '/' + CONFIG_KEY + '?nc=' + Date.now());
    if (r.ok) return await r.json();
  } catch { /* start fresh */ }
  return { updated: '', users: [] };
}

async function saveConfig(data: UsersConfig) {
  const session = await fetchAuthSession();
  if (!session.credentials) throw new Error('Not authenticated');
  const s3 = new S3Client({ region: config.region, credentials: session.credentials as never });
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName, Key: CONFIG_KEY,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
}

const empty: UserConfig = { email: '', displayName: '', female: false, dateCutoff: '', folderAccess: null };

export default function UsersManagementView() {
  const { tr } = useLang();
  const [cfg, setCfg] = useState<UsersConfig>({ updated: '', users: [] });
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<UserConfig>(empty);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showCli, setShowCli] = useState<string | null>(null);

  useEffect(() => { loadConfig().then(setCfg); }, []);

  const persist = useCallback(async (next: UsersConfig) => {
    setSaving(true);
    setMsg('');
    try {
      next.updated = new Date().toISOString();
      await saveConfig(next);
      setCfg(next);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg('Error: ' + String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const startEdit = (idx: number) => {
    setEditing(idx);
    setDraft({ ...cfg.users[idx] });
    setShowAdd(false);
  };

  const saveEdit = () => {
    if (editing === null) return;
    const users = [...cfg.users];
    users[editing] = { ...draft };
    persist({ ...cfg, users });
    setEditing(null);
  };

  const startAdd = () => {
    setShowAdd(true);
    setEditing(null);
    setDraft({ ...empty });
  };

  const saveAdd = () => {
    if (!draft.email.trim()) return;
    const users = [...cfg.users, { ...draft, email: draft.email.trim().toLowerCase() }];
    persist({ ...cfg, users });
    setShowAdd(false);
    setDraft(empty);
  };

  const deleteUser = (idx: number) => {
    const user = cfg.users[idx];
    if (!confirm(`Delete ${user.displayName || user.email}?`)) return;
    const users = cfg.users.filter((_, i) => i !== idx);
    persist({ ...cfg, users });
    setShowCli(`# Delete from Cognito:\naws cognito-idp admin-delete-user --user-pool-id ${config.userPoolId} --username "${user.email}" --region eu-west-1`);
  };

  const addAllow = () => {
    const path = prompt('Folder path to allow (e.g. .Amigos/España/Olloki/Beatriz/)');
    if (!path) return;
    const fa = draft.folderAccess ?? { allow: [], deny: [] };
    fa.allow = [...fa.allow, path];
    setDraft({ ...draft, folderAccess: fa });
  };

  const addDeny = () => {
    const path = prompt('Folder path to deny (e.g. .Amigos/España/Olloki/Beatriz/Otros/)');
    if (!path) return;
    const fa = draft.folderAccess ?? { allow: [], deny: [] };
    fa.deny = [...fa.deny, path];
    setDraft({ ...draft, folderAccess: fa });
  };

  const removeAllow = (idx: number) => {
    const fa = draft.folderAccess;
    if (!fa) return;
    fa.allow = fa.allow.filter((_, i) => i !== idx);
    setDraft({ ...draft, folderAccess: fa.allow.length || fa.deny.length ? fa : null });
  };

  const removeDeny = (idx: number) => {
    const fa = draft.folderAccess;
    if (!fa) return;
    fa.deny = fa.deny.filter((_, i) => i !== idx);
    setDraft({ ...draft, folderAccess: fa.allow.length || fa.deny.length ? fa : null });
  };

  const userForm = (isNew: boolean) => (
    <div className="um-form">
      <label>
        Email
        <input type="email" value={draft.email} disabled={!isNew}
          onChange={e => setDraft({ ...draft, email: e.target.value })} />
      </label>
      <label>
        Display Name
        <input type="text" value={draft.displayName}
          onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
      </label>
      <label className="um-check">
        <input type="checkbox" checked={draft.female}
          onChange={e => setDraft({ ...draft, female: e.target.checked })} />
        Female greeting (Bienvenida)
      </label>
      <label>
        Date Cutoff (photos before this date are hidden)
        <input type="date" value={draft.dateCutoff}
          onChange={e => setDraft({ ...draft, dateCutoff: e.target.value })} />
      </label>
      <div className="um-folders">
        <h4>Allowed Private Folders</h4>
        {(draft.folderAccess?.allow ?? []).map((p, i) => (
          <div key={i} className="um-folder-row">
            <span>{p}</span>
            <button onClick={() => removeAllow(i)}>✕</button>
          </div>
        ))}
        <button className="um-add-btn" onClick={addAllow}>+ Add allowed folder</button>
      </div>
      <div className="um-folders">
        <h4>Denied Sub-folders</h4>
        {(draft.folderAccess?.deny ?? []).map((p, i) => (
          <div key={i} className="um-folder-row">
            <span>{p}</span>
            <button onClick={() => removeDeny(i)}>✕</button>
          </div>
        ))}
        <button className="um-add-btn" onClick={addDeny}>+ Add denied folder</button>
      </div>
      <div className="um-actions">
        <button className="um-save" onClick={isNew ? saveAdd : saveEdit} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button className="um-cancel" onClick={() => { setEditing(null); setShowAdd(false); }}>Cancel</button>
      </div>
      {isNew && (
        <div className="um-cli">
          <h4>Create in Cognito (run in terminal):</h4>
          <pre>{`aws cognito-idp admin-create-user \\
  --user-pool-id ${config.userPoolId} \\
  --username "${draft.email}" \\
  --user-attributes Name=email,Value="${draft.email}" Name=email_verified,Value=true \\
  --region eu-west-1

# Set permanent password:
aws cognito-idp admin-set-user-password \\
  --user-pool-id ${config.userPoolId} \\
  --username "${draft.email}" \\
  --password "CHANGE_ME" --permanent \\
  --region eu-west-1`}</pre>
        </div>
      )}
    </div>
  );

  return (
    <div className="um-layout">
      <div className="um-header">
        <h2>👥 Users Management</h2>
        <button className="um-add-user-btn" onClick={startAdd}>+ Add User</button>
        {msg && <span className="um-msg">{msg}</span>}
      </div>

      {showCli && (
        <div className="um-cli">
          <pre>{showCli}</pre>
          <button onClick={() => { navigator.clipboard.writeText(showCli); setShowCli(null); }}>📋 Copy & Close</button>
        </div>
      )}

      {showAdd && userForm(true)}

      <div className="um-table">
        <div className="um-row um-row-header">
          <span>Email</span>
          <span>Name</span>
          <span>Cutoff</span>
          <span>Folders</span>
          <span>Actions</span>
        </div>
        {cfg.users.map((u, i) => (
          <div key={u.email} className="um-row">
            <span className="um-email">{u.email}</span>
            <span>{u.displayName} {u.female ? '♀' : ''}</span>
            <span>{u.dateCutoff || '—'}</span>
            <span>{u.folderAccess ? `${u.folderAccess.allow.length} allowed, ${u.folderAccess.deny.length} denied` : '—'}</span>
            <span className="um-row-actions">
              <button onClick={() => startEdit(i)}>Edit</button>
              <button onClick={() => deleteUser(i)}>Delete</button>
            </span>
          </div>
        ))}
        {cfg.users.length === 0 && <p className="um-empty">No users configured. Click "+ Add User" to add one.</p>}
      </div>

      {editing !== null && userForm(false)}

      {cfg.updated && <p className="um-updated">Last updated: {new Date(cfg.updated).toLocaleString()}</p>}
    </div>
  );
}
