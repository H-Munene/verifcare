import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/biometric_enrollments_api.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/geo/kenya_areas.dart';
import 'package:family_member/screens/register_dependant_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// The map step (Google Maps, GPS) needs a real device, so these cover everything around it:
// the bundled location data, the wizard's gating up to the map, and the exact request the
// Register button sends.

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'bundled areas chain county -> constituency -> ward, with a county centre',
    () async {
      final areas = await KenyaAreas.load();
      expect(areas.counties, hasLength(47));
      final nairobi = areas.counties.firstWhere((c) => c.name == 'NAIROBI');
      final constituencies = areas.constituenciesOf(nairobi);
      expect(constituencies.map((c) => c.name), contains('DAGORETTI NORTH'));
      final dagoretti = constituencies.firstWhere(
        (c) => c.name == 'DAGORETTI NORTH',
      );
      expect(
        areas.wardsOf(dagoretti).map((w) => w.name),
        contains('KILELESHWA'),
      );
      final centre = areas.centreOf(nairobi)!;
      expect(centre.lat, closeTo(-1.29, 0.2));
      expect(centre.lng, closeTo(36.85, 0.2));
    },
  );

  test(
    'registration sends the location names, a 20 m radius and the caller as primary',
    () async {
      late Map<String, dynamic> sent;
      final client = MockClient((request) async {
        sent = jsonDecode(request.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            ...sent,
            'id': 'd1',
            'status': 'active',
            'homeAddressText': null,
            'primaryConditionSummary': null,
          }),
          201,
          headers: {'content-type': 'application/json'},
        );
      });
      await http.runWithClient(() async {
        final dependant = await DependantsApi(ApiClient(() async => null))
            .registerDependant(
              fullName: 'Wanjiku Kamau',
              dob: DateTime(1950, 6, 5),
              county: 'NAIROBI',
              constituency: 'DAGORETTI NORTH',
              ward: 'KILELESHWA',
              geofenceLat: -1.28,
              geofenceLng: 36.78,
              cognitiveMonitoringEnabled: true,
              selfCognitoSub: 'sub-1',
              selfPhoneNumber: '+254700000001',
              selfFullName: 'Achieng Otieno',
              relationship: 'Daughter',
            );
        expect(dependant.id, 'd1');
      }, () => client);

      expect(sent, containsPair('dob', '1950-06-05'));
      expect(sent, containsPair('geofenceRadiusMeters', 20));
      expect(sent['ward'], 'KILELESHWA');
      expect(sent['primaryFamilyMember'], {
        'cognitoSub': 'sub-1',
        'phoneNumber': '+254700000001',
        'fullName': 'Achieng Otieno',
        'relationship': 'Daughter',
        'isPrimaryContact': true,
      });
    },
  );

  testWidgets('Next stays disabled until each step is complete', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});
    final client = ApiClient(() async => null);
    await tester.pumpWidget(
      MaterialApp(
        home: RegisterDependantScreen(
          dependantsApi: DependantsApi(client),
          enrollmentsApi: BiometricEnrollmentsApi(client),
          usersApi: UsersApi(client),
          identity: IdentityClaims(sub: 'sub-1'),
          onDone: () {},
        ),
      ),
    );
    // The areas load through rootBundle, which parses large assets (wards.json is 274 KB) on a
    // background isolate and delivers on the real event loop - neither advances under the widget
    // test's fake clock, so let real time run until the screen has them.
    await tester.runAsync(() async {
      await KenyaAreas.load();
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pumpAndSettle();

    ElevatedButton next() => tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Next'),
    );

    // Details: needs both names and a date of birth.
    expect(next().onPressed, isNull);
    expect(
      find.text("Enter the dependant's first and last name."),
      findsOneWidget,
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'First name'),
      'Wanjiku',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Last name'),
      'Kamau',
    );
    await tester.pump();
    expect(find.text('Choose a date of birth.'), findsOneWidget);

    // The form's own list - each multi-line text field is a scrollable of its own too.
    final formList = find.byType(Scrollable).first;

    // Cognitive monitoring stays off until the dependant is known to be over 65.
    final monitoring = find.widgetWithText(
      SwitchListTile,
      'Cognitive monitoring',
    );
    await tester.scrollUntilVisible(monitoring, 100, scrollable: formList);
    expect(tester.widget<SwitchListTile>(monitoring).onChanged, isNull);

    await tester.scrollUntilVisible(
      find.text('Date of birth'),
      -100,
      scrollable: formList,
    );
    await tester.tap(find.widgetWithText(InputDecorator, 'Date of birth'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '06/05/1950');
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(next().onPressed, isNotNull);
    await tester.scrollUntilVisible(monitoring, 100, scrollable: formList);
    expect(tester.widget<SwitchListTile>(monitoring).onChanged, isNotNull);

    // Location: each level unlocks the next; Next waits for the ward.
    await tester.tap(find.widgetWithText(ElevatedButton, 'Next'));
    await tester.pumpAndSettle();
    expect(
      find.text('Choose the county, constituency and ward.'),
      findsOneWidget,
    );
    Future<void> choose(String menu, String option) async {
      await tester.tap(find.widgetWithText(DropdownMenu<Area>, menu));
      await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextField, menu), option);
      await tester.pumpAndSettle();
      await tester.tap(find.text(option).last);
      await tester.pumpAndSettle();
    }

    await choose('County', 'NAIROBI');
    await choose('Constituency', 'DAGORETTI NORTH');
    expect(next().onPressed, isNull);
    await choose('Ward', 'KILELESHWA');
    expect(next().onPressed, isNotNull);

    // Changing the county clears the constituency and ward below it.
    await choose('County', 'MOMBASA');
    expect(next().onPressed, isNull);
  });
}
