import 'dart:convert';

import 'package:caregiver/api/api_client.dart';
import 'package:caregiver/api/visit_schedules_api.dart';
import 'package:caregiver/screens/checkout_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator_platform_interface/geolocator_platform_interface.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

// At the home, with location allowed, so every step can send a position.
class _AtHome extends GeolocatorPlatform with MockPlatformInterfaceMixin {
  @override
  Future<LocationPermission> checkPermission() async =>
      LocationPermission.whileInUse;

  @override
  Future<bool> isLocationServiceEnabled() async => true;

  @override
  Future<Position> getCurrentPosition({
    LocationSettings? locationSettings,
  }) async => Position(
    latitude: -1.28,
    longitude: 36.81,
    timestamp: DateTime(2026, 11, 13),
    accuracy: 5,
    altitude: 0,
    altitudeAccuracy: 0,
    heading: 0,
    headingAccuracy: 0,
    speed: 0,
    speedAccuracy: 0,
  );
}

final _visit = VisitSchedule.fromJson({
  'id': 'v1',
  'caregiverId': 'c',
  'dependantId': 'd',
  'caregiverDisplayName': 'Amina',
  'dependantDisplayName': 'Mzee Joseph',
  'scheduledStart': '2026-11-13T07:00:00Z',
  'scheduledEnd': '2026-11-13T08:00:00Z',
  'status': 'in_progress',
  'createdBy': 's',
  'createdAt': '2026-11-12T07:00:00Z',
  'updatedAt': '2026-11-12T07:00:00Z',
});

// The server's side: records each request and answers 200.
class _Backend {
  final requests = <(String, Map<String, dynamic>)>[];
  late final client = MockClient((request) async {
    requests.add((
      request.url.path,
      request.body.isEmpty
          ? {}
          : jsonDecode(request.body) as Map<String, dynamic>,
    ));
    return http.Response(
      '{}',
      200,
      headers: {'content-type': 'application/json'},
    );
  });
}

Widget _screen({required Map<String, bool> uploaded}) => MaterialApp(
  home: CheckoutScreen(
    visit: _visit,
    visitSchedulesApi: VisitSchedulesApi(ApiClient(() async => 'token')),
    tasks: const [],
    checkedTaskIds: const {},
    hasRecording: const {'caregiver': false, 'dependant': false},
    audioRequired: const {'caregiver': true, 'dependant': true},
    alreadyUploaded: uploaded,
    scannerBuilder: (onValue) => TextButton(
      onPressed: () => onValue('scanned-token'),
      child: const Text('fake scan'),
    ),
  ),
);

// Paths carry the API's stage prefix, and maps compare by content only through a matcher.
void _expectRequest(
  (String, Map<String, dynamic>) request,
  String path,
  Map<String, Object> body,
) {
  expect(request.$1, endsWith(path));
  expect(request.$2, body);
}

// After the server confirms, the screen deletes the phone's copies and notifies through plugins
// that don't exist in widget tests, so the spinner never settles: pump long enough for the
// request to go out instead.
Future<void> _afterCompleting(WidgetTester tester) =>
    tester.pump(const Duration(milliseconds: 500));

ElevatedButton _checkOutButton(WidgetTester tester) => tester
    .widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'Check out'));

void main() {
  setUp(() => GeolocatorPlatform.instance = _AtHome());

  testWidgets("can't check out without the caregiver's own recording", (
    tester,
  ) async {
    await tester.pumpWidget(_screen(uploaded: const {'dependant': true}));

    expect(find.text('Your voice not recorded'), findsOneWidget);
    expect(_checkOutButton(tester).onPressed, isNull);
  });

  testWidgets("the dependant's recording can be replaced by a reason", (
    tester,
  ) async {
    await tester.pumpWidget(_screen(uploaded: const {'caregiver': true}));
    expect(_checkOutButton(tester).onPressed, isNull);

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dependant unwell or asleep').last);
    await tester.pumpAndSettle();

    expect(_checkOutButton(tester).onPressed, isNotNull);
  });

  testWidgets(
    'requests check-out, then confirms with the 6 digits or the scanned code',
    (tester) async {
      final backend = _Backend();
      await http.runWithClient(() async {
        await tester.pumpWidget(
          _screen(uploaded: const {'caregiver': true, 'dependant': true}),
        );
        await tester.tap(find.widgetWithText(ElevatedButton, 'Check out'));
        await tester.pumpAndSettle();

        _expectRequest(
          backend.requests.single,
          '/visit-schedules/v1/checkout/request',
          {'gpsLat': -1.28, 'gpsLng': 36.81},
        );
        expect(find.text('Scan the code'), findsOneWidget);

        // Only six digits can be confirmed.
        await tester.enterText(find.byType(TextField).first, '12345');
        await tester.pump();
        expect(
          tester
              .widget<OutlinedButton>(
                find.widgetWithText(OutlinedButton, 'Confirm'),
              )
              .onPressed,
          isNull,
        );
        await tester.enterText(find.byType(TextField).first, '123456');
        await tester.pump();
        await tester.tap(find.widgetWithText(OutlinedButton, 'Confirm'));
        await _afterCompleting(tester);
        _expectRequest(
          backend.requests.last,
          '/visit-schedules/v1/checkout/code',
          {'code': '123456', 'gpsLat': -1.28, 'gpsLng': 36.81},
        );
      }, () => backend.client);
    },
  );

  testWidgets('confirms with the scanned QR code', (tester) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await tester.pumpWidget(
        _screen(uploaded: const {'caregiver': true, 'dependant': true}),
      );
      await tester.tap(find.widgetWithText(ElevatedButton, 'Check out'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Scan the code'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('fake scan'));
      await _afterCompleting(tester);

      _expectRequest(
        backend.requests.last,
        '/visit-schedules/v1/checkout/qr-scan',
        {'token': 'scanned-token', 'gpsLat': -1.28, 'gpsLng': 36.81},
      );
    }, () => backend.client);
  });

  testWidgets('checks out without the code once a reason is given', (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await tester.pumpWidget(
        _screen(uploaded: const {'caregiver': true, 'dependant': true}),
      );
      await tester.tap(find.widgetWithText(ElevatedButton, 'Check out'));
      await tester.pumpAndSettle();

      final withoutCode = find.widgetWithText(
        OutlinedButton,
        'Check out without the code',
      );
      expect(tester.widget<OutlinedButton>(withoutCode).onPressed, isNull);
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('No family member is here').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(withoutCode);
      await tester.tap(withoutCode);
      await _afterCompleting(tester);

      _expectRequest(
        backend.requests.last,
        '/visit-schedules/v1/checkout/override',
        {
          'reason': 'no_family_member_present',
          'gpsLat': -1.28,
          'gpsLng': 36.81,
        },
      );
    }, () => backend.client);
  });
}
