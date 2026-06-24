import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTags }       from '../context/TagsContext';
import { useLang }       from '../context/LangContext';
import { usePrivacy }    from '../context/PrivacyContext';
import { useNav, scrollToHash } from '../context/NavContext';
import { useFavorites }  from '../context/FavoritesContext';
import { useIndex }      from '../hooks/useIndex';
import { PhotoEntry } from '../types';
import PhotoGrid from './PhotoGrid';
import { sysTagCountryKey, sysTagCityKey, sysTagLabel, translateCountry, translateCity } from '../utils/sysTags';
import { displayNameForEmail } from '../config';

type Scope = 'private' | 'shared' | 'system' | 'path';
interface Selected { name: string; s3Path?: string; scope: Scope; slug?: string; }

const MIN_RAIL = 150;
const MAX_RAIL = 600;
const DEFAULT_RAIL = 273;

// ── Path tree ──────────────────────────────────────────────────────────────
// Source of truth: index/path_tags.json
// Each entry: { display: "disk-style path", s3: "S3 general-index key" }
// Built by cross-referencing the actual S3 index against folders.txt.
// display = exact disk name where available; underscore→space fallback otherwise.

interface TagPath { display: string; s3: string; }

interface TreeNode {
  name:     string;   // last segment of display path
  fullPath: string;   // full display path — selection key
  s3Path:   string;   // S3 key for index/general/{s3Path}.json (empty = intermediate)
  children: Record<string, TreeNode>;
}

function buildPathTree(tagPaths: TagPath[]): Record<string, TreeNode> {
  const s3Map = new Map(tagPaths.map(t => [t.display, t.s3]));
  const root: Record<string, TreeNode> = {};

  for (const { display } of tagPaths) {
    const segs = display.split('/');
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg      = segs[i];
      const nodePath = segs.slice(0, i + 1).join('/');
      if (!cur[seg]) {
        cur[seg] = {
          name:     seg,
          fullPath: nodePath,
          s3Path:   s3Map.get(nodePath) ?? '',
          children: {},
        };
      }
      cur = cur[seg].children;
    }
  }
  return root;
}

function diskPathToDisplay(displayPath: string): string {
  return 'Fotos/' + displayPath;
}


interface PathTreeNodeProps {
  node:            TreeNode;
  depth:           number;
  expandedPaths:   Set<string>;
  selectedPath:    string | null;
  highlightedPath: string | null;
  onToggle:        (path: string) => void;
  onSelect:        (vPath: string, s3Path: string) => void;
}

function PathTreeNode({ node, depth, expandedPaths, selectedPath, highlightedPath, onToggle, onSelect }: PathTreeNodeProps) {
  const hasChildren   = Object.keys(node.children).length > 0;
  const isExpanded    = expandedPaths.has(node.fullPath);
  const isSelected    = selectedPath === node.fullPath;
  const isHighlighted = highlightedPath === node.fullPath;
  const { isFavorite, toggleFavorite } = useFavorites();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isHighlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [isHighlighted]);

  const handleRowClick = () => {
    if (hasChildren) {
      onToggle(node.fullPath);
    } else {
      onSelect(node.fullPath, node.s3Path);
    }
  };

  return (
    <>
      <div
        ref={rowRef}
        className={'path-tree-row' + (isSelected ? ' active' : '') + (isHighlighted ? ' highlighted' : '')}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={handleRowClick}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleRowClick(); }}
      >
        <span className={'path-tree-arrow' + (hasChildren ? ' visible' : '')}>
          {hasChildren ? (isExpanded ? '▾' : '▸') : ''}
        </span>
        <span className="path-tree-icon">📁</span>
        <span className="path-tree-label">{node.name}</span>
        <span
          className={'fav-star' + (isFavorite(node.fullPath) ? ' fav-star--on' : '')}
          role="button"
          tabIndex={0}
          title={isFavorite(node.fullPath) ? 'Remove from favorites' : 'Add to favorites'}
          onClick={e => { e.stopPropagation(); toggleFavorite(node.fullPath); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); toggleFavorite(node.fullPath); } }}
        >★</span>
      </div>

      {isExpanded && hasChildren && (
        Object.entries(node.children)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => (
            <PathTreeNode
              key={key}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              highlightedPath={highlightedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
      )}
    </>
  );
}

