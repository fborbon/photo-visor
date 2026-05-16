import { useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { useIndex }   from '../hooks/useIndex';
import { usePrivacy } from '../context/PrivacyContext';
import { useTags }    from '../context/TagsContext';
import { useLang }    from '../context/LangContext';
import { Summary, LocationSummary, PhotoEntry } from '../types';
import PhotoGrid   from './PhotoGrid';
import ContextMenu from './ContextMenu';
import AddTagModal from './AddTagModal';

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function locationKey(loc: LocationSummary): string {
  const country = loc.country || 'Unknown';
  const city    = loc.city    || 'Unknown';
  return (country + '_' + city).replace(/[^\w-]/g, '_');
}

interface PanelState {
  title:    string;
  albumKey: string;
  indexKey: string;
}

export default function MapView() {
  const { data: summary, loading, error } = useIndex<Summary>('index/summary.json');
  const [panel, setPanel] = useState<PanelState | null>(null);
  const { data: panelPhotos, loading: panelLoading } = useIndex<PhotoEntry[]>(
    panel ? panel.indexKey : null
  );
  const { isOwner, isAlbumPrivate, toggleAlbum } = usePrivacy();
  const { addAlbumToTag } = useTags();
  const { tr } = useLang();
  const [albumMenu, setAlbumMenu] = useState<{ x: number; y: number } | null>(null);
  const [addTagAlbum, setAddTagAlbum] = useState(false);

  // Non-owners don't see private album markers
  const validLocations = (summary?.locations ?? []).filter(l => {
    if (!l.lat || !l.lng) return false;
    const key = locationKey(l);
    return isOwner || !isAlbumPrivate(key);
  });

  const albumPrivate = panel ? isAlbumPrivate(panel.albumKey) : false;

  return (
    <div className="map-layout">

      <div className="map-container">
        {loading && <div className="map-overlay-msg">{tr.loadingLocations}</div>}
        {error   && <div className="map-overlay-msg error">{error}</div>}

        <MapContainer center={[20, 0]} zoom={2} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MarkerClusterGroup chunkedLoading>
            {validLocations.map(loc => {
              const key = locationKey(loc);
              return (
                <Marker
                  key={key}
                  position={[loc.lat!, loc.lng!]}
                  eventHandlers={{
                    click: () => setPanel({
                      title:    [loc.city, loc.country].filter(Boolean).join(', '),
                      albumKey: key,
                      indexKey: 'index/geo/' + key + '.json',
                    }),
                  }}
                >
                  <Popup>
                    <strong>{[loc.city, loc.country].filter(Boolean).join(', ')}</strong>
                    <br />{loc.count.toLocaleString()} photos
                    {isOwner && isAlbumPrivate(key) && <><br />🔒 {tr.privateMarker}</>}
                  </Popup>
                </Marker>
              );
            })}
          </MarkerClusterGroup>
        </MapContainer>
      </div>

      {panel && (
        <div className="map-panel">
          <div
            className="panel-header"
            onContextMenu={e => { e.preventDefault(); setAlbumMenu({ x: e.clientX, y: e.clientY }); }}
          >
            <div className="panel-header-left">
              <h2 className="panel-title">
                {albumPrivate && <span className="panel-lock-badge">🔒</span>}
                {panel.title}
              </h2>
              {isOwner && (
                <label className="album-privacy-toggle" title={albumPrivate ? tr.makePublic : tr.makePrivate}>
                  <input
                    type="checkbox"
                    checked={albumPrivate}
                    onChange={() => toggleAlbum(panel.albumKey)}
                  />
                  <span>{albumPrivate ? tr.privateAlbum : tr.publicAlbum}</span>
                </label>
              )}
            </div>
            <button className="panel-close" onClick={() => setPanel(null)}>✕</button>
          </div>

          {albumMenu && panel && (
            <ContextMenu
              x={albumMenu.x} y={albumMenu.y}
              items={[{ label: '🏷 ' + tr.addTagToAlbum, onClick: () => setAddTagAlbum(true) }]}
              onClose={() => setAlbumMenu(null)}
            />
          )}
          {addTagAlbum && panel && (
            <AddTagModal
              onAdd={(tagName, shared) => addAlbumToTag({ key: panel.albumKey, title: panel.title }, tagName, shared)}
              onClose={() => setAddTagAlbum(false)}
            />
          )}

          <div className="panel-body">
            {panelLoading && <p className="panel-loading">{tr.loadingPhotos}</p>}
            {panelPhotos  && (
              <PhotoGrid
                photos={panelPhotos}
                albumKey={panel.albumKey}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
