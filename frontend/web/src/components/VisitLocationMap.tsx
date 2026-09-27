// A small OpenStreetMap for one visit (2026-09-27, the Visits side panel): the dependant's home,
// with the area check-in accepts drawn around it, and where the caregiver actually checked in,
// framed so both show. The pins are drawn in CSS rather than Leaflet's default marker images,
// which don't survive bundling.

import 'leaflet/dist/leaflet.css';
import { divIcon, latLng } from 'leaflet';
import { useEffect } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import './VisitLocationMap.css';

type Point = { lat: number; lng: number };

const homeIcon = divIcon({
  className: '',
  html: '<span class="visit-map__pin visit-map__pin--home"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const checkinIcon = divIcon({
  className: '',
  html: '<span class="visit-map__pin visit-map__pin--checkin"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** Frames the home's whole accepted area, and the check-in point when there is one. */
function Frame({ home, checkin, radius }: { home: Point; checkin: Point | null; radius: number }) {
  const map = useMap();
  // Keyed on the coordinates, not the point objects, so a re-render doesn't refit the map.
  const checkinLat = checkin?.lat;
  const checkinLng = checkin?.lng;
  useEffect(() => {
    const bounds = latLng(home.lat, home.lng).toBounds(radius * 2);
    if (checkinLat !== undefined && checkinLng !== undefined) {
      bounds.extend([checkinLat, checkinLng]);
    }
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 17 });
  }, [map, home.lat, home.lng, checkinLat, checkinLng, radius]);
  return null;
}

export function VisitLocationMap({
  home,
  radiusMeters,
  checkin,
}: {
  home: Point;
  radiusMeters: number;
  /** Where the caregiver checked in, if they have. */
  checkin: Point | null;
}) {
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
        <Marker position={[home.lat, home.lng]} icon={homeIcon} keyboard={false} />
        {checkin ? (
          <Marker position={[checkin.lat, checkin.lng]} icon={checkinIcon} keyboard={false} />
        ) : null}
        <Frame home={home} checkin={checkin} radius={radiusMeters} />
      </MapContainer>
    </div>
  );
}
