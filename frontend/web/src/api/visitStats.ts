// GET /dependants/{id}/stats and GET /caregivers/{id}/stats share one response shape, matching
// backend/openapi.yaml's VisitStats exactly.

export interface VisitStatsVisit {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  caregiverId: string;
  caregiverName: string;
  dependantId: string;
  dependantName: string;
}

export interface VisitStats {
  windowDays: number;
  visits: { total: number; completed: number; missed: number; cancelled: number; open: number };
  /** completed / (completed + missed), 0-1; null when neither happened in the window. */
  completionRate: number | null;
  lastMissedVisitStart: string | null;
  nextVisit: VisitStatsVisit | null;
  lastVisit: (VisitStatsVisit & { checkinAt: string; checkoutAt: string | null }) | null;
}
