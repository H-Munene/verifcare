// A small OpenStreetMap for one visit (2026-09-27, the visit side panel): the dependant's home,
// with the area check-in accepts drawn around it. The home pin shows how the visit went (user
// request): red with a white cross for missed, green with a white tick for completed, yellow with
// a white ellipsis while it's ongoing, grey with a white cross for cancelled, and grey with a white
// dash while it's still scheduled.
// It is the map's only pin (user request, 2026-09-27): a separate blue check-in pin sat on top of
// it, since a caregiver checks in inside the home's radius, and hid the state; the check-in
// distance is in the panel's facts instead. The pin names itself on hover, and is drawn with HTML
// and SVG rather than Leaflet's default marker images, which don't survive bundling.

import 'leaflet/dist/leaflet.css';
import { divIcon, latLng } from 'leaflet';
import { useEffect, useMemo } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import './VisitLocationMap.css';

type Point = { lat: number; lng: number };

export type HomeState = 'missed' | 'completed' | 'ongoing' | 'cancelled' | 'scheduled';

// White glyphs on the coloured pin, as small inline SVG (14px, 2px strokes).
const GLYPHS: Record<HomeState, string> = {
  missed: '<path d="M4 4l6 6M10 4l-6 6" />',
  cancelled: '<path d="M4 4l6 6M10 4l-6 6" />',
  completed: '<path d="M3.5 7.5l2.5 2.5 4.5-5" />',
  ongoing:
    '<circle cx="3.5" cy="7" r="0.9" fill="#fff" /><circle cx="7" cy="7" r="0.9" fill="#fff" /><circle cx="10.5" cy="7" r="0.9" fill="#fff" />',
  scheduled: '<path d="M3.5 7h7" />',
};

function pin(className: string, glyph = ''): ReturnType<typeof divIcon> {
  return divIcon({
    className: '',
    html: `<span class="visit-map__pin ${className}">${
      glyph
        ? `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`
        : ''
    }</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

const STATE_TITLES: Record<HomeState, string> = {
  missed: 'missed visit',
  completed: 'visit completed',
  ongoing: 'visit in progress',
  cancelled: 'visit cancelled',
  scheduled: 'visit scheduled',
};

/** Frames the home's whole accepted area. */
function Frame({ home, radius }: { home: Point; radius: number }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(latLng(home.lat, home.lng).toBounds(radius * 2), {
      padding: [32, 32],
      maxZoom: 17,
    });
  }, [map, home.lat, home.lng, radius]);
  return null;
}

export function VisitLocationMap({
  home,
  homeLabel,
  homeState,
  radiusMeters,
}: {
  home: Point;
  /** Names the home pin on hover, e.g. "Wanjiku's home". */
  homeLabel: string;
  homeState: HomeState;
  radiusMeters: number;
}) {
  const homeIcon = useMemo(
    () => pin(`visit-map__pin--${homeState}`, GLYPHS[homeState]),
    [homeState],
  );
  const homeTitle = STATE_TITLES[homeState]
    ? `${homeLabel}, ${STATE_TITLES[homeState]}`
    : homeLabel;

  return (
    <div className="visit-map">
      <MapContainer
        className="visit-map__canvas"
        center={[home.lat, home.lng]}
        zoom={16}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Circle
          center={[home.lat, home.lng]}
          radius={radiusMeters}
          pathOptions={{ color: '#0077e6', weight: 1.5, fillColor: '#0077e6', fillOpacity: 0.08 }}
        />
        <Marker
          position={[home.lat, home.lng]}
          icon={homeIcon}
          title={homeTitle}
          keyboard={false}
        />
        <Frame home={home} radius={radiusMeters} />
      </MapContainer>
    </div>
  );
}
