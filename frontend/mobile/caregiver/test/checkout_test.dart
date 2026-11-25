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

// The server's side: records each request and answers 200, saying whether the dependant's
// recording is needed.
class _Backend {
  final bool audioRequired;
  _Backend({this.audioRequired = true});

  final requests = <(String, Map<String, dynamic>)>[];
  late final client = MockClient((request) async {
    if (request.url.path.endsWith('/audio/requirement')) {
      return _json({
        'dependant': {'required': audioRequired, 'recorded': false},
      });
    }
    requests.add((
      request.url.path,
      request.body.isEmpty
          ? {}
          : jsonDecode(request.body) as Map<String, dynamic>,
    ));
    return _json({});
  });
}

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

final _unticked = VisitTask(
  careTaskId: 't1',
  title: 'Give medication',
  required: true,
);

Widget _screen({
  List<VisitTask> tasks = const [],
  Future<VoiceCheck?> Function()? upload,
}) => MaterialApp(
  home: CheckoutScreen(
    visit: _visit,
    visitSchedulesApi: VisitSchedulesApi(ApiClient(() async => 'token')),
    tasks: tasks,
    checkedTaskIds: const {},
    recorderBuilder: (onRecordingChanged) => TextButton(
      onPressed: () => onRecordingChanged(true),
      child: const Text('fake record'),
    ),
    uploadRecording: upload,
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

ElevatedButton _button(WidgetTester tester, String label) =>
    tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, label));

Future<void> _continue(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(ElevatedButton, 'Continue'));
  await tester.pumpAndSettle();
}

// Records (with the fake recorder) and sends the recording for its check.
Future<void> _recordAndCheck(WidgetTester tester) async {
  await tester.tap(find.text('fake record'));
  await tester.pump();
  await tester.tap(find.widgetWithText(ElevatedButton, 'Check voice'));
  await tester.pumpAndSettle();
}

const _checkoutRequest = '/visit-schedules/v1/checkout/request';
const _atHome = {'gpsLat': -1.28, 'gpsLng': 36.81};

void main() {
  setUp(() => GeolocatorPlatform.instance = _AtHome());

  testWidgets('every unticked task needs a reason before continuing', (
    tester,
  ) async {
    await tester.pumpWidget(_screen(tasks: [_unticked]));
    expect(_button(tester, 'Continue').onPressed, isNull);

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Client declined').last);
    await tester.pumpAndSettle();

    expect(_button(tester, 'Continue').onPressed, isNotNull);
  });

  testWidgets(
    "a passed voice check shows the tick and the score, then the family's code",
    (tester) async {
      final backend = _Backend();
      await http.runWithClient(() async {
        await tester.pumpWidget(
          _screen(
            upload: () async =>
                const VoiceCheck(result: 'match', score: 0.82, threshold: 0.5),
          ),
        );
        await _continue(tester);
        expect(_button(tester, 'Check voice').onPressed, isNull);

        await _recordAndCheck(tester);
        expect(find.text('Voice matches'), findsOneWidget);
        expect(find.text('Match score 0.82'), findsOneWidget);
        expect(backend.requests, isEmpty);

        // Moves on by itself after a pause.
        await tester.pump(const Duration(seconds: 2));
        await tester.pumpAndSettle();
        _expectRequest(backend.requests.single, _checkoutRequest, _atHome);
        expect(find.text('Scan the code'), findsOneWidget);
      }, () => backend.client);
    },
  );

  testWidgets(
    'a failed voice check shows the score, and can be recorded again or continued past',
    (tester) async {
      final backend = _Backend();
      await http.runWithClient(() async {
        await tester.pumpWidget(
          _screen(
            upload: () async => const VoiceCheck(
              result: 'mismatch',
              score: 0.31,
              threshold: 0.5,
            ),
          ),
        );
        await _continue(tester);
        await _recordAndCheck(tester);

        expect(find.text("Voice doesn't match"), findsOneWidget);
        expect(find.text('Match score 0.31, needs 0.50'), findsOneWidget);
        expect(find.text('Record again'), findsOneWidget);
        // No moving on by itself after a failed check.
        await tester.pump(const Duration(seconds: 3));
        expect(backend.requests, isEmpty);

        await _continue(tester);
        _expectRequest(backend.requests.single, _checkoutRequest, _atHome);
        expect(find.text('Scan the code'), findsOneWidget);
      }, () => backend.client);
    },
  );

  testWidgets("a dependant who can't speak is accounted for with a reason", (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await tester.pumpWidget(_screen());
      await _continue(tester);

      final withoutRecording = find.widgetWithText(
        OutlinedButton,
        'Continue without a recording',
      );
      expect(tester.widget<OutlinedButton>(withoutRecording).onPressed, isNull);
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Dependant unwell or asleep').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(withoutRecording);
      await tester.tap(withoutRecording);
      await tester.pumpAndSettle();

      _expectRequest(backend.requests.single, _checkoutRequest, {
        ..._atHome,
        'audioSkipReason': 'dependant_unwell_or_asleep',
      });
      expect(find.text('Scan the code'), findsOneWidget);
    }, () => backend.client);
  });

  testWidgets(
    "goes straight to the family's code when the dependant isn't recorded",
    (tester) async {
      final backend = _Backend(audioRequired: false);
      await http.runWithClient(() async {
        await tester.pumpWidget(_screen());
        await _continue(tester);

        expect(find.text('fake record'), findsNothing);
        _expectRequest(backend.requests.single, _checkoutRequest, _atHome);
        expect(find.text('Scan the code'), findsOneWidget);
      }, () => backend.client);
    },
  );

  testWidgets('confirms with the 6 digits', (tester) async {
    final backend = _Backend(audioRequired: false);
    await http.runWithClient(() async {
      await tester.pumpWidget(_screen());
      await _continue(tester);

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
        {'code': '123456', ..._atHome},
      );
    }, () => backend.client);
  });

  testWidgets('confirms with the scanned QR code', (tester) async {
    final backend = _Backend(audioRequired: false);
    await http.runWithClient(() async {
      await tester.pumpWidget(_screen());
      await _continue(tester);
      await tester.tap(find.text('Scan the code'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('fake scan'));
      await _afterCompleting(tester);

      _expectRequest(
        backend.requests.last,
        '/visit-schedules/v1/checkout/qr-scan',
        {'token': 'scanned-token', ..._atHome},
      );
    }, () => backend.client);
  });

  testWidgets('checks out without the code once a reason is given', (
    tester,
  ) async {
    final backend = _Backend(audioRequired: false);
    await http.runWithClient(() async {
      await tester.pumpWidget(_screen());
      await _continue(tester);

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
        {'reason': 'no_family_member_present', ..._atHome},
      );
    }, () => backend.client);
  });
}
