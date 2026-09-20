import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as shapefile from "shapefile";
import type {
  ConstituencyFeature,
  ConstituencyFeatureCollection,
  ConstituencyRecord,
  ConstituencyShapefileProperties,
  CountyRecord,
  CountyFeature,
  CountyFeatureCollection,
  CountyShapefileProperties,
  AnyPolygonGeometry,
  WardShapefileProperties,
  WardFeature,
  WardFeatureCollection,
  WardRecord,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = resolve(__dirname, "../source");
const CONSTITUENCIES_SOURCE = resolve(SOURCE_DIR, "constituencies");
const COUNTIES_SOURCE = resolve(SOURCE_DIR, "counties");
const WARDS_SOURCE = resolve(SOURCE_DIR, "wards");
const CONSTITUENCIES_OUT = resolve(__dirname, "../constituencies");
const COUNTIES_OUT = resolve(__dirname, "../counties");
const WARDS_OUT = resolve(__dirname, "../wards");

const COORD_PRECISION = 6;
const MERCATOR_MAX = 20037508.342789244;

function mercatorToWgs84(x: number, y: number): [number, number] {
  const lng = (x / MERCATOR_MAX) * 180;
  const lat =
    (180 / Math.PI) *
    (2 * Math.atan(Math.exp((y / MERCATOR_MAX) * Math.PI)) - Math.PI / 2);
  return [lng, lat];
}

function reprojectFromMercator(
  geometry: AnyPolygonGeometry,
): AnyPolygonGeometry {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) =>
        ring.map((coord) => {
          const [lng, lat] = mercatorToWgs84(coord[0]!, coord[1]!);
          return [lng, lat];
        }),
      ),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map((polygon) =>
      polygon.map((ring) =>
        ring.map((coord) => {
          const [lng, lat] = mercatorToWgs84(coord[0]!, coord[1]!);
          return [lng, lat];
        }),
      ),
    ),
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function assertSourceExists(dir: string, label: string): void {
  if (!existsSync(dir)) {
    throw new Error(
      `Source directory not found: ${dir}\nRun "pnpm download-source" first to fetch the ${label} data.`
    );
  }
}

function roundCoord(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundCoordinates(geometry: AnyPolygonGeometry): AnyPolygonGeometry {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) =>
        ring.map((coord) => [roundCoord(coord[0]!), roundCoord(coord[1]!)])
      ),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map((polygon) =>
      polygon.map((ring) =>
        ring.map((coord) => [roundCoord(coord[0]!), roundCoord(coord[1]!)])
      )
    ),
  };
}

async function readConstituenciesFromShapefile(): Promise<{
  geojson: ConstituencyFeatureCollection;
  records: ConstituencyRecord[];
}> {
  assertSourceExists(CONSTITUENCIES_SOURCE, "constituencies");

  const source = await shapefile.open(
    resolve(CONSTITUENCIES_SOURCE, "constituencies.shp"),
    resolve(CONSTITUENCIES_SOURCE, "constituencies.dbf")
  );

  const features: ConstituencyFeature[] = [];
  const records: ConstituencyRecord[] = [];

  let result = await source.read();
  while (!result.done) {
    const props = result.value.properties as ConstituencyShapefileProperties;
    const geometry = result.value.geometry as AnyPolygonGeometry;

    if (props.CONST_CODE > 0 && props.CONSTITUEN) {
      features.push({
        type: "Feature",
        properties: {
          constituency_code: props.CONST_CODE,
          constituency_name: props.CONSTITUEN,
          county_name: props.COUNTY_NAM,
          county_code: props.COUNTY_COD,
        },
        geometry: roundCoordinates(geometry),
      });

      records.push({
        constituency_code: props.CONST_CODE,
        constituency_name: props.CONSTITUEN,
        county_name: props.COUNTY_NAM,
        county_code: props.COUNTY_COD,
      });
    }

    result = await source.read();
  }

  features.sort((a, b) => a.properties.constituency_code - b.properties.constituency_code);
  records.sort((a, b) => a.constituency_code - b.constituency_code);

  return {
    geojson: { type: "FeatureCollection", features },
    records,
  };
}

