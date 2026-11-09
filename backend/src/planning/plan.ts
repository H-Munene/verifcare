// Day planning (2026-11-09): groups the day's dependants into one cluster per caregiver, gives each
// cluster to the caregiver who starts closest to it, orders the stops, and works out visit times.
//
// Pure and deterministic, with no database or clock: the same input always gives the same plan, so
// a supervisor's plan can be explained and the algorithms can be tested and evaluated directly
// (planning/evaluate.ts).
//
// Distances are straight lines scaled by a road factor. That is an estimate. Road-accurate travel
// needs a routing service with its own cost, and a supervisor reviews every plan before publishing.

import { haversineDistanceMeters } from '../geo.js';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface PlanStop extends GeoPoint {
  id: string;
}

export interface PlanCaregiver {
  id: string;
  base: GeoPoint;
}

export interface TravelAssumptions {
  /** How much longer a road journey is than the straight line. */
  roadFactor: number;
  averageSpeedKmh: number;
}

export const DEFAULT_TRAVEL: TravelAssumptions = { roadFactor: 1.4, averageSpeedKmh: 25 };

const DEFAULT_SEED = 20261109;
const KMEANS_RESTARTS = 8;
const KMEANS_MAX_ITERATIONS = 50;
const ROUNDING_MS = 5 * 60_000;

function distance(a: GeoPoint, b: GeoPoint): number {
  return haversineDistanceMeters(a.lat, a.lng, b.lat, b.lng);
}

/** Whole minutes to travel a straight-line [meters], rounded up. */
export function travelMinutes(meters: number, travel: TravelAssumptions = DEFAULT_TRAVEL): number {
  const roadKm = (meters * travel.roadFactor) / 1000;
  return Math.ceil((roadKm / travel.averageSpeedKmh) * 60);
}

/** A small seeded generator (mulberry32), so clustering is repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centroidOf(points: GeoPoint[]): GeoPoint {
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length,
  };
}

// k-means++: spread the starting centres out, weighted by squared distance from those chosen.
function initialCentres(points: GeoPoint[], k: number, random: () => number): GeoPoint[] {
  const centres = [points[Math.floor(random() * points.length)]!];
  while (centres.length < k) {
    const weights = points.map((p) => Math.min(...centres.map((c) => distance(p, c) ** 2)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total === 0) {
      centres.push(points[centres.length % points.length]!);
      continue;
    }
    let target = random() * total;
    let chosen = points.length - 1;
    for (const [i, weight] of weights.entries()) {
      target -= weight;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centres.push(points[chosen]!);
  }
  return centres;
}

// Points with the most to lose from not getting their nearest centre choose first, so a full
// cluster pushes out the point that can most easily go elsewhere.
function assignWithCapacity(points: GeoPoint[], centres: GeoPoint[], capacity: number): number[] {
  const ranked = points
    .map((point, index) => {
      const distances = centres.map((c) => distance(point, c));
      const sorted = [...distances].sort((a, b) => a - b);
      return { index, distances, regret: (sorted[1] ?? sorted[0]!) - sorted[0]! };
    })
    .sort((a, b) => b.regret - a.regret || a.index - b.index);
  const sizes = centres.map(() => 0);
  const assignment = points.map(() => -1);
  for (const { index, distances } of ranked) {
    let best = -1;
    for (const [c, d] of distances.entries()) {
      if (sizes[c]! < capacity && (best === -1 || d < distances[best]!)) {
        best = c;
      }
    }
    assignment[index] = best;
    sizes[best]! += 1;
  }
  return assignment;
}

/**
 * Splits [points] into [k] groups of at most ceil(n/k), keeping each caregiver's workload even and
 * their stops close together. Returns point indices per group. The best of several seeded restarts
 * wins, since k-means can settle on a poor local arrangement.
 */
