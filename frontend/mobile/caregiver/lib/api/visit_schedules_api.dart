// Typed request/response shapes and calls for GET /visit-schedules and
// GET /visit-schedules/{id}/checkin/context, matching backend/openapi.yaml exactly - not
// re-derived from scratch. Mirrors frontend/web/src/api/visitSchedules.ts's module shape, trimmed
// to the reads this app's first pass needs (no create/update - only a supervisor may schedule or
// reschedule a visit, per visitSchedules.ts's own RBAC).

import 'api_client.dart';

typedef VisitStatus = String;

// Real values: 'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled' | 'investigated'
// (docs/schema.sql's visit_schedules.status CHECK). A plain typedef, not an enum, so an unexpected
// future value (e.g. a new status added server-side) round-trips through the UI as an unstyled
// fallback instead of throwing at JSON-decode time.

class VisitSchedule {
  final String id;
  final String caregiverId;
  final String dependantId;
  // Added to VisitScheduleResponse for HEZ-66 - this list endpoint is the only one a caregiver can
  // call at all (GET /dependants is supervisor/family_member-only), so without this the calendar
  // screen would have no way to show whose visit each row is.
  final String caregiverDisplayName;
  final String dependantDisplayName;
  final DateTime scheduledStart;
  final DateTime scheduledEnd;
  final VisitStatus status;

  /// This visit's place in a planned route; null for a visit booked by hand.
  final int? routeSequence;

  /// The visit this one took over from another caregiver, if any.
  final String? recoveredFromVisitId;
  final String createdBy;
  final DateTime createdAt;
  final DateTime updatedAt;

  VisitSchedule({
    required this.id,
    required this.caregiverId,
    required this.dependantId,
    required this.caregiverDisplayName,
    required this.dependantDisplayName,
    required this.scheduledStart,
    required this.scheduledEnd,
    required this.status,
    this.routeSequence,
    this.recoveredFromVisitId,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
  });

  factory VisitSchedule.fromJson(Map<String, dynamic> json) {
    return VisitSchedule(
      id: json['id'] as String,
      caregiverId: json['caregiverId'] as String,
      dependantId: json['dependantId'] as String,
      caregiverDisplayName: json['caregiverDisplayName'] as String,
      dependantDisplayName: json['dependantDisplayName'] as String,
      scheduledStart: DateTime.parse(
        json['scheduledStart'] as String,
      ).toLocal(),
      scheduledEnd: DateTime.parse(json['scheduledEnd'] as String).toLocal(),
      status: json['status'] as String,
      routeSequence: json['routeSequence'] as int?,
      recoveredFromVisitId: json['recoveredFromVisitId'] as String?,
      createdBy: json['createdBy'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      updatedAt: DateTime.parse(json['updatedAt'] as String).toLocal(),
    );
  }
}

class VisitSchedulePage {
  final List<VisitSchedule> items;
  final String? nextCursor;

  VisitSchedulePage({required this.items, this.nextCursor});

  factory VisitSchedulePage.fromJson(Map<String, dynamic> json) {
    return VisitSchedulePage(
      items: (json['items'] as List)
          .map((item) => VisitSchedule.fromJson(item as Map<String, dynamic>))
          .toList(),
      nextCursor: json['nextCursor'] as String?,
    );
  }
}

/// GET .../checkin/context (new this pass, backend/src/routes/checkin.ts) - deliberately narrow:
/// enough to render the check-in map (dependant name/address, geofence circle), not the full
/// dependant record. See docs/caregiver-checkin-geofence-plan.md section 3 for why this exists.
class CheckinContext {
  final String dependantDisplayName;
  final String? dependantHomeAddressText;
  final double geofenceLat;
  final double geofenceLng;
  final int geofenceRadiusMeters;

  CheckinContext({
    required this.dependantDisplayName,
    this.dependantHomeAddressText,
    required this.geofenceLat,
    required this.geofenceLng,
    required this.geofenceRadiusMeters,
  });

