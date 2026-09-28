// The Overview's map of the day's visits on Google Maps (2026-09-26, user request; the
// OpenStreetMap version is OsmVisitsMap.tsx, chosen by VITE_OVERVIEW_MAP): one dot per dependant's home,
// coloured by where the visit stands (grey upcoming, amber awaiting check-in, green checked in,
// red no check-in), with a summary on hover - who the caregiver is and when they checked in and
// out. A home with several visits that day gets one dot in the most urgent visit's colour, and the
// summary lists every visit there. Hover is mirrored from the page's visit list (activeId), so the
// list is the keyboard route to the same information; a click pins the summary for touch screens.

import {
  GoogleMap,
  MarkerF,
  OverlayViewF,
  OverlayView,
  useJsApiLoader,
} from '@react-google-maps/api';
import { useEffect, useMemo, useState } from 'react';
import type { OverviewVisit } from '../api/dashboard';
import { Badge } from '../design-system/Badge';
import { HomeSummary } from './HomeSummary';
import { groupByHome } from './homes';
import { STATE_HEX, STATE_META, mostUrgent } from './visitStates';
import './VisitsMap.css';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';

export interface VisitsMapProps {
  apiKey: string;
  visits: OverviewVisit[];
  timeZone: string;
  /** The dependant whose home is highlighted, from a dot or a row in the page's list. */
  activeId: string | null;
  onActiveChange: (dependantId: string | null) => void;
}

// Nairobi, for a day with nothing to show.
const DEFAULT_CENTER = { lat: -1.2864, lng: 36.8172 };

// A quiet, low-saturation base map so the four status colours are the loudest thing on it.
const MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ saturation: -80 }, { lightness: 10 }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d6e4ee' }] },
];

const MAP_OPTIONS: google.maps.MapOptions = {
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: false,
  clickableIcons: false,
  styles: MAP_STYLES,
};

export function VisitsMap({ apiKey, visits, timeZone, activeId, onActiveChange }: VisitsMapProps) {
  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey: apiKey });
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const homes = useMemo(() => groupByHome(visits), [visits]);

  // Frame the homes whenever the set of homes changes (a new day or filter), not on every
  // re-render - refitting on each minute's refresh would undo the supervisor's own pan and zoom.
  const homesKey = homes.map((h) => h.dependantId).join(',');
  useEffect(() => {
    if (!map) {
      return;
    }
    if (homes.length === 0) {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(11);
    } else if (homes.length === 1) {
      map.setCenter(homes[0]!.position);
      map.setZoom(15);
    } else {
      const bounds = new google.maps.LatLngBounds();
      homes.forEach((h) => bounds.extend(h.position));
      map.fitBounds(bounds, 48);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- homesKey stands for homes
  }, [map, homesKey]);

  if (loadError) {
    return <Badge tone="danger">Could not load Google Maps - check the API key.</Badge>;
  }
  if (!isLoaded) {
    return (
      <SkeletonRegion label="Loading the map" className="visits-map">
        <Skeleton height="100%" radius={0} style={{ position: 'absolute', inset: 0 }} />
      </SkeletonRegion>
    );
  }

  const active = homes.find((h) => h.dependantId === activeId);

  return (
    <div className="visits-map">
      <GoogleMap
        mapContainerClassName="visits-map__canvas"
        center={DEFAULT_CENTER}
        zoom={11}
        options={MAP_OPTIONS}
        onLoad={setMap}
        onUnmount={() => setMap(null)}
        onClick={() => onActiveChange(null)}
      >
        {homes.map((home) => {
          const state = mostUrgent(home.visits.map((v) => v.state));
          const isActive = home.dependantId === activeId;
          return (
            <MarkerF
              key={home.dependantId}
              position={home.position}
              title={`${home.dependantName}: ${STATE_META[state].label}`}
              zIndex={isActive ? 10 : 1}
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: isActive ? 10 : 8,
                fillColor: STATE_HEX[state],
                fillOpacity: 1,
                // The 2px white ring keeps neighbouring dots apart where they overlap.
                strokeColor: '#ffffff',
                strokeWeight: 2,
              }}
              onMouseOver={() => onActiveChange(home.dependantId)}
              onMouseOut={() => onActiveChange(null)}
              onClick={() => onActiveChange(isActive ? null : home.dependantId)}
            />
          );
        })}
        {active ? (
          <OverlayViewF
            position={active.position}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height - 16 })}
          >
            <HomeSummary home={active} timeZone={timeZone} />
          </OverlayViewF>
        ) : null}
      </GoogleMap>
      {homes.length === 0 ? (
        <div className="visits-map__empty">No visits to show for this day.</div>
      ) : null}
    </div>
  );
}