export function clusterPoints(
  points: GeoPoint[],
  k: number,
  seed: number = DEFAULT_SEED,
): number[][] {
  if (points.length === 0 || k <= 0) {
    return [];
  }
  const groups = Math.min(k, points.length);
  const capacity = Math.ceil(points.length / groups);
  const random = seededRandom(seed);

  let best: { assignment: number[]; inertia: number } | undefined;
  for (let restart = 0; restart < KMEANS_RESTARTS; restart += 1) {
    let centres = initialCentres(points, groups, random);
    let assignment = assignWithCapacity(points, centres, capacity);
    for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration += 1) {
      centres = centres.map((centre, c) => {
        const members = points.filter((_, i) => assignment[i] === c);
        return members.length > 0 ? centroidOf(members) : centre;
      });
      const next = assignWithCapacity(points, centres, capacity);
      const stable = next.every((value, i) => value === assignment[i]);
      assignment = next;
      if (stable) {
        break;
      }
    }
    const inertia = points.reduce(
      (sum, p, i) => sum + distance(p, centres[assignment[i]!]!) ** 2,
      0,
    );
    if (!best || inertia < best.inertia) {
      best = { assignment, inertia };
    }
  }

  const result: number[][] = Array.from({ length: groups }, () => []);
  best!.assignment.forEach((group, index) => result[group]!.push(index));
  return result.filter((group) => group.length > 0);
}

/**
 * Hungarian algorithm: the row-to-column assignment with the lowest total cost, for at most as many
 * rows as columns. Returns the chosen column for each row. A greedy choice can strand the last
 * cluster with a caregiver on the far side of the city; this can't.
 */
export function assignMinimumCost(cost: number[][]): number[] {
  const rows = cost.length;
  if (rows === 0) {
    return [];
  }
  const columns = cost[0]!.length;
  const rowPotential = new Array<number>(rows + 1).fill(0);
  const columnPotential = new Array<number>(columns + 1).fill(0);
  const rowOfColumn = new Array<number>(columns + 1).fill(0);
  const path = new Array<number>(columns + 1).fill(0);

  for (let row = 1; row <= rows; row += 1) {
    rowOfColumn[0] = row;
    let current = 0;
    const slack = new Array<number>(columns + 1).fill(Infinity);
    const visited = new Array<boolean>(columns + 1).fill(false);
    do {
      visited[current] = true;
      const rowHere = rowOfColumn[current]!;
      let delta = Infinity;
      let next = 0;
      for (let column = 1; column <= columns; column += 1) {
        if (visited[column]) {
          continue;
        }
        const reduced =
          cost[rowHere - 1]![column - 1]! - rowPotential[rowHere]! - columnPotential[column]!;
        if (reduced < slack[column]!) {
          slack[column] = reduced;
          path[column] = current;
        }
        if (slack[column]! < delta) {
          delta = slack[column]!;
          next = column;
        }
      }
      for (let column = 0; column <= columns; column += 1) {
        if (visited[column]) {
          rowPotential[rowOfColumn[column]!]! += delta;
          columnPotential[column]! -= delta;
        } else {
          slack[column]! -= delta;
        }
      }
      current = next;
    } while (rowOfColumn[current] !== 0);
    do {
      const previous = path[current]!;
      rowOfColumn[current] = rowOfColumn[previous]!;
      current = previous;
    } while (current !== 0);
  }

  const result = new Array<number>(rows).fill(-1);
  for (let column = 1; column <= columns; column += 1) {
    if (rowOfColumn[column] !== 0) {
      result[rowOfColumn[column]! - 1] = column - 1;
    }
  }
  return result;
}

function routeLength(start: GeoPoint, stops: GeoPoint[]): number {
  let total = 0;
  let previous = start;
  for (const stop of stops) {
    total += distance(previous, stop);
    previous = stop;
  }
  return total;
}

