import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/biometric_enrollments_api.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/api/visit_schedules_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/screens/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Drives the real screens and the real ApiClient against canned backend responses (http's
// runWithClient swaps the client every http call uses), at phone and tablet widths - flutter_test
// fails the test on any layout overflow, so this also guards the responsive layout.

Map<String, dynamic> _visit(String id, String status, DateTime start) => {
  'id': id,
  'caregiverId': 'cg1',
  'dependantId': 'd1',
  'caregiverDisplayName': 'Grace Caregiver',
  'dependantDisplayName': 'Wanjiku Kamau',
  'scheduledStart': start.toUtc().toIso8601String(),
  'scheduledEnd': start.add(const Duration(hours: 1)).toUtc().toIso8601String(),
  'status': status,
  'createdBy': 's1',
  'createdAt': '2026-09-01T00:00:00Z',
  'updatedAt': '2026-09-01T00:00:00Z',
};

final _now = DateTime.now();

final _dependant = {
  'id': 'd1',
  'fullName': 'Wanjiku Kamau',
  'dob': '1950-06-15',
  'gender': 'female',
  'homeAddressText': 'House 12, Mugo Road',
  'primaryConditionSummary': 'Type 2 diabetes',
  'county': 'NAIROBI',
  'constituency': 'DAGORETTI NORTH',
  'ward': 'KILELESHWA',
  'geofenceLat': -1.2833,
  'geofenceLng': 36.7833,
  'geofenceRadiusMeters': 20,
  'cognitiveMonitoringEnabled': false,
  'status': 'active',
};

/// [callerIsPrimary]: whether the signed-in user (u1) is the dependant's primary contact.
/// [photoStatus]: the dependant's checkinPhotoStatus.
MockClient _backend({
  bool callerIsPrimary = true,
  String photoStatus = 'ready',
}) => MockClient((request) async {
  final path = request.url.path.replaceFirst('/prod', '');
  final query = request.url.queryParameters;
  final Object body = switch (path) {
    '/dependants' => {
      'items': [
        {..._dependant, 'checkinPhotoStatus': photoStatus},
      ],
      'nextCursor': null,
    },
    '/users/me' => {'id': 'u1', 'fullName': 'Achieng Otieno'},
    '/visit-schedules' when query['status'] == 'in_progress' => {
      'items': [_visit('v-now', 'in_progress', _now)],
      'nextCursor': null,
    },
    '/visit-schedules' => {
      'items': [
        _visit('v-now', 'in_progress', _now),
        _visit('v-next', 'scheduled', _now.add(const Duration(days: 1))),
        _visit('v-done', 'completed', _now.subtract(const Duration(days: 1))),
        _visit('v-missed', 'missed', _now.subtract(const Duration(days: 2))),
        _visit('v-off', 'cancelled', _now.subtract(const Duration(days: 3))),
      ],
      'nextCursor': null,
    },
    '/dependants/d1/family-members' => [
      {
        'familyMemberUserId': 'u2',
        'fullName': 'Brian Kamau',
        'relationship': 'Grandson',
        'isPrimaryContact': !callerIsPrimary,
        'email': 'brian@example.com',
        'phoneNumber': '+254700000002',
        'addedByName': 'Achieng Otieno',
        'createdAt': '2026-09-10T08:00:00Z',
      },
      {
        'familyMemberUserId': 'u1',
        'fullName': 'Achieng Otieno',
        'relationship': 'Daughter',
        'isPrimaryContact': callerIsPrimary,
      },
    ],
    '/biometric-enrollments' => [],
    '/visit-schedules/v-done/verification' => {
      'event': {
        'checkinAt': _now
            .subtract(const Duration(days: 1))
            .toUtc()
            .toIso8601String(),
        'checkoutAt': _now
            .subtract(const Duration(hours: 23))
            .toUtc()
            .toIso8601String(),
      },
      'attempts': [],
    },
    '/visit-schedules/v-done/task-outcomes' => [
      {
        'careTaskId': 't1',
        'title': 'Give morning medication',
        'required': true,
        'status': 'completed',
        'reason': null,
        'notes': null,
      },
      {
        'careTaskId': 't2',
        'title': 'Short walk',
        'required': false,
        'status': 'not_completed',
        'reason': 'client_declined',
        'notes': 'Too tired',
      },
    ],
    '/dependants/d1/care-tasks' => [
      {
        'title': 'Give morning medication',
        'description': null,
        'required': true,
      },
    ],
    _ => throw StateError('Unexpected request: ${request.url}'),
  };
  return http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json'},
  );
});

