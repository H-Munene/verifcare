// Google Maps pin placement, bounded to the ward selected in LocationSelector.tsx (HEZ-86
// revision) - the user's own step 6: "pin the exact location... the view locked within this
// boundary." Google Maps' `restriction` option only accepts a rectangular LatLngBounds, never an
// arbitrary polygon, so panning is bounded to the ward's bounding box (geo/adminBoundaries.ts's
// getFeatureBoundingBox) while the ward's actual polygon is drawn as a visual overlay on top -
// and the dropped/dragged pin is validated against that real polygon (not just the looser
// bounding box) via the same point-in-polygon check used for the ward lookup itself, since a
// bounding box alone would let a pin land in the box-but-outside-the-ward gap for anything but a
// perfectly rectangular ward.

import { useMemo } from 'react';
// The hook-based *F components, not the class-based Circle/Marker/Polygon: under React's
// StrictMode (main.tsx) the class versions mount twice and never remove the extra google.maps
// overlay, which is what left a trail of old circles behind every tap or drag of the pin (the
// user's report, 2026-09-26). The F versions clean up in an effect and move their existing
// overlay when center/position change.
import { CircleF, GoogleMap, MarkerF, PolygonF, useJsApiLoader } from '@react-google-maps/api';
import { getFeatureBoundingBox, isPointInFeature, type WardFeature } from '../geo/adminBoundaries';
import { Badge } from '../design-system/Badge';
import './ExactLocationMap.css';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';

export interface ExactLocationMapProps {
  apiKey: string;
  wardFeature: WardFeature;
  lat: number | null;
  lng: number | null;
  radiusMeters: number;
  // Whether the pin is inside the ward is the page's call (RegisterDependantPage derives it from
  // the pin and the ward), so a ward changed after the pin was placed is caught too.
  onPositionChange: (lat: number, lng: number) => void;
}

type LatLng = { lat: number; lng: number };

// Widens the restriction box beyond the ward's own tight bounding box (used, unpadded, for
// fitBounds itself) - a *strict* restriction pinned to the exact same tight box fights fitBounds:
// fitBounds often needs to show slightly more than the tight box in one axis (its own bounds/zoom
// rounding, and any mismatch between the bbox's aspect ratio and the map container's), and a
// strict restriction on that same tight box then forces a tighter, more zoomed-in view than
// fitBounds actually chose, to avoid ever revealing anything outside it - this was the real cause
// of the "too zoomed in" bug reported against this component. A soft, padded restriction (matching
// the confirmed-working reference implementation's own ~500m/0.005-degree margin) gives fitBounds
// room to do its job while still keeping panning generally within the ward.
const RESTRICTION_PADDING_DEGREES = 0.005;

function ringToPath(ring: number[][]): LatLng[] {
  return ring.map(([lng, lat]) => ({ lat: lat!, lng: lng! }));
}

function polygonPaths(feature: WardFeature): LatLng[][][] {
  const { geometry } = feature;
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map(ringToPath)];
  }
  return geometry.coordinates.map((polygon) => polygon.map(ringToPath));
}

