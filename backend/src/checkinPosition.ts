// The position check shared by both phones at check-in: the caregiver's (routes/checkin.ts) and the
// family member's when it issues a code (routes/checkinCode.ts). One function, so "at the home"
// means the same thing for both and neither can drift to a weaker rule.

import { z } from 'zod';
import { haversineDistanceMeters } from './geo.js';

export const devicePositionSchema = z.object({
  gpsLat: z.number().min(-90).max(90),
  gpsLng: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  isMockLocation: z.boolean(),
});
export type DevicePosition = z.infer<typeof devicePositionSchema>;

export type PositionFailureReason =
  'mock_location_detected' | 'insufficient_accuracy' | 'out_of_range';

export interface HomeGeofence {
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
}

export function assessPosition(
  position: DevicePosition,
  home: HomeGeofence,
  accuracyThresholdMeters: number,
): { distanceMeters: number; failureReason: PositionFailureReason | undefined } {
  const distanceMeters = haversineDistanceMeters(
    position.gpsLat,
    position.gpsLng,
    home.geofenceLat,
    home.geofenceLng,
  );
  let failureReason: PositionFailureReason | undefined;
  if (position.isMockLocation) {
    failureReason = 'mock_location_detected';
  } else if (position.accuracyMeters > accuracyThresholdMeters) {
    failureReason = 'insufficient_accuracy';
  } else if (distanceMeters > home.geofenceRadiusMeters) {
    failureReason = 'out_of_range';
  }
  return { distanceMeters, failureReason };
}

export function positionFailureDetail(reason: PositionFailureReason): string {
  switch (reason) {
    case 'mock_location_detected':
      return 'The device reported a mock/simulated location, which is never accepted.';
    case 'insufficient_accuracy':
      return 'The device-reported GPS accuracy is worse than this check-in requires.';
    case 'out_of_range':
      return "The device is outside the dependant's registered geofence.";
  }
}
