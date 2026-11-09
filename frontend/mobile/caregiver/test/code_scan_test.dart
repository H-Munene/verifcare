import 'dart:convert';

import 'package:caregiver/api/api_client.dart';
import 'package:caregiver/api/checkin_api.dart';
import 'package:caregiver/api/visit_schedules_api.dart';
import 'package:caregiver/screens/code_scan_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

http.Response _problem(int status, String detail) =>
    _json({'title': 'Problem', 'status': status, 'detail': detail}, status);

final _visit = VisitSchedule.fromJson({
  'id': 'visit-1',
  'caregiverId': 'cg',
  'dependantId': 'd',
  'caregiverDisplayName': 'Amina',
  'dependantDisplayName': 'Joseph',
  'scheduledStart': '2026-11-09T09:00:00Z',
  'scheduledEnd': '2026-11-09T10:00:00Z',
  'status': 'scheduled',
  'createdBy': 'sup',
  'createdAt': '2026-11-01T09:00:00Z',
  'updatedAt': '2026-11-01T09:00:00Z',
});

/// Answers the scan and the override routes, recording what was scanned.
class _Backend {
  http.Response Function() onScan = () =>
      _json({'status': 'in_progress', 'checkinAt': '2026-11-09T09:05:00Z'});
  http.Response Function() onLatest = () => _problem(404, 'None');
  final scanned = <String>[];
  final sessionTokens = <String?>[];
  final overrides = <Map<String, dynamic>>[];

  MockClient get client => MockClient((request) async {
    final path = request.url.path;
    if (path.endsWith('/checkin/qr-scan')) {
      sessionTokens.add(request.headers['X-Checkin-Session-Token']);
      scanned.add((jsonDecode(request.body) as Map)['token'] as String);
      return onScan();
    }
    if (path.endsWith('/checkin/override')) {
      if (request.method == 'GET') return onLatest();
      overrides.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({'status': 'pending'}, 201);
    }
    return _problem(404, 'Unexpected ${request.method} $path');
  });
}

Future<void Function(String)> _pump(
  WidgetTester tester, {
  VoidCallback? onProceed,
}) async {
  tester.view.physicalSize = const Size(400, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  late void Function(String) deliver;
  await tester.pumpWidget(
    MaterialApp(
      home: CodeScanScreen(
        visit: _visit,
        checkinApi: CheckinApi(ApiClient(() async => null)),
        session: GeofenceCheckinResult(
          sessionToken: 'session',
          distanceFromGeofenceMeters: 4,
          expiresAt: DateTime.now().add(const Duration(minutes: 10)),
        ),
        onProceed: onProceed ?? () {},
        scannerBuilder: (onValue) {
          deliver = onValue;
          return const SizedBox.expand();
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
  return deliver;
}

void main() {
  testWidgets('a good code starts the visit', (tester) async {
    final backend = _Backend();
    var proceeded = false;
    await http.runWithClient(() async {
      final scan = await _pump(tester, onProceed: () => proceeded = true);

      scan('the-code');
      await tester.pumpAndSettle();

      expect(backend.scanned, ['the-code']);
      expect(backend.sessionTokens, ['session']);
      expect(find.text('Visit started'), findsOneWidget);
      await tester.tap(find.widgetWithText(ElevatedButton, 'Continue'));
      expect(proceeded, isTrue);
    }, () => backend.client);
  });

  testWidgets('the camera reporting one code repeatedly only submits it once', (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      final scan = await _pump(tester);

      scan('the-code');
      scan('the-code');
      scan('the-code');
      await tester.pumpAndSettle();

      expect(backend.scanned, hasLength(1));
    }, () => backend.client);
  });

  testWidgets(
    'a refused code explains why and waits for the caregiver to scan again',
    (tester) async {
      final backend = _Backend()
        ..onScan = () => _problem(422, 'This code has expired.');
      await http.runWithClient(() async {
        final scan = await _pump(tester);

        scan('old-code');
        await tester.pumpAndSettle();

        expect(find.text('This code has expired.'), findsOneWidget);
        expect(find.text('Scan again'), findsOneWidget);

        backend.onScan = () =>
            _json({'status': 'in_progress', 'checkinAt': 'x'});
        await tester.tap(find.text('Scan again'));
        await tester.pumpAndSettle();
        expect(find.text('This code has expired.'), findsNothing);
      }, () => backend.client);
    },
  );

  testWidgets('an override needs a reason, and "other" needs details', (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await _pump(tester);
      await tester.tap(find.text('No family member can show a code?'));
      await tester.pumpAndSettle();

      ElevatedButton send() =>
          tester.widget(find.widgetWithText(ElevatedButton, 'Send request'));
      expect(send().onPressed, isNull);

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Other').last);
      await tester.pumpAndSettle();
      expect(send().onPressed, isNull);

      await tester.enterText(find.byType(TextField), 'Gate locked');
      await tester.pump();
      expect(send().onPressed, isNotNull);

      await tester.tap(find.widgetWithText(ElevatedButton, 'Send request'));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(backend.overrides, [
        {'reason': 'other', 'note': 'Gate locked'},
      ]);
      expect(find.text('Waiting for a supervisor'), findsOneWidget);

      // Leave the screen so its polling timer stops.
      await tester.pumpWidget(const SizedBox());
    }, () => backend.client);
  });

  testWidgets(
    'reopening the screen goes back to waiting on a pending request',
    (tester) async {
      final backend = _Backend()..onLatest = () => _json({'status': 'pending'});
      await http.runWithClient(() async {
        await tester.pumpWidget(
          MaterialApp(
            home: CodeScanScreen(
              visit: _visit,
              checkinApi: CheckinApi(ApiClient(() async => null)),
              session: GeofenceCheckinResult(
                sessionToken: 'session',
                distanceFromGeofenceMeters: 4,
                expiresAt: DateTime.now(),
              ),
              onProceed: () {},
              scannerBuilder: (_) => const SizedBox.expand(),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Waiting for a supervisor'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      }, () => backend.client);
    },
  );
}