export function ExactLocationMap({
  apiKey,
  wardFeature,
  lat,
  lng,
  radiusMeters,
  onPositionChange,
}: ExactLocationMapProps) {
  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey: apiKey });

  const bbox = useMemo(() => getFeatureBoundingBox(wardFeature), [wardFeature]);
  const paths = useMemo(() => polygonPaths(wardFeature), [wardFeature]);
  const restrictionBounds = useMemo(
    () => ({
      south: bbox.south - RESTRICTION_PADDING_DEGREES,
      west: bbox.west - RESTRICTION_PADDING_DEGREES,
      north: bbox.north + RESTRICTION_PADDING_DEGREES,
      east: bbox.east + RESTRICTION_PADDING_DEGREES,
    }),
    [bbox],
  );
  // @react-google-maps/api's GoogleMap re-runs `map.setOptions(options)` in an effect keyed on
  // this object's own reference (not a deep diff) every time it changes - center/zoom were
  // previously included here as an inline object literal, so every re-render (triggered by every
  // pin placement, since that updates this component's own lat/lng props) created a brand-new
  // object and snapped the view straight back to the ward's center at zoom 14, undoing whatever
  // pan/zoom the admin had just done. Memoizing it (keyed only on the ward-derived
  // restrictionBounds) keeps the reference stable across a pin placement, so setOptions is only
  // ever re-invoked when the selected ward itself changes - this was the actual cause of "the map
  // zooms out when I place or move the pin." Initial framing is handled once by onLoad's
  // fitBounds below instead of by a center/zoom pair here.
  const mapOptions = useMemo(
    () => ({
      restriction: { latLngBounds: restrictionBounds, strictBounds: false },
      streetViewControl: false,
      mapTypeControl: false,
    }),
    [restrictionBounds],
  );

  function handlePositionChange(newLat: number, newLng: number) {
    onPositionChange(newLat, newLng);
  }

  if (loadError) {
    return <Badge tone="danger">Could not load Google Maps - check the API key.</Badge>;
  }
  if (!isLoaded) {
    return (
      <SkeletonRegion label="Loading the map">
        <Skeleton height={320} radius="var(--radius-default)" />
      </SkeletonRegion>
    );
  }

  const isValid = lat !== null && lng !== null && isPointInFeature(lat, lng, wardFeature);

  return (
    <div className="exact-location-map">
      <GoogleMap
        mapContainerClassName="exact-location-map__container"
        // fitBounds() in onLoad is what actually sets the real view, once, when the map first
        // mounts - there is no center/zoom in `options` (see mapOptions's own comment) to compete
        // with it or to snap the view back on a later re-render.
        onLoad={(map) => {
          map.fitBounds({ south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east });
        }}
        onClick={(event) => {
          if (event.latLng) {
            handlePositionChange(event.latLng.lat(), event.latLng.lng());
          }
        }}
        options={mapOptions}
      >
        {paths.map((polygonRings, index) => (
          <PolygonF
            key={index}
            paths={polygonRings}
            // clickable: false - a google.maps.Polygon is clickable by default even at
            // fillOpacity: 0, which silently swallowed every click landing inside the ward outline
            // (nearly the whole visible map, by definition) before it could ever reach GoogleMap's
            // own onClick below. This was the actual cause of "tapping does nothing."
            options={{ strokeColor: '#15b042', strokeWeight: 2, fillOpacity: 0, clickable: false }}
          />
        ))}
        {lat !== null && lng !== null ? (
          <>
            <MarkerF
              position={{ lat, lng }}
              draggable
              onDragEnd={(event) => {
                if (event.latLng) {
                  handlePositionChange(event.latLng.lat(), event.latLng.lng());
                }
              }}
            />
            {radiusMeters > 0 ? (
              <CircleF
                // No remount key: CircleF moves its one circle with setCenter when the pin moves.
                // (An earlier fix remounted the class-based Circle on every move, which under
                // StrictMode left an orphaned overlay behind each time - the trail of circles.)
                center={{ lat, lng }}
                radius={radiusMeters}
                options={{
                  strokeColor: '#0077e6',
                  strokeWeight: 1.5,
                  fillColor: '#0077e6',
                  fillOpacity: 0.12,
                  clickable: false,
                }}
              />
            ) : null}
          </>
        ) : null}
      </GoogleMap>
      <div className="exact-location-map__status">
        {lat === null || lng === null ? (
          <span className="exact-location-map__hint">
            Click within the ward boundary to place the pin.
          </span>
        ) : isValid ? (
          <Badge tone="success">Pin placed.</Badge>
        ) : (
          <Badge tone="danger">Outside the selected ward boundary - reposition the pin.</Badge>
        )}
      </div>
    </div>
  );
}