async function readCountiesFromShapefile(): Promise<{
  geojson: CountyFeatureCollection;
  records: CountyRecord[];
}> {
  assertSourceExists(COUNTIES_SOURCE, "counties");

  const source = await shapefile.open(
    resolve(COUNTIES_SOURCE, "counties.shp"),
    resolve(COUNTIES_SOURCE, "counties.dbf")
  );

  const features: CountyFeature[] = [];
  const records: CountyRecord[] = [];

  let result = await source.read();
  while (!result.done) {
    const props = result.value.properties as CountyShapefileProperties;
    const geometry = result.value.geometry as AnyPolygonGeometry;

    if (props.COUNTY_COD > 0) {
      features.push({
        type: "Feature",
        properties: {
          county_code: props.COUNTY_COD,
          county_name: props.COUNTY_NAM,
        },
        geometry: roundCoordinates(geometry),
      });

      records.push({
        county_code: props.COUNTY_COD,
        county_name: props.COUNTY_NAM,
      });
    }

    result = await source.read();
  }

  features.sort((a, b) => a.properties.county_code - b.properties.county_code);
  records.sort((a, b) => a.county_code - b.county_code);

  return {
    geojson: { type: "FeatureCollection", features },
    records,
  };
}

async function readWardsFromShapefile(): Promise<{
  geojson: WardFeatureCollection;
  records: WardRecord[];
}> {
  assertSourceExists(WARDS_SOURCE, "wards");

  const source = await shapefile.open(
    resolve(WARDS_SOURCE, "ward.results.formatted.shp"),
    resolve(WARDS_SOURCE, "ward.results.formatted.dbf")
  );

  const features: WardFeature[] = [];
  const records: WardRecord[] = [];

  let result = await source.read();
  while (!result.done) {
    const props = result.value.properties as WardShapefileProperties;
    const geometry = result.value.geometry as AnyPolygonGeometry;

    if (props.COUNTY_ASS > 0) {
      const mapped = {
        ward_code: String(props.COUNTY_ASS),
        ward_name: props.NAME,
        county_code: props.COUNTY_COD,
        county_name: props.COUNTY_NAM,
        constituency_code: props.CONST_CODE,
        constituency_name: props.CONSTITUEN,
      };

      features.push({
        type: "Feature",
        properties: mapped,
        geometry: roundCoordinates(reprojectFromMercator(geometry)),
      });

      records.push({ ...mapped });
    }

    result = await source.read();
  }

  features.sort((a, b) => a.properties.ward_code.localeCompare(b.properties.ward_code));
  records.sort((a, b) => a.ward_code.localeCompare(b.ward_code));

  return {
    geojson: { type: "FeatureCollection", features },
    records,
  };
}

function writeJSON(filepath: string, data: unknown): void {
  writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Written: ${filepath}`);
}

function writeGeoJSON(filepath: string, data: unknown): void {
  writeFileSync(filepath, JSON.stringify(data), "utf-8");
  console.log(`Written: ${filepath}`);
}

async function main(): Promise<void> {
  ensureDir(CONSTITUENCIES_OUT);
  ensureDir(COUNTIES_OUT);
  ensureDir(WARDS_OUT);

  console.log("Reading constituencies from shapefile...");
  const { geojson: constGeoJSON, records: constRecords } =
    await readConstituenciesFromShapefile();
  writeJSON(resolve(CONSTITUENCIES_OUT, "constituencies.json"), constRecords);
  writeGeoJSON(resolve(CONSTITUENCIES_OUT, "constituencies.geojson"), constGeoJSON);
  console.log(`Constituencies: ${constRecords.length} records\n`);

  console.log("Reading counties from shapefile...");
  const { geojson: countyGeoJSON, records: countyRecords } =
    await readCountiesFromShapefile();
  writeJSON(resolve(COUNTIES_OUT, "counties.json"), countyRecords);
  writeGeoJSON(resolve(COUNTIES_OUT, "counties.geojson"), countyGeoJSON);
  console.log(`Counties: ${countyRecords.length} records\n`);

  console.log("Reading wards from shapefile...");
  const { geojson: wardGeoJSON, records: wardRecords } =
    await readWardsFromShapefile();
  writeJSON(resolve(WARDS_OUT, "wards.json"), wardRecords);
  writeGeoJSON(resolve(WARDS_OUT, "wards.geojson"), wardGeoJSON);
  console.log(`Wards: ${wardRecords.length} records\n`);

  console.log("Extraction complete.");
}

main();
