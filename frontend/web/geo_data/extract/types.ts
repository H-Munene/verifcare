export interface GeoJSONFeature<G, P> {
  type: "Feature";
  properties: P;
  geometry: G;
}

export interface GeoJSONFeatureCollection<G, P> {
  type: "FeatureCollection";
  features: GeoJSONFeature<G, P>[];
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: number[][][][];
}

export type AnyPolygonGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface ConstituencyProperties {
  constituency_code: number;
  constituency_name: string;
  county_name: string;
  county_code: number;
}

export interface CountyShapefileProperties {
  OBJECTID: number;
  ID_: number;
  COUNTY_NAM: string;
  CONST_CODE: number;
  CONSTITUEN: string;
  COUNTY_COD: number;
  Shape_Leng: number;
  Shape_Area: number;
}

export interface CountyProperties {
  county_code: number;
  county_name: string;
}

export interface ConstituencyRecord {
  constituency_code: number;
  constituency_name: string;
  county_name: string;
  county_code: number;
}

export interface CountyRecord {
  county_code: number;
  county_name: string;
}

export type ConstituencyFeature = GeoJSONFeature<AnyPolygonGeometry, ConstituencyProperties>;
export type ConstituencyFeatureCollection = GeoJSONFeatureCollection<AnyPolygonGeometry, ConstituencyProperties>;

export type CountyFeature = GeoJSONFeature<AnyPolygonGeometry, CountyProperties>;
export type CountyFeatureCollection = GeoJSONFeatureCollection<AnyPolygonGeometry, CountyProperties>;

export interface ConstituencyShapefileProperties {
  OBJECTID: number;
  COUNTY_NAM: string;
  CONST_CODE: number;
  CONSTITUEN: string;
  COUNTY_ASS: number;
  COUNTY_A_1: string | null;
  REGIST_CEN: number;
  REGISTRATI: string | null;
  COUNTY_COD: number;
  Shape_Leng: number;
  Shape_Area: number;
}

export interface WardShapefileProperties {
  OBJECTID: number;
  OBJECTID_1: number;
  CONST_CODE: number;
  CONSTITUEN: string;
  COUNTY_COD: number;
  COUNTY_NAM: string;
  COUNTY_ASS: number;
  COUNTY_A_1: string;
  NAME: string;
  Shape_Leng: number;
  Shape_Le_1: number;
  Shape_Area: number;
}

export interface WardProperties {
  ward_code: string;
  ward_name: string;
  county_code: number;
  county_name: string;
  constituency_code: number;
  constituency_name: string;
}

export interface WardRecord {
  ward_code: string;
  ward_name: string;
  county_code: number;
  county_name: string;
  constituency_code: number;
  constituency_name: string;
}

export type WardFeature = GeoJSONFeature<AnyPolygonGeometry, WardProperties>;
export type WardFeatureCollection = GeoJSONFeatureCollection<AnyPolygonGeometry, WardProperties>;
