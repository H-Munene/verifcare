import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/visit_schedules_api.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _dependantJson({String dob = '1950-06-15'}) => {
  'id': 'd1',
  'fullName': 'Wanjiku Kamau',
  'dob': dob,
  'gender': 'female',
  'homeAddressText': null,
  'primaryConditionSummary': null,
  'county': 'NAIROBI',
  'constituency': null,
  'ward': 'KILELESHWA',
  'geofenceLat': -1.2833,
  'geofenceLng': 36.7833,
  'geofenceRadiusMeters': 20,
  'status': 'active',
};

void main() {
  group('Dependant', () {
    test('age counts a birthday only once it has passed this year', () {
      final dependant = Dependant.fromJson(_dependantJson());
      expect(dependant.ageOn(DateTime(2026, 6, 14)), 75);
      expect(dependant.ageOn(DateTime(2026, 6, 15)), 76);
    });

    test('area text skips missing parts', () {
      expect(
        Dependant.fromJson(_dependantJson()).areaText,
        'KILELESHWA, NAIROBI',
      );
    });

    test('rejects a payload missing a required field', () {
      expect(
        () => Dependant.fromJson({..._dependantJson()}..remove('dob')),
        throwsFormatException,
      );
    });
  });

  test('FamilyMemberLink reads the name added for family members', () {
    final link = FamilyMemberLink.fromJson({
      'dependantId': 'd1',
      'familyMemberUserId': 'u1',
      'fullName': 'Achieng Otieno',
      'relationship': null,
      'isPrimaryContact': true,
      'addedBy': 'u1',
      'createdAt': '2026-09-24T09:00:00Z',
    });
    expect(
      (link.fullName, link.relationship, link.isPrimaryContact),
      ('Achieng Otieno', null, true),
    );
  });

  test('TaskOutcome keeps the skip reason for a task not done', () {
    final outcome = TaskOutcome.fromJson({
      'careTaskId': 't1',
      'title': 'Short walk',
      'description': null,
      'category': null,
      'required': false,
      'status': 'not_completed',
      'reason': 'client_declined',
      'notes': 'Too tired',
      'completedAt': '2026-09-24T09:30:00Z',
    });
    expect(describeSkipReason(outcome.reason), 'Declined');
    expect(outcome.notes, 'Too tired');
  });

  test('VerificationAudit reads the arrival, check-in method and recording', () {
    final audit = VerificationAudit.fromJson({
      'event': {
        'checkinAt': '2026-09-24T09:05:00Z',
        'checkoutAt': null,
        'checkinMethod': 'qr',
        'qrFamilyMemberName': 'Achieng Otieno',
        'audioRecordedAt': '2026-09-24T09:50:00Z',
        'audioDurationSeconds': 30,
        'audioSkipReason': null,
        'audioSkipNote': null,
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
    expect(audit.arrivedAt, DateTime.parse('2026-09-24T09:02:00Z').toLocal());
    expect(audit.checkinMethod, 'qr');
    expect(audit.qrFamilyMemberName, 'Achieng Otieno');
    expect(audit.audioDurationSeconds, 30);
    expect(audit.checkoutAt, isNull);
  });
}
