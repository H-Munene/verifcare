// The check-in flow's server steps (backend/src/routes/checkin.ts): geofence, then scanning the
// code on a family member's phone, or asking a supervisor if nobody from the family is there. Every
// step after geofence needs the geofence step's sessionToken in X-Checkin-Session-Token, alongside
// the normal bearer token.

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

class CheckinOverride {
  final String status; // pending | approved | denied
  final String? decisionNote;

  CheckinOverride({required this.status, this.decisionNote});

  factory CheckinOverride.fromJson(Map<String, dynamic> json) => switch (json) {
    {'status': String status} => CheckinOverride(
      status: status,
      decisionNote: json['decisionNote'] as String?,
    ),
    _ => throw FormatException('Unexpected check-in override: $json'),
  };
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

  /// Starts the visit. A refused code is a 422 ([ApiException]) whose detail says what to do next.
  Future<void> scanCode({
    required String visitScheduleId,
    required String sessionToken,
    required String token,
  }) async {
    await _client.post(
      '/visit-schedules/$visitScheduleId/checkin/qr-scan',
      {'token': token},
      headers: {'X-Checkin-Session-Token': sessionToken},
    );
  }

  /// Starts the visit with the 6 digits under the family's check-in code. A refused code is a
  /// 422 saying how many tries are left; too many wrong codes is a 429.
  Future<void> enterCode({
    required String visitScheduleId,
    required String sessionToken,
    required String code,
  }) async {
    await _client.post(
      '/visit-schedules/$visitScheduleId/checkin/code',
      {'code': code},
      headers: {'X-Checkin-Session-Token': sessionToken},
    );
  }

  Future<void> requestOverride({
    required String visitScheduleId,
    required String sessionToken,
    required String reason,
    String? note,
  }) async {
    await _client.post(
      '/visit-schedules/$visitScheduleId/checkin/override',
      {'reason': reason, 'note': ?note},
      headers: {'X-Checkin-Session-Token': sessionToken},
    );
  }

  /// The latest request for this visit, or null if none was ever made.
  Future<CheckinOverride?> latestOverride(String visitScheduleId) async {
    try {
      return CheckinOverride.fromJson(
        await _client.get('/visit-schedules/$visitScheduleId/checkin/override'),
      );
    } on ApiException catch (e) {
      if (e.problem.status == 404) return null;
      rethrow;
    }
  }
}
