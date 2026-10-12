// The Overview's map of the day's visits on OpenStreetMap (2026-09-26, the user's experiment with
// replacing Google Maps; switch back with VITE_OVERVIEW_MAP=google). Same behaviour as
// VisitsMap.tsx: one dot per home in the most urgent visit's colour, the home's summary on hover,
// a click pinning it for touch screens, and hover mirrored from the page's visit list. Leaflet and
// the tiles are the ones the dependant form's ward map already uses, so it needs no API key. The
// tiles are desaturated in CSS so the status colours stay the loudest thing on the map, as the
// Google version's muted style does.

import 'leaflet/dist/leaflet.css';
import { latLngBounds } from 'leaflet';
import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { OverviewVisit } from '../api/dashboard';
import { HomeSummary } from './HomeSummary';
import { groupByHome, type Home } from './homes';
import { STATE_HEX, mostUrgent } from './visitStates';
import './VisitsMap.css';

export interface OsmVisitsMapProps {
  visits: OverviewVisit[];
  timeZone: string;
  /** The dependant whose home is highlighted, from a dot or a row in the page's list. */
  activeId: string | null;
  onActiveChange: (dependantId: string | null) => void;
}

// Nairobi, for a day with nothing to show.
const DEFAULT_CENTER: [number, number] = [-1.2864, 36.8172];

/**
 * Frames the homes whenever the set of homes changes (a new day or filter), not on every
 * re-render - refitting on each minute's refresh would undo the supervisor's own pan and zoom.
 */
function FrameHomes({ homes }: { homes: Home[] }) {
  const map = useMap();
  const homesKey = homes.map((h) => h.dependantId).join(',');
  useEffect(() => {
    if (homes.length === 0) {
      map.setView(DEFAULT_CENTER, 11);
    } else if (homes.length === 1) {
      map.setView([homes[0]!.position.lat, homes[0]!.position.lng], 15);
    } else {
      map.fitBounds(latLngBounds(homes.map((h) => [h.position.lat, h.position.lng])), {
        padding: [48, 48],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- homesKey stands for homes
  }, [map, homesKey]);
  return null;
}

export function OsmVisitsMap({ visits, timeZone, activeId, onActiveChange }: OsmVisitsMapProps) {
  const homes = useMemo(() => groupByHome(visits), [visits]);

  return (
    <div className="visits-map visits-map--osm">
      <MapContainer className="visits-map__canvas" center={DEFAULT_CENTER} zoom={11}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FrameHomes homes={homes} />
        {homes.map((home) => {
          const state = mostUrgent(home.visits.map((v) => v.state));
          const isActive = home.dependantId === activeId;
          return (
            <CircleMarker
              key={home.dependantId}
              center={[home.position.lat, home.position.lng]}
              radius={isActive ? 10 : 8}
              pathOptions={{
                fillColor: STATE_HEX[state],
                fillOpacity: 1,
                // The 2px white ring keeps neighbouring dots apart where they overlap.
                color: '#ffffff',
                weight: 2,
              }}
              eventHandlers={{
                mouseover: () => onActiveChange(home.dependantId),
                mouseout: () => onActiveChange(null),
                click: () => onActiveChange(isActive ? null : home.dependantId),
              }}
            >
              {/* Open only for the active home, so a row in the visit list opens it too. */}
              {isActive ? (
                <Tooltip
                  permanent
                  direction="top"
                  offset={[0, -12]}
                  className="visits-map__leaflet-tooltip"
                >
                  <HomeSummary home={home} timeZone={timeZone} />
                </Tooltip>
              ) : null}
            </CircleMarker>
          );
        })}
      </MapContainer>
      {homes.length === 0 ? (
        <div className="visits-map__empty">No visits to show for this day.</div>
      ) : null}
    </div>
  );
}
