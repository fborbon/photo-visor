import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useTags }    from '../context/TagsContext';
import { useLang }    from '../context/LangContext';
import { usePrivacy } from '../context/PrivacyContext';
import { PhotoEntry } from '../types';
import { useNav, scrollToHash } from '../context/NavContext';
import { useFavorites } from '../context/FavoritesContext';
import PhotoGrid from './PhotoGrid';
import config from '../config';
import {
  sysTagCountryKey, sysTagCityKey, sysTagCoords, sysTagLabel,
  translateCountry,
} from '../utils/sysTags';

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// React 18 concurrent-mode / react-leaflet race: cleanup can fire on a marker
// whose onAdd never ran (so _icon is never set). Skip cleanup when there is
// nothing to clean up — this is always correct because _icon undefined means
// the icon was never added to the DOM.
(function patchMarkerRemoveIcon() {
  type Proto = { _removeIcon?: () => void; _pv_patched?: boolean };
  const proto = L.Marker.prototype as unknown as Proto;
  if (proto._pv_patched || !proto._removeIcon) return;
  const orig = proto._removeIcon;
  proto._removeIcon = function(this: { _icon?: Element }) {
    if (!this._icon) return;
    orig.call(this);
  };
  proto._pv_patched = true;
})();

const DEFAULT_ICON = new L.Icon.Default();

