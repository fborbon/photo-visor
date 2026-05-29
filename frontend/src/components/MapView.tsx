import { useState, useMemo, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useTags }    from '../context/TagsContext';
import { useLang }    from '../context/LangContext';
import { usePrivacy } from '../context/PrivacyContext';
import { PhotoEntry } from '../types';
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

interface PanelState {
  title:    string;
  slugs:    string[];
  fallback: string;
}

export default function MapView({ displayName }: { displayName?: string }) {
  const [mapLoaded, setMapLoaded] = useState(false);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [panelPhotos, setPanelPhotos] = useState<PhotoEntry[] | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const panelBodyRef = useRef<HTMLDivElement>(null);

  // Load all slugs for the active panel in parallel and merge results
  useEffect(() => {
    panelBodyRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    if (!panel) { setPanelPhotos(null); setPanelLoading(false); return; }
    let cancelled = false;
    setPanelLoading(true);
    setPanelPhotos(null);
    Promise.all(
      panel.slugs.map(slug =>
        fetch(config.cloudFrontUrl + '/index/sys/' + slug + '.json')
          .then(r => r.json() as Promise<PhotoEntry[]>)
          .catch(() => [] as PhotoEntry[])
      )
    ).then(arrays => {
      if (!cancelled) {
        setPanelPhotos(arrays.flat());
        setPanelLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [panel]);

  const { systemTagIndex } = useTags();
  const { lang, tr } = useLang();
  const { isOwner } = usePrivacy();

  // One marker per sys tag. When multiple tags share the same base coordinate,
  // spread them in a circle so they appear as distinct pins (not merged).
  const sysTagMarkers = useMemo(() => {
    type Entry = { lat: number; lng: number; country: string; city: string; slug: string; name: string; count: number; };
    const byLocation = new Map<string, Entry[]>();
    for (const [name, meta] of Object.entries(systemTagIndex.tags)) {
      if (!isOwner && !meta.public) continue;
      const country = sysTagCountryKey(name);
      const city    = sysTagCityKey(name);
      const coords  = sysTagCoords(country, city);
      if (!coords) continue;
      const key = country + ':' + city;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push({ lat: coords[0], lng: coords[1], country, city, slug: meta.slug, name, count: meta.count });
    }

    // Minimum radius so adjacent pins don't overlap, + 15% margin.
    // chord = 2R·sin(π/n) >= PIN_DEG  →  R = PIN_DEG / (2·sin(π/n)) × 1.15
    const PIN_DEG = 0.010;
    const result: (Entry & { key: string })[] = [];
    for (const entries of byLocation.values()) {
      if (entries.length === 1) {
        result.push({ ...entries[0], key: entries[0].slug });
      } else {
        const n      = entries.length;
        const radius = (PIN_DEG / (2 * Math.sin(Math.PI / n))) * 1.15;
        entries.forEach((e, i) => {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2;
          result.push({ ...e, key: e.slug,
            lat: e.lat + radius * Math.cos(angle),
            lng: e.lng + radius * Math.sin(angle),
          });
        });
      }
    }
    return result;
  }, [systemTagIndex]);

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
          {displayName && <WelcomeControl greeting={displayName} />}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            noWrap
          />
          {mapLoaded && sysTagMarkers.map(m => {
            const label       = sysTagLabel(m.name);
            const dispCountry = translateCountry(m.country, lang);
            const dispLabel   = label ? `${label}, ${dispCountry}` : dispCountry;
            const isSelected  = panel?.slugs.includes(m.slug) ?? false;
            return (
              <Marker
                key={m.key}
                position={[m.lat, m.lng]}
                icon={isSelected ? SELECTED_ICON : DEFAULT_ICON}
                zIndexOffset={isSelected ? 1000 : 0}
                eventHandlers={{
                  click: () => setPanel({ title: dispLabel, slugs: [m.slug], fallback: dispLabel }),
                }}
              >
                <Popup>
                  <strong>{dispLabel}</strong>
                  <br />{m.count.toLocaleString()} {tr.photos}
                </Popup>
              </Marker>
            );
          })}

        </MapContainer>
      </div>

      {panel && (
        <div className="map-panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <h2 className="panel-title">{panel.title}</h2>
            </div>
            <button className="panel-close" onClick={() => setPanel(null)}>✕</button>
          </div>

          <div className="panel-body" ref={panelBodyRef}>
            {panelLoading && <p className="panel-loading">{tr.loadingPhotos}</p>}
            {panelPhotos  && (
              <PhotoGrid
                photos={panelPhotos}
                placeFallback={panel.fallback}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