/** Stops in visiting order from [start]: nearest-neighbour, then improved by 2-opt. */
export function orderRoute<T extends GeoPoint>(start: GeoPoint, stops: T[]): T[] {
  const remaining = [...stops];
  let route: T[] = [];
  let here = start;
  while (remaining.length > 0) {
    let nearest = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      if (distance(here, remaining[i]!) < distance(here, remaining[nearest]!)) {
        nearest = i;
      }
    }
    const [next] = remaining.splice(nearest, 1);
    route.push(next!);
    here = next!;
  }

  // The route doesn't return home at the end, so reversing a tail is free to try as well.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i += 1) {
      for (let j = i + 1; j < route.length; j += 1) {
        const candidate = [
          ...route.slice(0, i),
          ...route.slice(i, j + 1).reverse(),
          ...route.slice(j + 1),
        ];
        if (routeLength(start, candidate) + 1e-6 < routeLength(start, route)) {
          route = candidate;
          improved = true;
        }
      }
    }
  }
  return route;
}

export interface TimetabledStop extends PlanStop {
  scheduledStart: Date;
  scheduledEnd: Date;
  travelMinutes: number;
  distanceMeters: number;
}

export interface Timetable {
  stops: TimetabledStop[];
  /** Stops that didn't fit before the shift ended, in route order. */
  unplaced: PlanStop[];
  totalDistanceMeters: number;
  totalTravelMinutes: number;
}

function roundUp(instant: number): number {
  return Math.ceil(instant / ROUNDING_MS) * ROUNDING_MS;
}

/** Times for [stops] in the given order, leaving [base] at [shiftStart]. Never drops a stop quietly. */
export function buildTimetable(params: {
  base: GeoPoint;
  stops: PlanStop[];
  shiftStart: Date;
  shiftEnd: Date;
  visitMinutes: number;
  travel?: TravelAssumptions;
}): Timetable {
  const { base, stops, shiftStart, shiftEnd, visitMinutes, travel = DEFAULT_TRAVEL } = params;
  const placed: TimetabledStop[] = [];
  const unplaced: PlanStop[] = [];
  let clock = shiftStart.getTime();
  let here = base;
  let totalDistanceMeters = 0;
  let totalTravelMinutes = 0;

  for (const stop of stops) {
    const distanceMeters = distance(here, stop);
    const minutes = travelMinutes(distanceMeters, travel);
    const start = roundUp(clock + minutes * 60_000);
    const end = start + visitMinutes * 60_000;
    if (end > shiftEnd.getTime()) {
      unplaced.push(stop);
      continue;
    }
    placed.push({
      ...stop,
      scheduledStart: new Date(start),
      scheduledEnd: new Date(end),
      travelMinutes: minutes,
      distanceMeters,
    });
    totalDistanceMeters += distanceMeters;
    totalTravelMinutes += minutes;
    clock = end;
    here = stop;
  }
  return { stops: placed, unplaced, totalDistanceMeters, totalTravelMinutes };
}

export interface PlannedRoute extends Timetable {
  caregiverId: string;
}

export interface DayPlan {
  routes: PlannedRoute[];
  unplaced: PlanStop[];
}

/** Everything above in order: cluster, assign, order, timetable. */
export function planDay(params: {
  stops: PlanStop[];
  caregivers: PlanCaregiver[];
  shiftStart: Date;
  shiftEnd: Date;
  visitMinutes: number;
  travel?: TravelAssumptions;
  seed?: number;
}): DayPlan {
  const { stops, caregivers, shiftStart, shiftEnd, visitMinutes, travel, seed } = params;
  if (caregivers.length === 0) {
    return { routes: [], unplaced: stops };
  }
  const groups = clusterPoints(stops, caregivers.length, seed).map((group) =>
    group.map((index) => stops[index]!),
  );
  const cost = groups.map((group) => {
    const centre = centroidOf(group);
    return caregivers.map((caregiver) => distance(caregiver.base, centre));
  });
  const chosen = assignMinimumCost(cost);

  const routes = groups.map((group, g) => {
    const caregiver = caregivers[chosen[g]!]!;
    return {
      caregiverId: caregiver.id,
      ...buildTimetable({
        base: caregiver.base,
        stops: orderRoute(caregiver.base, group),
        shiftStart,
        shiftEnd,
        visitMinutes,
        travel,
      }),
    };
  });
  return { routes, unplaced: routes.flatMap((route) => route.unplaced) };
}