Future<void> _pumpHome(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});

  final authService = CognitoAuthService();
  final client = ApiClient(authService.getIdToken);
  await tester.pumpWidget(
    MaterialApp(
      home: HomeScreen(
        authService: authService,
        dependantsApi: DependantsApi(client),
        visitSchedulesApi: VisitSchedulesApi(client),
        enrollmentsApi: BiometricEnrollmentsApi(client),
        usersApi: UsersApi(client),
        identity: IdentityClaims(sub: 'sub-1', role: 'family_member'),
        onSignedOut: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final (name, size) in [
    ('narrow phone', const Size(320, 640)),
    ('tablet', const Size(1024, 768)),
  ]) {
    testWidgets('home, visits and family render on a $name', (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, size);

        // Home: the dependant, flagged as having a caregiver with them right now.
        expect(find.text('Wanjiku Kamau'), findsOneWidget);
        expect(find.text('In progress'), findsOneWidget);

        await tester.tap(find.text('Wanjiku Kamau'));
        await tester.pumpAndSettle();

        // The caller is the primary contact here, so they get the Edit action.
        expect(find.widgetWithText(TextButton, 'Edit'), findsOneWidget);

        // Visits tab: in progress, upcoming and history, each visit labelled by status.
        // Scrolled to one by one, top to bottom, since a phone-height list only builds what's
        // near the screen.
        final visitsList = find.byType(ListView).first;
        for (final label in [
          'Upcoming',
          'Scheduled',
          'History',
          'Completed',
          'Missed',
          'Cancelled',
        ]) {
          await tester.dragUntilVisible(
            find.text(label),
            visitsList,
            const Offset(0, -100),
          );
          expect(find.text(label), findsOneWidget, reason: label);
        }

        // Family tab: primary contact first, and the caller marked as themselves.
        await tester.tap(find.text('Family'));
        await tester.pumpAndSettle();
        expect(find.text('Achieng Otieno (You)'), findsOneWidget);
        expect(find.text('Brian Kamau'), findsOneWidget);
        expect(
          find.textContaining('Primary contact', findRichText: true),
          findsOneWidget,
        );

        // A member expands to their registration details - never an ID document, which the
        // backend doesn't send to family members.
        expect(find.text('brian@example.com'), findsNothing);
        await tester.tap(find.text('Brian Kamau'));
        await tester.pumpAndSettle();
        expect(find.text('brian@example.com'), findsOneWidget);
        expect(find.text('+254700000002'), findsOneWidget);
        expect(find.text('Added by'), findsOneWidget);
        expect(find.text('Linked on'), findsOneWidget);
        expect(find.textContaining('ID'), findsNothing);

        // No Photos tab any more - the photo is managed from Edit's Photo step.
        expect(find.text('Photos'), findsNothing);
      }, _backend);
    });
  }

  testWidgets(
    'a past visit shows its timeline and care outcomes; an upcoming one its plan',
    (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        await tester.tap(find.text('Wanjiku Kamau'));
        await tester.pumpAndSettle();
        final visitsList = find.byType(ListView).first;

        await tester.dragUntilVisible(
          find.text('Completed'),
          visitsList,
          const Offset(0, -100),
        );
        // dragUntilVisible stops once the label is even partly on screen, so its centre (where
        // the tap lands) could sit just past the bottom edge - it did on some dates, since the
        // fixture's visits are relative to today. Bring it fully into view first.
        await tester.ensureVisible(find.text('Completed'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Completed'));
        await tester.pumpAndSettle();
        expect(find.text('Care activities'), findsOneWidget);
        expect(find.text('Give morning medication'), findsOneWidget);
        expect(find.text('Declined - Too tired'), findsOneWidget);
        // Photo steps never passed in this fixture, but the visit wasn't missed, so they read
        // "Not yet" rather than showing a red X.
        expect(find.text('Not yet'), findsNWidgets(2));

        await tester.pageBack();
        await tester.pumpAndSettle();
        await tester.dragUntilVisible(
          find.text('Scheduled'),
          visitsList,
          const Offset(0, 100),
        );
        await tester.tap(find.text('Scheduled'));
        await tester.pumpAndSettle();
        expect(find.text('Grace Caregiver'), findsOneWidget);
        expect(
          find.text(
            'House 12, Mugo Road\nKILELESHWA, DAGORETTI NORTH, NAIROBI',
          ),
          findsOneWidget,
        );
        expect(find.text('Give morning medication'), findsOneWidget);
      }, _backend);
    },
  );

  testWidgets(
    'a family member who is not the primary contact gets no Edit action',
    (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        await tester.tap(find.text('Wanjiku Kamau'));
        await tester.pumpAndSettle();
        expect(find.text('Visits'), findsOneWidget);
        expect(find.widgetWithText(TextButton, 'Edit'), findsNothing);
      }, () => _backend(callerIsPrimary: false));
    },
  );

  group('a dependant without a usable photo', () {
    Future<void> openDependant(WidgetTester tester) async {
      await _pumpHome(tester, const Size(360, 780));
      await tester.tap(find.text('Wanjiku Kamau'));
      await tester.pumpAndSettle();
    }

    testWidgets(
      'the primary contact is told to add one, and taken to the Photo step',
      (tester) async {
        await http.runWithClient(() async {
          await _pumpHome(tester, const Size(360, 780));
          expect(find.text('Photo needed'), findsOneWidget);

          await tester.tap(find.text('Wanjiku Kamau'));
          await tester.pumpAndSettle();
          expect(find.text('Add a photo of Wanjiku'), findsOneWidget);

          await tester.tap(find.widgetWithText(FilledButton, 'Add photo'));
          await tester.pumpAndSettle();
          expect(find.text('Edit details'), findsOneWidget);
          expect(
            find.textContaining('Replace it if it no longer looks like them'),
            findsOneWidget,
          );
        }, () => _backend(photoStatus: 'missing'));
      },
    );

    testWidgets(
      'another family member is told the primary contact must add it',
      (tester) async {
        await http.runWithClient(() async {
          await openDependant(tester);
          expect(find.text('Wanjiku has no photo yet'), findsOneWidget);
          expect(find.widgetWithText(FilledButton, 'Add photo'), findsNothing);
        }, () => _backend(callerIsPrimary: false, photoStatus: 'missing'));
      },
    );

    testWidgets('a photo waiting for review is not asked for again', (
      tester,
    ) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        expect(find.text('Photo awaiting review'), findsOneWidget);
        await tester.tap(find.text('Wanjiku Kamau'));
        await tester.pumpAndSettle();
        expect(
          find.text("Wanjiku's photo is waiting for review"),
          findsOneWidget,
        );
        expect(find.widgetWithText(FilledButton, 'Add photo'), findsNothing);
      }, () => _backend(photoStatus: 'awaiting_review'));
    });

    testWidgets('nothing is shown once the photo is ready', (tester) async {
      await http.runWithClient(() async {
        await openDependant(tester);
        expect(find.text('Photo needed'), findsNothing);
        expect(find.byIcon(Icons.photo_camera_outlined), findsNothing);
      }, _backend);
    });
  });
}
