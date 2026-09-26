import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/biometric_enrollments_api.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/geo/kenya_areas.dart';
import 'package:family_member/screens/dependant_wizard_screen.dart';
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
        home: DependantWizardScreen.register(
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

    // Registering goes step by step - the header isn't a shortcut.
    await tester.tap(find.text('Photo'));
    await tester.pumpAndSettle();
    expect(
      find.text('Choose the county, constituency and ward.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'editing pre-fills the saved details and saves only what a family member may change',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      late Map<String, dynamic> patched;
      final existing = Dependant.fromJson({
        'id': 'd1',
        'fullName': 'Wanjiku Wairimu Kamau',
        'dob': '1950-06-15',
        'gender': 'female',
        'homeAddressText': 'House 12, Mugo Road',
        'primaryConditionSummary': null,
        'county': 'NAIROBI',
        'constituency': 'DAGORETTI NORTH',
        'ward': 'KILELESHWA',
        'geofenceLat': -1.2833,
        'geofenceLng': 36.7833,
        'cognitiveMonitoringEnabled': true,
        'status': 'active',
      });
      final backend = MockClient((request) async {
        if (request.method == 'PATCH') {
          patched = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({
              ...patched,
              'id': 'd1',
              'dob': '1950-06-15',
              'status': 'active',
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response(
          '[]',
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      await http.runWithClient(() async {
        final client = ApiClient(() async => null);
        Dependant? saved;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () async =>
                    saved = await Navigator.of(context).push<Dependant>(
                      MaterialPageRoute(
                        builder: (_) => DependantWizardScreen.edit(
                          dependantsApi: DependantsApi(client),
                          enrollmentsApi: BiometricEnrollmentsApi(client),
                          existing: existing,
                        ),
                      ),
                    ),
                child: const Text('open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        // Same real-time tick as the registration test, once the screen has asked for the areas.
        await tester.runAsync(() async {
          await KenyaAreas.load();
          await Future<void>.delayed(Duration.zero);
        });
        await tester.pumpAndSettle();

        // Name split at the first space, as on the web; date of birth locked; no relationship field.
        expect(find.widgetWithText(TextField, 'Wanjiku'), findsOneWidget);
        expect(find.widgetWithText(TextField, 'Wairimu Kamau'), findsOneWidget);
        expect(find.textContaining("can't be changed"), findsOneWidget);
        expect(
          find.widgetWithText(
            TextField,
            'Your relationship to them (optional)',
          ),
          findsNothing,
        );

        // A saved address can be changed but not cleared - the API has no way to clear it.
        final address = find.widgetWithText(
          TextField,
          'Home address details (optional)',
        );
        await tester.enterText(address, '');
        await tester.pump();
        expect(
          find.text('Home address details can be changed, but not removed.'),
          findsOneWidget,
        );
        TextButton save() =>
            tester.widget<TextButton>(find.widgetWithText(TextButton, 'Save'));
        expect(save().onPressed, isNull);
        await tester.enterText(address, 'House 14, Mugo Road');
        await tester.pump();
        expect(save().onPressed, isNotNull);

        // Editing: the step header jumps straight to any step.
        await tester.tap(find.bySemanticsLabel('Step 4, Photo'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('Replace it if it no longer looks like them'),
          findsOneWidget,
        );
        await tester.tap(find.bySemanticsLabel('Step 2, Location'));
        await tester.pumpAndSettle();

        // The saved location is matched back to the dropdowns by name.
        expect(find.widgetWithText(TextField, 'KILELESHWA'), findsOneWidget);

        await tester.tap(find.widgetWithText(TextButton, 'Save'));
        await tester.pumpAndSettle();
        expect(saved?.id, 'd1');
      }, () => backend);

      expect(patched, {
        'fullName': 'Wanjiku Wairimu Kamau',
        'gender': 'female',
        'homeAddressText': 'House 14, Mugo Road',
        'county': 'NAIROBI',
        'constituency': 'DAGORETTI NORTH',
        'ward': 'KILELESHWA',
        'geofenceLat': -1.2833,
        'geofenceLng': 36.7833,
        'cognitiveMonitoringEnabled': true,
      });
      // Never the radius (supervisor-only) or date of birth (not editable).
      expect(patched.containsKey('geofenceRadiusMeters'), isFalse);
      expect(patched.containsKey('dob'), isFalse);
    },
  );

  testWidgets(
    'editing: a new county clears the pin, so Save waits for a new one',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final existing = Dependant.fromJson({
        'id': 'd1',
        'fullName': 'Wanjiku Kamau',
        'dob': '1950-06-15',
        'gender': null,
        'homeAddressText': null,
        'primaryConditionSummary': null,
        'county': 'NAIROBI',
        'constituency': 'DAGORETTI NORTH',
        'ward': 'KILELESHWA',
        'geofenceLat': -1.2833,
        'geofenceLng': 36.7833,
        'cognitiveMonitoringEnabled': false,
        'status': 'active',
      });
      final backend = MockClient(
        (_) async => http.Response(
          '[]',
          200,
          headers: {'content-type': 'application/json'},
        ),
      );
      await http.runWithClient(() async {
        final client = ApiClient(() async => null);
        await tester.pumpWidget(
          MaterialApp(
            home: DependantWizardScreen.edit(
              dependantsApi: DependantsApi(client),
              enrollmentsApi: BiometricEnrollmentsApi(client),
              existing: existing,
            ),
          ),
        );
        await tester.runAsync(() async {
          await KenyaAreas.load();
          await Future<void>.delayed(Duration.zero);
        });
        await tester.pumpAndSettle();

        TextButton save() =>
            tester.widget<TextButton>(find.widgetWithText(TextButton, 'Save'));
        expect(save().onPressed, isNotNull);

        await tester.tap(find.bySemanticsLabel('Step 2, Location'));
        await tester.pumpAndSettle();
        Future<void> choose(String menu, String option) async {
          await tester.tap(find.widgetWithText(DropdownMenu<Area>, menu));
          await tester.pumpAndSettle();
          await tester.enterText(find.widgetWithText(TextField, menu), option);
          await tester.pumpAndSettle();
          await tester.tap(find.text(option).last);
          await tester.pumpAndSettle();
        }

        await choose('County', 'MOMBASA');
        await choose('Constituency', 'CHANGAMWE');
        await choose('Ward', 'PORT REITZ');
        // Every dropdown is filled again, but the Nairobi pin is gone.
        expect(save().onPressed, isNull);
      }, () => backend);
    },
  );
}
