import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/biometric_enrollments_api.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/family_link_requests_api.dart';
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
String _iso(Duration ago) => _now.subtract(ago).toUtc().toIso8601String();

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

final _secondDependant = {
  ..._dependant,
  'id': 'd2',
  'fullName': 'Otieno Ouma',
  'dob': '1948-02-01',
  'gender': 'male',
};

/// [callerIsPrimary]: whether the signed-in user (u1) is the dependant's primary contact.
/// [photoStatus]: the dependant's checkinPhotoStatus.
/// [dependants]: how many dependants the caller is linked to (0, 1 or 2).
MockClient _backend({
  bool callerIsPrimary = true,
  String photoStatus = 'ready',
  int dependants = 1,
}) => MockClient((request) async {
  final path = request.url.path.replaceFirst('/prod', '');
  final query = request.url.queryParameters;
  final Object body = switch (path) {
    '/dependants' => {
      'items': [
        if (dependants > 0) {..._dependant, 'checkinPhotoStatus': photoStatus},
        if (dependants > 1) {..._secondDependant, 'checkinPhotoStatus': 'ready'},
      ],
      'nextCursor': null,
    },
    '/users/me' => {'id': 'u1', 'fullName': 'Achieng Otieno'},
    '/family-link-requests' => {'incoming': [], 'outgoing': []},
    '/visit-schedules' when query['status'] == 'in_progress' => {
      'items': [_visit('v-now', 'in_progress', _now.subtract(const Duration(minutes: 30)))],
      'nextCursor': null,
    },
    '/visit-schedules' => {
      'items': [
        _visit('v-now', 'in_progress', _now.subtract(const Duration(minutes: 30))),
        _visit('v-next', 'scheduled', _now.add(const Duration(days: 1))),
        _visit('v-done', 'completed', _now.subtract(const Duration(days: 1))),
        _visit('v-missed', 'missed', _now.subtract(const Duration(days: 2))),
        _visit('v-off', 'cancelled', _now.subtract(const Duration(days: 3))),
      ],
      'nextCursor': null,
    },
    '/dependants/d1/family-members' || '/dependants/d2/family-members' => [
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
    '/visit-schedules/v-now/verification' => {
      'event': {'checkinAt': _iso(const Duration(minutes: 25)), 'checkoutAt': null},
      'attempts': [
        {
          'attemptType': 'caregiver_liveness',
          'passed': true,
          'attemptedAt': _iso(const Duration(minutes: 28)),
        },
      ],
    },
    '/visit-schedules/v-missed/verification' => {'event': null, 'attempts': []},
    '/visit-schedules/v-done/verification' => {
      'event': {
        'checkinAt': _iso(const Duration(days: 1)),
        'checkoutAt': _iso(const Duration(hours: 23)),
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
      {'title': 'Give morning medication', 'description': null, 'required': true},
    ],
    _ => throw StateError('Unexpected request: ${request.url}'),
  };
  return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
});

Future<void> _pumpHome(
  WidgetTester tester,
  Size size, {
  Map<String, Object> prefs = const {},
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);

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
        linkRequestsApi: FamilyLinkRequestsApi(client),
        identity: IdentityClaims(sub: 'sub-1', role: 'family_member'),
        onSignedOut: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _goTo(WidgetTester tester, String tab) async {
  await tester.tap(find.widgetWithText(NavigationDestination, tab));
  await tester.pumpAndSettle();
}

/// Scrolls the visible tab's list until [text] is on screen.
Future<void> _scrollTo(WidgetTester tester, Finder finder, {double dy = -100}) async {
  await tester.dragUntilVisible(finder, find.byType(Scrollable).hitTestable().first, Offset(0, dy));
  await tester.pumpAndSettle();
}

void main() {
  for (final (name, size) in [
    ('narrow phone', const Size(320, 640)),
    ('tablet', const Size(1024, 768)),
  ]) {
    testWidgets('today, visits and family render on a $name', (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, size);

        // Today: the only dependant is selected, greeted by the caller's first name.
        expect(find.text('Wanjiku Kamau'), findsOneWidget);
        expect(find.textContaining('Achieng'), findsOneWidget);
        expect(find.text("Here's how Wanjiku's care is going."), findsOneWidget);

        // The visit in progress is the Now card, with its real check-in time.
        expect(find.text('WITH WANJIKU NOW'), findsOneWidget);
        expect(find.text('Grace is visiting'), findsOneWidget);
        expect(find.textContaining('Checked in'), findsOneWidget);

        // The feed holds only recorded moments, newest first, down to last week's missed visit.
        for (final (text, count) in [
          ('Grace arrived', 1),
          // Today's visit and yesterday's both started.
          ('Visit started', 2),
          ('Visit finished', 1),
          ('1 of 2 care tasks done with Grace.', 1),
          ('Missed visit', 1),
        ]) {
          await _scrollTo(tester, find.text(text).last);
          expect(find.text(text), findsNWidgets(count), reason: text);
        }
        // A cancelled visit isn't an event.
        expect(find.textContaining('cancelled'), findsNothing);

        // Visits: in progress, upcoming and history, each visit labelled by status.
        await _goTo(tester, 'Visits');
        for (final label in ['Upcoming', 'Scheduled', 'History', 'Completed', 'Missed', 'Cancelled']) {
          await _scrollTo(tester, find.text(label));
          expect(find.text(label), findsOneWidget, reason: label);
        }

        // Family: the dependant's details, with Edit for the primary contact, then the members -
        // primary contact first, and the caller marked as themselves.
        await _goTo(tester, 'Family');
        expect(find.text('About Wanjiku'), findsOneWidget);
        expect(find.widgetWithText(TextButton, 'Edit'), findsOneWidget);
        expect(find.text('Type 2 diabetes'), findsOneWidget);
        await _scrollTo(tester, find.text('Achieng Otieno (You)'));
        expect(find.text('Brian Kamau'), findsOneWidget);
        expect(find.textContaining('Primary contact', findRichText: true), findsOneWidget);

        // A member expands to their registration details - never an ID document, which the
        // backend doesn't send to family members.
        expect(find.text('brian@example.com'), findsNothing);
        await tester.tap(find.text('Brian Kamau'));
        await tester.pumpAndSettle();
        await _scrollTo(tester, find.text('Linked on'));
        expect(find.text('brian@example.com'), findsOneWidget);
        expect(find.text('+254700000002'), findsOneWidget);
        expect(find.text('Added by'), findsOneWidget);
        expect(find.textContaining('ID'), findsNothing);

        // Account: what isn't about one dependant.
        await _goTo(tester, 'Account');
        expect(find.text('Achieng Otieno'), findsOneWidget);
        expect(find.text('Family requests'), findsOneWidget);
        expect(find.text('Sign out'), findsOneWidget);
      }, _backend);
    });
  }

  testWidgets(
    'a past visit shows its timeline and care outcomes; an upcoming one its plan',
    (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        await _goTo(tester, 'Visits');

        await _scrollTo(tester, find.text('Completed'));
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
        await _scrollTo(tester, find.text('Scheduled'), dy: 100);
        await tester.tap(find.text('Scheduled'));
        await tester.pumpAndSettle();
        expect(find.text('Grace Caregiver'), findsOneWidget);
        expect(
          find.text('House 12, Mugo Road\nKILELESHWA, DAGORETTI NORTH, NAIROBI'),
          findsOneWidget,
        );
        expect(find.text('Give morning medication'), findsOneWidget);
      }, _backend);
    },
  );

  testWidgets("tapping Today's Now card opens the visit in progress", (tester) async {
    await http.runWithClient(() async {
      await _pumpHome(tester, const Size(360, 780));
      await tester.tap(find.text('Grace is visiting'));
      await tester.pumpAndSettle();
      expect(find.text('Visit timeline'), findsOneWidget);
    }, _backend);
  });

  testWidgets('a family member who is not the primary contact gets no Edit action', (
    tester,
  ) async {
    await http.runWithClient(() async {
      await _pumpHome(tester, const Size(360, 780));
      await _goTo(tester, 'Family');
      expect(find.text('About Wanjiku'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Edit'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Link a family member'), findsNothing);
    }, () => _backend(callerIsPrimary: false));
  });

  testWidgets('switching dependants changes every tab, and is remembered', (tester) async {
    await http.runWithClient(() async {
      await _pumpHome(tester, const Size(360, 780));
      // Alphabetical, so Otieno comes first and is picked when nothing is remembered.
      expect(find.text('Otieno Ouma'), findsOneWidget);

      await tester.tap(find.text('Otieno Ouma'));
      await tester.pumpAndSettle();
      expect(find.text('Your dependants'), findsOneWidget);
      await tester.tap(find.text('Wanjiku Kamau'));
      await tester.pumpAndSettle();

      expect(find.text("Here's how Wanjiku's care is going."), findsOneWidget);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('family.selectedDependantId'), 'd1');
    }, () => _backend(dependants: 2));
  });

  testWidgets('the remembered dependant is selected on launch', (tester) async {
    await http.runWithClient(() async {
      await _pumpHome(
        tester,
        const Size(360, 780),
        prefs: {'family.selectedDependantId': 'd1'},
      );
      expect(find.text("Here's how Wanjiku's care is going."), findsOneWidget);
    }, () => _backend(dependants: 2));
  });

  testWidgets('with no dependants yet, every dependant tab says how to get one', (
    tester,
  ) async {
    await http.runWithClient(() async {
      await _pumpHome(tester, const Size(360, 780));
      expect(find.text('No dependants yet'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Register a dependant'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Ask to join a family'), findsOneWidget);
      await _goTo(tester, 'Visits');
      expect(find.text('No dependants yet'), findsOneWidget);
    }, () => _backend(dependants: 0));
  });

  group('a dependant without a usable photo', () {
    testWidgets('the primary contact is told to add one, and taken to the Photo step', (
      tester,
    ) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        expect(find.text('Add a photo of Wanjiku'), findsOneWidget);

        await tester.tap(find.widgetWithText(FilledButton, 'Add photo'));
        await tester.pumpAndSettle();
        expect(find.text('Edit details'), findsOneWidget);
        expect(
          find.textContaining('Replace it if it no longer looks like them'),
          findsOneWidget,
        );
      }, () => _backend(photoStatus: 'missing'));
    });

    testWidgets('another family member is told the primary contact must add it', (
      tester,
    ) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        expect(find.text('Wanjiku has no photo yet'), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Add photo'), findsNothing);
      }, () => _backend(callerIsPrimary: false, photoStatus: 'missing'));
    });

    testWidgets('a photo waiting for review is not asked for again', (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        expect(find.text("Wanjiku's photo is waiting for review"), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Add photo'), findsNothing);
      }, () => _backend(photoStatus: 'awaiting_review'));
    });

    testWidgets('nothing is shown once the photo is ready', (tester) async {
      await http.runWithClient(() async {
        await _pumpHome(tester, const Size(360, 780));
        expect(find.text('Add a photo of Wanjiku'), findsNothing);
        expect(find.byIcon(Icons.photo_camera_outlined), findsNothing);
      }, _backend);
    });
  });
}
