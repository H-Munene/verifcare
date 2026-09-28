// The check-in flow's three server steps (backend/src/routes/checkin.ts): geofence, then the
// caregiver photo, then the dependant photo. Every step after geofence needs the geofence step's
// sessionToken in X-Checkin-Session-Token, alongside the normal bearer token.

import 'api_client.dart';

enum CheckinSubject { caregiver, dependant }

class LivenessResult {
  final bool passed;
  final String? failureReason;

  LivenessResult({required this.passed, this.failureReason});

  factory LivenessResult.fromJson(Map<String, dynamic> json) => switch (json) {
    {'passed': bool passed} => LivenessResult(
      passed: passed,
      failureReason: json['failureReason'] as String?,
    ),
    _ => throw FormatException('Unexpected liveness result: $json'),
  };
}

/// Human wording for LivenessResult.failureReason - values from checkin.ts
/// (no_face_detected/multiple_faces_detected from db/checkinLiveness.ts, plus not_enrolled and
/// identity_mismatch from the face-match step).
String describeLivenessFailure(String? reason) => switch (reason) {
  'no_face_detected' => 'no face was detected',
  'multiple_faces_detected' => 'more than one face was in the photo',
  'identity_mismatch' => "the face didn't match the enrolled photos",
  'not_enrolled' => 'no enrollment photos exist - contact your supervisor',
  _ => 'the photo could not be verified',
};

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

GeofenceFailureReason parseGeofenceFailureReason(String? value) =>
    switch (value) {
      'out_of_range' => GeofenceFailureReason.outOfRange,
      'insufficient_accuracy' => GeofenceFailureReason.insufficientAccuracy,
      'mock_location_detected' => GeofenceFailureReason.mockLocation,
      _ => GeofenceFailureReason.unknown,
    };

bool isRetriableGeofenceFailure(GeofenceFailureReason reason) =>
    switch (reason) {
      GeofenceFailureReason.outOfRange ||
      GeofenceFailureReason.insufficientAccuracy => true,
      GeofenceFailureReason.mockLocation ||
      GeofenceFailureReason.unknown => false,
    };

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

  /// Presign + upload only. Split from [submitLiveness] because the two subjects' uploads may run
  /// concurrently, but the backend only accepts the dependant submission once the caregiver's has
  /// passed (and within its co-presence window) - see PhotoVerificationScreen.
  Future<String> uploadLivenessPhoto({
    required String visitScheduleId,
    required CheckinSubject subject,
    required String sessionToken,
    required List<int> jpegBytes,
  }) async {
    final presign = await _client.post(
      '/visit-schedules/$visitScheduleId/checkin/${subject.name}-liveness/upload-url',
      {'contentType': 'image/jpeg'},
      headers: {'X-Checkin-Session-Token': sessionToken},
    );
    await ApiClient.uploadToPresignedUrl(
      presign['uploadUrl'] as String,
      jpegBytes,
      'image/jpeg',
    );
    return presign['s3Key'] as String;
  }

  /// A failed face check is a normal 200 with passed: false, not an exception - only
  /// precondition failures (expired session, co-presence window) throw [ApiException].
  Future<LivenessResult> submitLiveness({
    required String visitScheduleId,
    required CheckinSubject subject,
    required String sessionToken,
    required String s3Key,
  }) async {
    final json = await _client.post(
      '/visit-schedules/$visitScheduleId/checkin/${subject.name}-liveness',
      {'s3Key': s3Key},
      headers: {'X-Checkin-Session-Token': sessionToken},
    );
    return LivenessResult.fromJson(json);
  }
}
