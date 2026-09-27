// The Overview map's homes: the day's visits grouped by dependant, since a dot stands for a home
// and a home can have several visits in a day. Shared by the Google and OpenStreetMap versions.

import type { OverviewVisit } from '../api/dashboard';

export interface Home {
  dependantId: string;
  dependantName: string;
  position: { lat: number; lng: number };
  visits: OverviewVisit[];
}

export function groupByHome(visits: OverviewVisit[]): Home[] {
  const homes = new Map<string, Home>();
  for (const visit of visits) {
    const home = homes.get(visit.dependant.id);
    if (home) {
      home.visits.push(visit);
    } else {
      homes.set(visit.dependant.id, {
        dependantId: visit.dependant.id,
        dependantName: visit.dependant.fullName,
        position: { lat: visit.dependant.lat, lng: visit.dependant.lng },
        visits: [visit],
      });
    }
  }
  return [...homes.values()];
}
