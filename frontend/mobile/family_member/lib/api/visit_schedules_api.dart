// A family member's read-only view of their dependants' visits, matching backend/openapi.yaml.
// Every call is scoped server-side to dependants the caller is linked to
// (backend/src/routes/visitSchedules.ts). VisitSchedule and VerificationAudit are copies of the
// caregiver app's own models (frontend/mobile/caregiver/lib/api/visit_schedules_api.dart).

import 'api_client.dart';

// Real values: 'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled' | 'investigated'.
// A plain String, not an enum, so a status added server-side later degrades to an unstyled label
// instead of failing to decode.
typedef VisitStatus = String;

class VisitSchedule {
  final String id;
  final String dependantId;
  final String caregiverDisplayName;
  final String dependantDisplayName;
  final DateTime scheduledStart;
  final DateTime scheduledEnd;
  final VisitStatus status;

  VisitSchedule({
    required this.id,
    required this.dependantId,
    required this.caregiverDisplayName,
    required this.dependantDisplayName,
    required this.scheduledStart,
    required this.scheduledEnd,
    required this.status,
  });

  factory VisitSchedule.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'id': String id,
      'dependantId': String dependantId,
      'caregiverDisplayName': String caregiverDisplayName,
      'dependantDisplayName': String dependantDisplayName,
      'scheduledStart': String start,
      'scheduledEnd': String end,
      'status': String status,
    } =>
      VisitSchedule(
        id: id,
        dependantId: dependantId,
        caregiverDisplayName: caregiverDisplayName,
        dependantDisplayName: dependantDisplayName,
        scheduledStart: DateTime.parse(start).toLocal(),
        scheduledEnd: DateTime.parse(end).toLocal(),
        status: status,
      ),
    _ => throw FormatException('Unexpected visit: $json'),
  };
}

/// GET .../verification, trimmed to what the visit timeline reads.
class VerificationAudit {
  final DateTime? checkinAt;
  final DateTime? checkoutAt;
  final DateTime? caregiverVerifiedAt;
  final DateTime? dependantVerifiedAt;

  VerificationAudit({
    this.checkinAt,
    this.checkoutAt,
    this.caregiverVerifiedAt,
    this.dependantVerifiedAt,
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
      // Same rule as the admin web app's VisitDetailPage: the first *passing* attempt per type.
      DateTime? firstPass(String type) => parse(
        attempts
            .map((a) => a as Map<String, dynamic>)
            .where((a) => a['attemptType'] == type && a['passed'] == true)
            .firstOrNull?['attemptedAt'],
      );
      return VerificationAudit(
        checkinAt: parse(event?['checkinAt']),
        checkoutAt: parse(event?['checkoutAt']),
        caregiverVerifiedAt: firstPass('caregiver_liveness'),
        dependantVerifiedAt: firstPass('dependant_liveness'),
      );
    }
    throw FormatException('Unexpected verification audit: $json');
  }
}

/// One recorded care-task outcome for a visit (GET .../task-outcomes).
class TaskOutcome {
  final String title;
  final bool required;
  final String status; // completed | not_completed | not_applicable
  final String? reason;
  final String? notes;

  TaskOutcome({
    required this.title,
    required this.required,
    required this.status,
    this.reason,
    this.notes,
  });

  factory TaskOutcome.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'title': String title,
      'required': bool required,
      'status': String status,
    } =>
      TaskOutcome(
        title: title,
        required: required,
        status: status,
        reason: json['reason'] as String?,
        notes: json['notes'] as String?,
      ),
    _ => throw FormatException('Unexpected task outcome: $json'),
  };
}

/// Human wording for visit_task_completions.reason (backend taskSkipReasonEnum).
String describeSkipReason(String? reason) => switch (reason) {
  'client_declined' => 'Declined',
  'client_unavailable' => 'Unavailable',
  'equipment_unavailable' => 'Equipment unavailable',
  'other' => 'Other reason',
  _ => 'Not done',
};

class VisitSchedulesApi {
  final ApiClient _client;

  VisitSchedulesApi(this._client);

  /// Every visit matching the filters, following nextCursor through all pages - a dependant with
  /// daily visits passes one page within months, and a truncated history would silently hide the
  /// oldest visits. The backend orders by id, not by time, so callers sort by scheduledStart.
  /// ponytail: loads the full history up front; page it lazily if histories grow into thousands.
  Future<List<VisitSchedule>> listVisits({
    String? dependantId,
    VisitStatus? status,
  }) async {
    final visits = <VisitSchedule>[];
    String? cursor;
    do {
      final query = Uri(
        queryParameters: {
          'dependantId': ?dependantId,
          'status': ?status,
          'cursor': ?cursor,
          'limit': '100',
        },
      ).query;
      final json = await _client.get('/visit-schedules?$query');
      visits.addAll(
        (json['items'] as List).map(
          (item) => VisitSchedule.fromJson(item as Map<String, dynamic>),
        ),
      );
      cursor = json['nextCursor'] as String?;
    } while (cursor != null);
    return visits;
  }

  Future<VerificationAudit> getVerification(String visitScheduleId) async =>
      VerificationAudit.fromJson(
        await _client.get('/visit-schedules/$visitScheduleId/verification'),
      );

  Future<List<TaskOutcome>> getTaskOutcomes(String visitScheduleId) async {
    final json = await _client.getList(
      '/visit-schedules/$visitScheduleId/task-outcomes',
    );
    return json
        .map((item) => TaskOutcome.fromJson(item as Map<String, dynamic>))
        .toList();
  }
}
