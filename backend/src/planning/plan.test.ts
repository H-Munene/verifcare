import { describe, expect, it } from 'vitest';
import { haversineDistanceMeters } from '../geo.js';
import {
  assignMinimumCost,
  buildTimetable,
  clusterPoints,
  orderRoute,
  planDay,
  seededRandom,
  travelMinutes,
  type GeoPoint,
  type PlanStop,
} from './plan.js';

// Two tight neighbourhoods about 10 km apart.
const WEST: GeoPoint = { lat: -1.29, lng: 36.75 };
const EAST: GeoPoint = { lat: -1.29, lng: 36.84 };

function near(centre: GeoPoint, i: number): GeoPoint {
  return { lat: centre.lat + i * 0.0005, lng: centre.lng + (i % 3) * 0.0005 };
}

function stopsAround(centre: GeoPoint, prefix: string, count: number): PlanStop[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, ...near(centre, i) }));
}

const shiftStart = new Date('2026-11-10T05:00:00Z'); // 08:00 Nairobi
const shiftEnd = new Date('2026-11-10T14:00:00Z'); // 17:00 Nairobi

describe('clusterPoints', () => {
  it('separates two neighbourhoods', () => {
    const points = [...stopsAround(WEST, 'w', 4), ...stopsAround(EAST, 'e', 4)];

    const groups = clusterPoints(points, 2);

    const names = groups.map((g) => g.map((i) => points[i]!.id[0])).map((g) => [...new Set(g)]);
    expect(names).toHaveLength(2);
    expect(names.every((g) => g.length === 1)).toBe(true);
  });

  it('keeps workloads even, even when homes are lopsided', () => {
    const points = [...stopsAround(WEST, 'w', 9), ...stopsAround(EAST, 'e', 1)];

    const sizes = clusterPoints(points, 2).map((g) => g.length);

    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
    expect(sizes.reduce((a, b) => a + b)).toBe(10);
  });

  it('places every point exactly once', () => {
    const points = [...stopsAround(WEST, 'w', 7), ...stopsAround(EAST, 'e', 6)];

    const all = clusterPoints(points, 4)
      .flat()
      .sort((a, b) => a - b);

    expect(all).toEqual(points.map((_, i) => i));
  });

  it('gives the same answer every time for a seed', () => {
    const points = [...stopsAround(WEST, 'w', 6), ...stopsAround(EAST, 'e', 6)];

    expect(clusterPoints(points, 3, 7)).toEqual(clusterPoints(points, 3, 7));
  });

  it('never makes more groups than points, and copes with nothing to do', () => {
    expect(clusterPoints(stopsAround(WEST, 'w', 2), 5)).toHaveLength(2);
    expect(clusterPoints([], 3)).toEqual([]);
    expect(clusterPoints(stopsAround(WEST, 'w', 2), 0)).toEqual([]);
  });

  it('copes with several homes at the same point', () => {
    const points = Array.from({ length: 4 }, () => WEST);

    expect(clusterPoints(points, 2).flat()).toHaveLength(4);
  });
});

describe('assignMinimumCost', () => {
  it('finds the cheapest overall pairing, where a greedy choice would not', () => {
    // Greedy takes row 0 -> column 0 (cost 1), forcing row 1 -> column 1 (cost 100): total 101.
    const cost = [
      [1, 2],
      [1, 100],
    ];

    expect(assignMinimumCost(cost)).toEqual([1, 0]);
  });

  it('handles more columns than rows', () => {
    expect(
      assignMinimumCost([
        [9, 1, 9],
        [9, 9, 2],
      ]),
    ).toEqual([1, 2]);
  });

  it('copes with nothing to assign', () => {
    expect(assignMinimumCost([])).toEqual([]);
  });
});

describe('orderRoute', () => {
  it('visits points along a line in order, whatever order they arrive in', () => {
    const start = { lat: -1.3, lng: 36.7 };
    const line = [3, 1, 4, 2].map((i) => ({ id: `${i}`, lat: -1.3, lng: 36.7 + i * 0.01 }));

    expect(orderRoute(start, line).map((s) => s.id)).toEqual(['1', '2', '3', '4']);
  });

  it('does not lose or repeat a stop', () => {
    const stops = stopsAround(WEST, 's', 9);

    const ordered = orderRoute(EAST, stops);

    expect(ordered.map((s) => s.id).sort()).toEqual(stops.map((s) => s.id).sort());
  });

  it('copes with no stops', () => {
    expect(orderRoute(WEST, [])).toEqual([]);
  });
});

describe('travelMinutes', () => {
  it('applies the road factor and speed, rounding up', () => {
    // 5 km straight is 7 km by road: 16.8 minutes at 25 km/h.
    expect(travelMinutes(5000)).toBe(17);
  });

  it('takes no time to go nowhere', () => {
    expect(travelMinutes(0)).toBe(0);
  });
});

