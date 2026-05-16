import { useState } from 'react';
import { useTags }    from '../context/TagsContext';
import { useLang }    from '../context/LangContext';
import { useIndex }   from '../hooks/useIndex';
import { PhotoEntry } from '../types';
import PhotoGrid from './PhotoGrid';

type Scope = 'private' | 'shared';
interface Selected { name: string; scope: Scope; }

export default function TagsView() {
  const { tags, tagNames, sharedTags, sharedTagNames, deleteTag, isMySharedTag } = useTags();
  const { tr } = useLang();
  const [sel, setSel] = useState<Selected | null>(null);

  const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null);
  const { data: albumPhotos, loading: albumLoading } = useIndex<PhotoEntry[]>(
    expandedAlbum ? 'index/geo/' + expandedAlbum + '.json' : null
  );

  const entry = sel
    ? (sel.scope === 'private' ? tags[sel.name] : sharedTags[sel.name])
    : null;

  const canDelete = sel
    ? (sel.scope === 'private' || isMySharedTag(sel.name))
    : false;

  // Owner email for display
  const ownerLabel = (tagName: string) => {
    const e = sharedTags[tagName];
    if (!e) return '';
    return e.ownerEmail.split('@')[0];
  };

  const select = (name: string, scope: Scope) => {
    setSel({ name, scope });
    setExpandedAlbum(null);
  };

  return (
    <div className="tags-layout">

      {/* ── Tag rail ─────────────────────────────────────── */}
      <aside className="tags-rail">

        {/* Private tags */}
        {tagNames.length > 0 && (
          <>
            <h3 className="rail-heading">🔒 {tr.myTags}</h3>
            {tagNames.map(name => (
              <button
                key={'p:' + name}
                className={'tag-rail-btn' + (sel?.name === name && sel.scope === 'private' ? ' active' : '')}
                onClick={() => select(name, 'private')}
              >
                <span className="tag-rail-name">{name}</span>
                <span className="tag-rail-count">{tags[name].photos.length + tags[name].albums.length}</span>
              </button>
            ))}
          </>
        )}

        {/* Shared tags */}
        {sharedTagNames.length > 0 && (
          <>
            <h3 className="rail-heading" style={{ marginTop: '.8rem' }}>👨‍👩‍👧 {tr.familyTags}</h3>
            {sharedTagNames.map(name => (
              <button
                key={'s:' + name}
                className={'tag-rail-btn shared-tag' + (sel?.name === name && sel.scope === 'shared' ? ' active' : '')}
                onClick={() => select(name, 'shared')}
              >
                <span className="tag-rail-name">{name}</span>
                <span className="tag-rail-count">
                  {sharedTags[name].photos.length + sharedTags[name].albums.length}
                </span>
              </button>
            ))}
          </>
        )}

        {tagNames.length === 0 && sharedTagNames.length === 0 && (
          <p className="tags-empty-hint">{tr.noTags}</p>
        )}
      </aside>

      {/* ── Tag content ──────────────────────────────────── */}
      <div className="tags-main">
        {!sel && <div className="timeline-hint">{tr.noTags}</div>}

        {sel && entry && (
          <>
            <div className="tags-header">
              <h2 className="tags-selected-name">
                {sel.scope === 'private' ? '🔒' : '👨‍👩‍👧'} {sel.name}
                {sel.scope === 'shared' && (
                  <span className="tag-owner-hint"> · {tr.sharedBy} {ownerLabel(sel.name)}</span>
                )}
              </h2>
              {canDelete && (
                <button className="tag-delete-btn"
                  onClick={() => { deleteTag(sel.name, sel.scope === 'shared'); setSel(null); }}>
                  {tr.deleteTag}
                </button>
              )}
            </div>

            {/* Albums */}
            {entry.albums.length > 0 && (
              <div className="tagged-albums">
                <h4 className="tagged-section-label">{entry.albums.length} {tr.taggedAlbums}</h4>
                <div className="album-cards">
                  {entry.albums.map(a => (
                    <div key={a.key} className="album-card">
                      <span className="album-card-title">📁 {a.title}</span>
                      <button className="album-card-open"
                        onClick={() => setExpandedAlbum(expandedAlbum === a.key ? null : a.key)}>
                        {expandedAlbum === a.key ? '▲' : '▼'} {tr.openAlbum}
                      </button>
                    </div>
                  ))}
                </div>
                {expandedAlbum && (
                  <div className="album-expand">
                    {albumLoading && <p className="panel-loading">{tr.loading}</p>}
                    {albumPhotos  && <PhotoGrid photos={albumPhotos} />}
                  </div>
                )}
              </div>
            )}

            {/* Photos */}
            {entry.photos.length > 0
              ? <PhotoGrid photos={entry.photos} title={entry.photos.length + ' ' + tr.taggedPhotos} />
              : !entry.albums.length ? <p className="panel-loading">{tr.noTaggedPhotos}</p> : null
            }
          </>
        )}
      </div>
    </div>
  );
}
