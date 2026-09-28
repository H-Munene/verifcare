// The OpenStreetMap/Leaflet map behind the county -> constituency -> ward cascade
// (components/LocationSelector.tsx). Renders exactly one "active level" of boundary detail at a
// time, matching the confirmed UX: browsing the county dropdown shows nothing until hovered;
// selecting a county shows it filled, with a hovered constituency previewed darker on top while
// browsing that dropdown; selecting a constituency switches to showing every ward within it as
// outlines, with a hovered ward previewed filled on top; selecting a ward shows only that ward,
// filled, zoomed in - the previous levels' boundaries are not layered underneath at that point.

import { useEffect } from 'react';
import { geoJSON } from 'leaflet';
// Leaflet's own stylesheet - required for its tile/pane positioning and clipping rules
// (.leaflet-container, .leaflet-tile-pane, etc.). Without it, tiles render as plain unpositioned
// <img> elements at their natural size, which is exactly the "giant misaligned tiles spilling
// outside the map's box" symptom reported against this component - this import was present in the
// original GeofenceMap.tsx this component replaced, and was missed when rebuilding it for the
// forward-selection redesign. The real, actual root cause of that bug, not the ResizeObserver
// timing fix below (which addresses a real but different, much less impactful concern and is kept
// since it's still correct to have, just was never the fix this bug needed).
import 'leaflet/dist/leaflet.css';
import { GeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { CountyFeature, ConstituencyFeature, WardFeature } from '../geo/adminBoundaries';
import './LocationSelectorMap.css';

// Leaflet measures its container's pixel size once, when it first mounts - inside this project's
// CSS Grid Location step (a fixed 280px sidebar next to a `1fr` map column), that measurement can
// run before the grid has actually settled the `1fr` column's real width, or before the browser
// has finished laying out the step at all (this component mounts fresh every time the wizard
// navigates to this step, via a `{step === 1 ? ... : null}` conditional render - never just once
// at app startup). A wrong initial measurement is exactly what produces Leaflet's classic
// "misaligned/oversized tile grid spilling outside its own box" symptom - a ResizeObserver on the
// map's real container element re-measures whenever the browser actually changes that element's
// size, which reliably fires once for the correct post-layout size even when the very first
// measurement was wrong, and keeps working correctly for any later resize too (a window resize,
// or the sidebar's dropdown lists opening/closing below it).
function InvalidateSizeOnResize() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

const KENYA_CENTER: [number, number] = [0.0236, 37.9062];
const KENYA_ZOOM = 6;

export interface LocationSelectorMapProps {
  selectedCounty: CountyFeature | null;
  hoveredCounty: CountyFeature | null;
  selectedConstituency: ConstituencyFeature | null;
  hoveredConstituency: ConstituencyFeature | null;
  wardsInConstituency: WardFeature[];
  selectedWard: WardFeature | null;
  hoveredWard: WardFeature | null;
}

const countyStyle = { color: '#0077e6', weight: 2, fillColor: '#0077e6', fillOpacity: 0.15 };
const hoveredConstituencyStyle = {
  color: '#0068c9',
  weight: 2,
  dashArray: '4',
  fillColor: '#0068c9',
  fillOpacity: 0.35,
};
const wardOutlineStyle = { color: '#15b042', weight: 1.5, fillOpacity: 0 };
const hoveredWardStyle = { color: '#15b042', weight: 2, fillColor: '#15b042', fillOpacity: 0.4 };
const selectedWardStyle = { color: '#15b042', weight: 2, fillColor: '#15b042', fillOpacity: 0.5 };
const hoveredCountyStyle = { color: '#0077e6', weight: 2, fillColor: '#0077e6', fillOpacity: 0.35 };

export function LocationSelectorMap({
  selectedCounty,
  hoveredCounty,
  selectedConstituency,
  hoveredConstituency,
  wardsInConstituency,
  selectedWard,
  hoveredWard,
}: LocationSelectorMapProps) {
  return (
    <MapContainer center={KENYA_CENTER} zoom={KENYA_ZOOM} className="location-selector-map">
      <InvalidateSizeOnResize />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {selectedWard ? (
        <>
          <GeoJSON
            key={`ward-${selectedWard.properties.ward_code}`}
            data={selectedWard}
            style={selectedWardStyle}
          />
          <FitBoundsTo depth="ward" feature={selectedWard} />
        </>
      ) : selectedConstituency ? (
        <>
          {wardsInConstituency.map((ward) => (
            <GeoJSON
              key={`ward-outline-${ward.properties.ward_code}`}
              data={ward}
              style={wardOutlineStyle}
            />
          ))}
          {hoveredWard ? (
            <GeoJSON
              key={`ward-hover-${hoveredWard.properties.ward_code}`}
              data={hoveredWard}
              style={hoveredWardStyle}
            />
          ) : null}
          <FitBoundsTo depth="constituency" feature={selectedConstituency} />
        </>
      ) : selectedCounty ? (
        <>
          <GeoJSON
            key={`county-${selectedCounty.properties.county_code}`}
            data={selectedCounty}
            style={countyStyle}
          />
          {hoveredConstituency ? (
            <GeoJSON
              key={`constituency-hover-${hoveredConstituency.properties.constituency_code}`}
              data={hoveredConstituency}
              style={hoveredConstituencyStyle}
            />
          ) : null}
          <FitBoundsTo depth="county" feature={selectedCounty} />
        </>
      ) : (
        <>
          {hoveredCounty ? (
            <GeoJSON
              key={`county-hover-${hoveredCounty.properties.county_code}`}
              data={hoveredCounty}
              style={hoveredCountyStyle}
            />
          ) : null}
          {/* Nothing selected at all (including after a "clear" action) - reset the view back to
              the default Kenya-wide extent, since MapContainer's own center/zoom props only ever
              apply once at mount, not reactively, and this component stays mounted across
              selections within the same visit to this wizard step. */}
          <ResetToKenyaWhenIdle />
        </>
      )}
    </MapContainer>
  );
}

function ResetToKenyaWhenIdle() {
  const map = useMap();

  // This component is only ever rendered at all when the "nothing selected" branch is active, so
  // mounting it (including a fresh mount right after a prior selection was cleared, since that's a
  // different branch of the parent's ternary) is itself the "became idle" signal - no need to
  // track an idle transition separately from mounting.
  useEffect(() => {
    map.setView(KENYA_CENTER, KENYA_ZOOM);
  }, [map]);

  return null;
}

// Fits the map view to a feature's bounds exactly once per distinct (depth, feature) pair - not on
// every render, so hovering a sibling feature at the same level (e.g. previewing a different
// constituency within the same county) never fights the user's own pan/zoom of the already-
// selected level. `depth` is part of the key, not just the feature's own code: backing out from a
// ward/constituency to its parent county re-renders this component with the *same* county feature
// it was already fit to earlier (before drilling in further), which would never re-fit without
// `depth` distinguishing "county selected on its own" from "county showing through as context
// while its child was selected."
function FitBoundsTo({
  depth,
  feature,
}: {
  depth: 'county' | 'constituency' | 'ward';
  feature: CountyFeature | ConstituencyFeature | WardFeature;
}) {
  const map = useMap();
  // Checked ward first, then constituency, then county - ConstituencyProperties also carries its
  // parent county_code and WardProperties carries both of its ancestors' codes, so checking in the
  // opposite (broadest-first) order would always match the first (wrong) branch for a narrower type.
  const featureKey = JSON.stringify([
    depth,
    'ward_code' in feature.properties
      ? feature.properties.ward_code
      : 'constituency_code' in feature.properties
        ? feature.properties.constituency_code
        : feature.properties.county_code,
  ]);

  useEffect(() => {
    const bounds = geoJSON(feature).getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [16, 16] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureKey]);

  return null;
}