  factory CheckinContext.fromJson(Map<String, dynamic> json) {
    return CheckinContext(
      dependantDisplayName: json['dependantDisplayName'] as String,
      dependantHomeAddressText: json['dependantHomeAddressText'] as String?,
      geofenceLat: (json['geofenceLat'] as num).toDouble(),
      geofenceLng: (json['geofenceLng'] as num).toDouble(),
      geofenceRadiusMeters: json['geofenceRadiusMeters'] as int,
    );
  }
}

class ListVisitSchedulesParams {
  final VisitStatus? status;
  final DateTime? scheduledStartFrom;
  final DateTime? scheduledStartTo;
  final String? cursor;
  final int? limit;

  const ListVisitSchedulesParams({
    this.status,
    this.scheduledStartFrom,
    this.scheduledStartTo,
    this.cursor,
    this.limit,
  });

  // caregiverId is deliberately never a param here - the backend derives "this caller's own
  // visits" from the authenticated caregiver's identity for the caregiver role
  // (routes/visitSchedules.ts), not a client-supplied filter.
  String toQueryString() {
    final query = <String, String>{};
    if (status != null) query['status'] = status!;
    if (scheduledStartFrom != null) {
      query['scheduledStartFrom'] = scheduledStartFrom!
          .toUtc()
          .toIso8601String();
    }
    if (scheduledStartTo != null) {
      query['scheduledStartTo'] = scheduledStartTo!.toUtc().toIso8601String();
    }
    if (cursor != null) query['cursor'] = cursor!;
    if (limit != null) query['limit'] = limit.toString();
    if (query.isEmpty) return '';
    return '?${Uri(queryParameters: query).query}';
  }
}

class VisitSchedulesApi {
  final ApiClient _client;

  VisitSchedulesApi(this._client);

  Future<VisitSchedulePage> listVisitSchedules([
    ListVisitSchedulesParams params = const ListVisitSchedulesParams(),
  ]) async {
    final json = await _client.get('/visit-schedules${params.toQueryString()}');
    return VisitSchedulePage.fromJson(json);
  }

  Future<CheckinContext> getCheckinContext(String visitScheduleId) async {
    final json = await _client.get(
      '/visit-schedules/$visitScheduleId/checkin/context',
    );
    return CheckinContext.fromJson(json);
  }

  Future<VisitSchedule> getVisitSchedule(String visitScheduleId) async =>
      VisitSchedule.fromJson(
        await _client.get('/visit-schedules/$visitScheduleId'),
      );

  Future<VerificationAudit> getVerification(String visitScheduleId) async =>
      VerificationAudit.fromJson(
        await _client.get('/visit-schedules/$visitScheduleId/verification'),
      );

