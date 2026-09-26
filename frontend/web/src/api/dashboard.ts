// Typed shapes and calls for GET /dashboard/overview (backend/src/routes/dashboard.ts) and the
// alert acknowledgement the Overview page offers inline (routes/notifications.ts).

import type { ApiClient } from './client';

/** The Overview map's colour for a visit - see backend/src/routes/dashboard.ts's visitState. */
export type VisitState = 'upcoming' | 'awaiting_checkin' | 'checked_in' | 'no_checkin';

export interface OverviewVisit {
  id: string;
  state: VisitState;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  checkinAt: string | null;
  checkoutAt: string | null;
  caregiver: { id: string; fullName: string; phoneNumber: string };
  dependant: { id: string; fullName: string; lat: number; lng: number };
}

export interface TrendDay {
  date: string;
  completed: number;
  missed: number;
  cancelled: number;
  open: number;
}

export interface MissedVisitAlert {
  id: string;
  sentAt: string | null;
  visitScheduleId: string;
  scheduledStart: string;
  dependantName: string;
  caregiverName: string;
}

export interface DashboardOverview {
  // SAMPLE DATA (remove with api/dashboardSample.ts): true when the page shows generated data.
  sample?: boolean;
  date: string;
  timeZone: string;
  generatedAt: string;
  visits: OverviewVisit[];
  trend: TrendDay[];
  /** Completed and missed visits in the 14 days before the trend, to compare rates with. */
  previousPeriod: { completed: number; missed: number };
  attention: {
    missedVisitAlerts: { total: number; items: MissedVisitAlert[] };
    flaggedPhotos: number;
    dependantsWithoutPhoto: { total: number; items: { id: string; fullName: string }[] };
  };
}

// SAMPLE DATA (remove with api/dashboardSample.ts): VITE_DASHBOARD_SAMPLE_DATA=true in the local
// .env swaps the Overview's data for a generated busy day. The sample module is its own chunk,
// only downloaded when the flag is on.
const useSampleData = import.meta.env.VITE_DASHBOARD_SAMPLE_DATA === 'true';

export function createDashboardApi(client: ApiClient) {
  return {
    getOverview: async (date: string) => {
      if (useSampleData) {
        return (await import('./dashboardSample')).sampleOverview(date);
      }
      return client.get<DashboardOverview>(`/dashboard/overview?date=${encodeURIComponent(date)}`);
    },
    acknowledgeAlert: async (notificationId: string) => {
      if (useSampleData) {
        return (await import('./dashboardSample')).acknowledgeSampleAlert(notificationId);
      }
      return client.post<unknown>(`/notifications/${notificationId}/acknowledge`);
    },
  };
}