const SELECTED_ICON = L.divIcon({
  className: '',
  html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 41" width="29" height="47">
    <path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0z"
          fill="#FF7A00" stroke="#cc5500" stroke-width="1"/>
    <circle cx="12.5" cy="12.5" r="5" fill="white" opacity="0.9"/>
  </svg>`,
  iconSize:    [29, 47],
  iconAnchor:  [14, 47],
  popupAnchor: [1, -40],
});

// Leaflet control that shows the welcome greeting 2 rows below the zoom buttons (desktop only).
function WelcomeControl({ greeting }: { greeting: string }) {
  const map = useMap();
  useEffect(() => {
    const ctrl = new (L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'map-welcome-ctrl');
        div.textContent = greeting;
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    }))({ position: 'topleft' });
    ctrl.addTo(map);
    return () => { ctrl.remove(); };
  }, [map, greeting]);
  return null;
}

// Renders nothing; tells the parent when the Leaflet map has fired its first
// "load" event (i.e. map._loaded is true). We must not render Markers before
// that point: addLayer defers onAdd when _loaded is false, which leaves
// _icon undefined, causing a crash if React cleans up the Marker first.
function MapReadyGuard({ onReady }: { onReady: () => void }) {
  const map = useMapEvents({ load: onReady });
  useEffect(() => {
    if ((map as unknown as Record<string, unknown>)._loaded) onReady();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function FitAllBounds({ markers, skip }: { markers: { lat: number; lng: number }[]; skip?: boolean }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || skip || markers.length === 0) return;
    fittedRef.current = true;
    const bounds = L.latLngBounds(markers.map(m => [m.lat, m.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  }, [map, markers, skip]);
  return null;
}

function FlyToMarker({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => { map.flyTo([lat, lng], 10, { duration: 1 }); }, [map, lat, lng]);
  return null;
}

interface PanelAlbum { slug: string; label: string; tagName: string; }
interface PanelState {
  title:    string;
  albums:   PanelAlbum[];
  fallback: string;
}
interface AlbumSection { label: string; tagName: string; photos: PhotoEntry[]; }

const PANEL_PAGE           = 100;
const PANEL_LAZY_THRESHOLD = 1000;
const PANEL_DEFAULT_WIDTH  = 380;
const VIDEO_EXTS = /\.(mp4|mov|avi|3gp|wmv|mp3|mpg|vob)$/i;

function isVideo(photo: PhotoEntry) {
  return VIDEO_EXTS.test(photo.s3_key ?? '') || !!photo.video_proxy;
}

export default function MapView({ displayName }: { displayName?: string }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 767;
  const [mapLoaded,        setMapLoaded]        = useState(false);
  const [flyTarget,        setFlyTarget]        = useState<{ lat: number; lng: number } | null>(null);
  const [panel,            setPanel]            = useState<PanelState | null>(null);
  const [panelSections,    setPanelSections]    = useState<AlbumSection[] | null>(null);
  const [panelLoading,     setPanelLoading]     = useState(false);
  const [selectedAlbumIdx, setSelectedAlbumIdx] = useState(0);
  const [panelWidth,       setPanelWidth]       = useState(PANEL_DEFAULT_WIDTH);
  const [secVisible,       setSecVisible]       = useState<Map<number, number>>(new Map());
  const panelBodyRef    = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const widthDragRef    = useRef<{ startX: number; startW: number } | null>(null);
  const vDragRef        = useRef<{ startY: number; startPx: number } | null>(null);
  const scrollToEndRef  = useRef(false);
  const [tocHeight, setTocHeight] = useState(160);
  const [sheetHeight, setSheetHeight] = useState(65); // vh for mobile bottom sheet
  const sheetDragRef = useRef<{ startY: number; startVh: number } | null>(null);

  function onWidthDragStart(e: React.PointerEvent) {
    widthDragRef.current = { startX: e.clientX, startW: panelWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onWidthDragMove(e: React.PointerEvent) {
    if (!widthDragRef.current) return;
    const dx = widthDragRef.current.startX - e.clientX;
    setPanelWidth(Math.max(280, Math.min(720, widthDragRef.current.startW + dx)));
  }
  function onWidthDragEnd() { widthDragRef.current = null; }

  function onVDragStart(e: React.PointerEvent) {
    vDragRef.current = { startY: e.clientY, startPx: tocHeight };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onVDragMove(e: React.PointerEvent) {
    if (!vDragRef.current) return;
    const dy = e.clientY - vDragRef.current.startY;
    setTocHeight(Math.max(40, Math.min(600, vDragRef.current.startPx + dy)));
  }
  function onVDragEnd() { vDragRef.current = null; }

  function onSheetDragStart(e: React.PointerEvent) {
    sheetDragRef.current = { startY: e.clientY, startVh: sheetHeight };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onSheetDragMove(e: React.PointerEvent) {
    if (!sheetDragRef.current) return;
    const dy = sheetDragRef.current.startY - e.clientY;
    const dvh = (dy / window.innerHeight) * 100;
    setSheetHeight(Math.max(20, Math.min(90, sheetDragRef.current.startVh + dvh)));
  }
  function onSheetDragEnd() { sheetDragRef.current = null; }

  // Fetch photos for every album in the panel, sort sections by earliest date ascending.
  useEffect(() => {
    panelBodyRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    setSecVisible(new Map());
    setSelectedAlbumIdx(0);
    if (!panel) { setPanelSections(null); setPanelLoading(false); return; }
    let cancelled = false;
    setPanelLoading(true);
    setPanelSections(null);
    Promise.all(
      panel.albums.map(album =>
        fetch(config.indexBase + '/index/sys/' + album.slug + '.json')
          .then(r => r.json() as Promise<PhotoEntry[]>)
          .catch(() => [] as PhotoEntry[])
          .then(photos => ({ label: album.label, tagName: album.tagName, photos }))
      )
    ).then(sections => {
      if (cancelled) return;
      const filled = sections.filter(s => s.photos.length > 0);
      // Sort sections by earliest photo date ascending
      filled.sort((a, b) => {
        const minDt = (s: AlbumSection) =>
          s.photos.reduce((m, p) => (p.dt && p.dt < m ? p.dt : m), '9999');
        return minDt(a).localeCompare(minDt(b));
      });
      // Within each album: photos first (newest date first), videos at the end
      filled.forEach(sec => {
        sec.photos.sort((a, b) => {
          const av = isVideo(a), bv = isVideo(b);
          if (av !== bv) return av ? 1 : -1;
          return (b.dt ?? '9999').localeCompare(a.dt ?? '9999');
        });
      });
      setPanelSections(filled);
      setPanelLoading(false);
    });
    return () => { cancelled = true; };
  }, [panel]);

  // Reset scroll only when the album selection or panel changes (not on secVisible updates).
  useEffect(() => {
    panelBodyRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [panelSections, selectedAlbumIdx]);

  // Lazy-load more photos for the active section as the user scrolls.
  useEffect(() => {
    const container = panelBodyRef.current;
    if (!container || !panelSections) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const total = panelSections[selectedAlbumIdx]?.photos.length ?? 0;
        setSecVisible(prev => {
          const cur = prev.get(selectedAlbumIdx) ?? PANEL_PAGE;
          if (cur >= total) return prev;
          const next = new Map(prev);
          next.set(selectedAlbumIdx, Math.min(cur + PANEL_PAGE, total));
          return next;
        });
      });
    }, { root: container, threshold: 0 });
    container.querySelectorAll<HTMLElement>('[data-sec-sentinel]').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [panelSections, secVisible, selectedAlbumIdx]);

  const { pendingNav, clearNav } = useNav();
  const { systemTagIndex } = useTags();
  const { lang, tr }       = useLang();
  const { isOwner, isTagAllowed, dateCutoff } = usePrivacy();
  const { isFavorite, toggleFavorite } = useFavorites();

  // One marker per geographic location. All system tags that resolve to the same
  // country:city key are merged into one pin — the panel lists them as albums.
  const sysTagMarkers = useMemo(() => {
    type AlbumInfo = { slug: string; label: string; tagName: string; count: number };
    type LocEntry  = {
      lat: number; lng: number; country: string; city: string;
      albums: AlbumInfo[];
    };
    const byLocation = new Map<string, LocEntry>();

    for (const [name, meta] of Object.entries(systemTagIndex.tags)) {
      if (!isOwner && !meta.public && !isTagAllowed(name)) continue;
      if (dateCutoff && meta.latest_dt && meta.latest_dt < dateCutoff) continue;
      const country = sysTagCountryKey(name);
      const city    = sysTagCityKey(name);
      const coords: [number, number] | null =
        sysTagCoords(country, city) ??
        (meta.lat != null && meta.lng != null ? [meta.lat, meta.lng] : null);
      if (!coords) continue;
      const key = country + ':' + city;
      if (!byLocation.has(key))
        byLocation.set(key, { lat: coords[0], lng: coords[1], country, city, albums: [] });
      byLocation.get(key)!.albums.push({
        slug:    meta.slug,
        label:   sysTagLabel(name),
        tagName: name,
        count:   meta.count,
      });
    }

    return Array.from(byLocation.entries()).map(([key, loc]) => ({
      ...loc,
      key,
      count: loc.albums.reduce((s, a) => s + a.count, 0),
    }));
  }, [systemTagIndex, isOwner, isTagAllowed, dateCutoff]);

  // When this tab activates with a pending nav: find the right pin and open it.
  useEffect(() => {
    if (!pendingNav || !sysTagMarkers.length) return;
    const { tagName, mapCountry, mapCity } = pendingNav;
    const marker = sysTagMarkers.find(m => m.albums.some(a => a.tagName === tagName))
      ?? sysTagMarkers.find(m =>
        m.city === mapCity && translateCountry(m.country, 'en') === mapCountry
      );
    // Only skip if panel is already open for this exact tag.
    // Do NOT skip when tagName is undefined (navigating from Timeline/PathTags
    // where the tag isn't known) — undefined === undefined would incorrectly block.
    const alreadyOpen = tagName != null && panel?.albums.some(a => a.tagName === tagName);
    if (!marker || alreadyOpen) return;
    const dispCountry = translateCountry(marker.country, lang);
    const dispLabel   = marker.city ? `${marker.city}, ${dispCountry}` : dispCountry;
    setFlyTarget({ lat: marker.lat, lng: marker.lng });
    setPanel({
      title:    dispLabel,
      albums:   marker.albums.map(a => ({ slug: a.slug, label: a.label, tagName: a.tagName })),
      fallback: dispLabel,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, sysTagMarkers]);

  // When navigating to a specific photo hash, switch to the album that contains it.
  useEffect(() => {
    if (!pendingNav?.hash || !panelSections) return;
    const idx = panelSections.findIndex(s => s.photos.some(p => p.hash === pendingNav.hash));
    if (idx >= 0) setSelectedAlbumIdx(idx);
    scrollToHash(pendingNav.hash, panelBodyRef.current, clearNav);
  }, [panelSections, pendingNav, clearNav]);

  // Scroll to bottom after render when End button was clicked (loads all photos first)
  useLayoutEffect(() => {
    if (!scrollToEndRef.current) return;
    scrollToEndRef.current = false;
    if (panelBodyRef.current) {
      panelBodyRef.current.scrollTop = panelBodyRef.current.scrollHeight;
    }
  });

  const handleGoToStart = useCallback(() => {
    panelBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleGoToEnd = useCallback(() => {
    const sec = panelSections?.[selectedAlbumIdx];
    if (!sec) return;
    scrollToEndRef.current = true;
    setSecVisible(prev => {
      const next = new Map(prev);
      next.set(selectedAlbumIdx, sec.photos.length);
      return next;
    });
  }, [panelSections, selectedAlbumIdx]);

  return (
    <div className="map-layout">

      <div className="map-container">
        <MapContainer
          center={[20, 0]} zoom={2}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
          maxBounds={[[-90, -180], [90, 180]]}
          maxBoundsViscosity={1.0}
        >
          <MapReadyGuard onReady={() => setMapLoaded(true)} />
          {mapLoaded && sysTagMarkers.length > 0 && <FitAllBounds markers={sysTagMarkers} skip={!!pendingNav} />}
          {flyTarget && <FlyToMarker lat={flyTarget.lat} lng={flyTarget.lng} />}
          {displayName && <WelcomeControl greeting={displayName} />}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            noWrap
          />
          {mapLoaded && sysTagMarkers.map(m => {
            const dispCountry = translateCountry(m.country, lang);
            const dispCity    = m.city || dispCountry;
            const dispLabel   = m.city ? `${m.city}, ${dispCountry}` : dispCountry;
            const isSelected  = panel?.albums.some(a => m.albums.some(ma => ma.slug === a.slug)) ?? false;
            return (
              <Marker
                key={m.key}
                position={[m.lat, m.lng]}
                icon={isSelected ? SELECTED_ICON : DEFAULT_ICON}
                zIndexOffset={isSelected ? 1000 : 0}
                eventHandlers={{
                  click: () => setPanel({
                    title:    dispLabel,

                    albums:   m.albums.map(a => ({ slug: a.slug, label: a.label, tagName: a.tagName })),
                    fallback: dispLabel,
                  }),
                }}
              >
                <Popup>
                  <strong>{dispLabel}</strong>
                  <br />{m.count.toLocaleString()} {tr.photos}
                  {m.albums.length > 1 && <><br />{m.albums.length} albums</>}
                </Popup>
              </Marker>
            );
          })}

        </MapContainer>
      </div>

      {panel && (
        <div className="map-panel" style={isMobile ? { height: sheetHeight + 'vh' } : { width: panelWidth }}>
          {!isMobile && (
            <div
              className="panel-width-handle"
              onPointerDown={onWidthDragStart}
              onPointerMove={onWidthDragMove}
              onPointerUp={onWidthDragEnd}
              onPointerCancel={onWidthDragEnd}
            />
          )}
          <div
            className="panel-header"
            onPointerDown={isMobile ? onSheetDragStart : undefined}
            onPointerMove={isMobile ? onSheetDragMove : undefined}
            onPointerUp={isMobile ? onSheetDragEnd : undefined}
            onPointerCancel={isMobile ? onSheetDragEnd : undefined}
          >
            <div className="panel-header-left">
              <h2 className="panel-title">{panel.title}</h2>
            </div>
            <button className="panel-close" onClick={() => setPanel(null)}>✕</button>
          </div>

          <div className="panel-content" ref={panelContentRef}>
          {panelSections && panelSections.length > 1 && (
            <>
              <nav className="panel-toc" style={{ height: tocHeight, minHeight: 40, maxHeight: '70%' }}>
                {panelSections.map((sec, i) => (
                  <div key={i} className="panel-toc-row">
                    <button
                      className={'panel-toc-item' + (i === selectedAlbumIdx ? ' active' : '')}
                      onClick={() => {
                        setSelectedAlbumIdx(i);
                        panelBodyRef.current?.scrollTo({ top: 0, behavior: 'instant' });
                      }}
                    >
                      {sec.label}<span className="toc-item-count"> · {sec.photos.length}</span>
                    </button>
                    <span
                      className={'fav-star' + (isFavorite(sec.tagName) ? ' fav-star--on' : '')}
                      role="button"
                      tabIndex={0}
                      title={isFavorite(sec.tagName) ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={() => toggleFavorite(sec.tagName)}
                      onKeyDown={e => { if (e.key === 'Enter') toggleFavorite(sec.tagName); }}
                    >★</span>
                  </div>
                ))}
              </nav>
              <div
                className="panel-v-drag"
                onPointerDown={onVDragStart}
                onPointerMove={onVDragMove}
                onPointerUp={onVDragEnd}
                onPointerCancel={onVDragEnd}
              />
            </>
          )}

          {panelSections && panelSections.length > 0 && (
            <div className="panel-nav-bar">
              <button className="panel-nav-btn" onClick={handleGoToStart}>▲</button>
              <button className="panel-nav-btn" onClick={handleGoToEnd}>▼</button>
            </div>
          )}

          <div className="panel-body" ref={panelBodyRef}>
            {panelLoading && <p className="panel-loading">{tr.loadingPhotos}</p>}
            {panelSections && (() => {
              const sec   = panelSections[selectedAlbumIdx];
              if (!sec) return null;
              const shown   = pendingNav?.hash ? sec.photos.length : (secVisible.get(selectedAlbumIdx) ?? PANEL_PAGE);
              const hasMore = sec.photos.length > shown;
              return (
                <div className="album-section">
                  {panelSections.length === 1 && (
                    <div className="album-section-hdr">
                      <span className="album-section-title">{sec.label} <span className="album-section-count">· {sec.photos.length}</span></span>
                      <span
                        className={'fav-star' + (isFavorite(sec.tagName) ? ' fav-star--on' : '')}
                        role="button"
                        tabIndex={0}
                        title={isFavorite(sec.tagName) ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={() => toggleFavorite(sec.tagName)}
                        onKeyDown={e => { if (e.key === 'Enter') toggleFavorite(sec.tagName); }}
                      >★</span>
                    </div>
                  )}
                  <PhotoGrid
                    photos={sec.photos.slice(0, shown)}
                    placeFallback={panel.fallback}
                    navMode="map"
                    navTagName={sec.tagName}
                    defaultSort="newest"
                  />
                  {hasMore && <div style={{ height: 1 }} data-sec-sentinel={selectedAlbumIdx} />}
                </div>
              );
            })()}
          </div>
          </div>{/* panel-content */}
        </div>
      )}
    </div>
  );
}