  // Only callable while the visit is in_progress (backend/src/routes/visitTasks.ts).
  Future<List<VisitTask>> listTasks(String visitScheduleId) async {
    final json = await _client.getList(
      '/visit-schedules/$visitScheduleId/tasks',
    );
    return json
        .map((item) => VisitTask.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  /// [reason] must be set for, and only for, 'not_completed' (mirrors the backend's own rule).
  Future<void> putTask(
    String visitScheduleId,
    String careTaskId, {
    required String status,
    String? reason,
    String? notes,
  }) async {
    await _client.put('/visit-schedules/$visitScheduleId/tasks/$careTaskId', {
      'status': status,
      'reason': ?reason,
      'notes': ?notes,
    });
  }

  /// Asks to check out from where the caregiver is now. The server checks every requirement (inside
  /// the home's radius, required tasks addressed, both recordings or a reason for the dependant's),
  /// refusing with what's missing, and then the family can show their check-out code.
  Future<void> requestCheckout(
    String visitScheduleId, {
    required double gpsLat,
    required double gpsLng,
    String? audioSkipReason,
    String? audioSkipNote,
  }) async {
    await _client.post('/visit-schedules/$visitScheduleId/checkout/request', {
      'gpsLat': gpsLat,
      'gpsLng': gpsLng,
      'audioSkipReason': ?audioSkipReason,
      'audioSkipNote': ?audioSkipNote,
    });
  }

  /// Completes check-out with the QR code scanned from the family member's phone.
  Future<void> checkoutWithQr(
    String visitScheduleId, {
    required String token,
    required double gpsLat,
    required double gpsLng,
  }) async {
    await _client.post('/visit-schedules/$visitScheduleId/checkout/qr-scan', {
      'token': token,
      'gpsLat': gpsLat,
      'gpsLng': gpsLng,
    });
  }

  /// Completes check-out with the 6 digits shown under the family member's QR code.
  Future<void> checkoutWithCode(
    String visitScheduleId, {
    required String code,
    required double gpsLat,
    required double gpsLng,
  }) async {
    await _client.post('/visit-schedules/$visitScheduleId/checkout/code', {
      'code': code,
      'gpsLat': gpsLat,
      'gpsLng': gpsLng,
    });
  }

  /// Completes check-out without the family's code, at once. Supervisors see [reason] afterwards.
  Future<void> checkoutWithOverride(
    String visitScheduleId, {
    required String reason,
    String? note,
    required double gpsLat,
    required double gpsLng,
  }) async {
    await _client.post('/visit-schedules/$visitScheduleId/checkout/override', {
      'reason': reason,
      'note': ?note,
      'gpsLat': gpsLat,
      'gpsLng': gpsLng,
    });
  }

  Future<List<RecoveryOffer>> myRecoveryOffers() async {
    final json = await _client.get('/recovery-offers/mine');
    return (json['items'] as List)
        .map((item) => RecoveryOffer.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<void> acceptRecoveryOffer(String offerId) async {
    await _client.post('/recovery-offers/$offerId/accept', const {});
  }

  Future<void> declineRecoveryOffer(String offerId) async {
    await _client.post('/recovery-offers/$offerId/decline', const {});
  }

  /// Whether the dependant's recording is needed (their family consented to it being recorded)
  /// and whether the server already holds it. Only the dependant is recorded since 2026-11-24.
  Future<({bool required, bool recorded})> dependantAudioRequirement(
    String visitScheduleId,
  ) async {
    final json = await _client.get(
      '/visit-schedules/$visitScheduleId/audio/requirement',
    );
    final dependant = json['dependant'] as Map<String, dynamic>;
    return (
      required: dependant['required'] as bool,
      recorded: dependant['recorded'] as bool,
    );
  }

  /// Presign, upload straight to S3, then confirm, which also checks the voice against the
  /// dependant's voiceprint and returns the result. Safe to repeat: a retry replaces the recording
  /// and its check.
  Future<VoiceCheck> uploadDependantAudio(
    String visitScheduleId, {
    required List<int> bytes,
    required int durationSeconds,
  }) async {
    final presign = await _client.post(
      '/visit-schedules/$visitScheduleId/audio/dependant/upload-url',
      const {},
    );
    await ApiClient.uploadToPresignedUrl(
      presign['uploadUrl'] as String,
      bytes,
      'audio/mp4',
    );
    final confirmed = await _client.post(
      '/visit-schedules/$visitScheduleId/audio/dependant',
      {'s3Key': presign['s3Key'], 'durationSeconds': durationSeconds},
    );
    return VoiceCheck.fromJson(confirmed['voiceCheck'] as Map<String, dynamic>);
  }
}

/// The voice check of a visit recording (backend/src/voiceChecks.ts). Advisory: a failed check can
/// be recorded again, but never stops check-out.
class VoiceCheck {
  /// match, mismatch, too_short, not_enrolled, no_consent or unavailable.
  final String result;

  /// How alike the recording and the voiceprint are, 0 to 1; null when nothing was compared.
  final double? score;
  final double? threshold;

  const VoiceCheck({required this.result, this.score, this.threshold});

  factory VoiceCheck.fromJson(Map<String, dynamic> json) => VoiceCheck(
    result: json['result'] as String,
    score: (json['score'] as num?)?.toDouble(),
    threshold: (json['threshold'] as num?)?.toDouble(),
  );

  bool get passed => result == 'match';

  /// No comparison was made: the dependant has no voiceprint, or no consent to voice checks.
  bool get notChecked => result == 'not_enrolled' || result == 'no_consent';
}

/// A request to cover another caregiver's late visit. Deliberately only the area and times: the
/// name and address follow if it's accepted.
class RecoveryOffer {
  final String id;
  final DateTime proposedStart;
  final DateTime proposedEnd;
  final int distanceMeters;
  final DateTime expiresAt;
  final String? ward;

  RecoveryOffer({
    required this.id,
    required this.proposedStart,
    required this.proposedEnd,
    required this.distanceMeters,
    required this.expiresAt,
    this.ward,
  });

  factory RecoveryOffer.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'id': String id,
      'proposedStart': String start,
      'proposedEnd': String end,
      'distanceMeters': int distanceMeters,
      'expiresAt': String expiresAt,
    } =>
      RecoveryOffer(
        id: id,
        proposedStart: DateTime.parse(start).toLocal(),
        proposedEnd: DateTime.parse(end).toLocal(),
        distanceMeters: distanceMeters,
        expiresAt: DateTime.parse(expiresAt).toLocal(),
        ward: json['ward'] as String?,
      ),
    _ => throw FormatException('Unexpected recovery offer: $json'),
  };
}

/// One care-plan task as seen from a visit (GET .../tasks) - status is null until recorded.
class VisitTask {
  final String careTaskId;
  final String title;
  final String? description;
  final bool required;
  final String? status;

  VisitTask({
    required this.careTaskId,
    required this.title,
    this.description,
    required this.required,
    this.status,
  });

  // Required keys validated by the map pattern (fast-fail on a malformed row); the nullable
  // ones are read directly, since a map pattern also requires the key to be present.
  factory VisitTask.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'careTaskId': String careTaskId,
      'title': String title,
      'required': bool required,
    } =>
      VisitTask(
        careTaskId: careTaskId,
        title: title,
        description: json['description'] as String?,
        required: required,
        status: json['status'] as String?,
      ),
    _ => throw FormatException('Unexpected visit task: $json'),
  };
}

/// GET .../verification, trimmed to what the visit timeline reads.
class VerificationAudit {
  final DateTime? arrivedAt;
  final DateTime? checkinAt;
  final DateTime? checkoutAt;

  /// 'qr' or 'supervisor_override'; null until the visit has started.
  final String? checkinMethod;

  VerificationAudit({
    this.arrivedAt,
    this.checkinAt,
    this.checkoutAt,
    this.checkinMethod,
  });

  factory VerificationAudit.fromJson(Map<String, dynamic> json) {
    DateTime? parse(Object? value) => switch (value) {
      String iso => DateTime.parse(iso).toLocal(),
      null => null,
      _ => throw FormatException('Expected an ISO timestamp, got $value'),
    };
    if (json case {
      'event': Map<String, dynamic>? event,
      'attempts': List<dynamic> attempts,
    }) {
      return VerificationAudit(
        // The first passing geofence check is when the caregiver reached the home.
        arrivedAt: parse(
          attempts
              .map((a) => a as Map<String, dynamic>)
              .where(
                (a) => a['attemptType'] == 'geofence' && a['passed'] == true,
              )
              .firstOrNull?['attemptedAt'],
        ),
        checkinAt: parse(event?['checkinAt']),
        checkoutAt: parse(event?['checkoutAt']),
        checkinMethod: event?['checkinMethod'] as String?,
      );
    }
    throw FormatException('Unexpected verification audit: $json');
  }
}