// ── Section heading ────────────────────────────────────────────────────────
interface SectionHeadingProps {
  open:     boolean;
  onToggle: () => void;
  children: React.ReactNode;
  style?:   React.CSSProperties;
}
function SectionHeading({ open, onToggle, children, style }: SectionHeadingProps) {
  return (
    <button className="rail-group-heading rail-group-heading--btn" style={style} onClick={onToggle}>
      <span className={'rail-chevron' + (open ? ' open' : '')}>›</span>
      {children}
    </button>
  );
}

/** Render a disk path as a human-readable breadcrumb with Fotos/ prefix. */
function folderFullLabel(diskPath: string) {
  return diskPathToDisplay(diskPath).replace(/\//g, ' / ');
}

// ── Main component ─────────────────────────────────────────────────────────
export default function TagsView() {
  const { tags, tagNames, sharedTags, sharedTagNames, systemTagIndex, systemTagsLoading, deleteTag, isMySharedTag } = useTags();
  const { lang, tr } = useLang();
  const { isOwner } = usePrivacy();
  const { pendingNav, clearNav, navigate } = useNav();
  // When this component mounts due to a folder-path navigation, bypass the module-level
  // useIndex cache (which may hold a stale path_tags.json from earlier in the session).
  const [pathTagsKey] = useState(() =>
    pendingNav?.folderPath ? `index/path_tags.json?nc=${Date.now()}` : 'index/path_tags.json'
  );
  const { favorites, isFavorite, toggleFavorite } = useFavorites();
  const [sel, setSel] = useState<Selected | null>(null);
  const [sysFilter,  setSysFilter]  = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<{ name: string; shared: boolean } | null>(null);

  // Section collapse
  const [favOpen,      setFavOpen]      = useState(true);
  const [personalOpen, setPersonalOpen] = useState(true);
  const [systemOpen,   setSystemOpen]   = useState(true);
  const [pathOpen,     setPathOpen]     = useState(true);

  // Path tree expand state
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  // Path tags: {display, s3}[] — every entry has a real S3 index file
  // Non-owners only see Camera/ subtree
  const { data: tagPathsData } = useIndex<TagPath[]>(pathTagsKey);
  const tagPaths   = useMemo(() => {
    const all = tagPathsData ?? [];
    if (isOwner) return all;
    return all.filter(t => t.display.startsWith('Camera/'));
  }, [tagPathsData, isOwner]);
  const folderPaths = useMemo(() => tagPaths.map(t => t.display), [tagPaths]);

  // Build tree — non-owners only see Camera/ subtree
  const pathTree = useMemo(() => buildPathTree(tagPaths), [tagPaths]);

  // Flat filtered list (used when search is active) — search on full display path
  const filteredPaths = useMemo(() => {
    if (!pathFilter.trim()) return [];
    const q = pathFilter.toLowerCase();
    return folderPaths.filter(p => diskPathToDisplay(p).toLowerCase().includes(q));
  }, [folderPaths, pathFilter]);

  // Resizable panel
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL);
  const [railVh, setRailVh]       = useState(40);
  const railDragRef = useRef<{ startY: number; startVh: number } | null>(null);
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

  // Album expand
  const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null);
  const { data: albumPhotos, loading: albumLoading } = useIndex<PhotoEntry[]>(
    expandedAlbum ? 'index/geo/' + expandedAlbum + '.json' : null
  );

  // Lazy-load system tag photos
  const { data: sysPhotos, loading: sysLoading } = useIndex<PhotoEntry[]>(
    sel?.scope === 'system' && sel.slug ? `index/sys/${sel.slug}.json` : null
  );

  // Lazy-load path tag photos using the derived S3 key
  const { data: pathPhotos, loading: pathLoading } = useIndex<PhotoEntry[]>(
    sel?.scope === 'path' && sel.s3Path ? `index/general/${sel.s3Path}.json` : null
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

  // Filtered system tag names
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

  const select = (name: string, scope: Scope, slug?: string, s3Path?: string) => {
    setSel({ name, scope, slug, s3Path });
    setExpandedAlbum(null);
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  };

  // Apply incoming nav: expand tree to target folder and scroll to photo hash.
  useEffect(() => {
    if (!pendingNav?.folderPath || !tagPaths.length) return;
    const target = tagPaths.find(t => t.display === pendingNav.folderPath)
      ?? tagPaths.find(t => pendingNav.folderPath!.startsWith(t.display));
    if (!target) return;
    // Expand all ancestors
    const parts = target.display.split('/');
    setExpandedPaths(prev => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
    select(target.display, 'path', undefined, target.s3);
    // Highlight tree row and scroll it into view
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedPath(target.display);
    highlightTimerRef.current = setTimeout(() => setHighlightedPath(null), 5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, tagPaths]);

  // After the folder's photos load, scroll to the target hash.
  useEffect(() => {
    if (!pendingNav?.hash || !sel) return;
    scrollToHash(pendingNav.hash, undefined, clearNav);
  }, [pendingNav, sel, clearNav]);

  const handleDeleteClick = (e: React.MouseEvent, name: string, shared: boolean) => {
    e.stopPropagation();
    setConfirmDeleteTag({ name, shared });
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 767;

  return (
    <div className="tags-layout">

      {/* ── Tag rail ─────────────────────────────────────── */}
      <aside className="tags-rail" style={isMobile ? { height: railVh + 'vh', maxHeight: railVh + 'vh' } : { width: railWidth }}>

        {/* ══ Favorites ══ */}
        {favorites.size > 0 && (
          <>
            <SectionHeading open={favOpen} onToggle={() => setFavOpen(v => !v)}>
              ⭐ Favorites
            </SectionHeading>
            {favOpen && [...favorites].sort().map(path => {
              const tagPath = tagPaths.find(t => t.display === path);
              const parts2 = path.split('/');
              const lastName = parts2[parts2.length - 1] ?? path;
              return (
                <div key={path} className="fav-row">
                  <button
                    className={'tag-rail-btn' + (sel?.name === path && sel.scope === 'path' ? ' active' : '')}
                    onClick={() => navigate('tags', { hash: '', folderPath: path })}
                    title={path}
                  >
                    <span className="tag-rail-name">📁 {lastName}</span>
                  </button>
                  <span
                    className="fav-star fav-star--on"
                    role="button"
                    tabIndex={0}
                    title="Remove from favorites"
                    onClick={() => toggleFavorite(path)}
                    onKeyDown={e => { if (e.key === 'Enter') toggleFavorite(path); }}
                  >★</span>
                </div>
              );
            })}
          </>
        )}

        {/* ══ Personal Tags ══ */}
        <SectionHeading open={personalOpen} onToggle={() => setPersonalOpen(v => !v)}>
          👤 {tr.personalTags}
        </SectionHeading>

        {personalOpen && (
          <>
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
          </>
        )}

        {/* ══ Path Tags — all users; non-owners see Camera/ only ══ */}
        <SectionHeading open={pathOpen} onToggle={() => setPathOpen(v => !v)} style={{ marginTop: '1rem' }}>
          📁 {tr.pathTags}
        </SectionHeading>

        {pathOpen && (
          <>
            <input
              className="sys-tag-filter"
              placeholder={tr.filterTags}
              value={pathFilter}
              onChange={e => setPathFilter(e.target.value)}
            />

            {/* Filter active → flat list of matching paths */}
            {pathFilter.trim() ? (
              filteredPaths.length === 0
                ? <p className="tags-empty-hint">{tr.noTagsMatch}</p>
                : tagPaths
                  .filter(t => diskPathToDisplay(t.display).toLowerCase().includes(pathFilter.toLowerCase()))
                  .map(({ display, s3 }) => {
                    const label = folderFullLabel(display);
                    return (
                      <button
                        key={'fp:' + s3}
                        className={'tag-rail-btn sys-tag sys-tag-city' + (sel?.name === display && sel.scope === 'path' ? ' active' : '')}
                        onClick={() => select(display, 'path', undefined, s3)}
                        title={label}
                      >
                        <span className="tag-rail-name">{label}</span>
                      </button>
                    );
                  })
            ) : (
              /* No filter → tree view */
              folderPaths.length === 0
                ? <p className="tags-empty-hint">{tr.loading}</p>
                : Object.entries(pathTree)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, node]) => (
                      <PathTreeNode
                        key={key}
                        node={node}
                        depth={0}
                        expandedPaths={expandedPaths}
                        selectedPath={sel?.scope === 'path' ? sel.name : null}
                        highlightedPath={highlightedPath}
                        onToggle={toggleExpanded}
                        onSelect={(diskPath, s3Path) => select(diskPath, 'path', undefined, s3Path)}
                      />
                    ))
            )}
          </>
        )}

      </aside>

      {/* ── Resize handle ─────────────────────────────────── */}
      {isMobile ? (
        <div
          className="tags-resize-handle-mobile"
          onPointerDown={e => {
            railDragRef.current = { startY: e.clientY, startVh: railVh };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={e => {
            if (!railDragRef.current) return;
            const dy = e.clientY - railDragRef.current.startY;
            const dvh = (dy / window.innerHeight) * 100;
            setRailVh(Math.max(15, Math.min(75, railDragRef.current.startVh + dvh)));
          }}
          onPointerUp={() => { railDragRef.current = null; }}
          onPointerCancel={() => { railDragRef.current = null; }}
        />
      ) : (
        <div className="tags-resize-handle" onMouseDown={onDragStart} />
      )}

      {/* ── Tag content ──────────────────────────────────── */}
      <div className="tags-main" ref={mainRef}>
        {!sel && <div className="timeline-hint">{tr.noTags}</div>}

        {/* Personal / Shared tag content */}
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
                        <PhotoGrid photos={albumPhotos} navMode="tags" />
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
                  <PhotoGrid photos={entry.photos} navMode="tags" defaultSort="newest" />
                  <div className="back-to-top-wrap">
                    <button className="back-to-top-btn" onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ {tr.backToTop ?? 'Back to top'}</button>
                  </div>
                </>
              )
              : !entry.albums.length ? <p className="panel-loading">{tr.noTaggedPhotos}</p> : null
            }
          </>
        )}

        {/* System tag content */}
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
                  navMode="tags"
                />
                <div className="back-to-top-wrap">
                  <button className="back-to-top-btn" onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ {tr.backToTop ?? 'Back to top'}</button>
                </div>
              </>
            )}
          </>
        )}

        {/* Path tag content */}
        {sel?.scope === 'path' && (
          <>
            <div className="tags-header">
              <h2 className="tags-selected-name">📁 {diskPathToDisplay(sel.name)}</h2>
              {pathPhotos && <span className="tag-owner-hint">{pathPhotos.length} {tr.taggedPhotos}</span>}
              <button
                className="path-copy-btn"
                title="Copy path for Sync tab Force path"
                onClick={() => navigator.clipboard.writeText(sel.name).catch(() => {})}
              >
                📋 Copy path
              </button>
            </div>
            {pathLoading && <p className="panel-loading">{tr.loading}</p>}
            {!pathLoading && pathPhotos === null && (
              <p className="panel-loading" style={{ color: '#555' }}>No photos indexed for this folder.</p>
            )}
            {pathPhotos && pathPhotos.length === 0 && (
              <p className="panel-loading">{tr.noTaggedPhotos}</p>
            )}
            {pathPhotos && pathPhotos.length > 0 && (
              <>
                <PhotoGrid photos={pathPhotos} placeFallback={folderFullLabel(sel.name)} navMode="path" defaultSort="newest" />
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
