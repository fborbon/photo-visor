import { useState, useMemo, useRef, useEffect } from 'react';
import { useTags }    from '../context/TagsContext';
import { useLang }    from '../context/LangContext';
import { usePrivacy } from '../context/PrivacyContext';
import { useIndex }   from '../hooks/useIndex';
import { PhotoEntry } from '../types';
import PhotoGrid from './PhotoGrid';
import { sysTagCountryKey, sysTagCityKey, sysTagLabel, translateCountry, translateCity } from '../utils/sysTags';
import { displayNameForEmail } from '../config';

type Scope = 'private' | 'shared' | 'system';
interface Selected { name: string; scope: Scope; slug?: string; }

const MIN_RAIL = 150;
const MAX_RAIL = 600;
const DEFAULT_RAIL = 273;

export default function TagsView() {
  const { tags, tagNames, sharedTags, sharedTagNames, systemTagIndex, systemTagsLoading, deleteTag, isMySharedTag } = useTags();
  const { lang, tr } = useLang();
  const { isOwner } = usePrivacy();
  const [sel, setSel] = useState<Selected | null>(null);
  const [sysFilter, setSysFilter] = useState('');
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<{ name: string; shared: boolean } | null>(null);

  // ── Resizable panel ────────────────────────────────────────────────
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL);
  const mainRef       = useRef<HTMLDivElement>(null);
  const dragRef       = useRef(false);
  const startXRef     = useRef(0);
  const startWidthRef = useRef(DEFAULT_RAIL);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - startXRef.current;
      setRailWidth(Math.max(MIN_RAIL, Math.min(MAX_RAIL, startWidthRef.current + delta)));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = railWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  // ── Album expand ───────────────────────────────────────────────────
  const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null);
  const { data: albumPhotos, loading: albumLoading } = useIndex<PhotoEntry[]>(
    expandedAlbum ? 'index/geo/' + expandedAlbum + '.json' : null
  );

  // Lazy-load system tag photos
  const { data: sysPhotos, loading: sysLoading } = useIndex<PhotoEntry[]>(
    sel?.scope === 'system' && sel.slug ? `index/sys/${sel.slug}.json` : null
  );

  // Group shared tags by owner
  const tagsByOwner = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const name of sharedTagNames) {
      const ownerEmail = sharedTags[name]?.ownerEmail ?? '';
      const owner = ownerEmail ? displayNameForEmail(ownerEmail) : 'unknown';
      groups[owner] = groups[owner] ?? [];
      groups[owner].push(name);
    }
    return groups;
  }, [sharedTagNames, sharedTags]);

  // Filtered system tag names — non-owners only see public (Camera-origin) tags
  const sysTagNames = useMemo(() => {
    const all = Object.keys(systemTagIndex.tags)
      .filter(n => isOwner || systemTagIndex.tags[n].public)
      .sort();
    if (!sysFilter.trim()) return all;
    const q = sysFilter.toLowerCase();
    return all.filter(n => n.toLowerCase().includes(q));
  }, [systemTagIndex, sysFilter, isOwner]);

  // Group system tags: country → city → [tagNames]
  const sysTagsByCountry = useMemo(() => {
    const tree: Record<string, Record<string, string[]>> = {};
    for (const name of sysTagNames) {
      const ck   = sysTagCountryKey(name);
      const city = sysTagCityKey(name);
      (tree[ck] ??= {})[city] ??= [];
      tree[ck][city].push(name);
    }
    return Object.entries(tree)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([country, citiesMap]) => {
        const cities = Object.entries(citiesMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([city, names]) => ({ city, names }));
        return { country, cities };
      });
  }, [sysTagNames]);

  const entry = sel
    ? (sel.scope === 'private' ? tags[sel.name] : sel.scope === 'shared' ? sharedTags[sel.name] : null)
    : null;

  const canDelete = (name: string, scope: Scope) =>
    scope === 'private' || (scope === 'shared' && isMySharedTag(name));

  const select = (name: string, scope: Scope, slug?: string) => {
    setSel({ name, scope, slug });
    setExpandedAlbum(null);
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  };

  const handleDeleteClick = (e: React.MouseEvent, name: string, shared: boolean) => {
    e.stopPropagation();
    setConfirmDeleteTag({ name, shared });
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 767;

  return (
    <div className="tags-layout">

      {/* ── Tag rail ─────────────────────────────────────── */}
      <aside className="tags-rail" style={isMobile ? undefined : { width: railWidth }}>

        {/* ── Personal Tags ── */}
        <h3 className="rail-group-heading">👤 {tr.personalTags}</h3>

        {tagNames.length > 0 && (
          <div className="rail-user-section">
            <div className="rail-user-label">🔒 {tr.myTags}</div>
            {tagNames.map(name => (
              <button
                key={'p:' + name}
                className={'tag-rail-btn' + (sel?.name === name && sel.scope === 'private' ? ' active' : '')}
                onClick={() => select(name, 'private')}
              >
                <span className="tag-rail-name">{name}</span>
                <span className="tag-rail-right">
                  <span className="tag-rail-count">{tags[name].photos.length + tags[name].albums.length}</span>
                  {canDelete(name, 'private') && (
                    <span className="tag-rail-del" onClick={e => handleDeleteClick(e, name, false)} title="Delete tag">×</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {Object.entries(tagsByOwner).map(([owner, names]) => (
          <div key={'owner:' + owner} className="rail-user-section">
            <div className="rail-user-label">👤 {owner}</div>
            {names.map(name => (
              <button
                key={'s:' + name}
                className={'tag-rail-btn shared-tag' + (sel?.name === name && sel.scope === 'shared' ? ' active' : '')}
                onClick={() => select(name, 'shared')}
              >
                <span className="tag-rail-name">{name}</span>
                <span className="tag-rail-right">
                  <span className="tag-rail-count">{sharedTags[name].photos.length + sharedTags[name].albums.length}</span>
                  {canDelete(name, 'shared') && (
                    <span className="tag-rail-del" onClick={e => handleDeleteClick(e, name, true)} title="Delete tag">×</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        ))}

        {tagNames.length === 0 && sharedTagNames.length === 0 && (
          <p className="tags-empty-hint">{tr.noTags}</p>
        )}

        {/* ── System Tags ── */}
        <h3 className="rail-group-heading" style={{ marginTop: '1rem' }}>🗂 {tr.systemTags}</h3>
        <input
          className="sys-tag-filter"
          placeholder={tr.filterTags}
          value={sysFilter}
          onChange={e => setSysFilter(e.target.value)}
        />
        {systemTagsLoading && (
          <p className="tags-empty-hint">{tr.loading}</p>
        )}
        {!systemTagsLoading && sysTagNames.length === 0 && (
          <p className="tags-empty-hint">{sysFilter ? tr.noTagsMatch : tr.noSystemTags}</p>
        )}

        {sysTagsByCountry.map(({ country, cities }) => (
          <div key={'c:' + country} className="sys-country-group">
            <div className="sys-country-heading">{translateCountry(country, lang)}</div>
            {cities.map(({ city, names }) => {
              const showCityHeader = city !== '' &&
                (names.length > 1 || sysTagLabel(names[0]) !== city);
              return (
                <div key={'city:' + country + ':' + city} className="sys-city-group">
                  {showCityHeader && (
                    <div className="sys-city-heading">{translateCity(city, lang)}</div>
                  )}
                  {names.map(name => {
                    const meta  = systemTagIndex.tags[name];
                    const label = sysTagLabel(name);
                    const cls =
                      'tag-rail-btn sys-tag' +
                      (showCityHeader ? ' sys-tag-item' : ' sys-tag-city') +
                      (sel?.name === name && sel.scope === 'system' ? ' active' : '');
                    return (
                      <button
                        key={'sys:' + name}
                        className={cls}
                        onClick={() => select(name, 'system', meta.slug)}
                        title={name}
                      >
                        <span className="tag-rail-name">{label}</span>
                        <span className="tag-rail-count">{meta.count}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </aside>

      {/* ── Resize handle ─────────────────────────────────── */}
      <div className="tags-resize-handle" onMouseDown={onDragStart} />

      {/* ── Tag content ──────────────────────────────────── */}
      <div className="tags-main" ref={mainRef}>
        {!sel && <div className="timeline-hint">{tr.noTags}</div>}

        {sel && entry && (
          <>
            <div className="tags-header">
              <h2 className="tags-selected-name">
                {sel.scope === 'private' ? '🔒' : '👤'} {sel.name}
                {sel.scope === 'shared' && (
                  <span className="tag-owner-hint"> · {tr.sharedBy} {sharedTags[sel.name]?.ownerEmail ? displayNameForEmail(sharedTags[sel.name]!.ownerEmail!) : ''}</span>
                )}
              </h2>
              <span className="tag-owner-hint">
                {entry.photos.length + entry.albums.length} {tr.taggedPhotos}
              </span>
              {canDelete(sel.name, sel.scope) && (
                <button className="tag-delete-btn"
                  onClick={() => setConfirmDeleteTag({ name: sel.name, shared: sel.scope === 'shared' })}>
                  {tr.deleteTag}
                </button>
              )}
            </div>

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
                    {albumPhotos  && (
                      <>
                        <PhotoGrid photos={albumPhotos} />
                        <div className="back-to-top-wrap">
                          <button className="back-to-top-btn" onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ {tr.backToTop ?? 'Back to top'}</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {entry.photos.length > 0
              ? (
                <>
                  <PhotoGrid photos={entry.photos} />
                  <div className="back-to-top-wrap">
                    <button className="back-to-top-btn" onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ {tr.backToTop ?? 'Back to top'}</button>
                  </div>
                </>
              )
              : !entry.albums.length ? <p className="panel-loading">{tr.noTaggedPhotos}</p> : null
            }
          </>
        )}

        {sel?.scope === 'system' && (
          <>
            <div className="tags-header">
              <h2 className="tags-selected-name">
                🗂 {[
                  translateCity(sysTagCityKey(sel.name), lang),
                  translateCountry(sysTagCountryKey(sel.name), lang),
                ].filter(Boolean).join(', ') || sel.name}
              </h2>
              <span className="tag-owner-hint">
                {systemTagIndex.tags[sel.name]?.count ?? 0} {tr.taggedPhotos}
              </span>
            </div>
            {sysLoading && <p className="panel-loading">{tr.loading}</p>}
            {sysPhotos && (
              <>
                <PhotoGrid
                  photos={sysPhotos}
                  placeFallback={[
                    translateCity(sysTagCityKey(sel.name), lang),
                    translateCountry(sysTagCountryKey(sel.name), lang),
                  ].filter(Boolean).join(', ')}
                />
                <div className="back-to-top-wrap">
                  <button className="back-to-top-btn" onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ {tr.backToTop ?? 'Back to top'}</button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Tag delete confirmation */}
      {confirmDeleteTag && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteTag(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <p>🏷 {tr.deleteTagConfirm}</p>
            <p style={{ marginTop: '.5rem', fontWeight: 600, color: '#ffaadd' }}>"{confirmDeleteTag.name}"</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setConfirmDeleteTag(null)}>
                {tr.cancel}
              </button>
              <button className="confirm-delete" onClick={() => {
                deleteTag(confirmDeleteTag.name, confirmDeleteTag.shared);
                if (sel?.name === confirmDeleteTag.name) setSel(null);
                setConfirmDeleteTag(null);
              }}>
                {tr.deleteTag}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
