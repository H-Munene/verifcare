import 'package:caregiver/api/checkin_api.dart';
import 'package:caregiver/api/visit_schedules_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('VerificationAudit.fromJson', () {
    test('takes the first passing attempt of each photo type', () {
      final audit = VerificationAudit.fromJson({
        'event': {'checkinAt': '2026-09-24T09:05:00Z', 'checkoutAt': null},
        'attempts': [
          {
            'attemptType': 'caregiver_liveness',
            'passed': false,
            'attemptedAt': '2026-09-24T09:01:00Z',
          },
          {
            'attemptType': 'caregiver_liveness',
            'passed': true,
            'attemptedAt': '2026-09-24T09:02:00Z',
          },
          {
            'attemptType': 'dependant_liveness',
            'passed': true,
            'attemptedAt': '2026-09-24T09:05:00Z',
          },
        ],
      });
      expect(
        audit.caregiverVerifiedAt,
        DateTime.parse('2026-09-24T09:02:00Z').toLocal(),
      );
      expect(audit.dependantVerifiedAt, isNotNull);
      expect(audit.checkinAt, isNotNull);
      expect(audit.checkoutAt, isNull);
    });

    test('a missed visit that never started has every step empty', () {
      final audit = VerificationAudit.fromJson({'event': null, 'attempts': []});
      expect([
        audit.checkinAt,
        audit.caregiverVerifiedAt,
        audit.dependantVerifiedAt,
        audit.checkoutAt,
      ], everyElement(isNull));
    });

    test('rejects a malformed payload instead of guessing', () {
      expect(
        () => VerificationAudit.fromJson({'event': null}),
        throwsFormatException,
      );
    });
  });

  test('VisitTask.fromJson tolerates null optional fields', () {
    final task = VisitTask.fromJson({
      'careTaskId': 'a',
      'title': 'Give medication',
      'description': null,
      'required': true,
      'status': null,
    });
    expect(
      (task.title, task.required, task.status),
      ('Give medication', true, null),
    );
  });

  test('LivenessResult.fromJson reads a failed check', () {
    final result = LivenessResult.fromJson({
      'passed': false,
      'matchConfidence': 41.2,
      'failureReason': 'identity_mismatch',
    });
    expect(result.passed, isFalse);
    expect(
      describeLivenessFailure(result.failureReason),
      contains("didn't match"),
    );
  });
}
