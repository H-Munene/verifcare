import 'package:caregiver/api/visit_schedules_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('VerificationAudit.fromJson', () {
    test('takes the first passing geofence check as the arrival', () {
      final audit = VerificationAudit.fromJson({
        'event': {
          'checkinAt': '2026-09-24T09:05:00Z',
          'checkoutAt': null,
          'checkinMethod': 'qr',
        },
        'attempts': [
          {
            'attemptType': 'geofence',
            'passed': false,
            'attemptedAt': '2026-09-24T09:01:00Z',
          },
          {
            'attemptType': 'geofence',
            'passed': true,
            'attemptedAt': '2026-09-24T09:02:00Z',
          },
        ],
      });
      expect(
        audit.arrivedAt,
        DateTime.parse('2026-09-24T09:02:00Z').toLocal(),
      );
      expect(audit.checkinMethod, 'qr');
      expect(audit.checkinAt, isNotNull);
      expect(audit.checkoutAt, isNull);
    });

    test('a missed visit that never started has every step empty', () {
      final audit = VerificationAudit.fromJson({'event': null, 'attempts': []});
      expect([
        audit.arrivedAt,
        audit.checkinAt,
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
}