describe('buildTimetable', () => {
  const base = WEST;
  const stop = (id: string, offset: number): PlanStop => ({
    id,
    lat: WEST.lat,
    lng: WEST.lng + offset,
  });

  it('leaves at shift start, allows for travel, and rounds to five minutes', () => {
    const { stops } = buildTimetable({
      base,
      stops: [stop('a', 0.05)],
      shiftStart,
      shiftEnd,
      visitMinutes: 45,
    });

    expect(stops[0]!.travelMinutes).toBeGreaterThan(0);
    expect(stops[0]!.scheduledStart.getTime() % 300_000).toBe(0);
    expect(stops[0]!.scheduledStart.getTime()).toBeGreaterThanOrEqual(
      shiftStart.getTime() + stops[0]!.travelMinutes * 60_000,
    );
    expect(stops[0]!.scheduledEnd.getTime() - stops[0]!.scheduledStart.getTime()).toBe(2_700_000);
  });

  it('never overlaps one visit with the next', () => {
    const { stops } = buildTimetable({
      base,
      stops: [stop('a', 0.01), stop('b', 0.02), stop('c', 0.03)],
      shiftStart,
      shiftEnd,
      visitMinutes: 30,
    });

    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i]!.scheduledStart.getTime()).toBeGreaterThanOrEqual(
        stops[i - 1]!.scheduledEnd.getTime(),
      );
    }
  });

  it('reports what does not fit, rather than dropping it', () => {
    const shortShift = new Date(shiftStart.getTime() + 90 * 60_000);

    const { stops, unplaced } = buildTimetable({
      base,
      stops: [stop('a', 0.001), stop('b', 0.002), stop('c', 0.003)],
      shiftStart,
      shiftEnd: shortShift,
      visitMinutes: 40,
    });

    expect(stops.map((s) => s.id)).toEqual(['a', 'b']);
    expect(unplaced.map((s) => s.id)).toEqual(['c']);
  });

  it('adds up distance and travel', () => {
    const timetable = buildTimetable({
      base,
      stops: [stop('a', 0.01), stop('b', 0.02)],
      shiftStart,
      shiftEnd,
      visitMinutes: 30,
    });

    expect(timetable.totalDistanceMeters).toBeCloseTo(
      haversineDistanceMeters(WEST.lat, WEST.lng, WEST.lat, WEST.lng + 0.02),
      0,
    );
    expect(timetable.totalTravelMinutes).toBe(
      timetable.stops.reduce((sum, s) => sum + s.travelMinutes, 0),
    );
  });
});

describe('planDay', () => {
  const caregivers = [
    { id: 'near-east', base: { lat: -1.29, lng: 36.85 } },
    { id: 'near-west', base: { lat: -1.29, lng: 36.74 } },
  ];
  const stops = [...stopsAround(WEST, 'w', 3), ...stopsAround(EAST, 'e', 3)];
  const plan = () => planDay({ stops, caregivers, shiftStart, shiftEnd, visitMinutes: 45 });

  it('gives each neighbourhood to the caregiver who lives there', () => {
    const routes = new Map(plan().routes.map((r) => [r.caregiverId, r.stops.map((s) => s.id[0])]));

    expect(new Set(routes.get('near-west'))).toEqual(new Set(['w']));
    expect(new Set(routes.get('near-east'))).toEqual(new Set(['e']));
  });

  it('places every dependant when there is time', () => {
    const result = plan();

    expect(result.unplaced).toEqual([]);
    expect(result.routes.flatMap((r) => r.stops)).toHaveLength(6);
  });

  it('gives identical plans for identical input', () => {
    expect(plan()).toEqual(plan());
  });

  it('leaves everyone unplaced when nobody can visit', () => {
    const result = planDay({ stops, caregivers: [], shiftStart, shiftEnd, visitMinutes: 45 });

    expect(result.routes).toEqual([]);
    expect(result.unplaced).toHaveLength(6);
  });

  it('reports stops that do not fit in any shift', () => {
    const result = planDay({
      stops,
      caregivers,
      shiftStart,
      shiftEnd: new Date(shiftStart.getTime() + 60 * 60_000),
      visitMinutes: 45,
    });

    expect(result.routes.flatMap((r) => r.stops).length + result.unplaced.length).toBe(6);
    expect(result.unplaced.length).toBeGreaterThan(0);
  });
});

describe('seededRandom', () => {
  it('repeats for a seed and stays in range', () => {
    const a = seededRandom(1);
    const b = seededRandom(1);

    for (let i = 0; i < 100; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
