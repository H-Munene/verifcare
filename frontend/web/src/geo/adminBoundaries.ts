// Kenya administrative geography data access (HEZ-86 revision) - county -> constituency -> ward
// cascading lookups and boundary geometry, all sourced from public/geo_data/ (added by the user,
// extracted from real IEBC boundary shapefiles - see geo_data/extract/).
//
// Replaces the previous session's reverse-geocode-from-pin design (resolve county/constituency/
// ward FROM a dropped pin via point-in-polygon) with a forward-selection one: the admin picks
// county -> constituency -> ward explicitly via cascading dropdowns first (this module), then
// places a pin bounded within the selected ward (components/ExactLocationMap.tsx) - the pin's
// coordinates are validated to fall inside that ward's polygon (isPointInFeature below), not used
// to derive the names.
//
// Each list/geometry source is fetched at most once per page load and cached here - counties.json
// and counties.geojson are small (a few hundred KB) and safe to load eagerly; constituencies.geojson
// (~2MB) and wards.geojson (~34MB) are only ever fetched once the admin actually reaches the level
// that needs them (a county is selected, then a constituency is selected, respectively).

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';

export interface CountyOption {
  code: number;
  name: string;
}
export interface ConstituencyOption {
  code: number;
  name: string;
  countyCode: number;
}
export interface WardOption {
  code: string;
  name: string;
  countyCode: number;
  constituencyCode: number;
}

interface CountyProperties {
  county_code: number;
  county_name: string;
}
interface ConstituencyProperties {
  constituency_code: number;
  constituency_name: string;
  county_code: number;
  county_name: string;
}
interface WardProperties {
  ward_code: string;
  ward_name: string;
  county_code: number;
  county_name: string;
  constituency_code: number;
  constituency_name: string;
}

export type CountyFeature = Feature<Polygon | MultiPolygon, CountyProperties>;
export type ConstituencyFeature = Feature<Polygon | MultiPolygon, ConstituencyProperties>;
export type WardFeature = Feature<Polygon | MultiPolygon, WardProperties>;

function cachedFetch<T>(url: string, ref: { promise: Promise<T> | null }): Promise<T> {
  ref.promise ??= fetch(url).then((response) => {
    if (!response.ok) {
      // Cleared so a transient network failure can be retried later, rather than permanently
      // poisoning every subsequent lookup this page session.
      ref.promise = null;
      throw new Error(`Failed to load ${url} (${response.status}).`);
    }
    return response.json() as Promise<T>;
  });
  return ref.promise;
}

const countiesListRef: { promise: Promise<{ county_code: number; county_name: string }[]> | null } =
  { promise: null };
const countiesGeoRef: {
  promise: Promise<FeatureCollection<Polygon | MultiPolygon, CountyProperties>> | null;
} = { promise: null };
const constituenciesListRef: {
  promise: Promise<
    { constituency_code: number; constituency_name: string; county_code: number }[]
  > | null;
} = { promise: null };
const constituenciesGeoRef: {
  promise: Promise<FeatureCollection<Polygon | MultiPolygon, ConstituencyProperties>> | null;
} = { promise: null };
const wardsListRef: { promise: Promise<WardProperties[]> | null } = { promise: null };
const wardsGeoRef: {
  promise: Promise<FeatureCollection<Polygon | MultiPolygon, WardProperties>> | null;
} = { promise: null };

export async function loadCounties(): Promise<CountyOption[]> {
  const rows = await cachedFetch<{ county_code: number; county_name: string }[]>(
    '/geo_data/counties/counties.json',
    countiesListRef,
  );
  return rows.map((row) => ({ code: row.county_code, name: row.county_name }));
}

export async function loadConstituencies(countyCode: number): Promise<ConstituencyOption[]> {
  const rows = await cachedFetch<
    { constituency_code: number; constituency_name: string; county_code: number }[]
  >('/geo_data/constituencies/constituencies.json', constituenciesListRef);
  return rows
    .filter((row) => row.county_code === countyCode)
    .map((row) => ({
      code: row.constituency_code,
      name: row.constituency_name,
      countyCode: row.county_code,
    }));
}

export async function loadWards(constituencyCode: number): Promise<WardOption[]> {
  const rows = await cachedFetch<WardProperties[]>('/geo_data/wards/wards.json', wardsListRef);
  return rows
    .filter((row) => row.constituency_code === constituencyCode)
    .map((row) => ({
      code: row.ward_code,
      name: row.ward_name,
      countyCode: row.county_code,
      constituencyCode: row.constituency_code,
    }));
}

export async function getCountyFeature(code: number): Promise<CountyFeature | null> {
  const collection = await cachedFetch<FeatureCollection<Polygon | MultiPolygon, CountyProperties>>(
    '/geo_data/counties/counties.geojson',
    countiesGeoRef,
  );
  return collection.features.find((f) => f.properties.county_code === code) ?? null;
}

export async function getConstituencyFeature(code: number): Promise<ConstituencyFeature | null> {
  const collection = await cachedFetch<
    FeatureCollection<Polygon | MultiPolygon, ConstituencyProperties>
  >('/geo_data/constituencies/constituencies.geojson', constituenciesGeoRef);
  return collection.features.find((f) => f.properties.constituency_code === code) ?? null;
}

// Every ward feature within a constituency (to draw all their outlines at once, per the confirmed
// mockup behavior) - not a single-feature lookup like the two above.
export async function getWardFeaturesInConstituency(
  constituencyCode: number,
): Promise<WardFeature[]> {
  const collection = await cachedFetch<FeatureCollection<Polygon | MultiPolygon, WardProperties>>(
    '/geo_data/wards/wards.geojson',
    wardsGeoRef,
  );
  return collection.features.filter((f) => f.properties.constituency_code === constituencyCode);
}

export async function getWardFeature(code: string): Promise<WardFeature | null> {
  const collection = await cachedFetch<FeatureCollection<Polygon | MultiPolygon, WardProperties>>(
    '/geo_data/wards/wards.geojson',
    wardsGeoRef,
  );
  return collection.features.find((f) => f.properties.ward_code === code) ?? null;
}

export interface LatLngBoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

// A plain min/max walk over the feature's own coordinates - not turf's bbox() - since this is the
// only place a bounding box is needed (Google Maps' `restriction` option only accepts a
// rectangular LatLngBounds, never an arbitrary polygon) and a second turf module is not worth
// adding for a one-line reduction.
export function getFeatureBoundingBox(feature: Feature<Polygon | MultiPolygon>): LatLngBoundingBox {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const polygons =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const coord of ring) {
        const [lng, lat] = coord as [number, number];
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lng < west) west = lng;
        if (lng > east) east = lng;
      }
    }
  }
  return { south, west, north, east };
}

export function isPointInFeature(
  lat: number,
  lng: number,
  feature: Feature<Polygon | MultiPolygon>,
): boolean {
  const point: Feature<Point> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [lng, lat] },
  };
  return booleanPointInPolygon(point, feature);
}
