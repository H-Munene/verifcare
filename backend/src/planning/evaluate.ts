// How much distance day planning saves, for the report (npm run plan:evaluate). Each scenario is
// seeded synthetic data shaped like Nairobi: homes around several neighbourhoods, caregivers living
// across the city. The baselines are what a person might plausibly do by hand:
//   - by name: dependants sorted alphabetically and dealt out evenly, visited in that order.
//   - random: the same even split in a random order.
//
// Straight-line distance throughout, so this compares plans with each other. It doesn't estimate
// real road kilometres.

import { haversineDistanceMeters } from '../geo.js';
import { planDay, seededRandom, type GeoPoint, type PlanCaregiver, type PlanStop } from './plan.js';

const NEIGHBOURHOODS: GeoPoint[] = [
  { lat: -1.2921, lng: 36.8219 },
  { lat: -1.2676, lng: 36.8108 },
  { lat: -1.3032, lng: 36.7073 },
  { lat: -1.2195, lng: 36.8869 },
  { lat: -1.3128, lng: 36.8947 },
  { lat: -1.2571, lng: 36.7426 },
];

const SHIFT_START = new Date('2026-11-10T05:00:00Z');
const SHIFT_END = new Date('2026-11-10T17:00:00Z');
const VISIT_MINUTES = 45;

function around(centre: GeoPoint, random: () => number, spread: number): GeoPoint {
  return {
    lat: centre.lat + (random() - 0.5) * spread,
    lng: centre.lng + (random() - 0.5) * spread,
  };
}

function scenario(seed: number, dependants: number, caregiverCount: number) {
  const random = seededRandom(seed);
  const pick = () => NEIGHBOURHOODS[Math.floor(random() * NEIGHBOURHOODS.length)]!;
  const stops: PlanStop[] = Array.from({ length: dependants }, (_, i) => ({
    id: `d${String(Math.floor(random() * 1e6)).padStart(6, '0')}-${i}`,
    ...around(pick(), random, 0.03),
  }));
  const caregivers: PlanCaregiver[] = Array.from({ length: caregiverCount }, (_, i) => ({
    id: `c${i}`,
    base: around(pick(), random, 0.03),
  }));
  return { stops, caregivers, random };
}

function routeKm(base: GeoPoint, stops: GeoPoint[]): number {
  let total = 0;
  let here = base;
  for (const stop of stops) {
    total += haversineDistanceMeters(here.lat, here.lng, stop.lat, stop.lng);
    here = stop;
  }
  return total / 1000;
}

function dealtOutKm(stops: PlanStop[], caregivers: PlanCaregiver[]): number {
  const routes: PlanStop[][] = caregivers.map(() => []);
  stops.forEach((stop, i) => routes[i % caregivers.length]!.push(stop));
  return routes.reduce((sum, route, i) => sum + routeKm(caregivers[i]!.base, route), 0);
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const round = (value: number) => Math.round(value * 10) / 10;

export function evaluate(): {
  dependants: number;
  caregivers: number;
  plannedKm: number;
  byNameKm: number;
  randomKm: number;
  savingVsName: number;
  savingVsRandom: number;
  unplaced: number;
}[] {
  const sizes = [
    [12, 3],
    [24, 4],
    [40, 6],
    [60, 8],
  ] as const;
  const seeds = [11, 23, 37, 41, 53, 67, 79, 83, 97, 101];

  return sizes.map(([dependants, caregiverCount]) => {
    let plannedKm = 0;
    let byNameKm = 0;
    let randomKm = 0;
    let unplaced = 0;
    for (const seed of seeds) {
      const { stops, caregivers, random } = scenario(seed, dependants, caregiverCount);
      const plan = planDay({
        stops,
        caregivers,
        shiftStart: SHIFT_START,
        shiftEnd: SHIFT_END,
        visitMinutes: VISIT_MINUTES,
      });
      plannedKm += plan.routes.reduce((sum, route) => sum + route.totalDistanceMeters, 0) / 1000;
      unplaced += plan.unplaced.length;
      byNameKm += dealtOutKm(
        [...stops].sort((a, b) => a.id.localeCompare(b.id)),
        caregivers,
      );
      randomKm += dealtOutKm(shuffled(stops, random), caregivers);
    }
    return {
      dependants,
      caregivers: caregiverCount,
      plannedKm: round(plannedKm / seeds.length),
      byNameKm: round(byNameKm / seeds.length),
      randomKm: round(randomKm / seeds.length),
      savingVsName: round((1 - plannedKm / byNameKm) * 100),
      savingVsRandom: round((1 - plannedKm / randomKm) * 100),
      unplaced: round(unplaced / seeds.length),
    };
  });
}

if (process.argv[1]?.endsWith('evaluate.ts')) {
  console.table(evaluate());
}
