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
}
