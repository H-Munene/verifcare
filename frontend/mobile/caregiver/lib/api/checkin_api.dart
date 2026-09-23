// POST /visit-schedules/{id}/checkin/geofence only, this pass - the caregiver/dependant photo
// steps (backend/src/routes/checkin.ts's .../caregiver-liveness, .../dependant-liveness) are
// separate, later work (docs/caregiver-checkin-geofence-plan.md's suggested build order, HEZ-34/
// HEZ-68), not part of screen 04's geofence-only scope.

import 'api_client.dart';

/// backend's GeofenceFailureReason (checkin.ts) - a 422's Problem.failureReason. mockLocation is a
/// hard block (no retry, per the wireframe's screen 05 third state); outOfRange/
/// insufficientAccuracy are both retriable (the wireframe's second state) - grouped together here
/// since the app has nothing more specific to say for either beyond the server's own `detail` text.
enum GeofenceFailureReason {
  outOfRange,
  insufficientAccuracy,
  mockLocation,
  unknown,
}

GeofenceFailureReason parseGeofenceFailureReason(String? value) {
  switch (value) {
    case 'out_of_range':
      return GeofenceFailureReason.outOfRange;
    case 'insufficient_accuracy':
      return GeofenceFailureReason.insufficientAccuracy;
    case 'mock_location_detected':
      return GeofenceFailureReason.mockLocation;
    default:
      return GeofenceFailureReason.unknown;
  }
}

bool isRetriableGeofenceFailure(GeofenceFailureReason reason) =>
    reason == GeofenceFailureReason.outOfRange ||
    reason == GeofenceFailureReason.insufficientAccuracy;

class GeofenceCheckinResult {
  final String sessionToken;
  final double distanceFromGeofenceMeters;
  final DateTime expiresAt;

  GeofenceCheckinResult({
    required this.sessionToken,
    required this.distanceFromGeofenceMeters,
    required this.expiresAt,
  });

  factory GeofenceCheckinResult.fromJson(Map<String, dynamic> json) {
    return GeofenceCheckinResult(
      sessionToken: json['sessionToken'] as String,
      distanceFromGeofenceMeters: (json['distanceFromGeofenceMeters'] as num)
          .toDouble(),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }
}

class CheckinApi {
  final ApiClient _client;

  CheckinApi(this._client);

  /// Throws [ApiException] on a 422 (see [Problem.failureReason]/[parseGeofenceFailureReason]) or
  /// any other non-2xx - the caller decides how to present that, this layer only makes the
  /// machine-readable reason easy to get at rather than requiring detail-string parsing.
  Future<GeofenceCheckinResult> submitGeofenceCheckin({
    required String visitScheduleId,
    required double gpsLat,
    required double gpsLng,
    required double accuracyMeters,
    required bool isMockLocation,
  }) async {
    final json = await _client
        .post('/visit-schedules/$visitScheduleId/checkin/geofence', {
          'gpsLat': gpsLat,
          'gpsLng': gpsLng,
          'accuracyMeters': accuracyMeters,
          'isMockLocation': isMockLocation,
        });
    return GeofenceCheckinResult.fromJson(json);
  }
}
